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

// Minimum valid lap time accepted by the ranked system
const MIN_LAP_TIME_MS = 15000;

// Current ranked season identifier
const SEASON_ID = 1;

module.exports = {
  TOTAL_RANKS,
  MAX_STARS,
  PROTECTION_FLOOR,
  SOFT_LOSS_FLOOR,
  DUEL_TIMEOUT_MS,
  DUEL_SEARCH_TIMEOUT_MS,
  MIN_LAP_TIME_MS,
  SEASON_ID,
};
