import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMmToyShoppingTarget, isWithinActiveHours, millisecondsUntilActiveStart, normalizeFacebookPage,
  parseFunboxInterval, parseHotspotInterval, parseKeywordList, parsePageNickname,
  parseScanInterval, parseTimeValue, selectFacebookModePages, shoppingActiveHoursForTarget
} from '../src/settings.js';

test('掃描間隔接受 5～1440 分鐘整數', () => {
  assert.equal(parseScanInterval('10'), 10);
  assert.throws(() => parseScanInterval('1'), /5～1440/);
  assert.throws(() => parseScanInterval('10.5'), /5～1440/);
});

test('熱點掃描接受 5～300 秒整數', () => {
  assert.equal(parseHotspotInterval('30'), 30);
  assert.equal(parseHotspotInterval('5'), 5);
  assert.throws(() => parseHotspotInterval('4'), /5～300/);
});

test('Funbox 官網掃描接受 2～3600 秒整數', () => {
  assert.equal(parseFunboxInterval('2'), 2);
  assert.equal(parseFunboxInterval('3'), 3);
  assert.equal(parseFunboxInterval('60'), 60);
  assert.throws(() => parseFunboxInterval('1'), /2～3600/);
  assert.throws(() => parseFunboxInterval('3.5'), /2～3600/);
});

test('Facebook 網址會正規化並移除追蹤參數', () => {
  const page = normalizeFacebookPage({
    name: '測試店家',
    url: 'https://m.facebook.com/profile.php?id=123&fbclid=tracking'
  });
  assert.equal(page.name, '測試店家');
  assert.equal(page.url, 'https://www.facebook.com/profile.php?id=123');
  assert.equal(page.nameMode, 'manual');
});

test('未填名稱時採自動名稱模式，手動暱稱會驗證長度', () => {
  const page = normalizeFacebookPage({ url: 'https://www.facebook.com/profile.php?id=456' });
  assert.equal(page.nameMode, 'auto');
  assert.equal(parsePageNickname('  我的店家  '), '我的店家');
  assert.throws(() => parsePageNickname(''), /不能留空/);
});

test('每日監控時段支援跨越午夜與全天模式', () => {
  const atEight = new Date(2026, 6, 13, 8, 0);
  const atNoon = new Date(2026, 6, 13, 12, 0);
  assert.equal(isWithinActiveHours(atEight, '09:00', '00:00'), false);
  assert.equal(isWithinActiveHours(atNoon, '09:00', '00:00'), true);
  assert.equal(isWithinActiveHours(atEight, '00:00', '00:00'), true);
  assert.equal(parseTimeValue('23:59'), '23:59');
  assert.throws(() => parseTimeValue('24:00'), /HH:MM/);
});

test('休息時段可計算到下次開始時間', () => {
  const atEight = new Date(2026, 6, 13, 8, 0);
  assert.equal(millisecondsUntilActiveStart(atEight, '09:00'), 60 * 60 * 1000);
});

test('購物專區可沿用共用時段或設定自己的 24 小時時段', () => {
  const general = { start: '09:00', end: '18:00' };
  assert.deepEqual(shoppingActiveHoursForTarget({ scheduleMode: 'default' }, general), general);
  assert.deepEqual(shoppingActiveHoursForTarget({
    scheduleMode: 'custom', activeHours: { start: '00:00', end: '00:00' }
  }, general), { start: '00:00', end: '00:00' });
  assert.equal(isWithinActiveHours(new Date(2026, 7, 17, 3, 0), '00:00', '00:00'), true);
});

test('舊版 MM 小舖專區可在升級時辨識為獨立排程候選', () => {
  assert.equal(isMmToyShoppingTarget({ sourceType: 'mmtoy-category' }), true);
  assert.equal(isMmToyShoppingTarget({ url: 'https://mmtoyshop.com/category/test' }), true);
  assert.equal(isMmToyShoppingTarget({ url: 'https://www.eslite.com/Search' }), false);
});

test('FB 主監控以常態模式運作，進入熱點時段後指定粉專只由熱點模式掃描', () => {
  const pages = [
    { name: '一般店家', url: 'https://www.facebook.com/regular', enabled: true },
    { name: '台茂店', url: 'https://www.facebook.com/hotspot', enabled: true },
    { name: '暫停店家', url: 'https://www.facebook.com/paused', enabled: false }
  ];

  const normal = selectFacebookModePages(pages, {
    hotspotEnabled: true,
    hotspotActive: false,
    hotspotPageUrls: ['https://www.facebook.com/hotspot']
  });
  assert.deepEqual(normal.regularPages.map((page) => page.name), ['一般店家', '台茂店']);
  assert.deepEqual(normal.hotspotPages, []);

  const accelerated = selectFacebookModePages(pages, {
    hotspotEnabled: true,
    hotspotActive: true,
    hotspotPageUrls: ['https://www.facebook.com/hotspot']
  });
  assert.deepEqual(accelerated.regularPages.map((page) => page.name), ['一般店家']);
  assert.deepEqual(accelerated.hotspotPages.map((page) => page.name), ['台茂店']);
});

test('拒絕非 Facebook 網址與重複頁面', () => {
  assert.throws(() => normalizeFacebookPage({ url: 'https://example.com/page' }), /只允許/);
  const existing = [{ name: '店家', url: 'https://www.facebook.com/profile.php?id=123' }];
  assert.throws(
    () => normalizeFacebookPage({ url: 'https://www.facebook.com/profile.php?id=123' }, existing),
    /已經在監控清單/
  );
});

test('命中詞庫會整理空白、去除重複並拒絕空詞庫', () => {
  assert.deepEqual(parseKeywordList([' 戰鬥陀螺 ', 'BEYBLADE', 'beyblade', ''], '產品命中詞'), ['戰鬥陀螺', 'BEYBLADE']);
  assert.throws(() => parseKeywordList([], '產品命中詞'), /至少要保留一個/);
  assert.throws(() => parseKeywordList(['x'.repeat(61)], '產品命中詞'), /最多 60/);
});
