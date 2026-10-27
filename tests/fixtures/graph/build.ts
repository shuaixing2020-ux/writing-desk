/**
 * 生成关系图谱测试夹具。
 *
 * 为什么不直接把文件签入：夹具里含 ulid 之外的大量固定 id 与中文内容，
 * 手写容易出错；用代码生成可以保证与 ProjectStore 的真实写入路径一致
 * （同样是 frontmatter + 原子写），避免"夹具格式对但真实文件格式不对"。
 *
 * 用法：node --disable-warning=ExperimentalWarning tests/fixtures/graph/build.ts <目标目录>
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectStore } from '../../../server/store/project.ts';
import { writeFileAtomic } from '../../../server/util/atomic.ts';
import { parseFrontmatter, stringifyScene } from '../../../server/util/frontmatter.ts';

export const FIXTURE = {
  entities: {
    linyuan: 'ENTITY00000000000000000001',
    master: 'ENTITY00000000000000000002',
    sect: 'ENTITY00000000000000000003',
    gate: 'ENTITY00000000000000000004',
  },
  docs: {
    ch1: 'DOC0000000000000000000001',
    ch2: 'DOC0000000000000000000002',
  },
} as const;

/** 关系块：覆盖正常、悬空、坏锚点、坏行、注释、未知属性 */
const LINYUAN_RELATIONS = `# 主要关系
id=r_linyuan_mentor ${'mentor'} -> ${FIXTURE.entities.master} (老掌门) | since=${FIXTURE.docs.ch1} color=red | 收养并传艺
id=r_linyuan_ally ally -> ${FIXTURE.entities.sect} (青云门) | since=${FIXTURE.docs.ch1} | 同门

# 下面这条的目标条目不存在（悬空）
id=r_linyuan_owns owns -> DELETED_ITEM_000000000001 (已删除的剑) | 来历不明

# 这条的锚点指向已删除的文档
id=r_linyuan_enemy enemy -> ${FIXTURE.entities.master} (老掌门) | since=DOC_DELETED_0000000001 | 后来反目

id=r_bad1 这一行写错了，无法解析
`;

const SECT_RELATIONS = `id=r_sect_ally ally -> ${FIXTURE.entities.linyuan} (林远) | since=${FIXTURE.docs.ch1} | 同门
id=r_sect_inner 师徒 -> ${FIXTURE.entities.linyuan} (林远) | 中文类型名写法
id=r_sect_enemy 敌对 -> DELETED_FACTION_00000001 (已消失的势力)
`;

export async function buildFixture(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });

  // 作品骨架
  const store = await ProjectStore.create(root, { title: '图谱夹具' });

  // 文档树：第一卷 / 两章 / 三个场景
  const v = await store.createNode({ kind: 'volume', parent_id: null, title: '第一卷' });
  const c1 = await store.createNode({ kind: 'chapter', parent_id: v.id, title: '第一章' });
  const c2 = await store.createNode({ kind: 'chapter', parent_id: v.id, title: '第二章' });
  const s1 = await store.createNode({ kind: 'scene', parent_id: c1.id, title: '雨夜' });
  const s2 = await store.createNode({ kind: 'scene', parent_id: c2.id, title: '天明' });
  await store.writeScene(s1.id, '夜雨敲窗，林远推门而入。', 1);
  await store.writeScene(s2.id, '天亮了，老掌门站在山门前。', 1);

  // 条目文件：直接写，保留固定 id
  const bible = path.join(root, 'bible');
  await writeFileAtomic(
    path.join(bible, 'characters', '林远.md'),
    stringifyScene(
      {
        id: FIXTURE.entities.linyuan,
        type: 'character',
        name: '林远',
        aliases: ['小林'],
        relations: LINYUAN_RELATIONS,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      },
      '主角，青云门弟子。',
    ),
  );

  await writeFileAtomic(
    path.join(bible, 'characters', '老掌门.md'),
    stringifyScene(
      { id: FIXTURE.entities.master, type: 'character', name: '老掌门', aliases: ['师父'] },
      '青云门掌门。',
    ),
  );

  await writeFileAtomic(
    path.join(bible, 'factions', '青云门.md'),
    stringifyScene(
      { id: FIXTURE.entities.sect, type: 'faction', name: '青云门', relations: SECT_RELATIONS },
      '剑修门派。',
    ),
  );

  await writeFileAtomic(
    path.join(bible, 'places', '山门.md'),
    stringifyScene({ id: FIXTURE.entities.gate, type: 'place', name: '山门' }, '青石所筑。'),
  );

  // 关系类型配置：覆盖一条 + 新增一条
  await writeFileAtomic(
    path.join(bible, '_relation_types.json'),
    JSON.stringify(
      {
        types: [
          { key: 'mentor', label: '师承', inverse_label: '传人' },
          { key: 'sworn', label: '结拜', inverse_label: '结拜', directed: false, allowed: [['character', 'character']], acyclic: false },
        ],
      },
      null,
      2,
    ) + '\n',
  );
}

/** 夹具里那份 relations 块的原文，测试可直接引用 */
export const FIXTURE_RELATIONS = {
  linyuan: LINYUAN_RELATIONS,
  sect: SECT_RELATIONS,
};

// 作为脚本直接运行时生成到参数指定的目录
if (process.argv[1] && process.argv[1].endsWith('build.ts')) {
  const target = process.argv[2];
  if (!target) {
    console.error('用法: node tests/fixtures/graph/build.ts <目标目录>');
    process.exit(1);
  }
  await buildFixture(path.resolve(target));
  console.log(`夹具已生成: ${path.resolve(target)}`);
}
