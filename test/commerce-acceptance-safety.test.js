import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { acceptanceGroups } from '../scripts/commerce-acceptance-manifest.mjs';
test('驗收分組不重複計數，所有測試檔確實存在', async () => {
  const files = acceptanceGroups.flatMap(g => g.files); assert.equal(new Set(files).size, files.length);
  for (const file of files) await fs.access(new URL(file, import.meta.url));
});
test('專用驗收模式阻擋官網、正式3210、讀正式state與瀏覽器啟動', async () => {
  if (!process.env.COMMERCE_ACCEPTANCE_GUARDED) {
    const child = await promisify(execFile)(process.execPath, ['--import', new URL('../scripts/commerce-acceptance-guard.mjs', import.meta.url).href,
      '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], { windowsHide: true, timeout: 10000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))) });
    assert.match(child.stdout, /fail 0/); return;
  }
  await assert.rejects(fetch('https://shop.funbox.com.tw/'), { code: 'ACCEPTANCE_IO_BLOCKED' });
  await assert.rejects(fetch('http://127.0.0.1:3210/api/status'), { code: 'ACCEPTANCE_IO_BLOCKED' });
  await assert.rejects(fs.readFile(new URL('../state.json', import.meta.url)), { code: 'ACCEPTANCE_IO_BLOCKED' });
  await assert.rejects(fs.writeFile(new URL('../config.json', import.meta.url), '{}'), { code: 'ACCEPTANCE_IO_BLOCKED' });
  assert.throws(() => spawn('chrome.exe', []), { code: 'ACCEPTANCE_IO_BLOCKED' });
});
