// Isolated clean-room startup, no production directory/port/profile is opened.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-handoff-check-'));
let child, browser;
try {
  for (const directory of ['src', 'extensions', 'assets']) await fs.cp(path.join(root, directory), path.join(temporary, directory), { recursive: true });
  for (const file of ['package.json', '.env.example']) await fs.copyFile(path.join(root, file), path.join(temporary, file));
  await fs.symlink(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.example.json'), 'utf8'));
  assert.equal(config.autoPurchase.enabled, false);
  assert.equal(config.funbox.enabled, false);
  assert.equal(config.shoppingSites.enabled, false);
  assert.equal(config.japanAuctions.enabled, false);
  assert.equal(config.amazonJp.enabled, false);
  config.dashboardPort = port;
  await fs.writeFile(path.join(temporary, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(temporary, '.env'), '');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:DISCORD_|LINE_|FUNBOX_BUY_|ESLITE_BUY_|MOMO_BUY_|KINGSTONE_BUY_|X_API_|PRODUCT_CATALOG_)/.test(key)) delete env[key];
  child = spawn(process.execPath, ['src/index.js'], { cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutBytes = 0, stderrBytes = 0;
  child.stdout.on('data', data => { stdoutBytes += data.length; });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  const base = `http://127.0.0.1:${port}`;
  let state;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Clean-room service exited: ${child.exitCode}; stderrBytes=${stderrBytes}`);
    try { const response = await fetch(base + '/api/status', { signal: AbortSignal.timeout(1000) }); if (response.ok) { state = await response.json(); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(state, 'Clean-room status unavailable');
  assert.equal(state.funbox.enabled, false);
  assert.equal(state.shoppingSites.enabled, false);
  assert.equal(state.autoPurchase.enabled, false);
  assert.equal(state.autoPurchase.queued, 0);
  for (const task of state.japanAuctions.amazonJpProductOrders) assert.equal(task.enabled, false);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext(), page = await context.newPage();
  const pageErrors = [], writes = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', route => {
    const req = route.request();
    if (new URL(req.url()).origin !== base) return route.abort();
    if (req.method() !== 'GET') { writes.push(req.method()); return route.abort(); }
    return route.continue();
  });
  const response = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  assert.equal(response.status(), 200);
  await page.waitForSelector('#tab-button-japan', { timeout: 5000 });
  await page.waitForFunction(() => typeof currentStatus === 'object' && currentStatus !== null, null, { timeout: 5000 });
  const sheetResponse = await fetch(base + '/api/product-catalog');
  const sheet = await sheetResponse.json();
  assert.equal(sheet.configured, false);
  assert.deepEqual(sheet.items, []);
  assert.deepEqual(pageErrors, []); assert.deepEqual(writes, []);
  console.log(JSON.stringify({ cleanRoom: true, statusHttp: 200, dashboardHttp: 200, browserErrors: pageErrors.length,
    browserMutations: writes.length, purchasesEnabled: false, queue: 0, personalSheetConfigured: false, stdoutBytes, stderrBytes }));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await ended;
  }
  // Delete only this run's owned temporary tree, never the source workspace.
  const resolved = path.resolve(temporary), prefix = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(prefix) || !path.basename(resolved).startsWith('ken-handoff-check-')) throw new Error('Temporary cleanup target invalid');
  await fs.rm(resolved, { recursive: true, force: true });
}
