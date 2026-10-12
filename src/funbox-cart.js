import { load } from 'cheerio';
import { readAndReleaseResponse } from './api-response.js';

const ORIGIN = 'https://shop.funbox.com.tw';
export class FunboxCartError extends Error {
  constructor(message, purchaseStatus = 'cart_conflict') {
    super(message);
    this.purchaseStatus = purchaseStatus;
  }
}

// Read JSON data emitted by the storefront, never execute site JavaScript.
function assignmentJson(source, name) {
  const match = new RegExp(`window\\.${name}\\s*=\\s*`).exec(source);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  if (!['[', '{'].includes(source[start])) throw new FunboxCartError('Funbox 購物車資料格式變更');
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      if (--depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); }
        catch { throw new FunboxCartError('Funbox 購物車 JSON 無法解析'); }
      }
    }
  }
  throw new FunboxCartError('Funbox 購物車 JSON 不完整');
}

export function parseFunboxCartHtml(html, url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.origin !== ORIGIN || !/^\/carts\/[a-z0-9]{32}\/?$/i.test(parsedUrl.pathname)) {
    throw new FunboxCartError('Funbox 未取得有效的目前購物車');
  }
  const dom = load(html);
  const source = dom('script:not([src])').toArray().map(node => dom(node).text()).join('\n');
  const rows = assignmentJson(source, 'lineItems');
  if (!Array.isArray(rows)) throw new FunboxCartError('Funbox 購物車缺少權威商品資料，不能視為空車');
  const items = rows.map(item => {
    const variantId = String(item.variant_id ?? '');
    const type = String(item.type ?? '');
    const collectionId = item.collection_id == null ? '' : String(item.collection_id);
    const quantity = Number(item.quantity);
    if (!/^\d+$/.test(variantId) || !/^[a-z-]+$/.test(type) || !/^\d*$/.test(collectionId)
      || !Number.isInteger(quantity) || quantity < 0) {
      throw new FunboxCartError('Funbox 購物車商品資料不合法，已停止變更');
    }
    return { variantId, type, collectionId, quantity, itemKey: `${variantId}_${type}_${collectionId}` };
  }).filter(item => item.quantity > 0);
  return { items, cartUrl: ORIGIN + parsedUrl.pathname,
    csrfToken: dom('meta[name="csrf-token"]').attr('content') || '', source: 'official_cart_html_json' };
}

// Follow only the official cart redirect chain. A current /cart -> home redirect
// is not sufficient alone. The observed empty redirect is /account/index and
// is accepted only after confirming the authenticated member page.
export async function readFunboxCart(context, { timeout = 5000 } = {}) {
  let url = ORIGIN + '/cart';
  let emptyRedirect = false;
  const visited = new Set();
  for (let hop = 0; hop < 4; hop++) {
    if (visited.has(url)) throw new FunboxCartError('Funbox 購物車重新導向循環');
    visited.add(url);
    const response = await context.request.get(url, { maxRedirects: 0, timeout,
      headers: { Accept: 'text/html', 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
    const status = response.status(), headers = response.headers();
    const body = await readAndReleaseResponse(response);
    if ([401, 403].includes(status)) throw new FunboxCartError('Funbox 購物車登入已失效', 'login_required');
    if ([429, 503].includes(status)) throw new FunboxCartError(`Funbox 購物車暫時忙碌（HTTP ${status}）`, 'rate_limited');
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (!headers.location) throw new FunboxCartError('Funbox 購物車重新導向缺少位址');
      const target = new URL(headers.location, url);
      if (target.origin !== ORIGIN) throw new FunboxCartError('Funbox 購物車重新導向至非官方網站');
      if (/^\/account\/login/i.test(target.pathname)) throw new FunboxCartError('Funbox 購物車需要重新登入', 'login_required');
      emptyRedirect = target.pathname === '/account/index' && !target.search;
      if (!emptyRedirect && !/^\/carts\/[a-z0-9]{32}\/?$/i.test(target.pathname)) throw new FunboxCartError('Funbox 購物車回傳未識別的重新導向');
      url = target.href;
      continue;
    }
    if (status !== 200) throw new FunboxCartError(`Funbox 購物車讀取失敗（HTTP ${status}）`);
    if (emptyRedirect) {
      const dom = load(body);
      const loggedIn = dom('a[href*="/account/logout"], form[action*="/account/logout"]').length > 0;
      if (!loggedIn) throw new FunboxCartError('Funbox 空車重新導向未確認登入，不能視為清車成功', 'login_required');
      return { items: [], cartUrl: '', csrfToken: '', source: 'official_empty_cart_redirect' };
    }
    return parseFunboxCartHtml(body, url);
  }
  throw new FunboxCartError('Funbox 購物車重新導向次數異常');
}

export async function clearFunboxCart(context, { timeout = 5000 } = {}) {
  const started = Date.now();
  const before = await readFunboxCart(context, { timeout });
  if (!before.items.length) return { cleared: true, removed: 0, passes: 0, durationMs: Date.now() - started,
    emptyCheckedAt: new Date().toISOString(), source: before.source };
  if (!before.csrfToken) throw new FunboxCartError('Funbox 購物車缺少 CSRF 憑證，不能清車');
  const updates = Object.fromEntries(before.items.map(item => [item.itemKey, 0]));
  let transportError;
  try {
    const response = await context.request.post(before.cartUrl + '/update_line_item', {
      data: { updates, is_remote: false, apply_maximun_bonus: false, bonus_used: 0 }, timeout,
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': before.csrfToken,
        Origin: ORIGIN, Referer: before.cartUrl }
    });
    const status = response.status();
    await readAndReleaseResponse(response);
    if ([401, 403].includes(status)) throw new FunboxCartError('Funbox 清車時登入失效', 'login_required');
    if ([429, 503].includes(status)) throw new FunboxCartError(`Funbox 清車暫時忙碌（HTTP ${status}）`, 'rate_limited');
    if (!response.ok()) throw new FunboxCartError(`Funbox 清車失敗（HTTP ${status}）`);
  } catch (error) {
    if (error instanceof FunboxCartError) throw error;
    // A timed-out mutation may still execute later. Even an apparently empty
    // reread cannot authorize adding here, or a late delete can erase new items.
    transportError = error;
  }
  const after = await readFunboxCart(context, { timeout });
  if (transportError) throw new FunboxCartError('Funbox 清車請求結果不明；本輪禁止加購，避免遲到刪除覆蓋新商品');
  if (after.items.length) throw new FunboxCartError(`Funbox 清車後仍有 ${after.items.length} 款，已停止加購`);
  return { cleared: true, removed: before.items.length, passes: 1, durationMs: Date.now() - started,
    emptyCheckedAt: new Date().toISOString(), source: after.source };
}

export function reconcileFunboxCart(snapshot, expected) {
  const purchased = snapshot.items.filter(item => item.type !== 'gift');
  const matched = [], missing = [];
  const expectedIds = new Set(expected.map(item => String(item.variantId || item.product.variantId)));
  if (expectedIds.size !== expected.length) throw new FunboxCartError('Funbox 本輪規格重複，已停止送單');
  for (const item of purchased) {
    if (item.type !== 'normal' || !expectedIds.has(item.variantId)) throw new FunboxCartError('Funbox 購物車混入非本輪商品，已停止送單');
  }
  for (const item of expected) {
    const rows = purchased.filter(row => row.variantId === String(item.variantId || item.product.variantId));
    if (!rows.length) { missing.push(item); continue; }
    if (rows.length !== 1 || rows[0].quantity !== item.quantity) throw new FunboxCartError(`Funbox「${item.product.title}」數量不符，已停止送單`);
    matched.push(item);
  }
  if (!matched.length) throw new FunboxCartError('Funbox 加購後沒有任何本輪商品，已停止送單');
  return { matched, missing };
}

export function assertFunboxCheckoutRows(rows, expected) {
  const signature = (url, quantity) => {
    const parsed = new URL(url, ORIGIN);
    if (parsed.origin !== ORIGIN || !/^\/products\/[^/]+\/?$/.test(parsed.pathname)) {
      throw new FunboxCartError('Funbox 最終購物車商品連結不合法');
    }
    return `${parsed.pathname.replace(/\/$/, '').toLowerCase()}|${Number(quantity)}`;
  };
  const actual = rows.map(row => signature(row.url, row.quantity)).sort();
  const wanted = expected.map(item => signature(item.product.url, item.quantity)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new FunboxCartError('Funbox 最終送單前品項或數量已改變，已停止送單');
  }
}
