import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
}
for (const directory of ['src', 'scripts', 'extensions']) await collect(path.join(root, directory));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path.relative(root, file)}: ${result.stderr || result.error}`);
  const text = await fs.readFile(file, 'utf8');
  for (const match of text.matchAll(/(?:from\s+|import\s*\()['"](\.\.?\/[^'"]+\.m?js)['"]/g)) {
    await fs.access(path.resolve(path.dirname(file), match[1]));
  }
}
const { validateDashboardClientScript } = await import('../src/dashboard.js');
validateDashboardClientScript();
console.log(`語法及相對模組檢查通過：${files.length} 個程式檔；控制台內嵌腳本通過。未登入、通知或送單。`);
