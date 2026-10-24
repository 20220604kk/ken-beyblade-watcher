import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyLog, OperationalLogPolicy } from '../src/log-policy.js';
import { maintainLogs } from '../src/log-maintenance.js';

const emptyScan = 'Funbox 掃描完成：目前 81 件，新發現 0 件，庫存變動 0 件，通知 0 則。';
test('正常無變化掃描每輪保留，不因新品或通知為零而過濾', () => {
  const policy = new OperationalLogPolicy();
  for (const text of [emptyScan,
    '樂天：原始 35 件，保留 34 件 BEYBLADE X 商品、排除 1 件，新品 0、補貨 0、通知 0、近期重複略過 0。',
    '日亞官方原價：官方定價 153 件、合格 4 件、通知 0 則。',
    '誠品：本輪來源讀取 5 件、即時商品頁確認 0 件；合併既有基線後追蹤 8 件。']) {
    assert.equal(policy.accept(text), text);
    assert.equal(policy.accept(text), text, 'identical normal scans remain visible every round');
  }
  assert.ok(policy.accept(emptyScan.replace('庫存變動 0', '庫存變動 1')));
  assert.equal(classifyLog('樂天：原始 3 件，首次建立安全基線（不通知）。').kind, 'event');
  assert.equal(policy.accept('未分類的新訊息'), '未分類的新訊息');
});

test('歷史整理保留仍在保存期內的無變化掃描，不再按 routine 直接刪除', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-normal-scans-'));
  try {
    const file = path.join(root, '2026-10-23.log');
    const text = `[2026/10/23 上午10:00:00] ${emptyScan}\n[2026/10/23 上午10:00:02] ${emptyScan}\n`;
    await fs.writeFile(file, text); await fs.utimes(file, new Date('2026-10-23'), new Date('2026-10-23'));
    const report = await maintainLogs({ root, now: new Date('2026-10-24T16:00:00+08:00'), apply: true });
    assert.equal(report.removedEntries, 0); assert.equal(await fs.readFile(file, 'utf8'), text);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('交易與失敗優先於零通知摘要，交易步驟不節流', () => {
  const policy = new OperationalLogPolicy();
  for (const text of ['送單逾時，結果不明', '取得訂單 FB552483｜ATM 808', '安全結帳｜失敗', '掃描完成通知 0，訂單成立', 'order_number 123']) {
    assert.equal(classifyLog(text).kind, 'transaction');
    assert.equal(policy.accept(text), text);
    assert.equal(policy.accept(text), text);
  }
  assert.equal(classifyLog(emptyScan + ' HTTP 429').kind, 'error');
});
test('重複錯誤五分鐘節流，來源與帳號隔離並限制記憶體', () => {
  const policy = new OperationalLogPolicy({ maxKeys: 2 });
  assert.equal(policy.accept('帳號 A 登入失敗', 'shopping', 0), '帳號 A 登入失敗');
  assert.equal(policy.accept('帳號 A 登入失敗', 'shopping', 1000), null);
  assert.ok(policy.accept('帳號 B 登入失敗', 'shopping', 1000));
  assert.match(policy.accept('帳號 A 登入失敗', 'shopping', 300001), /略過 1 次/);
  assert.ok(policy.accept('帳號 A 登入失敗', 'japan', 300001));
  assert.equal(policy.errors.size, 2);
});
test('歷史清理：預覽不寫，僅清理過往 log，保護訂單、續行、活動檔與未知日期', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-log-policy-'));
  try {
    const old = path.join(root, '2026-09-01.log');
    const content = `[2026/9/1 下午1:02:03] ${emptyScan}\n[2026/9/1 下午1:02:04] Funbox 補貨 1\n[2026/9/1 下午1:02:05] 掃描失敗\n[2026/9/1 下午1:02:06] 訂單成立 FB552483\n  ATM 808 - protected\n[2026/9/1 下午1:02:07] 不認識的紀錄\n`;
    await fs.writeFile(old, content);
    await fs.writeFile(path.join(root, 'state.json'), '{"never":"touch"}');
    await fs.writeFile(path.join(root, '2026-10-17.log'), emptyScan);
    await fs.writeFile(path.join(root, 'monitor-current.out.log'), emptyScan);
    await fs.writeFile(path.join(root, '日期未辨識.log'), '不知道日期的紀錄\n');
    await fs.writeFile(path.join(root, 'empty.log'), `[2026/9/1 下午1:02:03] ${emptyScan}\n`);
    const past = new Date('2026-09-02T00:00:00+08:00');
    for (const name of await fs.readdir(root)) await fs.utimes(path.join(root, name), past, past);
    const now = new Date('2026-10-17T22:00:00+08:00');
    const preview = await maintainLogs({ root, now });
    assert.ok(preview.removedEntries >= 4);
    assert.equal(await fs.readFile(old, 'utf8'), content);
    const applied = await maintainLogs({ root, now, apply: true });
    assert.equal(applied.skippedActive, 2);
    assert.equal(applied.filesDeleted, 1);
    assert.equal(await fs.readFile(old, 'utf8'), '[2026/9/1 下午1:02:06] 訂單成立 FB552483\n  ATM 808 - protected\n[2026/9/1 下午1:02:07] 不認識的紀錄\n');
    assert.equal(await fs.readFile(path.join(root, 'state.json'), 'utf8'), '{"never":"touch"}');
    assert.equal(await fs.readFile(path.join(root, '日期未辨識.log'), 'utf8'), '不知道日期的紀錄\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('拒絕磁碟根目錄與連結，不能沿連結刪除其他資料', async () => {
  await assert.rejects(maintainLogs({ root: path.parse(process.cwd()).root }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-log-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-log-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'keep.log'), emptyScan);
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await maintainLogs({ root, apply: true });
    assert.equal(result.skippedLinks, 1);
    assert.equal(await fs.readFile(path.join(outside, 'keep.log'), 'utf8'), emptyScan);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
test('原始輸出的凌晨／晚上時間可辨識，舊事件過期但交易證據不過期', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-log-local-time-'));
  try {
    const file = path.join(root, 'crash-old.out.log');
    await fs.writeFile(file, '[2026/9/1 凌晨12:00:12] 新品訊號 BX-35\n[2026/9/1 晚上11:10:12] 訂單結果不明\n');
    await fs.utimes(file, new Date('2026-09-02'), new Date('2026-09-02'));
    await maintainLogs({ root, now: new Date('2026-10-17'), apply: true });
    assert.equal(await fs.readFile(file, 'utf8'), '[2026/9/1 晚上11:10:12] 訂單結果不明\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
