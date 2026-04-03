'use strict';

/**
 * DuelManager — owns all duel-specific in-memory state and business logic.
 *
 * Responsibilities:
 *  - Matchmaking queue (with per-player search timeout)
 *  - Player eligibility gating (rank-based matching via rank-system helpers)
 *  - Duel state machine: matched → in_progress → finished / cancelled
 *  - Per-player lap validation (checkpoint order, MIN_LAP_TIME_MS)
 *  - Idempotent duel resolution (resolved guard)
 *  - Rank updates via applyRankWin / applyRankLoss
 *  - Persistence of duel_results and player_ranks rows
 *  - Socket event emission (duel:matched, duel:result, duel:search_timeout)
 *  - Disconnect / manual leave resolution
 */

const {
  applyRankWin,
  applyRankLoss,
  canMatchOpponents,
  normalizeRankState,
} = require('./rank-system');

const {
  DUEL_TIMEOUT_MS,
  DUEL_SEARCH_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  RECENTLY_RESOLVED_GRACE_MS,
  MIN_LAP_TIME_MS,
  DUEL_REQUIRED_CHECKPOINTS,
  COUNTDOWN_MS,
  SEASON_ID,
} = require('./rank-config');

class DuelManager {
  /**
   * @param {{
   *   db: import('better-sqlite3').Database,
   *   io: import('socket.io').Server,
   *   metrics: { log: Function, recordError: Function },
   *   getActiveSession?: (socketId: string) => object|undefined
   * }} opts
   */
  constructor({ db, io, metrics, getActiveSession }) {
    this._db = db;
    this._io = io;
    this._metrics = metrics;

    /**
     * Optional callback to look up the active rental session for a socketId.
     * Used to revalidate car/session availability at duel creation time.
     */
    this._getActiveSession = typeof getActiveSession === 'function' ? getActiveSession : null;

    /** Queue: userId (number) → queueEntry */
    this._queue = new Map();

    /** Active duels: duelId (string) → duel */
    this._duels = new Map();

    /** Fast lookup: socketId (string) → duelId (string) */
    this._socketToDuel = new Map();

    /** Fast lookup: userId (number) → duelId (string) */
    this._userToDuel = new Map();

    /**
     * Recently-resolved grace period: socketId (string) → expiry timestamp.
     * Late inputs within RECENTLY_RESOLVED_GRACE_MS after duel cleanup return
     * 'duel_resolved' instead of 'not_in_duel'.
     */
    this._recentlyResolved = new Map();
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  /**
   * Check whether a user is currently in the matchmaking queue.
   * @param {number} userId
   */
  isInQueue(userId) {
    return this._queue.has(userId);
  }

  /**
   * Add a player to the matchmaking queue.
   * If an eligible opponent is already waiting, a duel is created immediately.
   *
   * @param {{
   *   userId: number,
   *   socketId: string,
   *   username: string,
   *   rank: number,
   *   stars: number,
   *   isLegend: boolean,
   *   legendPosition: number|null,
   *   carId: number|null,
   * }} entry
   * @returns {{ queued: true } | { matched: true, duel: object } | { error: string }}
   */
  addToQueue(entry) {
    const { userId, socketId, username, rank, stars, isLegend, legendPosition, carId } = entry;

    if (this._queue.has(userId) || this._userToDuel.has(userId)) {
      return { error: 'already_in_duel_or_queue' };
    }

    const playerState = normalizeRankState({ rank, stars, isLegend, legendPosition });

    // Try to find an eligible waiting opponent
    for (const [otherUserId, other] of this._queue) {
      if (canMatchOpponents(playerState, other.rankState)) {
        // Clear the opponent's search timeout
        if (other.searchTimeout) clearTimeout(other.searchTimeout);
        this._queue.delete(otherUserId);

        const duel = this._createDuel(
          { userId, socketId, username, rankState: playerState, carId },
          other,
        );
        if (!duel) {
          // Session validation failed: duel:error already emitted to affected players.
          return { error: 'match_creation_failed' };
        }
        this._metrics.log('info', 'duel_matched', {
          duelId: duel.id,
          userA: userId,
          userB: otherUserId,
        });
        return { matched: true, duel };
      }
    }

    // No match — enqueue with search timeout
    const searchTimeout = setTimeout(() => {
      if (this._queue.has(userId)) {
        this._queue.delete(userId);
        const sock = this._io.sockets.sockets.get(socketId);
        if (sock) {
          sock.emit('duel:search_timeout', {
            message: 'Поиск соперника завершён по тайм-ауту.',
          });
        }
        this._metrics.log('info', 'duel_search_timeout', { userId });
      }
    }, DUEL_SEARCH_TIMEOUT_MS);

    this._queue.set(userId, {
      userId,
      socketId,
      username,
      rankState: playerState,
      carId,
      queuedAt: Date.now(),
      searchTimeout,
    });

    this._metrics.log('info', 'duel_queue_join', { userId, rank, stars, isLegend });
    return { queued: true };
  }

  /**
   * Remove a player from the queue (cancel search).
   * @param {number} userId
   * @returns {{ removed: boolean }}
   */
  removeFromQueue(userId) {
    const entry = this._queue.get(userId);
    if (!entry) return { removed: false };
    if (entry.searchTimeout) clearTimeout(entry.searchTimeout);
    this._queue.delete(userId);
    this._metrics.log('info', 'duel_queue_leave', { userId });
    return { removed: true };
  }

  /**
   * Remove a player from the queue by their socketId (used on disconnect).
   * @param {string} socketId
   * @returns {{ removed: boolean }}
   */
  removeFromQueueBySocket(socketId) {
    for (const [userId, entry] of this._queue) {
      if (entry.socketId === socketId) {
        return this.removeFromQueue(userId);
      }
    }
    return { removed: false };
  }

  // ---------------------------------------------------------------------------
  // Duel creation
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _createDuel(playerA, playerB) {
    // Fix 3: Revalidate active car/session before finalizing the match.
    if (this._getActiveSession) {
      const sessionA = this._getActiveSession(playerA.socketId);
      const sessionB = this._getActiveSession(playerB.socketId);
      if (!sessionA || !sessionB) {
        const msg = 'Сессия аренды больше не активна.';
        const sockA = this._io.sockets.sockets.get(playerA.socketId);
        const sockB = this._io.sockets.sockets.get(playerB.socketId);
        if (!sessionA && sockA) {
          sockA.emit('duel:error', { code: 'session_expired', message: msg });
        }
        if (!sessionB && sockB) {
          sockB.emit('duel:error', { code: 'session_expired', message: msg });
        }
        this._metrics.log('warn', 'duel_create_invalid_session', {
          userA: playerA.userId,
          userB: playerB.userId,
          sessionAValid: !!sessionA,
          sessionBValid: !!sessionB,
        });
        return null;
      }
    }

    const duelId =
      'duel-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    const makePlayerState = (p) => ({
      socketId: p.socketId,
      dbUserId: p.userId,
      username: p.username,
      carId: p.carId || null,
      rankState: p.rankState,
      // Ready-state: both players must set this to true before the duel
      // transitions from ready_pending to in_progress.
      ready: false,
      // Lap-tracking state
      lapStarted: false,
      currentLapStart: null,
      checkpointIndex: 0,
      finished: false,
      finishTime: null,
      lapTimeMs: null,
    });

    const duel = {
      id: duelId,
      type: 'duel',
      status: 'ready_pending',
      resolved: false,
      winnerUserId: null,
      loserUserId: null,
      resolutionReason: null,
      startedAt: null,
      finishedAt: null,
      players: [makePlayerState(playerA), makePlayerState(playerB)],
      timeoutHandle: null,
      readyTimeoutHandle: null,
    };

    // Register
    this._duels.set(duelId, duel);
    this._socketToDuel.set(playerA.socketId, duelId);
    this._socketToDuel.set(playerB.socketId, duelId);
    this._userToDuel.set(playerA.userId, duelId);
    this._userToDuel.set(playerB.userId, duelId);

    // Start ready-state timeout
    duel.readyTimeoutHandle = setTimeout(() => {
      this._handleReadyTimeout(duelId);
    }, READY_TIMEOUT_MS);

    // Notify both players
    const sockA = this._io.sockets.sockets.get(playerA.socketId);
    const sockB = this._io.sockets.sockets.get(playerB.socketId);

    const matchedPayload = (opponent) => ({
      duelId,
      opponent: {
        username: opponent.username,
        ...opponent.rankState,
      },
      requiredCheckpoints: DUEL_REQUIRED_CHECKPOINTS,
    });

    if (sockA) sockA.emit('duel:matched', matchedPayload(playerB));
    if (sockB) sockB.emit('duel:matched', matchedPayload(playerA));

    return duel;
  }

  // ---------------------------------------------------------------------------
  // Ready-state lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Mark a player as ready for the duel to begin.
   * When both players are ready, the duel transitions to in_progress and
   * duel:start is emitted to both.
   * @param {string} socketId
   * @returns {{ ok: boolean, error?: string }}
   */
  handleReady(socketId) {
    const duel = this.getDuelBySocketId(socketId);
    if (!duel) {
      return {
        ok: false,
        error: this._recentlyResolved.has(socketId) ? 'duel_resolved' : 'not_in_duel',
      };
    }
    if (duel.resolved) return { ok: false, error: 'duel_resolved' };
    if (duel.status !== 'ready_pending') {
      return { ok: false, error: 'not_in_ready_state' };
    }

    const player = duel.players.find((p) => p.socketId === socketId);
    if (!player) return { ok: false, error: 'player_not_found' };

    // Idempotent: already marked ready
    if (player.ready) return { ok: true };

    player.ready = true;

    // Notify opponent that this player is ready
    const opponent = duel.players.find((p) => p.socketId !== socketId);
    if (opponent) {
      const opponentSock = this._io.sockets.sockets.get(opponent.socketId);
      if (opponentSock) {
        opponentSock.emit('duel:opponent_ready', {
          duelId: duel.id,
          username: player.username,
        });
      }
    }

    this._metrics.log('info', 'duel_player_ready', {
      duelId: duel.id,
      userId: player.dbUserId,
    });

    // Both players ready → start countdown phase
    if (duel.players.every((p) => p.ready)) {
      // Cancel ready timeout
      if (duel.readyTimeoutHandle) {
        clearTimeout(duel.readyTimeoutHandle);
        duel.readyTimeoutHandle = null;
      }

      duel.status = 'countdown';

      const countdownPayload = { duelId: duel.id, countdownMs: COUNTDOWN_MS };
      for (const p of duel.players) {
        const sock = this._io.sockets.sockets.get(p.socketId);
        if (sock) sock.emit('duel:countdown', countdownPayload);
      }

      this._metrics.log('info', 'duel_countdown', { duelId: duel.id });

      duel.countdownHandle = setTimeout(() => {
        this._startDuel(duel.id);
      }, COUNTDOWN_MS);
    }

    return { ok: true };
  }

  /**
   * Cancel a duel that is in the ready_pending state (player voluntarily cancels
   * before both sides confirmed ready).  Does NOT emit socket events — the caller
   * (socket handler) is responsible for notifying players via duel:cancelled.
   *
   * @param {string} socketId
   * @returns {{ cancelled: boolean, affectedSocketIds?: string[] }}
   */
  cancelReady(socketId) {
    const duel = this.getDuelBySocketId(socketId);
    if (!duel || duel.resolved || duel.status !== 'ready_pending') {
      return { cancelled: false };
    }

    const affectedSocketIds = duel.players.map((p) => p.socketId);

    duel.resolved = true;
    duel.status = 'cancelled';
    duel.resolutionReason = 'player_cancelled';
    duel.finishedAt = new Date().toISOString();

    if (duel.timeoutHandle) {
      clearTimeout(duel.timeoutHandle);
      duel.timeoutHandle = null;
    }
    if (duel.readyTimeoutHandle) {
      clearTimeout(duel.readyTimeoutHandle);
      duel.readyTimeoutHandle = null;
    }
    if (duel.countdownHandle) {
      clearTimeout(duel.countdownHandle);
      duel.countdownHandle = null;
    }

    try {
      this._db
        .prepare(
          `INSERT INTO duel_results
             (season_id, race_id, winner_id, loser_id, result_type,
              winner_lap_time_ms, loser_lap_time_ms)
           VALUES (?, ?, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(SEASON_ID, duel.id, 'player_cancelled');
    } catch (e) {
      this._metrics.log('error', 'duel_result_persist_fail', {
        duelId: duel.id,
        error: e.message,
      });
    }

    this._cleanupDuelMaps(duel.id);
    this._metrics.log('info', 'duel_cancelled', { duelId: duel.id, reason: 'player_cancelled' });

    return { cancelled: true, affectedSocketIds };
  }

  /**
   * Handle ready-state timeout (both players didn't ready up in time).
   * @private
   */
  _handleReadyTimeout(duelId) {
    const duel = this._duels.get(duelId);
    if (!duel || duel.resolved || duel.status !== 'ready_pending') return;
    this._metrics.log('info', 'duel_ready_timeout', { duelId });
    this._cancelDuel(duel, 'ready_timeout');
  }

  /**
   * Transition a duel from countdown to in_progress and emit duel:start.
   * Called after the countdown timer fires.
   * @private
   */
  _startDuel(duelId) {
    const duel = this._duels.get(duelId);
    if (!duel || duel.resolved || duel.status !== 'countdown') return;

    duel.countdownHandle = null;
    duel.status = 'in_progress';
    duel.startedAt = new Date().toISOString();

    // Start overall duel timeout from this point
    duel.timeoutHandle = setTimeout(() => {
      this._handleDuelTimeout(duel.id);
    }, DUEL_TIMEOUT_MS);

    const startPayload = { duelId: duel.id };
    for (const p of duel.players) {
      const sock = this._io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('duel:start', startPayload);
    }

    this._metrics.log('info', 'duel_start', { duelId: duel.id });
  }

  // ---------------------------------------------------------------------------
  // Lap events (called from socket event handlers)
  // ---------------------------------------------------------------------------

  /**
   * Player signals the start of their duel lap.
   * @param {string} socketId
   * @returns {{ ok: boolean, error?: string }}
   */
  handleStartLap(socketId) {
    const duel = this.getDuelBySocketId(socketId);
    if (!duel) {
      return {
        ok: false,
        error: this._recentlyResolved.has(socketId) ? 'duel_resolved' : 'not_in_duel',
      };
    }
    if (duel.resolved) return { ok: false, error: 'duel_resolved' };
    if (duel.status === 'ready_pending') return { ok: false, error: 'not_ready' };
    if (duel.status === 'countdown') return { ok: false, error: 'countdown_in_progress' };
    if (duel.status !== 'in_progress') return { ok: false, error: 'not_in_duel' };

    const player = duel.players.find((p) => p.socketId === socketId);
    if (!player) return { ok: false, error: 'player_not_found' };
    if (player.lapStarted) return { ok: false, error: 'lap_already_started' };
    if (player.finished) return { ok: false, error: 'already_finished' };

    player.lapStarted = true;
    player.currentLapStart = Date.now();
    player.checkpointIndex = 0;

    this._metrics.log('debug', 'duel_lap_start', {
      duelId: duel.id,
      userId: player.dbUserId,
    });
    return { ok: true };
  }

  /**
   * Player hits a checkpoint.
   * @param {string} socketId
   * @param {number} checkpointIndex  0-based index of the checkpoint being reported
   * @returns {{ ok: boolean, error?: string, nextCheckpoint?: number }}
   */
  handleCheckpoint(socketId, checkpointIndex) {
    const duel = this.getDuelBySocketId(socketId);
    if (!duel) {
      return {
        ok: false,
        error: this._recentlyResolved.has(socketId) ? 'duel_resolved' : 'not_in_duel',
      };
    }
    if (duel.resolved) return { ok: false, error: 'duel_resolved' };
    if (duel.status === 'countdown') return { ok: false, error: 'countdown_in_progress' };

    const player = duel.players.find((p) => p.socketId === socketId);
    if (!player) return { ok: false, error: 'player_not_found' };
    if (!player.lapStarted) return { ok: false, error: 'lap_not_started' };
    if (player.finished) return { ok: false, error: 'already_finished' };

    // Enforce sequential order
    if (checkpointIndex !== player.checkpointIndex) {
      return { ok: false, error: 'wrong_checkpoint_order' };
    }

    player.checkpointIndex += 1;
    this._metrics.log('debug', 'duel_checkpoint', {
      duelId: duel.id,
      userId: player.dbUserId,
      checkpoint: checkpointIndex,
    });
    return { ok: true, nextCheckpoint: player.checkpointIndex };
  }

  /**
   * Player submits a lap finish.
   * The first valid finish wins immediately.
   * @param {string} socketId
   * @returns {{ ok: boolean, resolved?: boolean, error?: string }}
   */
  handleFinishLap(socketId) {
    const duel = this.getDuelBySocketId(socketId);
    if (!duel) {
      return {
        ok: false,
        error: this._recentlyResolved.has(socketId) ? 'duel_resolved' : 'not_in_duel',
      };
    }
    if (duel.resolved) return { ok: false, error: 'duel_resolved' };
    if (duel.status === 'countdown') return { ok: false, error: 'countdown_in_progress' };

    const player = duel.players.find((p) => p.socketId === socketId);
    if (!player) return { ok: false, error: 'player_not_found' };
    if (!player.lapStarted) return { ok: false, error: 'lap_not_started' };
    if (player.finished) return { ok: false, error: 'already_finished' };

    // All required checkpoints must have been hit
    if (player.checkpointIndex < DUEL_REQUIRED_CHECKPOINTS) {
      this._metrics.log('warn', 'duel_finish_invalid_checkpoints', {
        duelId: duel.id,
        userId: player.dbUserId,
        checkpointIndex: player.checkpointIndex,
        required: DUEL_REQUIRED_CHECKPOINTS,
      });
      return { ok: false, error: 'checkpoints_incomplete' };
    }

    const now = Date.now();
    const lapTimeMs = now - player.currentLapStart;

    // Sanity-check minimum lap time
    if (lapTimeMs < MIN_LAP_TIME_MS) {
      this._metrics.log('warn', 'duel_finish_too_fast', {
        duelId: duel.id,
        userId: player.dbUserId,
        lapTimeMs,
      });
      return { ok: false, error: 'lap_too_fast' };
    }

    player.finished = true;
    player.finishTime = now;
    player.lapTimeMs = lapTimeMs;

    this._metrics.log('info', 'duel_lap_finish', {
      duelId: duel.id,
      userId: player.dbUserId,
      lapTimeMs,
    });

    // First valid finish = win
    return this._resolveDuel(duel, player.dbUserId, 'win');
  }

  // ---------------------------------------------------------------------------
  // Disconnect / leave handling
  // ---------------------------------------------------------------------------

  /**
   * Handle a socket disconnect.
   * - If player is in queue: remove from queue.
   * - If player is in a duel that hasn't started: cancel without rank changes.
   * - If player is in a started duel: apply loss to disconnecting player.
   * @param {string} socketId
   * @returns {{ affectedDuel: object|null }}
   */
  handleDisconnect(socketId) {
    // Remove from queue if waiting
    this.removeFromQueueBySocket(socketId);

    const duel = this.getDuelBySocketId(socketId);
    if (!duel) return { affectedDuel: null };

    // Already resolved — clean up lookup maps if still present
    if (duel.resolved) {
      this._cleanupDuelMaps(duel.id);
      return { affectedDuel: duel };
    }

    const disconnectingPlayer = duel.players.find((p) => p.socketId === socketId);
    if (!disconnectingPlayer) return { affectedDuel: null };

    if (duel.status === 'ready_pending' || duel.status === 'countdown') {
      // Before game has started: cancel without rank penalty
      this._cancelDuel(duel, 'cancel');
      return { affectedDuel: duel };
    }

    // After start: disconnecting player loses
    const otherPlayer = duel.players.find((p) => p.socketId !== socketId);
    const winnerId = otherPlayer ? otherPlayer.dbUserId : null;
    this._resolveDuel(duel, winnerId, 'disconnect');
    return { affectedDuel: duel };
  }

  /**
   * Handle an intentional leave during a duel (e.g. leave_race event).
   * Semantics identical to handleDisconnect.
   * @param {string} socketId
   * @returns {{ affectedDuel: object|null }}
   */
  handlePlayerLeave(socketId) {
    return this.handleDisconnect(socketId);
  }

  // ---------------------------------------------------------------------------
  // Resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _handleDuelTimeout(duelId) {
    const duel = this._duels.get(duelId);
    if (!duel || duel.resolved) return;
    this._metrics.log('info', 'duel_timeout', { duelId });
    this._cancelDuel(duel, 'timeout');
  }

  /**
   * Cancel a duel without rank changes (cancel / timeout / ready_timeout).
   * @private
   */
  _cancelDuel(duel, reason) {
    if (duel.resolved) return;

    duel.resolved = true;
    duel.status = (reason === 'timeout' || reason === 'ready_timeout') ? 'finished' : 'cancelled';
    duel.resolutionReason = reason;
    duel.finishedAt = new Date().toISOString();

    if (duel.timeoutHandle) {
      clearTimeout(duel.timeoutHandle);
      duel.timeoutHandle = null;
    }

    if (duel.readyTimeoutHandle) {
      clearTimeout(duel.readyTimeoutHandle);
      duel.readyTimeoutHandle = null;
    }

    if (duel.countdownHandle) {
      clearTimeout(duel.countdownHandle);
      duel.countdownHandle = null;
    }

    // Persist result row (no winner/loser, no rank changes)
    try {
      this._db
        .prepare(
          `INSERT INTO duel_results
             (season_id, race_id, winner_id, loser_id, result_type,
              winner_lap_time_ms, loser_lap_time_ms)
           VALUES (?, ?, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(SEASON_ID, duel.id, reason);
    } catch (e) {
      this._metrics.log('error', 'duel_result_persist_fail', {
        duelId: duel.id,
        error: e.message,
      });
    }

    // Notify both players
    const payload = { duelId: duel.id, result: reason, rankChange: null };
    for (const p of duel.players) {
      const sock = this._io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('duel:result', payload);
    }

    this._cleanupDuelMaps(duel.id);
    this._metrics.log('info', 'duel_cancelled', { duelId: duel.id, reason });
  }

  /**
   * Resolve a duel with a winner.
   * Idempotent: if already resolved, returns immediately.
   *
   * @private
   * @param {object} duel
   * @param {number|null} winnerUserId  DB user id of the winner, or null if no winner.
   * @param {string} reason  'win' | 'disconnect'
   * @returns {{ ok: boolean, resolved?: boolean, error?: string }}
   */
  _resolveDuel(duel, winnerUserId, reason) {
    if (duel.resolved) return { ok: false, error: 'already_resolved' };

    duel.resolved = true;
    duel.status = 'finished';
    duel.resolutionReason = reason;
    duel.finishedAt = new Date().toISOString();
    duel.winnerUserId = winnerUserId;

    if (duel.timeoutHandle) {
      clearTimeout(duel.timeoutHandle);
      duel.timeoutHandle = null;
    }

    if (duel.readyTimeoutHandle) {
      clearTimeout(duel.readyTimeoutHandle);
      duel.readyTimeoutHandle = null;
    }

    const winnerPlayer = winnerUserId
      ? duel.players.find((p) => p.dbUserId === winnerUserId)
      : null;
    const loserPlayer = winnerUserId
      ? duel.players.find((p) => p.dbUserId !== winnerUserId)
      : null;

    duel.loserUserId = loserPlayer ? loserPlayer.dbUserId : null;

    // Apply rank changes and persist result
    let winnerChange = null;
    let loserChange = null;
    try {
      const changes = this._applyRankChanges(
        duel,
        winnerUserId,
        duel.loserUserId,
        reason,
        winnerPlayer ? winnerPlayer.lapTimeMs : null,
        loserPlayer ? loserPlayer.lapTimeMs : null,
      );
      winnerChange = changes.winnerChange;
      loserChange = changes.loserChange;
    } catch (e) {
      this._metrics.log('error', 'duel_rank_apply_fail', {
        duelId: duel.id,
        error: e.message,
      });
      this._metrics.recordError();
    }

    // Notify both players
    for (const p of duel.players) {
      const isWinner = p.dbUserId === winnerUserId;
      const sock = this._io.sockets.sockets.get(p.socketId);
      if (sock) {
        sock.emit('duel:result', {
          duelId: duel.id,
          result: isWinner ? 'win' : 'loss',
          reason,
          lapTimeMs: p.lapTimeMs,
          rankChange: isWinner ? winnerChange : loserChange,
        });
      }
    }

    this._cleanupDuelMaps(duel.id);
    this._metrics.log('info', 'duel_resolved', {
      duelId: duel.id,
      winnerId: winnerUserId,
      loserId: duel.loserUserId,
      reason,
    });
    return { ok: true, resolved: true };
  }

  /**
   * Apply rank win/loss to both players, update the users table, and insert
   * player_ranks history + duel_results rows — all in a single DB transaction.
   *
   * @private
   * @param {object} duel                   The resolved duel object (for race_id logging).
   * @param {number|null} winnerId          DB user id of the winner, or null if no winner.
   * @param {number|null} loserId           DB user id of the loser, or null if no loser.
   * @param {string} reason                 Resolution reason ('win' | 'disconnect').
   * @param {number|null} winnerLapTimeMs   Winner's recorded lap time in ms, or null.
   * @param {number|null} loserLapTimeMs    Loser's recorded lap time in ms, or null.
   * @returns {{ winnerChange: object|null, loserChange: object|null }}
   *   winnerChange / loserChange are { old: rankState, new: rankState } or null
   *   when the corresponding player was not found in the DB.
   */
  _applyRankChanges(duel, winnerId, loserId, reason, winnerLapTimeMs, loserLapTimeMs) {
    const db = this._db;
    let winnerChange = null;
    let loserChange = null;

    db.transaction(() => {
      // ---- Winner ----
      if (winnerId) {
        const row = db
          .prepare(
            'SELECT rank, stars, is_legend, legend_position FROM users WHERE id = ?',
          )
          .get(winnerId);
        if (row) {
          const oldState = normalizeRankState({
            rank: row.rank,
            stars: row.stars,
            isLegend: Boolean(row.is_legend),
            legendPosition: row.legend_position,
          });
          const newState = applyRankWin(oldState);

          // Assign legend position if entering Legend
          if (newState.enteredLegend) {
            const maxRow = db
              .prepare(
                'SELECT MAX(legend_position) AS maxPos FROM users WHERE is_legend = 1',
              )
              .get();
            newState.legendPosition =
              maxRow && maxRow.maxPos != null ? maxRow.maxPos + 1 : 1;
          }

          db.prepare(
            `UPDATE users
             SET rank = ?, stars = ?, is_legend = ?, legend_position = ?,
                 duels_won = duels_won + 1
             WHERE id = ?`,
          ).run(
            newState.rank,
            newState.stars,
            newState.isLegend ? 1 : 0,
            newState.legendPosition || null,
            winnerId,
          );

          db.prepare(
            `INSERT INTO player_ranks
               (user_id, old_rank, old_stars, old_is_legend, old_legend_position,
                new_rank, new_stars, new_is_legend, new_legend_position,
                reason, race_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            winnerId,
            oldState.rank,
            oldState.stars,
            oldState.isLegend ? 1 : 0,
            oldState.legendPosition || null,
            newState.rank,
            newState.stars,
            newState.isLegend ? 1 : 0,
            newState.legendPosition || null,
            'duel_win',
            duel.id,
          );

          winnerChange = { old: oldState, new: newState };
        }
      }

      // ---- Loser ----
      if (loserId) {
        const row = db
          .prepare(
            'SELECT rank, stars, is_legend, legend_position FROM users WHERE id = ?',
          )
          .get(loserId);
        if (row) {
          const oldState = normalizeRankState({
            rank: row.rank,
            stars: row.stars,
            isLegend: Boolean(row.is_legend),
            legendPosition: row.legend_position,
          });
          const newState = applyRankLoss(oldState);

          db.prepare(
            `UPDATE users
             SET rank = ?, stars = ?, is_legend = ?, legend_position = ?,
                 duels_lost = duels_lost + 1
             WHERE id = ?`,
          ).run(
            newState.rank,
            newState.stars,
            newState.isLegend ? 1 : 0,
            newState.legendPosition || null,
            loserId,
          );

          db.prepare(
            `INSERT INTO player_ranks
               (user_id, old_rank, old_stars, old_is_legend, old_legend_position,
                new_rank, new_stars, new_is_legend, new_legend_position,
                reason, race_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            loserId,
            oldState.rank,
            oldState.stars,
            oldState.isLegend ? 1 : 0,
            oldState.legendPosition || null,
            newState.rank,
            newState.stars,
            newState.isLegend ? 1 : 0,
            newState.legendPosition || null,
            'duel_loss',
            duel.id,
          );

          loserChange = { old: oldState, new: newState };
        }
      }

      // ---- Duel result row ----
      db.prepare(
        `INSERT INTO duel_results
           (season_id, race_id, winner_id, loser_id, result_type,
            winner_lap_time_ms, loser_lap_time_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        SEASON_ID,
        duel.id,
        winnerId || null,
        loserId || null,
        reason,
        winnerLapTimeMs || null,
        loserLapTimeMs || null,
      );
    })();

    return { winnerChange, loserChange };
  }

  // ---------------------------------------------------------------------------
  // Map cleanup
  // ---------------------------------------------------------------------------

  /**
   * Remove a resolved duel from all lookup maps and cancel its timeout.
   * Also registers recently-resolved socketIds for the grace period.
   * @private
   */
  _cleanupDuelMaps(duelId) {
    const duel = this._duels.get(duelId);
    if (!duel) return;

    if (duel.timeoutHandle) {
      clearTimeout(duel.timeoutHandle);
      duel.timeoutHandle = null;
    }

    if (duel.readyTimeoutHandle) {
      clearTimeout(duel.readyTimeoutHandle);
      duel.readyTimeoutHandle = null;
    }

    for (const p of duel.players) {
      this._socketToDuel.delete(p.socketId);
      this._userToDuel.delete(p.dbUserId);

      // Fix 2: grace period — late inputs return 'duel_resolved' instead of 'not_in_duel'
      this._recentlyResolved.set(p.socketId, Date.now());
      const sid = p.socketId;
      setTimeout(() => {
        this._recentlyResolved.delete(sid);
      }, RECENTLY_RESOLVED_GRACE_MS);
    }

    this._duels.delete(duelId);
  }

  // ---------------------------------------------------------------------------
  // Status / lookup
  // ---------------------------------------------------------------------------

  /**
   * Get the active duel for a given socketId, or null.
   * @param {string} socketId
   * @returns {object|null}
   */
  getDuelBySocketId(socketId) {
    const duelId = this._socketToDuel.get(socketId);
    if (!duelId) return null;
    return this._duels.get(duelId) || null;
  }

  /**
   * Get the active duel for a given userId, or null.
   * @param {number} userId
   * @returns {object|null}
   */
  getDuelByUserId(userId) {
    const duelId = this._userToDuel.get(userId);
    if (!duelId) return null;
    return this._duels.get(duelId) || null;
  }

  /**
   * Get the duel status string for a user.
   * Never returns 'cancelled' — that internal state is mapped to 'finished'.
   * @param {number} userId
   * @returns {'none'|'searching'|'ready_pending'|'countdown'|'in_progress'|'finished'}
   */
  getDuelStatus(userId) {
    if (this._queue.has(userId)) return 'searching';
    const duel = this.getDuelByUserId(userId);
    if (!duel) return 'none';
    // Fix 1: never expose raw 'cancelled' to frontend consumers
    return duel.status === 'cancelled' ? 'finished' : duel.status;
  }

  // ---------------------------------------------------------------------------
  // Reset (used by dev reset-db endpoint)
  // ---------------------------------------------------------------------------

  /**
   * Clear all in-memory duel state (queue, duels, lookup maps).
   * Should be called when the dev reset-db endpoint fires.
   */
  clear() {
    for (const entry of this._queue.values()) {
      if (entry.searchTimeout) clearTimeout(entry.searchTimeout);
    }
    this._queue.clear();

    for (const duel of this._duels.values()) {
      if (duel.timeoutHandle) clearTimeout(duel.timeoutHandle);
      if (duel.readyTimeoutHandle) clearTimeout(duel.readyTimeoutHandle);
      if (duel.countdownHandle) clearTimeout(duel.countdownHandle);
    }
    this._duels.clear();
    this._socketToDuel.clear();
    this._userToDuel.clear();
    this._recentlyResolved.clear();
  }
}

module.exports = DuelManager;
