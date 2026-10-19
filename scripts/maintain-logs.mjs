import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logRoot } from '../src/file-log-router.js';
import { maintainLogs } from '../src/log-maintenance.js';

const args = process.argv.slice(2);
const lockFile = fileURLToPath(new URL('../data/log-maintenance.lock', import.meta.url));
let lock;
if (args.includes('--apply')) {
  try {
    lock = await fs.open(lockFile, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number((await fs.readFile(lockFile, 'utf8')).trim());
    let alive = true;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Unrecognized log maintenance lock; left untouched');
    try { process.kill(pid, 0); } catch (probeError) { if (probeError.code === 'ESRCH') alive = false; }
    if (alive) { console.log(JSON.stringify({ skipped: 'maintenance_already_running' })); process.exit(0); }
    await fs.unlink(lockFile);
    lock = await fs.open(lockFile, 'wx');
  }
  await lock.writeFile(String(process.pid));
}
try {
  const report = await maintainLogs({ root: logRoot, apply: args.includes('--apply') });
  if (args.includes('--apply')) {
    const reportFile = fileURLToPath(new URL('../data/log-maintenance-report.json', import.meta.url));
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
} finally {
  if (lock) { await lock.close(); await fs.unlink(lockFile); }
}
