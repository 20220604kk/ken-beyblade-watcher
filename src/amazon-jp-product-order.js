import fs from 'node:fs/promises';
import path from 'node:path';
import { AmazonOrderHistory } from './amazon-order-history.js';
import { chromium } from 'playwright';
import {
  AMAZON_JP_SELLER_ID,
  amazonJapanPageIssue,
  canonicalAmazonJapanUrl,
  extractAmazonAsin,
  extractModelCode,
  isAmazonPriceWithinMsrp,
  matchTakaraTomyCatalog,
  parseYen
} from './amazon-jp-monitor.js';
import {
  advanceAmazonJpCheckout,
  clickAndWaitForAmazonNavigation,
  firstVisible,
  parseAmazonJpCheckoutSnapshot
} from './amazon-jp-single-order.js';

const LOGIN_PATH = /\/(?:ap\/signin|ap\/mfa|gp\/css\/homepage)/i;
const PURCHASE_LIMIT_WORDS = /(?:已达到|已達到|已达|已達).*?(?:卖家|賣家).*?(?:采购|採購|购买|購買).*?(?:上限|限制)|購入数の上限|購入数量制限|maximum purchase quantity/i;
export const AMAZON_PRODUCT_POLL_MS = 5_000;

export function normalizeAmazonJpProductMode(value) {
  return value === 'hybrid' ? 'hybrid' : 'scan_signal';
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeAmazonJpProductUrl(value) {
  const asin = extractAmazonAsin(value);
  if (!asin) throw new Error('請貼上有效的 Amazon.co.jp 商品頁網址（需包含 /dp/ASIN）');
  return canonicalAmazonJapanUrl(asin);
}

export function resolveAmazonJpMsrp({ asin, title, catalog = [], manualProducts = {} } = {}) {
  const manual = manualProducts?.[asin];
  const manualMsrpYen = Number(manual?.manualMsrpYen || manual?.msrpYen);
  if (Number.isFinite(manualMsrpYen) && manualMsrpYen > 0) {
    return { code: manual.code || extractModelCode(title), msrpYen: manualMsrpYen, source: 'manual' };
  }
  const matched = matchTakaraTomyCatalog({ title, code: extractModelCode(title) }, catalog);
  return matched ? { code: matched.code, msrpYen: matched.msrpYen, source: 'catalog' } : null;
}

export function evaluateAmazonJpProductOrder(snapshot, msrp, toleranceYen = 1) {
  if (snapshot.pageIssue === 'rate_limited') return { eligible: false, reason: 'rate_limited' };
  if (snapshot.pageIssue === 'not_found') return { eligible: false, reason: 'page_not_found' };
  // Only explicit Amazon login evidence may stop the task. A blank account
  // label is common on partially rendered/throttled product pages and is not
  // proof that the persistent profile was signed out.
  if (snapshot.loginRequired) return { eligible: false, reason: 'login_required' };
  if (snapshot.pageIssue) return { eligible: false, reason: 'product_unreadable' };
  if (!snapshot.buyNowAvailable && !snapshot.addCartAvailable) return { eligible: false, reason: 'not_purchasable' };
  if (!msrp?.msrpYen) return { eligible: false, reason: 'msrp_not_found' };
  if (snapshot.purchaseLimited) return { eligible: false, reason: 'purchase_limited' };
  if (!snapshot.sellerConfirmed) return { eligible: false, reason: 'seller_not_amazon' };
  if (!snapshot.priceYen) return { eligible: false, reason: snapshot.priceText ? 'non_jpy_price' : 'price_missing' };
  if (!isAmazonPriceWithinMsrp(snapshot.priceYen, msrp.msrpYen, toleranceYen)) return { eligible: false, reason: 'above_msrp' };
  if (!snapshot.buyNowAvailable && !snapshot.addCartAvailable) return { eligible: false, reason: 'not_purchasable' };
  return { eligible: true, reason: 'qualified' };
}

export function matchesAmazonJpPurchaseSignal(config, product, { source, kind } = {}) {
  if (!config?.enabled) return false;
  if (source !== '日亞官方原價' || !['new', 'restock'].includes(kind)) return false;
  const targetAsin = extractAmazonAsin(config.targetUrl);
  const signalAsin = clean(product?.asin).toUpperCase();
  if (!targetAsin || targetAsin !== signalAsin) return false;
  return product?.available === true
    && product?.sellerConfirmed === true
    && isAmazonPriceWithinMsrp(product?.priceYen, product?.msrpYen, config.priceToleranceYen ?? 1);
}

export class AmazonJpProductOrderMonitor {
  constructor({ dataDir, state, getConfig, slot = 'A', storageKey, profileName, onTerminal = async () => {}, notifyPrivate = async () => {}, log = () => {}, orderHistory, checkoutRunner = advanceAmazonJpCheckout, persistentContextLauncher = (userDataDir, options) => chromium.launchPersistentContext(userDataDir, options) }) {
    this.state = state;
    this.getConfig = getConfig;
    this.onTerminal = onTerminal;
    this.notifyPrivate = notifyPrivate;
    this.log = log;
    this.slot = String(slot || 'A').toUpperCase();
    this.storageKey = storageKey || 'amazonJpProductOrder';
    this.checkoutRunner = checkoutRunner;
    this.persistentContextLauncher = persistentContextLauncher;
    this.profileDirectory = path.join(dataDir, 'auto-purchase', 'browser-profiles', profileName || `amazon-jp-product-order-${this.slot.toLowerCase()}`);
    this.context = null;
    this.page = null;
    this.headless = null;
    this.running = false;
    this.interactive = false;
    this.timer = null;
    this.nextAttemptAt = null;
    this.pendingSignal = null;
    this.taskClock = 0;
    this.stopped = false;
    this.phase = 'idle';
    this.browserOperation = false;
    this.failureCount = 0;
    this.orderHistory = orderHistory || new AmazonOrderHistory(dataDir, { log });
    this.activeOrderRecord = null;
    this.currentScanSteps = [];
  }

  mode() { return normalizeAmazonJpProductMode(this.getConfig()?.mode); }

  waitingStatus() { return this.mode() === 'hybrid' ? 'waiting_poll' : 'waiting_signal'; }

  assertIdle() {
    if (this.running || this.browserOperation) throw new Error('商品頁正在檢查或結帳，請等本次完成後再變更設定／開啟登入視窗');
  }

  canSchedule() {
    return !this.stopped && this.getConfig()?.enabled && !this.interactive && !this.browserOperation
      && !['completed', 'needs_review', 'needs_login'].includes(this.storage().status);
  }

  rearm() {
    if (this.running || this.timer || !this.canSchedule()) return;
    const cooldown = Math.max(0, Date.parse(this.storage().backoffUntil || '') - Date.now()) || 0;
    if (this.pendingSignal) this.scheduleNext(cooldown);
    else if (this.mode() === 'hybrid') {
      // Start-to-start target; slow requests never overlap or create catch-up bursts.
      const delay = Math.max(250, AMAZON_PRODUCT_POLL_MS - (Date.now() - this.taskClock));
      this.scheduleNext(Math.max(delay, cooldown));
    }
  }

  setBackoff(milliseconds) {
    const until = Math.max(Date.parse(this.storage().backoffUntil || '') || 0, Date.now() + milliseconds);
    this.storage().backoffUntil = new Date(until).toISOString();
  }

  storage() {
    this.state.data.commerce ||= {};
    this.state.data.commerce[this.storageKey] ||= { status: 'idle', refreshCount: 0, stepLog: [] };
    const storage = this.state.data.commerce[this.storageKey];
    storage.completedCount = Math.max(0, Number(storage.completedCount) || 0);
    storage.stepLog = Array.isArray(storage.stepLog) ? storage.stepLog.slice(-60) : [];
    return storage;
  }

  amazonStorage() {
    this.state.data.commerce ||= {};
    return this.state.data.commerce.amazonJp || {};
  }

  async recordStep(name, detail = {}) {
    const storage = this.storage();
    const now = Date.now();
    const step = {
      name,
      at: new Date(now).toISOString(),
      elapsedMs: this.taskClock ? now - this.taskClock : 0,
      ...detail
    };
    storage.stepLog.push(step);
    this.currentScanSteps.push(step);
    this.currentScanSteps = this.currentScanSteps.slice(-60);
    if (this.activeOrderRecord) await this.orderHistory.step(this.activeOrderRecord, step);
    storage.stepLog = storage.stepLog.slice(-60);
    await this.state.save();
  }

  async resetProgress() {
    this.assertIdle();
    this.stop();
    this.failureCount = 0;
    const storage = this.storage();
    Object.assign(storage, {
      completedCount: 0,
      refreshCount: 0,
      status: 'idle',
      lastError: '',
      lastErrorNotifiedKey: '',
      taskStartedAt: new Date().toISOString(),
      stepLog: []
    });
    for (const key of ['lastCheckedAt', 'lastSnapshot', 'triggeredAt', 'lastOrderStatus', 'lastOrderAt', 'resultUrl', 'completedAt', 'lastFailureNotifiedAt', 'targetAsin', 'lastSignalSource', 'lastSignalMatchedAt', 'lastSignalF5LatencyMs', 'lastSignalKind', 'lastSignalPriceYen', 'backoffUntil', 'lastTrigger']) delete storage[key];
    await this.state.save();
  }

  async sendPrivateAndRecord(message, kind) {
    const storage = this.storage();
    try {
      const result = await this.notifyPrivate(message, { discordAudience: 'private' });
      storage.lastNotificationStatus = 'sent';
      storage.lastNotificationId = String(result?.id || result || '');
      storage.lastNotificationError = '';
    } catch (error) {
      storage.lastNotificationStatus = 'failed';
      storage.lastNotificationError = error.message;
    }
    storage.lastNotificationKind = kind;
    storage.lastNotificationAt = new Date().toISOString();
    if (this.activeOrderRecord) await this.orderHistory.notification(this.activeOrderRecord, {
      status: storage.lastNotificationStatus, at: storage.lastNotificationAt, error: storage.lastNotificationError
    });
    await this.state.save();
  }

  async contextFor(headless) {
    if (this.context && this.headless !== headless) await this.closeBrowser();
    if (this.context) return this.context;
    await fs.mkdir(this.profileDirectory, { recursive: true });
    this.context = await this.persistentContextLauncher(this.profileDirectory, {
      headless,
      channel: 'chrome',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      timeout: 15_000,
      args: ['--disable-blink-features=AutomationControlled']
    });
    await this.context.addCookies([
      { name: 'i18n-prefs', value: 'JPY', domain: '.amazon.co.jp', path: '/' },
      { name: 'lc-main', value: 'ja_JP', domain: '.amazon.co.jp', path: '/' }
    ]);
    this.headless = headless;
    this.context.once('close', () => { this.context = null; this.page = null; this.headless = null; });
    return this.context;
  }

  async pageFor(headless) {
    const context = await this.contextFor(headless);
    if (!this.page || this.page.isClosed()) this.page = context.pages().find((page) => !page.isClosed()) || await context.newPage();
    return this.page;
  }

  async productSnapshot(page, status = 200) {
    // Missing prices/buttons are normal when sold out. Read one DOM snapshot,
    // never await four absent locators (4 x the default 30-second timeout).
    let deadline;
    let raw;
    try {
      raw = await Promise.race([
        page.evaluate(() => {
          const text = (selector) => document.querySelector(selector)?.textContent || '';
          const visibleButton = (selectors) => selectors.some((selector) => {
            const element = document.querySelector(selector);
            if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
            const style = getComputedStyle(element);
            return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
          });
          const prices = ['#corePrice_feature_div .a-price .a-offscreen', '#apex_desktop .priceToPay .a-offscreen', '#apex_desktop .a-price .a-offscreen', '#desktop_buybox .a-price .a-offscreen'];
          return {
            bodyText: document.body?.innerText || '', pageTitle: document.title,
            title: text('#productTitle'),
            accountText: text('#nav-link-accountList-nav-line-1, #nav-link-accountList .nav-line-1'),
            priceText: prices.map(text).find((value) => value.trim()) || '',
            merchantValues: Array.from(document.querySelectorAll('input[name="merchantID"], input[name="merchantId"], input[name="offeringID.1"]'), (item) => `${item.name || ''}:${item.value || ''}`),
            buyNowAvailable: visibleButton(['#buy-now-button', 'input[name="submit.buy-now"]']),
            addCartAvailable: visibleButton(['#add-to-cart-button', 'input[name="submit.add-to-cart"]'])
          };
        }),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('商品頁資料讀取超過 3 秒，已中止本次檢查')), 3_000); })
      ]);
    } catch (error) {
      await page.close?.().catch(() => {});
      throw error;
    } finally { clearTimeout(deadline); }
    const { merchantValues, buyNowAvailable, addCartAvailable } = raw;
    const bodyText = clean(raw.bodyText);
    const pageTitle = clean(raw.pageTitle);
    const title = clean(raw.title);
    const accountText = clean(raw.accountText);
    const loginWords = /(?:サインイン|ログイン|请登录|請登入|登录|登入|Sign[- ]?in)/i;
    const signedIn = accountText ? !loginWords.test(accountText) : null;
    const priceText = clean(raw.priceText);
    const sellerConfirmed = merchantValues.some((value) => value.includes(AMAZON_JP_SELLER_ID))
      || /(?:販売元|出品者|卖家|賣家|Seller)\s*[:：]?\s*(?:Amazon\.co\.jp|アマゾンジャパン)/i.test(bodyText);
    const pageIssue = amazonJapanPageIssue({ status, title: pageTitle, body: bodyText, html: bodyText }) || (!title ? 'product_unreadable' : '');
    return {
      url: page.url(),
      asin: extractAmazonAsin(page.url()) || extractAmazonAsin(this.getConfig()?.targetUrl),
      title,
      code: extractModelCode(title),
      priceText,
      priceYen: parseYen(priceText),
      sellerConfirmed,
      purchaseLimited: PURCHASE_LIMIT_WORDS.test(bodyText),
      buyNowAvailable,
      addCartAvailable,
      accountText,
      signedIn,
      loginRequired: LOGIN_PATH.test(page.url()) || loginWords.test(accountText) || loginWords.test(pageTitle) && !title,
      pageIssue
    };
  }

  async checkoutSnapshot(page) {
    const titles = await page.locator('[id^="item-block-product-title-"]:visible, [id^="checkout-item-block-item-primary-title-"]:visible, .lineitem-title-text:visible').allTextContents().catch(() => []);
    const quantityText = await page.locator('[data-a-selector="inner-value"]').first().textContent().catch(() => '');
    const asins = await page.locator('a[href*="/dp/"], a[href*="/gp/product/"]').evaluateAll((links) => links.map((link) => link.href)).catch(() => []);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const sellerLinkConfirmed = await page.locator(`a[href*="seller=${AMAZON_JP_SELLER_ID}"]`).count().catch(() => 0) > 0;
    const sellerTextConfirmed = /(?:卖家|賣家|販売元|出品者|Seller)\s*[:：]?\s*(?:Amazon\.co\.jp|アマゾンジャパン)/i.test(bodyText);
    return parseAmazonJpCheckoutSnapshot({ url: page.url(), bodyText, titles, quantityText, asins, sellerConfirmed: sellerLinkConfirmed || sellerTextConfirmed });
  }

  resolveMsrp(snapshot) {
    const amazon = this.amazonStorage();
    return resolveAmazonJpMsrp({
      asin: snapshot.asin,
      title: snapshot.title,
      catalog: amazon.catalog || [],
      manualProducts: amazon.manualProducts || {}
    });
  }

  async openLogin() {
    this.assertIdle();
    const targetUrl = normalizeAmazonJpProductUrl(this.getConfig()?.targetUrl);
    this.stop();
    this.browserOperation = true;
    try {
      await this.closeBrowser();
      const page = await this.pageFor(false);
      this.interactive = true;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { message: '日亞商品頁專用視窗已開啟；登入期間暫停自動刷新，完成登入檢查後依所選模式恢復。' };
    } finally { this.browserOperation = false; }
  }

  async completeLogin() {
    this.assertIdle();
    if (!this.interactive || !this.page || this.page.isClosed()) throw new Error('目前沒有日亞商品頁登入視窗，請先按「開啟專用視窗」');
    this.browserOperation = true;
    try {
    const snapshot = await this.productSnapshot(this.page);
    if (snapshot.loginRequired || !snapshot.signedIn) return { ok: false, message: `尚未辨識到日亞帳號登入完成${snapshot.accountText ? `（目前顯示：${snapshot.accountText}）` : ''}；請按右上角登入，視窗會保持開啟。` };
    if (!snapshot.asin) return { ok: false, message: '已登入，但目前不是 Amazon.co.jp 商品頁。' };
    const storage = this.storage();
    storage.loginVerifiedAt = new Date().toISOString();
    if (storage.status !== 'needs_review') storage.status = 'ready';
    await this.state.save();
    this.interactive = false;
    await this.closeBrowser();
    this.browserOperation = false;
    await this.start();
    return { ok: true, message: `日亞登入與商品頁已確認：${snapshot.title || snapshot.asin}。` };
    } finally { this.browserOperation = false; }
  }

  async requestPurchaseFromSignal(product, { source, kind } = {}) {
    const config = this.getConfig() || {};
    if (!config.enabled) return { matched: false, reason: 'disabled' };
    if (this.stopped || this.interactive || this.browserOperation) return { matched: false, reason: 'paused_for_login_or_stop' };
    if (!matchesAmazonJpPurchaseSignal(config, product, { source, kind })) {
      return { matched: false, reason: 'not_verified_matching_amazon_offer' };
    }
    const targetAsin = extractAmazonAsin(config.targetUrl);
    const storage = this.storage();
    if (storage.completedCount >= Math.max(1, Number(config.targetSuccessCount) || 1)) {
      return { matched: true, queued: false, reason: 'already_completed' };
    }
    if (storage.status === 'needs_review') {
      return { matched: true, queued: false, reason: 'order_needs_review' };
    }
    if (storage.status === 'needs_login') return { matched: true, queued: false, reason: 'login_required' };
    if (this.pendingSignal || storage.status === 'ordering') {
      return { matched: true, queued: false, reason: 'already_processing_signal' };
    }
    const matchedAt = Date.now();
    storage.lastSignalSource = source;
    storage.lastSignalMatchedAt = new Date(matchedAt).toISOString();
    storage.lastSignalKind = kind;
    storage.lastSignalPriceYen = Number(product.priceYen);
    storage.lastErrorNotifiedKey = '';
    storage.status = 'queued';
    this.pendingSignal = { asin: targetAsin, code: clean(product.code).toUpperCase(), source, kind, matchedAt };
    // A signal replaces the five-second timer. During a check it coalesces into
    // one follow-up; during checkout it is rejected above, never refreshes it.
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = null;
    this.rearm();
    await this.state.save();
    this.log(`日亞商品頁收到 ${source} 的 ${kind} 原價自營訊號：${targetAsin}，已排入單次商品頁驗證與下單。`);
    return { matched: true, queued: true, asin: targetAsin };
  }

  async clickQualifiedOffer(page, snapshot, msrp) {
    const buyNow = await firstVisible(page, ['#buy-now-button', 'input[name="submit.buy-now"]']);
    if (buyNow) {
      await this.recordStep('buy_now_click', { asin: snapshot.asin, priceYen: snapshot.priceYen });
      await clickAndWaitForAmazonNavigation(page, buyNow);
      return;
    }
    const addCart = await firstVisible(page, ['#add-to-cart-button', 'input[name="submit.add-to-cart"]']);
    if (!addCart) throw new Error('原價自營條件成立，但商品頁找不到立即購買或加入購物車按鈕');
    await this.recordStep('add_cart_click', { asin: snapshot.asin, priceYen: snapshot.priceYen });
    await clickAndWaitForAmazonNavigation(page, addCart);
    const checkoutButton = await firstVisible(page, [
      '#sc-buy-box-ptc-button input', 'input[name="proceedToRetailCheckout"]',
      'a[href*="/checkout/"]', 'button:has-text("レジに進む")', 'button:has-text("进入结算")'
    ]);
    if (!checkoutButton) throw new Error('商品已加入購物車，但找不到前往結帳按鈕');
    await this.recordStep('proceed_checkout', { asin: snapshot.asin });
    await clickAndWaitForAmazonNavigation(page, checkoutButton);
    const checkout = await this.checkoutSnapshot(page);
    if (checkout.itemCount !== 1 || checkout.asin && checkout.asin !== snapshot.asin) {
      throw new Error(`購物車隔離檢查失敗：目前辨識到 ${checkout.itemCount} 項，為避免混單不送出`);
    }
  }

  async scanOnce({ purchase = false, signal = null, trigger = 'manual' } = {}) {
    if (this.running || this.browserOperation) return { skipped: true };
    if (this.storage().status === 'needs_review') return { skipped: true, reason: 'order_needs_review' };
    if (purchase && (!this.canSchedule() || this.storage().status === 'ordering')) return { skipped: true, reason: 'task_paused' };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = null;
    this.running = true;
    this.phase = purchase ? 'checking' : 'inspecting';
    this.taskClock = Date.now();
    this.currentScanSteps = [];
    this.activeOrderRecord = null;
    const storage = this.storage();
    let submitted = false;
    let attemptedPurchase = false;
    try {
      const config = this.getConfig() || {};
      const targetSuccessCount = Math.max(1, Number(config.targetSuccessCount) || 1);
      if (storage.completedCount >= targetSuccessCount) {
        storage.status = 'completed';
        await this.state.save();
        await this.onTerminal({ status: 'already_completed' });
        this.stop();
        return { status: 'completed', skipped: true };
      }
      const targetUrl = normalizeAmazonJpProductUrl(config.targetUrl);
      const targetAsin = extractAmazonAsin(targetUrl);
      const polling = trigger === 'poll' && this.mode() === 'hybrid';
      if (purchase && (!config.enabled || !(polling || signal?.asin === targetAsin))) {
        return { skipped: true, reason: 'missing_matching_signal' };
      }
      const cooldown = (Date.parse(storage.backoffUntil || '') || 0) - Date.now();
      if (cooldown > 0) return { skipped: true, reason: 'cooling_down' };
      storage.lastTrigger = signal ? 'scan_signal' : polling ? 'poll' : 'manual';
      const page = await this.pageFor(!this.interactive);
      if (signal) storage.lastSignalF5LatencyMs = Math.max(0, Date.now() - signal.matchedAt);
      await this.recordStep('refresh_start', { asin: extractAmazonAsin(targetUrl) });
      const response = page.url() === targetUrl
        ? await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
        : await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if ([429, 503].includes(response?.status())) {
        const retryAfter = response.headers?.()['retry-after'];
        const seconds = Number(retryAfter);
        const retryMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter || '') - Date.now();
        this.setBackoff(Math.max(60_000, Number.isFinite(retryMs) ? retryMs : 0));
        throw Object.assign(new Error(`Amazon.co.jp HTTP ${response.status()}，已降速等待後重試`), { code: 'AMAZON_RATE_LIMITED' });
      }
      await page.waitForTimeout(250);
      const snapshot = await this.productSnapshot(page, response?.status() || 200);
      const msrp = this.resolveMsrp(snapshot);
      const productMismatch = snapshot.asin !== targetAsin
        || Boolean(signal?.code && snapshot.code && signal.code !== snapshot.code);
      const evaluation = productMismatch
        ? { eligible: false, reason: 'product_mismatch' }
        : evaluateAmazonJpProductOrder(snapshot, msrp, config.priceToleranceYen ?? 1);
      Object.assign(storage, {
        targetAsin: snapshot.asin,
        refreshCount: Number(storage.refreshCount || 0) + 1,
        lastCheckedAt: new Date().toISOString(),
        lastSnapshot: { ...snapshot, msrpYen: msrp?.msrpYen || null, msrpSource: msrp?.source || '', evaluation: evaluation.reason },
        lastError: ''
      });
      await this.recordStep('product_evaluated', { asin: snapshot.asin, result: evaluation.reason, priceYen: snapshot.priceYen, msrpYen: msrp?.msrpYen || null });
      if (evaluation.reason === 'rate_limited') throw Object.assign(new Error('Amazon.co.jp 回傳真正的流量限制或驗證頁'), { code: 'AMAZON_RATE_LIMITED' });
      if (evaluation.reason === 'login_required') throw Object.assign(new Error('日亞商品頁專用瀏覽器尚未登入或登入已失效；請完成登入檢查'), { code: 'AMAZON_LOGIN_REQUIRED' });
      if (['page_not_found', 'product_unreadable'].includes(evaluation.reason)) {
        throw new Error(evaluation.reason === 'page_not_found' ? '日亞商品頁不存在或暫時無法讀取' : '商品頁尚未完整載入，暫停後重新檢查');
      }
      this.failureCount = 0;
      delete storage.backoffUntil;
      if (!purchase) {
        storage.status = config.enabled ? this.waitingStatus() : 'idle';
        await this.state.save();
        return { status: 'inspected_only', snapshot: storage.lastSnapshot };
      }
      if (!evaluation.eligible) {
        storage.status = evaluation.reason === 'purchase_limited' ? 'purchase_limited' : this.waitingStatus();
        if (evaluation.reason === 'purchase_limited') this.setBackoff(60_000);
        // Ordinary five-second sold-out checks stay quiet; a verified restock
        // signal that lost its offer is a real failed attempt worth reporting.
        if (signal) {
          const reasons = {
            not_purchasable: '進入商品頁後已無可用購買按鈕', seller_not_amazon: '未能確認 Amazon.co.jp 自營報價',
            price_missing: '未讀到價格', above_msrp: '價格已高於原價容許範圍', non_jpy_price: '未讀到日圓價格',
            purchase_limited: '帳號已達限購', msrp_not_found: '找不到官方定價', product_mismatch: '商品與目標不符'
          };
          await this.sendPrivateAndRecord(`❌ 日亞商品頁補貨訊號觸發後未能購買｜${snapshot.title || targetAsin}｜原因：${reasons[evaluation.reason] || evaluation.reason}｜${this.mode() === 'hybrid' ? '依雙線模式繼續檢查' : '等待下一次補貨訊號'}`, 'failure');
        }
        await this.state.save();
        return { status: storage.status, snapshot: storage.lastSnapshot };
      }
      // Settings/stop may change across asynchronous page operations. Never
      // convert a cancelled check into a purchase, or buy the old target.
      if (this.stopped || !this.getConfig()?.enabled || extractAmazonAsin(this.getConfig()?.targetUrl) !== targetAsin) {
        return { skipped: true, reason: 'task_cancelled' };
      }
      this.pendingSignal = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.nextAttemptAt = null;
      this.phase = 'ordering';
      attemptedPurchase = true;
      storage.status = 'ordering';
      storage.triggeredAt = new Date().toISOString();
      await this.state.save();
      this.activeOrderRecord = await this.orderHistory.begin({
        slot: this.slot, mode: this.mode(), trigger: storage.lastTrigger,
        signalAt: signal?.matchedAt ? new Date(signal.matchedAt).toISOString() : null,
        scanStartedAt: new Date(this.taskClock).toISOString(), taskStartedAt: storage.taskStartedAt,
        snapshot, msrpYen: msrp?.msrpYen, steps: this.currentScanSteps
      });
      await this.clickQualifiedOffer(page, snapshot, msrp);
      const result = await this.checkoutRunner(
        page,
        (targetPage) => this.checkoutSnapshot(targetPage),
        (name, detail) => {
          if (name === 'submit_order') submitted = true;
          return this.recordStep(name, detail);
        }
      );
      const confirmed = result.status === 'ordered';
      await this.orderHistory.finish(this.activeOrderRecord, { status: result.status, orderId: result.snapshot.orderId });
      if (confirmed) storage.completedCount += 1;
      const taskComplete = confirmed && storage.completedCount >= targetSuccessCount;
      Object.assign(storage, {
        status: taskComplete ? 'completed' : confirmed ? this.waitingStatus() : 'needs_review',
        lastOrderStatus: result.status,
        lastOrderAt: new Date().toISOString(),
        resultUrl: result.snapshot.url,
        lastError: confirmed ? '' : '送單後未讀到完成頁'
      });
      await this.state.save();
      const orderNumber = result.snapshot.orderId ? `｜訂單 ${result.snapshot.orderId}` : '';
      await this.sendPrivateAndRecord(
        confirmed
          ? `✅ 日亞商品頁自動下單成功｜${snapshot.title}｜¥${snapshot.priceYen}${orderNumber}｜本輪 ${storage.completedCount}/${targetSuccessCount}${taskComplete ? '，任務完成並停止' : '，繼續等待下一次補貨'}`
          : `⚠️ 日亞商品頁已按送單，但尚未確認是否成立｜${snapshot.title}｜請先查日亞訂單，任務已暫停避免重複下單`,
        confirmed ? 'success' : 'unconfirmed'
      );
      if (taskComplete || !confirmed) {
        storage.completedAt = new Date().toISOString();
        await this.onTerminal(result);
        this.stop();
      }
      return result;
    } catch (error) {
      const loginRequired = error.code === 'AMAZON_LOGIN_REQUIRED';
      storage.status = submitted ? 'needs_review' : loginRequired ? 'needs_login' : this.getConfig()?.enabled ? this.waitingStatus() : 'idle';
      if (!submitted && !loginRequired) {
        this.failureCount += 1;
        this.setBackoff(error.code === 'AMAZON_RATE_LIMITED' ? Math.min(300_000, 60_000 * 2 ** Math.min(3, this.failureCount - 1)) : attemptedPurchase ? 15_000 : 30_000);
      }
      if (submitted || loginRequired) this.pendingSignal = null;
      storage.lastCheckedAt = new Date().toISOString();
      storage.lastError = error.message;
      await this.recordStep('failure', { error: error.message });
      if (this.activeOrderRecord) await this.orderHistory.finish(this.activeOrderRecord, {
        status: submitted ? 'submitted_unconfirmed' : 'failed', error: error.message
      });
      const notificationKey = `${error.message}|${storage.lastSnapshot?.asin || ''}`;
      if (purchase && (signal || attemptedPurchase || loginRequired || error.code === 'AMAZON_RATE_LIMITED') && storage.lastErrorNotifiedKey !== notificationKey) {
        storage.lastErrorNotifiedKey = notificationKey;
        await this.sendPrivateAndRecord(
          submitted
            ? `⚠️ 日亞商品頁送單後狀態不明｜${storage.lastSnapshot?.title || storage.targetAsin || '目標商品'}｜原因：${error.message}｜請先檢查訂單，任務已暫停避免重複下單`
            : `❌ 日亞商品頁任務失敗｜${storage.lastSnapshot?.title || storage.targetAsin || '目標商品'}｜原因：${error.message}｜${loginRequired ? '等待完成登入檢查' : this.mode() === 'hybrid' ? '降速後依雙線模式繼續' : '等待下一次補貨訊號'}`,
          submitted ? 'unconfirmed' : 'failure'
        );
      }
      if (submitted) {
        await this.onTerminal({ status: 'submitted_unconfirmed', error: error.message });
        this.stop();
      }
      await this.state.save();
      throw error;
    } finally {
      this.activeOrderRecord = null;
      this.running = false;
      this.phase = 'idle';
      this.rearm();
    }
  }

  scheduleNext(delay) {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Number(delay) || 0);
    this.nextAttemptAt = new Date(Date.now() + wait).toISOString();
    this.timer = setTimeout(() => void this.runScheduledScan(), wait);
  }

  async runScheduledScan() {
    this.timer = null;
    this.nextAttemptAt = null;
    if (!this.canSchedule()) return;
    if (this.running) return; // The active check will rearm when it finishes.
    const cooldown = (Date.parse(this.storage().backoffUntil || '') || 0) - Date.now();
    if (cooldown > 0) { this.rearm(); return; }
    const signal = this.pendingSignal;
    this.pendingSignal = null;
    if (!signal && this.mode() !== 'hybrid') return;
    try {
      await this.scanOnce({ purchase: true, signal, trigger: signal ? 'scan_signal' : 'poll' });
    } catch (error) {
      this.log(`日亞商品頁自動下單：${error.message}`);
    } finally { this.rearm(); }
  }

  async start() {
    this.assertIdle();
    this.stop();
    if (!this.getConfig()?.enabled) return;
    this.stopped = false;
    const storage = this.storage();
    if (storage.completedCount >= Math.max(1, Number(this.getConfig()?.targetSuccessCount) || 1)) {
      storage.status = 'completed';
    } else if (storage.status === 'ordering') {
      storage.status = 'needs_review';
      storage.lastError = '上次下單流程在程式重啟前未確認結果；請先核對日亞訂單，避免重複送單';
    } else if (storage.status === 'needs_login'
      && storage.lastSnapshot?.loginRequired === false
      && storage.lastSnapshot?.pageIssue) {
      // Repair the old false-positive state created when an incomplete Amazon
      // page had no account label. Preserve real explicit login redirects.
      storage.status = this.waitingStatus();
      storage.lastError = '';
      delete storage.backoffUntil;
    } else if (!['needs_review', 'needs_login'].includes(storage.status)) {
      storage.status = this.waitingStatus();
    }
    await this.state.save();
    this.taskClock = Date.now();
    if (this.mode() === 'hybrid' && this.canSchedule()) {
      // Keep every lane on a five-second cadence but spread their first hit so
      // A/B/C do not burst three Amazon requests from one IP at the same time.
      const lane = Math.max(0, ['A', 'B', 'C'].indexOf(this.slot));
      this.scheduleNext(AMAZON_PRODUCT_POLL_MS + lane * 1650);
    } else this.rearm();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = null;
    this.pendingSignal = null;
  }

  status() {
    return { slot: this.slot, ...this.getConfig(), ...this.storage(), orderHistory: this.orderHistory.status(), mode: this.mode(), pollIntervalSeconds: this.mode() === 'hybrid' ? 5 : null, phase: this.phase, running: this.running || this.browserOperation, interactive: this.interactive, nextAttemptAt: this.nextAttemptAt };
  }

  async closeBrowser() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
    this.headless = null;
  }

  async close() {
    this.stop();
    await this.closeBrowser();
  }
}
