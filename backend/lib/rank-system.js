'use strict';

/**
 * Pure rank-system helpers — no DB access, no side effects.
 *
 * State shape:
 *   { rank: number, stars: number, isLegend: boolean, legendPosition: number|null }
 *
 * All functions return a new state object and never mutate the input.
 */

const {
  TOTAL_RANKS,
  MAX_STARS,
  PROTECTION_FLOOR,
  SOFT_LOSS_FLOOR,
} = require('./rank-config');

// Rank tier labels and emoji
const TIER_MAP = [
  // index 0 unused; index corresponds to rank number (1-15)
  null,
  { emoji: '🏅', label: '1' },  // rank 1
  { emoji: '🏅', label: '2' },
  { emoji: '🏅', label: '3' },
  { emoji: '🏅', label: '4' },
  { emoji: '🏅', label: '5' },
  { emoji: '🚗', label: '6' },  // rank 6
  { emoji: '🚗', label: '7' },
  { emoji: '🚗', label: '8' },
  { emoji: '🚗', label: '9' },
  { emoji: '🚗', label: '10' }, // rank 10
  { emoji: '🛻', label: '11' }, // rank 11
  { emoji: '🛻', label: '12' },
  { emoji: '🛻', label: '13' },
  { emoji: '🛻', label: '14' },
  { emoji: '🛻', label: '15' }, // rank 15 (lowest)
];

/**
 * Normalize an incoming state object, filling in sensible defaults.
 * @param {object} raw
 * @returns {{ rank: number, stars: number, isLegend: boolean, legendPosition: number|null }}
 */
function normalizeRankState(raw) {
  const rank = (typeof raw.rank === 'number' && raw.rank >= 1 && raw.rank <= TOTAL_RANKS)
    ? raw.rank
    : TOTAL_RANKS;
  const stars = (typeof raw.stars === 'number' && raw.stars >= 0 && raw.stars <= MAX_STARS)
    ? raw.stars
    : 0;
  const isLegend = Boolean(raw.isLegend);
  const legendPosition = (isLegend && typeof raw.legendPosition === 'number')
    ? raw.legendPosition
    : null;
  return { rank, stars, isLegend, legendPosition };
}

/**
 * Return the display tier for a given rank number.
 * @param {number} rank
 * @returns {{ emoji: string, label: string }}
 */
function getRankTier(rank) {
  if (rank >= 1 && rank <= TOTAL_RANKS) return TIER_MAP[rank];
  return { emoji: '❓', label: String(rank) };
}

/**
 * Build a human-readable display object for the current state.
 * @param {{ rank: number, stars: number, isLegend: boolean, legendPosition: number|null }} state
 * @returns {{ label: string, emoji: string, starsDisplay: string, text: string }}
 */
function getRankDisplay(state) {
  const { rank, stars, isLegend, legendPosition } = normalizeRankState(state);

  if (isLegend) {
    const pos = legendPosition != null ? `#${legendPosition}` : '';
    return {
      label: `Legend ${pos}`.trim(),
      emoji: '🏆',
      starsDisplay: '',
      text: `🏆 Legend ${pos}`.trim(),
    };
  }

  const tier = getRankTier(rank);
  const filled = '★'.repeat(stars);
  const empty = '☆'.repeat(MAX_STARS - stars);
  const starsDisplay = filled + empty;

  return {
    label: tier.label,
    emoji: tier.emoji,
    starsDisplay,
    text: `${tier.emoji} ${tier.label} ${starsDisplay}`,
  };
}

/**
 * Apply a win to the given rank state.
 *
 * - 0..2 stars → gain 1 star
 * - 3 stars + rank > 1 → promote (rank - 1), stars = 0
 * - 3 stars + rank === 1 → enter Legend
 *
 * @param {{ rank: number, stars: number, isLegend: boolean, legendPosition: number|null }} state
 * @returns {{ rank: number, stars: number, isLegend: boolean, legendPosition: number|null, promoted: boolean, enteredLegend: boolean }}
 */
function applyRankWin(state) {
  const { rank, stars, isLegend, legendPosition } = normalizeRankState(state);

  // Legend players don't change within this PR
  if (isLegend) {
    return { rank, stars, isLegend, legendPosition, promoted: false, enteredLegend: false };
  }

  if (stars < MAX_STARS) {
    return { rank, stars: stars + 1, isLegend: false, legendPosition: null, promoted: false, enteredLegend: false };
  }

  // stars === MAX_STARS
  if (rank === 1) {
    // Enter Legend
    return { rank: 1, stars: 0, isLegend: true, legendPosition: null, promoted: false, enteredLegend: true };
  }

  // Promote to next higher rank
  return { rank: rank - 1, stars: 0, isLegend: false, legendPosition: null, promoted: true, enteredLegend: false };
}

/**
 * Apply a loss to the given rank state.
 *
 * - Ranks 15–10 (>= PROTECTION_FLOOR): no change
 * - Ranks 9–6 (>= SOFT_LOSS_FLOOR):  lose 1 star if stars > 0, else stay at 0 stars
 * - Ranks 5–1  (< SOFT_LOSS_FLOOR):  lose 1 star if stars > 0; else demote (rank+1, stars=3)
 *
 * @param {{ rank: number, stars: number, isLegend: boolean, legendPosition: number|null }} state
 * @returns {{ rank: number, stars: number, isLegend: boolean, legendPosition: number|null, demoted: boolean }}
 */
function applyRankLoss(state) {
  const { rank, stars, isLegend, legendPosition } = normalizeRankState(state);

  // Legend players don't change within this PR
  if (isLegend) {
    return { rank, stars, isLegend, legendPosition, demoted: false };
  }

  // Protected zone: ranks 15 down to PROTECTION_FLOOR (10)
  if (rank >= PROTECTION_FLOOR) {
    return { rank, stars, isLegend: false, legendPosition: null, demoted: false };
  }

  // Soft-loss zone: ranks 9 down to SOFT_LOSS_FLOOR (6)
  if (rank >= SOFT_LOSS_FLOOR) {
    if (stars > 0) {
      return { rank, stars: stars - 1, isLegend: false, legendPosition: null, demoted: false };
    }
    return { rank, stars: 0, isLegend: false, legendPosition: null, demoted: false };
  }

  // Hard-loss zone: ranks 5 down to 1
  if (stars > 0) {
    return { rank, stars: stars - 1, isLegend: false, legendPosition: null, demoted: false };
  }

  // Stars already 0 → demote
  const newRank = rank + 1; // rank 4 -> 5 etc.; rank 1 can't be <= 0 after normalise
  return { rank: newRank, stars: MAX_STARS, isLegend: false, legendPosition: null, demoted: true };
}

/**
 * Determine whether two players are eligible to match against each other.
 *
 * Rules (for future duel integration):
 * - A Legend can only match another Legend.
 * - Non-Legends can match within ±2 ranks of each other.
 *
 * @param {{ rank: number, isLegend: boolean }} stateA
 * @param {{ rank: number, isLegend: boolean }} stateB
 * @returns {boolean}
 */
function canMatchOpponents(stateA, stateB) {
  const a = normalizeRankState(stateA);
  const b = normalizeRankState(stateB);

  if (a.isLegend !== b.isLegend) return false;
  if (a.isLegend && b.isLegend) return true;

  return Math.abs(a.rank - b.rank) <= 2;
}

module.exports = {
  normalizeRankState,
  getRankTier,
  getRankDisplay,
  applyRankWin,
  applyRankLoss,
  canMatchOpponents,
};
