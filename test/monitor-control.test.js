import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { disableAllPurchases } from '../scripts/recover-reboot-state.mjs';
import { StateStore } from '../src/state.js';
import { validateMonitorFiles } from '../scripts/monitor-preflight.mjs';

test('斷電復原關閉兩平台與日亞全部購買線，包括暫停前的恢復設定；不更動監控與原設定', () => {
  const original = { autoPurchase: { enabled: true, funbox: { enabled: true, quantity: 3 }, eslite: { enabled: true } },
    amazonJpProductOrders: { A: { enabled: true, targetUrl: 'test' }, B: { enabled: true }, C: { enabled: true } },
    systemPause: { active: true, resumeState: { autoPurchaseEnabled: true, funboxEnabled: true, amazonProductOrders: { A: true } } },
    funbox: { enabled: true }, shoppingSites: { enabled: true } };
  const disabled = disableAllPurchases(original);
  assert.equal(original.autoPurchase.enabled, true);
  assert.equal(disabled.autoPurchase.enabled, false);
  for (const site of ['funbox','eslite']) assert.equal(disabled.autoPurchase[site].enabled, false);
  for (const slot of ['A','B','C']) assert.equal(disabled.amazonJpProductOrders[slot].enabled, false);
  assert.equal(disabled.systemPause.resumeState.autoPurchaseEnabled, false);
  assert.deepEqual(disabled.systemPause.resumeState.amazonProductOrders, { A:false, B:false, C:false });
  assert.equal(disabled.funbox.enabled, true);
  assert.equal(disabled.autoPurchase.funbox.quantity, 3);
  assert.equal(disabled.amazonJpProductOrders.A.targetUrl, 'test');
});

test('狀態檔損壞時保留原檔，不默默當作新狀態，也不把私人內容寫入錯誤', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-state-corrupt-'));
  try {
    const raw = '\0'.repeat(100) + 'PRIVATE';
    await fs.writeFile(path.join(dir,'state.json'), raw);
    await assert.rejects(new StateStore(dir).load(), error => /state.json 已損壞/.test(error.message) && !error.message.includes('PRIVATE'));
    assert.equal(await fs.readFile(path.join(dir,'state.json'),'utf8'), raw);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('保存狀態先保留前一份有效快照，反覆儲存不覆寫同分鐘的備份', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-state-durable-'));
  try {
    const state = new StateStore(dir, {saveDelayMs:0});
    await state.load(); state.mark('old'); await state.save();
    state.lastBackupAt=0; state.mark('new'); await state.save();
    const backup = await fs.readFile(path.join(dir,'state.json.last-good'),'utf8');
    assert.ok(JSON.parse(backup).seen.old); assert.equal(JSON.parse(backup).seen.new,undefined);
    state.mark('another'); await state.save();
    assert.equal(await fs.readFile(path.join(dir,'state.json.last-good'),'utf8'),backup);
    assert.ok(JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8')).seen.another);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('啟動預檢拒絕損壞、null、陣列，不輸出檔案內的私人資訊；有效物件可以啟動', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-preflight-'));
  const file = path.join(dir, 'state.json');
  try {
    for (const raw of ['\0\0PRIVATE', 'null', '[]']) {
      await fs.writeFile(file, raw);
      assert.throws(() => validateMonitorFiles([file]), error => error.message.includes('state.json') && !error.message.includes('PRIVATE'));
      assert.equal(await fs.readFile(file,'utf8'), raw);
    }
    await fs.writeFile(file, '{"seen":{}}');
    assert.doesNotThrow(() => validateMonitorFiles([file]));
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
