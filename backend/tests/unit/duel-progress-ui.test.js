'use strict';

/**
 * Unit tests for frontend/js/duel-progress.js
 * Run with: node tests/unit/duel-progress-ui.test.js
 * Uses Node.js built-in test runner + jsdom for DOM simulation.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Load the module source
// ---------------------------------------------------------------------------

const moduleSrc = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'frontend/js/duel-progress.js'),
    'utf8',
);

// ---------------------------------------------------------------------------
// DOM factory — create a fresh JSDOM environment for each test
// ---------------------------------------------------------------------------

function createDom() {
    const html = `<!DOCTYPE html>
<html>
<body>
  <div id="duel-progress-panel" style="display:none">
    <div id="duel-progress-elapsed">⏱ 00:00.000</div>
    <div id="duel-progress-checkpoints"></div>
    <div id="duel-progress-finish">🏁 Финиш: ожидание</div>
  </div>
</body>
</html>`;

    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
    });

    // Evaluate the module in this JSDOM context
    dom.window.eval(moduleSrc);

    return dom;
}

// ---------------------------------------------------------------------------
// Mock socket factory
// ---------------------------------------------------------------------------

function createMockSocket() {
    const handlers = {};
    return {
        on: function (event, handler) {
            handlers[event] = handler;
        },
        emit: function (event, data) {
            if (handlers[event]) handlers[event](data);
        },
        _trigger: function (event, data) {
            if (handlers[event]) handlers[event](data);
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuelProgress — init', () => {
    test('init() does not throw with a mock socket', () => {
        const dom = createDom();
        const socket = createMockSocket();
        assert.doesNotThrow(() => {
            dom.window.DuelProgress.init(socket);
        });
    });

    test('DuelProgress is defined on window after module load', () => {
        const dom = createDom();
        assert.ok(dom.window.DuelProgress, 'DuelProgress should be defined');
        assert.equal(typeof dom.window.DuelProgress.init, 'function');
        assert.equal(typeof dom.window.DuelProgress.activate, 'function');
        assert.equal(typeof dom.window.DuelProgress.reset, 'function');
        assert.equal(typeof dom.window.DuelProgress.setRequiredCheckpoints, 'function');
    });
});

describe('DuelProgress — activate / reset', () => {
    test('activate() shows #duel-progress-panel', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        const panel = dom.window.document.getElementById('duel-progress-panel');
        assert.equal(panel.style.display, 'none', 'panel should start hidden');

        dom.window.DuelProgress.activate();
        assert.equal(panel.style.display, '', 'panel should be visible after activate()');
    });

    test('reset() hides #duel-progress-panel', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.activate();
        const panel = dom.window.document.getElementById('duel-progress-panel');
        assert.equal(panel.style.display, '', 'panel should be visible after activate()');

        dom.window.DuelProgress.reset();
        assert.equal(panel.style.display, 'none', 'panel should be hidden after reset()');
    });

    test('activate() is idempotent', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        assert.doesNotThrow(() => {
            dom.window.DuelProgress.activate();
            dom.window.DuelProgress.activate();
        });
        const panel = dom.window.document.getElementById('duel-progress-panel');
        assert.equal(panel.style.display, '', 'panel should be visible');
    });

    test('reset() is idempotent', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        assert.doesNotThrow(() => {
            dom.window.DuelProgress.reset();
            dom.window.DuelProgress.reset();
        });
        const panel = dom.window.document.getElementById('duel-progress-panel');
        assert.equal(panel.style.display, 'none');
    });
});

describe('DuelProgress — setRequiredCheckpoints + activate renders checkpoint items', () => {
    test('setRequiredCheckpoints(2) + activate() renders 2 checkpoint items', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(2);
        dom.window.DuelProgress.activate();

        const container = dom.window.document.getElementById('duel-progress-checkpoints');
        const items = container.querySelectorAll('.duel-checkpoint-item');
        assert.equal(items.length, 2, 'should render 2 checkpoint items');
    });

    test('setRequiredCheckpoints(3) + activate() renders 3 checkpoint items', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(3);
        dom.window.DuelProgress.activate();

        const container = dom.window.document.getElementById('duel-progress-checkpoints');
        const items = container.querySelectorAll('.duel-checkpoint-item');
        assert.equal(items.length, 3, 'should render 3 checkpoint items');
    });

    test('checkpoint items start with ⬜ icon and no "hit" class', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(2);
        dom.window.DuelProgress.activate();

        const container = dom.window.document.getElementById('duel-progress-checkpoints');
        const items = container.querySelectorAll('.duel-checkpoint-item');
        items.forEach(function (item, i) {
            assert.ok(!item.classList.contains('hit'), 'item ' + i + ' should not have "hit" class');
            const icon = item.querySelector('.duel-checkpoint-icon');
            assert.equal(icon && icon.textContent, '⬜', 'item ' + i + ' icon should be ⬜');
        });
    });

    test('activate() resets finish indicator text', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.activate();
        const finishEl = dom.window.document.getElementById('duel-progress-finish');
        assert.ok(
            finishEl.textContent.includes('ожидание'),
            'finish should show "ожидание" after activate()',
        );
    });
});

describe('DuelProgress — duel:checkpoint_ok event', () => {
    test('duel:checkpoint_ok marks checkpoint as hit (✅ icon + hit class)', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(2);
        dom.window.DuelProgress.activate();

        // Trigger lap start so timestamps work
        socket._trigger('duel:lap_started', {});

        // Hit checkpoint 0
        socket._trigger('duel:checkpoint_ok', { index: 0, nextCheckpoint: 1 });

        const item0 = dom.window.document.getElementById('duel-cp-item-0');
        assert.ok(item0.classList.contains('hit'), 'item 0 should have "hit" class');
        const icon0 = dom.window.document.getElementById('duel-cp-icon-0');
        assert.equal(icon0 && icon0.textContent, '✅', 'item 0 icon should be ✅');
    });

    test('finish indicator gets "ready" class when all checkpoints hit', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(2);
        dom.window.DuelProgress.activate();

        socket._trigger('duel:lap_started', {});
        socket._trigger('duel:checkpoint_ok', { index: 0 });
        socket._trigger('duel:checkpoint_ok', { index: 1 });

        const finishEl = dom.window.document.getElementById('duel-progress-finish');
        assert.ok(finishEl.classList.contains('ready'), 'finish should have "ready" class');
        assert.ok(
            finishEl.textContent.includes('все чекпоинты пройдены'),
            'finish text should indicate all checkpoints passed',
        );
    });

    test('finish indicator does NOT get "ready" class when only one of two checkpoints hit', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(2);
        dom.window.DuelProgress.activate();

        socket._trigger('duel:lap_started', {});
        socket._trigger('duel:checkpoint_ok', { index: 0 });

        const finishEl = dom.window.document.getElementById('duel-progress-finish');
        assert.ok(!finishEl.classList.contains('ready'), 'finish should not have "ready" class yet');
    });
});

describe('DuelProgress — duel:result event', () => {
    test('duel:result stops the elapsed timer (no throws)', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(2);
        dom.window.DuelProgress.activate();

        socket._trigger('duel:lap_started', {});
        assert.doesNotThrow(() => {
            socket._trigger('duel:result', { result: 'win' });
        });
    });
});

describe('DuelProgress — reset clears checkpoint state', () => {
    test('reset() after checkpoint hit re-renders clean items on next activate()', () => {
        const dom = createDom();
        const socket = createMockSocket();
        dom.window.DuelProgress.init(socket);

        dom.window.DuelProgress.setRequiredCheckpoints(2);
        dom.window.DuelProgress.activate();
        socket._trigger('duel:lap_started', {});
        socket._trigger('duel:checkpoint_ok', { index: 0 });

        dom.window.DuelProgress.reset();

        // Activate again — should show clean state
        dom.window.DuelProgress.activate();
        const container = dom.window.document.getElementById('duel-progress-checkpoints');
        const hitItems = container.querySelectorAll('.duel-checkpoint-item.hit');
        assert.equal(hitItems.length, 0, 'no items should be "hit" after reset + re-activate');
    });
});
