import * as cheerio from 'cheerio';
import { sendNotification } from './notifier.js';

export const FUNBOX_BEYBLADE_PAGE_URL =
  'https://shop.funbox.com.tw/categories/takaratomy/beyblade';
export const FUNBOX_BEYBLADE_URL =
  'https://shop.funbox.com.tw/category_products/takaratomy/beyblade.json?limit=100&page=1&sort_by=sell_from-desc';
export const FUNBOX_BEYBLADE_COLLECTION_PRODUCTS_URL =
  'https://shop.funbox.com.tw/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA/products.json';
export const FUNBOX_BEYBLADE_SEARCH_API_URL =
  'https://shop.funbox.com.tw/search/search.json';
export const FUNBOX_BEYBLADE_SEARCH_BODY =
  'q=beyblade&per=10&page=1&sort_by=sell_from-desc&type=product';
export const FUNBOX_BEYBLADE_SOURCES = [
  { id: 'category', label: '分類 API', url: FUNBOX_BEYBLADE_URL, intervalMs: 9000 },
  { id: 'collection', label: '集合頁 API', url: FUNBOX_BEYBLADE_COLLECTION_PRODUCTS_URL, intervalMs: 9000 },
  {
    id: 'search',
    label: '搜尋 API 快線',
    url: FUNBOX_BEYBLADE_SEARCH_API_URL,
    method: 'POST',
    body: FUNBOX_BEYBLADE_SEARCH_BODY,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest'
    },
    intervalMs: 3000,
    timeoutMs: 1800
  }
];
export const FUNBOX_SOURCE_TIMEOUT_MS = 3000;
export const FUNBOX_PRODUCT_HYDRATION_TIMEOUT_MS = 1200;

const FUNBOX_CHALLENGE_WORDS = /(?:Retry later|Too Many Requests|請稍後再試|請勿關閉此頁面|驗證目前無法完成|toomany|Icon-Carts-Loading)/i;

function absoluteUrl(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return '';
  }
}

export function canonicalFunboxProductId(productUrl, explicitId = '') {
  try {
    const slug = new URL(productUrl).pathname.match(/\/products\/([^/?#]+)/)?.[1];
    if (slug) return decodeURIComponent(slug).trim().toLowerCase();
  } catch {
    // Fall back to the upstream id only when the product URL is unavailable.
  }
  return String(explicitId || productUrl || '').trim();
}

function productKey(productUrl, explicitId) {
  return canonicalFunboxProductId(productUrl, explicitId);
}

export function shouldSkipFunboxProduct(product) {
  return String(product?.title || '').toUpperCase().includes('APP');
}

export function funboxSkipReason(product) {
  return shouldSkipFunboxProduct(product) ? '命中 APP 兌換商品排除規則' : '';
}

export function parseFunboxProducts(html, pageUrl = FUNBOX_BEYBLADE_URL) {
  const $ = cheerio.load(html);
  const products = [];
  const seen = new Set();

  $('.product').each((_, card) => {
    const anchor = $(card).find('a.productClick[href*="/products/"]').first();
    if (!anchor.length) return;

    const url = absoluteUrl(anchor.attr('href'), pageUrl);
    const id = productKey(url, anchor.attr('data-id') || $(card).find('[data-id]').first().attr('data-id'));
    if (!id || seen.has(id)) return;

    const image = $(card).find('img').first();
    const title = (
      anchor.attr('data-name')
      || image.attr('alt')
      || $(card).find('.product_title, .product-title').first().text()
    ).trim().replace(/\s+/g, ' ');
    if (!title) return;

    const rawPrice = (
      anchor.attr('data-price')
      || $(card).find('.product_price, .product-price').first().text()
    ).trim().replace(/\s+/g, ' ');
    const buttonText = (
      $(card).find('.product_btn, .product-btn').first().text()
      || $(card).find('button').first().text()
    ).trim().replace(/\s+/g, ' ');
    const soldOut = /售完|缺貨|補貨中/.test(buttonText);
    const rawStock = (
      anchor.attr('data-stock')
      || $(card).find('[data-stock]').first().attr('data-stock')
      || ''
    ).trim();
    const stock = /^\d+$/.test(rawStock) ? Number(rawStock) : null;

    seen.add(id);
    products.push({
      id,
      sourceProductId: String(
        anchor.attr('data-id') || $(card).find('[data-id]').first().attr('data-id') || ''
      ),
      title,
      url,
      price: rawPrice,
      imageUrl: absoluteUrl(image.attr('data-src') || image.attr('src'), pageUrl),
      stock,
      available: !soldOut,
      availabilityText: buttonText || (soldOut ? '缺貨' : '')
    });
  });

  return products;
}

function formatPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value || '').trim();
  return `NT$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(amount)}`;
}

export function parseFunboxProductData(input, pageUrl = FUNBOX_BEYBLADE_PAGE_URL) {
  const rawProducts = Array.isArray(input) ? input : Array.isArray(input?.products) ? input.products : [];
  return rawProducts.map((item) => {
    const variants = Array.isArray(item?.variants) ? item.variants : [];
    const parsedVariants = variants.map((variant) => {
      const stock = Number(variant?.inventory_quantity);
      const quantity = Number.isFinite(stock) ? Math.max(0, stock) : null;
      const available = quantity === null
        ? String(variant?.inventory_policy || '') !== 'deny'
        : quantity > 0 || String(variant?.inventory_policy || '') !== 'deny';
      // Cyberbiz 的 `qc` 在 Funbox 商品 JSON 是商品條碼／識別碼，
      // 不是限購量。把它當成數量上限會造成補貨數與下單數判斷失真。
      const rawCap = Number(
        variant?.max_order_quantity
        ?? variant?.quantity_limit
        ?? variant?.purchase_limit
      );
      return {
        id: variant?.id === null || variant?.id === undefined ? null : String(variant.id),
        title: String(variant?.title || variant?.name || '').trim(),
        stock: quantity,
        available,
        qtyCap: Number.isFinite(rawCap) && rawCap > 0 ? rawCap : null
      };
    });
    const quantities = variants
      .map((variant) => Number(variant?.inventory_quantity))
      .filter(Number.isFinite);
    const stock = quantities.length ? quantities.reduce((total, value) => total + Math.max(0, value), 0) : null;
    const available = variants.length
      ? variants.some((variant) =>
          Number(variant?.inventory_quantity) > 0 || String(variant?.inventory_policy || '') !== 'deny'
        )
      : stock === null || stock > 0;
    const url = absoluteUrl(item?.url, pageUrl);
    const id = productKey(url, item?.id);
    const title = String(item?.title || '').trim().replace(/\s+/g, ' ');
    if (!id || !title || !url) return null;
    const purchasableVariant = parsedVariants.find((variant) => variant.available && variant.id)
      || parsedVariants.find((variant) => variant.id)
      || null;
    return {
      id,
      sourceProductId: item?.id === null || item?.id === undefined ? '' : String(item.id),
      title,
      url,
      price: formatPrice(item?.price),
      imageUrl: absoluteUrl(item?.photo, pageUrl),
      stock,
      available,
      availabilityText: available ? (stock === 0 ? '可預購' : '有貨') : '缺貨',
      stockSource: stock === null ? '' : 'funbox_frontend_api',
      variants: parsedVariants,
      variantId: purchasableVariant?.id || null,
      qtyCap: purchasableVariant?.qtyCap || null
    };
  }).filter(Boolean);
}

export function parseFunboxSearchData(input, pageUrl = FUNBOX_BEYBLADE_SEARCH_API_URL) {
  const products = Array.isArray(input?.products?.result) ? input.products.result : [];
  return parseFunboxProductData(products.map((item) => ({
    ...item,
    url: item?.url || (item?.handle ? `/products/${item.handle}` : ''),
    photo: item?.photo
      || item?.featured_image?.medium
      || item?.featured_image?.large
      || item?.photo_urls?.[0]
      || '',
    price: item?.price ?? item?.variants?.[0]?.price
  })), pageUrl);
}

export function parseFunboxResponse(body, pageUrl = FUNBOX_BEYBLADE_URL) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data?.products?.result)) return parseFunboxSearchData(data, pageUrl);
      return parseFunboxProductData(data, pageUrl);
    } catch {
      // 本機測試頁使用 HTML，由下方的既有解析器處理。
    }
  }
  return parseFunboxProducts(text, pageUrl);
}

export function validateFunboxSourceBody(body, sourceUrl = FUNBOX_BEYBLADE_URL) {
  const text = String(body || '').trim();
  if (!text) throw new Error('Funbox 回傳空白內容');
  if (FUNBOX_CHALLENGE_WORDS.test(text)) {
    throw new Error('Funbox HTTP 200 但回傳驗證／等待頁');
  }
  if (/\.json(?:\?|$)/i.test(String(sourceUrl || '')) && !/^[\[{]/.test(text)) {
    throw new Error('Funbox JSON API 回傳非商品資料');
  }
  return text;
}

function mergeFunboxProduct(current, incoming) {
  if (!current) return { ...incoming };
  const currentStock = Number(current.stock);
  const incomingStock = Number(incoming.stock);
  const currentHasStock = Number.isFinite(currentStock);
  const incomingHasStock = Number.isFinite(incomingStock);
  const preferIncoming = Number(incoming.observedAtMs || 0) >= Number(current.observedAtMs || 0)
    || incoming.available === true && current.available !== true;
  const preferred = preferIncoming ? incoming : current;
  const fallback = preferIncoming ? current : incoming;
  return {
    ...fallback,
    ...preferred,
    available: current.available === true || incoming.available === true,
    // The two endpoints can return different snapshots during a busy sale.  The
    // newest response is safer than the old "maximum stock wins" rule, which
    // overstated inventory while units were being sold.
    stock: preferIncoming
      ? (incomingHasStock ? incomingStock : currentHasStock ? currentStock : null)
      : (currentHasStock ? currentStock : incomingHasStock ? incomingStock : null),
    sourceIds: [...new Set([...(current.sourceIds || []), ...(incoming.sourceIds || [])])],
    sourceProductIds: [...new Set([
      ...(current.sourceProductIds || []),
      ...(incoming.sourceProductIds || []),
      current.sourceProductId,
      incoming.sourceProductId
    ].filter(Boolean).map(String))]
  };
}

export function mergeFunboxProductSources(sourceResults = []) {
  const merged = new Map();
  for (const source of sourceResults) {
    for (const product of source.products || []) {
      const id = canonicalFunboxProductId(product.url, product.id);
      merged.set(id, mergeFunboxProduct(merged.get(id), {
        ...product,
        id,
        sourceIds: [...new Set([...(product.sourceIds || []), source.id].filter(Boolean))]
      }));
    }
  }
  return [...merged.values()];
}

function mergeSeenRecord(current, incoming) {
  if (!current) return { ...incoming };
  const currentTime = Date.parse(current.lastSeenAt || current.firstSeenAt || '') || 0;
  const incomingTime = Date.parse(incoming.lastSeenAt || incoming.firstSeenAt || '') || 0;
  const newest = incomingTime >= currentTime ? incoming : current;
  const older = newest === incoming ? current : incoming;
  const firstSeenAt = [current.firstSeenAt, incoming.firstSeenAt]
    .filter(Boolean)
    .sort()[0];
  const lastSeenAt = [current.lastSeenAt, incoming.lastSeenAt]
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    ...older,
    ...newest,
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    notificationId: newest.notificationId || older.notificationId
  };
}

export function migrateFunboxSeenRecords(seen = {}) {
  const migrated = {};
  for (const [legacyId, record] of Object.entries(seen || {})) {
    const id = canonicalFunboxProductId(record?.url, legacyId);
    if (!id) continue;
    migrated[id] = mergeSeenRecord(migrated[id], record || {});
  }
  return migrated;
}

function compactNotificationText(value, maxLength = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function funboxProductLabel(product, maxLength = 48) {
  const title = compactNotificationText(product.title || 'Funbox 商品', 160);
  const model = title.match(/\b(?:BX|CX|UX)-\d+\b/i);
  const focusedTitle = model ? title.slice(model.index) : title;
  return compactNotificationText(focusedTitle, maxLength);
}

function funboxPriceLabel(price) {
  const value = String(price || '').trim();
  if (!value) return '';
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return `NT$${Number(value).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}`;
  }
  return value;
}

function funboxSimulationUrl(value, fallback, label) {
  const candidate = String(value || '').trim() || fallback;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label}必須是完整的 http 或 https 網址`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label}只接受 http 或 https 網址`);
  }
  return parsed.toString();
}

export function normalizeFunboxSimulationProduct(input = {}) {
  const title = compactNotificationText(
    input.title || 'BEYBLADE X 戰鬥陀螺 UX-16 時鐘幻象',
    120
  );
  const price = compactNotificationText(input.price || 'NT$350', 32);
  const stockValue = input.stock === '' || input.stock === null || input.stock === undefined
    ? 50
    : Number(input.stock);
  if (!Number.isFinite(stockValue) || stockValue < 0 || stockValue > 99999) {
    throw new Error('模擬庫存必須是 0～99999 的數字');
  }
  const url = funboxSimulationUrl(
    input.targetUrl || input.url,
    'https://shop.funbox.com.tw/categories/takaratomy/beyblade',
    '點擊目的地'
  );
  const imageUrl = String(input.imageUrl || '').trim()
    ? funboxSimulationUrl(input.imageUrl, '', '圖片')
    : '';
  return {
    id: 'simulation-funbox-custom',
    title,
    url,
    price,
    stock: Math.trunc(stockValue),
    availabilityText: '有貨',
    imageUrl
  };
}

export function funboxDiscordPreview(product, { test = false } = {}) {
  const meta = [
    funboxPriceLabel(product.price),
    product.stock !== null && product.stock !== undefined
      ? `庫存 ${product.stock} 組`
      : product.availabilityText || ''
  ].filter(Boolean).join('｜');
  return [
    `${test ? '🧪 Funbox 通知測試' : '🚨 Funbox 新品上架'}｜${funboxProductLabel(product)}`,
    meta || '點擊查看商品'
  ].join('\n');
}

export function formatFunboxNotification(product, detectedAt = new Date()) {
  const lines = [
    '🚨 Funbox 戰鬥陀螺上新！',
    '',
    `品名：${product.title}`
  ];
  if (product.price) lines.push(`價格：${funboxPriceLabel(product.price)}`);
  if (product.stock !== null) lines.push(`目前庫存：${product.stock}（官網前台可售量）`);
  else if (product.availabilityText) lines.push(`狀態：${product.availabilityText}`);
  lines.push(`偵測時間：${detectedAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  lines.push('', `連結：${product.url}`);
  return lines.join('\n');
}

export function funboxEmbed(product, { test = false } = {}) {
  const details = [
    test ? '**測試說明：** 正式官網公開商品資料，不是真實陀螺上架' : '',
    `**完整品名：** ${product.title}`,
    product.price ? `**價格：** ${funboxPriceLabel(product.price)}` : '',
    product.stock !== null ? `**可售庫存：** ${product.stock} 組` : '',
    product.stock !== null ? '**庫存來源：** Funbox 官網前台可售量' : '',
    product.stock === null && product.availabilityText ? `**狀態：** ${product.availabilityText}` : '',
    '',
    `**🛒 購買：** [立即前往商品頁](${product.url})`
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  return {
    author: { name: '陀螺通知監控儀表・Funbox 官網' },
    title: `${test ? '🧪 Funbox 通知測試' : '🚨 Funbox 新品上架'}｜${funboxProductLabel(product, 90)}`,
    url: product.url,
    color: test ? 0xd6a62f : 0xe5484d,
    description: details,
    thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
    footer: { text: test ? '正式資料測試・不會寫入陀螺監控基線' : 'Funbox 官網即時上架通知' },
    timestamp: new Date().toISOString()
  };
}

function stockStatus(stock, lowStockThreshold = 10) {
  if (stock === 0) return '已售罄';
  if (stock <= lowStockThreshold) return '即將銷售完畢';
  return '';
}

export const FUNBOX_STOCK_NOTIFICATION_THRESHOLDS = [100, 50, 20, 10, 0];

export function funboxStockNotificationDecision(previousStock, currentStock) {
  const previous = Number(previousStock);
  const current = Number(currentStock);
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === current) {
    return { notify: false, reason: 'unchanged', threshold: null };
  }
  if (current > previous) {
    return { notify: true, reason: 'restock', threshold: null };
  }

  const crossed = FUNBOX_STOCK_NOTIFICATION_THRESHOLDS
    .filter((threshold) => previous > threshold && current <= threshold);
  if (!crossed.length) return { notify: false, reason: 'between_thresholds', threshold: null };
  return {
    notify: true,
    reason: current === 0 ? 'sold_out' : 'threshold',
    threshold: Math.min(...crossed)
  };
}

export function funboxStockDiscordPreview(
  product,
  previousStock,
  { lowStockThreshold = 10 } = {}
) {
  const status = stockStatus(product.stock, lowStockThreshold);
  const heading = product.stock === 0
    ? '🔴 Funbox 已售罄'
    : status
      ? '⚠️ Funbox 低庫存'
      : '🔔 Funbox 庫存變動';
  return [
    `${heading}｜${funboxProductLabel(product)}`,
    `庫存 ${previousStock} → ${product.stock} 組`
  ].join('\n');
}

export function formatFunboxStockNotification(
  product,
  previousStock,
  detectedAt = new Date(),
  { lowStockThreshold = 10 } = {}
) {
  const status = stockStatus(product.stock, lowStockThreshold);
  const lines = [
    '🔔 Funbox 庫存變動通知',
    '',
    `品名：${product.title}`
  ];
  if (product.price) lines.push(`價格：${funboxPriceLabel(product.price)}`);
  lines.push(`庫存變化：${previousStock} → ${product.stock}`);
  lines.push(`目前庫存：${product.stock}（官網前台可售量）`);
  if (status) lines.push(`狀態：${status}`);
  lines.push(`時間：${detectedAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  lines.push('', `連結：${product.url}`);
  return lines.join('\n');
}

export function funboxStockEmbed(product, previousStock, { lowStockThreshold = 10 } = {}) {
  const status = stockStatus(product.stock, lowStockThreshold);
  const heading = product.stock === 0
    ? '🔴 Funbox 商品已售罄'
    : status
      ? '⚠️ Funbox 庫存即將銷售完畢'
      : '🔔 Funbox 庫存變動通知';
  const title = `${heading}｜${funboxProductLabel(product, 80)}`;
  const details = [
    `**完整品名：** ${product.title}`,
    product.price ? `**價格：** ${funboxPriceLabel(product.price)}` : '',
    `**庫存變化：** ${previousStock} → ${product.stock} 組`,
    `**目前可售：** ${product.stock} 組`,
    status ? `**狀態：** ${status}` : '',
    '**庫存來源：** Funbox 官網前台可售量',
    '',
    `**🛒 購買：** [立即前往商品頁](${product.url})`
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  return {
    author: { name: '陀螺通知監控儀表・Funbox 官網' },
    title,
    url: product.url,
    color: product.stock === 0 ? 0xd71920 : status ? 0xf0a202 : 0x3c82f6,
    description: details,
    thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
    footer: { text: 'Funbox 官網庫存變動通知' },
    timestamp: new Date().toISOString()
  };
}

export class FunboxMonitor {
  constructor({
    state,
    log = () => {},
    notify = sendNotification,
    onPurchaseCandidate = null,
    onInventorySnapshot = null,
    onExcludedProduct = null,
    sourceIntervalMs = null,
    fetcher = fetch,
    url = FUNBOX_BEYBLADE_URL,
    sources = null,
    sourceTimeoutMs = FUNBOX_SOURCE_TIMEOUT_MS,
    productHydrationTimeoutMs = FUNBOX_PRODUCT_HYDRATION_TIMEOUT_MS,
    stateKey = 'funbox',
    logLabel = 'Funbox 官網'
  }) {
    this.state = state;
    this.log = log;
    this.notify = notify;
    this.onPurchaseCandidate = typeof onPurchaseCandidate === 'function' ? onPurchaseCandidate : null;
    this.onInventorySnapshot = typeof onInventorySnapshot === 'function' ? onInventorySnapshot : null;
    this.onExcludedProduct = onExcludedProduct;
    this.sourceIntervalMs = sourceIntervalMs;
    this.cooldownUntil = 0;
    this.sourceCooldowns = new Map();
    this.fetcher = fetcher;
    this.url = url;
    this.sources = Array.isArray(sources) && sources.length
      ? sources.map((source, index) => ({
          id: String(source.id || `source-${index + 1}`),
          label: String(source.label || source.id || `資料源 ${index + 1}`),
          url: String(source.url || ''),
          timeoutMs: Math.max(250, Number(source.timeoutMs) || sourceTimeoutMs),
          intervalMs: Math.max(0, Number(source.intervalMs) || 0),
          method: String(source.method || 'GET').toUpperCase(),
          body: source.body === null || source.body === undefined ? undefined : String(source.body),
          headers: source.headers && typeof source.headers === 'object' ? { ...source.headers } : {},
          hydrateProductDetails: Boolean(source.hydrateProductDetails)
        })).filter((source) => source.url)
      : [{ id: 'primary', label: '主要 API', url }];
    this.sourceTimeoutMs = Math.max(250, Number(sourceTimeoutMs) || FUNBOX_SOURCE_TIMEOUT_MS);
    this.productHydrationTimeoutMs = Math.max(
      250,
      Number(productHydrationTimeoutMs) || FUNBOX_PRODUCT_HYDRATION_TIMEOUT_MS
    );
    this.stateKey = stateKey;
    this.logLabel = logLabel;
    this.running = false;
    this.notificationTasks = new Set();
    this.sourceCache = new Map();
  }

  emitPurchaseCandidate(candidate) {
    if (!this.onPurchaseCandidate) return false;
    try {
      const task = this.onPurchaseCandidate(candidate);
      Promise.resolve(task).catch((error) => {
        this.log(`Funbox 購買工作派送失敗：${error.message}`, 'funbox');
      });
      return true;
    } catch (error) {
      this.log(`Funbox 購買工作派送失敗：${error.message}`, 'funbox');
      return false;
    }
  }

  emitInventorySnapshot(products, observedAt) {
    if (!this.onInventorySnapshot) return false;
    try {
      this.onInventorySnapshot(products, observedAt);
      return true;
    } catch (error) {
      this.log(`Funbox 庫存快照派送失敗：${error.message}`, 'funbox');
      return false;
    }
  }

  notifyInBackground(text, options, { onSuccess } = {}) {
    let notification;
    try {
      notification = this.notify(text, options);
    } catch (error) {
      notification = Promise.reject(error);
    }
    const task = Promise.resolve(notification)
      .then(async (messageId) => {
        await onSuccess?.(messageId);
        return messageId;
      });
    this.notificationTasks.add(task);
    task.then(
      () => this.notificationTasks.delete(task),
      (error) => {
        this.notificationTasks.delete(task);
        this.log(`Funbox 背景通知失敗：${error.message}`, 'funbox');
      }
    );
    return task;
  }

  async hydrateProductDetails(product) {
    const startedAt = Date.now();
    const canonicalUrl = String(product?.url || '').replace(/\.json(?:\?.*)?$/i, '');
    if (!/\/products\/[^/?#]+/i.test(canonicalUrl)) {
      return { product, ok: false, durationMs: 0, error: '缺少 Funbox 單品網址' };
    }
    try {
      const response = await this.fetcher(`${canonicalUrl}.json`, {
        headers: {
          Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
        },
        signal: AbortSignal.timeout(this.productHydrationTimeoutMs)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = validateFunboxSourceBody(await response.text(), `${canonicalUrl}.json`);
      const raw = JSON.parse(body);
      const [details] = parseFunboxProductData(
        Array.isArray(raw) ? raw : [{ ...raw, url: raw?.url || canonicalUrl }],
        canonicalUrl
      );
      if (!details) throw new Error('單品 JSON 無法解析');
      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        product: {
          ...product,
          ...details,
          id: canonicalFunboxProductId(details.url || canonicalUrl, details.id || product.id),
          discoveryUrl: product.url,
          detailHydrationFailed: false
        }
      };
    } catch (error) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error.message,
        product: { ...product, detailHydrationFailed: true }
      };
    }
  }

  async fetchSource(source, { previousSeen = {} } = {}) {
    const startedAt = Date.now();
    const cooldownUntil=Math.max(this.cooldownUntil,this.sourceCooldowns.get(source.id)||0);
    if(startedAt<cooldownUntil)return {...source,ok:false,fresh:false,products:[],productCount:0,durationMs:0,error:'HTTP 限流冷卻中',retryAfterMs:cooldownUntil-startedAt};
    const cached = this.sourceCache.get(source.id);
    const intervalMs = this.sourceIntervalMs ? this.sourceIntervalMs(source,startedAt) : source.intervalMs;
    if (cached && intervalMs > 0 && startedAt - cached.fetchedAtMs < intervalMs) {
      return {
        ...source,
        ok: true,
        fresh: false,
        skipped: true,
        durationMs: 0,
        productCount: cached.products.length,
        hydratedCount: cached.hydratedCount || 0,
        hydrationErrors: [],
        products: cached.products.map((product) => ({ ...product }))
      };
    }
    try {
      const requestHeaders = {
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        ...(source.headers || {})
      };
      if (cached?.etag && source.method !== 'POST') requestHeaders['If-None-Match'] = cached.etag;
      const response = await this.fetcher(source.url, {
        method: source.method || 'GET',
        headers: requestHeaders,
        ...(source.body === undefined ? {} : { body: source.body }),
        signal: AbortSignal.timeout(source.timeoutMs || this.sourceTimeoutMs)
      });
      if (response.status === 304 && cached) {
        const products = cached.products.map((product) => ({ ...product, observedAtMs: Date.now() }));
        this.sourceCache.set(source.id, { ...cached, fetchedAtMs: Date.now(), products });
        return {
          ...source,
          ok: true,
          fresh: true,
          notModified: true,
          durationMs: Date.now() - startedAt,
          productCount: products.length,
          hydratedCount: cached.hydratedCount || 0,
          hydrationErrors: [],
          products
        };
      }
      if (!response.ok) {
        if([429,503].includes(response.status)){
          const raw=response.headers.get('retry-after');const seconds=Number(raw);
          const retryAt=raw&&Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(raw||'');
          const until=Math.max(Date.now()+60000,Number.isFinite(retryAt)?retryAt:0);
          if(response.status===429||raw)this.cooldownUntil=Math.max(this.cooldownUntil,until);
          else this.sourceCooldowns.set(source.id,until);
          throw Object.assign(new Error(`HTTP ${response.status}，遵守限流冷卻`),{retryAfterMs:until-Date.now()});
        }
        throw new Error(`HTTP ${response.status}`);
      }
      const body = validateFunboxSourceBody(await response.text(), source.url);
      let products = parseFunboxResponse(body, source.url);
      const hydrationErrors = [];
      let hydratedCount = 0;
      if (source.hydrateProductDetails) {
        products = await Promise.all(products.map(async (product) => {
          const id = canonicalFunboxProductId(product.url, product.id);
          const stored = previousSeen[id];
          const shouldHydrate = !shouldSkipFunboxProduct(product)
            && product.available !== false
            && !product.variantId
            && (!stored || stored.available === false || stored.purchaseReady === false);
          if (!shouldHydrate) return product;
          const hydrated = await this.hydrateProductDetails(product);
          if (hydrated.ok) hydratedCount += 1;
          else hydrationErrors.push(`${id}：${hydrated.error}`);
          return hydrated.product;
        }));
      }
      const observedAtMs = Date.now();
      const observedProducts = products.map((product) => ({ ...product, observedAtMs }));
      this.sourceCache.set(source.id, {
        fetchedAtMs: observedAtMs,
        etag: response.headers.get('etag') || '',
        hydratedCount,
        products: observedProducts
      });
      return {
        ...source,
        ok: true,
        fresh: true,
        durationMs: Date.now() - startedAt,
        productCount: products.length,
        hydratedCount,
        hydrationErrors,
        products: observedProducts
      };
    } catch (error) {
      return {
        ...source,
        ok: false,
        durationMs: Date.now() - startedAt,
        productCount: 0,
        products: [],
        error: error.message,
        retryAfterMs: error.retryAfterMs || 0
      };
    }
  }

  async scan({
    notifyExistingOnFirstRun = false,
    notifyStockChanges = false,
    lowStockThreshold = 10
  } = {}) {
    if (this.running) return { skipped: true };
    this.running = true;
    const startedAt = new Date();
    try {
      this.state.data.commerce ||= {};
      const previous = this.state.data.commerce[this.stateKey] || { initialized: false, seen: {} };
      previous.seen = migrateFunboxSeenRecords(previous.seen || {});
      previous.excluded ||= {};
      const isFirstRun = !previous.initialized;
      const seenBeforeScan = new Set(Object.keys(previous.seen));
      const shouldNotify = !isFirstRun || notifyExistingOnFirstRun;
      const purchaseCandidateMap = new Map();
      const earlyNotificationMap = new Map();
      const earlyNotificationIds = new Map();
      const dispatchEarlyNotification = (product, source) => {
        const id = String(product.id);
        if (!shouldNotify || previous.seen[id] || shouldSkipFunboxProduct(product)
          || earlyNotificationMap.has(id)) return;
        earlyNotificationMap.set(id, product);
        this.log(
          `${this.logLabel}早期新品訊號：${product.title}｜${source.label} ${source.durationMs}ms，立即推播。`,
          'funbox'
        );
        this.notifyInBackground(
          formatFunboxNotification(product, startedAt),
          {
            discordPreview: funboxDiscordPreview(product),
            embeds: [funboxEmbed(product)]
          },
          {
            onSuccess: async (messageId) => {
              if (!messageId) return;
              earlyNotificationIds.set(id, messageId);
              if (!previous.seen[id]) return;
              previous.seen[id].notificationId = messageId;
              await this.state.save();
            }
          }
        );
      };
      const dispatchEarlyCandidate = (product, source) => {
        if (!shouldNotify || product.available === false || !product.variantId
          || shouldSkipFunboxProduct(product)) return;
        const id = String(product.id);
        const stored = previous.seen[id];
        const reason = !stored
          ? 'new_product'
          : stored.available === false
            ? 'restock'
            : stored.purchaseReady === false
              ? 'purchase_ready'
              : '';
        if (!reason || purchaseCandidateMap.has(id)) return;
        const candidate = {
          ...product,
          reason,
          detectedAt: new Date(product.observedAtMs || Date.now()).toISOString(),
          detectionSource: source.label,
          detectionLatencyMs: source.durationMs
        };
        purchaseCandidateMap.set(id, candidate);
        this.log(
          `${this.logLabel}早期有貨訊號：${product.title}｜${source.label} ${source.durationMs}ms，立即派送購買。`,
          'funbox'
        );
        this.emitPurchaseCandidate(candidate);
      };
      const sourceTasks = this.sources.map(async (source) => {
        const result = await this.fetchSource(source, { previousSeen: previous.seen });
        if (result.ok && result.fresh !== false) {
          for (const product of result.products) {
            if(shouldSkipFunboxProduct(product)&&this.onExcludedProduct)void Promise.resolve(this.onExcludedProduct(product)).catch(()=>this.log('APP 上架通知處理失敗，保留活動紀錄供核對','funbox'));
            dispatchEarlyCandidate(product, result);
            dispatchEarlyNotification(product, result);
          }
          // Retry leases follow the first fresh response, not the slowest source.
          this.emitInventorySnapshot(result.products.filter(product => !shouldSkipFunboxProduct(product)), Date.now());
        }
        return result;
      });
      const sourceResults = await Promise.all(sourceTasks);
      const successfulSources = sourceResults.filter((source) => source.ok);
      const freshSuccessfulSources = successfulSources.filter((source) => source.fresh !== false);
      if (!successfulSources.length) {
        throw Object.assign(new Error(`Funbox 所有資料源失敗：${sourceResults.map((source) => `${source.label} ${source.error}`).join('；')}`),{retryAfterMs:Math.max(0,...sourceResults.map(s=>s.retryAfterMs||0))});
      }
      const parsedProducts = mergeFunboxProductSources(successfulSources);
      const skippedProducts = parsedProducts.filter(shouldSkipFunboxProduct);
      const products = parsedProducts.filter((product) => !shouldSkipFunboxProduct(product));
      // 結帳工作只讀這份記憶體快照，不會額外對 Funbox 加壓。新的缺貨訊號
      // 可讓正在組車的帳號提前封箱，剩餘品項留給同帳號下一張單。
      const freshProducts = mergeFunboxProductSources(freshSuccessfulSources).filter(product => !shouldSkipFunboxProduct(product));
      const freshIds = new Set(freshProducts.map(product => String(product.id)));
      const freshById = new Map(freshProducts.map(product => [String(product.id), product]));
      this.emitInventorySnapshot(freshProducts, Date.now());

      // APP 預約生產／序號兌換商品不屬於現貨監控。清掉既有正式基線，
      // 但保留一份獨立稽核紀錄，讓管理者能分辨「有掃到並排除」與
      // 「資料源根本沒有回傳」。官方日後移除 APP 字樣時仍視為正式新品。
      for (const product of skippedProducts) {
        const id = String(product.id);
        const existing = previous.excluded[id];
        const reason = funboxSkipReason(product);
        previous.excluded[id] = {
          title: product.title,
          url: product.url,
          reason,
          firstSeenAt: existing?.firstSeenAt || startedAt.toISOString(),
          lastSeenAt: startedAt.toISOString(),
          price: product.price,
          stock: product.stock,
          available: product.available,
          sourceProductId: product.sourceProductId || existing?.sourceProductId || ''
        };
        if (!existing || existing.title !== product.title || existing.reason !== reason) {
          this.log(`${this.logLabel}已掃描但排除：${id}｜${product.title}｜原因：${reason}`, 'funbox');
        }
        delete previous.seen[product.id];
      }

      const newProducts = products.filter((product) => !previous.seen[product.id]);
      let notified = 0;
      let stockChanged = 0;
      let stockNotified = 0;
      const purchaseCandidates = [...purchaseCandidateMap.values()];
      const errors = sourceResults
        .filter((source) => !source.ok)
        .map((source) => `${source.label}：${source.error}`);

      for (const product of newProducts) {
        if (shouldNotify) {
          if (freshIds.has(String(product.id)) && product.available !== false && product.variantId) {
            if (!purchaseCandidateMap.has(String(product.id))) {
              const observed = freshById.get(String(product.id));
              const candidate = { ...observed, reason: 'new_product', detectedAt: new Date(observed.observedAtMs || Date.now()).toISOString() };
              purchaseCandidateMap.set(String(product.id), candidate);
              purchaseCandidates.push(candidate);
              this.emitPurchaseCandidate(candidate);
            }
          }
          if (!earlyNotificationMap.has(String(product.id))) {
            this.notifyInBackground(
              formatFunboxNotification(product, startedAt),
              {
                discordPreview: funboxDiscordPreview(product),
                embeds: [funboxEmbed(product)]
              },
              {
                onSuccess: async (messageId) => {
                  if (!messageId || !previous.seen[product.id]) return;
                  previous.seen[product.id].notificationId = messageId;
                  await this.state.save();
                }
              }
            );
          }
          notified += 1;
        }
        previous.seen[product.id] = {
          title: product.title,
          url: product.url,
          firstSeenAt: startedAt.toISOString(),
          ...(earlyNotificationIds.get(String(product.id))
            ? { notificationId: earlyNotificationIds.get(String(product.id)) }
            : product.notificationId
              ? { notificationId: product.notificationId }
              : {})
        };
      }

      if (!isFirstRun) {
        for (const product of products) {
          if (!seenBeforeScan.has(String(product.id))) continue;
          if (!freshIds.has(String(product.id))) continue;
          const previousAvailable = previous.seen[product.id]?.available;
          if ((previousAvailable === false && product.available === true
            || previous.seen[product.id]?.purchaseReady === false && product.variantId)
            && !purchaseCandidateMap.has(String(product.id))) {
            const candidate = {
              ...freshById.get(String(product.id)),
              detectedAt: new Date(freshById.get(String(product.id)).observedAtMs || Date.now()).toISOString(),
              reason: previousAvailable === false ? 'restock' : 'purchase_ready'
            };
            purchaseCandidateMap.set(String(product.id), candidate);
            purchaseCandidates.push(candidate);
            this.emitPurchaseCandidate(candidate);
          }
        }
      }

      if (!isFirstRun && notifyStockChanges) {
        for (const product of products) {
          if (!seenBeforeScan.has(String(product.id))) continue;
          const storedStock = previous.seen[product.id]?.stock;
          if (storedStock === null || storedStock === undefined || product.stock === null || product.stock === undefined) continue;
          const oldStock = Number(storedStock);
          const currentStock = Number(product.stock);
          if (!Number.isFinite(oldStock) || !Number.isFinite(currentStock) || oldStock === currentStock) continue;
          stockChanged += 1;
          const decision = funboxStockNotificationDecision(oldStock, currentStock);
          if (!decision.notify) continue;
          this.notifyInBackground(
            formatFunboxStockNotification(product, oldStock, startedAt, { lowStockThreshold }),
            {
              discordPreview: funboxStockDiscordPreview(product, oldStock, { lowStockThreshold }),
              embeds: [funboxStockEmbed(product, oldStock, { lowStockThreshold })]
            }
          );
          stockNotified += 1;
          notified += 1;
        }
      }

      for (const product of products) {
        if (!previous.seen[product.id]) continue;
        previous.seen[product.id].lastSeenAt = startedAt.toISOString();
        previous.seen[product.id].price = product.price;
        previous.seen[product.id].stock = product.stock;
        previous.seen[product.id].available = product.available;
        previous.seen[product.id].purchaseReady = Boolean(
          product.available !== false && product.variantId
        );
        previous.seen[product.id].imageUrl = product.imageUrl;
        previous.seen[product.id].missingStreak = 0;
        delete previous.seen[product.id].confirmedAbsentAt;
      }

      // A product omitted by just one endpoint is not proof of sell-out. Only
      // two consecutive scans where every source succeeds close the current
      // availability generation, allowing one clean restock event next time.
      if (freshSuccessfulSources.length === this.sources.length) {
        const currentIds = new Set(products.map((product) => String(product.id)));
        for (const [id, stored] of Object.entries(previous.seen)) {
          if (currentIds.has(id)) continue;
          stored.missingStreak = Math.max(0, Number(stored.missingStreak) || 0) + 1;
          if (stored.missingStreak >= 2) {
            stored.available = false;
            stored.purchaseReady = false;
            stored.stock = 0;
            stored.confirmedAbsentAt ||= startedAt.toISOString();
          }
        }
      }

      previous.initialized = true;
      previous.url = this.url;
      previous.sources = sourceResults.map((source) => ({
        id: source.id,
        label: source.label,
        url: source.url,
        ok: source.ok,
        fresh: source.fresh !== false,
        skipped: Boolean(source.skipped),
        notModified: Boolean(source.notModified),
        durationMs: source.durationMs,
        productCount: source.productCount,
        hydratedCount: source.hydratedCount || 0,
        hydrationErrors: source.hydrationErrors || [],
        error: source.error || null
      }));
      previous.lastScanAt = startedAt.toISOString();
      previous.lastProductCount = products.length;
      previous.lastError = errors.length ? errors.join('\n') : null;
      this.state.data.commerce[this.stateKey] = previous;
      await this.state.save();

      const result = {
        completedAt: new Date().toISOString(),
        checked: products.length,
        skipped: skippedProducts.length,
        discovered: newProducts.length,
        notified,
        stockChanged,
        stockNotified,
        firstRun: isFirstRun,
        products: products.map((product) => ({
          id: String(product.id),
          title: product.title,
          stock: product.stock,
          available: product.available
        })),
        discoveredProducts: newProducts.map((product) => ({
          id: String(product.id),
          title: product.title,
          stock: product.stock,
          available: product.available
        })),
        purchaseCandidates: purchaseCandidates.map((product) => ({
          id: String(product.id),
          title: product.title,
          url: product.url,
          stock: product.stock,
          available: product.available,
          variantId: product.variantId,
          qtyCap: product.qtyCap,
          reason: product.reason
        })),
        excludedProducts: skippedProducts.map((product) => ({
          id: String(product.id),
          title: product.title,
          url: product.url,
          reason: funboxSkipReason(product)
        })),
        purchaseCandidatesDispatched: Boolean(this.onPurchaseCandidate),
        sources: previous.sources,
        errors
      };
      this.log(
        `${this.logLabel}掃描完成：目前 ${products.length} 件，新發現 ${newProducts.length} 件，`
        + `庫存變動 ${stockChanged} 件，通知 ${notified} 則。`,
        'funbox'
      );
      return result;
    } finally {
      this.running = false;
    }
  }

  async close() {
    await Promise.allSettled([...this.notificationTasks]);
  }
}
