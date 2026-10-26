/**
 * 归档写入器 —— 自写 zip 与 tar.gz。
 *
 * 为什么不用第三方库：
 *   - 依赖越少，作者的项目越不容易因为某个包停更而打不开自己的备份；
 *   - epub 与 zip 备份的需求很窄（存储/压缩、UTF-8 文件名、无加密无分卷），
 *     两百行足够，而且格式是公开规范，出问题可以自己查；
 *   - tar.gz 是「备份」场景最稳的容器：Windows 10+ 自带 tar 能直接解开，
 *     万一本工具没了，作者双击或用命令行也能拿回全部文件。
 *
 * 两个格式都只在内存里拼装。小说项目量级（几十 MB）完全放得下，
 * 而且避免了「写一半崩掉留下坏压缩包」的风险 —— 调用方拿到完整 Buffer 后
 * 再走 writeFileAtomic 一次性落盘。
 */

import zlib from 'node:zlib';
import { fitBytes, toPosix } from './common.ts';

export interface ArchiveEntry {
  /** 归档内路径，使用正斜杠 */
  name: string;
  data: Buffer;
  /** 是否强制不压缩（epub 的 mimetype 必须是 store 模式） */
  store?: boolean;
}

// ─────────────────────────── ZIP ───────────────────────────

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** DOS 时间/日期（zip 头只有这个精度，1980 年起算） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 生成 zip。
 * 标志位 0x0800 = 文件名按 UTF-8 编码（中文文件名必需）。
 */
export function buildZip(entries: ArchiveEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(toPosix(entry.name), 'utf8');
    const crc = zlib.crc32(entry.data);
    const useStore = entry.store === true;
    const payload = useStore
      ? entry.data
      : zlib.deflateRawSync(entry.data, { level: 9 });

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(useStore ? 0 : 8, 8); // 压缩方法
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useStore ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ─────────────────────────── TAR.GZ ───────────────────────────

const BLOCK = 512;

/**
 * ustar 头。
 *
 * 100 字节的 name 字段装不下中文长路径（UTF-8 一个汉字 3 字节），
 * 所以用 ustar 的 prefix 字段拆分：prefix(155) + '/' + name(100)。
 * 拆不开就截断 name —— 宁可名字短一点，也不能写出非法头。
 */
function tarHeader(name: string, size: number, mtime: number, mode = 0o644): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);

  let full = toPosix(name).replace(/^\/+/, '');
  let prefix = '';
  if (Buffer.byteLength(full, 'utf8') > 100) {
    const idx = full.lastIndexOf('/');
    if (idx > 0) {
      const candidate = full.slice(0, idx);
      const rest = full.slice(idx + 1);
      if (Buffer.byteLength(candidate, 'utf8') <= 155 && Buffer.byteLength(rest, 'utf8') <= 100) {
        prefix = candidate;
        full = rest;
      } else {
        full = fitBytes(full, 100);
      }
    } else {
      full = fitBytes(full, 100);
    }
  }

  buf.write(fitBytes(full, 100), 0, 'utf8');
  buf.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
  buf.write('0000000\0', 108, 'ascii'); // uid
  buf.write('0000000\0', 116, 'ascii'); // gid
  buf.write(Math.max(0, Math.floor(size)).toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  buf.write(Math.max(0, Math.floor(mtime / 1000)).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  buf.write('        ', 148, 'ascii'); // 校验和占位（8 个空格）
  buf.write('0', 156, 'ascii'); // typeflag = 普通文件
  // linkname 100 字节留空
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  buf.write('0000000\0', 329, 'ascii'); // devmajor
  buf.write('0000000\0', 337, 'ascii'); // devminor
  buf.write(fitBytes(prefix, 155), 345, 'utf8');

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}

function padBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/** 生成 tar.gz（备份用）。目录条目可选，这里只写文件，解压时自动建目录。 */
export function buildTarGz(
  entries: ArchiveEntry[],
  opts: { mtime?: number; level?: number } = {},
): Buffer {
  const mtime = opts.mtime ?? Date.now();
  const parts: Buffer[] = [];

  for (const entry of entries) {
    parts.push(tarHeader(entry.name, entry.data.length, mtime));
    parts.push(entry.data);
    const pad = padBlock(entry.data.length);
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }

  // 结束标记：两个全零块
  parts.push(Buffer.alloc(BLOCK * 2, 0));

  return zlib.gzipSync(Buffer.concat(parts), { level: opts.level ?? 9 });
}
