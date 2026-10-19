import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { LocalCredentialStore } from '../src/credential-store.js';
import { safePrivatePath, sealPrivatePayload, openPrivatePayload, disabledImportConfig, makePhase1Receipt,
  requirePhase1, sourceFingerprint, collectPrivateSnapshot, importPrivateBundle, restorePortableProfiles, preparePrivateExportDirectories } from '../src/private-migration.js';

const checks = ['syntax', 'offline', 'cleanroom', 'distribution'].map(name => ({ name, exitCode: 0 }));
const file = (name, value) => { const content = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { path: name, data: content.toString('base64'), bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }; };
const payload = () => {
  const key = Buffer.alloc(32, 1), iv = Buffer.alloc(12, 2), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encoded = Buffer.concat([cipher.update(JSON.stringify({ funbox: { account: 'fixture@example.invalid', password: 'fixture-only-password' } })), cipher.final()]);
  return { schema: 1, createdAt: new Date().toISOString(), portableProfiles: [], files: [
  file('.env', 'DISCORD_PRIVATE_WEBHOOK_URL=synthetic-secret-value'),
  file('config.json', { autoPurchase: { enabled: true, funbox: { enabled: true }, eslite: { enabled: true } },
    funbox: { enabled: true }, shoppingSites: { enabled: true }, japanAuctions: { enabled: true }, amazonJp: { enabled: true },
    amazonJpProductOrders: { A: { enabled: true } }, systemPause: { active: true, resumeState: { autoPurchaseEnabled: true } } }),
  file('data/state.json', { commerce: { ledger: { purchases: 7 }, amazonJpProductOrder: { apiTransaction: { phase: 'submitted', asin: 'B0TEST0001' } } } }),
  file('data/private-purchase/.credential-key', key),
  file('data/private-purchase/credentials.enc.json', { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encoded.toString('base64') })
] }; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-private-test-'));
  t.after(async () => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('ken-private-test-')) throw Error('bad cleanup'); await fs.rm(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  await fs.writeFile(path.join(root, 'code.js'), 'export const version = 1;\n');
  execFileSync('git', ['add', 'code.js'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic fixture'], { cwd: root, windowsHide: true });
  const receiptFile = path.join(root, 'receipt.json');
  await fs.writeFile(receiptFile, JSON.stringify(await makePhase1Receipt(root, checks)));
  return { root, receiptFile, assertStopped: async () => {} };
}

test('private paths reject traversal, Windows absolute paths, duplicates of directory syntax and Git injection', () => {
  for (const name of ['../.env', '/data/a', 'data/../code.js', 'data\\x', 'C:/data/a', 'data//a', 'data/.git/config', 'code.js', 'data/\0x']) assert.throws(() => safePrivatePath(name));
  for (const name of ['.env', 'config.json', 'data/private-purchase/.credential-key', 'records/order.json']) assert.equal(safePrivatePath(name), name);
});

test('AES-GCM archive hides synthetic secrets, round-trips all bytes and authenticates key/header/ciphertext', () => {
  const key = crypto.randomBytes(32), input = payload(), sealed = sealPrivatePayload(input, key);
  assert.equal(sealed.includes(Buffer.from('synthetic-secret-value')), false);
  assert.deepEqual(openPrivatePayload(sealed, key), input);
  assert.throws(() => openPrivatePayload(sealed, crypto.randomBytes(32)), /AUTHENTICATION_FAILED/);
  for (const offset of [8, sealed.length - 1, sealed.readUInt32BE() + 20]) {
    const corrupt = Buffer.from(sealed); corrupt[offset] ^= 1;
    assert.throws(() => openPrivatePayload(corrupt, key), /AUTHENTICATION_FAILED/);
  }
});

test('authenticated package still refuses unsafe payload paths, duplicate entries, bad hash and unsafe portable profiles', () => {
  const key = crypto.randomBytes(32);
  for (const change of [p => { p.files.push(file('data/../code.js', 'bad')); }, p => { p.files.push(p.files[0]); },
    p => { p.files[0].sha256 = 'bad'; }, p => { p.portableProfiles.push({ path: 'data/auto-purchase/browser-profiles/..', state: { cookies: [], origins: [] } }); }]) {
    const p = payload(); change(p); assert.throws(() => openPrivatePayload(sealPrivatePayload(p, key), key), /AUTHENTICATION_FAILED/);
  }
});

test('phase 1 gate binds this machine, exact code fingerprint, commit and four successful checks', async t => {
  const f = await fixture(t);
  assert.equal((await requirePhase1(f.root, f.receiptFile)).complete, true);
  await fs.writeFile(path.join(f.root, 'code.js'), 'changed');
  await assert.rejects(requirePhase1(f.root, f.receiptFile), /PHASE1/);
  await assert.rejects(makePhase1Receipt(f.root, checks.slice(1)), /INCOMPLETE/);
});

test('phase 1 rejects a foreign-machine receipt or stale date, without opening package or key', async t => {
  const f = await fixture(t);
  const original = JSON.parse(await fs.readFile(f.receiptFile, 'utf8'));
  for (const patch of [{ host: 'other-computer' }, { completedAt: '2000-01-01T00:00:00Z' }, { checks: [] }, { complete: false }]) {
    await fs.writeFile(f.receiptFile, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(importPrivateBundle({ ...f, packageFile: path.join(f.root, 'must-not-read.kenvault'), keyFile: 'missing.key' }), /PHASE1/);
  }
});

test('import disables purchases, monitoring and resume flags while retaining original settings and unresolved order history', async t => {
  const f = await fixture(t), key = crypto.randomBytes(32);
  const packageFile = path.join(f.root, 'bundle.kenvault'), keyFile = path.join(f.root, 'bundle.key');
  await fs.writeFile(packageFile, sealPrivatePayload(payload(), key)); await fs.writeFile(keyFile, key);
  const result = await importPrivateBundle({ ...f, packageFile, keyFile, launch: () => assert.fail('no profiles') });
  assert.equal(result.purchasesEnabled, false); assert.equal(result.serviceStarted, false);
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'config.json')));
  assert.equal(config.autoPurchase.enabled, false); assert.equal(config.amazonJpProductOrders.A.enabled, false);
  assert.equal(config.funbox.enabled, false); assert.equal(config.systemPause.resumeState, null);
  assert.equal(config.systemPause.active, true);
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'data/state.json')));
  assert.equal(state.commerce.ledger.purchases, 7); assert.equal(state.commerce.amazonJpProductOrder.apiTransaction.phase, 'submitted');
  const credentials = await new LocalCredentialStore(path.join(f.root, 'data')).load();
  assert.equal(credentials.get('funbox').account, 'fixture@example.invalid');
  assert.equal(credentials.get('funbox').password, 'fixture-only-password');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'data/private-import/original-config.json'))).autoPurchase.enabled, true);
  await assert.rejects(importPrivateBundle({ ...f, packageFile, keyFile, launch: () => {} }), /TARGET_PRIVATE_FILES_EXIST/);
});

test('embedded credential pair and JSON configuration must be usable before importing', () => {
  const key = crypto.randomBytes(32);
  for (const change of [p => { p.files = p.files.filter(item => !item.path.endsWith('.credential-key')); },
    p => { p.files[p.files.findIndex(item => item.path.endsWith('.credential-key'))] = file('data/private-purchase/.credential-key', crypto.randomBytes(32)); },
    p => { p.files[p.files.findIndex(item => item.path === 'config.json')] = file('config.json', []); }]) {
    const p = payload(); change(p);
    assert.throws(() => openPrivatePayload(sealPrivatePayload(p, key), key), /AUTHENTICATION_FAILED/);
  }
});

test('export directories must be new, dedicated, separate and outside any Git repository', async t => {
  const f = await fixture(t), base = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-private-test-'));
  t.after(async () => { if (path.dirname(base) !== os.tmpdir() || !path.basename(base).startsWith('ken-private-test-')) throw Error('bad cleanup'); await fs.rm(base, { recursive: true, force: true }); });
  const options = (a, b) => ({ source: f.root, toolingRoot: f.root, output: path.join(a, 'snapshot.kenvault'), keyFile: path.join(b, 'snapshot.key') });
  await assert.rejects(preparePrivateExportDirectories(options(base, base)), /DIRECTORIES_REQUIRED/);
  const pair = options(path.join(base, 'ken-private-bundle'), path.join(base, 'ken-private-key'));
  assert.equal((await preparePrivateExportDirectories(pair)).length, 2);
  await assert.rejects(preparePrivateExportDirectories(pair), /EEXIST/);
  await assert.rejects(preparePrivateExportDirectories(options(path.join(f.root, 'ken-private-repo'), path.join(base, 'ken-private-rejected'))), /OUTSIDE_GIT/);
});

test('new untracked executable code invalidates phase 1; corrupted archive never installs secrets', async t => {
  const f = await fixture(t);
  const original = await sourceFingerprint(f.root);
  await fs.writeFile(path.join(f.root, 'unreviewed.mjs'), 'export const injected = true;');
  assert.notEqual(await sourceFingerprint(f.root), original);
  await assert.rejects(requirePhase1(f.root, f.receiptFile), /PHASE1/);
  await fs.unlink(path.join(f.root, 'unreviewed.mjs'));
  const key = crypto.randomBytes(32), bytes = sealPrivatePayload(payload(), key); bytes[bytes.length - 1] ^= 1;
  const packageFile = path.join(f.root, 'corrupt.kenvault'), keyFile = path.join(f.root, 'key.key');
  await fs.writeFile(packageFile, bytes); await fs.writeFile(keyFile, key);
  await assert.rejects(importPrivateBundle({ ...f, packageFile, keyFile }), /AUTHENTICATION_FAILED/);
  await assert.rejects(fs.access(path.join(f.root, '.env')));
});

test('OS-bound raw browser profiles are quarantined, never copied into the active profile directory', async t => {
  const f = await fixture(t), key = crypto.randomBytes(32), p = payload();
  const relative = 'data/auto-purchase/browser-profiles/amazon-jp-product-order';
  p.files.push(file(relative + '/Default/Network/Cookies', 'synthetic-old-OS-encrypted-db'));
  const packageFile = path.join(f.root, 'bundle.kenvault'), keyFile = path.join(f.root, 'key.key');
  await fs.writeFile(packageFile, sealPrivatePayload(p, key)); await fs.writeFile(keyFile, key);
  await importPrivateBundle({ ...f, packageFile, keyFile });
  await assert.rejects(fs.access(path.join(f.root, relative)));
  const directory = path.join(f.root, 'data/private-import/raw-profiles');
  const [name] = await fs.readdir(directory);
  assert.equal(await fs.readFile(path.join(directory, name, 'Default/Network/Cookies'), 'utf8'), 'synthetic-old-OS-encrypted-db');
});

test('portable-cookie failure rolls back staged secrets; existing private files are never overwritten', async t => {
  const f = await fixture(t), key = crypto.randomBytes(32), p = payload();
  p.portableProfiles.push({ path: 'data/auto-purchase/browser-profiles/amazon-jp-product-order', state: { cookies: [], origins: [] } });
  const packageFile = path.join(f.root, 'bundle.kenvault'), keyFile = path.join(f.root, 'bundle.key');
  await fs.writeFile(packageFile, sealPrivatePayload(p, key)); await fs.writeFile(keyFile, key);
  await assert.rejects(importPrivateBundle({ ...f, packageFile, keyFile, launch: async () => { throw Error('fixture browser failure'); } }));
  await assert.rejects(fs.access(path.join(f.root, '.env')));
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.private-import-')), false);
  await fs.writeFile(path.join(f.root, '.env'), 'existing-private-fixture');
  await assert.rejects(importPrivateBundle({ ...f, packageFile, keyFile }), /TARGET_PRIVATE_FILES_EXIST/);
  assert.equal(await fs.readFile(path.join(f.root, '.env'), 'utf8'), 'existing-private-fixture');
});

test('snapshot includes account key/session/state files but excludes operational flags, cache, screenshots and browsing history', async t => {
  const f = await fixture(t);
  for (const item of payload().files) { const destination = path.join(f.root, item.path); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, Buffer.from(item.data, 'base64')); }
  for (const name of ['data/monitor-service.pid', 'data/diagnostics/test.json', 'data/auto-purchase/browser-profiles/amazon-jp-product-order/Default/History',
    'data/auto-purchase/browser-profiles/amazon-jp-product-order/Default/Cache/cache', 'data/records/evidence/image.png']) {
    await fs.mkdir(path.dirname(path.join(f.root, name)), { recursive: true }); await fs.writeFile(path.join(f.root, name), 'synthetic');
  }
  const p = await collectPrivateSnapshot(f.root);
  assert.equal(p.files.length, 5);
  assert.equal(p.files.some(item => /\.credential-key$/.test(item.path)), true);
});

test('restored cookie and localStorage survive a fresh dedicated Chrome profile; every origin is served offline', async t => {
  const f = await fixture(t); let requests = 0;
  const launch = async (directory, options) => {
    const context = await chromium.launchPersistentContext(directory, options);
    context.on('request', () => { requests++; }); return context;
  };
  const profile = { path: 'data/auto-purchase/browser-profiles/amazon-jp-product-order', state: {
    cookies: [{ name: 'synthetic-login', value: 'fixture-only', domain: 'example.invalid', path: '/', expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [{ origin: 'https://example.invalid', localStorage: [{ name: 'synthetic-token', value: 'fixture-only' }] }] } };
  const restored = await restorePortableProfiles(f.root, [profile], launch);
  assert.equal(restored.cookies, 1); assert.equal(restored.officialLoginVerified, false);
  const context = await chromium.launchPersistentContext(path.join(f.root, profile.path), { channel: 'chrome', headless: true });
  try {
    assert.equal((await context.cookies()).find(cookie => cookie.name === 'synthetic-login').value, 'fixture-only');
    await context.route('**/*', route => route.fulfill({ body: '<!doctype html><title>Offline</title>' }));
    const page = await context.newPage(); await page.goto('https://example.invalid');
    assert.equal(await page.evaluate(() => localStorage.getItem('synthetic-token')), 'fixture-only');
  } finally { await context.close(); }
  assert.equal(requests, 1);
});
