import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseYen, AMAZON_JP_SELLER_ID } from './amazon-jp-monitor.js';

const AMAZON_HOST = /^(?:www\.)?amazon\.co\.jp$/i;
const CHECKOUT_PATH = /\/(?:checkout\/|gp\/cart\/view\.html)/i;
const LOGIN_PATH = /\/(?:ap\/signin|ap\/mfa|gp\/css\/homepage)/i;
const STOCK_LIMIT_WORDS = /抱歉，无法再提供您所请求的数量|ご指定の数量をご用意できません|requested quantity.*not available/i;
const ORDER_DONE_WORDS = /ご注文ありがとうございました|注文(?:が)?確定|注文番号|订单已提交|感谢您的订单|order (?:has been )?placed|order number/i;
const ASIN_PATTERN = /\b[A-Z0-9]{10}\b/i;

function extractModelCode(value) {
  return String(value || '').normalize('NFKC').toUpperCase().match(/\b(?:BXG|BX|CX|UX)\s*-?\s*\d{2}\b/)?.[0]
    ?.replace(/\s+/g, '').replace(/^(BXG|BX|CX|UX)(\d{2})$/, '$1-$2') || '';
}

function normalizeAsin(value) {
  const match = String(value || '').toUpperCase().match(ASIN_PATTERN);
  return match?.[0] || '';
}

export function extractAmazonJpOrderId({ url = '', bodyText = '' } = {}) {
  try {
    const target = new URL(String(url));
    // A thank-you purchaseId identifies the checkout flow, NOT necessarily
    // the formal order. Only an official detail URL or labelled order ID counts.
    const orderId = target.searchParams.get('orderID') || '';
    if (target.protocol === 'https:' && AMAZON_HOST.test(target.hostname)
      && target.pathname === '/your-orders/order-details' && /^\d{3}-\d{7}-\d{7}$/.test(orderId)) return orderId;
  } catch {}
  return String(bodyText || '').match(/(?:注文番号|订单编号|訂單編號|Order (?:number|#))\s*[:：#]?\s*(\d{3}-\d{7}-\d{7})/i)?.[1] || '';
}

export function normalizeAmazonJpCheckoutUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('請貼上有效的 Amazon.co.jp 購物車或結帳網址'); }
  if (url.protocol !== 'https:' || !AMAZON_HOST.test(url.hostname) || !CHECKOUT_PATH.test(url.pathname)) {
    throw new Error('只接受 Amazon.co.jp 的購物車或 checkout 結帳網址');
  }
  url.hash = '';
  return url.href;
}

export function parseAmazonJpCheckoutSnapshot({ url = '', bodyText = '', titles = [], quantityText = '', asins = [], sellerConfirmed = false, totalText = '', shippingText = '', deliveryConfirmed = false } = {}) {
  const text = String(bodyText || '').replace(/\s+/g, ' ').trim();
  const uniqueTitles = [...new Map(
    (titles || [])
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((value) => [value.normalize('NFKC').toUpperCase(), value])
  ).values()];
  const quantityControlMatch = String(quantityText || '').match(/\d+/);
  const quantityTextMatch = text.match(/(?:数量|個数|Quantity)\s*[:：]?\s*(\d+)/i);
  const quantity = quantityControlMatch ? Number(quantityControlMatch[0]) : quantityTextMatch ? Number(quantityTextMatch[1]) : null;
  const loginRequired = LOGIN_PATH.test(String(url)) || /登录|ログイン|Sign[- ]?in/i.test(text) && !/订单总计|注文内容|Order total/i.test(text);
  const confirmed = /\/(?:thankyou|order-confirmation|order\/complete)/i.test(String(url)) || ORDER_DONE_WORDS.test(text);
  const title = uniqueTitles[0] || '';
  const moneyAfter = label => text.match(new RegExp(`(?:${label})\\s*[:：]?\\s*(?:JPY\\s*)?[¥￥]\\s*([\\d,]+)`, 'i'))?.[1];
  const totalAmount = moneyAfter('注文合計|注文の合計|ご請求額|订单总计|訂單總計|Order total');
  const totalYen = parseYen(totalText) ?? (totalAmount ? Number(totalAmount.replace(/,/g, '')) : null);
  const shippingAmount = moneyAfter('配送料(?:・手数料)?|配送手数料|运费|運費|Shipping(?: & handling)?');
  const shippingZero = /^(?:[¥￥]\s*0|0\s*円|無料|Free|免運)$/i.test(String(shippingText).trim());
  const shippingYen = shippingZero ? 0 : parseYen(shippingText)
    ?? (shippingAmount ? Number(shippingAmount.replace(/,/g, '')) : null);
  return {
    url: String(url),
    title,
    itemCount: uniqueTitles.length,
    itemTitles: uniqueTitles,
    quantity,
    asin: (asins || []).map(normalizeAsin).find(Boolean) || '',
    asins: [...new Set((asins || []).map(normalizeAsin).filter(Boolean))],
    code: extractModelCode(title),
    stockLimited: STOCK_LIMIT_WORDS.test(text),
    sellerConfirmed: Boolean(sellerConfirmed),
    loginRequired,
    confirmed,
    orderId: extractAmazonJpOrderId({ url, bodyText }),
    totalYen, shippingYen, deliveryConfirmed: Boolean(deliveryConfirmed),
    verificationRequired: /Robot Check|Enter the characters you see|画像に表示されている文字/i.test(text)
  };
}

export async function readAmazonJpCheckoutSnapshot(page) {
  if (typeof page.waitForFunction === 'function') {
    await page.waitForFunction(() => {
      const text = document.body?.innerText || '';
      if (/ご注文ありがとうございました|注文番号|订单已提交|order (?:has been )?placed|Robot Check|Enter the characters you see/i.test(text)
        || /\/(?:ap\/signin|ap\/mfa)/i.test(location.pathname)) return true;
      const final = document.querySelector('#submitOrderButtonId, input[name="placeYourOrder1"], input[name="placeYourOrder"]');
      if (final) return /注文合計|注文の合計|ご請求額|订单总计|訂單總計|Order total/i.test(text)
        && Boolean(document.querySelector('[id^="item-block-product-title-"], [id^="checkout-item-block-item-primary-title-"], .lineitem-title-text'));
      return Boolean(document.querySelector('#checkout-experience-left-column-deck input[type="submit"], #checkout-experience-container input.a-button-input[type="submit"], a[href*="/prime/handler?action=decline"]'));
    }, undefined, { timeout: 2_000, polling: 100 }).then(handle => handle.dispose()).catch(error => {
      if (error.name !== 'TimeoutError') throw error;
    });
  }
  let timer;
  try {
    const raw = await Promise.race([page.evaluate(sellerId => {
      const visible = element => element && getComputedStyle(element).display !== 'none'
        && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0;
      const elements = selector => [...document.querySelectorAll(selector)].filter(visible);
      const text = selector => elements(selector).map(element => element.innerText || element.textContent || '').join(' ').trim();
      const bodyText = document.body?.innerText || '';
      return {
        url: location.href, bodyText,
        titles: elements('[id^="item-block-product-title-"], [id^="checkout-item-block-item-primary-title-"], .lineitem-title-text').map(element => element.textContent),
        quantityText: text('[data-a-selector="inner-value"], select[name*="quantity"] option:checked'),
        asins: elements('a[href*="/dp/"], a[href*="/gp/product/"]').map(element => element.href),
        sellerConfirmed: elements(`a[href*="seller=${sellerId}"]`).length > 0
          || /(?:卖家|賣家|販売元|出品者|Seller)\s*[:：]?\s*(?:Amazon\.co\.jp|アマゾンジャパン)/i.test(bodyText),
        totalText: text('#grand-total-price, .grand-total-price, [data-testid="order-total"]'),
        shippingText: text('#shipping-total-price, [data-testid="shipping-total"]'),
        deliveryConfirmed: Boolean(text('#shipping-address, #shipping-address-section, [data-testid="shipping-address"], .shipping-address'))
          || /(?:お届け先|配送先|配送地址|收貨地址|Shipping address)\s*[:：]/i.test(bodyText)
      };
    }, AMAZON_JP_SELLER_ID), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('日亞結帳資料讀取超過 3 秒，本次不送單')), 3_000);
    })]);
    return parseAmazonJpCheckoutSnapshot(raw);
  } catch (error) {
    // Terminate a stuck DOM read before another operation can reuse the page.
    // The caller retains the submitted/unconfirmed state and never resubmits.
    if (error.message === '日亞結帳資料讀取超過 3 秒，本次不送單') await page.close?.().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}

export async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => true)) return locator;
  }
  return null;
}

export async function clickAndWaitForAmazonNavigation(page, locator, timeout = 15_000) {
  const before = typeof page.url === 'function' ? page.url() : '';
  const navigation = before && typeof page.waitForURL === 'function'
    ? page.waitForURL(url => url.toString() !== before, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 6_000) }).catch(() => null)
    : null;
  // Locator click performs visibility, enabled and actionability checks. Never
  // dispatch a DOM click to bypass a covered/disabled button.
  await locator.click({ timeout });
  if (navigation) await navigation;
  else await page.waitForLoadState?.('domcontentloaded', { timeout: Math.min(timeout, 6_000) }).catch(() => {});
}

export async function advanceAmazonJpCheckout(page, snapshot, recordStep = async () => {}, { beforeSubmit = async () => {}, canContinue = () => true } = {}) {
  const stages = new Set();
  for (let step = 0; step < 8; step += 1) {
    if (!canContinue()) throw new Error('日亞任務已停止或設定已變更，本次不送單');
    const current = await snapshot(page);
    await recordStep('checkout_inspect', { step: step + 1, url: current.url });
    if (current.confirmed) return { status: current.orderId ? 'ordered' : 'submitted_unconfirmed', snapshot: current };
    if (current.verificationRequired) throw Object.assign(new Error('日亞結帳要求人工驗證，本次不送單'), { code: 'AMAZON_VERIFICATION_REQUIRED' });
    if (current.loginRequired) throw new Error('日亞結帳工作階段已失效，點擊立即購買後被轉回登入頁');
    const finalButton = await firstVisible(page, [
      '#submitOrderButtonId input[type="submit"]', 'input[name="placeYourOrder1"]',
      'input[name="placeYourOrder"]', 'button:has-text("注文を確定する")',
      'button:has-text("提交订单")', 'button:has-text("Place your order")'
    ]);
    if (finalButton) {
      await beforeSubmit(current);
      if (!canContinue()) throw new Error('日亞任務已停止或設定已變更，本次不送單');
      await recordStep('submit_order', { step: step + 1, url: current.url });
      await clickAndWaitForAmazonNavigation(page, finalButton);
      const result = await snapshot(page);
      const confirmed = result.confirmed && Boolean(result.orderId);
      await recordStep('submit_result', { status: confirmed ? 'ordered' : 'submitted_unconfirmed', url: result.url, orderId: result.orderId });
      return { status: confirmed ? 'ordered' : 'submitted_unconfirmed', snapshot: result };
    }
    const continueButton = await firstVisible(page, [
      'a[href*="/prime/handler?action=decline"]',
      '#checkout-experience-left-column-deck input[type="submit"]',
      '#checkout-experience-container input.a-button-input[type="submit"]',
      'button:has-text("使用此付款方式")', 'button:has-text("この支払い方法を使う")',
      'button:has-text("続行")', 'button:has-text("继续")', 'button:has-text("Continue")'
    ]);
    if (!continueButton) throw new Error(`日亞結帳第 ${step + 1} 步找不到繼續或送單按鈕`);
    const buttonStage = typeof continueButton.getAttribute === 'function'
      ? await Promise.all(['id', 'name', 'value', 'href'].map(name => continueButton.getAttribute(name))) : [];
    const stage = `${current.url}|${current.itemCount}|${current.quantity}|${current.asin}|${current.totalYen}|${current.deliveryConfirmed}|${JSON.stringify(buttonStage)}`;
    if (stages.has(stage)) throw new Error('日亞結帳尚未確認前一步完成，不重複點擊同一步驟');
    stages.add(stage);
    await recordStep('checkout_continue', { step: step + 1, url: current.url });
    await clickAndWaitForAmazonNavigation(page, continueButton);
  }
  throw new Error('日亞結帳步驟超過預期，本輪不送單');
}

export class AmazonJpSingleOrderMonitor {
  constructor({ dataDir, state, getConfig, onTerminal = async () => {}, notifyPrivate = async () => {}, log = () => {}, persistentContextLauncher = (userDataDir, options) => chromium.launchPersistentContext(userDataDir, options) }) {
    this.state = state;
    this.getConfig = getConfig;
    this.onTerminal = onTerminal;
    this.notifyPrivate = notifyPrivate;
    this.log = log;
    this.persistentContextLauncher = persistentContextLauncher;
    this.profileDirectory = path.join(dataDir, 'auto-purchase', 'browser-profiles', 'amazon-jp-single-order');
    this.context = null;
    this.page = null;
    this.headless = null;
    this.running = false;
    this.timer = null;
    this.nextRefreshAt = null;
    this.interactive = false;
    this.signalRefreshRequested = false;
    this.signalPreemptRequested = false;
  }

  storage() {
    this.state.data.commerce ||= {};
    this.state.data.commerce.amazonJpSingleOrder ||= { status: 'idle', refreshCount: 0 };
    const storage = this.state.data.commerce.amazonJpSingleOrder;
    storage.completedCount = Math.max(0, Number(storage.completedCount) || 0);
    return storage;
  }

  async resetProgress() {
    const storage = this.storage();
    storage.completedCount = 0;
    storage.refreshCount = 0;
    storage.status = 'idle';
    storage.lastError = '';
    storage.lastErrorNotifiedKey = '';
    storage.taskStartedAt = new Date().toISOString();
    for (const key of [
      'lastCheckedAt', 'lastSnapshot', 'triggeredAt', 'lastOrderStatus', 'lastOrderAt',
      'resultUrl', 'completedAt', 'lastFailureNotifiedAt', 'lastNotificationId',
      'lastNotificationAt', 'lastNotificationKind', 'lastNotificationStatus',
      'lastNotificationError', 'targetAsin', 'targetCode', 'lastSignalSource',
      'lastSignalProduct', 'lastSignalKind', 'lastSignalMatchedAt',
      'lastSignalRefreshStatus', 'lastSignalRefreshedAt', 'lastSignalF5StartedAt',
      'lastSignalF5LatencyMs'
    ]) delete storage[key];
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
      storage.lastNotificationId = '';
      storage.lastNotificationError = error.message;
    }
    storage.lastNotificationKind = kind;
    storage.lastNotificationAt = new Date().toISOString();
    await this.state.save();
  }

  async contextFor(headless) {
    if (this.context && this.headless !== headless) await this.closeBrowser();
    if (this.context) return this.context;
    await fs.mkdir(this.profileDirectory, { recursive: true });
    this.context = await this.persistentContextLauncher(this.profileDirectory, {
      headless,
      channel: 'chrome',
      locale: 'zh-CN',
      timezoneId: 'Asia/Tokyo',
      args: ['--disable-blink-features=AutomationControlled']
    });
    this.headless = headless;
    this.context.once('close', () => { this.context = null; this.page = null; this.headless = null; });
    return this.context;
  }

  async pageFor(headless) {
    const context = await this.contextFor(headless);
    if (!this.page || this.page.isClosed()) this.page = context.pages().find((page) => !page.isClosed()) || await context.newPage();
    return this.page;
  }

  async snapshot(page) {
    const titles = await page.locator('[id^="item-block-product-title-"]:visible, [id^="checkout-item-block-item-primary-title-"]:visible, .lineitem-title-text:visible').allTextContents().catch(() => []);
    const quantityText = await page.locator('[data-a-selector="inner-value"]').first().textContent().catch(() => '');
    const asins = await page.locator('a[href*="/dp/"], a[href*="/gp/product/"]').evaluateAll((links) => links.map((link) => link.href)).catch(() => []);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const sellerLinkConfirmed = await page.locator('a[href*="seller=AN1VRQENFRJN5"]').count().catch(() => 0) > 0;
    const sellerTextConfirmed = /(?:卖家|賣家|販売元|出品者|Seller)\s*[:：]?\s*(?:Amazon\.co\.jp|アマゾンジャパン)/i.test(bodyText);
    const sellerConfirmed = sellerLinkConfirmed || sellerTextConfirmed;
    return parseAmazonJpCheckoutSnapshot({ url: page.url(), bodyText, titles, quantityText, asins, sellerConfirmed });
  }

  async requestImmediateRefresh(product, { source = '日本拍賣', kind = 'availability' } = {}) {
    const config = this.getConfig() || {};
    if (!config.enabled) return { matched: false, reason: 'disabled' };
    const storage = this.storage();
    if (storage.status === 'needs_review') return { matched: false, reason: 'order_needs_review' };
    const signalAsin = normalizeAsin(product?.asin || product?.url);
    const signalCode = extractModelCode(product?.code || product?.title);
    const targetAsin = normalizeAsin(storage.targetAsin || storage.lastSnapshot?.asin);
    const targetCode = extractModelCode(storage.targetCode || storage.lastSnapshot?.code || storage.lastSnapshot?.title);
    const matched = Boolean(
      (targetAsin && signalAsin && targetAsin === signalAsin)
      || (targetCode && signalCode && targetCode === signalCode)
    );
    if (!matched) return { matched: false, reason: 'different_product' };

    storage.lastSignalSource = String(source || '日本拍賣');
    storage.lastSignalProduct = signalAsin || signalCode || String(product?.title || '');
    storage.lastSignalKind = String(kind || 'availability');
    const matchedAtMs = Date.now();
    storage.lastSignalMatchedAt = new Date(matchedAtMs).toISOString();
    const ordering = storage.status === 'ordering';
    let preempted = false;
    if (this.running && !ordering && this.page && !this.page.isClosed()) {
      this.signalRefreshRequested = true;
      this.signalPreemptRequested = true;
      const f5StartedAtMs = Date.now();
      storage.lastSignalF5StartedAt = new Date(f5StartedAtMs).toISOString();
      storage.lastSignalF5LatencyMs = Math.max(0, f5StartedAtMs - matchedAtMs);
      storage.lastSignalRefreshStatus = 'preempting_active_scan';
      preempted = true;
      await this.page.reload({ waitUntil: 'commit', timeout: 5_000 }).catch(() => {});
    } else if (this.running) {
      this.signalRefreshRequested = true;
      storage.lastSignalRefreshStatus = ordering ? 'queued_after_ordering' : 'queued_after_active_scan';
    } else {
      const f5StartedAtMs = Date.now();
      storage.lastSignalF5StartedAt = new Date(f5StartedAtMs).toISOString();
      storage.lastSignalF5LatencyMs = Math.max(0, f5StartedAtMs - matchedAtMs);
      storage.lastSignalRefreshStatus = 'scheduled_now';
      this.scheduleNext(0, 'signal');
    }
    await this.state.save();
    this.log(`日亞單品收到${storage.lastSignalSource}同品項提示：${storage.lastSignalProduct}，${preempted ? `已在 ${storage.lastSignalF5LatencyMs}ms 內搶占並 F5` : this.running ? '目前正在送單，完成後立刻再 F5' : '立刻 F5'}。`);
    return { matched: true, queued: this.running && !preempted, preempted, asin: signalAsin, code: signalCode };
  }

  async openLogin() {
    const targetUrl = normalizeAmazonJpCheckoutUrl(this.getConfig()?.targetUrl);
    this.stop();
    await this.closeBrowser();
    const page = await this.pageFor(false);
    this.interactive = true;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return { message: '日亞單品專用視窗已開啟；請在該視窗完成登入，並保留正確的單一商品結帳頁。' };
  }

  async completeLogin() {
    if (!this.interactive || !this.page || this.page.isClosed()) throw new Error('目前沒有日亞單品登入視窗，請先按「開啟專用視窗」');
    const snapshot = await this.snapshot(this.page);
    if (snapshot.loginRequired) return { ok: false, message: '尚未辨識到日亞登入完成；視窗會保持開啟。' };
    if (!CHECKOUT_PATH.test(new URL(this.page.url()).pathname)) return { ok: false, message: '已登入，但目前不是購物車／結帳頁；請開回目標結帳網址再檢查。' };
    const storage = this.storage();
    storage.loginVerifiedAt = new Date().toISOString();
    storage.status = 'ready';
    await this.state.save();
    this.interactive = false;
    await this.closeBrowser();
    return { ok: true, message: `日亞登入與結帳頁已確認：${snapshot.title || '目標商品'}。現在可啟用自動刷新。` };
  }

  async advanceCheckout(page, initial, onSubmit = () => {}) {
    return advanceAmazonJpCheckout(page, (targetPage) => this.snapshot(targetPage), name => {
      if (name === 'submit_order') onSubmit();
    });
  }

  async scanOnce() {
    if (this.running) return { skipped: true };
    if (this.storage().status === 'needs_review') return { skipped: true, reason: 'order_needs_review' };
    this.running = true;
    this.signalPreemptRequested = false;
    const storage = this.storage();
    let availabilityTriggered = false;
    let submitted = false;
    try {
      const targetSuccessCount = Math.max(1, Number(this.getConfig()?.targetSuccessCount) || 1);
      if (storage.completedCount >= targetSuccessCount) {
        storage.status = 'completed';
        await this.state.save();
        await this.onTerminal({ status: 'already_completed' });
        this.stop();
        return { status: 'completed', skipped: true };
      }
      const targetUrl = normalizeAmazonJpCheckoutUrl(this.getConfig()?.targetUrl);
      const page = await this.pageFor(true);
      if (page.url() === targetUrl) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      else await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(500);
      let snapshot = await this.snapshot(page);
      if (snapshot.asin) storage.targetAsin = snapshot.asin;
      if (snapshot.code) storage.targetCode = snapshot.code;
      storage.refreshCount = Number(storage.refreshCount || 0) + 1;
      storage.lastCheckedAt = new Date().toISOString();
      storage.lastSnapshot = snapshot;
      storage.lastError = '';
      if (snapshot.loginRequired) throw new Error('日亞專用瀏覽器尚未登入或登入已失效');
      if (snapshot.itemCount !== 1) throw new Error(`目標結帳頁必須剛好只有 1 項商品，目前辨識到 ${snapshot.itemCount} 項`);
      if (!Number.isInteger(snapshot.quantity) || snapshot.quantity < 1 || snapshot.stockLimited) {
        storage.status = 'waiting_stock';
        storage.lastErrorNotifiedKey = '';
        await this.state.save();
        return { status: storage.status, snapshot };
      }
      availabilityTriggered = true;
      if (!snapshot.sellerConfirmed) {
        await page.waitForTimeout(1500);
        snapshot = await this.snapshot(page);
        storage.lastSnapshot = snapshot;
      }
      storage.lastErrorNotifiedKey = '';
      storage.status = 'ordering';
      storage.triggeredAt = new Date().toISOString();
      await this.state.save();
      if (!snapshot.sellerConfirmed) throw new Error('偵測到數量恢復，但商品賣家不是 Amazon.co.jp，本輪不送單');
      const result = await this.advanceCheckout(page, snapshot, () => { submitted = true; });
      const confirmed = result.status === 'ordered' && Boolean(result.snapshot.orderId);
      if (!confirmed) result.status = 'submitted_unconfirmed';
      if (confirmed) storage.completedCount += 1;
      const taskComplete = confirmed && storage.completedCount >= targetSuccessCount;
      storage.status = taskComplete ? 'completed' : confirmed ? 'waiting_stock' : 'needs_review';
      storage.lastOrderStatus = result.status;
      storage.lastOrderAt = new Date().toISOString();
      storage.resultUrl = result.snapshot.url;
      await this.state.save();
      const orderNumber = result.snapshot.orderId ? `｜訂單 ${result.snapshot.orderId}` : '';
      await this.sendPrivateAndRecord(
        confirmed
          ? `✅ 日亞單品自動下單成功｜${snapshot.title}${orderNumber}｜本輪 ${storage.completedCount}/${targetSuccessCount}${taskComplete ? '，任務完成並停止' : '，繼續等待下一次補貨'}`
          : `⚠️ 日亞單品送單結果待確認｜${snapshot.title}｜請先核對訂單，已暫停刷新及重送`,
        confirmed ? 'success' : 'unconfirmed'
      );
      if (taskComplete || !confirmed) {
        storage.completedAt = new Date().toISOString();
        await this.onTerminal(result);
        this.stop();
      } else {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      }
      return result;
    } catch (error) {
      if (submitted) {
        storage.status = 'needs_review';
        storage.lastError = error.message;
        this.stop();
        await this.sendPrivateAndRecord(`⚠️ 日亞單品送單結果待確認｜請先核對訂單，已暫停刷新及重送`, 'unconfirmed');
        await this.state.save();
        throw error;
      }
      if (this.signalPreemptRequested) {
        storage.status = 'waiting_stock';
        storage.lastError = '';
        await this.state.save();
        return { status: 'preempted_for_signal' };
      }
      storage.status = 'retrying';
      storage.lastCheckedAt = new Date().toISOString();
      storage.lastError = error.message;
      const notificationKey = `${error.message}|${storage.lastSnapshot?.title || ''}`;
      if (availabilityTriggered && storage.lastErrorNotifiedKey !== notificationKey) {
        storage.lastErrorNotifiedKey = notificationKey;
        storage.lastFailureNotifiedAt = new Date().toISOString();
        await this.sendPrivateAndRecord(
          `❌ 日亞單品自動下單失敗｜${storage.lastSnapshot?.title || '目標商品'}｜原因：${error.message}｜系統會自動返回購物車並繼續刷新`,
          'failure'
        );
      }
      const targetUrl = String(this.getConfig()?.targetUrl || '');
      if (this.page && !this.page.isClosed() && targetUrl) {
        await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      }
      await this.state.save();
      throw error;
    } finally {
      this.running = false;
      if (this.signalRefreshRequested && this.getConfig()?.enabled && !['completed', 'needs_review'].includes(this.storage().status)) {
        this.signalRefreshRequested = false;
        this.scheduleNext(0, 'signal');
      }
    }
  }

  scheduleNext(delay, reason = 'interval') {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Number(delay) || 0);
    this.nextRefreshAt = new Date(Date.now() + wait).toISOString();
    this.timer = setTimeout(() => void this.runScheduledScan(reason), wait);
  }

  async runScheduledScan(reason = 'interval') {
    this.timer = null;
    this.nextRefreshAt = null;
    try {
      await this.scanOnce();
      if (reason === 'signal') {
        const storage = this.storage();
        storage.lastSignalRefreshStatus = 'completed';
        storage.lastSignalRefreshedAt = new Date().toISOString();
        await this.state.save();
      }
    } catch (error) {
      this.log(`日亞單品自動下單：${error.message}`);
    }
    if (!this.getConfig()?.enabled || ['completed', 'needs_review'].includes(this.storage().status) || this.timer) return;
    const delay = Math.max(1, Math.min(30, Number(this.getConfig()?.intervalSeconds) || 2)) * 1000;
    this.scheduleNext(delay);
  }

  start() {
    this.stop();
    if (!this.getConfig()?.enabled) return;
    if (this.storage().status === 'ordering') this.storage().status = 'needs_review';
    if (this.storage().status === 'needs_review') return;
    this.scheduleNext(0, 'startup');
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRefreshAt = null;
    this.signalRefreshRequested = false;
    this.signalPreemptRequested = false;
  }

  status() {
    return { ...this.getConfig(), ...this.storage(), running: this.running, interactive: this.interactive, nextRefreshAt: this.nextRefreshAt };
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
