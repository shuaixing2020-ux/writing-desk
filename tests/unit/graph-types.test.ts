/**
 * 关系类型注册表测试（G0-6）。
 *
 * 重点：内置默认正确、文件可覆盖、JSON 损坏要降级而不是崩溃。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RELATION_TYPES_FILE,
  defaultRelationTypes,
  describeAllowed,
  getTypeDef,
  isEndpointAllowed,
  loadRelationTypes,
  resolveTypeKey,
} from '../../server/graph/types.ts';

describe('内置类型默认值', () => {
  const table = defaultRelationTypes();

  test('十条内置类型齐全', () => {
    const expected = ['mentor', 'kin', 'love', 'ally', 'enemy', 'member_of', 'located_at', 'participates', 'causes', 'owns'];
    for (const k of expected) {
      assert.ok(table.byKey.has(k), `缺少内置类型 ${k}`);
    }
    assert.equal(table.byKey.size, 10);
  });

  test('师徒有向且禁成环', () => {
    const d = table.byKey.get('mentor')!;
    assert.equal(d.label, '师徒');
    assert.equal(d.inverse_label, '徒弟');
    assert.equal(d.directed, true);
    assert.equal(d.acyclic, true);
  });

  test('亲属无向', () => {
    assert.equal(table.byKey.get('kin')!.directed, false);
  });

  test('盟友与敌对互斥', () => {
    assert.deepEqual(table.byKey.get('ally')!.exclusive_with, ['enemy']);
    assert.deepEqual(table.byKey.get('enemy')!.exclusive_with, ['ally']);
  });

  test('causes 禁成环', () => {
    assert.equal(table.byKey.get('causes')!.acyclic, true);
  });
});

describe('类型解析', () => {
  const table = defaultRelationTypes();

  test('按 key 解析', () => {
    assert.equal(resolveTypeKey(table, 'mentor'), 'mentor');
  });

  test('按中文显示名解析', () => {
    assert.equal(resolveTypeKey(table, '师徒'), 'mentor');
    assert.equal(resolveTypeKey(table, '敌对'), 'enemy');
  });

  test('未知类型返回 null', () => {
    assert.equal(resolveTypeKey(table, '不存在的类型'), null);
    assert.equal(resolveTypeKey(table, ''), null);
  });

  test('端点约束：师徒只能角色→角色', () => {
    const d = getTypeDef(table, 'mentor')!;
    assert.equal(isEndpointAllowed(d, 'character', 'character'), true);
    assert.equal(isEndpointAllowed(d, 'character', 'faction'), false);
    assert.equal(isEndpointAllowed(d, 'faction', 'character'), false);
  });

  test('端点约束：隶属是角色→势力、势力→势力', () => {
    const d = getTypeDef(table, 'member_of')!;
    assert.equal(isEndpointAllowed(d, 'character', 'faction'), true);
    assert.equal(isEndpointAllowed(d, 'faction', 'faction'), true);
    assert.equal(isEndpointAllowed(d, 'faction', 'character'), false, '势力→角色不是"隶属"');
  });

  test('端点约束：导致只能事件→事件', () => {
    const d = getTypeDef(table, 'causes')!;
    assert.equal(isEndpointAllowed(d, 'event', 'event'), true);
    assert.equal(isEndpointAllowed(d, 'character', 'event'), false);
  });

  test('describeAllowed 生成可读文本', () => {
    const d = getTypeDef(table, 'owns')!;
    const text = describeAllowed(d);
    assert.ok(text.includes('character→item'), text);
    assert.ok(text.includes('faction→item'), text);
  });
});

describe('配置文件覆盖', () => {
  async function projectWith(config: unknown | null): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-reltypes-'));
    if (config !== null) {
      const file = path.join(dir, RELATION_TYPES_FILE);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, typeof config === 'string' ? config : JSON.stringify(config));
    }
    return dir;
  }

  test('配置文件不存在时用默认值，无警告', async () => {
    const dir = await projectWith(null);
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.size, 10);
    assert.deepEqual(table.warnings, []);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('覆盖内置类型的显示名', async () => {
    const dir = await projectWith([{ key: 'mentor', label: '师承', inverse_label: '传人' }]);
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.get('mentor')!.label, '师承');
    assert.equal(table.byKey.get('mentor')!.inverse_label, '传人');
    // 未覆盖的字段保持默认
    assert.equal(table.byKey.get('mentor')!.acyclic, true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('新增自定义类型', async () => {
    const dir = await projectWith([
      { key: 'sworn', label: '结拜', inverse_label: '结拜', directed: false, allowed: [['character', 'character']], acyclic: false },
    ]);
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.has('sworn'), true);
    assert.equal(resolveTypeKey(table, '结拜'), 'sworn');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('禁用内置类型', async () => {
    const dir = await projectWith([{ key: 'love', disabled: true }]);
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.has('love'), false);
    assert.equal(resolveTypeKey(table, '情感'), null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('支持 { types: [...] } 包装格式', async () => {
    const dir = await projectWith({ types: [{ key: 'x1', label: '测试类型' }] });
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.has('x1'), true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('JSON 损坏时回退默认并给出警告，不抛错', async () => {
    const dir = await projectWith('{ 这不是合法 JSON');
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.size, 10, '应回退到默认的 10 条');
    assert.ok(table.warnings.length > 0, '应报告警告');
    assert.match(table.warnings[0], /不是合法 JSON/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('非法条目被跳过并记警告', async () => {
    const dir = await projectWith([{ label: '没有 key' }, { key: 'ok1', label: '正常' }]);
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.has('ok1'), true);
    assert.equal(table.warnings.length, 1);
    assert.match(table.warnings[0], /缺少 key/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('allowed: null 表示不限类型', async () => {
    const dir = await projectWith([{ key: 'any', label: '任意', allowed: null }]);
    const table = await loadRelationTypes(dir);
    assert.equal(table.byKey.get('any')!.allowed, null);
    const d = getTypeDef(table, 'any')!;
    assert.equal(isEndpointAllowed(d, 'character', 'event'), true);
    assert.equal(isEndpointAllowed(d, 'place', 'item'), true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────── G1' 修订：角色词（A2） ───────────────────────────

describe('角色词（A2）', () => {
  const table = defaultRelationTypes();

  test('师徒：师父 / 徒弟，非对称', () => {
    const def = getTypeDef(table, 'mentor')!;
    assert.equal(def.from_role, '师父');
    assert.equal(def.to_role, '徒弟');
    assert.equal(def.symmetric, false);
  });

  test('亲属：父母 / 子女', () => {
    const def = getTypeDef(table, 'kin')!;
    assert.equal(def.from_role, '父母');
    assert.equal(def.to_role, '子女');
    assert.equal(def.symmetric, false);
  });

  test('对称类型只有一个称呼', () => {
    for (const key of ['love', 'ally', 'enemy']) {
      const def = getTypeDef(table, key)!;
      assert.equal(def.symmetric, true, `${key} 应是对称关系`);
      assert.equal(def.from_role, def.to_role, `${key} 的两个角色词应相同`);
    }
  });

  test('其余内置类型都有角色词', () => {
    for (const key of ['member_of', 'located_at', 'participates', 'causes', 'owns']) {
      const def = getTypeDef(table, key)!;
      assert.ok(def.from_role.length > 0, `${key} 缺 from_role`);
      assert.ok(def.to_role.length > 0, `${key} 缺 to_role`);
    }
  });

  test('配置文件可覆盖角色词', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-roles-'));
    try {
      await fs.mkdir(path.join(dir, 'bible'), { recursive: true });
      await fs.writeFile(
        path.join(dir, RELATION_TYPES_FILE),
        JSON.stringify([{ key: 'mentor', from_role: '师尊', to_role: '门徒' }]),
      );
      const loaded = await loadRelationTypes(dir);
      const def = getTypeDef(loaded, 'mentor')!;
      assert.equal(def.from_role, '师尊');
      assert.equal(def.to_role, '门徒');
      // 没覆盖的字段仍用内置值
      assert.equal(def.label, '师徒');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('旧配置文件（没有角色词）仍可用：回退到 label 与 inverse_label', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-roles-'));
    try {
      await fs.mkdir(path.join(dir, 'bible'), { recursive: true });
      await fs.writeFile(
        path.join(dir, RELATION_TYPES_FILE),
        JSON.stringify([{ key: 'mentor', label: '师承' }]),
      );
      const loaded = await loadRelationTypes(dir);
      const def = getTypeDef(loaded, 'mentor')!;
      assert.equal(def.label, '师承', '显示名应被覆盖');
      // 只改显示名时角色词沿用内置默认值：作者没写的字段不该被猜成别的词
      assert.equal(def.from_role, '师父');
      assert.equal(def.to_role, '徒弟');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
