// Offline foundation only. No browser, HTTP, Discord, credentials or order imports.
// Inputs below are OUR observation contract, not an asserted Shopee API schema.
const HOSTS = new Set(['shopee.tw', 'www.shopee.tw', 'm.shopee.tw']);
const EVIDENCE = new Set(['product-control', 'variant-data', 'unlisted-label', 'soldout-label']);
const ROUTES = Object.freeze({ 'shopee-funbox': 'public', 'shopee-mm': 'mmtoy', 'shopee-other': 'public' });

export function normalizeShopeeTitle(value) {
  return String(value ?? '').normalize('NFKC').replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ').trim();
}

export function shopeeModelCodes(title) {
  return [...new Set([...normalizeShopeeTitle(title).toUpperCase()
    .matchAll(/(?:BXG|BX|UX|CX)\s*-\s*\d{2}(?!\d)/g)]
    .map(([code]) => code.replace(/\s/g, '')))];
}

export function shopeeProductIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password) return null;
    const match = url.pathname.match(/^\/product\/([1-9]\d*)\/([1-9]\d*)\/?$/)
      || url.pathname.match(/-i\.([1-9]\d*)\.([1-9]\d*)\/?$/);
    if (!match) return null;
    const [, shopId, itemId] = match;
    return { shopId, itemId, productUrl: `https://shopee.tw/product/${shopId}/${itemId}` };
  } catch { return null; }
}

export function classifyShopeeAccess({ finalUrl = '', httpStatus, visibleText = '' } = {}) {
  let path = '';
  try { path = new URL(finalUrl).pathname; } catch { /* No observed URL yet. */ }
  if (httpStatus === 429) return 'rate-limited';
  const text = String(visibleText).replace(/\s+/g, ' ');
  if (httpStatus === 403 || /^\/verify\/captcha(?:\/|$)/i.test(path)
    || /頁面無法顯示|流量驗證|請滑動以完成拼圖|安全性驗證|驗證目前無法完成/.test(text)) return 'blocked';
  // Shopee also serves an explicit login-required page under /verify/traffic/error.
  // Use its observed message, never a query flag or a generic header login link.
  if (httpStatus === 401 || /^\/(?:buyer\/)?login(?:\/|$)/i.test(path)
    || (path === '/verify/traffic/error' && /看起來您尚未登入[。.]?\s*請登入以繼續/.test(text))) return 'auth-required';
  if (/^\/verify(?:\/|$)/i.test(path)) return 'blocked';
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) return 'read-error';
  // HTTP success is not parser success. Caller must validate actual items/empty evidence.
  return 'unverified-content';
}

function positiveId(value) {
  // Reject unsafe JS numbers; product IDs are persisted as strings.
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? '');
  return /^[1-9]\d*$/.test(id) ? id : null;
}

function validSource(source) {
  return source && Object.hasOwn(ROUTES, source.id)
    && source.shopIdVerified === true && positiveId(source.shopId);
}

function normalizeCandidate(raw, source) {
  const identity = shopeeProductIdentity(raw.productUrl);
  if (!identity || identity.shopId !== String(source.shopId)) return { error: 'wrong-shop-or-url' };
  if ((raw.itemId != null && String(raw.itemId) !== identity.itemId)
    || (raw.shopId != null && String(raw.shopId) !== identity.shopId)) return { error: 'identity-conflict' };
  const title = normalizeShopeeTitle(raw.title);
  if (!title) return { error: 'missing-title' };
  const models = shopeeModelCodes(title);
  const relevant = /BEYBLADE|戰鬥陀螺/i.test(title) || models.length > 0;
  const excluded = /FUNKO|漫畫|貼紙|吊飾|鑰匙圈|紙陀螺/i.test(title);
  if (!relevant || excluded) return { ignored: true };
  const modelId = raw.modelId == null ? null : positiveId(raw.modelId);
  if (raw.modelId != null && !modelId) return { error: 'invalid-model-id' };
  let availability = ['available', 'unavailable'].includes(raw.availability)
    && EVIDENCE.has(raw.availabilityEvidence) ? raw.availability : 'unknown';
  if ((raw.availabilityEvidence === 'unlisted-label' || raw.availabilityEvidence === 'soldout-label')
    && availability === 'available') availability = 'unknown';
  let quantity = Number.isSafeInteger(raw.quantity) && raw.quantity >= 0
    && raw.quantityEvidence === 'observed-count'
    && ((raw.quantityScope === 'product-total' && !modelId) || (raw.quantityScope === 'selected-model' && modelId))
    ? raw.quantity : null;
  if ((quantity === 0 && availability === 'available') || (quantity > 0 && availability === 'unavailable')) {
    quantity = null;
    availability = 'unknown';
  }
  return { product: {
    ...identity, modelId, title, models,
    key: `shopee:TW:${identity.shopId}:${identity.itemId}${modelId ? `:${modelId}` : ''}`,
    modelName: modelId ? normalizeShopeeTitle(raw.modelName) : null,
    availability,
    availabilityEvidence: availability === 'unknown' ? null : raw.availabilityEvidence,
    quantity,
    quantityScope: quantity === null ? 'unknown' : raw.quantityScope,
    priceTwd: raw.priceKind === 'exact' && Number.isFinite(raw.priceTwd) && raw.priceTwd >= 0 ? raw.priceTwd : null
  } };
}

export function parseShopeeObservation(input, source) {
  const rejected = (health, reason) => ({ health, reason, products: [], baselineWritable: false });
  if (!validSource(source)) return rejected('configuration-error', 'shop-identity-not-verified');
  const access = classifyShopeeAccess(input);
  if (access !== 'unverified-content') return rejected(access, access);
  try {
    const finalUrl = new URL(input.finalUrl);
    if (finalUrl.protocol !== 'https:' || !HOSTS.has(finalUrl.hostname) || finalUrl.username || finalUrl.password) {
      return rejected('parse-error', 'unexpected-final-origin');
    }
  } catch { return rejected('parse-error', 'unexpected-final-origin'); }
  if (!Number.isFinite(Date.parse(input.observedAt)) || !input.scopeId || !Array.isArray(input.items)) {
    return rejected('parse-error', 'invalid-observation-contract');
  }
  const products = [];
  let ignored = 0;
  const seen = new Set();
  for (const item of input.items) {
    const result = normalizeCandidate(item, source);
    // Invalid/cross-shop rows must never make a result count as a complete empty shop.
    if (result.error) return rejected('parse-error', result.error);
    if (result.ignored) { ignored += 1; continue; }
    if (seen.has(result.product.key)) return rejected('parse-error', 'duplicate-product-key');
    seen.add(result.product.key);
    products.push(result.product);
  }
  if (!input.items.length && !(input.emptyResultVerified === true && input.coverage === 'complete')) {
    return rejected('parse-error', 'empty-without-evidence');
  }
  return {
    health: 'ready', reason: null, products, ignored, baselineWritable: true,
    sourceId: source.id, shopId: String(source.shopId), observedAt: new Date(input.observedAt).toISOString(),
    scopeId: input.scopeId, coverage: input.coverage === 'complete' ? 'complete' : 'partial'
  };
}

export function createShopeeState(source) {
  if (!validSource(source)) throw new Error('Verified Shopee shop identity required');
  return { schemaVersion: 1, sourceId: source.id, shopId: String(source.shopId),
    initialized: false, sequence: 0, lastPrimaryAt: null, lastObservedAt: null, records: {} };
}

// Pure reducer: caller is responsible for atomic state/event persistence in a future worker.
// Only the primary search's COMPLETE snapshots can establish search absence.
export function reduceShopeeObservation(previous, observation, source, { primaryScope = 'search:beyblade' } = {}) {
  if (!validSource(source) || previous.sourceId !== source.id || previous.shopId !== String(source.shopId)) {
    throw new Error('State/source identity mismatch');
  }
  if (!observation.baselineWritable || observation.health !== 'ready') {
    return { state: previous, events: [], ignoredReason: observation.reason || observation.health };
  }
  if (observation.sourceId !== source.id || observation.shopId !== previous.shopId) throw new Error('Observation/source mismatch');
  const time = Date.parse(observation.observedAt);
  // Reject out-of-order observations, rather than letting delayed pages restore stale stock.
  if (!Number.isFinite(time) || (previous.lastObservedAt && time <= Date.parse(previous.lastObservedAt))) {
    return { state: previous, events: [], ignoredReason: 'stale-observation' };
  }
  const state = structuredClone(previous);
  const events = [];
  const primary = observation.scopeId === primaryScope;
  const fullPrimary = primary && observation.coverage === 'complete';
  const currentKeys = new Set(observation.products.map(p => p.key));
  const emit = (kind, product) => {
    state.sequence += 1;
    events.push({ eventId: `${source.id}:${state.sequence}`, sourceId: source.id, kind,
      observedAt: observation.observedAt, product: structuredClone(product) });
  };
  for (const product of observation.products) {
    const old = state.records[product.key];
    let kind = null;
    if (state.initialized) {
      if (!old) kind = 'first-seen';
      else if (primary && old.primaryVisibility === 'missing') kind = 'reappeared';
      else if (product.availability === 'available' && old.lastKnownAvailability === 'unavailable') kind = 'restock';
      else if (product.availability === 'available' && old.pendingVisibilityConfirmation) kind = 'availability-confirmed';
      else if (product.availability === 'available' && old.lastKnownAvailability === 'unknown') kind = 'availability-confirmed';
    }
    if (kind) emit(kind, product);
    state.records[product.key] = {
      ...product, lastSeenAt: observation.observedAt,
      primaryVisibility: primary ? 'visible' : old?.primaryVisibility || 'unknown',
      pendingVisibilityConfirmation: product.availability === 'unknown'
        && (['first-seen', 'reappeared'].includes(kind) || old?.pendingVisibilityConfirmation === true),
      lastKnownAvailability: product.availability === 'unknown'
        ? old?.lastKnownAvailability || 'unknown' : product.availability
    };
  }
  if (fullPrimary) {
    for (const [key, record] of Object.entries(state.records)) {
      // Listing membership is item-level. A list without model details cannot remove its models.
      if (record.primaryVisibility === 'visible' && !currentKeys.has(key)
        && !observation.products.some(p => p.itemId === record.itemId)) record.primaryVisibility = 'missing';
    }
    state.initialized = true;
    state.lastPrimaryAt = observation.observedAt;
  }
  state.lastObservedAt = observation.observedAt;
  return { state, events, ignoredReason: null };
}

export function previewShopeeNotification(event, { test = true } = {}) {
  if (!Object.hasOwn(ROUTES, event.sourceId)) throw new Error('Unknown notification source; no public fallback');
  if (!['first-seen', 'reappeared', 'restock', 'availability-confirmed'].includes(event.kind)) return null;
  // 新商品出現在賣場本身就是有價值的情報，即使商品頁當下已售罄，也要
  // 清楚標示「目前不可購」後通知。補貨類事件則仍必須有明確可購證據，
  // 未知狀態也一律等待商品直查確認，避免把列表可見誤報成補貨。
  const discovery = ['first-seen', 'reappeared'].includes(event.kind);
  if (event.product.availability === 'unknown') return null;
  if (!discovery && event.product.availability !== 'available') return null;
  const names = { 'shopee-mm': 'MM小舖・蝦皮', 'shopee-funbox': 'FUNBOX旗艦館・蝦皮', 'shopee-other': '蝦皮賣場' };
  const labels = { 'first-seen': '首次發現商品', reappeared: '商品重新出現', restock: '恢復可購', 'availability-confirmed': '已確認可購' };
  const p = event.product;
  const identity = shopeeProductIdentity(p.productUrl);
  if (!identity || identity.shopId !== p.shopId || identity.itemId !== p.itemId) throw new Error('Invalid notification product URL');
  const status = p.availability === 'available'
    ? `已確認可購｜${p.quantity === null ? '數量未公開' : `前台可售 ${p.quantity} 組`}`
    : p.availability === 'unavailable' ? '目前不可購' : '可購狀態待確認';
  return { audience: test ? 'private' : ROUTES[event.sourceId], eventId: event.eventId,
    content: [`${test ? '🧪 模擬測試｜' : ''}${names[event.sourceId]}｜${labels[event.kind]}`,
      p.title, ...(p.modelName ? [`規格：${p.modelName}`] : []), status, identity.productUrl].join('\n') };
}
