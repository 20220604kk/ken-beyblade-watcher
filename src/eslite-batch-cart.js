import { releaseResponse } from './api-response.js';
import { esliteAtmFallbackTemplate, esliteLinePayFallbackTemplate } from './eslite-account-setup.js';

const fail = (message, status = 'cart_conflict') => Object.assign(new Error(message), { purchaseStatus: status });
export async function fillEsliteBatchCart({ api, products, settings, readCart, timeoutForStep, checkpoint, now = Date.now }) {
  if (!products.length || new Set(products.map(p => p.id)).size !== products.length) throw fail('誠品合單任務為空或重複');
  const until = now() + (settings.batchBuildMs || 8000), expected = [], skipped = [];
  for (const product of products) {
    if (now() >= until) { skipped.push({ ...product, reason: 'batch_deferred' }); continue; }
    const quantity = Number(product.quantity);
    if (!product.id || !Number.isInteger(quantity) || quantity < 1) throw fail('誠品合單缺少商品或可確認數量');
    checkpoint('開始加車', `${product.title || product.id} ×${quantity}；本帳號依序加車`, 'start');
    let response, body, uncertain = false;
    try {
      response = await api.post('/api/v2/cart/items', { data: { product_guid: String(product.id), qty: quantity, crosssell_items: [] },
        timeout: timeoutForStep(Math.max(1, Math.min(5000, until - now()))) });
      try { body = await response.json(); } catch { uncertain = true; }
    } catch { uncertain = true; }
    finally { await releaseResponse(response); }
    if (response?.status() === 401) throw fail('誠品合單加車時登入失效', 'needs_login');
    if ([403, 429].includes(response?.status())) throw fail('誠品合單加車受限，停止本帳號', 'rate_limited');
    if (response && response.status() >= 500) uncertain = true;
    const reason = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
    const limited = /限購|已達.*上限|曾經購買|已購買過|purchase.*limit/i.test(reason);
    const unavailable = response && !uncertain && !response.ok() && (response.status() === 409 || limited || /售完|售罄|無庫存/.test(reason));
    if (unavailable && settings.batchAllowPartial) {
      skipped.push({ ...product, reason: limited ? 'purchase_limited' : 'stock_out' });
      checkpoint('排除不可購品項', `${product.title || product.id}；保留其他款`, 'info'); continue;
    }
    if (response && !uncertain && !response.ok()) throw fail(`誠品合單加車未接受（HTTP ${response.status()}）`, limited ? 'purchase_limited' : 'cart_conflict');
    if (String(body?.product_guid || '') !== String(product.id) || Number(body?.response_quantity ?? body?.request_quantity) !== quantity) uncertain = true;
    expected.push({ ...product, quantity });
    if (uncertain) {
      checkpoint('加車回應待核對', `${product.title || product.id}；只查車，不重加`, 'retry');
      assertEsliteBatchItems(await readCart('核對合單購物車'), expected);
    }
    checkpoint('加車確認', `${product.title || product.id} ×${quantity}`, 'success');
  }
  if (!expected.length) throw fail('誠品本批沒有可購商品，未送單', 'stock_out');
  if (skipped.length && !settings.batchAllowPartial) throw fail('誠品合單不允許缺款，未送單');
  assertEsliteBatchItems(await readCart('核對合單購物車'), expected);
  checkpoint('購物車封箱', `${expected.length} 款已核對；排除 ${skipped.length} 款，下一步核對配送、紅利與金額`, 'success');
  return { products: expected, skippedProducts: skipped, quantity: expected.reduce((sum, p) => sum + p.quantity, 0) };
}

export function assertEsliteBatchItems(items, products) {
  if (items.length !== products.length || !products.every(p => items.filter(row => String(row.product_guid || row.guid) === String(p.id)
    && Number(row.qty ?? row.quantity) === p.quantity).length === 1)) throw fail('誠品合單購物車的品項或數量不符，未送單');
}

export async function verifyEsliteBatchQuote({ api, checkout, maxTotal, timeoutForStep, requestedPayment, deliveryProfile, linePayPrimeProvider }) {
  const read = async url => {
    const response = await api.get(url, { timeout: timeoutForStep() });
    try {
      if (!response.ok()) throw fail('誠品合單配送／金額無法確認，未送單', 'precheckout_unavailable');
      return await response.json();
    } finally { await releaseResponse(response); }
  };
  const [cart, choices] = await Promise.all([read('/api/v2/cart/items?type=shopping&step=2'), read('/api/v1/cart/payments_deliveries')]);
  let paymentFallback;
  let delivery = choices.shipping_fee?.[checkout.delivery];
  if (!delivery?.payment_codes?.map(String).includes(String(checkout.payment)) && requestedPayment === 'seven_cod'
    && choices.shipping_fee?.['2']?.payment_codes?.map(String).includes('3')) {
    const fallback = esliteAtmFallbackTemplate({ checkout }, deliveryProfile, '官方本次購物車不提供 7-11 取貨付款');
    checkout = fallback.checkout; paymentFallback = fallback.paymentFallback;
    delivery = choices.shipping_fee['2'];
  }
  if (!delivery?.payment_codes?.map(String).includes(String(checkout.payment))) {
    const code = (Array.isArray(choices.payment_prompt_texts) ? choices.payment_prompt_texts : []).find(row => row.payment_type === 'pay_line')?.payment_type_id;
    const home = choices.shipping_fee?.['2'];
    if (!code || !home?.payment_codes?.map(String).includes(String(code))) throw fail('誠品合單未提供指定配送／付款，未送單', 'payment_unavailable');
    const subtotal = Number(cart.cart?.total_amount), fee = Number(home.main_island_fee), amount = subtotal + fee;
    if (!Number.isFinite(subtotal) || subtotal <= 0 || !Number.isFinite(fee) || fee < 0 || !Number.isFinite(amount)
      || !Number.isFinite(maxTotal) || amount > maxTotal) throw fail('LINE Pay 備援含運金額不明或超額，未送單');
    esliteAtmFallbackTemplate({ checkout }, deliveryProfile, '核對共用宅配資料');
    if (typeof linePayPrimeProvider !== 'function') throw fail('官方提供 LINE Pay，但尚未接通一次性付款憑證，未送單', 'needs_setup');
    let primeResult;
    try { primeResult = await linePayPrimeProvider({ timeoutMs: timeoutForStep(), paymentCode: String(code) }); }
    catch { throw fail('LINE Pay 一次性付款憑證取得未確認，未送單', 'needs_setup'); }
    const fallback = esliteLinePayFallbackTemplate({ paymentMode: requestedPayment, checkout }, deliveryProfile, code, primeResult);
    checkout = fallback.checkout; paymentFallback = fallback.paymentFallback; delivery = home;
  }
  const subtotal = Number(cart.cart?.total_amount), fee = Number(checkout.delivery === '2' ? delivery.main_island_fee : delivery.fee);
  const total = subtotal + fee;
  if (!Number.isFinite(subtotal) || subtotal <= 0 || !Number.isFinite(fee) || fee < 0 || !Number.isFinite(maxTotal) || total > maxTotal) throw fail('誠品合單含運金額不明或超過設定上限，未送單');
  return { subtotal, fee, total, ...(paymentFallback ? { checkout, payment: paymentFallback.to, paymentFallback } : {}) };
}
