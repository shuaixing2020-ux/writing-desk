/**
 * 生成演示作品 —— 首次运行时的示例内容，也用于手工验收。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/seed-demo.mjs
 *   WD_DATA_DIR=/tmp/x node scripts/seed-demo.mjs
 *
 * 只创建数据，不启动服务。已存在同名作品时跳过，不覆盖。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.WD_DATA_DIR ?? path.join(root, 'data', 'projects');
const projectRoot = path.join(dataDir, '示例小说');

// 直接复用服务端实现，保证演示数据的格式与真实写入完全一致
const { ProjectStore } = await import(path.join(root, 'server/store/project.ts'));

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

if (await exists(path.join(projectRoot, 'project.json'))) {
  console.log(`示例作品已存在，跳过：${projectRoot}`);
  process.exit(0);
}

console.log('正在生成演示作品…');
const store = await ProjectStore.create(projectRoot, {
  title: '示例小说',
  author: '写作台',
  mode: 'webnovel',
});

await store.updateMeta({ daily_goal: 3000, count_mode: 'hanzi' });

// ── 第一卷 ──
const v1 = await store.createNode({ kind: 'volume', parent_id: null, title: '第一卷 · 山门' });
const c1 = await store.createNode({ kind: 'chapter', parent_id: v1.id, title: '开篇' });
const c2 = await store.createNode({ kind: 'chapter', parent_id: v1.id, title: '夜雨' });

const s1 = await store.createNode({ kind: 'scene', parent_id: c1.id, title: '雨夜来客' });
const s2 = await store.createNode({ kind: 'scene', parent_id: c1.id, title: '入门' });
const s3 = await store.createNode({ kind: 'scene', parent_id: c2.id, title: '剑鸣' });

await store.writeScene(
  s1.id,
  `夜雨敲窗，山门外一片寂静。

守门的老仆缩在门房里，就着一盏将熄的油灯打盹。檐角的水珠连成线，砸在青石板上，一声一声，像是谁在数着时辰。

“师父，我回来了。”

少年站在雨里，斗笠压得很低，声音却很稳。他没有撑伞，雨水顺着衣角往下淌，在脚边积成一小滩。

门房里没有应声。`,
  1,
);

await store.writeScene(
  s2.id,
  `“进来。”

声音从后山传来，隔着雨幕，却清清楚楚落在耳里。

少年摘下斗笠，露出一张被雨水洗得发白的脸。他抬头看了一眼山门上方的匾额——“青云”两个字被雨水浸得发黑，笔画里积着泥。

他跪下，磕了三个头。

“弟子林远，奉师命下山三年，今日归山复命。”

山门无风自动，缓缓开了一线。`,
  1,
);

await store.writeScene(
  s3.id,
  `剑鸣声起时，雨恰好停了。

林远站在藏剑阁前，看着那柄插在石台上的剑。剑身没有出鞘，却在轻轻震颤，嗡鸣声越来越急，像是压抑了三年。

“它还认得你。”身后有人说。

林远没有回头。“它也记得我走的时候，没能带走它。”

“你现在能带走了。”

林远沉默了很久，伸手握住剑柄。

剑鸣骤停。`,
  1,
);

// ── 第二卷（留空，展示新建状态）──
await store.createNode({ kind: 'volume', parent_id: null, title: '第二卷 · 剑出' });

// ── 设定库 ──
await store.saveEntity({
  type: 'character',
  name: '林远',
  aliases: ['小林', '林师兄'],
  fields: { 身份: '青云门弟子', 年龄: '十九', 佩剑: '未名' },
  description:
    '青云门弟子，三年前奉师命下山历练，性格沉稳寡言，剑法出众。左手腕有一道旧疤，从不解释来历。',
});

await store.saveEntity({
  type: 'character',
  name: '师父',
  aliases: ['师尊', '掌门'],
  fields: { 身份: '青云门掌门', 年龄: '不详' },
  description: '青云门掌门。话极少，行踪不定。三年前命林远下山，未说明缘由。',
});

await store.saveEntity({
  type: 'place',
  name: '青云门',
  aliases: ['山门'],
  fields: { 位置: '青云山', 气候: '多雨' },
  description: '建在青云山半腰的剑修门派。山门为青石所筑，匾额上的字已有些年头。',
});

await store.saveEntity({
  type: 'item',
  name: '未名剑',
  aliases: ['那柄剑'],
  fields: { 品阶: '未知', 状态: '认主' },
  description: '插在藏剑阁石台上的剑，剑身未出鞘。会随主人心境嗡鸣。',
});

await store.saveEntity({
  type: 'term',
  name: '归山复命',
  aliases: [],
  fields: { 类别: '门规' },
  description: '青云门弟子下山历练后，须回山向掌门复命。未复命者，视为叛门。',
});

// ── 灵感箱 ──
await store.addInbox('雨声可以当作计时器——数到第几声时门开了？');
await store.addInbox('“它还认得你” 这句可以做全书回扣');
await store.addInbox('林远手腕的疤，第三卷再解释');

// ── 快照 ──
const scene1 = await store.readScene(s1.id);
if (scene1) {
  console.log('演示作品已生成：');
  console.log(`  路径：${projectRoot}`);
  console.log(`  卷章场景：2 卷 / 2 章 / 3 场景`);
  console.log(`  设定条目：5 条`);
  console.log(`  灵感：3 条`);
  console.log(`\n启动服务后打开 http://127.0.0.1:7788 即可看到。`);
}
