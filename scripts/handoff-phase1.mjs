// Phase 1 touches code/tests only; it does not open a private migration package.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makePhase1Receipt, sourceFingerprint } from '../src/private-migration.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptFile = path.join(root, 'artifacts', 'handoff', 'phase1.json');
await fs.mkdir(path.dirname(receiptFile), { recursive: true });
// A failed re-run must not leave yesterday's success receipt usable.
await fs.rm(receiptFile, { force: true });
const before = await sourceFingerprint(root);
const checks = [];
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(?:DISCORD_|LINE_|FUNBOX_BUY_|ESLITE_BUY_|MOMO_BUY_|KINGSTONE_BUY_|X_API_|PRODUCT_CATALOG_)/.test(key)) delete env[key];
for (const [name, args] of [
  ['syntax', ['scripts/check.mjs']],
  ['offline', ['--test', '--test-concurrency=1']],
  ['cleanroom', ['scripts/verify-handoff.mjs']],
  ['distribution', ['scripts/audit-distribution.mjs']]
]) {
  console.log(`PHASE1｜${name}｜開始`);
  const result = spawnSync(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 600_000 });
  if (result.status !== 0) throw new Error(`PHASE1_FAILED_${name}`);
  checks.push({ name, exitCode: 0 });
}
if (before !== await sourceFingerprint(root)) throw new Error('PHASE1_SOURCE_CHANGED');
await fs.writeFile(receiptFile, JSON.stringify(await makePhase1Receipt(root, checks), null, 2), { mode: 0o600 });
console.log('PHASE1｜完成｜artifacts/handoff/phase1.json｜尚未讀取私人包');
