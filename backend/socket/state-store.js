'use strict';

/**
 * Factory that creates all shared Maps and mutable state used across socket modules.
 * Returns a single object that is passed as `state` to every module's setup/handler.
 */
function createStateStore() {
  // Active rental sessions and timeout handles (keyed by socket.id)
  const activeSessions = new Map();
  const inactivityTimeouts = new Map();
  const sessionDurationTimeouts = new Map();
  const controlCommandCounters = new Map(); // socketId -> { count, windowStart }

  // Device sockets: carId (number) -> socket
  const deviceSockets = new Map();

  // Driver presence: userId (number) -> presence entry
  const presenceMap = new Map();
  const presenceGraceTimers = new Map(); // userId -> setTimeout handle

  // Race management
  const raceRooms = new Map(); // raceId -> race object
  const leaderboard = []; // sorted array of { userId, carName, lapTimeMs, date }
  let raceCounter = 0;

  // Per-user chat rate-limit state: userId -> { lastSent, burst }
  const chatRateLimits = new Map();

  // Per-user session-start rate-limit: userId -> { count, windowStart }
  const sessionStartRateLimits = new Map();

  // Per-user duel-search rate-limit: userId -> { count, windowStart }
  const duelSearchRateLimits = new Map();

  // Per-socket duel-event group rate-limit: socketId -> { count, windowStart }
  const duelEventRateLimits = new Map();

  // Per-user chat:delete rate-limit: userId -> { count, windowStart }
  const chatDeleteRateLimits = new Map();

  // Per-socket presence:hello rate-limit: socketId -> { count, windowStart }
  const presenceHelloRateLimits = new Map();

  // Per-socket presence:heartbeat rate-limit: socketId -> { count, windowStart }
  const presenceHeartbeatRateLimits = new Map();

  // Per-user join_race rate-limit: userId -> { count, windowStart }
  const joinRaceRateLimits = new Map();

  // Per-user end_lap rate-limit: userId -> { count, windowStart }
  const endLapRateLimits = new Map();

  return {
    activeSessions,
    inactivityTimeouts,
    sessionDurationTimeouts,
    controlCommandCounters,
    deviceSockets,
    presenceMap,
    presenceGraceTimers,
    raceRooms,
    leaderboard,
    get raceCounter() { return raceCounter; },
    set raceCounter(v) { raceCounter = v; },
    chatRateLimits,
    sessionStartRateLimits,
    duelSearchRateLimits,
    duelEventRateLimits,
    chatDeleteRateLimits,
    presenceHelloRateLimits,
    presenceHeartbeatRateLimits,
    joinRaceRateLimits,
    endLapRateLimits,
  };
}

module.exports = { createStateStore };
