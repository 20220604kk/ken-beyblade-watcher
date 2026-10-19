import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { canonicalRakutenItemUrl, parseRakutenItem } from '../src/rakuten-item.js';
import { classifyJapanAuctionUrl, JapanAuctionMonitor, parseJapanAuctionPage } from '../src/japan-auctions.js';

const url = 'https://item.rakuten.co.jp/auc-ookawaya/4904810077596/';
const item = (stock = 0) => ({ manageNumber: '4904810077596', title: 'BEYBLADE X CX-20 カスタマイズセット C',
  inventoryType: 'single', variantId: '4904810077596', taxIncludedPrice: 7810,
  features: { displayNormalCartButton: true }, purchaseInfo: {
    purchaseBySellType: { purchaseCondition: stock ? 'enabled' : 'sold-out' },
    newPurchaseSku: { quantity: stock, ...(stock ? {} : { stockCondition: 'sold-out' }) },
    variantMappedInventories: [{ sku: '4904810077596', quantity: stock }] } });
const html = (i = item(), shop = 'auc-ookawaya') => `<html><meta charset="EUC-JP"><body>${' '.repeat(1000)}
<h2>推薦商品 CX-99 在庫あり 購入する</h2><script id="item-page-app-data" type="application/json">${JSON.stringify({
  shop: { shopUrl: shop, shopName: 'トイスタジアム1号店' }, newApi: { itemInfoSku: i }
})}</script></body></html>`;
const target = { id: 'rakuten-single', ...classifyJapanAuctionUrl(url) };

test('樂天單品識別、查詢參數去重且不接受分類／非官網／憑證網址', () => {
  assert.equal(target.sourceType, 'rakuten-item');
  assert.equal(canonicalRakutenItemUrl(url + '?variantId=one#detail'), url);
  for (const bad of ['http://item.rakuten.co.jp/a/b/', 'https://item.rakuten.co.jp/a/c/',
    'https://item.rakuten.co.jp/a/s/', 'https://fake.example/a/b/', 'https://u:p@item.rakuten.co.jp/a/b/']) {
    assert.throws(() => canonicalRakutenItemUrl(bad));
  }
});

test('只讀指定單品JSON，推薦區有貨不能蓋過主商品售罄', () => {
  const [p] = parseJapanAuctionPage(html(), target);
  assert.equal(p.available, false); assert.equal(p.stock, 0); assert.equal(p.price, '¥7,810');
  assert.equal(p.id, '/auc-ookawaya/4904810077596'); assert.equal(p.url, url);
  assert.equal(parseRakutenItem(html(item(4)), url)[0].available, true);
});

test('資料缺漏、身份不符、未知／矛盾販售狀態、多規格均不可推測可購', () => {
  const bad = [
    { ...item(), manageNumber: 'other' }, { ...item(), inventoryType: 'multiple' },
    { ...item(), title: '\uFFFD' }, { ...item(), purchaseInfo: {} },
    { ...item(1), purchaseInfo: { ...item(1).purchaseInfo, purchaseBySellType: { purchaseCondition: 'unknown' } } },
    { ...item(1), purchaseInfo: { ...item(1).purchaseInfo, newPurchaseSku: { quantity: 1, stockCondition: 'sold-out' } } },
    { ...item(1), purchaseInfo: { ...item(1).purchaseInfo, variantMappedInventories: [{ sku: 'wrong', quantity: 1 }] } }
  ];
  for (const i of bad) assert.throws(() => parseRakutenItem(html(i), url), /保留既有基線/);
  assert.throws(() => parseRakutenItem(html(item(), 'other'), url), /識別不符/);
  assert.throws(() => parseRakutenItem('<html>Just a moment</html>', url));
});

test('HTTP直查正確解碼EUC-JP；售罄基線轉有貨只通知一次、失敗保留基線', async () => {
  const state = { data: {}, save: async () => {} }, notices = [];
  let current = html(), requests = 0;
  const monitor = new JapanAuctionMonitor({ dataDir: '.', state, getTargets: () => [target],
    notify: async (...args) => notices.push(args), fetcher: async requested => {
      requests++; assert.equal(requested, url);
      return new Response(iconv.encode(current, 'euc-jp'), { headers: { 'content-type': 'text/html;charset=EUC-JP' } });
    } });
  monitor.pageFor = async () => { throw Error('不應啟動瀏覽器'); };
  try {
    await monitor.scanTarget(target); assert.equal(notices.length, 0);
    assert.match(Object.values(monitor.status(target).products)[0].title, /カスタマイズ/);
    current = html(item(3)); const result = await monitor.scanTarget(target);
    assert.equal(result.restocked, 1); assert.equal(notices.length, 1);
    await monitor.scanTarget(target); assert.equal(notices.length, 1);
    current = html({ ...item(), purchaseInfo: {} });
    await assert.rejects(monitor.scanTarget(target));
    assert.equal(Object.values(monitor.status(target).products)[0].stock, 3);
    assert.ok(monitor.status(target).lastError); assert.equal(requests, 4);
  } finally { await monitor.close(); }
});
