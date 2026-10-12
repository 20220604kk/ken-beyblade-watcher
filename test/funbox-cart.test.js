import test from 'node:test';
import assert from 'node:assert/strict';
import { clearFunboxCart, readFunboxCart, parseFunboxCartHtml, reconcileFunboxCart, assertFunboxCheckoutRows } from '../src/funbox-cart.js';

const cart = 'https://shop.funbox.com.tw/carts/' + 'a'.repeat(32);
const item = (id = '111', quantity = 1, type = 'normal', collection_id = null) => ({ variant_id: id, quantity, type, collection_id });
const html = (items, csrf = 'csrf-test') => `<meta name="csrf-token" content="${csrf}"><script>window.lineItems = ${JSON.stringify(items)};</script>`;
const member = '<a href="/account/logout">登出</a>';
function response(status, body = '', location = '') {
  return { status: () => status, ok: () => status >= 200 && status < 300,
    headers: () => location ? { location } : {}, text: async () => body, async dispose() {} };
}
const nonempty = items => [response(302, '', cart), response(200, html(items))];
const empty = () => [response(302, '', '/account/index'), response(200, member)];
function context(gets, post = async () => response(200, '{}')) {
  const calls = [];
  return { calls, request: {
    async get(url, options) { calls.push({ method: 'GET', url, options }); assert.equal(options.maxRedirects, 0);
      assert.ok(gets.length, 'unexpected cart reread'); return gets.shift(); },
    async post(url, options) { calls.push({ method: 'POST', url, options }); return post(url, options); }
  } };
}

test('只解析官方購物車 JSON，不把推薦商品或整頁型號當成車內商品', () => {
  const state = parseFunboxCartHtml(html([item('111')]) + '<a href="/products/bx-09">222 BX-09</a>', cart);
  assert.deepEqual(state.items, [{ variantId: '111', quantity: 1, type: 'normal', collectionId: '', itemKey: '111_normal_' }]);
});
test('JSON 平衡解析支援字串中的括號、引號與換行', () => {
  const state = parseFunboxCartHtml(html([{ ...item(), title: 'hello ] \\" {' }]).replace('window.lineItems = ', 'window.lineItems =\n'), cart);
  assert.equal(state.items.length, 1);
});
test('缺少資料、資料截斷、非 JSON、數量與識別碼異常都不視為空車', () => {
  for (const source of ['<h1>頁面載入失敗</h1>', '<script>window.lineItems = [];</script><script></script>'.replace('[]', '[{'),
    '<script>window.lineItems = runCode();</script>', html([item('111', -1)]), html([item('bad-id')]), html([item('111', 1.5)])]) {
    assert.throws(() => parseFunboxCartHtml(source, cart));
  }
});
test('未知網站／非購物車 URL 不可作為權威資料', () => {
  assert.throws(() => parseFunboxCartHtml(html([]), 'https://other.example/carts/' + 'a'.repeat(32)));
  assert.throws(() => parseFunboxCartHtml(html([]), 'https://shop.funbox.com.tw/'));
});
test('目前空車導向會員中心，必須確認登入才可回報空車', async () => {
  const ctx = context(empty());
  assert.deepEqual((await readFunboxCart(ctx)).items, []);
  assert.equal(ctx.calls.length, 2);
});
test('登入頁、假會員頁、外站、404、503 都不誤判成空車', async () => {
  for (const gets of [[response(302, '', '/account/login')], [response(302, '', '/account/index'), response(200, '<form>登入</form>')],
    [response(302, '', 'https://other.example/')], [response(404)], [response(503)], [response(302, '', '/')]]) {
    await assert.rejects(readFunboxCart(context(gets)));
  }
});
test('空車只確認狀態，不發任何刪除請求', async () => {
  const ctx = context(empty());
  const result = await clearFunboxCart(ctx);
  assert.equal(result.cleared, true); assert.equal(result.removed, 0);
  assert.ok(ctx.calls.every(call => call.method === 'GET'));
});
test('一次清除所有項目，等待 API 回覆後再讀權威空車', async () => {
  let posted = false;
  const ctx = context([...nonempty([item('111'), item('222', 2, 'add-buy', '99')]), ...empty()], async (url, options) => {
    assert.equal(url, cart + '/update_line_item');
    assert.deepEqual(options.data.updates, { '111_normal_': 0, '222_add-buy_99': 0 });
    assert.equal(options.headers['X-CSRF-Token'], 'csrf-test');
    assert.equal(ctx.calls.filter(c => c.method === 'GET').length, 2, 'reread must not precede mutation response');
    await new Promise(resolve => setTimeout(resolve, 25)); posted = true; return response(200);
  });
  const result = await clearFunboxCart(ctx);
  assert.equal(posted, true); assert.equal(result.removed, 2); assert.equal(result.cleared, true);
  assert.deepEqual(ctx.calls.map(c => c.method), ['GET', 'GET', 'POST', 'GET', 'GET']);
});
test('清車回傳 200 但商品未消失，禁止加購而且不盲目重刪', async () => {
  const ctx = context([...nonempty([item()]), ...nonempty([item()])]);
  await assert.rejects(clearFunboxCart(ctx), /仍有 1 款/);
  assert.equal(ctx.calls.filter(c => c.method === 'POST').length, 1);
});
test('清車逾時即使重查是空車，也不准加購，以防遲到刪除', async () => {
  const ctx = context([...nonempty([item()]), ...empty()], async () => { throw new Error('Timeout 5000ms'); });
  await assert.rejects(clearFunboxCart(ctx), /結果不明.*禁止加購/);
  assert.equal(ctx.calls.filter(c => c.method === 'POST').length, 1);
});
test('缺少 CSRF 不發清車，登入失效或限流不反覆送請求', async () => {
  const ctx = context([response(302, '', cart), response(200, html([item()], ''))]);
  await assert.rejects(clearFunboxCart(ctx), /CSRF/);
  assert.ok(ctx.calls.every(c => c.method === 'GET'));
  for (const status of [401, 403, 429, 503]) {
    const blocked = context(nonempty([item()]), async () => response(status));
    await assert.rejects(clearFunboxCart(blocked));
    assert.equal(blocked.calls.length, 3);
  }
});
test('購物車只剩已授權部分時保留這些商品，其餘延後，不重複加購', () => {
  const first = { product: { title: 'one', variantId: '111' }, quantity: 1 }, second = { product: { title: 'two', variantId: '222' }, quantity: 1 };
  const result = reconcileFunboxCart(parseFunboxCartHtml(html([item('111')]), cart), [first, second]);
  assert.deepEqual(result.matched, [first]); assert.deepEqual(result.missing, [second]);
});
test('購物車混入外品、重複列、數量不符或全缺失時仍攔下', () => {
  const expected = [{ product: { title: 'one', variantId: '111' }, quantity: 1 }];
  for (const rows of [[item('222')], [item('111'), item('111')], [item('111', 2)], []]) {
    assert.throws(() => reconcileFunboxCart(parseFunboxCartHtml(html(rows), cart), expected));
  }
});
test('本輪 API 刷新過的實際規格優先，明確贈品不當成額外購買', () => {
  const expected = [{ product: { title: 'one', variantId: 'old' }, variantId: '111', quantity: 1 }];
  assert.equal(reconcileFunboxCart(parseFunboxCartHtml(html([item('111'), item('222', 1, 'gift')]), cart), expected).matched.length, 1);
});
test('最終送單檢查接受不同順序但品項與數量必須完全相同', () => {
  const expected = ['one', 'two'].map(id => ({ product: { url: 'https://shop.funbox.com.tw/products/' + id }, quantity: 1 }));
  assert.doesNotThrow(() => assertFunboxCheckoutRows(['two', 'one'].map(id => ({ url: '//shop.funbox.com.tw/products/' + id, quantity: 1 })), expected));
});
test('最終送單前少品、混入外品、數量變動、惡意網址都會攔截', () => {
  const expected = [{ product: { url: 'https://shop.funbox.com.tw/products/one' }, quantity: 1 }];
  for (const rows of [[], [{ url: '/products/two', quantity: 1 }], [{ url: '/products/one', quantity: 2 }],
    [{ url: 'https://other.example/products/one', quantity: 1 }]]) assert.throws(() => assertFunboxCheckoutRows(rows, expected));
});
