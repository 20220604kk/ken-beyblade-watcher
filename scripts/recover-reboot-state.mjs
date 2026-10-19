// Explicit recovery only; never silently replace corrupt purchase history.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export function disableAllPurchases(config) {
  const result = structuredClone(config);
  result.autoPurchase ||= {};
  result.autoPurchase.enabled = false;
  for (const platform of ['funbox', 'eslite']) {
    result.autoPurchase[platform] ||= {};
    result.autoPurchase[platform].enabled = false;
  }
  result.amazonJpProductOrders ||= {};
  for (const slot of ['A', 'B', 'C']) {
    result.amazonJpProductOrders[slot] ||= {};
    result.amazonJpProductOrders[slot].enabled = false;
  }
  for (const key of ['amazonJpProductOrder', 'amazonJpSingleOrder']) if (result[key]) result[key].enabled = false;
  if (result.systemPause?.resumeState) {
    result.systemPause.resumeState.autoPurchaseEnabled = false;
    result.systemPause.resumeState.amazonProductOrders = { A: false, B: false, C: false };
  }
  return result;
}

async function durableWrite(target, value) {
  const temporary = target + '.recovery.tmp';
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, target);
}

export async function recover(root) {
  await fs.access(path.join(root, 'data', 'monitor-disabled.flag'));
  const listening = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 3210 });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(true); });
  });
  if (listening) throw new Error('服務可能仍在執行，不復原');
  const statePath = path.join(root, 'data', 'state.json'), configPath = path.join(root, 'config.json');
  const stateBytes = await fs.readFile(statePath);
  try { JSON.parse(stateBytes.toString('utf8')); throw new Error('狀態檔仍有效，不執行損壞重建'); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const configBytes = await fs.readFile(configPath);
  const config = disableAllPurchases(JSON.parse(configBytes.toString('utf8')));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, 'data', 'recovery', stamp + '-forced-reboot');
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'state.corrupt.bin'), stateBytes, { flag: 'wx' });
  await fs.writeFile(path.join(backup, 'config.before-recovery.json'), configBytes, { flag: 'wx' });
  const recovery = { at: new Date().toISOString(), reason: 'forced_reboot_state_corruption', historyVerified: false, automaticPurchasesDisabled: true, originalStateBytes: stateBytes.length, backup: path.relative(root, backup) };
  // Write the disabled settings and warning before replacing state. A partial
  // recovery therefore cannot start automatic checkout with an empty ledger.
  await durableWrite(path.join(root, 'data', 'order-recovery-required.flag'), JSON.stringify(recovery, null, 2) + '\n');
  await durableWrite(configPath, JSON.stringify(config, null, 2) + '\n');
  await durableWrite(statePath, JSON.stringify({ seen: {}, forms: {}, initializedPages: {}, lastScan: null, recovery }) + '\n');
  return recovery;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--apply')) throw new Error('必須明確傳入 --apply；此指令會重建已損壞的狀態，不自動執行');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await recover(root), null, 2));
}
