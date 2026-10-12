import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDestinationFor, logRoot } from '../src/file-log-router.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  path.join(projectRoot, 'monitor.out.log'),
  path.join(projectRoot, 'data', 'service-output.log'),
  ...safeList(path.join(projectRoot, 'logs'))
    .filter((name) => /^(monitor-|crash-|app\.stdout)/i.test(name) && /\.log$/i.test(name))
    .map((name) => path.join(projectRoot, 'logs', name))
];

function safeList(folder) {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
}

function dateKeyFromLine(line) {
  const match = String(line).match(/^\[(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!match) return '日期未辨識';
  return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
}

const grouped = new Map();
let sourceCount = 0;
let lineCount = 0;

for (const file of [...new Set(candidates)]) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  sourceCount += 1;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const destination = logDestinationFor(line, 'system');
    const output = path.join(logRoot, destination.section, destination.label, dateKeyFromLine(line) + '.log');
    if (!grouped.has(output)) grouped.set(output, new Set());
    grouped.get(output).add(line);
    lineCount += 1;
  }
}

for (const [file, lines] of grouped) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const merged = [...new Set([...existing, ...lines])];
  fs.writeFileSync(file, merged.join('\n') + '\n', 'utf8');
}

console.log('歷史 LOG 整理完成：來源 ' + sourceCount + ' 個，讀取 ' + lineCount + ' 行，輸出 ' + grouped.size + ' 份分類檔。');

