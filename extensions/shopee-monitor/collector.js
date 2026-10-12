// Runs in Chrome's isolated world. DOM only: never read credentials, cookies,
// localStorage, application state, network APIs or the user's shopping cart.
export function collectShopeeDom(plan) {
  const finalUrl = location.href;
  const visible = (e, depth = 0) => {
    if (!e || depth > 6) return false;
    const style = getComputedStyle(e);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    // Shopee's product link uses display:contents: the anchor has no box,
    // while its flex child is visibly rendered. Zero anchor rects is not hidden.
    return Boolean(e.getClientRects().length) || (style.display === 'contents' && [...e.children].some(child => visible(child, depth + 1)));
  };
  const accessMessages = ['看起來您尚未登入。請登入以繼續', '驗證目前無法完成', '頁面無法顯示', '流量驗證', '請滑動以完成拼圖', '安全性驗證'];
  const pageText = document.body?.innerText || '';
  const accessText = accessMessages.find(s => pageText.replace(/\s+/g, '').includes(s.replace(/\s+/g, ''))) || '';
  const profile = [...document.querySelectorAll('img[alt="profile"]')].some(e => visible(e) && e.closest('button,[role="button"]'));
  const loginLink = [...document.querySelectorAll('a[href]')].some(e => visible(e) && /\/buyer\/login/.test(e.getAttribute('href') || '') && /登入/.test(e.innerText));
  const loginState = /\/verify\/|\/buyer\/login/.test(location.pathname) || accessText ? 'unknown' : profile ? 'logged-in' : loginLink ? 'logged-out' : 'unknown';
  const identity = value => {
    try { const u = new URL(value, location.origin); const m = u.pathname.match(/^\/product\/(\d+)\/(\d+)\/?$/) || u.pathname.match(/-i\.(\d+)\.(\d+)\/?$/);
      return u.hostname === 'shopee.tw' && m && m[1] === plan.shopId ? { productUrl: `https://shopee.tw/product/${m[1]}/${m[2]}`, itemId: m[2] } : null;
    } catch { return null; }
  };
  if (accessText || /\/verify\/|\/buyer\/login/.test(location.pathname)) return {finalUrl, accessText, loginState, rendered:false, items:[]};
  const items = [], seen = new Set();
  if (plan.kind === 'search') {
    const links = [...document.querySelectorAll('a[aria-label^="View product:"]')];
    const diagnostics = { readyState:document.readyState, cardLinkCount:links.length, visibleCardCount:0 };
    // Observed on the logged-in FUNBOX store search, 2026-09-04.
    for (const a of links) {
      const id = identity(a.href); if (!id || seen.has(id.itemId) || !visible(a)) continue;
      diagnostics.visibleCardCount += 1;
      const title = a.getAttribute('aria-label').replace(/^View product:\s*/, '').replace(/\s+/g, ' ').trim();
      if (!title) continue; seen.add(id.itemId);
      const text = a.innerText || '';
      const unavailable = /未上架|已售完|已售罄|售完|售罄/.test(text);
      items.push({...id, title, availability:unavailable ? 'unavailable' : 'unknown', availabilityEvidence:unavailable ? 'unlisted-label' : null});
    }
    return {finalUrl, accessText, loginState, rendered:items.length > 0, items, diagnostics};
  }
  const id = identity(finalUrl);
  const heading = [...document.querySelectorAll('h1')].find(e => visible(e));
  if (id && heading) {
    // Confine stock labels to the main product region, not recommendations.
    const title = heading.innerText.replace(/\s+/g, ' ').trim();
    const controls = [...document.querySelectorAll('button')].filter(e => visible(e) && /^(加入購物車|直接購買|立即購買)$/.test(e.innerText.trim()));
    const enabled = controls.some(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true');
    // Unknown unless there are actual enabled product purchase controls. A sold
    // count or a search result is never treated as available inventory.
    items.push({...id, title, availability:enabled ? 'available' : 'unknown', availabilityEvidence:enabled ? 'product-control' : null});
  }
  return {finalUrl, accessText, loginState, rendered:items.length === 1, items};
}

// A small, read-only product probe.  It intentionally uses the browser's
// existing Shopee context without reading/exporting cookies and never calls a
// cart or checkout endpoint.  Product probes are kept sequential so a target
// with several known item IDs cannot create a request burst.
export async function collectShopeePdp(plan) {
  const finalUrl = plan.url;
  const browserUrl = location.href;
  const probes = Array.isArray(plan.probeProducts) ? plan.probeProducts.slice(0, 24) : [];
  const items = [];
  let successCount = 0;
  let failureCount = 0;
  let strongestStatus = 0;
  let errorCode = null;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index] || {};
    const shopId = String(probe.shopId || plan.shopId || '');
    const itemId = String(probe.itemId || '');
    if (!/^[1-9]\d*$/.test(shopId) || !/^[1-9]\d*$/.test(itemId) || shopId !== String(plan.shopId)) {
      failureCount += 1;
      continue;
    }
    try {
      const query = new URLSearchParams({ item_id: itemId, shop_id: shopId });
      const response = await fetch(`/api/v4/pdp/get_pc?${query}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      strongestStatus = Math.max(strongestStatus, response.status);
      let payload = null;
      try { payload = await response.json(); } catch { /* Invalid JSON is a read error, never stock zero. */ }
      const item = payload?.data?.item;
      if (!response.ok || payload?.error || !item
        || String(item.item_id || '') !== itemId || String(item.shop_id || '') !== shopId
        || !String(item.title || '').trim()) {
        errorCode ||= payload?.error || response.status || 'invalid-product-response';
        failureCount += 1;
        continue;
      }
      const models = Array.isArray(item.models) ? item.models : [];
      const stockValues = [item.stock, item.normal_stock, ...models.flatMap(model => [model.stock, model.normal_stock])]
        .filter(value => Number.isFinite(value) && value >= 0);
      const quantity = stockValues.length ? Math.max(...stockValues) : null;
      const available = item.has_model_with_available_shopee_stock === true
        || stockValues.some(value => value > 0);
      const unavailable = item.is_unavailable === true
        || item.has_model_with_available_shopee_stock === false
        || (item.item_status && item.item_status !== 'normal')
        || Number(item.status) === 8;
      const availability = available ? 'available' : unavailable ? 'unavailable' : 'unknown';
      items.push({
        productUrl: `https://shopee.tw/product/${shopId}/${itemId}`,
        shopId,
        itemId,
        title: String(item.title).replace(/\s+/g, ' ').trim(),
        availability,
        availabilityEvidence: availability === 'available' ? 'variant-data'
          : availability === 'unavailable' ? 'soldout-label' : null,
        quantity,
        quantityScope: quantity === null ? 'unknown' : 'item'
      });
      successCount += 1;
    } catch (error) {
      errorCode ||= error?.name === 'TimeoutError' ? 'timeout' : 'fetch-failed';
      failureCount += 1;
    }
    if (index + 1 < probes.length) await pause(120);
  }
  const pageText = document.body?.innerText || '';
  const challengeText = ['驗證目前無法完成', '流量驗證', '請滑動以完成拼圖', '安全性驗證']
    .find(text => pageText.replace(/\s+/g, '').includes(text.replace(/\s+/g, ''))) || '';
  const httpStatus = successCount > 0 ? 200
    : strongestStatus === 429 ? 429 : strongestStatus === 403 ? 403 : undefined;
  return {
    finalUrl,
    browserUrl,
    transport: 'pdp-api',
    mode: 'probe',
    httpStatus,
    rendered: successCount > 0,
    items,
    loginState: challengeText ? 'unknown' : 'logged-in',
    accessText: successCount > 0 ? '' : challengeText || String(errorCode || ''),
    diagnostics: { apiSuccessCount: successCount, apiFailureCount: failureCount, apiErrorCode: errorCode }
  };
}
