import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { purchaseRecordsText, purchaseLogExportClient } from '../src/purchase-log-export.js';
import { esliteOrderTablesHtml, esliteSheetOrderRowsHtml } from '../src/eslite-purchase-ui.js';
import { funboxOrderTablesHtml } from '../src/funbox-purchase-ui.js';

const item = { platform: 'eslite', accountSlot: 'C', status: 'ordered', orderId: 'MOCK-001', product: { title: '測試商品' },
  payment: 'virtual_atm_home', paymentFallback: { from: 'seven_cod', to: 'virtual_atm_home', reason: '無門市資料' },
  steps: Array.from({ length: 80 }, (_, index) => ({ label: '核對派單任務', stepNumber: 2, state: 'success',
    at: '2026-10-10T09:00:00Z', elapsedMs: index, reason: `完整步驟 ${index}` })),
  password: 'SECRET', cookie: 'SECRET', checkout: { private: 'SECRET' } };

test('完整 UTF-8 文字包含全部步驟及備援資訊，不受畫面高度限制', () => {
  const text = purchaseRecordsText([{ item }]);
  assert.equal((text.match(/^02｜/gm) || []).length, 80);
  assert.match(text, /02｜17:00:00｜\+0.1s｜核對派單任務｜完成｜結束/);
  assert.doesNotMatch(text, /2026\/|完整步驟|結果說明|網站回應碼|執行內容/);
  assert.match(text, /7-11 取貨付款 → 宅配 ATM/); assert.match(text, /MOCK-001/);
  assert.doesNotMatch(text, /SECRET|cookie|password/); assert.match(text, /\r\n/);
});

test('錯誤步驟中的請求頭、憑證、HTML 也不外流，沒有舊步驟不補造', () => {
  const text = purchaseRecordsText([{ item: { ...item, error: 'Timeout 4000ms exceeded\nauthorization: SECRET',
    steps: [{ label: 'failed', state: 'failed', reason: 'cookie: SECRET\n下一步' }, { label: 'response', reason: '<!DOCTYPE html><html>SECRET</html>' }] } }]);
  assert.doesNotMatch(text, /SECRET|<html>|authorization:/); assert.match(text, /4.0 秒/);
  assert.match(purchaseRecordsText([{ item: { status: 'failed' } }]), /沒有逐步日誌/);
});

test('兩平台都有單筆 TXT 及篩選匯出入口', () => {
  assert.match(esliteOrderTablesHtml, /exportPurchaseLog\('eslite'\)/);
  assert.match(funboxOrderTablesHtml, /exportPurchaseLog\('funbox'\)/);
  assert.match(esliteSheetOrderRowsHtml([{ item, key: 'key' }]), /data-eslite-export="key"/);
});

test('浏览器下載純本機生成，有 BOM、完整步驟及正確單筆，無網路請求', () => {
  let clicked = 0, textParts, filename;
  const link = { click: () => clicked++, remove() {}, set download(value) { filename = value; } };
  const context = { currentStatus: { autoPurchase: {} }, esliteSheetRecords: () => ({ rows: [{ item, key: 'one' }, { item: { product: { title: '不能匯出' } }, key: 'two' }] }),
    document: { createElement: () => link, body: { append() {} } }, Blob: class { constructor(parts) { textParts = parts; } },
    URL: { createObjectURL: () => 'blob:local', revokeObjectURL() {} }, setTimeout: fn => fn(), alert: () => assert.fail('不應跳警告') };
  vm.runInNewContext(purchaseLogExportClient + ";exportPurchaseLog('eslite','one')", context);
  assert.equal(clicked, 1); assert.equal(textParts[0], '\uFEFF');
  assert.equal((textParts[1].match(/^02｜/gm)||[]).length,80); assert.doesNotMatch(textParts[1], /不能匯出/);
  assert.match(filename, /^eslite-C-MOCK-001-.*\.txt$/);
});
