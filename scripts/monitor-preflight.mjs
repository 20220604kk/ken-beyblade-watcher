import fs from 'node:fs';
import path from 'node:path';
export function validateMonitorFiles(files) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    } catch { throw new Error(`監控資料無法讀取：${path.basename(file)}。請先復原，未清空資料。`); }
  }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'monitor-preflight.mjs') {
  try { validateMonitorFiles(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
