// Offline private migration. No secrets are written to Git, telemetry or logs.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { disableAllPurchases } from '../scripts/recover-reboot-state.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const FORMAT = 'KEN_PRIVATE_MIGRATION_V1';
const REQUIRED_FILES = ['.env', 'config.json', 'data/state.json', 'data/private-purchase/.credential-key', 'data/private-purchase/credentials.enc.json'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const host = () => sha(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`);
const ignoredDirectory = /cache|metrics|crash|shader|optimization|ttsengine|safe browsing|segmentation|^diagnostics$|^evidence$|^recovery$|^desktop-control-browser$|^service worker$/i;
const ignoredFile = /\.log$|\.tmp$|\.lock$|\.pid$|\.pma$|^LOCK$|^Singleton|^DevToolsActivePort$|^(?:History|Archived History|Favicons|Top Sites|Visited Links|DIPS)(?:$|-)|^monitor-.*\.(?:flag|stop)$|^state\.json\.last-good$/i;

export function safePrivatePath(value) {
  if (typeof value !== 'string' || value.length > 800 || value.includes('\\') || value.includes(':')
    || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')
    || !/^(?:\.env|config\.json|data\/.+|records\/.+)$/.test(value)
    || value.split('/').some(part => ['.git', 'node_modules'].includes(part))) throw fail('PRIVATE_PATH_INVALID');
  return value;
}

export function profileRoot(relative) {
  return relative.match(/^(data\/auto-purchase\/browser-profiles\/[^/]+|data\/(?:amazon-jp|biccamera|japan-auction)-browser-profile)(?:\/|$)/)?.[1] || '';
}

export async function sourceFingerprint(root) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\0').filter(value => /^(?:src|scripts|test|extensions|assets)\/|\.(?:js|mjs|cjs|ps1)$/.test(value));
  const files = [...new Set([...tracked, ...untracked])].sort();
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    if (/^(?:data|records|logs|artifacts|node_modules)\/|^\.env$|^config\.json$/.test(relative)) throw fail('PRIVATE_FILES_TRACKED');
    hash.update(relative + '\0'); hash.update(await fs.readFile(path.join(root, relative)));
  }
  return hash.digest('hex');
}

export async function makePhase1Receipt(root, checks) {
  if (checks.length !== 4 || checks.some(check => check.exitCode !== 0)
    || checks.map(check => check.name).join('|') !== 'syntax|offline|cleanroom|distribution') throw fail('PHASE1_CHECKS_INCOMPLETE');
  return { schema: 1, stage: 1, complete: true, host: host(), completedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    sourceFingerprint: await sourceFingerprint(root), checks, privateDataRead: false };
}

export async function requirePhase1(root, receiptFile) {
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  const expected = ['syntax', 'offline', 'cleanroom', 'distribution'];
  if (receipt.schema !== 1 || receipt.stage !== 1 || receipt.complete !== true || receipt.host !== host()
    || !Array.isArray(receipt.checks) || receipt.checks.length !== expected.length
    || receipt.checks.some((check, index) => check.name !== expected[index] || check.exitCode !== 0)
    || receipt.privateDataRead !== false || receipt.sourceFingerprint !== await sourceFingerprint(root)
    || !Number.isFinite(Date.parse(receipt.completedAt)) || Date.now() - Date.parse(receipt.completedAt) > 7 * 86400_000
    || Date.parse(receipt.completedAt) > Date.now() + 60_000) throw fail('PHASE1_REQUIRED_OR_STALE');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  if (receipt.commit !== commit) throw fail('PHASE1_COMMIT_CHANGED');
  return receipt;
}

export function sealPrivatePayload(payload, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('PRIVATE_KEY_INVALID');
  const header = Buffer.from(JSON.stringify({ format: FORMAT, cipher: 'aes-256-gcm', keyId: sha(key).slice(0, 16) }));
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 1 });
  if (compressed.length > MAX_BYTES) throw fail('PRIVATE_PACKAGE_TOO_LARGE');
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, iv, cipher.getAuthTag(), encrypted]);
}

export function openPrivatePayload(buffer, key) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32 || buffer.length < 36 || buffer.length > MAX_BYTES + 4096) throw fail('invalid');
    const size = buffer.readUInt32BE();
    if (size < 20 || size > 2048 || size + 32 >= buffer.length) throw fail('invalid');
    const header = buffer.subarray(4, 4 + size), data = JSON.parse(header.toString('utf8'));
    if (data.format !== FORMAT || data.cipher !== 'aes-256-gcm' || data.keyId !== sha(key).slice(0, 16)) throw fail('invalid');
    const offset = 4 + size, decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(offset, offset + 12));
    decipher.setAAD(header); decipher.setAuthTag(buffer.subarray(offset + 12, offset + 28));
    const compressed = Buffer.concat([decipher.update(buffer.subarray(offset + 28)), decipher.final()]);
    const payload = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_BYTES * 2 }).toString('utf8'));
    if (payload.schema !== 1 || !Array.isArray(payload.files) || !Array.isArray(payload.portableProfiles)) throw fail('invalid');
    const seen = new Set(); let bytes = 0;
    for (const file of payload.files) {
      safePrivatePath(file.path);
      if (seen.has(file.path.toLowerCase()) || typeof file.data !== 'string' || file.data.length > MAX_BYTES * 2) throw fail('invalid');
      seen.add(file.path.toLowerCase());
      const content = Buffer.from(file.data, 'base64'); bytes += content.length;
      if (bytes > MAX_BYTES || content.length !== file.bytes || sha(content) !== file.sha256) throw fail('invalid');
    }
    validatePrivateFiles(payload.files);
    const profiles = new Set();
    for (const profile of payload.portableProfiles) {
      safePrivatePath(profile.path);
      if (profiles.has(profile.path.toLowerCase()) || profileRoot(profile.path) !== profile.path || !Array.isArray(profile.state?.cookies) || !Array.isArray(profile.state?.origins)) throw fail('invalid');
      profiles.add(profile.path.toLowerCase());
    }
    return payload;
  } catch { throw fail('PRIVATE_PACKAGE_AUTHENTICATION_FAILED'); }
}

function validatePrivateFiles(files) {
  const content = name => {
    const item = files.find(file => file.path === name);
    if (!item) throw fail('REQUIRED_PRIVATE_FILE_MISSING');
    return Buffer.from(item.data, 'base64');
  };
  for (const required of REQUIRED_FILES) content(required);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  for (const name of ['config.json', 'data/state.json']) if (!object(JSON.parse(content(name)))) throw fail('PRIVATE_JSON_INVALID');
  const key = content('data/private-purchase/.credential-key');
  if (key.length !== 32) throw fail('PRIVATE_CREDENTIAL_PAIR_INVALID');
  const envelope = JSON.parse(content('data/private-purchase/credentials.enc.json'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  if (!object(JSON.parse(plaintext))) throw fail('PRIVATE_CREDENTIAL_PAIR_INVALID');
}

export async function preparePrivateExportDirectories({ source, toolingRoot, output, keyFile }) {
  const parents = [path.dirname(output), path.dirname(keyFile)];
  if (parents[0].toLowerCase() === parents[1].toLowerCase()
    || parents.some(directory => !/^ken-private-[a-z0-9-]+$/i.test(path.basename(directory)))) throw fail('DEDICATED_SEPARATE_PRIVATE_DIRECTORIES_REQUIRED');
  // Only brand-new dedicated directories receive restrictive ACLs, never Downloads
  // itself, a workspace, or an arbitrary existing user directory.
  for (const directory of parents) {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory, { mode: 0o700 });
  }
  const protectedRoots = await Promise.all([source, toolingRoot].map(directory => fs.realpath(directory)));
  const canonical = await Promise.all(parents.map(directory => fs.realpath(directory)));
  const contained = (value, directory) => {
    const relative = path.relative(directory, value);
    return !relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
  };
  if (canonical[0].toLowerCase() === canonical[1].toLowerCase()
    || canonical.some(directory => protectedRoots.some(root => contained(directory, root)))) throw fail('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_GIT');
  for (const directory of canonical) {
    let insideGit = false;
    try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: directory, windowsHide: true, stdio: 'ignore' }); insideGit = true; } catch (error) {
      if (error.status !== 128) throw fail('PRIVATE_DIRECTORY_GIT_CHECK_FAILED');
    }
    if (insideGit) throw fail('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_GIT');
  }
  return canonical;
}

export function disabledImportConfig(config) {
  const result = disableAllPurchases(config);
  result.monitoringEnabled = false;
  for (const key of ['funbox', 'funboxSandbox', 'shoppingSites', 'japanAuctions', 'amazonJp', 'hotspot']) {
    if (result[key]) result[key].enabled = false;
  }
  // Official pause gate also suppresses Discord schedules on manual startup.
  result.systemPause = { active: true, pausedAt: new Date().toISOString(), resumeState: null };
  if (result.discordAutomation) result.discordAutomation.enabled = false;
  return result;
}

export async function assertNoService(root) {
  let port = 3210;
  try { port = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).dashboardPort || port; } catch {}
  const listening = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000); socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
  if (listening) throw fail('TARGET_SERVICE_MUST_BE_STOPPED');
}

export async function collectPrivateSnapshot(root, { portableProfiles = [] } = {}) {
  const candidates = ['.env', 'config.json'];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw fail('SOURCE_SYMLINK_NOT_ALLOWED');
      const next = relative + '/' + entry.name;
      if (entry.isDirectory()) { if (!ignoredDirectory.test(entry.name)) await walk(next); }
      else if (!ignoredFile.test(entry.name) || profileRoot(next) && /^\d+\.log$/.test(entry.name)) candidates.push(next);
    }
  }
  await walk('data');
  try { await walk('records'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = []; let totalBytes = 0;
  for (const relative of candidates.sort()) {
    safePrivatePath(relative);
    const absolute = path.join(root, relative), before = await fs.stat(absolute), content = await fs.readFile(absolute), after = await fs.stat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('SOURCE_CHANGED_DURING_EXPORT');
    totalBytes += content.length;
    if (totalBytes > MAX_BYTES) throw fail('PRIVATE_SNAPSHOT_TOO_LARGE');
    files.push({ path: relative, bytes: content.length, sha256: sha(content), data: content.toString('base64') });
  }
  try { validatePrivateFiles(files); } catch { throw fail('PRIVATE_SOURCE_FILES_OR_CREDENTIAL_PAIR_INVALID'); }
  return { schema: 1, createdAt: new Date().toISOString(), files, portableProfiles, totalBytes,
    limitations: ['raw Chrome profiles are OS-bound backups', 'cookie expiry and official verification still apply', 'not a cross-machine trading lease'] };
}

export async function restorePortableProfiles(root, profiles, launch) {
  let cookieCount = 0;
  for (const profile of profiles) {
    safePrivatePath(profile.path);
    if (profileRoot(profile.path) !== profile.path) throw fail('PROFILE_PATH_INVALID');
    const context = await launch(path.join(root, profile.path), { channel: 'chrome', headless: true,
      serviceWorkers: 'block', args: ['--disable-background-networking', '--no-first-run'] });
    try {
      // No navigation to the storefront. New OS encrypts the restored cookie DB.
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Offline restore</title>' }));
      await context.addCookies(profile.state.cookies); cookieCount += profile.state.cookies.length;
      for (const origin of profile.state.origins) {
        const url = new URL(origin.origin);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('STORAGE_ORIGIN_INVALID');
        const page = await context.newPage();
        await page.goto(url.origin, { waitUntil: 'domcontentloaded' });
        await page.evaluate(values => { for (const item of values) localStorage.setItem(item.name, item.value); }, origin.localStorage || []);
        await page.close();
      }
    } finally { await context.close(); }
  }
  return { profiles: profiles.length, cookies: cookieCount, officialLoginVerified: false };
}

export async function importPrivateBundle({ root, packageFile, keyFile, receiptFile, launch, assertStopped = assertNoService }) {
  // Deliberately BEFORE opening the package or key. Receipt is local-machine and
  // current-code bound; it is an operational gate, not DRM against a key holder.
  await requirePhase1(root, receiptFile);
  await assertStopped(root);
  const payload = openPrivatePayload(await fs.readFile(packageFile), await fs.readFile(keyFile));
  const conflicts = [];
  for (const file of payload.files) {
    if (profileRoot(file.path)) continue;
    try { await fs.access(path.join(root, file.path)); conflicts.push(file.path); } catch {}
  }
  if (conflicts.length) throw fail('TARGET_PRIVATE_FILES_EXIST_USE_FRESH_CLONE');
  try { await fs.access(path.join(root, 'data')); throw fail('TARGET_DATA_DIRECTORY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await fs.mkdtemp(path.join(root, '.private-import-'));
  try {
    for (const file of payload.files) {
      const profile = profileRoot(file.path);
      const destination = profile ? `data/private-import/raw-profiles/${sha(profile).slice(0, 16)}/${file.path.slice(profile.length + 1)}` : file.path;
      const target = path.join(stage, destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    const original = JSON.parse(await fs.readFile(path.join(stage, 'config.json'), 'utf8'));
    await fs.mkdir(path.join(stage, 'data', 'private-import'), { recursive: true });
    await fs.writeFile(path.join(stage, 'data', 'private-import', 'original-config.json'), JSON.stringify(original), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(stage, 'config.json'), JSON.stringify(disabledImportConfig(original), null, 2), { mode: 0o600 });
    const restored = await restorePortableProfiles(stage, payload.portableProfiles, launch);
    await fs.writeFile(path.join(stage, 'data', 'monitor-disabled.flag'), 'private-import-not-activated');
    await fs.writeFile(path.join(stage, 'data', 'monitor-autostart-disabled.flag'), 'private-import-not-activated');
    await fs.writeFile(path.join(stage, 'data', 'private-import', 'report.json'), JSON.stringify({ importedAt: new Date().toISOString(),
      snapshotAt: payload.createdAt, files: payload.files.length, ...restored, purchasesEnabled: false,
      rawProfilesActivated: false, indexedDbPortableRestore: false, sourceMayHaveNewerOrders: true }, null, 2));
    // Recheck the complete destination before committing any private file.
    await assertStopped(root);
    for (const entry of await fs.readdir(stage)) {
      try { await fs.access(path.join(root, entry)); throw fail('TARGET_CHANGED_DURING_IMPORT'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const moved = [];
    try {
      for (const entry of await fs.readdir(stage)) { await fs.rename(path.join(stage, entry), path.join(root, entry)); moved.push(entry); }
    } catch (error) {
      for (const entry of moved.reverse()) await fs.rename(path.join(root, entry), path.join(stage, entry));
      throw error;
    }
    return { files: payload.files.length, ...restored, purchasesEnabled: false, serviceStarted: false };
  } finally {
    const resolved = path.resolve(stage);
    if (path.dirname(resolved) !== path.resolve(root) || !path.basename(resolved).startsWith('.private-import-')) throw fail('CLEANUP_TARGET_INVALID');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
