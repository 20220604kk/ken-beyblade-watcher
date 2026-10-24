import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyLog, OperationalLogPolicy } from './log-policy.js';
import { taipeiDateKey } from './file-log-router.js';

function lineDate(text) {
  const iso = text.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
  if (iso && Number.isFinite(Date.parse(iso[1]))) return new Date(iso[1]);
  const local = text.match(/^\[(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s*(上午|下午|凌晨|清晨|早上|中午|傍晚|晚上)?\s*(\d{1,2}):(\d{2}):(\d{2})/);
  if (!local) return null;
  let hour = Number(local[5]);
  if (local[4]) hour = hour % 12 + (/下午|中午|傍晚|晚上/.test(local[4]) ? 12 : 0);
  const stamp = `${local[1]}-${local[2].padStart(2, '0')}-${local[3].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${local[6]}:${local[7]}+08:00`;
  return Number.isFinite(Date.parse(stamp)) ? new Date(stamp) : null;
}

// Deliberately confined to text logs. No state, purchase JSON/JSONL, session,
// screenshot, cart or recovery files are traversed or removed here.
export async function maintainLogs({ root, now = new Date(), apply = false } = {}) {
  if (!root || path.parse(path.resolve(root)).root === path.resolve(root)) throw new Error('Explicit log directory required');
  const absolute = path.resolve(root);
  const rootStat = await fs.lstat(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Log root must be a real directory');
  const today = taipeiDateKey(now);
  const report = { apply, at: now.toISOString(), filesChanged: 0, filesDeleted: 0, bytesBefore: 0, bytesAfter: 0, removedEntries: 0, skippedActive: 0, skippedLinks: 0, raced: 0 };
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(absolute, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside log root');
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) { report.skippedLinks++; continue; }
      if (stat.isDirectory()) { await visit(file); continue; }
      if (!stat.isFile() || !entry.name.endsWith('.log')) continue;
      // Never rewrite today's or open service output, even if it looks idle.
      if (/^(monitor-current\.|watchdog\.log$|service-lifecycle\.log$)/.test(entry.name)
          || entry.name.includes(today) || taipeiDateKey(stat.mtime) >= today) {
        report.skippedActive++; continue;
      }
      report.bytesBefore += stat.size;
      const input = await fs.readFile(file, 'utf8');
      const entries = input.replace(/^\uFEFF/, '').split(/\r?\n(?=\[\d{4}[\/-])/);
      const kept = [];
      const policy = new OperationalLogPolicy();
      const namedDay = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.log$/)?.[1];
      for (const block of entries) {
        if (!block.trim()) continue;
        const classification = classifyLog(block);
        const date = lineDate(block) || (namedDay ? new Date(`${namedDay}T00:00:00+08:00`) : null);
        const expired = classification.days !== null && date && now - date > classification.days * 86400000;
        if (expired || !policy.accept(block, relative, date?.getTime() ?? now.getTime())) {
          report.removedEntries++; continue;
        }
        kept.push(block.replace(/[\r\n]+$/, ''));
      }
      const output = kept.length ? kept.join('\n') + '\n' : '';
      report.bytesAfter += Buffer.byteLength(output);
      if (output === input) continue;
      report.filesChanged++;
      if (!output) report.filesDeleted++;
      if (!apply) continue;
      const latest = await fs.lstat(file);
      if (latest.isSymbolicLink() || latest.size !== stat.size || latest.mtimeMs !== stat.mtimeMs) { report.raced++; continue; }
      if (!output) { await fs.unlink(file); continue; }
      const temporary = `${file}.compact-${process.pid}`;
      try {
        await fs.writeFile(temporary, output, { flag: 'wx' });
        const beforeReplace = await fs.lstat(file);
        if (beforeReplace.size !== stat.size || beforeReplace.mtimeMs !== stat.mtimeMs || beforeReplace.isSymbolicLink()) { report.raced++; continue; }
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
    }
  }
  await visit(absolute);
  return report;
}
