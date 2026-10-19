import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { collectPrivateSnapshot, sealPrivatePayload, openPrivatePayload, importPrivateBundle, profileRoot, preparePrivateExportDirectories } from '../src/private-migration.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
function option(name) { const at = args.indexOf(name); if (at < 0 || !args[at + 1] || args[at + 1].startsWith('--')) throw new Error('MISSING_OPTION_' + name); return path.resolve(args[at + 1]); }
const launch = (directory, options) => chromium.launchPersistentContext(directory, options);
try {
  if (command === 'import') {
    if (!args.includes('--acknowledge-private-import')) throw new Error('PRIVATE_IMPORT_ACK_REQUIRED');
    const result = await importPrivateBundle({ root, packageFile: option('--package'), keyFile: option('--key'),
      receiptFile: path.join(root, 'artifacts', 'handoff', 'phase1.json'), launch });
    console.log(JSON.stringify({ result: 'PRIVATE_IMPORT_COMPLETE_NOT_ACTIVATED', ...result }));
  } else if (command === 'export') {
    const source = option('--source'), output = option('--output'), keyFile = option('--key');
    const contained = (file, directory) => file === directory || file.startsWith(directory + path.sep);
    if (contained(output, source) || contained(output, root) || contained(keyFile, source) || contained(keyFile, root)
      || path.dirname(output) === path.dirname(keyFile)) throw new Error('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_GIT_AND_KEY_SEPARATE');
    const statusUrl = 'http://127.0.0.1:3210/api/status';
    const live = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
    if (live.systemPause?.active !== true || live.autoPurchase?.processing || live.autoPurchase?.queued
      || ['funbox', 'eslite'].some(platform => live.autoPurchase?.runtime?.[platform]?.accounts?.some(account => account.busy || account.accountBrowserOpen || account.interactiveLoginOpen))
      || live.japanAuctions?.amazonJpProductOrders?.some(task => task.running || task.interactive || task.phase === 'ordering' || task.race?.busy)) throw new Error('SOURCE_MUST_BE_SAFELY_PAUSED');
    const privateDirectories = await preparePrivateExportDirectories({ source, toolingRoot: root, output, keyFile });
    if (process.platform === 'win32') {
      const identity = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
      for (const directory of privateDirectories) {
        execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
      }
    }
    const portableProfiles = [];
    const profiles = [];
    const profileBase = path.join(source, 'data', 'auto-purchase', 'browser-profiles');
    for (const entry of await fs.readdir(profileBase, { withFileTypes: true })) if (entry.isDirectory()) profiles.push('data/auto-purchase/browser-profiles/' + entry.name);
    for (const name of ['amazon-jp-browser-profile', 'biccamera-browser-profile', 'japan-auction-browser-profile']) {
      if (await fs.access(path.join(source, 'data', name)).then(() => true).catch(() => false)) profiles.push('data/' + name);
    }
    for (const relative of profiles) {
      if (profileRoot(relative) !== relative) throw new Error('PROFILE_PATH_INVALID');
      let context;
      try {
        context = await launch(path.join(source, relative), { channel: 'chrome', headless: true, serviceWorkers: 'block',
          args: ['--disable-background-networking', '--no-first-run'] });
        await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline migration snapshot</title>' }));
        const origin = /amazon/.test(relative) ? 'https://www.amazon.co.jp' : /eslite/.test(relative)
          ? 'https://www.eslite.com' : /funbox/.test(relative) ? 'https://shop.funbox.com.tw' : '';
        if (origin) { const page = await context.newPage(); await page.goto(origin, { waitUntil: 'domcontentloaded' }); }
        const state = await context.storageState({ indexedDB: true });
        portableProfiles.push({ path: relative, state });
        console.log(JSON.stringify({ profile: relative.split('/').at(-1), cookies: state.cookies.length, origins: state.origins.length }));
      } catch { throw new Error('PORTABLE_COOKIE_EXPORT_FAILED_' + relative.split('/').at(-1)); }
      finally { await context?.close(); }
    }
    const payload = await collectPrivateSnapshot(source, { portableProfiles });
    const after = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
    if (after.systemPause?.active !== true || after.autoPurchase?.processing || after.autoPurchase?.queued) throw new Error('SOURCE_RESUMED_DURING_EXPORT');
    for (const name of ['.env', 'config.json', 'data/state.json']) {
      const entry = payload.files.find(file => file.path === name);
      const actual = crypto.createHash('sha256').update(await fs.readFile(path.join(source, name))).digest('hex');
      if (actual !== entry.sha256) throw new Error('SOURCE_CHANGED_DURING_EXPORT');
    }
    const key = crypto.randomBytes(32), encrypted = sealPrivatePayload(payload, key);
    // Verify encrypted bytes before committing the package/key pair to disk.
    const verified = openPrivatePayload(encrypted, key);
    if (verified.files.length !== payload.files.length) throw new Error('PRIVATE_EXPORT_VERIFICATION_FAILED');
    await fs.writeFile(keyFile, key, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(output, encrypted, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ result: 'ENCRYPTED_PRIVATE_SNAPSHOT_COMPLETE', fileCount: payload.files.length,
      sourceBytes: payload.totalBytes, encryptedBytes: encrypted.length, portableProfiles: portableProfiles.length,
      cookies: portableProfiles.reduce((sum, item) => sum + item.state.cookies.length, 0), snapshotAt: payload.createdAt,
      sha256: crypto.createHash('sha256').update(encrypted).digest('hex'), output, keyFile,
      rawBrowserProfilesPortable: false, officialLoginsVerified: false }));
  } else throw new Error('USE_export_OR_import');
} catch (error) {
  console.error(JSON.stringify({ result: 'PRIVATE_MIGRATION_FAILED', code: /^[A-Z0-9_-]+$/.test(error.code || '') ? error.code
    : /^[A-Z0-9_/-]+$/.test(error.message || '') ? error.message : 'PRIVATE_OPERATION_FAILED_NO_SECRET_DETAILS' }));
  process.exitCode = 1;
}
