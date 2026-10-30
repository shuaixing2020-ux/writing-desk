/**
 * 界面偏好单元测试（L1）。
 *
 * 重点是「不能把正文挤没」和「坏数据不能把应用弄挂」这两条。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PREFS,
  MAX_INSPECTOR_W,
  MIN_EDITOR_W,
  MIN_INSPECTOR_W,
  PRESET_NARROW,
  PRESET_WIDE,
  SIDEBAR_W,
  UI_PREFS_KEY,
  clampInspectorWidth,
  loadPrefs,
  parsePrefs,
  savePrefs,
  stepInspectorWidth,
  type PrefStorage,
} from '../../web/src/lib/ui-prefs.ts';

describe('clampInspectorWidth', () => {
  test('正常宽度原样保留', () => {
    assert.equal(clampInspectorWidth(420, 1600), 420);
  });

  test('低于下限抬到 300', () => {
    assert.equal(clampInspectorWidth(120, 1600), MIN_INSPECTOR_W);
  });

  test('高于上限压到 720', () => {
    assert.equal(clampInspectorWidth(2000, 3000), MAX_INSPECTOR_W);
  });

  test('窗口不够宽时保证正文至少 560', () => {
    // 1200 - 260 - 560 = 380 可用
    const w = clampInspectorWidth(700, 1200);
    assert.equal(w, 380);
    assert.ok(1200 - SIDEBAR_W - w >= MIN_EDITOR_W, '正文宽度必须够');
  });

  test('窗口极窄时不小于 300（宁可挤正文也不给负宽度）', () => {
    const w = clampInspectorWidth(600, 900);
    assert.equal(w, MIN_INSPECTOR_W);
  });

  test('小数四舍五入，避免半像素抖动', () => {
    assert.equal(clampInspectorWidth(420.6, 1600), 421);
    assert.equal(clampInspectorWidth(420.4, 1600), 420);
  });

  test('非有限数退回下限', () => {
    assert.equal(clampInspectorWidth(Number.NaN, 1600), MIN_INSPECTOR_W);
    assert.equal(clampInspectorWidth(Number.POSITIVE_INFINITY, 1600), MIN_INSPECTOR_W);
  });
});

describe('parsePrefs', () => {
  test('空值返回默认', () => {
    assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
    assert.deepEqual(parsePrefs(''), DEFAULT_PREFS);
  });

  test('坏 JSON 返回默认，不抛错', () => {
    assert.deepEqual(parsePrefs('{不是 json'), DEFAULT_PREFS);
  });

  test('非对象返回默认', () => {
    assert.deepEqual(parsePrefs('42'), DEFAULT_PREFS);
    assert.deepEqual(parsePrefs('"x"'), DEFAULT_PREFS);
  });

  test('缺字段用默认值补齐', () => {
    const p = parsePrefs(JSON.stringify({ inspectorWidth: 500 }));
    assert.equal(p.inspectorWidth, 500);
    assert.equal(p.inspectorOpen, DEFAULT_PREFS.inspectorOpen);
    assert.equal(p.outlineMode, 'list');
  });

  test('越界宽度被钳制到合法区间', () => {
    assert.equal(parsePrefs(JSON.stringify({ inspectorWidth: 5000 })).inspectorWidth, MAX_INSPECTOR_W);
    assert.equal(parsePrefs(JSON.stringify({ inspectorWidth: 1 })).inspectorWidth, MIN_INSPECTOR_W);
  });

  test('字段类型不对时用默认值', () => {
    const p = parsePrefs(JSON.stringify({ inspectorOpen: 'yes', inspectorWidth: 'wide' }));
    assert.equal(p.inspectorOpen, DEFAULT_PREFS.inspectorOpen);
    assert.equal(p.inspectorWidth, DEFAULT_PREFS.inspectorWidth);
  });

  test('outlineMode 只接受 list / map', () => {
    assert.equal(parsePrefs(JSON.stringify({ outlineMode: 'map' })).outlineMode, 'map');
    assert.equal(parsePrefs(JSON.stringify({ outlineMode: '别的' })).outlineMode, 'list');
  });

  test('完整对象原样读回', () => {
    const prefs = {
      inspectorWidth: 560,
      inspectorOpen: false,
      lastPanel: 'bible',
      focusMode: true,
      outlineMode: 'map',
    };
    assert.deepEqual(parsePrefs(JSON.stringify(prefs)), prefs);
  });
});

describe('读写与容错', () => {
  function memoryStorage(initial: Record<string, string> = {}): PrefStorage & { data: Record<string, string> } {
    const data = { ...initial };
    return {
      data,
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => {
        data[k] = v;
      },
    };
  }

  test('保存后能读回', () => {
    const s = memoryStorage();
    const prefs = { ...DEFAULT_PREFS, inspectorWidth: 520 };
    savePrefs(prefs, s);
    assert.deepEqual(loadPrefs(s), prefs);
    assert.ok(UI_PREFS_KEY in s.data);
  });

  test('读取抛错时返回默认值', () => {
    const broken: PrefStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {},
    };
    assert.deepEqual(loadPrefs(broken), DEFAULT_PREFS);
  });

  test('写入抛错时静默，不向外抛', () => {
    const broken: PrefStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    assert.doesNotThrow(() => savePrefs(DEFAULT_PREFS, broken));
  });
});

describe('stepInspectorWidth', () => {
  test('方向键每次 16px', () => {
    assert.equal(stepInspectorWidth(400, 1, 1600), 416);
    assert.equal(stepInspectorWidth(400, -1, 1600), 384);
  });

  test('调整也受钳制', () => {
    assert.equal(stepInspectorWidth(MIN_INSPECTOR_W, -1, 1600), MIN_INSPECTOR_W);
    assert.equal(stepInspectorWidth(MAX_INSPECTOR_W, 1, 3000), MAX_INSPECTOR_W);
  });
});

describe('预设档位', () => {
  test('窄栏 380 / 宽栏 560 都在合法区间内', () => {
    assert.ok(PRESET_NARROW >= MIN_INSPECTOR_W && PRESET_NARROW <= MAX_INSPECTOR_W);
    assert.ok(PRESET_WIDE >= MIN_INSPECTOR_W && PRESET_WIDE <= MAX_INSPECTOR_W);
    assert.ok(PRESET_WIDE > PRESET_NARROW);
  });

  test('默认宽度就是窄栏', () => {
    assert.equal(DEFAULT_PREFS.inspectorWidth, PRESET_NARROW);
  });
});
