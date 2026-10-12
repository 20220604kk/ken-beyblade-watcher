import test from 'node:test';
import assert from 'node:assert/strict';
import { FunboxPurchaseAdapter } from '../src/auto-purchase.js';

const origin = 'https://shop.funbox.com.tw', token = 'b'.repeat(32), cartUrl = origin + '/carts/' + token;
const products = [
  { id: 'bx09', title: 'BEYBLADE BX-09', url: origin + '/products/bx09', variantId: '123', stock: 10, quantity: 1 },
  { id: 'bx35', title: 'BEYBLADE BX-35 隨機強化組', url: origin + '/products/bx35', variantId: '456', stock: 10, quantity: 1 }
];
const profile = { fullName: '隔離測試', phone: '0900000000', city: '桃園市', district: '中壢區', postalCode: '320', address: '測試地址' };
const response = (body, url, status = 200, headers = {}) => ({ status: () => status, ok: () => status >= 200 && status < 300,
  url: () => url, headers: () => headers, text: async () => typeof body === 'string' ? body : JSON.stringify(body), json: async () => body, dispose: async () => {} });
function fixture({ skip = false, timeoutAdd = false, ambiguousAdd = false, timeoutOrder = false, mismatch = false } = {}) {
  const cart = [], adds = [], events = []; let submits = 0, clears = 0;
  const props = () => ({ csrfToken: 'fixture-csrf', cart: { token, customer: { email: 'test@example.invalid', mobile: profile.phone } },
    lineItems: cart.map(item => ({ type: 'normal', variant_id: Number(item.variantId), quantity: item.quantity })),
    paymentItems: [], requiresShipping: true, shop: { cart_extra_inputs: [] }, priceValidations: { total_price_before_bonus_discount: cart.length * 100 } });
  const choices = { payment_items: [{ id: 1, service: 'cyberbizpay_atm', cvs_payment: 'no', label: '虛擬ATM', payment_charge: 0 }],
    price_weight_shipping_rates: [{ id: 2, name: '一般宅配', shipping_class: 'ShippingRule', deliverable_countries: 'On shore of Taiwan', price: 120, payment_names: ['虛擬ATM'] }] };
  const api = { storageState: async () => ({ cookies: [], origins: [] }), dispose: async () => {}, get: async url => {
    if (url === origin + '/account' || url === origin + '/account/index') return response('<a href="/account/logout">登出</a>', url);
    if (url === origin + '/cart') { if (!cart.length) clears++; return response('', url, 302, { location: cart.length ? cartUrl : '/account/index' }); }
    if (url === cartUrl) return response(`<meta name="csrf-token" content="fixture-csrf"><script>window.lineItems = ${JSON.stringify(props().lineItems)};</script><div id="checkout-v3" data-react-props='${JSON.stringify(props())}'></div>`, url);
    if (url.includes('/shipping_rates_and_payment_method_items')) return response(choices, url);
    if (url === origin + '/products/bx35.json') return response({ variants: [{ id: 456, inventory_quantity: 0, inventory_policy: 'deny' }] }, url);
    if (url === origin + '/account/orders') return response('<a href="/account/logout">登出</a>' + (!timeoutOrder && submits ? `<a href="/account/orders/${token}">明細</a>` : ''), url);
    if (url === origin + '/account/orders/' + token) return response(`<div class="order_name"><span class="value">FB-BATCH-MOCK</span></div><div class="order_total_price">NT$${cart.length * 100 + 120}</div><div class="item_title">付款方式</div><div class="item_content">虛擬ATM繳費</div><div class="item_title">付款狀態</div><div class="item_content">等待付款</div><div class="order_line_items">${cart.map(item => `<div class="table_row"><div class="line_item_title"><a href="/products/${item.id}">${item.title} -</a></div><div class="line_item_price_quantity">NT$100 x ${mismatch ? 2 : item.quantity}</div></div>`).join('')}</div>`, url);
    if (url === origin + '/orders/' + token) return response(`<h4 class="payment-way">您選擇的付款方式為: 虛擬ATM</h4><p>轉帳銀行: 玉山銀行(808) 帳號: 12345678901234 轉帳金額: NT$${cart.length * 100 + 120} 請於 2026-10-12 23:59 前完成轉帳</p>`, url);
    throw Error('Unexpected fixture GET ' + url);
  }, post: async (url, options) => {
    if (url === origin + '/cart/add') {
      const item = products.find(p => p.variantId === options.form.id); adds.push(item.id); events.push('add-' + item.id);
      if (skip && item.id === 'bx35') return response({ message: '售罄' }, url, 409);
      cart.push({ ...item, quantity: Number(options.form.quantity) });
      if (timeoutAdd && item.id === 'bx35') throw Error('Timeout 5000ms exceeded');
      return response({}, url, ambiguousAdd && item.id === 'bx35' ? 503 : 200);
    }
    if (url.endsWith('/apply_bonus')) { assert.equal(options.form.bonus_used, '0'); return response({ bonus_used: 0 }, url); }
    if (url === cartUrl + '/') {
      submits++; events.push('submit'); assert.equal(options.form.bonus_used, '0');
      if (timeoutOrder) throw Error('Timeout 15000ms exceeded');
      return response({ success: true, url: '/orders/' + token }, url);
    }
    throw Error('Unexpected fixture POST ' + url);
  } };
  const adapter = new FunboxPurchaseAdapter({ dataDir: 'test/nonexistent-batch-session', apiAtmCheckout: true, apiContextFactory: async () => api,
    browserLauncher: () => { throw Error('Browser forbidden'); }, getDeliveryProfile: () => profile });
  const run = (extra = {}) => adapter.purchase(products[0], { action: 'checkout', payment: 'virtual_atm_home', batchProducts: products,
    buyKeywords: ['BEYBLADE'], skipBuyKeywords: [], batchAllowPartial: true, batchBuildMs: 8000, maxTotal: 500,
    onBeforeSubmit: async intent => { assert.ok(intent.products.length); events.push('intent'); }, ...extra });
  return { adapter, run, cart, adds, events, counts: () => ({ submits, clears }) };
}
test('FUNBOX正式 adapter 合單：一車兩款一張單，紅利0與ATM資訊，無瀏覽器', async () => {
  const f = fixture();
  try {
    const result = await f.run(); assert.equal(result.status, 'ordered'); assert.equal(result.orderNumber, 'FB-BATCH-MOCK');
    assert.equal(result.quantity, 2); assert.equal(result.products.length, 2); assert.equal(result.bankCode, '808');
    assert.deepEqual(f.adds, ['bx09', 'bx35']); assert.deepEqual(f.events, ['add-bx09', 'add-bx35', 'intent', 'submit']);
    assert.equal(f.counts().submits, 1); assert.equal(f.counts().clears, 1);
    assert.equal(f.cart[1].quantity, 1, '帳本剩餘額度一件，不再加三件');
  } finally { await f.adapter.close(); }
});
test('FUNBOX正式 adapter 合單：售罄剔除，保留優先品項送單', async () => {
  const f = fixture({ skip: true });
  try { const result = await f.run(); assert.equal(result.status, 'ordered'); assert.equal(result.products.length, 1); assert.equal(result.skippedProducts[0].id, 'bx35'); assert.equal(f.counts().submits, 1); }
  finally { await f.adapter.close(); }
});
for (const scenario of [{ timeoutAdd: true }, { ambiguousAdd: true }]) test('FUNBOX加車結果不明：查整車不重加 ' + JSON.stringify(scenario), async () => {
  const f = fixture(scenario);
  try { assert.equal((await f.run()).status, 'ordered'); assert.equal(f.adds.length, 2); }
  finally { await f.adapter.close(); }
});
test('FUNBOX合單送單逾時／明細不符：保護整車，不能下一張清車', async () => {
  for (const scenario of [{ timeoutOrder: true }, { mismatch: true }]) {
    const f = fixture(scenario);
    try {
      const result = await f.run(); assert.equal(result.status, 'submitted_unconfirmed'); assert.equal(result.products.length, 2);
      assert.equal(f.adapter.activePurchaseHold().products.length, 2);
      await assert.rejects(f.run(), e => e.purchaseStatus === 'submitted_unconfirmed'); assert.equal(f.counts().submits, 1);
    } finally { await f.adapter.close(); }
  }
});
test('FUNBOX合單含運超額：送單前阻止，不靠付款階段才拒絕', async () => {
  const f = fixture();
  try { await assert.rejects(f.run({ maxTotal: 300 }), /超過/); assert.equal(f.counts().submits, 0); }
  finally { await f.adapter.close(); }
});
