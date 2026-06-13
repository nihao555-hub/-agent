import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { IntakeItem } from './types';

const RESUME_EXT = new Set(['.pdf', '.doc', '.docx', '.txt']);

/**
 * 扫描归集目录，读取其中的简历文件为归集项（txt 取文本，其余转 base64）。
 * `processed` 用于跨多次扫描/监听去重，避免同一文件重复入库（不会改动用户文件）。
 */
export async function readFolderItems(dir: string, processed: Set<string>): Promise<IntakeItem[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const items: IntakeItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!RESUME_EXT.has(ext)) continue;
    const full = join(dir, entry.name);
    if (processed.has(full)) continue;
    const buf = await readFile(full);
    if (ext === '.txt') {
      items.push({ text: buf.toString('utf-8'), meta: `文件：${entry.name}` });
    } else {
      items.push({
        fileBase64: buf.toString('base64'),
        fileName: entry.name,
        meta: `文件：${entry.name}`,
      });
    }
    processed.add(full);
  }
  return items;
}
