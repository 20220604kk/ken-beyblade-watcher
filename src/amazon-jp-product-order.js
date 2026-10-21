import fs from 'node:fs/promises';
import path from 'node:path';
import { AmazonOrderHistory } from './amazon-order-history.js';
import { chromium } from 'playwright';
import { waitForAmazonProductReady, amazonProductRecoveryDelay } from './amazon-jp-page-readiness.js';
import { safePurchaseText } from './purchase-diagnostics.js';
import { amazonThreeSteps } from './amazon-three-steps.js';
import { canRecoverAmazonDirectIntent, nextAmazonPreSubmitRetry } from './amazon-pre-submit-retry.js';
import { AmazonJpHttpClient, parseAmazonHttpCart, amazonOfferDecisionText } from './amazon-jp-http.js';
import { openAmazonBrowserDirectEntry } from './amazon-browser-direct-entry.js';
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
  readAmazonJpCheckoutSnapshot
} from './amazon-jp-single-order.js';

const LOGIN_PATH = /\/(?:ap\/signin|ap\/mfa|gp\/css\/homepage)/i;
const PURCHASE_LIMIT_WORDS = /(?:已达到|已達到|已达|已達).*?(?:卖家|賣家).*?(?:采购|採購|购买|購買).*?(?:上限|限制)|購入数の上限|購入数量制限|maximum purchase quantity/i;
export const AMAZON_PRODUCT_POLL_MS = 5_000;
export const AMAZON_FAST_POLL_MS = 1_000;
export const AMAZON_A_FAST_POLL_MS = AMAZON_FAST_POLL_MS; // Compatibility with existing local callers.

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
  if (snapshot.pageIssue === 'human_verification') return { eligible: false, reason: 'verification_required' };
  if (snapshot.pageIssue === 'rate_limited') return { eligible: false, reason: 'rate_limited' };
  if (snapshot.pageIssue === 'not_found') return { eligible: false, reason: 'page_not_found' };
  // Only explicit Amazon login evidence may stop the task. A blank account
  // label is common on partially rendered/throttled product pages and is not
  // proof that the persistent profile was signed out.
  if (snapshot.loginRequired) return { eligible: false, reason: 'login_required' };
  if (snapshot.pageIssue) return { eligible: false, reason: 'product_unreadable' };
  if (!snapshot.buyNowAvailable && !snapshot.addCartAvailable) return { eligible: false, reason: 'not_purchasable' };
  if (snapshot.purchaseLimited) return { eligible: false, reason: 'purchase_limited' };
  if (!snapshot.sellerConfirmed) return { eligible: false, reason: 'seller_not_amazon' };
  if (!(Number.isFinite(snapshot.priceYen) && snapshot.priceYen > 0)) return { eligible: false, reason: snapshot.priceText ? 'non_jpy_price' : 'price_missing' };
  if (!snapshot.buyNowAvailable && !snapshot.addCartAvailable) return { eligible: false, reason: 'not_purchasable' };
  return { eligible: true, reason: 'qualified' };
}

export function matchesAmazonJpPurchaseSignal(config, product, { source, kind } = {}) {
  if (!config?.enabled) return false;
  if (!['日亞官方原價', '日亞自營AOD'].includes(source) || !['new', 'restock'].includes(kind)) return false;
  const targetAsin = extractAmazonAsin(config.targetUrl);
  const signalAsin = clean(product?.asin).toUpperCase();
  if (!targetAsin || targetAsin !== signalAsin) return false;
  return product?.available === true
    && product?.sellerConfirmed === true
    && Number.isFinite(product?.priceYen) && product.priceYen > 0;
}

export function validateAmazonJpProductCheckout(checkout, { asin, code, quotePriceYen, msrpYen, toleranceYen = 1, maxShippingYen = 500 } = {}) {
  let url;
  try { url = new URL(checkout.url); } catch { throw new Error('日亞結帳網址無法核對，不送單'); }
  if (url.protocol !== 'https:' || !/^(?:www\.)?amazon\.co\.jp$/i.test(url.hostname)
    || !/\/(?:checkout\/|gp\/buy\/)/i.test(url.pathname)) throw new Error('不是日亞官方結帳頁，不送單');
  if (checkout.itemCount !== 1 || checkout.quantity !== 1 || checkout.stockLimited) throw new Error('日亞送單前商品／數量核對失敗，必須只有目標商品 1 件');
  if (checkout.asin !== asin || checkout.asins?.some(value => value !== asin) || code && checkout.code !== code) throw new Error('日亞結帳商品與目標不符，不送單');
  if (!checkout.sellerConfirmed) throw new Error('日亞送單前無法確認自營賣家，不送單');
  if (!checkout.deliveryConfirmed) throw new Error('日亞送單前未確認收件配送資料，不送單');
  if (!Number.isFinite(checkout.shippingYen) || checkout.shippingYen < 0 || checkout.shippingYen > maxShippingYen) throw new Error(`日亞運費未確認或超過 ¥${maxShippingYen}，不送單`);
  if (!Number.isFinite(checkout.totalYen) || checkout.totalYen <= checkout.shippingYen
    || !isAmazonPriceWithinMsrp(checkout.totalYen - checkout.shippingYen, quotePriceYen ?? msrpYen, toleranceYen)) throw new Error('日亞含運總額未確認或商品金額高於本輪自營報價，不送單');
  return { totalYen: checkout.totalYen, shippingYen: checkout.shippingYen };
}

export class AmazonJpProductOrderMonitor {
  constructor({ dataDir, state, getConfig, slot = 'A', storageKey, profileName, onTerminal = async () => {}, notifyPrivate = async () => {}, log = () => {}, orderHistory, checkoutRunner = advanceAmazonJpCheckout, httpClientFactory = options => new AmazonJpHttpClient(options), persistentContextLauncher = (userDataDir, options) => chromium.launchPersistentContext(userDataDir, options), readScheduler = null }) {
    this.state = state;
    this.getConfig = getConfig;
    this.onTerminal = onTerminal;
    this.raceCoordinator = null;
    this.activeRaceLease = null;
    this.notifyPrivate = notifyPrivate;
    this.log = log;
    this.slot = String(slot || 'A').toUpperCase();
    this.storageKey = storageKey || 'amazonJpProductOrder';
    this.checkoutRunner = checkoutRunner;
    this.httpClientFactory = httpClientFactory;
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
    this.directIdleOrderBaseline = null;
    this.stepLog = [];
    this.refreshCount = 0;
    this.signalChecks = [];
    this.maintenancePollCount = 0;
    this.readScheduler = readScheduler;
  }

  mode() { return normalizeAmazonJpProductMode(this.getConfig()?.mode); }

  transport() { return this.getConfig()?.checkoutTransport === 'browser' ? 'browser' : 'api'; }

  fastLaneEnabled() { return ['A', 'B', 'C'].includes(this.slot) && this.transport() === 'api' && this.getConfig()?.fastLane === true; }

  browserEntryFallbackActive() {
    const fallback = this.storage().checkoutEntryFallback;
    return this.fastLaneEnabled() && fallback?.asin === extractAmazonAsin(this.getConfig()?.targetUrl)
      && Date.parse(fallback.until || '') > Date.now();
  }

  pollIntervalMs() { return this.fastLaneEnabled() ? AMAZON_FAST_POLL_MS : AMAZON_PRODUCT_POLL_MS; }

  targetProduct() {
    const asin = extractAmazonAsin(this.getConfig()?.targetUrl);
    if (!asin) return { asin: '', title: '', code: '', titleSource: '' };
    const snapshot = this.storage().lastSnapshot;
    const amazon = this.amazonStorage();
    const manual = amazon.manualProducts?.[asin];
    const known = amazon.products?.[asin];
    for (const [source, item] of [['quote', snapshot?.asin === asin ? snapshot : null], ['database', manual], ['baseline', known]]) {
      const title = clean(item?.title).slice(0, 400);
      if (title) return { asin, title, code: clean(item.code || extractModelCode(title)), titleSource: source };
    }
    return { asin, title: '', code: '', titleSource: '' };
  }

  async saveApiCheckpoint() {
    // Await real durable writes without paying the shared 350ms debounce at
    // every API stage. Keep the StateStore serialization/atomic rename queue.
    if (this.transport() === 'api' && typeof this.state.writeSnapshot === 'function') return this.state.writeSnapshot();
    return this.state.save();
  }

  hasPendingApiTransaction() {
    const tx = this.storage().apiTransaction;
    return Boolean(tx && !tx.accounted);
  }

  canRecoverPreSubmit(submitted = false) {
    return canRecoverAmazonDirectIntent({ transaction: this.storage().apiTransaction,
      stockWait: this.storage().checkoutStockWait,
      asin: extractAmazonAsin(this.getConfig()?.targetUrl), fastLane: this.fastLaneEnabled() && this.transport() === 'api', submitted,
      raceState: this.raceCoordinator?.current(this.slot)?.routes.api?.state });
  }

  async recoverPreSubmit({ submitted = false, minimumDelayMs = 0, recordRetry = true } = {}) {
    if (!this.canRecoverPreSubmit(submitted)) return false;
    const storage = this.storage(), tx = storage.apiTransaction, previous = storage.preSubmitRetry;
    minimumDelayMs = Math.max(minimumDelayMs, (Date.parse(storage.backoffUntil || '') || 0) - Date.now());
    const retry = nextAmazonPreSubmitRetry(previous, { asin: tx.asin, minimumDelayMs });
    delete storage.apiTransaction;
    storage.preSubmitRetry = retry;
    if (!['needs_login', 'needs_verification'].includes(storage.status)) storage.status = this.getConfig()?.enabled ? this.waitingStatus() : 'idle';
    // Do not clear a cart, touch another route, reuse a checkout form, or alter
    // enabled settings. A retained stock page resumes GET; otherwise the next
    // attempt starts from a fresh validated product GET.
    this.setBackoff(retry.delayMs);
    try { await this.saveApiCheckpoint(); }
    catch (error) {
      storage.apiTransaction = tx; storage.preSubmitRetry = previous;
      storage.status = 'needs_review'; this.stop(); throw error;
    }
    if (recordRetry) await this.recordStep('pre_submit_retry', { retryCount: retry.attempts, retryDelayMs: retry.delayMs });
    return retry;
  }

  waitingStatus() { return this.mode() === 'hybrid' ? 'waiting_poll' : 'waiting_signal'; }

  assertIdle() {
    if (this.running || this.browserOperation) throw new Error('商品頁正在檢查或結帳，請等本次完成後再變更設定／開啟登入視窗');
    if (['preparing', 'granted'].includes(this.raceCoordinator?.current(this.slot)?.routes.frontend?.state)) throw new Error('插件正在結帳，暫不變更帳號／工作階段');
  }

  canSchedule() {
    return !this.stopped && this.getConfig()?.enabled && !this.interactive && !this.browserOperation
      && !this.hasPendingApiTransaction()
      && !['completed', 'needs_review', 'needs_login', 'needs_verification'].includes(this.storage().status);
  }

  rearm() {
    if (this.running || this.timer || !this.canSchedule()) return;
    const cooldown = Math.max(0, Date.parse(this.storage().backoffUntil || '') - Date.now()) || 0;
    if (this.pendingSignal) this.scheduleNext(cooldown);
    else if (this.mode() === 'hybrid') {
      // Start-to-start target; slow requests never overlap or create catch-up bursts.
      const delay = Math.max(this.fastLaneEnabled() ? 0 : 250, this.pollIntervalMs() - (Date.now() - this.taskClock));
      this.scheduleNext(Math.max(delay, cooldown));
    }
  }

  setBackoff(milliseconds) {
    const until = Math.max(Date.parse(this.storage().backoffUntil || '') || 0, Date.now() + milliseconds);
    this.storage().backoffUntil = new Date(until).toISOString();
  }

  storage() {
    this.state.data.commerce ||= {};
    this.state.data.commerce[this.storageKey] ||= { status: 'idle' };
    const storage = this.state.data.commerce[this.storageKey];
    storage.completedCount = Math.max(0, Number(storage.completedCount) || 0);
    for (const key of ['stepLog', 'refreshCount', 'signalChecks', 'lastIdleCartCheckCount']) delete storage[key];
    return storage;
  }

  amazonStorage() {
    this.state.data.commerce ||= {};
    return this.state.data.commerce.amazonJp || {};
  }

  async recordStep(name, detail = {}) {
    if(this.transport()==='browser'&&this.activeOrderRecord){
      if(['buy_now_click','proceed_checkout','checkout_inspect','checkout_verified'].includes(name)&&!this.browserEvidenceStarted){
        this.browserEvidenceStarted=true;await this.captureBrowserEvidence('entry');
      }
      if(['checkout_inspect','checkout_verified'].includes(name)&&!this.browserEvidenceResponse){
        this.browserEvidenceResponse=true;await this.captureBrowserEvidence('response');
      }
    }
    const now = Date.now();
    const step = {
      name,
      at: new Date(now).toISOString(),
      elapsedMs: this.taskClock ? now - this.taskClock : 0,
      ...detail
    };
    this.currentScanSteps.push(step);
    this.currentScanSteps = this.currentScanSteps.slice(-60);
    this.stepLog = amazonThreeSteps([...this.stepLog, step]).slice(-60);
    // Poll/transport telemetry must not introduce disk checkpoints on the hot
    // path. Durable purchase intent is saved separately before each mutation.
    if (this.fastLaneEnabled() && ['api_request_complete', 'refresh_start', 'product_evaluated'].includes(name)) {
      return;
    }
    if (this.activeOrderRecord) await this.orderHistory.step(this.activeOrderRecord, step);
    await this.saveApiCheckpoint();
  }

  async captureBrowserEvidence(kind,error) {
    if(!this.activeOrderRecord || typeof this.orderHistory.captureEvidence!=='function' || typeof this.page?.screenshot!=='function')return;
    try {
      const image=await this.page.screenshot({type:'png',fullPage:true,timeout:2000});
      this.orderHistory.captureEvidence(this.activeOrderRecord,kind,{image,source:kind==='entry'?'專用瀏覽器入口畫面；未證明安全結帳已載入':'專用瀏覽器實際畫面',url:this.page.url(),error:error?.message,errorCode:error?.code});
    } catch(captureError) {
      this.orderHistory.captureEvidence(this.activeOrderRecord,kind,{source:'瀏覽器截圖未取得；僅保存錯誤說明',captureError:captureError.message,error:error?.message||captureError.message,errorCode:error?.code});
    }
  }

  clearDiagnostics() {
    // Do not touch in-flight purchase evidence, transaction locks, success
    // counts, cooldowns or the independent 500-poll maintenance cadence.
    this.stepLog = [];
    this.refreshCount = 0;
    this.signalChecks = [];
    this.storage();
  }

  async resetProgress() {
    this.assertIdle();
    if (this.hasPendingApiTransaction()) throw new Error('日亞 API 留有未核對交易，不能用重設清除；請先查官方訂單／購物車');
    this.stop();
    this.failureCount = 0;
    this.clearDiagnostics();
    delete this.storage().preSubmitRetry;
    delete this.storage().checkoutEntryFallback;
    this.maintenancePollCount = 0;
    const storage = this.storage();
    Object.assign(storage, {
      completedCount: 0,
      status: 'idle',
      lastError: '',
      lastErrorNotifiedKey: '',
      taskStartedAt: new Date().toISOString()
    });
    for (const key of ['lastCheckedAt', 'lastSnapshot', 'triggeredAt', 'lastOrderStatus', 'lastOrderAt', 'resultUrl', 'completedAt', 'lastFailureNotifiedAt', 'targetAsin', 'lastSignalSource', 'lastSignalMatchedAt', 'lastSignalF5LatencyMs', 'lastSignalKind', 'lastSignalPriceYen', 'backoffUntil', 'lastTrigger']) delete storage[key];
    delete storage.pageRecoveryCount;
    delete storage.lastPageDiagnostic;
    delete storage.orderHistoryCheck;
    delete storage.loginIssueScope;
    delete storage.checkoutAccessIssue;
    delete storage.checkoutStockWait;
    this.directIdleOrderBaseline = null;
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
    const context = this.context;
    context.once('close', () => {
      if (this.context !== context) return;
      const wasInteractive = this.interactive;
      this.context = null; this.page = null; this.headless = null; this.interactive = false;
      if (wasInteractive) {
        this.stop();
        const storage = this.storage();
        if (!['needs_review', 'needs_verification', 'completed', 'purchase_limited'].includes(storage.status)) storage.status = 'needs_login';
        storage.lastError = '專用視窗已關閉；按「檢查」會重新開啟並核對已保存的登入。';
      }
    });
    return this.context;
  }

  findInteractivePage() {
    const targetAsin = extractAmazonAsin(this.getConfig()?.targetUrl);
    const official = page => {
      try { return !page.isClosed() && new URL(page.url()).origin === 'https://www.amazon.co.jp'; }
      catch { return false; }
    };
    let pages = [];
    try { pages = this.context?.pages?.() || []; } catch { /* closed context: reopen the same saved profile */ }
    const target = pages.find(page => official(page) && extractAmazonAsin(page.url()) === targetAsin);
    // Rebind only within THIS account's BrowserContext, never ordinary Chrome
    // or a different task's profile. Login can replace/close its original tab.
    return target || (this.page && !this.page.isClosed() ? this.page : null) || pages.find(official) || null;
  }

  async pageFor(headless) {
    const context = await this.contextFor(headless);
    if (!this.page || this.page.isClosed()) this.page = context.pages().find((page) => !page.isClosed()) || await context.newPage();
    return this.page;
  }

  async productSnapshot(page, status = 200) {
    const readiness = await waitForAmazonProductReady(page, status);
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
            captchaPresent: Boolean(document.querySelector('#captchacharacters, form[action*="validateCaptcha"], input[name="cvf_captcha_input"]')),
            title: text('#productTitle'),
            accountText: text('#nav-link-accountList-nav-line-1, #nav-link-accountList .nav-line-1'),
            priceText: prices.map(text).find((value) => value.trim()) || '',
            merchantValues: Array.from(document.querySelectorAll('input[name="merchantID"], input[name="merchantId"], input[name="offeringID.1"]'), (item) => `${item.name || ''}:${item.value || ''}`),
            buyNowAvailable: visibleButton(['#buy-now-button', '#pre-order-button', '#preorder-button', 'input[name="submit.buy-now"]', '[name="submit.pre-order"]', '[name="submit.preorder"]']),
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
    const pageIssue = raw.captchaPresent || /Robot Check|Enter the characters you see|画像に表示されている文字/i.test(`${pageTitle} ${bodyText}`)
      ? 'human_verification'
      : amazonJapanPageIssue({ status, title: pageTitle, body: bodyText, html: bodyText })
        || (!title || readiness.state === 'time_limit' && (!priceText || !buyNowAvailable && !addCartAvailable) ? 'product_unreadable' : '');
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
      pageIssue,
      diagnostic: { httpStatus: Number(status) || 0, pageTitle: safePurchaseText(pageTitle, 120),
        bodyLength: bodyText.length, hasProductTitle: Boolean(title), hasPrice: Boolean(priceText),
        hasBuyButton: Boolean(buyNowAvailable || addCartAvailable), readiness }
    };
  }

  async checkoutSnapshot(page) {
    return readAmazonJpCheckoutSnapshot(page);
  }

  async httpClient() {
    const context = await this.contextFor(!this.interactive);
    return this.httpClientFactory({ request: context.request, parallelPreflight: false, fastCheckout: this.fastLaneEnabled(), directBuyNow: this.fastLaneEnabled(),
      retailFallbackEnabled: this.fastLaneEnabled(), stockWaitIntervalMs: 250,
      stockWaitEnabled: this.fastLaneEnabled(), stockWait: this.storage().checkoutAccessIssue ? null : this.storage().checkoutStockWait,
      onStockWait: async (value, { durable = true } = {}) => {
        if (value) { this.storage().checkoutStockWait = value; this.phase = 'stock_wait'; }
        else delete this.storage().checkoutStockWait;
        if (durable) await this.saveApiCheckpoint();
      },
      browserDirectEntry: this.browserEntryFallbackActive()
        ? async (snapshot, options) => {
          await this.recordStep('checkout_browser_entry', { step: 2 });
          return openAmazonBrowserDirectEntry(await this.pageFor(!this.interactive), snapshot, options);
        } : null,
      captureEvidence:(kind,input)=>{if(this.activeOrderRecord && typeof this.orderHistory.captureEvidence==='function')this.orderHistory.captureEvidence(this.activeOrderRecord,kind,input);},
      // Another route can create an identical order. Never attribute its new
      // order-list entry to this API send; require this route's own completion.
      idleOrderBaseline: this.raceCoordinator?.connected(this.slot) || this.raceCoordinator?.current(this.slot) ? null : this.directIdleOrderBaseline,
      authorizeFinalSubmit: async () => { if (this.activeRaceLease) await this.raceCoordinator.grant(this.activeRaceLease); },
      canContinue: () => !this.stopped && Boolean(this.getConfig()?.enabled)
        && extractAmazonAsin(this.getConfig()?.targetUrl) === this.storage().targetAsin
        && (!this.activeRaceLease || this.raceCoordinator.canContinue(this.activeRaceLease))
        && (this.phase !== 'maintenance' || !this.pendingSignal && !this.raceCoordinator?.maintenanceBlocked()),
      recordStep: (name, detail) => this.recordStep(name, detail),
      checkpoint: async transaction => {
        if (transaction) this.storage().apiTransaction = { ...transaction };
        else delete this.storage().apiTransaction;
        await this.saveApiCheckpoint();
      }
    });
  }

  async reconcileApiOrder() {
    if (this.running || this.browserOperation || this.interactive) return { skipped: true, reason: 'task_busy' };
    const storage = this.storage(), transaction = storage.apiTransaction;
    if ((Date.parse(storage.backoffUntil || '') || 0) > Date.now()) {
      return { skipped: true, reason: 'cooling_down', message: '官方要求降速，期限未到；本次不查單、不重送。' };
    }
    if (!transaction || transaction.accounted || !['submitted', 'confirmed'].includes(transaction.phase)) {
      return { skipped: true, reason: 'cart_needs_manual_review', message: '尚未送單，但購物車／加車結果需人工核對；不再加車、不自動送單。' };
    }
    this.running = true; this.phase = 'reconciling'; this.taskClock = Date.now();
    this.currentScanSteps = [];
    try {
      const client = await this.httpClient();
      const result = await client.confirmOrder(transaction);
      if (result.status === 'ordered') {
        storage.completedCount += 1;
        transaction.accounted = true; transaction.phase = 'confirmed'; transaction.orderId = result.snapshot.orderId;
        storage.lastOrderStatus = 'ordered'; storage.resultUrl = result.snapshot.url;
        const complete = storage.completedCount >= Math.max(1, Number(this.getConfig()?.targetSuccessCount) || 1);
        storage.status = complete ? 'completed' : this.waitingStatus(); storage.lastError = '';
        await this.state.save();
        await this.recordStep('submit_result', { status: 'ordered', orderId: result.snapshot.orderId });
        // Recovery has no new POST, but needs its own permanent evidence record.
        const record = await this.orderHistory.begin({ slot: this.slot, mode: this.mode(), trigger: 'api_reconciliation',
          scanStartedAt: new Date(this.taskClock).toISOString(), snapshot: transaction, steps: this.currentScanSteps, compactSteps: true });
        await this.orderHistory.finish(record, { status: 'ordered', orderId: result.snapshot.orderId });
        await this.sendPrivateAndRecord(`✅ 日亞 API 查單確認成立｜${transaction.title || transaction.asin}｜訂單 ${result.snapshot.orderId}｜本次只查單，沒有重送`, 'success');
        if (complete) { this.stop(); await this.onTerminal(result); }
      } else {
        await this.recordStep('submit_result', { status: 'submitted_unconfirmed' });
        storage.status = 'needs_review'; storage.lastError = '官方訂單仍無法唯一核對；不重送、不清車'; await this.state.save();
      }
      return result;
    } finally { this.running = false; this.phase = 'idle'; this.rearm(); }
  }

  async prepareDirectIdleBaseline(client) {
    if (!this.fastLaneEnabled() || this.hasPendingApiTransaction() || this.interactive || this.pendingSignal
      || this.stopped || !this.getConfig()?.enabled || typeof client.readIdleOrderBaseline !== 'function') return;
    const asin = extractAmazonAsin(this.getConfig()?.targetUrl);
    const check = this.storage().orderHistoryCheck;
    if (check?.asin === asin && (['needs_login', 'needs_verification'].includes(check.status)
      || Date.parse(check.nextCheckAt || '') > Date.now())) return;
    try {
      const baseline = await client.readIdleOrderBaseline(asin);
      if (!this.stopped && !this.hasPendingApiTransaction() && extractAmazonAsin(this.getConfig()?.targetUrl) === asin) {
        this.directIdleOrderBaseline = baseline;
        this.storage().orderHistoryCheck = { asin, scope: 'order_history', status: 'ready', at: new Date().toISOString() };
      }
    } catch (error) {
      this.directIdleOrderBaseline = null; // Unknown history is NOT an empty baseline.
      const auth = error.code === 'AMAZON_LOGIN_REQUIRED' ? 'needs_login'
        : error.code === 'AMAZON_VERIFICATION_REQUIRED' ? 'needs_verification' : '';
      this.storage().orderHistoryCheck = { asin, scope: 'order_history', status: auth || 'unavailable',
        at: new Date().toISOString(), code: error.code || 'UNKNOWN',
        message: auth === 'needs_login' ? '背景查單需再次登入；僅暫停背景查單'
          : auth === 'needs_verification' ? '背景查單待人工驗證；僅暫停背景查單' : '背景查單暫不可用；商品登入另行核對',
        ...(!auth ? { nextCheckAt: new Date(Date.now() + Math.max(300_000, error.retryAfterMs || 0)).toISOString() } : {}) };
      await this.state.save();
      // A genuine site rate limit still applies to the account's requests.
      if (error.code === 'AMAZON_RATE_LIMITED') throw error;
      // Only this auxiliary operation is suspended. Never change purchase
      // login state or notify "login failed" for an optional history check.
    }
  }

  async confirmApiCartReviewed() {
    this.assertIdle();
    if (this.interactive) throw new Error('請先完成登入檢查，再核對購物車');
    const storage = this.storage(), tx = storage.apiTransaction;
    if ((Date.parse(storage.backoffUntil || '') || 0) > Date.now()) throw new Error('官方降速期限未到，暫不查車');
    if (tx && !tx.accounted && ['submitted', 'confirmed'].includes(tx.phase)) throw new Error('曾進入送單階段，不能用清車解除；必須先查官方訂單');
    if (storage.status !== 'needs_review') throw new Error('目前沒有需要人工核對的購物車');
    this.running = true; this.phase = 'inspecting';
    try {
      const client = await this.httpClient();
      const cart = await client.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
      if (!parseAmazonHttpCart(cart).empty) throw new Error('購物車仍有商品，或官方回應不足以確認空車；尚未解除。請先到此任務專用瀏覽器核對並移除測試商品，再按「檢查」。本次沒有清車或送單。');
      delete storage.apiTransaction;
      storage.status = this.getConfig()?.enabled ? this.waitingStatus() : 'idle'; storage.lastError = '';
      await this.recordStep('api_cart_empty', { step: 2, result: 'manual_cart_reviewed' });
      await this.state.save();
      return { message: '已從 API 確認空車，待核對已解除；本次沒有加車／送單。若任務已停止，請重新勾選「啟動」才會搶購。' };
    } finally { this.running = false; this.phase = 'idle'; this.rearm(); }
  }

  resolveMsrp(snapshot) {
    // Compatibility method name; this is a quote, never a TT MSRP lookup.
    return Number.isFinite(snapshot.priceYen) && snapshot.priceYen > 0
      ? { code: snapshot.code || extractModelCode(snapshot.title), msrpYen: snapshot.priceYen,
        quotePriceYen: snapshot.priceYen, source: 'amazon_retail_quote' } : null;
  }

  async openLogin() {
    this.assertIdle();
    this.stop();
    const existing = this.interactive || this.headless === false ? this.findInteractivePage() : null;
    if (existing) {
      this.page = existing;
      this.interactive = true;
      await this.page.bringToFront();
      return { message: '此任務的專用視窗已開啟；完成登入／驗證後，請按「檢查」。本次沒有重新載入頁面或送單。' };
    }
    const targetUrl = normalizeAmazonJpProductUrl(this.getConfig()?.targetUrl);
    this.browserOperation = true;
    try {
      await this.closeBrowser();
      const page = await this.pageFor(false);
      this.interactive = true;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { message: '日亞商品頁專用視窗已開啟；登入期間暫停自動刷新，完成登入／驗證後，請按「檢查」恢復原任務。' };
    } finally { this.browserOperation = false; }
  }

  // One UI action for inspection/recovery. Never calls purchase=true or clears
  // a cart. Existing enabled scheduling resumes only through its normal locks.
  async check() {
    this.assertIdle();
    if (this.canRecoverPreSubmit()) {
      const retry = await this.recoverPreSubmit();
      this.storage().lastError = ''; this.rearm();
      return { message: `已確認紀錄停在最終送單之前，解除舊直購流程；${Math.ceil(retry.delayMs / 1000)} 秒後依原啟用設定繼續。本次未清車、未購買、未送單。` };
    }
    if (this.interactive) return this.completeLogin();
    if (this.storage().checkoutAccessIssue || ['needs_login', 'needs_verification'].includes(this.storage().status)) return this.completeLogin();
    if (this.hasPendingApiTransaction()) {
      if (['submitted', 'confirmed'].includes(this.storage().apiTransaction.phase)) return this.reconcileApiOrder();
      return this.confirmApiCartReviewed();
    }
    try { return await this.scanOnce({ purchase: false }); }
    catch (error) {
      if (['AMAZON_LOGIN_REQUIRED', 'AMAZON_VERIFICATION_REQUIRED'].includes(error.code)) return this.openLogin();
      throw error;
    }
  }

  async completeLogin() {
    this.assertIdle();
    if (this.interactive) this.page = this.findInteractivePage();
    if (!this.interactive || !this.page) await this.openLogin();
    this.browserOperation = true;
    try {
    const snapshot = await this.productSnapshot(this.page);
    if (snapshot.pageIssue === 'human_verification') return { ok: false, message: '目前仍為人工驗證頁，請在專用視窗完成驗證，系統不會自動重試驗證。' };
    // Authentication does not require stock, a price, or a Buy Now button.
    // A sold-out product can time out the OFFER wait while login is valid.
    let officialProduct = false;
    try { officialProduct = new URL(snapshot.url).origin === 'https://www.amazon.co.jp'
      && extractAmazonAsin(snapshot.url) === extractAmazonAsin(this.getConfig()?.targetUrl); } catch { /* not an official product */ }
    const loginProductReady = officialProduct && snapshot.title && snapshot.signedIn === true && !snapshot.loginRequired
      && extractAmazonAsin(snapshot.url) === extractAmazonAsin(this.getConfig()?.targetUrl)
      && snapshot.diagnostic?.httpStatus === 200 && snapshot.diagnostic?.hasProductTitle;
    if (snapshot.pageIssue && !(snapshot.pageIssue === 'product_unreadable' && loginProductReady)) return { ok: false, message: '商品頁尚未取得完整資料，不能判定登入驗證成功；視窗會保持開啟。' };
    if (snapshot.loginRequired || !snapshot.signedIn) return { ok: false, message: `尚未辨識到日亞帳號登入完成${snapshot.accountText ? `（目前顯示：${snapshot.accountText}）` : ''}；請按右上角登入，視窗會保持開啟。` };
    if (!officialProduct) return { ok: false, message: '已登入，請在專用視窗回到本任務商品頁後按「檢查」。' };
    const storage = this.storage();
    storage.loginVerifiedAt = new Date().toISOString();
    storage.lastError = ''; storage.lastFailureCode = ''; storage.lastErrorNotifiedKey = '';
    delete storage.loginIssueScope;
    delete storage.orderHistoryCheck;
    // A successful official interactive login permits one fresh checkout check.
    // It does not certify that checkout itself is already authorized.
    delete storage.checkoutAccessIssue;
    if (['needs_login', 'needs_verification'].includes(storage.idleCartMaintenance?.status)) delete storage.idleCartMaintenance;
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
    if (storage.status === 'needs_review' || this.hasPendingApiTransaction()) {
      return { matched: true, queued: false, reason: 'order_needs_review' };
    }
    if (storage.status === 'needs_login') return { matched: true, queued: false, reason: 'login_required' };
    if (storage.status === 'needs_verification') return { matched: true, queued: false, reason: 'verification_required' };
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

  async clickQualifiedOffer(page, snapshot) {
    const buyNow = await firstVisible(page, ['#buy-now-button', '#pre-order-button', '#preorder-button', 'input[name="submit.buy-now"]', '[name="submit.pre-order"]', '[name="submit.preorder"]']);
    if (buyNow) {
      await this.recordStep('buy_now_click', { asin: snapshot.asin, priceYen: snapshot.priceYen });
      await clickAndWaitForAmazonNavigation(page, buyNow);
      return;
    }
    const addCart = await firstVisible(page, ['#add-to-cart-button', 'input[name="submit.add-to-cart"]']);
    if (!addCart) throw new Error('自營可購條件成立，但商品頁找不到立即購買或加入購物車按鈕');
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
    if (this.hasPendingApiTransaction()) return { skipped: true, reason: 'order_needs_review' };
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
    let apiClient;
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
      let page;
      let snapshot;
      if (signal) storage.lastSignalF5LatencyMs = Math.max(0, Date.now() - signal.matchedAt);
      await this.recordStep('refresh_start', { asin: targetAsin, step: 1, transport: this.transport() });
      const readSnapshot = async () => {
      if (this.transport() === 'api') {
        apiClient = await this.httpClient();
        snapshot = this.fastLaneEnabled() && storage.checkoutStockWait?.asin === targetAsin && !storage.checkoutAccessIssue
          ? storage.checkoutStockWait.snapshot
          : this.fastLaneEnabled() && typeof apiClient.readRetailOffer === 'function'
          ? await apiClient.readRetailOffer(targetAsin)
          : this.fastLaneEnabled() && typeof apiClient.readDirectOffer === 'function'
          ? await apiClient.readDirectOffer(targetAsin) : await apiClient.readOffer(targetAsin);
      } else {
      page = await this.pageFor(!this.interactive);
      const response = page.url() === targetUrl
        ? await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
        : await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if ([429, 503].includes(response?.status())) {
        storage.lastPageDiagnostic = { httpStatus: response.status(), readiness: { state: 'http_rejected', waitedMs: 0 } };
        const retryAfter = response.headers?.()['retry-after'];
        const seconds = Number(retryAfter);
        const retryMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter || '') - Date.now();
        this.setBackoff(Math.max(60_000, Number.isFinite(retryMs) ? retryMs : 0));
        throw Object.assign(new Error(`Amazon.co.jp HTTP ${response.status()}，已降速等待後重試`), { code: 'AMAZON_RATE_LIMITED' });
      }
      snapshot = await this.productSnapshot(page, response?.status() || 200);
      }
      return snapshot;
      };
      snapshot = this.readScheduler ? await this.readScheduler.run({ lane: 'single', scope: this.profileDirectory,
        key: targetAsin, canStart: () => !this.hasPendingApiTransaction() && this.storage().status !== 'needs_review'
          && (!purchase || this.canSchedule()) }, readSnapshot) : await readSnapshot();
      const productMismatch = snapshot.asin !== targetAsin
        || Boolean(signal?.code && snapshot.code && signal.code !== snapshot.code);
      const evaluation = productMismatch
        ? { eligible: false, reason: 'product_mismatch' }
        : evaluateAmazonJpProductOrder(snapshot);
      Object.assign(storage, {
        targetAsin: snapshot.asin,
        lastCheckedAt: new Date().toISOString(),
        lastSnapshot: { ...snapshot, msrpYen: null, msrpSource: '', quotePriceYen: snapshot.priceYen, pricingSource: 'amazon_retail_quote', evaluation: evaluation.reason },
        lastPageDiagnostic: snapshot.diagnostic || null,
        lastError: ''
      });
      this.refreshCount += 1;
      this.maintenancePollCount += 1;
      if (signal) {
        // Keep a bounded, credential-free history of signal-to-offer decisions;
        // ordinary polling does not create an order record or grow this list.
        this.signalChecks = [...this.signalChecks, {
          at: storage.lastCheckedAt, asin: targetAsin, result: evaluation.reason,
          signalToReadMs: storage.lastSignalF5LatencyMs,
          diagnostic: snapshot.diagnostic || null
        }].slice(-40);
      }
      await this.recordStep('product_evaluated', { asin: snapshot.asin, result: evaluation.reason, priceYen: snapshot.priceYen, quotePriceYen: snapshot.priceYen, diagnostic: snapshot.diagnostic || null });
      if (evaluation.reason === 'verification_required') throw Object.assign(new Error('日亞要求人工驗證；請開啟專用視窗處理，已暫停自動刷新'), { code: 'AMAZON_VERIFICATION_REQUIRED' });
      if (evaluation.reason === 'rate_limited') throw Object.assign(new Error('Amazon.co.jp 回傳真正的流量限制或驗證頁'), { code: 'AMAZON_RATE_LIMITED' });
      if (evaluation.reason === 'login_required') throw Object.assign(new Error('日亞商品頁專用瀏覽器尚未登入或登入已失效；請完成登入檢查'), { code: 'AMAZON_LOGIN_REQUIRED' });
      if (['page_not_found', 'product_unreadable'].includes(evaluation.reason)) {
        throw Object.assign(new Error(evaluation.reason === 'page_not_found' ? '日亞商品頁不存在或暫時無法讀取' : '商品頁等待關鍵資料後仍未完整載入，將有限恢復'),
          { code: evaluation.reason === 'page_not_found' ? 'AMAZON_PRODUCT_NOT_FOUND' : 'AMAZON_PRODUCT_UNREADABLE' });
      }
      this.failureCount = 0;
      storage.pageRecoveryCount = 0;
      delete storage.backoffUntil;
      if (!purchase) {
        storage.status = config.enabled ? this.waitingStatus() : 'idle';
        await this.state.save();
        return { status: 'inspected_only', snapshot: storage.lastSnapshot };
      }
      if (evaluation.reason === 'not_purchasable') { this.raceCoordinator?.unavailable(this.slot); delete storage.preSubmitRetry; }
      if (!evaluation.eligible) {
        storage.status = evaluation.reason === 'purchase_limited' ? 'purchase_limited' : this.waitingStatus();
        if (evaluation.reason === 'purchase_limited') this.setBackoff(60_000);
        // Ordinary five-second sold-out checks stay quiet; a verified restock
        // signal that lost its offer is a real failed attempt worth reporting.
        if (signal) {
          const reasons = {
            not_purchasable: apiClient ? amazonOfferDecisionText(snapshot.diagnostic) : '進入商品頁後已無可用購買按鈕', seller_not_amazon: '未能確認 Amazon.co.jp 自營報價',
            price_missing: '未讀到價格', above_msrp: '價格已高於原價容許範圍', non_jpy_price: '未讀到日圓價格',
            purchase_limited: '帳號已達限購', msrp_not_found: '找不到官方定價', product_mismatch: '商品與目標不符'
          };
          await this.sendPrivateAndRecord(`❌ 日亞商品頁補貨訊號觸發後未能購買｜${snapshot.title || targetAsin}｜原因：${reasons[evaluation.reason] || evaluation.reason}｜${this.mode() === 'hybrid' ? '依雙線模式繼續檢查' : '等待下一次補貨訊號'}`, 'failure');
        }
        // An unavailable quote is telemetry, not purchase intent. Queue its
        // ordinary debounced save without adding 350ms to every fast poll.
        // Durable transaction checkpoints still await writeSnapshot below.
        if (this.fastLaneEnabled()) void this.state.save().catch(error => this.log(`日亞監控狀態儲存失敗：${safePurchaseText(error)}`));
        else await this.state.save();
        if (this.fastLaneEnabled() && apiClient && !storage.checkoutStockWait && !this.pendingSignal
          && evaluation.reason !== 'purchase_limited'
          && (!this.directIdleOrderBaseline || this.directIdleOrderBaseline.asin !== targetAsin
            || Date.now() - Date.parse(this.directIdleOrderBaseline.at) >= 20_000)) {
          this.phase = 'maintenance';
          await this.prepareDirectIdleBaseline(apiClient);
        }
        // Maintenance is deliberately after an unavailable quote. A qualifying
        // offer always wins; never clean during checkout or unresolved intent.
        if (this.fastLaneEnabled() && typeof apiClient?.clearIdleCart === 'function'
          && this.maintenancePollCount >= 500 && !storage.checkoutStockWait
          && !this.raceCoordinator?.maintenanceBlocked()
          && !['needs_login', 'needs_verification'].includes(storage.idleCartMaintenance?.status)
          && evaluation.reason !== 'purchase_limited' && !this.pendingSignal && !this.hasPendingApiTransaction()
          && !this.stopped && this.getConfig()?.enabled) {
          this.maintenancePollCount = 0;
          this.phase = 'maintenance';
          try {
            const result = await apiClient.clearIdleCart();
            storage.idleCartMaintenance = { at: new Date().toISOString(), status: 'completed', removed: result.removed };
          } catch (error) {
            const auth = error.code === 'AMAZON_LOGIN_REQUIRED' ? 'needs_login'
              : error.code === 'AMAZON_VERIFICATION_REQUIRED' ? 'needs_verification' : '';
            storage.idleCartMaintenance = { at: new Date().toISOString(), scope: 'cart', status: auth || 'failed',
              error: auth ? '待機購物車整理需另行驗證；商品監控與購買持續' : safePurchaseText(error) };
            if (error.code === 'AMAZON_RATE_LIMITED') throw error;
          }
          await this.state.save();
        }
        return { status: storage.status, snapshot: storage.lastSnapshot };
      }
      // Settings/stop may change across asynchronous page operations. Never
      // convert a cancelled check into a purchase, or buy the old target.
      if (this.stopped || !this.getConfig()?.enabled || extractAmazonAsin(this.getConfig()?.targetUrl) !== targetAsin) {
        return { skipped: true, reason: 'task_cancelled' };
      }
      this.pendingSignal = null;
      if (storage.checkoutAccessIssue && apiClient) {
        storage.status = this.waitingStatus(); await this.state.save();
        return { skipped: true, reason: 'checkout_access_required', snapshot: storage.lastSnapshot };
      }
      if (apiClient && this.fastLaneEnabled() && this.raceCoordinator && (this.raceCoordinator.connected(this.slot) || this.raceCoordinator.current(this.slot))) {
        try { this.activeRaceLease = await this.raceCoordinator.begin(this.slot, 'api', targetAsin); }
        catch (error) { if (error.code === 'AMAZON_RACE_STOPPED') return { skipped: true, reason: 'race_route_consumed' }; throw error; }
        if (apiClient) apiClient.idleOrderBaseline = null;
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.nextAttemptAt = null;
      this.phase = 'ordering';
      attemptedPurchase = true;
      storage.status = 'ordering';
      storage.triggeredAt = new Date().toISOString();
      await (this.fastLaneEnabled() ? this.saveApiCheckpoint() : this.state.save());
      this.activeOrderRecord = await this.orderHistory.begin({
        slot: this.slot, mode: this.mode(), trigger: storage.lastTrigger,
        ...(this.activeRaceLease ? { route: 'api', raceId: this.activeRaceLease.waveId } : {}),
        signalAt: signal?.matchedAt ? new Date(signal.matchedAt).toISOString() : null,
        scanStartedAt: new Date(this.taskClock).toISOString(), taskStartedAt: storage.taskStartedAt,
        snapshot, msrpYen: null, steps: this.currentScanSteps, compactSteps: true
      });
      this.browserEvidenceStarted=false;
      this.browserEvidenceResponse=false;
      const beforeSubmit = async checkout => {
        const currentConfig = this.getConfig() || {};
        const quote = validateAmazonJpProductCheckout(checkout, { asin: targetAsin, code: snapshot.code,
          quotePriceYen: snapshot.priceYen, toleranceYen: currentConfig.priceToleranceYen ?? 1,
          maxShippingYen: Math.max(0, Math.min(10_000, Number(currentConfig.maxShippingYen ?? 500) || 0)) });
        await this.recordStep('checkout_verified', { step: 6, asin: targetAsin, quantity: 1, ...quote });
      };
      let result;
      if (apiClient) {
        result = await apiClient.checkout(snapshot, { beforeSubmit });
        submitted = apiClient.submitted;
      } else {
      await this.clickQualifiedOffer(page, snapshot);
      result = await this.checkoutRunner(
        page,
        (targetPage) => this.checkoutSnapshot(targetPage),
        (name, detail) => {
          if (name === 'submit_order') submitted = true;
          return this.recordStep(name, detail);
        },
        {
          canContinue: () => !this.stopped && this.getConfig()?.enabled && extractAmazonAsin(this.getConfig()?.targetUrl) === targetAsin,
          beforeSubmit
        }
      );
      }
      const confirmed = result.status === 'ordered' && Boolean(result.snapshot.orderId);
      if (!confirmed) result.status = 'submitted_unconfirmed';
      if (this.activeRaceLease) await this.raceCoordinator.finish(this.activeRaceLease, { status: result.status, orderId: result.snapshot.orderId });
      await this.orderHistory.finish(this.activeOrderRecord, { status: result.status, orderId: result.snapshot.orderId });
      if (confirmed) {
        delete storage.preSubmitRetry;
        storage.completedCount += 1;
        if (storage.apiTransaction) storage.apiTransaction.accounted = true;
      }
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
      apiClient?.captureFailure?.(error);
      if(this.browserEvidenceStarted)await this.captureBrowserEvidence('failure',error);
      submitted ||= Boolean(apiClient?.submitted || ['submitted', 'confirmed'].includes(storage.apiTransaction?.phase));
      // Only a recognized, received pre-submit shell can switch entry route.
      // Never change route after a timeout, auth challenge, or uncertain order.
      if (error.code === 'AMAZON_CHECKOUT_SHELL' && apiClient?.directBuyNow && !submitted && this.canRecoverPreSubmit(false)) {
        const previous = storage.checkoutEntryFallback;
        storage.checkoutEntryFallback = { asin: storage.targetAsin, reason: 'checkout_shell',
          since: new Date().toISOString(), until: new Date(Date.now() + 120_000).toISOString() };
        if (previous?.until && Date.parse(previous.until) > Date.now()) storage.checkoutEntryFallback = previous;
      }
      if (this.activeRaceLease) await this.raceCoordinator.finish(this.activeRaceLease, { status: submitted ? 'submitted_unconfirmed' : 'failed' });
      const retry = await this.recoverPreSubmit({ submitted, recordRetry: false,
        minimumDelayMs: error.code === 'AMAZON_RATE_LIMITED' ? Math.max(60_000, error.retryAfterMs || 0) : 0 });
      const needsCartReview = error.code === 'AMAZON_CART_REVIEW' || this.hasPendingApiTransaction();
      const checkoutAccess = !submitted && error.requestScope === 'checkout'
        && ['AMAZON_CHECKOUT_AUTH_REQUIRED', 'AMAZON_LOGIN_REQUIRED', 'AMAZON_VERIFICATION_REQUIRED'].includes(error.code);
      if (checkoutAccess) storage.checkoutAccessIssue = { scope: 'checkout', status: error.code === 'AMAZON_VERIFICATION_REQUIRED' ? 'needs_verification' : 'needs_login',
        at: new Date().toISOString(), message: '結帳需要再次核對登入／驗證；商品監控持續，未送單' };
      const loginRequired = error.code === 'AMAZON_LOGIN_REQUIRED' && !checkoutAccess;
      const verificationRequired = error.code === 'AMAZON_VERIFICATION_REQUIRED' && !checkoutAccess;
      if (loginRequired || verificationRequired || (submitted && error.code === 'AMAZON_CHECKOUT_AUTH_REQUIRED')) storage.loginIssueScope = error.requestScope || (attemptedPurchase ? 'checkout' : 'product');
      // AOD and the product buybox can change between the two GETs. When no
      // buy-now POST was attempted, this is an availability race, not a broken
      // submission. Keep the configured cadence; never apply this to a timeout,
      // contract mismatch, rate limit, or any pending transaction.
      const directOfferDisappeared = error.code === 'AMAZON_DIRECT_BUY_UNAVAILABLE'
        && this.fastLaneEnabled() && !apiClient?.addAttempted && !submitted && !needsCartReview;
      storage.status = submitted ? 'needs_review' : verificationRequired ? 'needs_verification' : loginRequired ? 'needs_login' : needsCartReview ? 'needs_review' : this.getConfig()?.enabled ? this.waitingStatus() : 'idle';
      if (directOfferDisappeared) {
        this.failureCount = 0;
        delete storage.backoffUntil;
        delete storage.lastFailureCode;
      } else if (!submitted && !loginRequired && !verificationRequired && !retry) {
        if (storage.lastFailureCode !== (error.code || 'UNKNOWN')) this.failureCount = 0;
        storage.lastFailureCode = error.code || 'UNKNOWN';
        this.failureCount += 1;
        const incomplete = error.code === 'AMAZON_PRODUCT_UNREADABLE';
        this.setBackoff(error.code === 'AMAZON_RATE_LIMITED' ? Math.min(300_000, 60_000 * 2 ** Math.min(3, this.failureCount - 1))
          : error.code === 'AMAZON_PRODUCT_NOT_FOUND' && !this.fastLaneEnabled() ? 300_000
          : this.fastLaneEnabled() ? 1000 : incomplete ? amazonProductRecoveryDelay(this.failureCount) : attemptedPurchase ? 15_000 : 30_000);
        if (error.retryAfterMs) this.setBackoff(error.retryAfterMs);
        // Reopen only the page, once per consecutive unreadable sequence.
        // Preserve the account's persistent context/cookies; never do this in checkout.
        if (this.transport() === 'browser' && incomplete && this.failureCount >= 2 && !attemptedPurchase && !storage.pageRecoveryCount) {
          storage.pageRecoveryCount = 1;
          await this.page?.close?.().catch(() => {});
          this.page = null;
          await this.recordStep('product_page_recovery', { action: '下次檢查重開商品頁，保留帳號工作階段' });
        }
      }
      // A throttled order POST is still an unknown submission. Hold both the
      // transaction and Retry-After; even manual reconciliation must wait.
      if (error.code === 'AMAZON_RATE_LIMITED') this.setBackoff(Math.max(60_000, error.retryAfterMs || 0));
      if (submitted || loginRequired || verificationRequired || needsCartReview) this.pendingSignal = null;
      if (loginRequired || verificationRequired) delete storage.backoffUntil;
      storage.lastCheckedAt = new Date().toISOString();
      storage.lastError = safePurchaseText(error);
      await this.recordStep('failure', { error: safePurchaseText(error), diagnostic: storage.lastPageDiagnostic || null });
      if (retry) await this.recordStep('pre_submit_retry', { retryCount: retry.attempts, retryDelayMs: retry.delayMs });
      if (this.activeOrderRecord) await this.orderHistory.finish(this.activeOrderRecord, {
        status: submitted ? 'submitted_unconfirmed' : 'failed', error: safePurchaseText(error)
      });
      const notificationKey = `${safePurchaseText(error)}|${storage.lastSnapshot?.asin || ''}`;
      if (purchase && (signal || attemptedPurchase || loginRequired || verificationRequired || error.code === 'AMAZON_RATE_LIMITED') && storage.lastErrorNotifiedKey !== notificationKey) {
        storage.lastErrorNotifiedKey = notificationKey;
        await this.sendPrivateAndRecord(
          submitted
            ? `⚠️ 日亞商品頁送單後狀態不明｜${storage.lastSnapshot?.title || storage.targetAsin || '目標商品'}｜原因：${safePurchaseText(error)}｜請先檢查訂單，任務已暫停避免重複下單`
            : `❌ 日亞任務失敗｜${storage.lastSnapshot?.title || storage.targetAsin || '目標商品'}｜原因：${safePurchaseText(error)}｜${checkoutAccess ? '結帳需在官方視窗核對；商品監控繼續' : verificationRequired ? '等待使用者完成驗證' : loginRequired ? '等待完成登入檢查' : retry ? `尚未送單，${Math.ceil(retry.delayMs / 1000)} 秒後自動重試；監控任務繼續` : needsCartReview ? '保留購物車，等待人工核對，不重加／重送' : this.mode() === 'hybrid' ? '降速後依雙線模式繼續' : '等待下一次補貨訊號'}`,
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
      this.activeRaceLease = null;
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
    // Prepare before the first scheduled quote, not after a qualified offer.
    // A real stock signal skips preparation and takes the hot path immediately.
    if (this.fastLaneEnabled() && !this.storage().checkoutStockWait && !this.pendingSignal && (!this.directIdleOrderBaseline
      || this.directIdleOrderBaseline.asin !== extractAmazonAsin(this.getConfig()?.targetUrl))) {
      this.running = true; this.phase = 'maintenance';
      try { await this.prepareDirectIdleBaseline(await this.httpClient()); }
      catch (error) {
        this.setBackoff(error.code === 'AMAZON_RATE_LIMITED' ? Math.max(60_000, error.retryAfterMs || 0) : 1000);
        this.storage().lastError = safePurchaseText(error);
        if (error.code === 'AMAZON_LOGIN_REQUIRED') this.storage().status = 'needs_login';
        if (error.code === 'AMAZON_VERIFICATION_REQUIRED') this.storage().status = 'needs_verification';
        await this.state.save(); this.running = false; this.phase = 'idle'; this.rearm(); return;
      } finally { this.running = false; this.phase = 'idle'; }
    }
    if (!this.canSchedule()) { this.rearm(); return; }
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
    this.taskClock = Date.now();
    const storage = this.storage();
    // Old code treated the redirect URL alone as expired authentication.
    // Re-evaluate it once through the new official GET/actual-form contract.
    if (!this.hasPendingApiTransaction() && storage.status === 'needs_login' && storage.loginIssueScope === 'checkout') {
      storage.status = this.waitingStatus(); delete storage.loginIssueScope; storage.lastError = '';
    }
    if (storage.authContractVersion !== 2) {
      for (const key of ['orderHistoryCheck', 'idleCartMaintenance']) {
        if (['needs_login', 'needs_verification'].includes(storage[key]?.status)) delete storage[key];
      }
      storage.authContractVersion = 2;
    }
    if (this.canRecoverPreSubmit()) {
      await this.recoverPreSubmit();
      storage.lastError = '前輪未送出最終訂單，已自動解除舊直購流程；繼續監控重試';
    }
    if (storage.completedCount >= Math.max(1, Number(this.getConfig()?.targetSuccessCount) || 1)) {
      storage.status = 'completed';
    } else if (storage.status === 'ordering' || this.hasPendingApiTransaction()) {
      storage.status = 'needs_review';
      storage.lastError = ['adding', 'cart_ready', 'buy_now'].includes(storage.apiTransaction?.phase)
        ? '舊流程缺少可自動恢復的直購證據；請按「檢查」核對。已確認的新版未送單失敗會自動重試。'
        : '上次下單流程在程式重啟前未確認結果；請先核對日亞訂單，避免重複送單';
    } else if (storage.status === 'needs_login'
      && storage.lastSnapshot?.loginRequired === false
      && storage.lastSnapshot?.pageIssue) {
      // Repair the old false-positive state created when an incomplete Amazon
      // page had no account label. Preserve real explicit login redirects.
      storage.status = this.waitingStatus();
      storage.lastError = '';
      delete storage.backoffUntil;
    } else if (!['needs_review', 'needs_login', 'needs_verification'].includes(storage.status)) {
      storage.status = this.waitingStatus();
    }
    await this.state.save();
    this.taskClock = Date.now();
    if (this.mode() === 'hybrid' && this.canSchedule()) {
      // Keep every lane on a five-second cadence but spread their first hit so
      // A/B/C do not burst three Amazon requests from one IP at the same time.
      const lane = Math.max(0, ['A', 'B', 'C'].indexOf(this.slot));
      this.scheduleNext(this.pollIntervalMs() + lane * 1650);
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
    const { apiTransaction, checkoutStockWait, ...storage } = this.storage();
    return { slot: this.slot, ...this.getConfig(), ...storage, checkoutTransport: this.transport(),
      targetProduct: this.targetProduct(), fastLane: this.fastLaneEnabled(),
      singleFlowVersion: 'extension-port-2026-10-22', stockWaitIntervalMs: 250,
      checkoutFallback: this.fastLaneEnabled() ? 'aod_new_retail' : null,
      checkoutStockWait: checkoutStockWait ? { active: true, since: checkoutStockWait.since, refreshCount: checkoutStockWait.refreshCount } : null,
      checkoutEntryRoute: this.browserEntryFallbackActive() ? 'browser_fallback' : this.transport(),
      stepLog: [...this.stepLog], purchaseSteps: [...this.stepLog], refreshCount: this.refreshCount, signalChecks: [...this.signalChecks],
      evidencePending:this.orderHistory.evidence?.pending || 0,
      ...(this.raceBridge ? { race: this.raceBridge.status(this.slot) } : {}),
      ...(this.fastLaneEnabled() ? { checkoutRoute: 'direct_buy_now' } : {}),
      apiTransactionStatus: apiTransaction?.phase || '', apiOrderCheckAvailable: this.hasPendingApiTransaction() && ['submitted', 'confirmed'].includes(apiTransaction?.phase),
      apiCartReviewAvailable: this.transport() === 'api' && storage.status === 'needs_review'
        && (!apiTransaction || !['submitted', 'confirmed'].includes(apiTransaction.phase)),
      orderHistory: this.orderHistory.status(), mode: this.mode(), pollIntervalSeconds: this.mode() === 'hybrid' ? this.pollIntervalMs() / 1000 : null, phase: this.phase, running: this.running || this.browserOperation, interactive: this.interactive, nextAttemptAt: this.nextAttemptAt };
  }

  async closeBrowser() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.headless = null;
    this.interactive = false;
    await context?.close().catch(() => {});
  }

  async close() {
    this.stop();
    await this.closeBrowser();
  }
}
