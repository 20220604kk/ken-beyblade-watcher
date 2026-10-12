import { readEsliteMemberDetail } from './eslite-account-setup.js';

const fail = message => new Error(message);
const fields = ['fee', 'main_island_fee', 'off_island_fee', 'free_shipping_amount', 'payment_codes'];
export function publicEslitePaymentChoices(body) {
  return {
    shipping_fee: body.shipping_fee && Object.fromEntries(Object.entries(body.shipping_fee).map(([key, value]) =>
      [key, Object.fromEntries(fields.filter(field => value?.[field] != null).map(field => [field, value[field]]))])),
    payment_prompt_texts: body.payment_prompt_texts || null,
    installments: body.installments || null
  };
}

export async function probeEslitePaymentChoices({ api, productId, expectedAccount, onStep = () => {} }) {
  if (!/^\d{15,25}$/.test(productId || '')) throw fail('測試商品識別格式不正確');
  let addDispatched = false, cartItemId = '', cleanupConfirmed = false;
  const calls = [], steps = [], result = { productId, orderSubmissions: 0, paymentSubmissions: 0 };
  const emit = label => { steps.push(label); onStep(label); };
  const get = async url => {
    calls.push({ method: 'GET', path: url.split('?')[0] });
    const response = await api.get(url, { timeout: 8000, maxRetries: 0 });
    try { if (!response.ok()) throw fail(`官方查詢未確認（HTTP ${response.status()}）`); return await response.json(); }
    finally { await response.dispose?.(); }
  };
  const cart = async () => {
    const body = await get('/api/v2/cart/items?type=shopping&step=1');
    if (!Array.isArray(body.cart?.cart_items)) throw fail('無法確認購物車內容，未變更');
    return body.cart.cart_items;
  };
  try {
    emit('01｜核對本帳號會員身分');
    // No credentials or member body are returned from this helper.
    const memberApi = { get: async (url, options) => {
      if (url !== '/api/v2/member_detail') throw fail('禁止非會員查詢');
      calls.push({ method: 'GET', path: url }); return api.get(url, options);
    } };
    await readEsliteMemberDetail(memberApi, { expectedAccount, timeoutMs: 8000 });
    emit('02｜確認原購物車為空');
    const original = await cart();
    if (original.length) return { ...result, status: 'skipped_existing_cart', originalItemCount: original.length, steps, calls, cleanupConfirmed: false, cartChanged: false };
    emit('03｜核對現貨商品');
    const stock = await get(`/api/v4/products/${productId}/purchase_status`);
    if (stock.product_guid && String(stock.product_guid) !== productId
      || !/^(?:add_to_shopping_cart|can_buy|in_stock|available|on_sale)$/i.test(stock.product_button_status || stock.button_status || stock.status || '')
      || stock.stock != null && Number(stock.stock) <= 0) throw fail('商品未確認現貨，不加入購物車');
    emit('04｜加入一件測試商品');
    addDispatched = true;
    calls.push({ method: 'POST', path: '/api/v2/cart/items' });
    let add;
    try {
      add = await api.post('/api/v2/cart/items', { data: { product_guid: productId, qty: 1, crosssell_items: [] }, timeout: 8000, maxRetries: 0 });
      if (!add.ok()) throw fail(`加車未確認（HTTP ${add.status()}），不重加`);
    } finally { await add?.dispose?.(); }
    const added = await cart();
    if (added.length !== 1 || String(added[0].product_guid || added[0].guid) !== productId || Number(added[0].qty ?? added[0].quantity) !== 1
      || !added[0].cart_item_id) throw fail('加入後購物車不符，停止讀取結帳契約');
    cartItemId = String(added[0].cart_item_id);
    emit('05｜讀取官方付款與配送選項（不送單）');
    result.choices = publicEslitePaymentChoices(await get('/api/v1/cart/payments_deliveries'));
    const quote = await get('/api/v2/cart/items?type=shopping&step=2');
    result.subtotal = Number(quote.cart?.total_amount) || null;
    result.status = 'choices_captured';
  } catch {
    result.status = 'probe_incomplete';
    result.detail = '官方探測未完整確認；未呼叫送單或付款，下一步只清理本次測試商品';
  } finally {
    if (addDispatched) {
      emit('06｜只移除本次測試商品');
      try {
        const current = await cart();
        const own = current.filter(row => String(row.product_guid || row.guid) === productId && Number(row.qty ?? row.quantity) === 1
          && row.cart_item_id && (!cartItemId || String(row.cart_item_id) === cartItemId || current.length === 1));
        if (own.length === 1) {
          cartItemId = String(own[0].cart_item_id);
          calls.push({ method: 'DELETE', path: '/api/v2/cart/items' });
          const deletion = await api.delete('/api/v2/cart/items', { data: { cart_item_id: own[0].cart_item_id }, timeout: 8000, maxRetries: 0 });
          try { if (!deletion.ok()) throw fail('測試商品移除未確認'); } finally { await deletion.dispose?.(); }
        } else if (current.some(row => String(row.product_guid || row.guid) === productId)) throw fail('測試商品數量或識別已改變，不擅自刪除');
        const after = await cart();
        cleanupConfirmed = !after.some(row => String(row.product_guid || row.guid) === productId);
        result.remainingOtherItems = after.length;
      } catch { cleanupConfirmed = false; }
      emit(cleanupConfirmed ? '07｜測試商品已移除；未送單、未付款' : '07｜清理結果待確認，暫停本帳號自動下單');
    }
    Object.assign(result, { steps, calls, cleanupConfirmed, cartChanged: addDispatched, ...(cartItemId ? { cartItemId } : {}) });
  }
  return result;
}

export async function cleanupEslitePaymentProbe({ api, hold, expectedAccount }) {
  if (hold?.scope !== 'cart_probe' || !/^\d{15,25}$/.test(hold.productId || '')) throw fail('沒有本帳號可核對的測試商品');
  await readEsliteMemberDetail(api, { expectedAccount, timeoutMs: 8000 });
  const read = async () => {
    const response = await api.get('/api/v2/cart/items?type=shopping&step=1', { timeout: 8000, maxRetries: 0 });
    try {
      if (!response.ok()) throw fail('清理前購物車尚未確認');
      const body = await response.json();
      if (!Array.isArray(body.cart?.cart_items)) throw fail('購物車格式尚未確認');
      return body.cart.cart_items;
    } finally { await response.dispose?.(); }
  };
  const items = await read(), own = items.filter(row => String(row.product_guid || row.guid) === hold.productId);
  if (own.length) {
    if (own.length !== 1 || Number(own[0].qty ?? own[0].quantity) !== 1 || !own[0].cart_item_id
      || items.length !== 1 && String(own[0].cart_item_id) !== hold.cartItemId) throw fail('測試商品數量或身分已改變，不擅自刪除');
    const response = await api.delete('/api/v2/cart/items', { data: { cart_item_id: own[0].cart_item_id }, timeout: 8000, maxRetries: 0 });
    try { if (!response.ok()) throw fail('測試商品移除未確認'); } finally { await response.dispose?.(); }
  }
  const after = await read();
  return { cleanupConfirmed: !after.some(row => String(row.product_guid || row.guid) === hold.productId), remainingOtherItems: after.length,
    orderSubmissions: 0, paymentSubmissions: 0, cartAdded: false };
}
