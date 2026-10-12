import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNBOX_CONTACT_FIELDS, validateFunboxDeliveryProfile, assertFunboxAtmContactSnapshot,
  fillFunboxHomeContact, verifyFunboxRenderedCart, isFunboxCheckoutTelemetry,
  installFunboxCheckoutResourcePolicy, captureFunboxCheckoutHtml } from '../src/funbox-checkout.js';

const profile = { fullName: '測試收件人', phone: '0912345678', city: '桃園市', district: '中壢區',
  postalCode: '320', address: '測試路1號' };
test('只排除已知追蹤流量，結帳、登入、付款、驗證、未知 CDN 皆保留', () => {
  assert.equal(isFunboxCheckoutTelemetry('https://www.googletagmanager.com/gtm.js'), true);
  assert.equal(isFunboxCheckoutTelemetry('https://scripts.clarity.ms/1.js'), true);
  for (const url of ['https://shop.funbox.com.tw/orders', 'https://shop.funbox.com.tw/account/login',
    'https://cdn-general.cybassets.com/frontend/checkout/main.js', 'https://www.google.com/recaptcha/api.js',
    'https://www.gstatic.com/recaptcha.js', 'https://payment.example.com',
    'https://www.googletagmanager.com.other.com/file.js', 'invalid']) {
    assert.equal(isFunboxCheckoutTelemetry(url), false);
  }
});
test('資源政策只安裝在當前工作頁，核心與付款請求仍放行', async () => {
  let handler;
  await installFunboxCheckoutResourcePolicy({ route: async (pattern, callback) => {
    assert.equal(pattern, '**/*'); handler = callback;
  } });
  const actions = [];
  for (const url of ['https://www.googletagmanager.com/gtm.js', 'https://shop.funbox.com.tw/orders']) {
    await handler({ request: () => ({ url: () => url }), abort: async () => actions.push('abort'),
      fallback: async () => actions.push('fallback') });
  }
  assert.deepEqual(actions, ['abort', 'fallback']);
});
function ready() {
  const fields = Object.fromEntries(Object.entries(FUNBOX_CONTACT_FIELDS).map(([name, key]) => [name, [profile[key]]]));
  for (const [key, value] of Object.entries({ city: profile.city, district: profile.district,
    zip: profile.postalCode, address1: profile.address })) fields[`order[shipping_address_attributes][${key}]`] = [value];
  return { fields, paymentService: 'cyberbizpay_atm', paymentId: '1', shippingRate: '2', bonusUsed: '0' };
}

test('ATM 最終資料必須是正確付款、配送、完整購買人與收件人', () => {
  assert.doesNotThrow(() => assertFunboxAtmContactSnapshot(ready(), profile));
  for (const key of ['paymentService', 'paymentId', 'shippingRate']) {
    const snapshot = ready(); snapshot[key] = '';
    assert.throws(() => assertFunboxAtmContactSnapshot(snapshot, profile));
  }
  const wrongPayment = ready(); wrongPayment.paymentService = 'credit_card';
  assert.throws(() => assertFunboxAtmContactSnapshot(wrongPayment, profile));
  const hiddenBonus = ready(); hiddenBonus.bonusUsed = '258';
  assert.throws(() => assertFunboxAtmContactSnapshot(hiddenBonus, profile));
  const noBonus = ready(); delete noBonus.bonusUsed;
  assert.throws(() => assertFunboxAtmContactSnapshot(noBonus, profile));
  noBonus.bonusInputPresent = false;
  assert.doesNotThrow(() => assertFunboxAtmContactSnapshot(noBonus, profile));
  noBonus.bonusInputPresent = true;
  assert.throws(() => assertFunboxAtmContactSnapshot(noBonus, profile));
});

test('隱藏重複欄位與宅配地址不能不同；缺欄位不得默認成功', () => {
  for (const name of Object.keys(ready().fields)) {
    const missing = ready(); delete missing.fields[name];
    assert.throws(() => assertFunboxAtmContactSnapshot(missing, profile));
    const different = ready(); different.fields[name].push('舊資料');
    assert.throws(() => assertFunboxAtmContactSnapshot(different, profile));
  }
});

test('不完整收件設定停止，錯誤訊息不洩漏個資', () => {
  for (const key of Object.keys(profile)) assert.throws(() => validateFunboxDeliveryProfile({ ...profile, [key]: '' }));
  const snapshot = ready(); snapshot.fields['order[billing_address_attributes][phone]'] = ['0999999999'];
  assert.throws(() => assertFunboxAtmContactSnapshot(snapshot, profile), error =>
    !error.message.includes(profile.phone) && !error.message.includes('0999999999'));
});

test('已正確的宅配欄位不重填；選單等待選項而不是固定睡眠', async () => {
  const calls = [], values = {}, committed = [];
  const page = { locator(selector) {
    const name = selector.match(/^\[name="(.+)"\]:visible$/)[1];
    const key = FUNBOX_CONTACT_FIELDS[name];
    values[name] ??= profile[key];
    const locator = { first: () => locator, waitFor: async () => {}, inputValue: async () => values[name],
      evaluate: async () => values[name], focus: async () => {}, blur: async () => { committed.push(name); },
      fill: async value => { calls.push(['fill', name]); values[name] = value; },
      selectOption: async ({ label }) => { calls.push(['select', name]); values[name] = label; } };
    return locator;
  } };
  await fillFunboxHomeContact(page, profile);
  assert.deepEqual(calls, []);
  assert.deepEqual(committed, ['order[billing_address_attributes][phone]', 'order[shipping_address_attributes][phone]']);
  values['order[billing_address_attributes][city]'] = '舊縣市';
  values['order[billing_address_attributes][address1]'] = '舊地址';
  await fillFunboxHomeContact(page, profile);
  assert.deepEqual(calls.map(call => call[0]), ['select', 'fill']);
});

test('集中核對渲染品項：不以型號猜測、不調整數量、不容許外品', async () => {
  const expected = [{ product: { url: 'https://shop.funbox.com.tw/products/tm07807' }, quantity: 1 }];
  let rows = [{ url: '/products/tm07807', quantity: 1 }], evaluations = 0;
  const page = { waitForFunction: async () => {}, locator: () => ({ evaluateAll: async () => { evaluations++; return rows; } }) };
  assert.equal(await verifyFunboxRenderedCart(page, expected), 1);
  assert.equal(evaluations, 1);
  rows = [{ url: '/products/tm07807', quantity: 2 }];
  await assert.rejects(verifyFunboxRenderedCart(page, expected));
  rows = [{ url: '/products/tm07807-extra', quantity: 1 }];
  await assert.rejects(verifyFunboxRenderedCart(page, expected));
});

test('存圖 HTML 使用當前表單值，不拿 defaultValue／舊 selected 當作實際填寫結果', async () => {
  const priorDocument = globalThis.document;
  const attributes = [{ value: 'old', checked: '' }, {}, {}];
  const copies = attributes.map(attrs => ({ setAttribute: (key, value) => { attrs[key] = value; },
    removeAttribute: key => { delete attrs[key]; } }));
  const selected = [{ selected: '' }, {}];
  copies[1].options = selected.map(attrs => ({ setAttribute: (key, value) => { attrs[key] = value; },
    removeAttribute: key => { delete attrs[key]; } }));
  const originals = [{ tagName: 'INPUT', type: 'checkbox', value: 'new', checked: false },
    { tagName: 'SELECT', options: [{ selected: false }, { selected: true }] },
    { tagName: 'TEXTAREA', value: 'current' }];
  globalThis.document = { querySelectorAll: () => originals,
    documentElement: { cloneNode: () => ({ querySelectorAll: () => copies, outerHTML: '<html>copy</html>' }) } };
  try {
    const html = await captureFunboxCheckoutHtml({ evaluate: callback => callback() });
    assert.equal(html, '<!DOCTYPE html>\n<html>copy</html>');
    assert.deepEqual(attributes[0], { value: 'new' });
    assert.deepEqual(selected, [{}, { selected: '' }]);
    assert.equal(copies[2].textContent, 'current');
    assert.equal(originals[0].value, 'new');
  } finally { globalThis.document = priorDocument; }
});
