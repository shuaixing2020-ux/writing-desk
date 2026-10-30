/**
 * 索引库迁移测试（回归）。
 *
 * 背景：给 relation 表加 owner_id 列时只改了建表语句，
 * 老作品的 index.sqlite 不会自动加列 —— 打开作品直接报
 * `no such column: owner_id`，界面表现为「连不上本地写作服务」。
 *
 * 这里用旧版表结构造一个库，验证打开时会自动补列。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

import { IndexDb } from '../../server/db/index.ts';

describe('索引库迁移', () => {
  test('老库缺 owner_id 时打开会自动补列并保留老数据', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-migrate-'));
    const file = path.join(dir, 'index.sqlite');
    try {
      // 造一个「旧版」库：relation 表没有 owner_id
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE relation (
          id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
          type TEXT NOT NULL, since TEXT, until TEXT, reveal TEXT,
          weight INTEGER, note TEXT NOT NULL DEFAULT '',
          extra TEXT NOT NULL DEFAULT '', line_no INTEGER
        );
      `);
      old.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema', '2');
      old
        .prepare('INSERT INTO relation (id, from_id, to_id, type, note) VALUES (?, ?, ?, ?, ?)')
        .run('r_old', 'A', 'B', 'mentor', '老数据');
      old.close();

      // 打开：应当自动迁移，而不是抛 no such column
      const db = await IndexDb.open(file);
      try {
        // allRelations 的 SELECT 里带 owner_id：列没补上这里就会抛错
        const rows = db.allRelations();
        assert.equal(rows.length, 1, '老数据应保留');
        assert.equal(rows[0].id, 'r_old');
      } finally {
        db.close();
      }

      // 列确实存在（关库后直接看表结构）
      const probe = new DatabaseSync(file);
      try {
        const cols = probe.prepare('PRAGMA table_info(relation)').all() as Array<{ name: string }>;
        assert.ok(
          cols.some((c) => c.name === 'owner_id'),
          '应补出 owner_id 列',
        );
      } finally {
        probe.close();
      }

      // 再开一次：迁移必须幂等
      const again = await IndexDb.open(file);
      again.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
