'use strict';

/**
 * Unit tests for backend/lib/rank-system.js
 * Run with: node tests/unit/rank-system.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyRankWin,
  applyRankLoss,
  canMatchOpponents,
  normalizeRankState,
  getRankDisplay,
} = require('../../lib/rank-system');

// ---------------------------------------------------------------------------
// applyRankWin — win scenarios
// ---------------------------------------------------------------------------
test('win: 15/0 -> 15/1', () => {
  const result = applyRankWin({ rank: 15, stars: 0, isLegend: false });
  assert.equal(result.rank, 15);
  assert.equal(result.stars, 1);
  assert.equal(result.isLegend, false);
  assert.equal(result.promoted, false);
  assert.equal(result.enteredLegend, false);
});

test('win: 15/2 -> 15/3', () => {
  const result = applyRankWin({ rank: 15, stars: 2, isLegend: false });
  assert.equal(result.rank, 15);
  assert.equal(result.stars, 3);
  assert.equal(result.isLegend, false);
  assert.equal(result.promoted, false);
  assert.equal(result.enteredLegend, false);
});

test('win: 15/3 -> 14/0 (promotion)', () => {
  const result = applyRankWin({ rank: 15, stars: 3, isLegend: false });
  assert.equal(result.rank, 14);
  assert.equal(result.stars, 0);
  assert.equal(result.isLegend, false);
  assert.equal(result.promoted, true);
  assert.equal(result.enteredLegend, false);
});

test('win: 1/3 -> Legend', () => {
  const result = applyRankWin({ rank: 1, stars: 3, isLegend: false });
  assert.equal(result.rank, 1);
  assert.equal(result.stars, 0);
  assert.equal(result.isLegend, true);
  assert.equal(result.promoted, false);
  assert.equal(result.enteredLegend, true);
});

// Intermediate promotion check
test('win: 2/3 -> 1/0 (promotion to rank 1)', () => {
  const result = applyRankWin({ rank: 2, stars: 3, isLegend: false });
  assert.equal(result.rank, 1);
  assert.equal(result.stars, 0);
  assert.equal(result.isLegend, false);
  assert.equal(result.promoted, true);
  assert.equal(result.enteredLegend, false);
});

// Legend win — no change in this PR
test('win: Legend stays Legend (no intra-legend change)', () => {
  const result = applyRankWin({ rank: 1, stars: 0, isLegend: true, legendPosition: 3 });
  assert.equal(result.isLegend, true);
  assert.equal(result.legendPosition, 3);
  assert.equal(result.enteredLegend, false);
  assert.equal(result.promoted, false);
});

// ---------------------------------------------------------------------------
// applyRankLoss — loss scenarios
// ---------------------------------------------------------------------------
test('loss: 12/2 -> 12/2 (protected zone, no change)', () => {
  const result = applyRankLoss({ rank: 12, stars: 2, isLegend: false });
  assert.equal(result.rank, 12);
  assert.equal(result.stars, 2);
  assert.equal(result.demoted, false);
});

test('loss: 8/2 -> 8/1 (soft-loss zone)', () => {
  const result = applyRankLoss({ rank: 8, stars: 2, isLegend: false });
  assert.equal(result.rank, 8);
  assert.equal(result.stars, 1);
  assert.equal(result.demoted, false);
});

test('loss: 8/0 -> 8/0 (soft-loss zone, already 0 stars)', () => {
  const result = applyRankLoss({ rank: 8, stars: 0, isLegend: false });
  assert.equal(result.rank, 8);
  assert.equal(result.stars, 0);
  assert.equal(result.demoted, false);
});

test('loss: 3/2 -> 3/1 (hard-loss zone)', () => {
  const result = applyRankLoss({ rank: 3, stars: 2, isLegend: false });
  assert.equal(result.rank, 3);
  assert.equal(result.stars, 1);
  assert.equal(result.demoted, false);
});

test('loss: 3/0 -> 4/3 (hard-loss zone, demotion)', () => {
  const result = applyRankLoss({ rank: 3, stars: 0, isLegend: false });
  assert.equal(result.rank, 4);
  assert.equal(result.stars, 3);
  assert.equal(result.demoted, true);
});

// Additional edge cases
test('loss: 10/1 -> 10/1 (protection floor boundary)', () => {
  const result = applyRankLoss({ rank: 10, stars: 1, isLegend: false });
  assert.equal(result.rank, 10);
  assert.equal(result.stars, 1);
  assert.equal(result.demoted, false);
});

test('loss: 5/0 -> 6/3 (boundary of hard-loss zone)', () => {
  const result = applyRankLoss({ rank: 5, stars: 0, isLegend: false });
  assert.equal(result.rank, 6);
  assert.equal(result.stars, 3);
  assert.equal(result.demoted, true);
});

test('loss: Legend stays Legend (no change)', () => {
  const result = applyRankLoss({ rank: 1, stars: 0, isLegend: true, legendPosition: 2 });
  assert.equal(result.isLegend, true);
  assert.equal(result.legendPosition, 2);
  assert.equal(result.demoted, false);
});

// ---------------------------------------------------------------------------
// canMatchOpponents — matching rules
// ---------------------------------------------------------------------------
test('match: Legend vs non-Legend => false', () => {
  const a = { rank: 1, isLegend: true };
  const b = { rank: 1, isLegend: false };
  assert.equal(canMatchOpponents(a, b), false);
});

test('match: non-Legend vs Legend => false', () => {
  const a = { rank: 3, isLegend: false };
  const b = { rank: 1, isLegend: true };
  assert.equal(canMatchOpponents(a, b), false);
});

test('match: Legend vs Legend => true', () => {
  const a = { rank: 1, isLegend: true };
  const b = { rank: 1, isLegend: true };
  assert.equal(canMatchOpponents(a, b), true);
});

test('match: same rank non-Legend => true', () => {
  assert.equal(canMatchOpponents({ rank: 5, isLegend: false }, { rank: 5, isLegend: false }), true);
});

test('match: rank difference <= 2 => true', () => {
  assert.equal(canMatchOpponents({ rank: 5, isLegend: false }, { rank: 7, isLegend: false }), true);
});

test('match: rank difference > 2 => false', () => {
  assert.equal(canMatchOpponents({ rank: 1, isLegend: false }, { rank: 5, isLegend: false }), false);
});

// ---------------------------------------------------------------------------
// getRankDisplay — display helpers
// ---------------------------------------------------------------------------
test('display: rank 15, stars 0 shows empty stars', () => {
  const d = getRankDisplay({ rank: 15, stars: 0, isLegend: false });
  assert.equal(d.label, '15');
  assert.equal(d.starsDisplay, '☆☆☆');
  assert.match(d.text, /15/);
  assert.match(d.text, /☆☆☆/);
});

test('display: rank 1, stars 3 shows filled stars', () => {
  const d = getRankDisplay({ rank: 1, stars: 3, isLegend: false });
  assert.equal(d.starsDisplay, '★★★');
});

test('display: Legend with position shows legend text', () => {
  const d = getRankDisplay({ rank: 1, stars: 0, isLegend: true, legendPosition: 5 });
  assert.match(d.text, /Legend/);
  assert.match(d.text, /#5/);
  assert.equal(d.emoji, '🏆');
  assert.equal(d.starsDisplay, '');
});

// ---------------------------------------------------------------------------
// normalizeRankState — defaults and clamping
// ---------------------------------------------------------------------------
test('normalizeRankState: invalid rank defaults to 15', () => {
  const s = normalizeRankState({ rank: 999, stars: 0, isLegend: false });
  assert.equal(s.rank, 15);
});

test('normalizeRankState: missing fields use defaults', () => {
  const s = normalizeRankState({});
  assert.equal(s.rank, 15);
  assert.equal(s.stars, 0);
  assert.equal(s.isLegend, false);
  assert.equal(s.legendPosition, null);
});
