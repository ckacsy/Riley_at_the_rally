'use strict';

// Ladder goes from rank 15 (lowest) down to rank 1 (highest normal)
const TOTAL_RANKS = 15;
const MAX_STARS = 3;

// Ranks 15–10: protected from star loss on defeat
const PROTECTION_FLOOR = 10;

// Ranks 9–6: soft loss (lose 1 star but never demote)
const SOFT_LOSS_FLOOR = 6;

// Duel timing constants (reserved for future duel gameplay PRs)
const DUEL_TIMEOUT_MS = 5 * 60 * 1000;
const DUEL_SEARCH_TIMEOUT_MS = 60 * 1000;

// Ready-state timeout: both players must press Готов within this window
const READY_TIMEOUT_MS = 60 * 1000;

// Grace period after duel resolution: late inputs return duel_resolved instead of not_in_duel
const RECENTLY_RESOLVED_GRACE_MS = 5 * 1000;

// Minimum valid lap time accepted by the ranked system
const MIN_LAP_TIME_MS = 15000;

// Number of checkpoints a player must hit (in order) before finishing a duel lap
const DUEL_REQUIRED_CHECKPOINTS = 3;

// Current ranked season identifier
const SEASON_ID = 1;

module.exports = {
  TOTAL_RANKS,
  MAX_STARS,
  PROTECTION_FLOOR,
  SOFT_LOSS_FLOOR,
  DUEL_TIMEOUT_MS,
  DUEL_SEARCH_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  RECENTLY_RESOLVED_GRACE_MS,
  MIN_LAP_TIME_MS,
  DUEL_REQUIRED_CHECKPOINTS,
  SEASON_ID,
};
