import assert from 'node:assert/strict';
import test from 'node:test';
import { isTcsbSearchTarget, loadTcsbSearchProducts, parseTcsbProductsData, TCSB_SEARCH_URL } from '../src/tcsb-monitor.js';
import { ShoppingSiteMonitor, shoppingSiteName } from '../src/shopping-sites.js';

const item = (patch = {}) => ({ id: 232335, name: 'BEYBLADE X 戰鬥陀螺 BX-09 通行證',
  url_key: '4904810905240', is_saleable: false, prices: { final: { price: 995 } },
  base_image: { medium_image_url: 'https://cdn.example.test/bx09.webp' }, ...patch });
const payload = (data, page = 1, pages = 1, total = data.length) => ({ data, meta: { current_page: page, last_page: pages, total } });
const target = { id: 'tcsb-test', name: '墊腳石官網戰鬥陀螺', siteName: '墊腳石官網', url: TCSB_SEARCH_URL, enabled: true, baselineVersion: 'tcsb-products-v1' };

test('辨識新官網，不能誤認 91APP、momo 或相似惡意網域', () => {
  assert.equal(shoppingSiteName(TCSB_SEARCH_URL), '墊腳石官網');
  assert.equal(shoppingSiteName('https://shop.tcsb.com.tw/v2/Search?q=x'), '墊腳石購物網');
  assert.equal(isTcsbSearchTarget(target), true);
  for (const url of ['https://shop.tcsb.com.tw/v2/Search?q=x', 'https://tcsb.com.tw.evil.test/search?query=x',
    'https://www.momoshop.com.tw/TP/TP0002451/main', 'https://www.tcsb.com.tw/product/123', 'http://www.tcsb.com.tw/search?query=x']) {
    assert.equal(isTcsbSearchTarget({ url }), false);
  }
});

test('名稱／價格／圖片／可購狀態由官方欄位取得，保留戰鬥盤、配件，不虛構庫存', () => {
  const products = parseTcsbProductsData({ data: [item(), item({ id: 2, name: 'BEYBLADE X CX-16 極限衝擊對戰組C', is_saleable: true }),
    item({ id: 3, name: 'BEYBLADE X BX-57 3v3對戰收納盒', is_saleable: true }), item({ id: 4, name: 'BEYBLADE X BX-51 發射器' }),
    item({ id: 5, name: '戰鬥陀螺X漫畫 BX-09' }), item({ id: 6, name: '戰鬥陀螺X(3)' }), item({ id: 7, name: '一般玩具' })] });
  assert.equal(products.length, 4);
  assert.equal(products[0].available, false);
  assert.equal(products[1].available, true);
  assert.equal(products[0].price, 'NT$995');
  assert.equal(products[0].url, 'https://www.tcsb.com.tw/product/4904810905240');
  assert.equal(products[0].imageUrl, 'https://cdn.example.test/bx09.webp');
  assert.deepEqual(products[0].variants, []);
  assert.equal(products[0].stock, undefined);
  assert.equal(products[0].availabilitySource, 'tcsb-products-api');
});

test('缺失可購狀態保持未知；重複 ID 去重，不從字串 false 推論可購', () => {
  const products = parseTcsbProductsData({ data: [item({ is_saleable: 'false' }), item({ id: 2, is_saleable: undefined }), item({ id: 2, is_saleable: undefined })] });
  assert.equal(products.length, 2);
  assert.ok(products.every(product => product.available === null));
  assert.throws(() => parseTcsbProductsData({}), /格式不完整/);
});

test('全頁讀取保留使用者的搜尋和產地篩選，最多兩個並行，不跟隨外部 next URL', async () => {
  const calls = [];
  let concurrent = 0, maxConcurrent = 0;
  const products = await loadTcsbSearchProducts(target, async (href, options) => {
    const url = new URL(href);
    assert.equal(url.hostname, 'www.tcsb.com.tw');
    assert.equal(url.pathname, '/api/products');
    assert.equal(url.searchParams.get('query'), 'beyblade x 戰鬥陀螺');
    assert.equal(url.searchParams.get('place_of_origin'), '其他');
    assert.equal(options.headers.Accept, 'application/json');
    assert.ok(options.signal);
    const page = Number(url.searchParams.get('page'));
    calls.push(page); concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(resolve => setImmediate(resolve));
    concurrent--;
    return Response.json({ ...payload([item({ id: page })], page, 3, 3), links: { next: 'https://evil.test/api' } });
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(maxConcurrent, 2);
  assert.equal(products.length, 3);
});

test('HTTP、格式、分頁截斷、重複頁及掃描中筆數變動皆不接受部分結果', async () => {
  await assert.rejects(loadTcsbSearchProducts(target, async () => new Response('busy', { status: 429 })), /HTTP 429/);
  await assert.rejects(loadTcsbSearchProducts(target, async () => Response.json({})), /分頁資料不完整/);
  await assert.rejects(loadTcsbSearchProducts(target, async () => Response.json(payload([item()], 1, 11, 11))), /超過 10 頁/);
  await assert.rejects(loadTcsbSearchProducts(target, async () => Response.json(payload([item()], 1, 1, 2))), /未完整讀取/);
  await assert.rejects(loadTcsbSearchProducts(target, async href => {
    const page = Number(new URL(href).searchParams.get('page'));
    return Response.json(payload([item()], page, 2, page === 1 ? 2 : 3));
  }), /掃描中變動/);
  await assert.rejects(loadTcsbSearchProducts({ ...target, url: 'https://www.tcsb.com.tw/search' }), /關鍵字不能留空/);
});

test('整合監控：首輪只建基線，補貨一次通知，重複輪不洗版；故障保留基線', async t => {
  const state = { data: {}, async save() {} }, notifications = [];
  let available = false, failure = false;
  const monitor = new ShoppingSiteMonitor({ state, getTargets: () => [target],
    notify: async (text, options) => { notifications.push({ text, options }); },
    browserLauncher: () => assert.fail('新官網不使用瀏覽器'),
    fetcher: async () => failure ? new Response('busy', { status: 503 }) : Response.json(payload([item({ is_saleable: available })])) });
  t.after(() => monitor.close());
  const first = await monitor.scan();
  assert.equal(first.notified, 0);
  available = true;
  const restock = await monitor.scan();
  await Promise.all([...monitor.notificationTasks]);
  assert.equal(restock.restocked, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /墊腳石官網/);
  assert.doesNotMatch(notifications[0].text, /庫存.*1|前台可售.*1/);
  assert.equal((await monitor.scan()).notified, 0);
  const baseline = JSON.stringify(state.data.commerce.shoppingSites.targets[target.id].seen);
  failure = true;
  assert.equal((await monitor.scan()).errors.length, 1);
  assert.equal(JSON.stringify(state.data.commerce.shoppingSites.targets[target.id].seen), baseline);
});

test('套用共用黑名單；未知可售不製造假售罄或假補貨', async t => {
  const state = { data: {}, async save() {} };
  let availability = true;
  const monitor = new ShoppingSiteMonitor({ state, getTargets: () => [target], getExcludeKeywords: () => ['收納盒'],
    notify: async () => assert.fail('不應通知'),
    fetcher: async () => Response.json(payload([item({ is_saleable: availability }), item({ id: 2, name: 'BEYBLADE X BX-57 收納盒', is_saleable: true })])) });
  t.after(() => monitor.close());
  assert.equal((await monitor.scan()).excluded, 1);
  availability = undefined;
  const result = await monitor.scan();
  assert.equal(result.stockChanged, 0);
  assert.equal(result.restocked, 0);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen['232335'].available, true);
});
