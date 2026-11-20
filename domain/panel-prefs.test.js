import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_SCREENS,
  PANEL_SIDES,
  panelPrefKey,
  parsePanelCollapsed,
  readPanelCollapsed,
  writePanelCollapsed,
} from './panel-prefs.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    data,
  };
}

describe('panel-prefs', () => {
  it('keys are per screen and per panel', () => {
    const keys = new Set();
    for (const screen of PANEL_SCREENS) {
      for (const side of PANEL_SIDES) {
        keys.add(panelPrefKey(screen, side));
      }
    }
    assert.equal(keys.size, 4);
    assert.equal(panelPrefKey('editor', 'left'), 'polis.panel.editor.left');
    assert.equal(panelPrefKey('editor', 'right'), 'polis.panel.editor.right');
    assert.equal(panelPrefKey('battle', 'left'), 'polis.panel.battle.left');
    assert.equal(panelPrefKey('battle', 'right'), 'polis.panel.battle.right');
  });

  it('missing values read as expanded', () => {
    const storage = fakeStorage();
    assert.equal(readPanelCollapsed(storage, 'editor', 'left'), false);
    assert.equal(readPanelCollapsed(storage, 'battle', 'right'), false);
  });

  it('round-trips collapsed state per screen and per panel', () => {
    const storage = fakeStorage();
    writePanelCollapsed(storage, 'editor', 'left', true);
    assert.equal(readPanelCollapsed(storage, 'editor', 'left'), true);
    // Independence: the other panels stay expanded.
    assert.equal(readPanelCollapsed(storage, 'editor', 'right'), false);
    assert.equal(readPanelCollapsed(storage, 'battle', 'left'), false);
    assert.equal(readPanelCollapsed(storage, 'battle', 'right'), false);
    writePanelCollapsed(storage, 'battle', 'right', true);
    assert.equal(readPanelCollapsed(storage, 'battle', 'right'), true);
    assert.equal(readPanelCollapsed(storage, 'editor', 'left'), true);
    writePanelCollapsed(storage, 'editor', 'left', false);
    assert.equal(readPanelCollapsed(storage, 'editor', 'left'), false);
    assert.equal(readPanelCollapsed(storage, 'battle', 'right'), true);
  });

  it('corrupt stored values fall back to expanded without errors', () => {
    for (const raw of [null, '', '  ', 'maybe', '{bad json', '0', 'false']) {
      assert.equal(parsePanelCollapsed(raw), false, JSON.stringify(raw));
    }
    assert.equal(parsePanelCollapsed('true'), true);
    assert.equal(parsePanelCollapsed('TRUE'), true);
    assert.equal(parsePanelCollapsed('1'), true);
    const storage = fakeStorage({ [panelPrefKey('editor', 'left')]: 'garbage!!!' });
    assert.equal(readPanelCollapsed(storage, 'editor', 'left'), false);
  });

  it('never throws on missing or refusing storage', () => {
    assert.equal(readPanelCollapsed(null, 'editor', 'left'), false);
    assert.equal(readPanelCollapsed(undefined, 'battle', 'left'), false);
    assert.equal(readPanelCollapsed({}, 'editor', 'left'), false);
    assert.equal(readPanelCollapsed({ getItem() { throw new Error('denied'); } }, 'editor', 'left'), false);
    assert.equal(readPanelCollapsed(fakeStorage(), 'unknown', 'left'), false);
    assert.equal(readPanelCollapsed(fakeStorage(), 'editor', 'middle'), false);
    // Writes never throw, even when the browser refuses storage.
    writePanelCollapsed(null, 'editor', 'left', true);
    writePanelCollapsed({ setItem() { throw new Error('quota'); } }, 'editor', 'left', true);
    writePanelCollapsed(fakeStorage(), 'unknown', 'left', true);
  });

  it('stored values are plain collapsed flags, not scenario data', () => {
    const storage = fakeStorage();
    writePanelCollapsed(storage, 'editor', 'left', true);
    writePanelCollapsed(storage, 'battle', 'right', true);
    assert.deepEqual(storage.data, {
      'polis.panel.editor.left': 'true',
      'polis.panel.battle.right': 'true',
    });
  });
});
