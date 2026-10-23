import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { amazonRetryAfterMs } from './amazon-read-scheduler.js';
import { monitoringRoute } from './monitoring-resources.js';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { AMAZON_INVENTORY_SEEDS, amazonInventoryCandidates, amazonInventoryRetryMs } from './amazon-inventory.js';
import { approximateTwdFromYen, japanProductBlacklistMatch } from './japan-auctions.js';

export const AMAZON_JP_SELLER_ID = 'AN1VRQENFRJN5';
export const TAKARA_TOMY_LINEUP_URL = 'https://beyblade.takaratomy.co.jp/beyblade-x/lineup/';
export const AMAZON_JP_SEARCH_URL = `https://www.amazon.co.jp/s?k=${encodeURIComponent('ベイブレードX')}&i=toys&rh=p_6%3A${AMAZON_JP_SELLER_ID}&s=date-desc-rank&language=ja_JP&currency=JPY`;
export const AMAZON_JP_DISCOVERY_URL = AMAZON_JP_SEARCH_URL.replace(/&rh=[^&]+/, '');
export const AMAZON_JP_DEFAULT_PRICE_TOLERANCE_YEN = 1;

const BLOCKED_WORDS = /Robot Check|Enter the characters you see|Sorry! Something went wrong|ご迷惑をおかけしています|アクセスが集中/i;
const PAGE_NOT_FOUND_WORDS = /ページが見つかりません|何かお探しですか|Page Not Found/i;
export const AMAZON_JP_RETRY_DELAYS_MS = [120_000, 300_000, 900_000, 1_800_000, 3_600_000];

export function amazonJapanRetryDelayMs(failureCount) {
  const index = Math.min(
    AMAZON_JP_RETRY_DELAYS_MS.length - 1,
    Math.max(0, Math.trunc(Number(failureCount) || 1) - 1)
  );
  return AMAZON_JP_RETRY_DELAYS_MS[index];
}

export function nextAmazonJapanAdaptiveInterval(currentSeconds, outcome = 'success') {
  const current = Math.min(60, Math.max(15, Number(currentSeconds) || 20));
  if (outcome !== 'success') {
    return Math.min(60, current < 40 ? 40 : current + 5);
  }
  if (current > 20) return Math.max(20, current - 5);
  return current <= 15 ? 20 : current - 1;
}

export function amazonJapanPageIssue({ status, title, body, html } = {}) {
  const code = Number(status);
  const content = `${clean(title)} ${clean(body)}`;
  if (code === 404 || PAGE_NOT_FOUND_WORDS.test(content)) return 'not_found';
  if (code === 429 || code === 503 || BLOCKED_WORDS.test(content)) return 'rate_limited';
  if (code === 202 && String(html || '').length < 5_000 && !clean(body)) return 'loading_shell';
  return '';
}

function amazonAccessError(issue, detail = '') {
  const error = new Error(issue === 'rate_limited'
    ? `Amazon.co.jp 回傳流量限制或驗證頁${detail ? `：${detail}` : ''}`
    : issue === 'not_found'
      ? `Amazon.co.jp 頁面不存在${detail ? `：${detail}` : ''}`
      : `Amazon.co.jp 頁面長時間停留在空白載入殼${detail ? `：${detail}` : ''}`);
  error.code = issue === 'rate_limited'
    ? 'AMAZON_RATE_LIMITED'
    : issue === 'not_found'
      ? 'AMAZON_NOT_FOUND'
      : 'AMAZON_LOADING_SHELL';
  return error;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).href; } catch { return ''; }
}

function normalizeName(value) {
  return clean(value)
    .toUpperCase()
    .replace(/TAKARA\s*TOMY|タカラトミー|BEYBLADE\s*X|ベイブレードX?/gi, '')
    .replace(/[\s・･「」『』【】\[\]()（）\-_/.,]/g, '');
}

export function extractAmazonAsin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/(^|\.)amazon\.co\.jp$/i.test(url.hostname)) return '';
    const pathMatch = url.pathname.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (pathMatch) return pathMatch[1].toUpperCase();
    const queryAsin = clean(url.searchParams.get('asin'));
    return /^[A-Z0-9]{10}$/i.test(queryAsin) ? queryAsin.toUpperCase() : '';
  } catch {
    return '';
  }
}

export function canonicalAmazonJapanUrl(asin) {
  const value = clean(asin).toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(value)) return '';
  return `https://www.amazon.co.jp/dp/${value}?m=${AMAZON_JP_SELLER_ID}&language=ja_JP&currency=JPY`;
}

export function extractModelCode(value) {
  return clean(value).toUpperCase().match(/\b(?:BXG|BX|CX|UX)-\d{2}\b/)?.[0] || '';
}

export function parseYen(value) {
  const text = clean(value);
  if (!/[￥¥円]/.test(text) || /TWD|NT\$/i.test(text)) return null;
  const match = text.match(/[￥¥]\s*([\d,]+)|([\d,]+)\s*円/);
  if (!match) return null;
  const amount = Number(String(match[1] || match[2]).replace(/,/g, ''));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function isAmazonPriceWithinMsrp(priceYen, msrpYen, toleranceYen = AMAZON_JP_DEFAULT_PRICE_TOLERANCE_YEN) {
  const price = Number(priceYen);
  const msrp = Number(msrpYen);
  const tolerance = Math.max(0, Number(toleranceYen) || 0);
  return Number.isFinite(price) && price > 0
    && Number.isFinite(msrp) && msrp > 0
    && price <= msrp + tolerance;
}

export function roundRobinRows(rows, cursor = 0, count = 1) {
  const values = Array.isArray(rows) ? rows : [];
  if (!values.length || count <= 0) return { rows: [], nextCursor: 0 };
  const start = Math.max(0, Number(cursor) || 0) % values.length;
  const limit = Math.min(values.length, Math.max(1, Number(count) || 1));
  const selected = Array.from({ length: limit }, (_, index) => values[(start + index) % values.length]);
  return { rows: selected, nextCursor: (start + limit) % values.length };
}

export function parseTakaraTomyLineup(html, pageUrl = TAKARA_TOMY_LINEUP_URL) {
  const $ = cheerio.load(String(html || ''));
  const products = [];
  $('li.mix').each((_, element) => {
    const card = $(element);
    const anchor = card.find('a[href]').first();
    const bold = card.find('b').first();
    const code = extractModelCode(bold.text() || card.text());
    const name = clean(bold.find('span').first().text() || card.find('img[alt]').first().attr('alt'));
    const priceText = card.find('i').toArray().map((item) => clean($(item).text())).find((text) => parseYen(text));
    const msrpYen = parseYen(priceText);
    if (!code || !name || !msrpYen) return;
    products.push({
      code,
      name,
      msrpYen,
      officialUrl: absoluteUrl(anchor.attr('href'), pageUrl),
      normalizedName: normalizeName(name)
    });
  });
  return products;
}

export function parseAmazonStoreAsins(html, pageUrl = 'https://www.amazon.co.jp/stores/') {
  const $ = cheerio.load(String(html || ''));
  const products = new Map();
  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const url = absoluteUrl(anchor.attr('href'), pageUrl);
    const asin = extractAmazonAsin(url);
    if (!asin) return;
    const title = clean(anchor.attr('aria-label') || anchor.find('img[alt]').first().attr('alt') || anchor.text());
    const old = products.get(asin);
    if (!old || title.length > old.title.length) products.set(asin, { asin, title, url: canonicalAmazonJapanUrl(asin) });
  });
  return [...products.values()];
}

export function parseAmazonSellerSearch(html, pageUrl = AMAZON_JP_SEARCH_URL) {
  const $ = cheerio.load(String(html || ''));
  const products = [];
  $('[data-component-type="s-search-result"][data-asin]').each((_, element) => {
    const card = $(element);
    const asin = clean(card.attr('data-asin')).toUpperCase();
    const title = clean(card.find('h2').first().text());
    const priceYen = parseYen(card.find('.a-price .a-offscreen').first().text());
    if (!/^[A-Z0-9]{10}$/.test(asin) || !title) return;
    const text = clean(card.text());
    const unavailable = /現在在庫切れ|一時的に在庫切れ|在庫切れ|出品者からお求め/i.test(text);
    products.push({
      asin,
      title,
      code: extractModelCode(title),
      priceYen,
      imageUrl: absoluteUrl(card.find('img.s-image').first().attr('src'), pageUrl),
      url: canonicalAmazonJapanUrl(asin),
      available: !unavailable && priceYen > 0
    });
  });
  return products;
}

function safeAmazonImageUrl(value) {
  try {
    const url = new URL(clean(value), 'https://www.amazon.co.jp/');
    if (url.protocol !== 'https:') return '';
    if (!/(^|\.)(?:media-amazon|ssl-images-amazon)\.com$/i.test(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function parseAmazonMainImage($) {
  const image = $('#landingImage, #imgTagWrapperId img, #main-image-container img').first();
  let dynamicImages = [];
  try {
    dynamicImages = Object.entries(JSON.parse(image.attr('data-a-dynamic-image') || '{}'))
      .sort(([, left], [, right]) => (Number(right?.[0]) * Number(right?.[1])) - (Number(left?.[0]) * Number(left?.[1])))
      .map(([url]) => url);
  } catch {
    dynamicImages = [];
  }
  const candidates = [
    image.attr('data-old-hires'),
    ...dynamicImages,
    image.attr('src'),
    $('meta[property="og:image"]').first().attr('content')
  ];
  return candidates.map(safeAmazonImageUrl).find(Boolean) || '';
}

export function parseAmazonOffer(html, asin = '') {
  const $ = cheerio.load(String(html || ''));
  const title = clean($('#productTitle').first().text());
  const imageUrl = parseAmazonMainImage($);
  const buybox = $('#desktop_buybox, #buybox').first();
  const buyboxHtml = buybox.html() || '';
  const merchantId = clean(
    buybox.find('input[name="merchantID"], input[name="merchantId"], input[name="offeringID.1"]')
      .filter((_, item) => /merchant/i.test($(item).attr('name') || '')).first().attr('value')
  ) || buyboxHtml.match(/"merchantId"\s*:\s*"([A-Z0-9]+)"/i)?.[1] || '';
  const priceSelectors = [
    '#corePrice_feature_div .a-price .a-offscreen',
    '#apex_desktop .priceToPay .a-offscreen',
    '#apex_desktop .a-price .a-offscreen',
    '#desktop_buybox .a-price .a-offscreen'
  ];
  let priceYen = null;
  for (const selector of priceSelectors) {
    priceYen = parseYen($(selector).first().text());
    if (priceYen) break;
  }
  const buyButtonPresent = Boolean($('#add-to-cart-button, #buy-now-button').length);
  const available = buyButtonPresent
    && merchantId === AMAZON_JP_SELLER_ID
    && Boolean(priceYen);
  return {
    asin: clean(asin).toUpperCase(),
    title,
    code: extractModelCode(title),
    imageUrl,
    priceYen,
    merchantId,
    sellerConfirmed: merchantId === AMAZON_JP_SELLER_ID,
    buyButtonPresent,
    available
  };
}

export function matchTakaraTomyCatalog(product, catalog) {
  const code = product?.code || extractModelCode(product?.title);
  if (!code) return null;
  const matches = (catalog || []).filter((item) => item.code === code);
  if (matches.length === 1) return matches[0];
  const title = normalizeName(product?.title);
  if (!title) return null;
  const named = matches.filter((item) => item.normalizedName && (
    title.includes(item.normalizedName) || item.normalizedName.includes(title)
  ));
  return named.length === 1 ? named[0] : null;
}

export function amazonJapanNotification(product, { kind = 'restock', xConfirmed = false, test = false } = {}) {
  const status = kind === 'new' ? '新品可購' : '自營恢復販售';
  const prefix = test ? '🧪 測試｜' : '';
  const priceTwd = approximateTwdFromYen(`¥${product.priceYen}`);
  const priceText = `¥${Number(product.priceYen).toLocaleString('en-US')}${priceTwd === null ? '' : `（約 NT$${priceTwd.toLocaleString('en-US')}）`}`;
  return {
    text: `${prefix}🇯🇵 日亞｜${status}｜${product.code} ${product.title}`,
    options: {
      discordAudience: 'japan',
      username: '日拍追蹤',
      discordPreview: `${prefix}🇯🇵 日亞 ${status}｜${product.code}｜${priceText}`,
      embeds: [{
        title: `${prefix}🇯🇵 日本亞馬遜｜${status}`,
        url: product.url,
        description: [
          ...(test ? ['🧪 測試通知：價格與可購狀態為模擬，並非真實補貨。'] : []),
          `商品：${product.title}`,
          `型號：${product.code}`,
          `日亞價格：${priceText}`,
          '',
          `[🛒 前往 Amazon.co.jp ${test ? '真實商品頁' : '官方賣家頁'}](${product.url})`
        ].join('\n'),
        color: 0xff9900,
        thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
        footer: { text: `${test ? '本機測試・不是真實補貨｜' : ''}只通知全新 Amazon.co.jp 自營・第三方販售不通知` },
        timestamp: new Date().toISOString()
      }]
    }
  };
}

const AMAZON_JP_TEST_PRESETS = {
  B0HJ783F18: {
    asin: 'B0HJ783F18', code: 'BX-52',
    title: 'タカラトミー(TAKARA TOMY) BEYBLADE X ベイブレードX BX-52 スターター ラスタードラグーン6-60LC',
    msrpYen: 2300
  },
  B0HJ75X3PN: {
    asin: 'B0HJ75X3PN', code: 'BX-53',
    title: 'タカラトミー(TAKARA TOMY) BEYBLADE X ベイブレードX BX-53 オールインワンセット',
    msrpYen: 7480
  }
};

export function amazonJapanTestNotification(selection = {}, savedProducts = []) {
  const choice = clean(selection.choice).toUpperCase();
  const preset = AMAZON_JP_TEST_PRESETS[choice];
  if (!preset && choice !== 'CUSTOM') throw new Error('請選擇 BX-52、BX-53 或自訂日亞網址');

  const asin = preset?.asin || extractAmazonAsin(selection.url);
  if (!asin) throw new Error('自訂測試只接受有效的 amazon.co.jp 商品網址');
  const saved = savedProducts.find((item) => clean(item.asin).toUpperCase() === asin) || {};
  const title = preset?.title || clean(selection.title || saved.title).replace(/@/g, '＠').slice(0, 180);
  const code = preset?.code || extractModelCode(selection.code || saved.code || title);
  const msrpYen = preset?.msrpYen || Number(selection.msrpYen || saved.msrpYen);
  const priceYen = preset?.msrpYen || Number(selection.priceYen || msrpYen);
  if (!title) throw new Error('請填入自訂測試商品名稱');
  if (!code) throw new Error('請填入有效型號，例如 BX-52');
  if (!Number.isSafeInteger(msrpYen) || msrpYen < 1 || msrpYen > 1_000_000) {
    throw new Error('請填入有效的日圓測試參考報價');
  }
  if (!Number.isSafeInteger(priceYen) || priceYen < 1 || priceYen > msrpYen) {
    throw new Error('模擬日亞價格須為正整數且不高於測試使用定價');
  }
  const product = {
    asin, code, title, priceYen, msrpYen,
    url: canonicalAmazonJapanUrl(asin),
    imageUrl: saved.imageUrl || '',
    testPriceSource: preset ? 'catalog' : 'custom'
  };
  return { ...amazonJapanNotification(product, { test: true, xConfirmed: Boolean(preset) }), product };
}

export class AmazonJapanMonitor {
  constructor({ dataDir, state, getConfig, getExcludeKeywords = () => [], notify, log = () => {}, fetcher = fetch, onAvailabilitySignal = async () => {}, readScheduler = null, getDelegatedAsins = () => new Set(), continuousInventory = false, inventorySeeds = AMAZON_INVENTORY_SEEDS }) {
    this.dataDir = dataDir;
    this.state = state;
    this.getConfig = getConfig;
    this.getExcludeKeywords = getExcludeKeywords;
    this.notify = notify;
    this.log = log;
    this.fetcher = fetcher;
    this.onAvailabilitySignal = onAvailabilitySignal;
    this.context = null;
    this.contextPromise = null;
    this.page = null;
    this.running = false;
    this.locationReady = false;
    this.notFoundLoggedUrls = new Set();
    this.readScheduler = readScheduler;
    this.getDelegatedAsins = getDelegatedAsins;
    this.operations = new AsyncLocalStorage();
    this.lanePages = new Map();
    this.backgroundRunning = false;
    this.notificationPromise = null;
    this.locationPromise = null;
    this.closed = false;
    this.generation = 0;
    this.continuousInventory = continuousInventory;
    this.inventorySeeds = inventorySeeds;
    this.httpFallbacks = new Map();
  }

  storage() {
    this.state.data.commerce ||= {};
    const storage = this.state.data.commerce.amazonJp ||= {
      initialized: false,
      products: {},
      catalog: [],
      brandProducts: {},
      xSignals: {},
      manualProducts: {}
    };
    storage.products ||= {};
    storage.catalog ||= [];
    storage.brandProducts ||= {};
    storage.xSignals ||= {};
    storage.manualProducts ||= {};
    return storage;
  }

  async ensureContext() {
    if (this.context) return this.context;
    if (this.contextPromise) return this.contextPromise;
    this.contextPromise = (async () => {
      const profile = path.join(this.dataDir, 'amazon-jp-browser-profile');
      await fs.mkdir(profile, { recursive: true });
      const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        viewport: { width: 1365, height: 900 }
      });
      await context.route('**/*', monitoringRoute());
      await context.addCookies([
        { name: 'i18n-prefs', value: 'JPY', domain: '.amazon.co.jp', path: '/' },
        { name: 'lc-main', value: 'ja_JP', domain: '.amazon.co.jp', path: '/' }
      ]);
      context.once('close', () => {
        if (this.context === context) this.context = null;
        this.page = null;
        this.locationReady = false;
      });
      this.context = context;
      return context;
    })().finally(() => { this.contextPromise = null; });
    return this.contextPromise;
  }

  async browserPage() {
    const lane = this.operations.getStore()?.lane || 'all';
    if (lane !== 'all') {
      const existing = this.lanePages.get(lane);
      if (existing && !existing.isClosed()) return existing;
      const context = await this.ensureContext();
      const page = await context.newPage();
      this.lanePages.set(lane, page);
      return page;
    }
    if (this.page && !this.page.isClosed()) return this.page;
    const context = await this.ensureContext();
    this.page = context.pages().find((page) => !page.isClosed()) || await context.newPage();
    return this.page;
  }

  async ensureJapanLocation(page) {
    if (this.locationReady) return;
    if (!this.locationPromise) this.locationPromise = this.ensureJapanLocationOnce(page)
      .finally(() => { this.locationPromise = null; });
    return this.locationPromise;
  }

  async ensureJapanLocationOnce(page) {
    if (this.locationReady) return;
    const postalCode = clean(this.getConfig()?.postalCode || '100-0001');
    const match = postalCode.match(/^(\d{3})-?(\d{4})$/);
    if (!match) throw new Error('日亞日本郵遞區號格式必須是 123-4567');
    let lastError = null;
    let lastLocation = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await page.goto('https://www.amazon.co.jp/?language=ja_JP&currency=JPY', {
          waitUntil: 'domcontentloaded', timeout: 60_000
        });
        const trigger = page.locator(
          '#glow-ingress-block:visible, #nav-global-location-popover-link:visible'
        ).first();
        const html = await page.content();
        const title = await page.title();
        const body = clean(await page.locator('body').innerText().catch(() => '')).slice(0, 1_000);
        const retryAfterMs = amazonRetryAfterMs(response?.headers?.()['retry-after']);
        const issue = response?.headers?.()['retry-after'] ? 'rate_limited'
          : amazonJapanPageIssue({ status: response?.status(), title, body, html });
        this.recordReadDiagnostic({ url: 'https://www.amazon.co.jp/', status: response?.status(), transport: 'browser', issue, retryAfterMs });
        if (issue) throw Object.assign(amazonAccessError(issue, title || `HTTP ${response?.status() || 'unknown'}`),
          { httpStatus: response?.status(), retryAfterMs, requestKind: 'location' });
        await trigger.waitFor({ state: 'visible', timeout: 20_000 });

        lastLocation = clean(await page.locator('#glow-ingress-line2').innerText().catch(() => ''));
        if (lastLocation.includes(`${match[1]}-${match[2]}`)) {
          this.locationReady = true;
          return;
        }

        await trigger.click({ timeout: 10_000, force: attempt > 1 });
        const zipInput = page.locator('#GLUXZipUpdateInput_0');
        await zipInput.waitFor({ state: 'visible', timeout: 7_000 });
        await zipInput.fill(match[1]);
        await page.locator('#GLUXZipUpdateInput_1').fill(match[2]);
        await page.locator('#GLUXZipUpdate input[type="submit"]').click();
        await page.waitForTimeout(500);
        let updatedLocation = clean(await page.locator('#glow-ingress-line2').innerText().catch(() => ''));
        if (!updatedLocation.includes(`${match[1]}-${match[2]}`)) {
          const confirm = page.locator(
            '#GLUXConfirmClose:visible, button:visible:has-text("完了")'
          ).first();
          const confirmationVisible = await confirm.waitFor({ state: 'visible', timeout: 7_000 })
            .then(() => true)
            .catch(() => false);
          if (confirmationVisible) {
            await confirm.click({ timeout: 7_000 });
            await page.waitForTimeout(1_000);
            updatedLocation = clean(await page.locator('#glow-ingress-line2').innerText().catch(() => ''));
          }
        }
        if (updatedLocation.includes(`${match[1]}-${match[2]}`)) {
          this.locationReady = true;
          return;
        }
        lastLocation = updatedLocation || lastLocation;
        lastError = new Error('郵遞區號送出後，頁面未確認配送地區已更新');
      } catch (error) {
        lastError = error;
        if (error?.code === 'AMAZON_RATE_LIMITED') throw error;
        if (attempt < 3) await page.waitForTimeout(750 * attempt);
      }
    }
    throw new Error(
      `Amazon.co.jp 配送地區仍是「${lastLocation || '無法辨識'}」；三次嘗試均失敗：${lastError?.message || '未知錯誤'}`
    );
  }

  async loadPage(url) {
    const lane = this.operations.getStore()?.lane || 'all';
    const generation = this.operations.getStore()?.generation ?? this.generation;
    const kind = new URL(url).pathname === '/s' ? 'search'
      : /\/dp\/|\/gp\/product\//.test(new URL(url).pathname) ? 'product' : 'brand';
    const startedAt = Date.now();
    const useHttp = lane === 'background' && kind === 'product' && (this.httpFallbacks.get(url) || 0) <= Date.now();
    const read = async () => {
      try {
        const html = useHttp
          ? await this.loadProductHttp(url) : await this.loadBrowserPage(url);
        return html;
      } catch (error) {
        // A valid HTTP 200 with incomplete HTML may need rendering next round.
        // Never switch transports in response to throttling or verification.
        if (useHttp && error.code === 'AMAZON_PRODUCT_UNREADABLE') this.httpFallbacks.set(url, Date.now() + 30 * 60_000);
        error.requestKind ||= kind;
        throw error;
      } finally {
        this.storage().lastReadDurationMs = Date.now() - startedAt;
      }
    };
    return this.readScheduler ? this.readScheduler.run({ lane: kind === 'search' ? 'search'
      : lane === 'background' ? 'background' : 'confirmation', scope: 'general-monitor', key: url,
      canStart: () => !this.closed && generation === this.generation && this.getConfig()?.enabled !== false }, read) : read();
  }

  recordReadDiagnostic({ url, status, transport, issue = '', retryAfterMs = 0 }) {
    const lane = this.operations.getStore()?.lane || 'all';
    const diagnostic = { at: new Date().toISOString(), lane, kind: new URL(url).pathname === '/' ? 'location' : new URL(url).pathname === '/s' ? 'search'
      : /aodAjaxMain/.test(url) ? 'aod' : /\/dp\/|\/gp\/product\//.test(new URL(url).pathname) ? 'product' : 'brand',
      httpStatus: Number(status) || 0, transport, issue, retryAfterMs,
      ...(/^[A-Z0-9]{10}$/.test(new URL(url).searchParams.get('asin') || '') ? { asin: new URL(url).searchParams.get('asin') } : {}) };
    this.storage().recentReads = [...(this.storage().recentReads || []), diagnostic].slice(-40);
    this.storage()[lane === 'background' ? 'lastBackgroundDiagnostic' : 'lastSearchDiagnostic'] = diagnostic;
    return diagnostic;
  }

  async loadProductHttp(url) {
    const page = await this.browserPage();
    await this.ensureJapanLocation(page);
    const context = await this.ensureContext();
    const target = new URL(url);
    if (target.origin !== 'https://www.amazon.co.jp') throw new Error('日亞監控拒絕跨網域商品請求');
    target.searchParams.set('language', 'ja_JP');
    target.searchParams.set('currency', 'JPY');
    let response;
    try {
      response = await context.request.get(target.href, { timeout: 15_000, maxRetries: 0, maxRedirects: 0 });
      const html = await response.text();
      const $ = cheerio.load(html);
      const status = response.status();
      const retryAfterMs = amazonRetryAfterMs(response.headers()['retry-after']);
      const issue = response.headers()['retry-after'] ? 'rate_limited' : amazonJapanPageIssue({
        status, title: $('title').text(), body: $('body').text().slice(0, 800), html
      });
      this.recordReadDiagnostic({ url, status, transport: 'web_http', issue, retryAfterMs });
      if (issue && issue !== 'not_found') throw Object.assign(amazonAccessError(issue), { httpStatus: status, retryAfterMs });
      if (issue === 'not_found') return html;
      if (status !== 200) throw Object.assign(new Error(`日亞網頁商品 HTTP ${status}，本輪不切換讀取方式`),
        { code: 'AMAZON_HTTP_REJECTED', httpStatus: status });
      if ($('#ap_email, form[name="signIn"]').length) {
        throw Object.assign(new Error('日亞監控商品頁要求登入'), { code: 'AMAZON_LOGIN_REQUIRED', httpStatus: status });
      }
      const offer = parseAmazonOffer(html, extractAmazonAsin(url));
      const explicitUnavailable = /現在在庫切れ|一時的に在庫切れ|現在お取り扱い|Currently unavailable|暂时缺货|目前無貨|在庫切れ/i
        .test($('#availability, #outOfStock, #availability_feature_div, #availabilityInsideBuyBox_feature_div').text());
      if (status !== 200 || !$('#productTitle').text().trim()
        || !offer.buyButtonPresent && !explicitUnavailable || offer.buyButtonPresent && !(offer.priceYen > 0)) {
        this.recordReadDiagnostic({ url, status, transport: 'web_http', issue: 'product_unreadable' });
        throw Object.assign(new Error('日亞網頁 HTTP 商品資料不完整，保留既有狀態'), { code: 'AMAZON_PRODUCT_UNREADABLE', httpStatus: status });
      }
      return html;
    } finally { await response?.dispose?.().catch(() => {}); }
  }

  async loadBrowserPage(url) {
    const page = await this.browserPage();
    await this.ensureJapanLocation(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (response?.status() === 202) {
      await page.waitForFunction(() => document.body?.innerText?.trim().length > 100, null, { timeout: 15_000 }).catch(() => {});
    }
    if (/amazon\.co\.jp\/stores\//i.test(url)) {
      await page.waitForSelector('a[href*="/dp/"], a[href*="/gp/product/"]', { timeout: 20_000 }).catch(() => {});
      for (let step = 1; step <= 5; step += 1) {
        await page.evaluate((ratio) => window.scrollTo(0, document.body.scrollHeight * ratio), step / 5);
        await page.waitForTimeout(350);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    const html = await page.content();
    const title = await page.title();
    const body = clean(await page.locator('body').innerText().catch(() => '')).slice(0, 800);
    const retryAfterMs = amazonRetryAfterMs(response?.headers?.()['retry-after']);
    const issue = response?.headers?.()['retry-after'] ? 'rate_limited'
      : amazonJapanPageIssue({ status: response?.status(), title, body, html });
    this.recordReadDiagnostic({ url, status: response?.status(), transport: 'browser', issue, retryAfterMs });
    if (issue === 'not_found') {
      if (!this.notFoundLoggedUrls.has(url)) {
        this.notFoundLoggedUrls.add(url);
        this.log(`日亞頁面不存在，僅將該頁視為不可購買，不啟動全站限流退避：${url}`);
      }
      return html;
    }
    if (issue) throw Object.assign(amazonAccessError(issue, title || `HTTP ${response?.status() || 'unknown'}`),
      { httpStatus: response?.status(), retryAfterMs });
    if (html.length < 1000) throw new Error('Amazon.co.jp 回傳不完整頁面，本輪不更新基線');
    return html;
  }

  async addXSignal(value, { source = 'bey_sokuhou', title = '' } = {}) {
    let url = String(value || '').trim();
    if (/^https:\/\/amzn\.(?:to|asia)\//i.test(url)) {
      const response = await this.fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      url = response.url || url;
    }
    const asin = extractAmazonAsin(url);
    if (!asin) throw new Error('這個 X 情報連結沒有可辨識的日本亞馬遜 ASIN');
    const storage = this.storage();
    storage.xSignals ||= {};
    storage.xSignals[asin] = {
      asin,
      source: clean(source).replace(/^@/, '') || 'bey_sokuhou',
      title: clean(title),
      originalAmazonUrl: url,
      affiliateConfirmed: /(?:^|[?&])tag=bey_sokuhou-22(?:&|$)/i.test(url),
      recordedAt: new Date().toISOString()
    };
    await this.state.save();
    return storage.xSignals[asin];
  }

  migrateXSignalsToManualProducts(storage = this.storage()) {
    storage.manualProducts ||= {};
    for (const signal of Object.values(storage.xSignals || {})) {
      const asin = clean(signal.asin).toUpperCase();
      if (!asin || storage.manualProducts[asin]) continue;
      const known = storage.products?.[asin] || storage.brandProducts?.[asin] || {};
      storage.manualProducts[asin] = {
        asin,
        code: extractModelCode(known.code || known.title || signal.title),
        title: clean(known.title || signal.title || `ASIN ${asin}`),
        imageUrl: clean(known.imageUrl),
        originalAmazonUrl: signal.originalAmazonUrl || canonicalAmazonJapanUrl(asin),
        productUrl: canonicalAmazonJapanUrl(asin),
        source: 'x_signal',
        affiliateConfirmed: Boolean(signal.affiliateConfirmed),
        addedAt: signal.recordedAt || new Date().toISOString(),
        updatedAt: signal.recordedAt || new Date().toISOString(),
        inspectionError: ''
      };
    }
    return storage.manualProducts;
  }

  async addManualProduct(value) {
    let url = String(value || '').trim();
    if (/^https:\/\/amzn\.(?:to|asia)\//i.test(url)) {
      const response = await this.fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      url = response.url || url;
    }
    const asin = extractAmazonAsin(url);
    if (!asin) throw new Error('這個網址沒有可辨識的日本亞馬遜 ASIN');
    const storage = this.storage();
    this.migrateXSignalsToManualProducts(storage);
    const previous = storage.manualProducts[asin] || {};
    const known = storage.products?.[asin] || storage.brandProducts?.[asin] || {};
    let inspected = {};
    let inspectionError = '';
    if (!clean(known.title || previous.title) || !clean(known.imageUrl || previous.imageUrl)) {
      try {
        inspected = parseAmazonOffer(await this.loadPage(canonicalAmazonJapanUrl(asin)), asin);
      } catch (error) {
        inspectionError = error.message;
      }
    }
    const title = clean(inspected.title || known.title || previous.title || `ASIN ${asin}`);
    const now = new Date().toISOString();
    storage.manualProducts[asin] = {
      ...previous,
      asin,
      code: extractModelCode(inspected.code || known.code || previous.code || title),
      title,
      imageUrl: clean(inspected.imageUrl || known.imageUrl || previous.imageUrl),
      originalAmazonUrl: url,
      productUrl: canonicalAmazonJapanUrl(asin),
      source: previous.source === 'x_signal' ? 'x_signal' : 'manual',
      affiliateConfirmed: Boolean(previous.affiliateConfirmed || /(?:^|[?&])tag=bey_sokuhou-22(?:&|$)/i.test(url)),
      addedAt: previous.addedAt || now,
      updatedAt: now,
      inspectionError
    };
    await this.state.save();
    return storage.manualProducts[asin];
  }

  async deleteManualProduct(value) {
    const raw = String(value || '').trim();
    const asin = (extractAmazonAsin(raw) || (/^[A-Z0-9]{10}$/i.test(raw) ? raw : '')).toUpperCase();
    if (!asin) throw new Error('找不到要刪除的日亞 ASIN');
    const storage = this.storage();
    this.migrateXSignalsToManualProducts(storage);
    const existing = storage.manualProducts[asin];
    if (!existing) throw new Error(`日亞單品資料庫中找不到 ASIN ${asin}`);
    delete storage.manualProducts[asin];
    delete storage.xSignals?.[asin];
    delete storage.preCatalogWatch?.[asin];
    await this.state.save();
    return existing;
  }

  async ensureSeedSignals() {
    const storage = this.storage();
    for (const url of this.getConfig()?.xSignalUrls || []) {
      const asin = extractAmazonAsin(url);
      if (asin && !storage.xSignals?.[asin]) await this.addXSignal(url);
    }
    this.migrateXSignalsToManualProducts(storage);
  }

  async loadAodOffer(asin) {
    const { AmazonJpHttpClient, amazonAodUrl } = await import('./amazon-jp-http.js');
    const url = amazonAodUrl(asin), lane = this.operations.getStore()?.lane || 'all';
    const generation = this.operations.getStore()?.generation ?? this.generation;
    const read = async () => {
      const page = await this.browserPage();
      await this.ensureJapanLocation(page);
      const context = await this.ensureContext();
      const client = new AmazonJpHttpClient({ request: context.request });
      try {
        const snapshot = await client.readOffer(asin);
        if (snapshot.pageIssue || ['retail_contract_incomplete', 'retail_price_unreadable'].includes(snapshot.diagnostic?.decision)) {
          throw Object.assign(new Error('AOD 回應不完整，保留原有庫存狀態'), { code: 'AMAZON_PRODUCT_UNREADABLE', httpStatus: 200 });
        }
        this.recordReadDiagnostic({ url, status: 200, transport: 'aod_http' });
        return { ...snapshot, available: snapshot.sellerConfirmed && snapshot.addCartAvailable && snapshot.priceYen > 0,
          buyButtonPresent: snapshot.addCartAvailable, pricingSource: 'amazon_retail_aod', msrpYen: null };
      } catch (error) {
        this.recordReadDiagnostic({ url, status: error.httpStatus, transport: 'aod_http', issue: error.code, retryAfterMs: error.retryAfterMs || 0 });
        error.requestKind = 'aod'; throw error;
      }
    };
    return this.readScheduler ? this.readScheduler.run({ lane: lane === 'background' ? 'background' : 'confirmation',
      scope: 'general-monitor', key: url, canStart: () => !this.closed && generation === this.generation && this.getConfig()?.enabled !== false }, read) : read();
  }

  async verifyOffer(product) {
    const offer = await this.loadAodOffer(product.asin);
    return { ...product, ...offer, title: offer.title || product.title, code: offer.code || product.code,
      imageUrl: offer.imageUrl || product.imageUrl || '', url: canonicalAmazonJapanUrl(product.asin),
      msrpYen: null, officialName: '', officialUrl: '', pricingSource: 'amazon_retail_aod',
      rejectionReason: offer.available ? '' : 'AOD 目前沒有可確認的全新 Amazon.co.jp 自營可購報價' };
  }

  async inspectDedicatedPreCatalogProducts(products, officialCatalog, pricingCatalog, storage, onObserved = () => {}) {
    const pending = products.filter((product) => (
      product.dedicatedUntilCatalog === true
    ));
    const previous = storage.preCatalogWatch || {};
    const current = {};
    const observed = [];
    let successful = 0;
    for (const product of pending) {
      const checkedAt = new Date().toISOString();
      try {
        const offer = await this.verifyOffer(product);
        observed.push(offer); onObserved(offer);
        current[product.asin] = {
          ...previous[product.asin],
          ...offer,
          asin: product.asin,
          code: offer.code || product.code,
          title: offer.title || product.title,
          url: canonicalAmazonJapanUrl(product.asin),
          imageUrl: offer.imageUrl || previous[product.asin]?.imageUrl || '',
          priceYen: offer.priceYen || null,
          msrpYen: null,
          pricingSource: 'amazon_retail_aod',
          sellerConfirmed: Boolean(offer.sellerConfirmed),
          buyButtonPresent: Boolean(offer.buyButtonPresent),
          available: Boolean(offer.available),
          lastCheckedAt: checkedAt,
          lastError: ''
        };
        successful += 1;
      } catch (error) {
        if (error?.code === 'AMAZON_RATE_LIMITED' || error?.code === 'AMAZON_LOADING_SHELL') throw error;
        current[product.asin] = {
          ...previous[product.asin],
          asin: product.asin,
          code: product.code,
          title: product.title,
          url: canonicalAmazonJapanUrl(product.asin),
          lastCheckedAt: checkedAt,
          lastError: error.message
        };
      }
    }
    storage.preCatalogWatch = current;
    storage.lastDedicatedCheckedCount = pending.length;
    storage.lastDedicatedSuccessfulCount = successful;
    return { pending, successful, observed };
  }

  async flushNotifications() {
    if (this.notificationPromise) return this.notificationPromise;
    this.notificationPromise = (async () => {
      const pending = this.storage().pendingAvailabilityNotifications ||= {};
      let count = 0;
      while (Object.keys(pending).length) {
        const [asin, entry] = Object.entries(pending)[0];
        const { product, kind } = entry;
        const message = amazonJapanNotification(product, { kind, xConfirmed: Boolean(this.storage().xSignals?.[asin]) });
        let messageId;
        try { messageId = await this.notify(message.text, message.options); }
        catch (error) {
          this.storage().notificationRetryAt = new Date(Date.now() + Math.max(15_000, Number(error.retryAfterMs) || 0)).toISOString();
          await this.state.save(); throw error;
        }
        if (pending[asin] === entry) delete pending[asin];
        this.log(`日亞通知已送出：${product.code}｜ASIN ${asin}｜Discord 訊息 ID ${messageId || 'ok'}。`);
        count++;
        this.storage().notificationSentCount = (this.storage().notificationSentCount || 0) + 1;
        this.storage().lastNotificationAt = new Date().toISOString();
        this.storage().notificationRetryAt = '';
      }
      await this.state.save();
      return count;
    })().finally(() => { this.notificationPromise = null; });
    return this.notificationPromise;
  }

  registerInventoryProduct(product, source) {
    const asin = clean(product?.asin || extractAmazonAsin(product?.url)).toUpperCase();
    const code = extractModelCode(product?.code || product?.title || product?.name);
    if (!/^[A-Z0-9]{10}$/.test(asin) || !code || japanProductBlacklistMatch(product, this.getExcludeKeywords())) return null;
    const registry = this.storage().productRegistry ||= {}, old = registry[asin], at = new Date().toISOString();
    const live = ['web_search', 'aod_verified'].includes(source);
    registry[asin] = { asin, code,
      title: clean((live ? product.title || product.name : old?.title) || product.title || product.name || `BEYBLADE X ${code}`).slice(0, 500),
      imageUrl: safeAmazonImageUrl((live ? product.imageUrl : old?.imageUrl) || product.imageUrl || old?.imageUrl), url: canonicalAmazonJapanUrl(asin),
      sources: [...new Set([...(old?.sources || []), source])].slice(-8), addedAt: old?.addedAt || at,
      lastSeenAt: live ? at : old?.lastSeenAt || '', lastDiscoveredAt: source === 'web_search' ? at : old?.lastDiscoveredAt || '' };
    return registry[asin];
  }

  inventoryRegistry() {
    const storage = this.storage();
    const groups = [ [this.inventorySeeds, 'owner_seed'], [Object.values(storage.brandProducts || {}), 'brand_history'],
      [Object.values(storage.products || {}), 'observed_history'], [Object.values(storage.manualProducts || {}), 'manual_database'],
      [this.getConfig()?.watchProducts || [], 'configured_watch'] ];
    for (const [rows, source] of groups) for (const product of rows) this.registerInventoryProduct(product, source);
    return Object.values(storage.productRegistry || {}).filter(product => !japanProductBlacklistMatch(product, this.getExcludeKeywords()));
  }

  commitInventoryObservation(product, events = new Map()) {
    const storage = this.storage(), old = storage.products[product.asin];
    storage.products[product.asin] = product;
    if (this.continuousInventory) this.registerInventoryProduct(product, 'aod_verified');
    if (!storage.initialized || storage.searchDiscoveryVersion !== 1 || !product.available) return;
    const kind = !old ? 'new' : old.available === false ? 'restock' : '';
    if (!kind || events.has(product.asin)) return;
    events.set(product.asin, { product, kind });
    (storage.pendingAvailabilityNotifications ||= {})[product.asin] = { product: { ...product }, kind };
    try {
      void Promise.resolve(this.onAvailabilitySignal({ ...product }, { source: '日亞自營AOD', kind }))
        .catch(error => this.log(`日亞購買訊號交付失敗（監控繼續）：${error.message}`));
    } catch (error) { this.log(`日亞購買訊號交付失敗（監控繼續）：${error.message}`); }
  }

  async checkInventoryProduct(product, events) {
    const storage = this.storage(), attempts = storage.inventoryAttempts ||= {}, started = Date.now();
    try {
      const verified = { ...await this.verifyOffer(product), lastOfferCheckedAt: new Date().toISOString() };
      if (this.closed || this.operations.getStore()?.generation !== this.generation || this.getConfig()?.enabled === false) {
        throw Object.assign(new Error('日亞唯讀工作已取消'), { code: 'AMAZON_READ_CANCELLED' });
      }
      this.commitInventoryObservation(verified, events);
      attempts[product.asin] = { at: new Date().toISOString(), durationMs: Date.now() - started, status: 'ok',
        httpStatus: 200, decision: verified.diagnostic?.decision || (verified.available ? 'qualified' : 'unavailable') };
      return true;
    } catch (error) {
      if (['AMAZON_RATE_LIMITED', 'AMAZON_VERIFICATION_REQUIRED', 'AMAZON_LOGIN_REQUIRED', 'AMAZON_READ_CANCELLED'].includes(error.code)) throw error;
      attempts[product.asin] = { at: new Date().toISOString(), durationMs: Date.now() - started, status: 'failed',
        httpStatus: error.httpStatus || 0, errorCode: error.code || 'AMAZON_READ_FAILED',
        retryAt: new Date(Date.now() + amazonInventoryRetryMs(error)).toISOString() };
      // Missing/partial pages never erase a prior valid stock observation.
      return false;
    }
  }

  async saveInventory() {
    if (typeof this.state.writeSnapshot === 'function') await this.state.writeSnapshot();
    else await this.state.save();
  }

  deliverInventoryNotifications() {
    if (!Object.keys(this.storage().pendingAvailabilityNotifications || {}).length) return;
    if (Date.parse(this.storage().notificationRetryAt || '') > Date.now()) return;
    void this.flushNotifications().catch(error => this.log(`日亞通知待重試（監控繼續）：${error.message}`));
  }

  async scanInventory() {
    if (this.backgroundRunning) return { skipped: true };
    this.backgroundRunning = true; this.closed = false;
    const storage = this.storage(), events = new Map();
    try {
      await this.ensureSeedSignals();
      const registry = this.inventoryRegistry(), delegated = this.getDelegatedAsins();
      const eligible = amazonInventoryCandidates(registry, storage.inventoryAttempts, delegated);
      const ids = new Set(eligible.map(p => p.asin));
      let cycle = storage.inventoryCycle;
      if (!cycle || !cycle.pending?.length) cycle = storage.inventoryCycle = {
        startedAt: new Date().toISOString(), members: [...ids], pending: [...ids], checked: 0, successful: 0, failed: 0,
        deferred: registry.filter(p => !delegated.has(p.asin) && !ids.has(p.asin)).length,
        delegated: registry.filter(p => delegated.has(p.asin)).length };
      for (const asin of cycle.pending.filter(asin => !ids.has(asin))) cycle[delegated.has(asin) ? 'delegated' : 'deferred']++;
      cycle.pending = cycle.pending.filter(asin => ids.has(asin));
      for (const asin of ids) if (!cycle.members.includes(asin)) { cycle.members.push(asin); cycle.pending.push(asin); }
      const pending = new Set(cycle.pending);
      // One AOD read per scheduler turn, no fixed 30-second rotation gate.
      const product = eligible.find(p => pending.has(p.asin));
      if (product) {
        const success = await this.checkInventoryProduct(product, events);
        cycle.pending = cycle.pending.filter(asin => asin !== product.asin);
        cycle.checked++; cycle[success ? 'successful' : 'failed']++;
      }
      if (!cycle.pending.length) {
        if (cycle.checked) storage.lastInventoryCycle = { startedAt: cycle.startedAt, completedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(cycle.startedAt), checked: cycle.checked, successful: cycle.successful,
          failed: cycle.failed, deferred: cycle.deferred, delegated: cycle.delegated, registryCount: registry.length };
        storage.inventoryCycle = null;
        if (cycle.checked) this.log(`日亞全庫 AOD 輪查完成：商品庫 ${registry.length} 件｜實查 ${cycle.checked} 件｜成功 ${cycle.successful} 件｜失敗 ${cycle.failed} 件｜暫緩 ${cycle.deferred} 件｜單品分擔 ${cycle.delegated} 件｜耗時 ${(storage.lastInventoryCycle.durationMs / 1000).toFixed(1)} 秒。`);
      }
      storage.lastBackgroundScanAt = new Date().toISOString(); storage.lastBackgroundDirectCheckedCount = product ? 1 : 0;
      storage.lastBackgroundError = ''; storage.lastBackgroundErrorCode = '';
      storage.pricingPolicy = 'amazon_retail_aod'; storage.lastKnownCount = Object.keys(storage.products).length;
      await this.saveInventory(); this.deliverInventoryNotifications();
      return { lane: 'background', checkedAt: storage.lastBackgroundScanAt, directCheckedCount: product ? 1 : 0, registryCount: registry.length };
    } catch (error) {
      storage.lastBackgroundError = error.message; storage.lastBackgroundErrorCode = error.code || 'AMAZON_SCAN_FAILED';
      await this.saveInventory(); this.deliverInventoryNotifications(); throw error;
    } finally { this.backgroundRunning = false; }
  }

  async scanDiscovery() {
    if (this.running) return { skipped: true };
    this.running = true; this.closed = false;
    const storage = this.storage(), events = new Map();
    try {
      await this.ensureSeedSignals(); this.inventoryRegistry();
      const beforeCount = Object.keys(storage.productRegistry || {}).length;
      const tick = (Number(storage.inventoryDiscoveryTick) || 0) + 1;
      const urls = [AMAZON_JP_DISCOVERY_URL];
      if (tick % 3 === 0) {
        const page = Math.min(6, Math.max(2, Number(storage.inventoryDiscoveryPage) || 2)), url = new URL(AMAZON_JP_DISCOVERY_URL);
        url.searchParams.set('page', String(page)); urls.push(url.href); storage.inventoryDiscoveryPage = page === 6 ? 2 : page + 1;
      }
      const found = new Map();
      for (const url of urls) {
        const rows = parseAmazonSellerSearch(await this.loadPage(url), url);
        if (this.closed || this.operations.getStore()?.generation !== this.generation || this.getConfig()?.enabled === false) {
          throw Object.assign(new Error('日亞唯讀工作已取消'), { code: 'AMAZON_READ_CANCELLED' });
        }
        if (!rows.length) throw Object.assign(new Error('Amazon.co.jp 新品搜尋回應缺少可解析商品，保留商品庫'), { code: 'AMAZON_SEARCH_UNREADABLE' });
        for (const row of rows) found.set(row.asin, row);
        // Register immediately: a later page error must not lose new ASINs.
        for (const row of rows) this.registerInventoryProduct(row, 'web_search');
      }
      const candidates = [...found.values()].filter(p => p.code && !japanProductBlacklistMatch(p, this.getExcludeKeywords()));
      const now = Date.now(), attempts = storage.inventoryAttempts || {};
      const urgent = amazonInventoryCandidates(candidates, attempts, this.getDelegatedAsins(), now)
        .filter(p => !attempts[p.asin] || now - Date.parse(attempts[p.asin].at) >= 30_000
          && p.available && storage.products[p.asin]?.available !== true).slice(0, 2);
      for (const product of urgent) await this.checkInventoryProduct(product, events);
      storage.inventoryDiscoveryTick = tick; storage.lastSearchCount = found.size; storage.lastCandidateCount = candidates.length;
      storage.lastSearchAsins = [...found.keys()]; storage.lastSearchReadAt = new Date().toISOString();
      storage.lastScanAt = storage.lastSearchReadAt; storage.lastError = ''; storage.lastErrorCode = '';
      storage.lastSearchWarning = candidates.length ? '' : '搜尋結果沒有 BX／CX／UX 型號；已知商品仍由全庫 AOD 獨立輪查';
      storage.lastDirectCheckedCount = urgent.length; storage.initialized = true; storage.searchDiscoveryVersion = 1;
      storage.lastInventoryAddedCount = Object.keys(storage.productRegistry).length - beforeCount;
      this.log(`日亞新品搜尋：讀取 ${found.size} 件｜型號候選 ${candidates.length} 件｜商品庫 ${Object.keys(storage.productRegistry).length} 件｜本輪新增 ${storage.lastInventoryAddedCount} 件｜即時 AOD ${urgent.length} 件。`);
      await this.saveInventory(); this.deliverInventoryNotifications();
      return { lane: 'search', checkedAt: storage.lastScanAt, searchCount: found.size, candidateCount: candidates.length,
        directCheckedCount: urgent.length, registryCount: Object.keys(storage.productRegistry).length, discovered: events.size };
    } catch (error) {
      storage.lastError = error.message; storage.lastErrorCode = error.code || 'AMAZON_SCAN_FAILED';
      await this.saveInventory(); this.deliverInventoryNotifications(); throw error;
    } finally { this.running = false; }
  }

  async scan(options = {}) {
    const lane = options.lane || 'all';
    return this.operations.run({ lane, generation: this.generation }, () => this.continuousInventory && lane === 'background'
      ? this.scanInventory() : this.continuousInventory && lane === 'search' ? this.scanDiscovery() : this.scanLane({ ...options, lane }));
  }

  async scanLane({ forceCatalog = false, lane = 'all', rotateBackground = true } = {}) {
    const flag = lane === 'background' ? 'backgroundRunning' : 'running';
    if (this[flag]) return { skipped: true };
    this[flag] = true;
    this.closed = false;
    const startedAt = Date.now();
    const storage = this.storage();
    // Keep this round's comparison baseline stable while committing each
    // completed observation. A later page failure must not replay a signal
    // already delivered to the independent purchase lane.
    const previous = { ...storage.products };
    const discoveryUpgrade = storage.searchDiscoveryVersion !== 1;
    const availabilityEvents = new Map();
    // Delivery retry is independent of the availability transition: Discord
    // failure must neither lose a notification nor replay a purchase signal.
    const pendingNotifications = storage.pendingAvailabilityNotifications ||= {};
    let notified = 0;
    let notificationsStarted = false;
    const notifyObserved = async () => {
      notificationsStarted = true;
      // Discord delivery may wait, but all purchase signals are already handed
      // off. Also deliver observations if a later page aborts this round.
      if (lane === 'all') notified += await this.flushNotifications();
      else void this.flushNotifications().catch(error => this.log(`日亞通知待重試（監控繼續）：${error.message}`));
    };
    const observe = (product) => {
      const old = storage.products[product.asin];
      storage.products[product.asin] = product;
      if (!storage.initialized || discoveryUpgrade || !product.available) return;
      const kind = !old ? 'new' : old.available === false ? 'restock' : '';
      if (!kind || availabilityEvents.has(product.asin)) return;
      availabilityEvents.set(product.asin, { product, kind });
      pendingNotifications[product.asin] = { product: { ...product }, kind };
      // Handoff immediately, before another product read, a Discord request,
      // or a debounced state save. Never await checkout in the monitoring lane.
      try {
        void Promise.resolve(this.onAvailabilitySignal({ ...product }, { source: '日亞自營AOD', kind }))
          .catch((error) => this.log(`日亞購買訊號交付失敗（監控繼續）：${error.message}`));
      } catch (error) {
        this.log(`日亞購買訊號交付失敗（監控繼續）：${error.message}`);
      }
    };
    try {
      await this.ensureSeedSignals();
      // Historical TT/brand snapshots remain intact but are never refreshed or
      // used as a price gate. Seller search discovers ASINs; AOD confirms offers.
      const catalog = [];
      const brandProducts = storage.brandProducts || {};
      storage.pricingPolicy = 'amazon_retail_aod';
      const normalizeKnownProduct = (product, source) => {
        const asin = clean(product?.asin || extractAmazonAsin(product?.url)).toUpperCase();
        const title = clean(product?.title || product?.name);
        const code = extractModelCode(product?.code || title);
        return {
          ...product,
          asin,
          title: title || `${code || asin} Amazon.co.jp 商品`,
          code,
          url: canonicalAmazonJapanUrl(asin),
          discoverySource: source
        };
      };
      const usableKnownProduct = (product) => Boolean(
        /^[A-Z0-9]{10}$/.test(product.asin)
        && product.code
        && !japanProductBlacklistMatch(product, this.getExcludeKeywords())
      );
      const watchRegistry = new Map();
      for (const product of this.getConfig()?.watchProducts || []) {
        const normalized = normalizeKnownProduct(product, 'configured_watch');
        if (usableKnownProduct(normalized)) watchRegistry.set(normalized.asin, normalized);
      }
      for (const product of Object.values(this.migrateXSignalsToManualProducts(storage))) {
        const normalized = normalizeKnownProduct(product, 'manual_database');
        if (usableKnownProduct(normalized)) watchRegistry.set(normalized.asin, normalized);
      }
      const configuredWatch = [...watchRegistry.values()];
      const pricingCatalog = [];
      const delegated = lane === 'background' ? this.getDelegatedAsins() : new Set();
      const dedicated = lane === 'search' ? { pending: [], successful: 0, observed: [] } : await this.inspectDedicatedPreCatalogProducts(
        configuredWatch.filter(product => !delegated.has(product.asin)),
        catalog,
        pricingCatalog,
        storage,
        observe
      );
      const dedicatedPendingAsins = new Set(dedicated.pending.map((product) => product.asin));
      const searchHtml = lane === 'background' ? '' : await this.loadPage(AMAZON_JP_SEARCH_URL);
      const searchProducts = lane === 'background' ? [] : parseAmazonSellerSearch(searchHtml);
      if (lane !== 'background' && !searchProducts.length) throw Object.assign(new Error('Amazon.co.jp 官方賣家搜尋沒有可解析商品，本輪不更新基線'), { code: 'AMAZON_SEARCH_UNREADABLE', requestKind: 'search' });
      if (lane !== 'background') {
        storage.lastSearchAsins = searchProducts.map(product => product.asin);
        storage.lastSearchReadAt = new Date().toISOString();
        storage.pendingDiscoveries ||= {};
        for (const product of searchProducts) {
          if (product.code && !japanProductBlacklistMatch(product, this.getExcludeKeywords())
            && !previous[product.asin] && !storage.pendingDiscoveries[product.asin]) {
            storage.pendingDiscoveries[product.asin] = { asin: product.asin, code: product.code, title: product.title,
              discoveredAt: storage.lastSearchReadAt, status: 'pending_confirmation' };
          }
        }
        storage.pendingDiscoveries = Object.fromEntries(Object.entries(storage.pendingDiscoveries).slice(-100));
      }
      const blacklist = this.getExcludeKeywords();
      const blacklistedRows = searchProducts.filter((product) => japanProductBlacklistMatch(product, blacklist));
      // The broad seller search is useful for discovering new ASINs, but it is
      // not a complete inventory feed: its first page is often filled with
      // unrelated merchandise.  Known ASINs therefore remain in a persistent
      // registry and are checked directly in small rotating batches.
      const candidateRows = searchProducts.filter((product) => {
        if (!product.code) return false;
        if (japanProductBlacklistMatch(product, blacklist)) return false;
        return true;
      }).sort((a, b) => {
        const priority = product => !previous[product.asin] ? 0 : previous[product.asin].available === false ? 1 : 2;
        return priority(a) - priority(b);
      });
      const observed = new Map(dedicated.observed.map((product) => [product.asin, product]));
      const rejected = blacklistedRows.map((product) => ({
        ...product,
        rejectionReason: `命中日本購物黑名單「${japanProductBlacklistMatch(product, blacklist)}」`
      }));
      for (const product of candidateRows) {
        if (dedicatedPendingAsins.has(product.asin)) continue;
        const old = previous[product.asin];
        const cached = old?.pricingSource === 'amazon_retail_aod' && old.available && product.available
          && Number(old.priceYen) === Number(product.priceYen)
          && Date.now() - Date.parse(old.lastOfferCheckedAt || '') < 30_000;
        // Search never creates proof of stock or refreshes an AOD timestamp.
        const verified = cached ? { ...old, discoverySource: 'amazon_seller_search' }
          : { ...await this.verifyOffer(product), lastOfferCheckedAt: new Date().toISOString() };
        observed.set(verified.asin, verified);
        observe(verified);
        if (storage.pendingDiscoveries?.[verified.asin]) {
          storage.pendingDiscoveries[verified.asin].status = verified.available ? 'confirmed_available' : 'confirmed_unavailable';
          storage.pendingDiscoveries[verified.asin].confirmedAt = new Date().toISOString();
        }
        if (!verified.available) rejected.push(verified);
      }

      const searchAsins = new Set(candidateRows.map((product) => product.asin));
      const watchSelection = roundRobinRows(
        lane === 'search' || !rotateBackground ? [] : configuredWatch.filter((product) => !dedicatedPendingAsins.has(product.asin)),
        storage.watchCursor,
        this.getConfig()?.watchBatchSize || 2
      );
      if (lane !== 'search' && rotateBackground) storage.watchCursor = watchSelection.nextCursor;

      const backgroundRegistry = new Map();
      for (const product of [...Object.values(brandProducts || {}), ...Object.values(previous)]) {
        const normalized = normalizeKnownProduct(product, 'persistent_registry');
        if (!usableKnownProduct(normalized) || searchAsins.has(normalized.asin)
          || configuredWatch.some((item) => item.asin === normalized.asin)) continue;
        const old = backgroundRegistry.get(normalized.asin);
        backgroundRegistry.set(normalized.asin, { ...old, ...normalized });
      }
      const backgroundSelection = roundRobinRows(
        lane === 'search' || !rotateBackground ? [] : [...backgroundRegistry.values()],
        storage.backgroundCursor,
        this.getConfig()?.backgroundBatchSize || 1
      );
      if (lane !== 'search' && rotateBackground) storage.backgroundCursor = backgroundSelection.nextCursor;
      const recentlySearched = lane === 'background' && Date.now() - Date.parse(storage.lastSearchReadAt || '') < 30_000
        ? new Set(storage.lastSearchAsins || []) : new Set();
      storage.lastDelegatedCount = lane === 'background' ? delegated.size : storage.lastDelegatedCount || 0;
      const directRows = [...watchSelection.rows, ...backgroundSelection.rows]
        .filter((product, index, all) => all.findIndex((item) => item.asin === product.asin) === index)
        .filter((product) => !searchAsins.has(product.asin) && !recentlySearched.has(product.asin) && !delegated.has(product.asin));

      for (const product of directRows) {
        try {
          const verified = {
            ...await this.verifyOffer(product),
            discoverySource: product.discoverySource,
            lastOfferCheckedAt: new Date().toISOString()
          };
          observed.set(verified.asin, verified);
          observe(verified);
          if (!verified.available) rejected.push(verified);
        } catch (error) {
          if (error?.code === 'AMAZON_RATE_LIMITED' || error?.code === 'AMAZON_LOADING_SHELL') throw error;
          rejected.push({ ...product, rejectionReason: `AOD 直接核對失敗：${error.message}` });
        }
      }

      const eligible = [...observed.values()].filter((product) => product.available);
      // Observations were committed individually. Never replace the shared
      // registry with an older lane snapshot while the other lane is running.
      const current = storage.products;
      const discovered = [...availabilityEvents.values()].filter(({ kind }) => kind === 'new').length;
      const restocked = [...availabilityEvents.values()].filter(({ kind }) => kind === 'restock').length;
      await notifyObserved();
      if (lane !== 'background') {
        storage.initialized = true;
        storage.searchDiscoveryVersion = 1;
      }
      storage.products = current;
      const checkedAt = new Date().toISOString();
      if (lane === 'background') storage.lastBackgroundScanAt = checkedAt;
      else storage.lastScanAt = checkedAt;
      if (lane !== 'background') storage.lastSearchCount = searchProducts.length;
      if (lane !== 'background') {
        storage.lastExcludedCount = blacklistedRows.length;
        storage.lastCandidateCount = candidateRows.length;
      }
      storage[lane === 'background' ? 'lastBackgroundDirectCheckedCount' : 'lastDirectCheckedCount'] = directRows.length + dedicated.pending.length;
      storage.lastKnownCount = Object.keys(current).length;
      storage.lastEligibleCount = eligible.length;
      storage[lane === 'background' ? 'lastBackgroundRejected' : 'lastRejected'] = rejected.slice(0, 30).map((product) => ({
        asin: product.asin,
        code: product.code,
        title: product.title,
        reason: product.rejectionReason
      }));
      storage[lane === 'background' ? 'lastBackgroundError' : 'lastError'] = '';
      storage[lane === 'background' ? 'lastBackgroundErrorCode' : 'lastErrorCode'] = '';
      await this.state.save();
      const lastBrandSnapshotCount = storage.lastBrandSnapshotCount || Object.keys(brandProducts).length;
      this.log(`日亞自營AOD${lane === 'background' ? '背景複查' : ''}：AOD 自營報價、優先直查 ${dedicated.pending.length} 件（成功 ${dedicated.successful} 件）、品牌 ASIN 基線 ${Object.keys(brandProducts).length} 件（最近品牌頁 ${lastBrandSnapshotCount} 件）、Amazon.co.jp 搜尋 ${searchProducts.length} 件、搜尋候選 ${candidateRows.length} 件、一般直接核對 ${directRows.length} 件、單品任務分擔 ${delegated.size} 件、已知商品 ${Object.keys(current).length} 件、合格 ${eligible.length} 件、通知 ${notified} 則。`);
      return {
        checkedAt,
        lane,
        catalogCount: catalog.length,
        brandAsinCount: Object.keys(brandProducts).length,
        searchCount: searchProducts.length,
        excludedCount: blacklistedRows.length,
        candidateCount: candidateRows.length,
        directCheckedCount: directRows.length + dedicated.pending.length,
        dedicatedPendingCount: dedicated.pending.length,
        dedicatedSuccessfulCount: dedicated.successful,
        knownCount: Object.keys(current).length,
        eligibleCount: eligible.length,
        discovered,
        restocked,
        notified,
        xSignalCount: Object.keys(storage.xSignals || {}).length,
        durationMs: Date.now() - startedAt,
        eligible: eligible.map((item) => ({ asin: item.asin, code: item.code, title: item.title, priceYen: item.priceYen, msrpYen: item.msrpYen }))
      };
    } catch (error) {
      storage[lane === 'background' ? 'lastBackgroundAttemptAt' : 'lastAttemptAt'] = new Date().toISOString();
      storage[lane === 'background' ? 'lastBackgroundError' : 'lastError'] = error.message;
      storage[lane === 'background' ? 'lastBackgroundErrorCode' : 'lastErrorCode'] = error.code || 'AMAZON_SCAN_FAILED';
      await this.state.save();
      if (!notificationsStarted) {
        await notifyObserved().catch((notificationError) => this.log(`日亞部分掃描通知失敗：${notificationError.message}`));
        await this.state.save();
      }
      if (error?.code === 'AMAZON_RATE_LIMITED' || error?.code === 'AMAZON_LOADING_SHELL'
        || /Timeout|頁面.*關閉|context.*closed/i.test(error.message)) {
        if (lane === 'all') await this.close();
        else {
          await this.lanePages.get(lane)?.close().catch(() => {});
          this.lanePages.delete(lane);
        }
      }
      throw error;
    } finally {
      this[flag] = false;
    }
  }

  status() {
    const storage = this.storage();
    this.migrateXSignalsToManualProducts(storage);
    const configuredWatch = new Map(
      (this.getConfig()?.watchProducts || []).map((product) => [clean(product.asin).toUpperCase(), product])
    );
    const enrichProduct = (entry) => {
      const asin = clean(entry.asin).toUpperCase();
      const product = storage.products?.[asin]
        || storage.brandProducts?.[asin]
        || configuredWatch.get(asin)
        || {};
      const code = extractModelCode(product.code || product.title || entry.code || entry.title);
      const catalogItem = matchTakaraTomyCatalog({
        code,
        title: product.title || entry.title || ''
      }, storage.catalog || []);
      return {
        ...entry,
        code,
        title: clean(product.title || entry.title || catalogItem?.name || `ASIN ${asin}`),
        imageUrl: clean(product.imageUrl || entry.imageUrl),
        productUrl: canonicalAmazonJapanUrl(asin),
        catalogConfirmed: Boolean(catalogItem),
        msrpYen: catalogItem?.msrpYen || product.msrpYen || null
      };
    };
    const xSignals = Object.values(storage.xSignals || {}).map(enrichProduct);
    const manualProducts = Object.values(storage.manualProducts || {})
      .map(enrichProduct)
      .sort((a, b) => Date.parse(b.addedAt || b.updatedAt || 0) - Date.parse(a.addedAt || a.updatedAt || 0));
    const now = Date.now(), delegated = this.getDelegatedAsins();
    const inventoryProducts = Object.values(storage.productRegistry || {})
      .filter(p => !japanProductBlacklistMatch(p, this.getExcludeKeywords()))
      .map(p => {
        const observed = storage.products[p.asin], attempt = storage.inventoryAttempts?.[p.asin];
        return { ...p, attempt: attempt || null, delegated: delegated.has(p.asin),
          available: observed?.pricingSource === 'amazon_retail_aod' ? observed.available : null,
          priceYen: observed?.pricingSource === 'amazon_retail_aod' ? observed.priceYen : null,
          lastOfferCheckedAt: observed?.lastOfferCheckedAt || '' };
      }).sort((a, b) => a.code.localeCompare(b.code) || a.asin.localeCompare(b.asin));
    const ages = inventoryProducts.map(p => Date.parse(p.lastOfferCheckedAt)).filter(Number.isFinite);
    const inventory = { version: 1, trackedCount: inventoryProducts.length,
      neverVerified: inventoryProducts.filter(p => !p.lastOfferCheckedAt).length,
      failedCount: inventoryProducts.filter(p => p.attempt?.status === 'failed').length,
      deferredCount: inventoryProducts.filter(p => Date.parse(p.attempt?.retryAt || '') > now).length,
      delegatedCount: inventoryProducts.filter(p => p.delegated).length,
      oldestOfferAgeSeconds: ages.length ? Math.max(0, Math.round((now - Math.min(...ages)) / 1000)) : null,
      currentCycle: storage.inventoryCycle ? { startedAt: storage.inventoryCycle.startedAt,
        total: storage.inventoryCycle.members.length, checked: storage.inventoryCycle.checked,
        pending: storage.inventoryCycle.pending.length, failed: storage.inventoryCycle.failed } : null,
      lastCycle: storage.lastInventoryCycle || null };
    return {
      ...storage, pricingPolicy: 'amazon_retail_aod', ttCatalogEnabled: false,
      continuousInventory: this.continuousInventory, inventory, inventoryProducts,
      productRegistry: undefined, inventoryAttempts: undefined, inventoryCycle: undefined,
      archivedCatalogCount: storage.catalog?.length || 0,
      backgroundScanning: this.backgroundRunning,
      notificationSending: Boolean(this.notificationPromise),
      readScheduler: this.readScheduler?.status() || null,
      catalogCount: storage.catalog?.length || 0,
      brandAsinCount: Object.keys(storage.brandProducts || {}).length,
      xSignalCount: Object.keys(storage.xSignals || {}).length,
      manualProductCount: manualProducts.length,
      products: undefined,
      catalog: undefined,
      brandProducts: undefined,
      manualProducts,
      xSignals: xSignals.sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)).slice(0, 12)
    };
  }

  async close() {
    this.closed = true;
    this.generation++;
    await this.context?.close().catch(() => {});
    this.lanePages.clear();
    this.context = null;
    this.contextPromise = null;
    this.page = null;
    this.locationReady = false;
  }
}
