import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { purchaseKeywordMatches, purchasePolicy, normalizeDispatchSettings } from './purchase-rules.js';
import { PurchaseLedger, taipeiPurchaseDay } from './purchase-ledger.js';
import { planAccountPurchase, sortPurchaseTasks, selectAccountBatch, compatibleWithPayment } from './purchase-dispatcher.js';
import { EsliteRestockTasks } from './eslite-restock-tasks.js';
import { canonicalFunboxProductId } from './funbox.js';
import { readEsliteOrderHistory, matchEsliteSingleProductOrder, matchEsliteProductOrder } from './eslite-orders.js';
import { fillEsliteBatchCart, verifyEsliteBatchQuote } from './eslite-batch-cart.js';
import { prepareEsliteAccountViaApi, readEsliteMemberDetail, resolveEsliteCheckoutSelection } from './eslite-account-setup.js';
import { PICKUP_SETUP_REQUIRED } from './pickup-setup.js';
import { isEsliteAccountSlot, esliteAccountSlots, esliteSlotIndex } from './eslite-account-slots.js';
import { classifyEsliteLogin, readEsliteLoginState, summarizeEsliteAuthReply } from './eslite-login-state.js';
import { normalizeEsliteBrowserSession, saveEsliteBrowserSession } from './eslite-browser-session.js';
import { clearInvalidEsliteAuth, seedEsliteAuthOnce, prepareExpiredEsliteAuthBeforeNavigation } from './eslite-auth-cleanup.js';
import { safePurchaseText, purchaseErrorSummary, safePurchaseStep } from './purchase-diagnostics.js';
import { readAndReleaseResponse, releaseResponse } from './api-response.js';
import { clearFunboxCart, readFunboxCart, reconcileFunboxCart, assertFunboxCheckoutRows } from './funbox-cart.js';
import { purchaseFunboxViaApi } from './funbox-api-checkout.js';
import { purchaseRequestBudget } from './purchase-deadline.js';
import { probeEslitePaymentChoices, cleanupEslitePaymentProbe } from './eslite-payment-probe.js';
import { PurchaseOrderStatusRefresher, readFunboxOrderStatus, readEsliteOrderStatus } from './purchase-order-status.js';
import { fillFunboxHomeContact, verifyFunboxRenderedCart, verifyFunboxAtmContact,
  installFunboxCheckoutResourcePolicy, captureFunboxCheckoutHtml } from './funbox-checkout.js';
import path from 'node:path';
import { chromium, request as playwrightRequest } from 'playwright';

const PLATFORM_LABELS = {
  funbox: 'Funbox 官網',
  eslite: '誠品線上',
  momo: 'momo購物網',
  kingstone: '墊腳石購物網'
};
const PURCHASE_NOTIFICATION_LABELS = {
  funbox: 'FUNBOX官網',
  eslite: '誠品線上',
  momo: 'momo購物網',
  kingstone: '墊腳石購物網'
};

const COMPLETED_STATUSES = new Set([
  'carted', 'cart', 'ordered', 'success', 'submitted_unconfirmed',
  'payment_failed', '3ds_pending'
]);
const ACTIONS = new Set(['cart', 'checkout']);
const FUNBOX_PAYMENTS = new Set(['seven_cod', 'virtual_atm_home']);
const ESLITE_PAYMENTS = new Set(['seven_cod', 'virtual_atm_home']);
const FUNBOX_CHECKOUT_LIMIT_WORDS = /超過限購|限購|每人限購|超過可購買數量|庫存不足|已達購買上限/;
const FUNBOX_ORDER_SUCCESS_WORDS = /訂單(?:已)?(?:成立|完成|成功)|感謝(?:您的)?(?:訂購|購買)|訂單編號\s*[:：]?\s*[A-Z0-9-]{6,}/i;
const FUNBOX_COLLECTION_API = 'https://shop.funbox.com.tw/category_products/takaratomy/beyblade.json?limit=100&page=1&sort_by=sell_from-desc';
// 同一帳號的 Cyberbiz 購物車共用同一組 Session；多開工作器不會增加
// 吞吐量，反而會互相清空購物車並把登入請求加倍。每個帳號固定一條線，
// A／B／C 三個不同帳號仍然可以同步下單。
const FUNBOX_WORKER_COUNT = 1;
const FUNBOX_MULTI_ACCOUNT_PRODUCT_CONCURRENCY = 1;
const FUNBOX_WAVE_COLLECT_MS = 250;
const FUNBOX_BATCH_ADD_TIMEOUT_MS = 2500;
const FUNBOX_BATCH_CART_VERIFY_TIMEOUT_MS = 1800;
const FUNBOX_SESSION_VERIFY_INTERVAL_MS = 9 * 60 * 1000;
const FUNBOX_SESSION_HEARTBEAT_INTERVAL_MS = 8 * 60 * 1000;
// JWT 的 24 小時到期時間可在本機判斷，不需要靠高頻請求續命。平常每
// 10 分鐘確認會員與空車；誠品掃描出現活動頁、上架、補貨或庫存變化時，
// 暫時切成 90 秒檢查。API-only 待命不因十分鐘到期而失效；JWT 到期、
// 官方拒絕、車內狀態不明才停止快線，不用反覆啟動瀏覽器。
const ESLITE_SESSION_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const ESLITE_SESSION_HEARTBEAT_ACCELERATED_MS = 90 * 1000;
const ESLITE_SESSION_HEARTBEAT_ACCELERATION_DURATION_MS = 5 * 60 * 1000;
const ESLITE_SESSION_HEARTBEAT_LANE_GAP_MS = 1500;
const ESLITE_API_READY_TTL_MS = ESLITE_SESSION_HEARTBEAT_INTERVAL_MS + 30 * 1000;
const ESLITE_API_ORDER_DEADLINE_MS = 30000;
const ESLITE_API_ORDER_WINDOW_MS = 30000;
const ESLITE_SESSION_RENEW_AHEAD_MS = 10 * 60 * 1000;
const FUNBOX_LOGIN_STAGGER_MS = 2000;
const FUNBOX_LOGIN_COOLDOWN_MS = 30 * 60 * 1000;
const FUNBOX_RETRY_LATER_WORDS = /retry\s+later|too\s+many\s+requests|請稍後再試|稍後重試|操作過於頻繁/i;
export const CART_MAINTENANCE_TIMES = Object.freeze(['08:50', '13:20']);
const ORDER_SUCCESS_WORDS = /訂單(?:已)?(?:成立|完成|成功)|感謝(?:您的)?(?:訂購|購買)|訂購完成|訂單編號\s*[:：]?\s*[A-Z0-9-]{6,}/i;
let funboxLoginCooldownUntil = 0;

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMinuteKey(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function detectOrderConfirmation({ platform = '', url = '', bodyText = '' } = {}) {
  const currentUrl = String(url || '');
  const text = String(bodyText || '').replace(/\s+/g, ' ').trim();
  let urlOrderId = '';
  try {
    urlOrderId = new URL(currentUrl, 'https://invalid.local/').searchParams.get('orderid') || '';
  } catch {
    urlOrderId = '';
  }
  const orderId = text.match(/訂單(?:編號|號碼)\s*[:：]?\s*([A-Z0-9-]{6,})/i)?.[1]
    || urlOrderId
    || '';
  const urlConfirmed = platform === 'eslite'
    ? /\/cart\/step3(?:[/?#]|$)|\/order(?:s)?\/(?:complete|success)/i.test(currentUrl)
    : /\/(?:order|orders|checkout)\/(?:complete|completed|success|thank)(?:[/?#]|$)/i.test(currentUrl)
      || /[?&](?:orderId|orderid|orderNo|orderno)=[A-Z0-9-]{6,}/i.test(currentUrl);
  const textConfirmed = ORDER_SUCCESS_WORDS.test(text);
  return {
    confirmed: Boolean(urlConfirmed || textConfirmed || orderId),
    orderId,
    evidence: orderId ? `訂單編號 ${orderId}` : urlConfirmed ? '完成頁網址' : textConfirmed ? '完成頁成功文字' : ''
  };
}

function funboxLoginCooldownError() {
  const remainingMinutes = Math.max(1, Math.ceil((funboxLoginCooldownUntil - Date.now()) / 60000));
  const error = new Error(`Funbox 官網暫時限制登入，已停止自動重試；約 ${remainingMinutes} 分鐘後再驗證`);
  error.code = 'FUNBOX_LOGIN_RATE_LIMITED';
  return error;
}

function assertFunboxLoginCooldown() {
  if (Date.now() < funboxLoginCooldownUntil) throw funboxLoginCooldownError();
}

function registerFunboxLoginRateLimit() {
  funboxLoginCooldownUntil = Math.max(funboxLoginCooldownUntil, Date.now() + FUNBOX_LOGIN_COOLDOWN_MS);
  throw funboxLoginCooldownError();
}

export const FUNBOX_PURCHASE_STATUS_MESSAGES = Object.freeze({
  submitted_unconfirmed: '送單結果待核對，已停止本帳號重送',
  success: '✅ 已自動結帳完成',
  payment_failed: '❌ 訂單已建立但付款失敗（show_failed），請手動完成付款',
  '3ds_pending': '⚠ 訂單已建立（需完成銀行 3DS 驗證才能付款）',
  checkout_limited: '🚫 結帳時被 CYBERBIZ 限購攔截，請手動調整數量後結帳',
  stock_out: '⚡ 結帳時商品已售完（已被其他人搶走）',
  inventory_conflict: '⚠ 官網庫存資料與購物車配置不同步，已安全停止',
  cart_conflict: '⚠ 購物車內容或數量未確認正確，已安全停止',
  rate_limited: '⏳ FUNBOX 暫時限制請求，已停止擴大重試',
  cart: '🛒 商品已在購物車，請手動完成結帳',
  failed: '❌ 自動購買失敗，請手動下單'
});

export const FUNBOX_SKIP_BUY_KEYWORDS = Object.freeze([
  'BXG-04', '銀牙烈虎', 'BX-33', 'BX-26', 'BXG-33',
  'BXG-29', 'BXG-20', '蜘蛛人', '暴風天馬', '烈焰飛鳳'
]);
export const ESLITE_SKIP_BUY_KEYWORDS = Object.freeze(['BX-10']);
export const SHARED_SKIP_BUY_KEYWORDS = Object.freeze([
  '戰鬥盒', '收納包', '戰鬥盤', '競技場', 'STADIUM'
]);

export const FUNBOX_BUY_KEYWORDS = Object.freeze([
  'BX-09',
  'UX-17', 'UX-21', 'UX-15', 'UX-04',
  'BX-46',
  'CX-16', 'CX-04',
  'UX-03', 'UX-16',
  'CX-11',
  'UX-11', 'UX-20', 'UX-10',
  'CX-07',
  'UX-01',
  'BX-35', 'BX-48', 'BX-49',
  'CX-19',
  'BX-50', 'BX-34',
  'CX-13', 'CX-08', 'CX-17', 'CX-05',
  'BX-42', 'BX-29', 'BX-30',
  'BXG-22', 'BXG-11'
]);

function normalizePurchaseKeywordList(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set();
  return source.map((item) => String(item || '').normalize('NFKC').trim())
    .filter((item) => {
      const key = item.toLocaleUpperCase('zh-TW');
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeFunboxKeywordText(value) {
  return String(value || '').normalize('NFKC').toUpperCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsFunboxKeyword(title, keyword) {
  return purchaseKeywordMatches(title, keyword);
}

export function funboxPurchaseStrategy(product = {}, rules = {}) {
  const title = String(product.title || product.name || '').trim();
  const skipBuyKeywords = normalizePurchaseKeywordList(rules.skipBuyKeywords, FUNBOX_SKIP_BUY_KEYWORDS);
  const buyKeywords = normalizePurchaseKeywordList(rules.buyKeywords, FUNBOX_BUY_KEYWORDS);
  const skippedKeyword = skipBuyKeywords.find((keyword) => containsFunboxKeyword(title, keyword));
  if (skippedKeyword) return {
    eligible: false, quantity: 0, rule: 'skip_keyword',
    label: `命中黑名單「${skippedKeyword}」，僅通知`, matchedKeyword: skippedKeyword, priority: null
  };
  const matchedKeyword = buyKeywords.find((keyword) => containsFunboxKeyword(title, keyword));
  if (!matchedKeyword) return {
    eligible: false, quantity: 0, rule: 'not_whitelisted',
    label: '未命中自動下單白名單，僅通知', matchedKeyword: '', priority: null
  };
  if (/隨機強化組/i.test(title)) {
    return {
      eligible: true, quantity: 3, rule: 'random_booster',
      label: `隨機強化組 ×3｜${matchedKeyword}`, matchedKeyword, priority: buyKeywords.indexOf(matchedKeyword)
    };
  }
  return {
    eligible: true, quantity: 1, rule: 'standard',
    label: `一般陀螺 ×1｜${matchedKeyword}`, matchedKeyword, priority: buyKeywords.indexOf(matchedKeyword)
  };
}

function funboxOrderReference(result = {}) {
  const explicit = String(result.orderNumber || '').trim();
  if (explicit) return explicit;
  const source = `${result.detail || ''} ${result.resultUrl || ''}`;
  const visibleNumber = source.match(/(?:訂單編號|訂單號碼|訂單序號)\s*[:：]?\s*([A-Z0-9-]{6,})/i)?.[1];
  if (visibleNumber) return visibleNumber;
  return source.match(/\/orders\/([A-Za-z0-9-]+)/)?.[1] || '網站已確認成立（單號待訂單頁更新）';
}

export function funboxPurchaseResultStatus(result = {}) {
  const explicit = String(result.purchaseStatus || result.status || '').trim().toLowerCase();
  if (result.status === 'submitted_unconfirmed' || explicit === 'submitted_unconfirmed') return 'submitted_unconfirmed';
  if (explicit === 'ordered' || explicit === 'success') return 'success';
  if (explicit === 'carted' || explicit === 'cart') return 'cart';
  // 舊紀錄會把所有例外都先標成 failed；先讓錯誤內容細分真正原因。
  if (explicit !== 'failed' && Object.hasOwn(FUNBOX_PURCHASE_STATUS_MESSAGES, explicit)) return explicit;
  const detail = `${result.error || ''} ${result.detail || ''} ${result.resultUrl || ''}`;
  if (/show_failed|付款失敗/i.test(detail)) return 'payment_failed';
  if (/3d[ -]?secure|3ds|銀行.*驗證/i.test(detail)) return '3ds_pending';
  if (/限購|購買上限|超過可購買數量/i.test(detail)) return 'checkout_limited';
  if (/購物車.*(?:多|其他|非本次)|cart[_ ]?conflict/i.test(detail)) return 'cart_conflict';
  if (/庫存資料.*不同步|inventory[_ ]?conflict|HTTP\s*409/i.test(detail)) return 'inventory_conflict';
  if (/HTTP\s*(?:429|503)|retry later|請稍後再試|操作過於頻繁/i.test(detail)) return 'rate_limited';
  if (/售完|售罄|庫存不足|已被其他人/i.test(detail)) return 'stock_out';
  if (/已在購物車|加入購物車|\/carts\//i.test(detail)) return 'cart';
  return 'failed';
}

function funboxPurchaseError(purchaseStatus, message) {
  const error = new Error(message);
  error.purchaseStatus = purchaseStatus;
  return error;
}

export function formatFunboxAccountPurchaseNotification(product = {}, accountResult = {}) {
  const slot = String(accountResult.slot || accountResult.accountSlot || '?').toUpperCase();
  const title = String(product.title || product.name || '未命名商品').trim();
  const url = String(product.url || '').trim();
  const duration = Number(accountResult.durationMs) > 0
    ? `\n耗時：${(Number(accountResult.durationMs) / 1000).toFixed(2)} 秒`
    : '';
  const purchaseStatus = funboxPurchaseResultStatus(accountResult);
  const statusMessage = FUNBOX_PURCHASE_STATUS_MESSAGES[purchaseStatus];
  const productLine = url ? `[${title}](${url})` : title;
  const attempts = Math.max(1, Number(accountResult.attempts) || 1);
  const retryLine = attempts > 1 ? `\n嘗試次數：${attempts} 次` : '';
  if (purchaseStatus === 'success') {
    const orderNumber = funboxOrderReference(accountResult);
    const paymentUrl = String(accountResult.paymentUrl || '').trim();
    const resultUrl = String(accountResult.resultUrl || '').trim();
    const checkoutUrl = paymentUrl || resultUrl;
    const paymentDeadline = String(accountResult.paymentDeadline || '').trim();
    const bankInfo = accountResult.bankCode && accountResult.bankAccount ? `\nATM：${accountResult.bankCode}｜${accountResult.bankAccount}` : '';
    const payment = accountResult.payment === 'virtual_atm_home' ? '虛擬 ATM' : accountResult.payment==='line_pay_home'?'一般宅配／LINE Pay 待付款（未付款）':'7-11 貨到付款';
    const cartItems = formatFunboxCartItems(accountResult, product);
    return {
      text: `自動購買成功｜FUNBOX官網\n帳號${slot}｜${payment}\n成功單號：${orderNumber}\n購物車內容：\n${cartItems}${checkoutUrl ? `\n結帳連結：${checkoutUrl}` : ''}${bankInfo}${paymentDeadline ? `\n付款期限：${paymentDeadline}` : ''}${retryLine}${duration}`,
      preview: `自動購買成功｜FUNBOX官網\n帳號${slot}｜${title}\n${statusMessage}`
    };
  }
  if (purchaseStatus === 'submitted_unconfirmed') return formatPlatformPurchaseNotification('funbox', product, { ...accountResult, status: 'submitted_unconfirmed' });
  if (['cart', 'payment_failed', '3ds_pending'].includes(purchaseStatus)) {
    const reason = String(accountResult.error || accountResult.detail || '').trim();
    return {
      text: `自動購買待接手｜FUNBOX官網\n帳號${slot}｜FUNBOX官網\n購買品項：${productLine}\n結果：${statusMessage}${reason ? `\n網站回覆：${reason}` : ''}${retryLine}${duration}`,
      preview: `自動購買待接手｜FUNBOX官網\n帳號${slot}｜${title}\n${statusMessage}`
    };
  }
  {
    const reason = String(accountResult.error || accountResult.detail || '網站未接受訂單').trim();
    return {
      text: `自動購買失敗｜FUNBOX官網\n帳號${slot}｜FUNBOX官網\n購買品項：${productLine}\n結果：${statusMessage}\n失敗原因：${reason}${retryLine}${duration}`,
      preview: `自動購買失敗｜FUNBOX官網\n帳號${slot}｜${title}\n${statusMessage}`
    };
  }
}

function formatFunboxCartItems(result = {}, fallbackProduct = null) {
  const productResults = Array.isArray(result.productResults) ? result.productResults : [];
  const products = Array.isArray(result.products) ? result.products : [];
  const entries = productResults.length
    ? productResults.map((item) => ({ product: item.product || item, quantity: item.quantity }))
    : products.length
      ? products.map((product) => ({ product, quantity: products.length === 1 ? result.quantity : 1 }))
      : fallbackProduct
        ? [{ product: fallbackProduct, quantity: result.quantity }]
        : [];
  if (!entries.length) return '• 網站已成立訂單（商品明細待訂單頁更新）';
  return entries.map(({ product, quantity }) => {
    const title = String(product?.title || product?.name || '未命名商品').trim();
    const url = String(product?.url || '').trim();
    const item = url ? `[${title}](${url})` : title;
    return `• ${item} ×${Math.max(1, Number(quantity) || 1)}`;
  }).join('\n');
}

export function formatFunboxAccountBatchNotification(products = [], accountResult = {}) {
  const slot = String(accountResult.slot || accountResult.accountSlot || '?').toUpperCase();
  const payment = accountResult.payment === 'virtual_atm_home' ? '虛擬 ATM' : accountResult.payment==='line_pay_home'?'一般宅配／LINE Pay 待付款（未付款）':'7-11 貨到付款';
  const waves = Array.isArray(accountResult.waves) ? accountResult.waves : [];
  const purchased = Array.isArray(accountResult.products) ? accountResult.products : [];
  const deferred = Array.isArray(accountResult.deferredProducts) ? accountResult.deferredProducts : [];
  const productLine = (product) => {
    const title = String(product?.title || '未命名商品');
    const url = String(product?.url || '');
    return url ? `[${title}](${url})` : title;
  };
  const waveLines = waves.map((wave, index) => {
    const succeeded = ['ordered', 'success'].includes(wave.status);
    const titles = (wave.products || []).map(productLine).join('、') || '無';
    const reference = funboxOrderReference(wave);
    if (!succeeded) return `第 ${index + 1} 張：${titles}\n結果：${FUNBOX_PURCHASE_STATUS_MESSAGES[funboxPurchaseResultStatus(wave)]}`;
    const checkoutUrl = String(wave.paymentUrl || wave.resultUrl || '').trim();
    const paymentDeadline = String(wave.paymentDeadline || '').trim();
    return `第 ${index + 1} 張訂單\n成功單號：${reference}\n購物車內容：\n${formatFunboxCartItems(wave)}${checkoutUrl ? `\n結帳連結：${checkoutUrl}` : ''}${paymentDeadline ? `\n付款期限：${paymentDeadline}` : ''}`;
  });
  const unresolved = deferred.length ? `\n尚未完成：${deferred.map(productLine).join('、')}` : '';
  const fullSuccess = accountResult.ok && deferred.length === 0 && purchased.length >= products.length;
  const heading = fullSuccess ? '自動購買成功｜FUNBOX官網' : purchased.length ? '自動購買部分完成｜FUNBOX官網' : '自動購買失敗｜FUNBOX官網';
  const reason = accountResult.error ? `\n結果：${accountResult.error}` : '';
  return {
    text: `${heading}\n帳號${slot}｜${payment}\n目標：${products.map(productLine).join('、')}\n${waveLines.join('\n') || '未成立訂單'}${unresolved}${reason}`,
    preview: `${heading}\n帳號${slot}｜取得 ${purchased.length}/${products.length} 款｜${payment}`
  };
}

function platformOrderReference(result = {}) {
  const explicit = String(result.orderNumber || result.orderId || '').trim();
  if (explicit) return explicit;
  const source = `${result.detail || ''} ${result.resultUrl || ''}`;
  const visibleNumber = source.match(/(?:訂單編號|訂單號碼|訂單序號)\s*[:：]?\s*([A-Z0-9-]{6,})/i)?.[1];
  if (visibleNumber) return visibleNumber;
  try {
    const parsed = new URL(String(result.resultUrl || ''));
    const queryOrder = parsed.searchParams.get('orderid') || parsed.searchParams.get('orderId');
    if (queryOrder) return queryOrder;
  } catch {}
  return source.match(/\/orders?\/([A-Za-z0-9-]+)/)?.[1]
    || '網站已確認成立（單號待訂單頁更新）';
}

export function formatPlatformPurchaseNotification(platform, product = {}, result = {}, options = {}) {
  const label = PURCHASE_NOTIFICATION_LABELS[platform] || PLATFORM_LABELS[platform] || String(platform || '購物網站');
  const slot = String(options.accountSlot || result.slot || result.accountSlot || 'A').toUpperCase();
  const title = String(product.title || product.name || '未命名商品').trim();
  const url = String(product.url || '').trim();
  const duration = Number(result.durationMs) > 0
    ? `\n耗時：${(Number(result.durationMs) / 1000).toFixed(2)} 秒`
    : '';
  if (result.status === 'ordered' && result.ok !== false) {
    const orderNumber = platformOrderReference(result);
    return {
      text: `自動購買成功｜${label}\n帳號${slot}｜［${title}］\n成功單號：${orderNumber}\n數量：${Math.max(1, Number(result.quantity) || 1)}${duration}${url ? `\n商品頁：${url}` : ''}`,
      preview: `自動購買成功｜${label}\n帳號${slot}｜${title}\n成功單號：${orderNumber}`
    };
  }
  const reason = purchaseErrorSummary(
    result.error
    || result.detail
    || (result.status === 'submitted_unconfirmed'
      ? '網站已接收送單操作，但尚未確認訂單成立'
      : result.status === 'carted'
        ? '只完成加入購物車，尚未成立訂單'
        : '網站未接受訂單')
  );
  if (result.status === 'submitted_unconfirmed') return {
    text: `訂單結果待核對｜${label}\n帳號${slot}｜［${title}］\n狀態：${reason}\n已停止重送，請核對官方訂單${duration}${url ? `\n商品頁：${url}` : ''}`,
    preview: `訂單結果待核對｜${label}\n帳號${slot}｜${title}\n禁止自動重送`
  };
  return {
    text: `自動購買失敗｜${label}\n帳號${slot}｜［${title}］\n失敗原因：${reason}${duration}${url ? `\n商品頁：${url}` : ''}`,
    preview: `自動購買失敗｜${label}\n帳號${slot}｜${title}\n失敗原因：${reason}`
  };
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function normalizeAction(value) {
  return ACTIONS.has(value) ? value : 'cart';
}

function conciseAutomationError(error) {
  return safePurchaseText(error || '等待人工登入');
}

function shouldRetryFunboxPurchase(error) {
  const status = funboxPurchaseResultStatus({
    status: 'failed', purchaseStatus: error?.purchaseStatus, error: error?.message
  });
  // 售罄、限購，或網站已經接收送單動作時都禁止重送，避免超賣或重複訂單。
  if (error?.orderSubmitted || [
    'stock_out', 'inventory_conflict', 'cart_conflict', 'rate_limited',
    'checkout_limited', 'payment_failed', '3ds_pending', 'cart', 'submitted_unconfirmed'
  ].includes(status)) {
    return false;
  }
  return /timeout|timed out|ERR_|ECONN|ENET|socket|target page|browser.*closed|HTTP\s*(?:429|500|502|503|504)|retry later|暫時|網路|連線/i
    .test(String(error?.message || error || ''));
}

function compactHttpResponseBody(value, maximum = 240) {
  const text = String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '伺服器未回傳原因';
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

export function normalizeAutoPurchaseConfig(input = {}) {
  const funboxPayment = FUNBOX_PAYMENTS.has(input.funbox?.payment)
    ? input.funbox.payment
    : 'virtual_atm_home';
  const funboxAccountPayments = Object.fromEntries(esliteAccountSlots(Object.keys(input.funbox?.accountPayments || {})).map((slot) => [
    slot,
    FUNBOX_PAYMENTS.has(input.funbox?.accountPayments?.[slot])
      ? input.funbox.accountPayments[slot]
      : ['A', 'B', 'C'].includes(slot) ? funboxPayment : 'virtual_atm_home'
  ]));
  const eslitePayment = ESLITE_PAYMENTS.has(input.eslite?.payment)
    ? input.eslite.payment
    : 'virtual_atm_home';
  const esliteAccountPayments = Object.fromEntries(esliteAccountSlots(Object.keys(input.eslite?.accountPayments || {})).map((slot) => [
    slot,
    ESLITE_PAYMENTS.has(input.eslite?.accountPayments?.[slot])
      ? input.eslite.accountPayments[slot]
      : ['A', 'B', 'C'].includes(slot) ? eslitePayment : 'virtual_atm_home'
  ]));
  // 舊共用黑名單只在升級時複製到兩份獨立名單，避免遺失原有限制。
  // 輸出不再保留共用欄位；日後編輯或同步其中一份不影響另一份。
  const legacyShared = Number(input.rulesVersion) < 2 || input.rulesVersion === undefined
    ? normalizePurchaseKeywordList(input.sharedSkipBuyKeywords, []) : [];
  const independentBlacklist = (platform, defaults) => normalizePurchaseKeywordList([
    ...normalizePurchaseKeywordList(input[platform]?.skipBuyKeywords, [...defaults, ...SHARED_SKIP_BUY_KEYWORDS]),
    ...legacyShared
  ], []);
  return {
    enabled: Boolean(input.enabled),
    pickupPolicyVersion: Number(input.pickupPolicyVersion) || 0,
    rulesVersion: 2,
    funbox: {
      ...normalizeDispatchSettings(input.funbox),
      enabled: Boolean(input.funbox?.enabled),
      action: normalizeAction(input.funbox?.action),
      quantity: clampInteger(input.funbox?.quantity, 1, 3, 1),
      payment: funboxPayment,
      accountPayments: funboxAccountPayments,
      maxAttempts: clampInteger(input.funbox?.maxAttempts, 1, 3, 3),
      priorityKeywords: normalizePurchaseKeywordList(input.funbox?.priorityKeywords, []),
      skipBuyKeywords: independentBlacklist('funbox', FUNBOX_SKIP_BUY_KEYWORDS),
      buyKeywords: normalizePurchaseKeywordList(
        input.funbox?.buyKeywords,
        FUNBOX_BUY_KEYWORDS
      )
    },
    eslite: {
      ...normalizeDispatchSettings(input.eslite),
      enabled: Boolean(input.eslite?.enabled),
      action: normalizeAction(input.eslite?.action),
      quantity: clampInteger(input.eslite?.quantity, 1, 3, 1),
      payment: eslitePayment,
      accountPayments: esliteAccountPayments,
      skipBuyKeywords: independentBlacklist('eslite', ESLITE_SKIP_BUY_KEYWORDS),
      buyMode: input.eslite?.buyMode === 'whitelist' ? 'whitelist' : 'all',
      buyKeywords: normalizePurchaseKeywordList(input.eslite?.buyKeywords, []),
      priorityKeywords: normalizePurchaseKeywordList(input.eslite?.priorityKeywords, []),
      useRecentStore: true
    }
  };
}

export function updateAutoPurchaseSettings(current, body = {}) {
  const config = normalizeAutoPurchaseConfig(current);
  const platforms = body.platform ? [body.platform] : ['funbox', 'eslite'];
  if (platforms.some((platform) => !['funbox', 'eslite'].includes(platform))) {
    throw new Error('目前自動下單只支援 FUNBOX 與誠品；MOMO／墊腳石已封存');
  }
  for (const platform of platforms) {
    const settings = config[platform];
    for (const [suffix, key] of Object.entries({ Enabled: 'enabled', Quantity: 'quantity', Payment: 'payment', AccountPayments: 'accountPayments', SkipBuyKeywords: 'skipBuyKeywords', BuyKeywords: 'buyKeywords', BuyMode: 'buyMode', PriorityKeywords: 'priorityKeywords', AccountModes: 'accountModes', BatchMaxItems: 'batchMaxItems', BatchCollectMs: 'batchCollectMs', BatchBuildMs: 'batchBuildMs', BatchMaxTotal: 'batchMaxTotal', BatchAllowPartial: 'batchAllowPartial', SevenCodBlockedKeywords: 'sevenCodBlockedKeywords' })) {
      const field = `${platform}${suffix}`;
      if (!Object.hasOwn(body, field)) continue;
      if (['skipBuyKeywords', 'buyKeywords', 'priorityKeywords', 'sevenCodBlockedKeywords'].includes(key)
        && (!Array.isArray(body[field]) || body[field].some(item => typeof item !== 'string'))) {
        throw new Error('黑白名單與優先關鍵字必須是文字陣列，原設定未變更');
      }
      if (key === 'buyMode' && !['all', 'whitelist'].includes(body[field])) {
        throw new Error('請選擇有效的購買範圍，原設定未變更');
      }
      if (key === 'accountModes' && (!body[field] || typeof body[field] !== 'object' || Array.isArray(body[field])
        || Object.entries(body[field]).some(([slot, mode]) => !isEsliteAccountSlot(slot) || !['single', 'batch'].includes(mode)))) throw new Error('帳號模式必須是單品或合單');
      if (key === 'batchAllowPartial' && typeof body[field] !== 'boolean') throw new Error('合單缺款設定必須是布林值');
      if (key.startsWith('batch') && key !== 'batchAllowPartial' && (!Number.isFinite(Number(body[field])) || (key === 'batchCollectMs' ? Number(body[field]) < 0 : Number(body[field]) <= 0))) throw new Error('合單上限必須是正數，集貨等待可為零');
      settings[key] = body[field];
    }
  }
  config.enabled = config.funbox.enabled || config.eslite.enabled;
  return normalizeAutoPurchaseConfig(config);
}

export function mergeAutoPurchaseLists(current, { from, to, list = 'both' } = {}) {
  if (!['funbox', 'eslite'].includes(from) || !['funbox', 'eslite'].includes(to) || from === to
    || !['black', 'white', 'both'].includes(list)) throw new Error('請指定不同的 FUNBOX／誠品名單與同步種類');
  const config = normalizeAutoPurchaseConfig(current);
  for (const key of list === 'black' ? ['skipBuyKeywords'] : list === 'white' ? ['buyKeywords'] : ['skipBuyKeywords', 'buyKeywords']) {
    // 目的地順序優先；來源只追加缺少項目，不改啟用、付款、數量或白名單模式。
    config[to][key] = normalizePurchaseKeywordList([...config[to][key], ...config[from][key]], []);
  }
  return config;
}

function maskAccount(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.includes('@')) {
    const [local, domain] = text.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (text.length <= 4) return '***';
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function shortAccount(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(0, 4);
  if (text.includes('@')) return `${text.slice(0, Math.min(3, text.indexOf('@')))}…`;
  return text.slice(0, 4);
}

function compactProduct(product) {
  return {
    id: String(product.id || product.guid || product.url || '').trim(),
    title: String(product.title || product.name || '未命名商品').trim(),
    url: String(product.url || '').trim(),
    stock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : null,
    variantId: product.variantId === null || product.variantId === undefined
      ? null
      : String(product.variantId),
    variantName: String(product.variantName || ''),
    qtyCap: Number.isFinite(Number(product.qtyCap)) ? Number(product.qtyCap) : null,
    purchasePriority: Number.isFinite(Number(product.purchasePriority ?? product.priority))
      ? Number(product.purchasePriority ?? product.priority)
      : null,
    reason: String(product.reason || 'available'),
    detectionSource: String(product.detectionSource || ''),
    detectedAt: product.detectedAt || new Date().toISOString()
  };
}

function funboxInventorySignature(product) {
  return JSON.stringify({
    variantId: String(product?.variantId || ''),
    stock: Number.isFinite(Number(product?.stock)) ? Number(product.stock) : null,
    qtyCap: Number.isFinite(Number(product?.qtyCap)) ? Number(product.qtyCap) : null
  });
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count() && await locator.isVisible()) return locator;
    } catch {
      // Continue to the next stable selector.
    }
  }
  return null;
}

async function waitForFirstVisible(page, selectors, { timeout = 10000, interval = 160 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    const locator = await firstVisible(page, selectors);
    if (locator) return locator;
    await page.waitForTimeout(Math.min(interval, Math.max(1, deadline - Date.now()))).catch(() => {});
  } while (Date.now() < deadline);
  return null;
}

async function waitForFirstEnabled(page, selectors, options) {
  const deadline = Date.now() + (options?.timeout || 10000);
  do {
    const locator = await firstVisible(page, selectors);
    if (locator) {
      try {
        if (await locator.isEnabled()) return locator;
      } catch {
        // The Vue node may be replaced while product data is loading. Retry it.
      }
    }
    await page.waitForTimeout(options?.interval || 160).catch(() => {});
  } while (Date.now() < deadline);
  return null;
}

async function anyPresent(page, selectors) {
  for (const selector of selectors) {
    try {
      if (await page.locator(selector).count()) return true;
    } catch {
      // Continue to the next stable selector.
    }
  }
  return false;
}

async function clickFirstStable(page, selectors, errorMessage) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const locator = await firstVisible(page, selectors);
    if (!locator) break;
    try {
      await locator.click({ timeout: 6000 });
      return locator;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(180).catch(() => {});
    }
  }
  throw new Error(lastError ? `${errorMessage}（頁面按鈕持續更新）` : errorMessage);
}

async function clickFast(locator) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 500 });
  } catch {
    // Sticky/footer controls can be ready while Playwright reports them outside
    // the viewport. The fast fallbacks below avoid wasting a flash-sale window.
  }
  try {
    await locator.click({ force: true, timeout: 1200 });
    return;
  } catch {
    await locator.evaluate((element) => element.click());
  }
}

async function gotoWithAbortRetry(page, url, options = {}) {
  const transientNetworkError = /net::(?:ERR_ABORTED|ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_TIMED_OUT)/i;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, {
        ...options,
        // A response body can be reset after Chromium has already committed the
        // CYBERBIZ cart navigation. Retrying from "commit" is much more stable
        // than requiring the same HTTP/2 stream to reach domcontentloaded.
        waitUntil: attempt === 0 ? options.waitUntil : 'commit'
      });
    } catch (error) {
      lastError = error;
      if (!transientNetworkError.test(String(error?.message || error))) throw error;
      await page.waitForTimeout(350 + attempt * 450).catch(() => {});
      if (/\/carts\//i.test(page.url()) && page.url() !== 'about:blank') {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        const checkoutReady = await page.locator(
          'tr.line-item, [data-translate-keys="shipping-and-payment"]'
        ).first().waitFor({ state: 'attached', timeout: 7000 }).then(() => true).catch(() => false);
        if (checkoutReady) return null;
      }
    }
  }
  throw lastError;
}

async function chooseCheckoutOption(page, selectors, errorMessage, { domClick = false } = {}) {
  const choice = await (domClick ? waitForFirstEnabled : waitForFirstVisible)(page, selectors, { timeout: 10000 });
  if (!choice) throw new Error(errorMessage);
  // FUNBOX cards handle click on their button. Checking the nested decorative
  // radio first can time out for 1.2s on every option without updating state.
  if (domClick) {
    await choice.evaluate(element => element.click());
    return choice;
  }
  try {
    const input = choice.locator('input[type="radio"], input[type="checkbox"]').first();
    // CYBERBIZ hides the native radio and renders a styled card. Playwright can
    // still safely check the real control with force; requiring visibility made
    // the old code click the card text without changing the selected radio.
    if (await input.count() && !await input.isDisabled().catch(() => false)) {
      await input.check({ force: true, timeout: 1200 });
      return choice;
    }
  } catch {
    // Some checkout choices are the input itself or a Vue-rendered text node.
  }
  await clickFast(choice);
  return choice;
}

export async function chooseFunboxVirtualAtmOptions(page) {
  const started = Date.now(), timings = {};
  const homeShippingSelectors = [
    'button[id^="homeDelivery-shipping-button-"]',
    'button:has-text("一般宅配")', 'label:has-text("一般宅配")'
  ];
  const legacyHomeDeliverySelectors = [
    'a#homeDelivery-shipping-tab',
    '[data-translate-keys="home-delivery"]',
    'button:has-text("宅配"):not(:has-text("一般宅配"))',
    'label:has-text("宅配"):not(:has-text("一般宅配"))'
  ];

  // CYBERBIZ currently renders 「一般宅配」 directly. Older layouts first
  // required a separate 「宅配」 tab. Wait for either layout so a missing
  // legacy tab never prevents the ATM path from reaching the real options.
  const shippingEntry = await waitForFirstVisible(
    page,
    [...homeShippingSelectors, ...legacyHomeDeliverySelectors],
    { timeout: 10000 }
  );
  if (!shippingEntry) throw new Error('找不到 Funbox 宅配／一般宅配選項');
  timings.entryReadyMs = Date.now() - started;

  let homeDelivery = null;
  let homeShipping = await firstVisible(page, homeShippingSelectors);
  if (!homeShipping) {
    homeDelivery = await chooseCheckoutOption(
      page,
      legacyHomeDeliverySelectors,
      '找不到 Funbox 宅配選項', { domClick: true }
    );
  }
  homeShipping = await chooseCheckoutOption(
    page,
    homeShippingSelectors,
    '找不到 Funbox 一般宅配選項', { domClick: true }
  );
  timings.shippingSelectedMs = Date.now() - started;
  const virtualAtm = await chooseCheckoutOption(page, [
    'div[data-payment-name="虛擬ATM"] button',
    'button:has-text("虛擬ATM")', 'label:has-text("虛擬ATM")',
    'button[id^="payment-button-"]:has-text("虛擬ATM")'
  ], '找不到 Funbox 虛擬 ATM 選項', { domClick: true });
  timings.atmSelectedMs = Date.now() - started;
  await page.waitForFunction(() => document.querySelector('#order_payment_service')?.value === 'cyberbizpay_atm'
    && Boolean(document.querySelector('[name="order[shipping_rate]"]')?.value), null, { timeout: 5000 });
  timings.stateReadyMs = Date.now() - started;
  return { homeDelivery, homeShipping, virtualAtm, timings };
}

async function chooseEsliteCheckoutOption(page, selectors, fieldName, errorMessage) {
  const choice = await waitForFirstVisible(page, selectors, { timeout: 25000 });
  if (!choice) throw new Error(errorMessage);
  const fieldSelector = `#formData input[name="${fieldName}"]`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = await choice.locator('.option').first().isVisible().catch(() => false)
      ? choice.locator('.option').first()
      : choice;
    await target.click({ force: true, timeout: 2500 }).catch(async () => {
      await target.evaluate((element) => element.click());
    });
    const applied = await page.waitForFunction((selector) => {
      const field = document.querySelector(selector);
      return Boolean(String(field?.value || '').trim());
    }, fieldSelector, { timeout: 7000 }).then(() => true).catch(() => false);
    if (applied) return choice;
    await page.waitForTimeout(250 + attempt * 250).catch(() => {});
  }
  throw new Error(`${errorMessage}（已點擊，但網站未套用選項）`);
}

async function assertCheckoutOptionSelected(page, choice, keywords, errorMessage) {
  const expected = (Array.isArray(keywords) ? keywords : [keywords])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  const deadline = Date.now() + 2500;
  do {
    const state = await choice.evaluate((element) => {
      const controls = [
        element.matches('input[type="radio"], input[type="checkbox"]') ? element : null,
        element.querySelector('input[type="radio"], input[type="checkbox"]')
      ].filter(Boolean);
      if (controls.some((control) => control.checked)) return { selected: true, text: element.textContent || '' };
      const candidates = [];
      let current = element;
      for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) candidates.push(current);
      const selected = candidates.some((node) => {
        const attrs = [
          node.getAttribute('aria-checked'), node.getAttribute('aria-pressed'),
          node.getAttribute('aria-selected'), node.getAttribute('data-checked'),
          node.getAttribute('data-selected'), node.getAttribute('data-active')
        ].map((value) => String(value || '').toLowerCase());
        if (attrs.includes('true')) return true;
        return /(^|\s)(?:active|selected|checked|is-active|is-selected)(?:\s|$)/i.test(String(node.className || ''));
      });
      return { selected, text: candidates.map((node) => node.textContent || '').join(' ') };
    }).catch(() => ({ selected: false, text: '' }));
    const normalizedText = String(state.text || '').replace(/\s+/g, ' ').toLowerCase();
    if (state.selected && expected.every((word) => normalizedText.includes(word))) return true;

    const checkedText = await page.locator('input[type="radio"]:checked, input[type="checkbox"]:checked')
      .evaluateAll((elements) => elements.map((element) => {
        const container = element.closest('label, [role="radio"], [role="option"], li, div');
        return container?.textContent || element.getAttribute('value') || '';
      }).join(' ')).catch(() => '');
    const normalizedChecked = String(checkedText || '').replace(/\s+/g, ' ').toLowerCase();
    if (expected.every((word) => normalizedChecked.includes(word))) return true;
    await page.waitForTimeout(120).catch(() => {});
  } while (Date.now() < deadline);
  const radioSummary = await page.locator('input[type="radio"]').evaluateAll((elements) => elements.map((element) => ({
    checked: element.checked,
    name: element.getAttribute('name') || '',
    value: element.getAttribute('value') || '',
    id: element.id || '',
    text: String(element.closest('label, li, div')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100)
  }))).catch(() => []);
  const checked = radioSummary.filter((item) => item.checked)
    .map((item) => `${item.name || item.id || 'radio'}=${item.value || item.text}`)
    .join('、');
  throw new Error(`${errorMessage}${checked ? `（目前選中：${checked}）` : ''}`);
}

async function normalizeSingleFunboxCartQuantity(page, targetQuantity) {
  // Cyberbiz may append an automatic gift row to the cart.  A sold-out gift
  // has no quantity control and must not be mistaken for a second purchased
  // product, otherwise the single-order safety check rejects a clean cart.
  const rows = page.locator('tr.line-item:has(input[data-testid="quantity-input"])');
  await rows.first().waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
  const rowCount = await rows.count().catch(() => 0);
  if (rowCount !== 1) {
    throw funboxPurchaseError(
      'cart_conflict',
      `Funbox 單品結帳購物車應只有 1 款商品，目前偵測到 ${rowCount} 款，已停止送單`
    );
  }
  const row = rows.first();
  const input = row.locator('input[data-testid="quantity-input"]').first();
  if (!await input.count()) throw new Error('Funbox 無法確認購物車商品數量，已停止送單');
  const target = Math.max(1, Number(targetQuantity) || 1);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = Number(await input.inputValue().catch(() => NaN));
    if (current === target) return current;
    const selector = current > target ? 'button[data-testid="minus-button"]' : 'button[data-testid="plus-button"]';
    const button = row.locator(selector).first();
    if (!Number.isFinite(current) || !await button.count() || await button.isDisabled().catch(() => true)) {
      throw new Error(`Funbox 購物車數量無法安全調整為 ${target} 組，已停止送單`);
    }
    await clickFast(button);
    await page.waitForTimeout(280);
  }
  throw new Error(`Funbox 購物車數量未能調整為 ${target} 組，已停止送單`);
}

async function normalizeFunboxBatchCartQuantities(page, expectedItems) {
  const items = Array.isArray(expectedItems) ? expectedItems : [];
  if (items.length === 1) {
    return normalizeSingleFunboxCartQuantity(page, items[0].quantity);
  }
  const rows = page.locator('tr.line-item:has(input[data-testid="quantity-input"])');
  await rows.first().waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
  const rowCount = await rows.count().catch(() => 0);
  if (rowCount !== items.length) {
    throw funboxPurchaseError(
      'cart_conflict',
      `Funbox 合單購物車應有 ${items.length} 款商品，目前偵測到 ${rowCount} 款，已停止送單`
    );
  }
  let totalQuantity = 0;
  const usedRows = new Set();
  for (const item of items) {
    const slug = (() => {
      try { return new URL(item.product.url).pathname.match(/\/products\/([^/?#]+)/i)?.[1] || ''; } catch { return ''; }
    })();
    const code = String(item.product.title || '').match(/(?:BXG|BX|CX|UX)-\d+/i)?.[0] || '';
    let rowIndex = -1;
    for (let index = 0; index < rowCount; index += 1) {
      if (usedRows.has(index)) continue;
      const row = rows.nth(index);
      const href = await row.locator('a[href*="/products/"]').first().getAttribute('href').catch(() => '');
      const text = await row.innerText().catch(() => '');
      if ((slug && String(href).toLowerCase().includes(`/products/${slug.toLowerCase()}`))
        || (code && String(text).toUpperCase().includes(code.toUpperCase()))) {
        rowIndex = index;
        break;
      }
    }
    if (rowIndex < 0) {
      throw funboxPurchaseError('cart_conflict', `Funbox 合單購物車找不到「${item.product.title}」，已停止送單`);
    }
    usedRows.add(rowIndex);
    const row = rows.nth(rowIndex);
    const input = row.locator('input[data-testid="quantity-input"]').first();
    const target = Math.max(1, Number(item.quantity) || 1);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = Number(await input.inputValue().catch(() => NaN));
      if (current === target) {
        totalQuantity += current;
        break;
      }
      const selector = current > target ? 'button[data-testid="minus-button"]' : 'button[data-testid="plus-button"]';
      const button = row.locator(selector).first();
      if (!Number.isFinite(current) || !await button.count() || await button.isDisabled().catch(() => true)) {
        throw new Error(`Funbox「${item.product.title}」數量無法安全調整為 ${target} 組，已停止送單`);
      }
      await clickFast(button);
      await page.waitForTimeout(280);
      if (attempt === 11) throw new Error(`Funbox「${item.product.title}」數量未能調整為 ${target} 組，已停止送單`);
    }
  }
  return totalQuantity;
}

async function assertCheckoutFormReady(page, errorPrefix) {
  const missing = await page.evaluate(() => [...document.querySelectorAll(
    'input[required], select[required], textarea[required], input[aria-required="true"], select[aria-required="true"], textarea[aria-required="true"]'
  )].filter((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return false;
    if (element.disabled) return false;
    if (element.matches('input[type="radio"]')) {
      const name = element.getAttribute('name');
      if (!name) return !element.checked;
      return ![...document.querySelectorAll('input[type="radio"]')]
        .some((radio) => radio.getAttribute('name') === name && radio.checked);
    }
    if (element.matches('input[type="checkbox"]')) return !element.checked;
    return !String(element.value || '').trim();
  }).map((element) => element.getAttribute('name') || element.id || element.getAttribute('placeholder') || element.tagName)
    .filter(Boolean).slice(0, 8)).catch(() => []);
  if (missing.length) throw new Error(`${errorPrefix}仍有未完成欄位：${missing.join('、')}`);
  return true;
}

async function saveCheckoutEvidence(page, evidencePath, { liveFormValues = false } = {}) {
  const target = String(evidencePath || '').trim();
  if (!target) return '';
  await fs.mkdir(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: true });
  await fs.writeFile(target.replace(/\.png$/i, '.html'), liveFormValues
    ? await captureFunboxCheckoutHtml(page) : await page.content(), 'utf8').catch(() => {});
  return target;
}

async function checkCheckoutAgreements(page) {
  const selectors = [
    'input[type="checkbox"][required]',
    'input[type="checkbox"][name*="agree" i]',
    'input[type="checkbox"][id*="agree" i]',
    'label:has-text("同意") input[type="checkbox"]',
    'label:has-text("已閱讀") input[type="checkbox"]',
    'label:has-text("服務條款") input[type="checkbox"]',
    'label:has-text("購物須知") input[type="checkbox"]'
  ];
  let checked = 0;
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const checkbox = matches.nth(index);
      try {
        if (!await checkbox.isVisible() || !await checkbox.isEnabled() || await checkbox.isChecked()) continue;
        await checkbox.check({ force: true, timeout: 1200 });
        checked += 1;
      } catch {
        // Dynamic duplicate nodes are harmless; checkout validation will report
        // any agreement that is still missing.
      }
    }
  }
  return checked;
}

async function fillFirst(page, selectors, value) {
  const locator = await firstVisible(page, selectors);
  if (!locator) return false;
  await locator.fill(String(value));
  return true;
}

async function clickFirst(page, selectors, errorMessage) {
  const locator = await firstVisible(page, selectors);
  if (!locator) throw new Error(errorMessage);
  await locator.click();
  return locator;
}

class BrowserPurchaseAdapter {
  constructor({
    dataDir,
    browserLauncher = (options) => chromium.launch(options),
    persistentContextLauncher = (userDataDir, options) => chromium.launchPersistentContext(userDataDir, options),
    log = () => {},
    getPickupProfile = () => ({ fullName: '', phone: '', storeName: '' }),
    getDeliveryProfile = () => ({
      fullName: '', phone: '', city: '', district: '', postalCode: '', address: ''
    }),
    profileName = ''
  }) {
    if (!profileName) throw new Error('購物平台必須配置獨立的專用瀏覽器資料夾');
    this.dataDir = dataDir;
    this.browserLauncher = browserLauncher;
    this.log = log;
    this.browser = null;
    this.browserLaunchPromise = null;
    this.browserHeadless = null;
    this.interactiveLogin = null;
    this.interactiveLoginSequence = 0;
    this.getPickupProfile = getPickupProfile;
    this.getDeliveryProfile = getDeliveryProfile;
    this.persistentContextLauncher = persistentContextLauncher;
    this.profileDirectory = path.join(dataDir, 'auto-purchase', 'browser-profiles', profileName);
    this.maintenanceCartUrl = '';
    this.maintenanceHeadless = true;
  }

  async _browser(headless = true) {
    if (this.browser?.isConnected() && this.browserHeadless !== headless) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    if (!this.browser || !this.browser.isConnected()) {
      if (!this.browserLaunchPromise) {
        this.browserLaunchPromise = this.browserLauncher({
          headless,
          channel: 'chrome',
          args: ['--disable-blink-features=AutomationControlled']
        }).then((browser) => {
          this.browser = browser;
          this.browserHeadless = headless;
          return browser;
        }).finally(() => {
          this.browserLaunchPromise = null;
        });
      }
      await this.browserLaunchPromise;
    }
    return this.browser;
  }

  async _context(sessionFile, { headless = true, launchArgs = [] } = {}) {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    if (this.profileDirectory) {
      await fs.mkdir(this.profileDirectory, { recursive: true });
      const context = await this.persistentContextLauncher(this.profileDirectory, {
        headless,
        channel: 'chrome',
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
        args: ['--disable-blink-features=AutomationControlled', ...launchArgs]
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await this._importLegacySessionOnce(context, sessionFile);
      return context;
    }
    const browser = await this._browser(headless);
    let storageState;
    try {
      await fs.access(sessionFile);
      storageState = sessionFile;
    } catch {
      storageState = undefined;
    }
    const context = await browser.newContext({
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
      storageState
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return context;
  }

  async _isolatedContext(sessionFile, { headless = true } = {}) {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    const browser = await this._browser(headless);
    let storageState;
    try {
      await fs.access(sessionFile);
      storageState = sessionFile;
    } catch {
      storageState = undefined;
    }
    const context = await browser.newContext({
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
      storageState
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return context;
  }

  async _blankIsolatedContext({ headless = true } = {}) {
    const browser = await this._browser(headless);
    const context = await browser.newContext({
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei'
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return context;
  }

  async _importLegacySessionOnce(context, sessionFile) {
    const markerFile = path.join(this.profileDirectory, '.legacy-session-imported');
    try {
      await fs.access(markerFile);
      return;
    } catch {
      // First launch of this dedicated browser profile.
    }
    try {
      const legacy = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
      if (Array.isArray(legacy.cookies) && legacy.cookies.length) {
        await context.addCookies(legacy.cookies);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log(`舊登入狀態移轉略過：${error.message}`);
    }
    await fs.writeFile(markerFile, new Date().toISOString(), { mode: 0o600 });
  }

  async close() {
    await this.accountBrowser?.browser.close().catch(() => {});
    this.accountBrowser = null;
    await this._closeInteractiveLogin();
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.browserLaunchPromise = null;
    this.browserHeadless = null;
  }

  async _closeInteractiveLogin() {
    const session = this.interactiveLogin;
    if (!session) return;
    this.interactiveLogin = null;
    if (session.timer) clearInterval(session.timer);
    await session.context?.close().catch(() => {});
  }

  async openAccountBrowser(onClosed = () => {}) {
    if (this.accountBrowser && !this.accountBrowser.page.isClosed()) {
      await this.accountBrowser.page.bringToFront();
      return { ok: true, message: '已開啟此帳號的原有視窗；關閉後恢復自動派單。' };
    }
    if (this.interactiveLogin?.page && !this.interactiveLogin.page.isClosed()) {
      await this.interactiveLogin.page.bringToFront();
      return { ok: true, message: '已顯示此帳號原有的登入視窗；未重複登入。' };
    }
    // A separate browser never closes a headless purchase worker. Only this
    // account's saved state is loaded; changes in a browsing window are not
    // blindly imported into the purchase session (the user may switch accounts).
    await fs.access(this.sessionFile);
    const browser = await this.browserLauncher({ headless: false, channel: 'chrome' });
    try {
      const context = await browser.newContext({ storageState: this.sessionFile, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
      const page = await context.newPage();
      const window = { browser, context, page };
      this.accountBrowser = window;
      const release = () => { if (this.accountBrowser === window) { this.accountBrowser = null; onClosed(); } };
      browser.once('disconnected', release);
      page.once('close', () => { void browser.close().catch(() => {}); });
      await page.goto(this instanceof EslitePurchaseAdapter ? 'https://www.eslite.com/member/orders' : 'https://shop.funbox.com.tw/account',
        { waitUntil: 'domcontentloaded', timeout: 25000 });
      return { ok: true, message: '已載入此帳號已保存的登入資料；不送帳密、不清車。此帳號暫停派單至視窗關閉；若官方憑證已到期，仍需重新登入。' };
    } catch (error) {
      await browser.close().catch(() => {});
      this.accountBrowser = null;
      throw error;
    }
  }

  async _keepInteractiveLogin({ context, page, sessionFile, label, error, validate, onValidated = () => {}, onAfterClose = () => {}, watchSameUrl = false, checkIntervalMs = 2000, keepOnBusy = false }) {
    if (page.isClosed?.()) {
      await context.close().catch(() => {});
      return { ok: false, pending: false, message: `${label} 登入視窗已關閉，未保存憑證；請重新開啟登入。` };
    }
    const sequence = ++this.interactiveLoginSequence;
    const initialUrl = page.url();
    const session = {
      sequence, context, page, sessionFile, label, validate,
      initialUrl, timer: null, validating: false, keepOnBusy
    };
    this.interactiveLogin = session;

    const clearIfCurrent = () => {
      if (this.interactiveLogin?.sequence !== sequence) return;
      if (session.timer) clearInterval(session.timer);
      this.interactiveLogin = null;
    };
    page.once('close', clearIfCurrent);
    context.once?.('close', clearIfCurrent);

    // Most login flows leave the login URL after the user completes CAPTCHA/SMS.
    // Detect that transition and persist the dedicated browser profile automatically.
    session.timer = setInterval(async () => {
      if (this.interactiveLogin?.sequence !== sequence || session.validating) return;
      if (page.isClosed?.()) { clearIfCurrent(); return; }
      let currentUrl;
      try {
        currentUrl = page.url();
      } catch {
        clearIfCurrent();
        return;
      }
      if (!currentUrl || (!watchSameUrl && (currentUrl === initialUrl || /login|signin/i.test(currentUrl)))) return;
      session.validating = true;
      try {
        if (!await validate(page)) return;
        await context.storageState({ path: sessionFile, indexedDB: true });
        await onValidated();
        await this._closeInteractiveLogin();
        await onAfterClose();
        this.log(`${label} 手動登入完成，私人 session 已自動儲存。`);
      } catch {
        // The user may still be between verification steps. Keep the window open.
      } finally {
        session.validating = false;
      }
    }, checkIntervalMs);
    session.timer.unref?.();

    return {
      ok: false,
      pending: true,
      message: `${label} 登入視窗會保持開啟。請直接在該視窗完成登入或官方驗證；完成後會自動保存，也可回控制台按「完成後檢查」。目前提示：${conciseAutomationError(error)}`
    };
  }

  async _completeInteractiveLogin({ label, successMessage, validate }) {
    const session = this.interactiveLogin;
    if (!session) {
      throw new Error(`${label} 目前沒有等待中的登入視窗，請先按「開啟登入視窗」`);
    }
    if (!session.page || session.page.isClosed()) {
      await this._closeInteractiveLogin();
      throw new Error(`${label} 登入視窗已被關閉，請重新開啟`);
    }
    const loggedIn = await validate(session.page).catch(() => false);
    if (!loggedIn) {
      return {
        ok: false,
        pending: true,
        message: `${label} 尚未辨識到登入成功。視窗不會關閉，請完成圖形／簡訊驗證後再按一次「完成後檢查」。`
      };
    }
    await session.context.storageState({ path: session.sessionFile, indexedDB: true });
    await this._closeInteractiveLogin();
    return { ok: true, pending: false, message: successMessage };
  }

  async _clearCart(page, cartUrl) {
    await gotoWithAbortRetry(page, cartUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const isEsliteCart = /(?:^|\.)eslite\.com$/i.test(new URL(cartUrl).hostname);
    if (isEsliteCart) {
      // 誠品購物車是 Vue 非同步載入；過早判定會把尚未渲染的舊商品當成空車。
      await page.waitForTimeout(3500);
      const cartSettled = await page.waitForFunction(() => {
        if (document.querySelector('.cart-item-row[data-cart-item-id]')) return true;
        const body = document.body?.innerText || '';
        if (/購物車(?:內)?(?:目前)?(?:沒有|無)商品|購物車是空的|尚無商品/.test(body)) return true;
        const orderBody = document.querySelector('.card-local .ec-card-body');
        const loading = orderBody?.querySelector('img[src*="loading"], [class*="loading"], [class*="spinner"]');
        return Boolean(orderBody && !loading && /商品總金額\s*\$?\s*0/.test(body));
      }, null, { timeout: 30000 }).then(() => true).catch(() => false);
      if (!cartSettled) throw new Error('誠品購物車在 30 秒內沒有完成載入，為避免混入舊商品已停止下單');
    } else {
      await page.waitForTimeout(800);
    }
    let removed = 0;
    for (let attempt = 0; attempt < (isEsliteCart ? 10 : 30); attempt += 1) {
      const previousEsliteItems = isEsliteCart
        ? await page.locator('.cart-item-row[data-cart-item-id]').count().catch(() => 0)
        : 0;
      const remove = await firstVisible(page, [
        'button:has-text("刪除")', 'button:has-text("移除")',
        'a:has-text("刪除")', 'a:has-text("移除")',
        '.cart-item-row [class*="cursor-pointer"]:has-text("刪除商品")',
        '[aria-label*="刪除"]', '[aria-label*="移除"]',
        '[data-qe-id*="remove"]', '[class*="remove"]',
        'text=刪除商品',
        'tr:has(a[href*="/products/"]) td:last-child button'
      ]);
      if (!remove) break;
      await remove.click().catch(() => {});
      removed += 1;
      await page.waitForTimeout(450);
      const confirm = await firstVisible(page, [
        '.ec-modal:visible button.btn-ok:has-text("確認")',
        '[role="dialog"]:visible button:has-text("確認")',
        'button:has-text("確認刪除")', 'button:has-text("確定")', 'button:has-text("確認")'
      ]);
      if (confirm) await confirm.click().catch(() => {});
      if (isEsliteCart && previousEsliteItems > 0) {
        const decreased = await page.waitForFunction((previous) =>
          document.querySelectorAll('.cart-item-row[data-cart-item-id]').length < previous,
        previousEsliteItems, { timeout: 12000 }).then(() => true).catch(() => false);
        if (!decreased) throw new Error('誠品購物車刪除按鈕已點擊，但 12 秒內商品數量沒有下降，已停止避免重複操作');
      }
      await page.waitForTimeout(450);
    }
    if (isEsliteCart) {
      const remaining = await page.locator('.cart-item-row[data-cart-item-id]').count().catch(() => 0);
      if (remaining > 0) throw new Error(`誠品購物車清理後仍有 ${remaining} 款商品，已停止下單`);
    }
    return removed;
  }

  async maintainSession({ clearCart = false } = {}) {
    if (this.interactiveLogin) {
      return { ok: false, skipped: true, reason: '正在等待人工登入，避免關閉或干擾登入視窗' };
    }
    const context = await this._context(this.sessionFile, { headless: this.maintenanceHeadless });
    const page = await context.newPage();
    try {
      await this._login(page, context);
      let removed = 0;
      if (clearCart) {
        if (!this.maintenanceCartUrl) throw new Error('此平台尚未設定購物車保養網址');
        removed = await this._clearCart(page, this.maintenanceCartUrl);
      }
      await context.storageState({ path: this.sessionFile, indexedDB: true });
      return { ok: true, loggedIn: true, cleared: Boolean(clearCart), removed };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async _fillPickupContact(page) {
    const profile = this.getPickupProfile();
    const fillExactVisible = async (selectors, value) => {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.count() && await locator.isVisible().catch(() => false)) {
          await locator.fill(String(value)).catch(() => {});
        }
      }
    };
    if (profile.fullName) {
      await fillExactVisible([
        'input[name="order[billing_address_attributes][name]"]',
        'input[name="order[shipping_address_attributes][name]"]'
      ], profile.fullName);
      await fillFirst(page, [
        'input[name*="recipientName" i]', 'input[name*="receiverName" i]',
        'input[name*="consignee" i]', 'input[placeholder*="收件人"]',
        'input[aria-label*="收件人"]', 'input[placeholder*="取件人"]',
        'input[aria-label*="取件人"]', 'input[autocomplete="name"]'
      ], profile.fullName).catch(() => false);
    }
    if (profile.phone) {
      await fillExactVisible([
        'input[name="order[billing_address_attributes][phone]"]',
        'input[name="order[shipping_address_attributes][phone]"]'
      ], profile.phone);
      await fillFirst(page, [
        'input[name*="recipientPhone" i]', 'input[name*="receiverPhone" i]',
        'input[name*="mobile" i]', 'input[placeholder*="手機"]',
        'input[placeholder*="電話"]', 'input[aria-label*="手機"]',
        'input[aria-label*="電話"]', 'input[autocomplete="tel"]'
      ], profile.phone).catch(() => false);
    }
  }

  async _fillHomeDeliveryContact(page) {
    const profile = this.getDeliveryProfile();
    if (
      !profile.fullName
      || !/^09\d{8}$/.test(profile.phone)
      || !profile.city
      || !profile.district
      || !/^\d{3,5}$/.test(profile.postalCode)
      || !profile.address
    ) {
      throw new Error('尚未設定完整的 Funbox 宅配收件資料');
    }
    const fill = async (selector, value) => {
      const field = page.locator(selector).first();
      if (!await field.count() || !await field.isVisible().catch(() => false)) {
        throw new Error(`Funbox 宅配欄位已變更：${selector}`);
      }
      await field.fill(String(value));
    };
    await fill('input[name="order[billing_address_attributes][name]"]', profile.fullName);
    await fill('input[name="order[billing_address_attributes][phone]"]', profile.phone);
    const city = page.locator('select[name="order[billing_address_attributes][city]"]').first();
    if (!await city.count()) throw new Error('Funbox 找不到宅配縣市欄位');
    await city.selectOption({ label: profile.city }).catch(() => city.selectOption(profile.city));
    await page.waitForTimeout(150);
    const district = page.locator('select[name="order[billing_address_attributes][district]"]').first();
    if (!await district.count()) throw new Error('Funbox 找不到宅配區域欄位');
    await district.selectOption({ label: profile.district }).catch(() => district.selectOption(profile.district));
    await fill('input[name="order[billing_address_attributes][zip]"]', profile.postalCode);
    await fill('input[name="order[billing_address_attributes][address1]"]', profile.address);
    await fill('input[name="order[shipping_address_attributes][name]"]', profile.fullName);
    await fill('input[name="order[shipping_address_attributes][phone]"]', profile.phone);
  }

  async _chooseSavedStore(page, { verify = false } = {}) {
    const storeName = String(this.getPickupProfile().storeName || '').trim();
    if (!storeName) return false;
    const store = await firstVisible(page, [
      `label:has-text("${storeName}")`, `button:has-text("${storeName}")`,
      `input[type="radio"]:near(:text("${storeName}"))`, `text=${storeName}`
    ]);
    if (!store) return false;
    await chooseCheckoutOption(page, [
      `label:has-text("${storeName}")`, `button:has-text("${storeName}")`,
      `input[type="radio"]:near(:text("${storeName}"))`, `text=${storeName}`
    ], `找不到已儲存門市「${storeName}」`);
    if (verify) {
      await assertCheckoutOptionSelected(
        page, store, [storeName], `門市「${storeName}」未成功選取`
      );
    }
    return true;
  }

  async _chooseSavedDeliveryAddress(page, { verify = false } = {}) {
    const profile = this.getDeliveryProfile();
    const tokens = [profile.address, profile.district, profile.fullName]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (!tokens.length) return false;
    for (const token of tokens) {
      const escaped = token.replace(/"/g, '\\"');
      const option = await firstVisible(page, [
        `label:has-text("${escaped}")`, `button:has-text("${escaped}")`,
        `input[type="radio"]:near(:text("${escaped}"))`, `text=${escaped}`
      ]);
      if (!option) continue;
      const selected = await chooseCheckoutOption(page, [
        `label:has-text("${escaped}")`, `button:has-text("${escaped}")`,
        `input[type="radio"]:near(:text("${escaped}"))`, `text=${escaped}`
      ], `找不到已儲存宅配地址「${token}」`);
      if (verify) {
        await assertCheckoutOptionSelected(page, selected, [token], `宅配地址「${token}」未成功選取`);
      }
      return true;
    }
    return false;
  }
}

export class FunboxPurchaseAdapter extends BrowserPurchaseAdapter {
  constructor(options) {
    super({ ...options, profileName: options.profileName || 'funbox' });
    this.accountSlot = String(options.accountSlot || 'A').toUpperCase();
    this.accountLabel = `帳號 ${this.accountSlot}`;
    this.sessionFile = options.sessionFile || path.join(options.dataDir, 'auto-purchase', 'funbox-session.json');
    // 每個帳號只有一條購物車作業線；ABC 才是彼此獨立的購買工作器。
    this.workerCount = Math.max(1, Number(options.workerCount) || FUNBOX_WORKER_COUNT);
    this.maxConcurrency = this.workerCount;
    this.warmPoolEnabled = false;
    this.warmPoolClosed = false;
    this.warmWorkers = [];
    this.warmWorkerWaiters = [];
    this.warmWorkerCreating = 0;
    this.warmPoolTimer = null;
    this.loginState = 'idle';
    this.lastVerifiedAt = null;
    this.nextVerifyAt = null;
    this.lastVerifyError = '';
    this.getCredentials = options.getCredentials || (() => ({
      account: String(options.email || ''), password: String(options.password || '')
    }));
    this.maintenanceCartUrl = 'https://shop.funbox.com.tw/cart';
    this.getPurchaseHold = options.getPurchaseHold || (() => null);
    this.purchaseHold = null;
    this.getPickupSetup = options.getPickupSetup;
    this.onPickupOrderConfirmed=options.onPickupOrderConfirmed;
    this.getSelectedPayment = options.getSelectedPayment || (() => 'virtual_atm_home');
    this.apiAtmCheckout = options.apiAtmCheckout === true;
    this.apiContextFactory = options.apiContextFactory || (options => playwrightRequest.newContext(options));
  }

  activePurchaseHold() { return this.purchaseHold || this.getPurchaseHold(); }

  async maintainSession(options = {}) {
    if (this.accountBrowser) return { ok: false, skipped: true, reason: '帳號瀏覽器使用中' };
    options = { clearCart: false, ...options };
    if (options.clearCart !== false && this.activePurchaseHold()) {
      return { ok: false, skipped: true, reason: '訂單結果待核對，禁止保養清車' };
    }
    if (this.apiAtmCheckout && ['virtual_atm_home','seven_cod'].includes(this.getSelectedPayment())) {
      let worker;
      try {
        worker = await this._acquireWarmWorker({apiOnly:true});
        worker.authenticatedAt = 0;
        await this._ensureWarmWorkerLogin(worker);
        const evidence = options.clearCart === false ? {removed:0} : await clearFunboxCart(worker.context);
        if (options.clearCart !== false) this.lastCartClearEvidence = {...evidence,state:'empty_verified'};
        return {ok:true,transport:'http_api',removed:evidence.removed};
      } catch (cause) { return {ok:false,error:purchaseErrorSummary(cause)}; }
      finally { await this._releaseWarmWorker(worker); }
    }
    return super.maintainSession(options);
  }

  credentialsStatus() {
    const { account, password } = this.getCredentials();
    return {
      ready: Boolean(account && password),
      account: maskAccount(account),
      displayAccount: shortAccount(account),
      slot: this.accountSlot,
      loginState: this.loginState,
      lastVerifiedAt: this.lastVerifiedAt,
      nextVerifyAt: this.nextVerifyAt,
      lastError: this.lastVerifyError
    };
  }

  runtimeStatus() {
    return {
      accountBrowserOpen: Boolean(this.accountBrowser),
      cartActionUncertain: Boolean(this.cartActionUncertain),
      state: !this.warmPoolEnabled
        ? 'disabled'
        : this.warmWorkers.length >= this.workerCount
          ? 'ready'
          : 'warming',
      warmWorkers: this.warmWorkers.length,
      idleWorkers: this.warmWorkers.filter((worker) => !worker.busy).length,
      maxConcurrency: this.maxConcurrency,
      checkoutTransport: this.apiAtmCheckout && ['virtual_atm_home','seven_cod'].includes(this.getSelectedPayment()) ? 'http_api' : 'browser',
      accountSlot: this.accountSlot,
      pickupSetupReady: this.getPickupSetup ? Boolean(this.getPickupSetup()) : undefined,
      pickupSetupRequired: !this.apiAtmCheckout && this.getSelectedPayment() === 'seven_cod' && this.getPickupSetup && !this.getPickupSetup(),
      pickupSelectionPending:this.getSelectedPayment()==='seven_cod'&&this.getPickupSetup&&!this.getPickupSetup(),
      interactiveLoginOpen: Boolean(this.interactiveLogin),
      purchaseHold: this.activePurchaseHold(),
      heartbeatEnabled: this.warmPoolEnabled,
      loginState: this.loginState,
      lastVerifiedAt: this.lastVerifiedAt,
      nextVerifyAt: this.nextVerifyAt,
      lastError: this.lastVerifyError,
      quantityRule: '黑名單優先｜白名單命中才買｜獨立優先關鍵字排序｜一般 ×1｜隨機強化組 ×3',
      cartClear: this.lastCartClearEvidence || null
    };
  }

  async _loggedIn(page) {
    await page.goto('https://shop.funbox.com.tw/account', {
      waitUntil: 'domcontentloaded', timeout: 25000
    }).catch(() => {});
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (FUNBOX_RETRY_LATER_WORDS.test(bodyText)) registerFunboxLoginRateLimit();
    return !/\/account\/login/i.test(page.url());
  }

  async _login(page, context, { interactive = false } = {}) {
    const { account, password } = this.getCredentials();
    if (!account || !password) throw new Error('尚未在控制台儲存 Funbox 私人購買帳密');
    if (await this._loggedIn(page)) return true;
    assertFunboxLoginCooldown();
    await page.goto('https://shop.funbox.com.tw/account/login', {
      waitUntil: 'domcontentloaded', timeout: 25000
    });
    const loginBodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (FUNBOX_RETRY_LATER_WORDS.test(loginBodyText)) registerFunboxLoginRateLimit();
    const userFilled = await fillFirst(page, [
      'input[name="customer[login]"]', 'input[name="customer[email]"]',
      'input[type="email"]', 'input[autocomplete="username"]'
    ], account);
    const passwordFilled = await fillFirst(page, [
      'input[name="customer[password]"]', 'input[type="password"]',
      'input[autocomplete="current-password"]'
    ], password);
    if (!userFilled || !passwordFilled) throw new Error('Funbox 登入頁欄位已變更');
    const submit = await firstVisible(page, [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("登入")', 'button:has-text("會員登入")'
    ]);
    if (!submit) throw new Error('找不到 Funbox 登入按鈕');
    await submit.click();
    await page.waitForTimeout(interactive ? 2500 : 1500);
    if (interactive && /login/i.test(page.url())) {
      await page.waitForURL((url) => !/\/account\/login/i.test(url.pathname), { timeout: 120000 }).catch(() => {});
    }
    if (/\/account\/login/i.test(page.url())) throw new Error('Funbox 登入失敗，請檢查帳密或驗證畫面');
    await context.storageState({ path: this.sessionFile, indexedDB: true });
    return true;
  }

  async testLogin({ interactive = true } = {}) {
    if (this.accountBrowser) throw new Error('此帳號瀏覽器已開啟，請先關閉後再更新登入');
    await this._closeInteractiveLogin();
    const context = await this._context(this.sessionFile, { headless: !interactive });
    const page = await context.newPage();
    try {
      await this._login(page, context, { interactive });
      await context.close();
      return { ok: true, message: 'Funbox 登入成功，私人 session 已儲存。' };
    } catch (error) {
      if (interactive) {
        return this._keepInteractiveLogin({
          context, page, sessionFile: this.sessionFile, label: 'Funbox', error,
          validate: (targetPage) => this._loggedIn(targetPage)
        });
      }
      await context.close();
      throw error;
    }
  }

  async completeLogin() {
    return this._completeInteractiveLogin({
      label: 'Funbox',
      successMessage: 'Funbox 登入成功，私人 session 已儲存。',
      validate: (page) => this._loggedIn(page)
    });
  }

  async _requestLogin(context, { persist = true } = {}) {
    const { account, password } = this.getCredentials();
    if (!account || !password) throw new Error('尚未在控制台儲存 Funbox 私人購買帳密');
    assertFunboxLoginCooldown();
    const loginPage = await context.request.get('https://shop.funbox.com.tw/account/login', { timeout: 10000 });
    const html = await readAndReleaseResponse(loginPage);
    if ([429, 503].includes(loginPage.status()) || FUNBOX_RETRY_LATER_WORDS.test(html)) {
      registerFunboxLoginRateLimit();
    }
    const token = html.match(/name=["']authenticity_token["'][^>]*value=["']([^"']+)/i)?.[1]
      || html.match(/name=["']csrf-token["'][^>]*content=["']([^"']+)/i)?.[1];
    if (!token) throw new Error('Funbox 登入頁找不到安全權杖');
    const response = await context.request.post('https://shop.funbox.com.tw/account/login', {
      form: {
        'customer[login]': account,
        'customer[password]': password,
        authenticity_token: token
      },
      timeout: 12000,
      maxRedirects: 0
    });
    const responseBody = await readAndReleaseResponse(response).catch(() => '');
    if ([429, 503].includes(response.status()) || FUNBOX_RETRY_LATER_WORDS.test(responseBody)) {
      registerFunboxLoginRateLimit();
    }
    const location = response.headers().location || '';
    const loginSucceeded = response.status() >= 300 && response.status() < 400
      ? /\/account(?:\/index)?/i.test(location)
      : !/\/account\/login/i.test(response.url());
    if (!loginSucceeded) throw new Error('Funbox 登入失敗，請檢查帳密');
    if (persist) await context.storageState({ path: this.sessionFile, indexedDB: true });
    this.loginState = 'ready';
    this.lastVerifiedAt = new Date().toISOString();
    this.nextVerifyAt = new Date(Date.now() + FUNBOX_SESSION_VERIFY_INTERVAL_MS).toISOString();
    this.lastVerifyError = '';
    return true;
  }

  async _createWarmWorker({ apiOnly = this.apiAtmCheckout && ['virtual_atm_home','seven_cod'].includes(this.getSelectedPayment()) } = {}) {
    this.warmWorkerCreating += 1;
    let context;
    try {
      // 優先複製已儲存的登入狀態。只有 Session 真正失效時才送出一次
      // 登入請求，避免每次重啟都重新登入三個帳號。
      if (apiOnly) {
        const storageState = await fs.readFile(this.sessionFile, 'utf8').then(JSON.parse).catch(error => {
          if (error.code === 'ENOENT') return undefined; throw error;
        });
        const api = await this.apiContextFactory({storageState});
        context = {request:api,apiOnly:true,storageState:({indexedDB,...options}={})=>api.storageState(options),close:()=>api.dispose()};
      } else context = await this._isolatedContext(this.sessionFile);
      const worker = { context, apiOnly, busy: false, authenticatedAt: 0 };
      await this._ensureWarmWorkerLogin(worker);
      return worker;
    } catch (error) {
      await context?.close().catch(() => {});
      throw error;
    } finally {
      this.warmWorkerCreating = Math.max(0, this.warmWorkerCreating - 1);
    }
  }

  _registerIdleWorker(worker) {
    if (this.warmPoolClosed || (!this.warmPoolEnabled && !worker.busy)) {
      void worker.context.close().catch(() => {});
      return;
    }
    if (!this.warmWorkers.includes(worker)) this.warmWorkers.push(worker);
    const waiter = this.warmWorkerWaiters.shift();
    if (waiter) {
      worker.busy = true;
      waiter.resolve(worker);
      return;
    }
    worker.busy = false;
  }

  async _ensureWarmPool() {
    if (!this.warmPoolEnabled || this.warmPoolClosed) return;
    const missing = Math.max(0, this.workerCount - this.warmWorkers.length - this.warmWorkerCreating);
    if (!missing) return;
    const results = await Promise.allSettled(
      Array.from({ length: missing }, () => this._createWarmWorker())
    );
    let ready = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        this._registerIdleWorker(result.value);
        ready += 1;
      } else {
        this.log(`Funbox 購買工作器預熱失敗：${conciseAutomationError(result.reason)}`);
      }
    }
    if (ready) this.log(`Funbox ${this.accountLabel} 已預熱 ${this.warmWorkers.length}/${this.workerCount} 條獨立結帳線。`);
  }

  async setWarmPoolEnabled(enabled) {
    this.warmPoolEnabled = Boolean(enabled);
    if (this.warmPoolEnabled) {
      this.warmPoolClosed = false;
      await this._ensureWarmPool();
      if (!this.warmPoolTimer) {
        this.warmPoolTimer = setInterval(() => {
          void this._refreshWarmPoolSessions();
        }, FUNBOX_SESSION_HEARTBEAT_INTERVAL_MS);
        this.warmPoolTimer.unref?.();
      }
      return;
    }
    if (this.warmPoolTimer) clearInterval(this.warmPoolTimer);
    this.warmPoolTimer = null;
    const idle = this.warmWorkers.filter((worker) => !worker.busy);
    this.warmWorkers = this.warmWorkers.filter((worker) => worker.busy);
    await Promise.allSettled(idle.map((worker) => worker.context.close()));
    const waiters = this.warmWorkerWaiters.splice(0);
    waiters.forEach(({ reject }) => reject(new Error('Funbox 自動下單已關閉')));
  }

  async _refreshWarmPoolSessions() {
    if (!this.warmPoolEnabled || this.warmPoolClosed || this.accountBrowser) return;
    const idleWorkers = this.warmWorkers.filter((worker) => !worker.busy);
    const results = await Promise.allSettled(idleWorkers.map(async (worker) => {
      // 強制定期驗證；補貨真正發生時就不必臨時重新登入。
      worker.authenticatedAt = 0;
      await this._ensureWarmWorkerLogin(worker);
    }));
    const failedWorkers = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') failedWorkers.push(idleWorkers[index]);
    });
    if (failedWorkers.length) {
      this.warmWorkers = this.warmWorkers.filter((worker) => !failedWorkers.includes(worker));
      await Promise.allSettled(failedWorkers.map((worker) => worker.context.close()));
      this.log(`Funbox ${failedWorkers.length} 條預熱登入已失效，正在自動重建。`);
    }
    // 啟動時若剛好遇到 Retry Later，工作池可能一開始就是空的。
    // 心跳必須在冷卻後重新補建，不能永遠停在 warming 狀態。
    if (this.warmWorkers.length < this.workerCount) await this._ensureWarmPool();
  }

  async _acquireWarmWorker({apiOnly = this.apiAtmCheckout && ['virtual_atm_home','seven_cod'].includes(this.getSelectedPayment())} = {}) {
    const stale = this.warmWorkers.filter(worker => !worker.busy && Boolean(worker.apiOnly) !== apiOnly);
    this.warmWorkers = this.warmWorkers.filter(worker => !stale.includes(worker));
    await Promise.allSettled(stale.map(worker => worker.context.close()));
    const idle = this.warmWorkers.find((worker) => !worker.busy && Boolean(worker.apiOnly) === apiOnly);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    if (this.warmWorkers.length + this.warmWorkerCreating < this.workerCount) {
      const worker = await this._createWarmWorker({apiOnly});
      worker.busy = true;
      this.warmWorkers.push(worker);
      return worker;
    }
    return new Promise((resolve, reject) => {
      this.warmWorkerWaiters.push({ resolve, reject });
    });
  }

  async _releaseWarmWorker(worker, { healthy = true } = {}) {
    if (!worker) return;
    if (!healthy || this.warmPoolClosed || !this.warmPoolEnabled) {
      this.warmWorkers = this.warmWorkers.filter((candidate) => candidate !== worker);
      await worker.context.close().catch(() => {});
      if (this.warmPoolEnabled && !this.warmPoolClosed) void this._ensureWarmPool();
      return;
    }
    this._registerIdleWorker(worker);
  }

  async _ensureWarmWorkerLogin(worker) {
    if (Date.now() - worker.authenticatedAt < FUNBOX_SESSION_VERIFY_INTERVAL_MS) return;
    this.loginState = 'checking';
    try {
      const response = await worker.context.request.get('https://shop.funbox.com.tw/account', {
        timeout: 8000
      });
      const body = await readAndReleaseResponse(response).catch(() => '');
      if ([429, 503].includes(response.status()) || FUNBOX_RETRY_LATER_WORDS.test(body)) {
        registerFunboxLoginRateLimit();
      }
      if (/\/account\/login/i.test(response.url())) {
        await this._requestLogin(worker.context, { persist: true });
        if (worker.apiOnly) {
          const verified = await worker.context.request.get('https://shop.funbox.com.tw/account',{timeout:8000});
          const verifiedHtml = await readAndReleaseResponse(verified);
          if (!verified.ok() || /\/account\/login/i.test(verified.url()) || !/href=["'][^"']*\/account\/logout/i.test(verifiedHtml)) {
            throw funboxPurchaseError('needs_login','FUNBOX 登入請求後仍未確認會員狀態');
          }
        }
      } else if (worker.apiOnly && (!response.ok() || !/href=["'][^"']*\/account\/logout/i.test(body))) {
        throw funboxPurchaseError('needs_login','FUNBOX 會員 API 未確認登入，禁止加車或送單');
      }
      worker.authenticatedAt = Date.now();
      this.loginState = 'ready';
      this.lastVerifiedAt = new Date().toISOString();
      this.nextVerifyAt = new Date(Date.now() + FUNBOX_SESSION_VERIFY_INTERVAL_MS).toISOString();
      this.lastVerifyError = '';
    } catch (error) {
      this.loginState = 'error';
      this.lastVerifyError = conciseAutomationError(error);
      this.nextVerifyAt = new Date(
        error?.code === 'FUNBOX_LOGIN_RATE_LIMITED'
          ? funboxLoginCooldownUntil
          : Date.now() + FUNBOX_SESSION_HEARTBEAT_INTERVAL_MS
      ).toISOString();
      throw error;
    }
  }

  async _postCartAdd(context, variantId, quantity, timeout = 12000) {
    const response = await context.request.post('https://shop.funbox.com.tw/cart/add', {
      form: { id: variantId, quantity: String(quantity) },
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      timeout
    });
    const body = await readAndReleaseResponse(response).catch(() => '');
    return { response, body };
  }

  async _clearCart(page, cartUrl) {
    if (new URL(cartUrl).origin !== 'https://shop.funbox.com.tw') throw new Error('Funbox 清車位址不合法');
    this.lastCartClearEvidence = { cleared: false, state: 'checking', at: new Date().toISOString() };
    // Stop this task's React checkout page before mutations. Its debounced
    // quantity/delete updates must not race the direct add-to-cart API.
    if (page.url() !== 'about:blank') await page.goto('about:blank');
    try {
      const evidence = await clearFunboxCart(page.context());
      this.lastCartClearEvidence = { ...evidence, state: 'empty_verified' };
      this.log(`Funbox ${this.accountLabel} API 清車已確認｜移除 ${evidence.removed} 款｜${evidence.durationMs}ms`);
      return evidence.removed;
    } catch (error) {
      this.lastCartClearEvidence = { cleared: false, state: 'blocked', at: new Date().toISOString(),
        error: conciseAutomationError(error) };
      throw error;
    }
  }

  async _cartContainsProduct(context, product, timeout = FUNBOX_BATCH_CART_VERIFY_TIMEOUT_MS) {
    const snapshot = await readFunboxCart(context, { timeout });
    const row = snapshot.items.find(item => item.type === 'normal' && item.variantId === String(product.variantId));
    return { present: Boolean(row), quantity: row?.quantity || 0, cartUrl: snapshot.cartUrl };
  }

  async _addProductToCart(context, product, settings, { timeout = 12000 } = {}) {
    const strategy = funboxPurchaseStrategy(product, settings);
    if (!strategy.eligible && !settings?.verifyOnly && !settings?.confirmedManualAssignment) {
      throw new Error(strategy.label);
    }
    if (!product.variantId) throw new Error(`Funbox ${product.title} 缺少可購買規格，已停止加購`);
    const requestedQuantity = Math.min(strategy.quantity, Number(settings.plannedQuantity) > 0 ? Number(settings.plannedQuantity) : strategy.quantity);
    const limits = [requestedQuantity];
    if (Number(product.qtyCap) > 0) limits.push(Number(product.qtyCap));
    if (Number(product.stock) > 0) limits.push(Number(product.stock));
    let quantity = Math.max(1, Math.min(...limits));
    let addedQuantity = quantity;
    let variantId = String(product.variantId);
    let cartAttempt = await this._postCartAdd(context, variantId, addedQuantity, timeout);
    if (!cartAttempt.response.ok() && [401, 403].includes(cartAttempt.response.status())) {
      await this._requestLogin(context, { persist: false });
      cartAttempt = await this._postCartAdd(context, variantId, addedQuantity, timeout);
    }
    if (cartAttempt.response.status() >= 500) throw funboxPurchaseError('cart_unknown', 'FUNBOX 加車回覆不明（HTTP ' + cartAttempt.response.status() + '）；先查車，不降量重加');
    if (!cartAttempt.response.ok() && cartAttempt.response.status() === 409) {
      const firstReason = compactHttpResponseBody(cartAttempt.body);
      const refreshed = await this._refreshPurchasableVariant(context, product).catch(() => null);
      if (refreshed?.available === false && Number(refreshed.stock) === 0) {
        throw funboxPurchaseError(
          'stock_out',
          `Funbox 加入購物車失敗（HTTP 409）：${firstReason}；單品即時庫存已為 0`
        );
      }
      if (refreshed?.variantId) {
        variantId = refreshed.variantId;
        quantity = requestedQuantity;
        if (Number(refreshed.qtyCap) > 0) quantity = Math.min(quantity, Number(refreshed.qtyCap));
        if (Number(refreshed.stock) > 0) quantity = Math.min(quantity, Number(refreshed.stock));
        addedQuantity = Math.max(1, quantity);
        this.log(`Funbox ${product.title} 加入購物車遇到 409：${firstReason}；已取得即時規格並安全重試一次。`);
        cartAttempt = await this._postCartAdd(context, variantId, addedQuantity, timeout);
      } else {
        this.log(`Funbox ${product.title} 加入購物車遇到 409：${firstReason}；即時規格暫時無法取得，避免重送相同請求。`);
      }
    }
    if (cartAttempt.response.status() >= 500) throw funboxPurchaseError('cart_unknown', 'FUNBOX 加車回覆不明（HTTP ' + cartAttempt.response.status() + '）；先查車，不重加');
    if (!cartAttempt.response.ok() && addedQuantity > 1) {
      this.log(`Funbox ${product.title} 加入 ${addedQuantity} 組被拒絕，保留商品機會並立即降為 1 組重試（HTTP ${cartAttempt.response.status()}）。`);
      addedQuantity = 1;
      quantity = 1;
      cartAttempt = await this._postCartAdd(context, variantId, 1, timeout);
    }
    if (!cartAttempt.response.ok()) {
      const reason = compactHttpResponseBody(cartAttempt.body);
      const message = `Funbox 加入購物車失敗（HTTP ${cartAttempt.response.status()}）：${reason}`;
      if (/售完|售罄/i.test(reason)) throw funboxPurchaseError('stock_out', message);
      if (cartAttempt.response.status() === 409) {
        throw funboxPurchaseError('inventory_conflict', `${message}；即時重讀後仍無法配置庫存`);
      }
      if ([429, 503].includes(cartAttempt.response.status()) || FUNBOX_RETRY_LATER_WORDS.test(reason)) {
        throw funboxPurchaseError('rate_limited', message);
      }
      throw funboxPurchaseError('failed', message);
    }
    return { product, quantity, variantId };
  }

  async _refreshPurchasableVariant(context, product) {
    const productSlug = (() => {
      try { return new URL(product.url).pathname.match(/\/products\/([^/?#]+)/)?.[1] || ''; } catch { return ''; }
    })();
    let current = null;

    // 單品 JSON 是最接近使用者真正點開的商品狀態，也能處理不在陀螺
    // 集合頁內的安全測試商品。集合 JSON 保留為補貨切換時的備援來源。
    if (productSlug) {
      const productResponse = await context.request.get(
        `https://shop.funbox.com.tw/products/${encodeURIComponent(productSlug)}.json`,
        {
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
          timeout: 8000
        }
      ).catch(() => null);
      if (productResponse?.ok()) current = await readAndReleaseResponse(productResponse, 'json').catch(() => null);
      else await releaseResponse(productResponse);
    }
    if (!current) {
      const response = await context.request.get(FUNBOX_COLLECTION_API, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        timeout: 8000
      });
      if (!response.ok()) { await releaseResponse(response); return null; }
      const data = await readAndReleaseResponse(response, 'json').catch(() => null);
      const products = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : [];
      current = products.find((item) => String(item?.id || '') === String(product.id || ''))
        || products.find((item) => String(item?.url || '').includes(`/products/${productSlug}`));
    }
    if (!current) return null;
    const variants = Array.isArray(current.variants) ? current.variants : [];
    const variant = variants.find((item) => Number(item?.inventory_quantity) > 0 && item?.id)
      || variants.find((item) => String(item?.inventory_policy || '') !== 'deny' && item?.id);
    if (!variant) {
      const knownQuantities = variants
        .map((item) => Number(item?.inventory_quantity))
        .filter(Number.isFinite);
      return {
        available: false,
        variantId: null,
        stock: knownQuantities.length
          ? knownQuantities.reduce((total, value) => total + Math.max(0, value), 0)
          : null,
        qtyCap: null
      };
    }
    return {
      available: true,
      variantId: String(variant.id),
      stock: Number.isFinite(Number(variant.inventory_quantity)) ? Number(variant.inventory_quantity) : null,
      qtyCap: (() => {
        const cap = Number(
          variant?.max_order_quantity
          ?? variant?.quantity_limit
          ?? variant?.purchase_limit
        );
        return Number.isFinite(cap) && cap > 0 ? cap : null;
      })()
    };
  }

  async purchase(product, settings) {
    if (this.accountBrowser || this.cartActionUncertain) throw funboxPurchaseError('account_not_ready', '帳號瀏覽器使用中或清車待確認，未加車、未送單');
    return this.purchaseBatch(settings.batchProducts || [product], settings);
  }

  async _purchaseAtmViaApi(products, settings) {
    const checkoutAccount=this.getCredentials().account;
    const batch = (Array.isArray(products) ? products : [products]).filter(Boolean);
    if (!batch.length || batch.length > 1 && !settings.batchProducts) throw funboxPurchaseError('needs_setup','合單必須使用已核對的帳號任務');
    if (this.activePurchaseHold()) throw funboxPurchaseError('submitted_unconfirmed','訂單待核對，禁止清車或重送');
    const started = Date.now(), steps = [];
    const emit = async raw => {
      const step = safePurchaseStep({...raw,at:new Date().toISOString(),elapsedMs:Date.now()-started});
      steps.push(step); await settings.onStep?.(step);
    };
    let worker, submitted = false;
    try {
      worker = await this._acquireWarmWorker({apiOnly:true});
      await this._ensureWarmWorkerLogin(worker);
      const remaining = (Math.min(30000, Number(settings.transactionDeadlineMs) || 30000)) - (Date.now() - started);
      if (remaining <= 0) throw funboxPurchaseError('deadline_exceeded', 'FUNBOX 主交易已達時間上限，未加車、未送單');
      const budget = purchaseRequestBudget(worker.context.request, { deadlineMs: remaining, onDispatch: (method, url) => {
        if (method === 'post' && /^\/carts\/[a-z0-9]{32}\/$/i.test(new URL(url, 'https://shop.funbox.com.tw').pathname)) submitted = true;
      } });
      const context = { ...worker.context, request: budget.request };
      if (settings.resumeCartUrl) throw funboxPurchaseError('needs_setup','API 任務不沿用未核對的舊購物車');
      await emit({label:'核對派單任務',taskNumber:settings.taskSequence||1,state:'start',reason:`帳號 ${this.accountSlot}；${batch.map(p=>p.title||p.id).join('、')}`});
      if (batch.some(p=>!p.id||!p.url) || new Set(batch.map(p=>p.id)).size!==batch.length) throw funboxPurchaseError('needs_setup','派單商品識別不完整或重複，未加車');
      await emit({label:'核對派單任務',taskNumber:settings.taskSequence||1,state:'success',reason:settings.batchProducts?'本帳號合單，優先順序已凍結；不自動清車':'帳號與單品任務一致；不自動清車'});
      const expected = [], skippedProducts = [], buildUntil = Date.now() + (settings.batchBuildMs || 8000);
      for (const candidate of batch) {
        if (settings.batchProducts && Date.now() >= buildUntil) { skippedProducts.push({...candidate,reason:'batch_deferred'}); continue; }
        await emit({label:'開始加車',state:'start',reason:`${candidate.title}；依序修改本帳號購物車，不併發清車／加車`});
        let added;
        try { added = await this._addProductToCart(context,candidate,{...settings,plannedQuantity:candidate.quantity||settings.plannedQuantity},
          {timeout:settings.batchProducts?Math.max(1,Math.min(5000,buildUntil-Date.now())):12000}); }
        catch (cause) {
          if (cause.purchaseStatus === 'cart_unknown' || /timeout|timed out|ECONN|socket/i.test(String(cause.message))) {
            const recoveryQuantity = candidate.quantity || settings.plannedQuantity || funboxPurchaseStrategy(candidate,settings).quantity;
            const cart = await readFunboxCart(context,{expected:[...expected,{product:candidate,quantity:recoveryQuantity}]});
            const row = cart.items.find(item => item.type === 'normal' && item.variantId === String(candidate.variantId));
            const quantity = candidate.quantity || settings.plannedQuantity || funboxPurchaseStrategy(candidate,settings).quantity;
            if (!row || row.quantity!==quantity) throw cause;
            const wanted = [...expected,{product:candidate,quantity}];
            if (reconcileFunboxCart(cart,wanted).missing.length) throw cause;
            added = {product:candidate,variantId:row.variantId,quantity:row.quantity};
          } else if (settings.batchProducts && settings.batchAllowPartial && ['stock_out','checkout_limited'].includes(cause.purchaseStatus)) {
            skippedProducts.push({...candidate,reason:cause.purchaseStatus});
            await emit({label:'排除不可購品項',state:'info',reason:`${candidate.title}；${purchaseErrorSummary(cause)}，保留其他款`}); continue;
          } else throw cause;
        }
        expected.push({product:{...added.product,id:candidate.id,variantId:added.variantId},quantity:added.quantity});
        await emit({label:'指定商品已加入購物車',state:'success',reason:`${candidate.title} ×${added.quantity}`});
      }
      if (!expected.length) throw funboxPurchaseError('stock_out','本批沒有可確認商品，未送單');
      if (skippedProducts.length && !settings.batchAllowPartial) throw funboxPurchaseError('cart_conflict','合單不允許缺款，未送單');
      await emit({label:'購物車封箱',state:'success',reason:`本車 ${expected.length} 款；排除 ${skippedProducts.length} 款，重新核對正式結帳金額`});
      if (settings.action !== 'checkout' && !settings.verifyOnly) {
        const cart = await readFunboxCart(context,{expected});
        if (reconcileFunboxCart(cart,expected).missing.length) throw funboxPurchaseError('cart_conflict','API 加車核對不一致');
        return {status:'carted',products:expected.map(i=>({...i.product,quantity:i.quantity})),transport:'http_api',quantity:expected.reduce((s,i)=>s+i.quantity,0),resultUrl:cart.cartUrl,detail:'API 加車已確認，未送單',durationMs:Date.now()-started,timings:{steps}};
      }
      const result = await purchaseFunboxViaApi({api:context.request,reconcileApi:worker.context.request,expected,deliveryProfile:this.getDeliveryProfile(),
        pickupProfile:this.getPickupProfile(),pickupSetup:this.getPickupSetup?.(),
        settings:{...settings,onStep:emit},beforeSubmit:async intent => {
          if (typeof settings.onBeforeSubmit !== 'function') throw funboxPurchaseError('needs_setup','缺少可持久保存的送單意圖，未送單');
          await settings.onBeforeSubmit({...intent,accountSlot:this.accountSlot,products:expected.map(i=>({...i.product,quantity:i.quantity})),productId:batch[0].id,quantity:expected.reduce((s,i)=>s+i.quantity,0)});
          this.purchaseHold = {productId:batch[0].id,products:expected.map(i=>({...i.product,quantity:i.quantity})),startedAt:new Date().toISOString(),reason:'API 送單結果待核對'};
        }});
      if (result.status !== 'submitted_unconfirmed') this.purchaseHold = null;
      if(result.status==='ordered'&&result.payment==='seven_cod'&&this.onPickupOrderConfirmed){
        try{await this.onPickupOrderConfirmed(context.request,result,checkoutAccount);await emit({label:'本帳號取貨門市已永久記錄',state:'success',reason:'正式貨到付款訂單已核對；未來同門市可直接帶入，不再開電子地圖'});}
        catch(cause){await emit({label:'訂單成立，但門市永久保存未完成',state:'info',reason:purchaseErrorSummary(cause)});}
      }
      return {...result,products:expected.map(i=>({...i.product,quantity:i.quantity})),skippedProducts,durationMs:Date.now()-started,timings:{steps}};
    } catch (cause) {
      const last=steps[steps.length-1];
      await emit({label:'本次停止',stepNumber:last?.stepNumber||1,stepTitle:last?.stepTitle||'購物車',state:submitted?'unknown':'failed',reason:purchaseErrorSummary(cause)});
      const rejected = ['checkout_rejected', 'checkout_busy', 'rate_limited'].includes(cause.purchaseStatus)
        || cause.purchaseStatus === 'deadline_exceeded' && cause.requestNotDispatched;
      if (submitted && !rejected) {
        cause.orderSubmitted = true; cause.purchaseStatus = 'submitted_unconfirmed';
      } else this.purchaseHold = null;
      cause.timings = {steps}; cause.durationMs = Date.now()-started; throw cause;
    } finally { await this._releaseWarmWorker(worker); }
  }

  async purchaseBatch(products, settings) {
    if (this.accountBrowser || this.cartActionUncertain) throw funboxPurchaseError('account_not_ready', '帳號瀏覽器使用中或清車待確認，未加車、未送單');
    if (this.apiAtmCheckout && ['virtual_atm_home','seven_cod'].includes(settings.payment)) {
      return this._purchaseAtmViaApi(products, settings);
    }
    if (settings.payment === 'seven_cod' && !settings.verifyOnly && this.getPickupSetup && !this.getPickupSetup()) {
      throw funboxPurchaseError('needs_setup', PICKUP_SETUP_REQUIRED);
    }
    const batchProducts = (Array.isArray(products) ? products : [products]).filter(Boolean);
    if (!batchProducts.length) throw new Error('Funbox 合單沒有可處理商品');
    const product = batchProducts[0];
    const startedAt = Date.now();
    const timings = {};
    const stageLabels = { workerAcquiredMs: '取得獨立工作器', sessionReadyMs: '確認登入', cartClearedMs: 'API 清車確認',
      cartUrlReadyMs: 'API 加購完成', cartVerifiedMs: '核對購物車', checkoutFormVerifiedMs: '確認配送與付款資料',
      cartFinalVerifiedMs: '最後核對商品數量', orderSubmittingMs: '送出訂單', orderConfirmedMs: '確認訂單成立' };
    const checkpoint = (name) => {
      timings[name] = Date.now() - startedAt;
      if (stageLabels[name]) {
        const step = safePurchaseStep({ label: stageLabels[name], state: name === 'orderSubmittingMs' ? 'start' : 'success',
          at: new Date().toISOString(), elapsedMs: timings[name] });
        timings.steps ||= []; timings.steps.push(step);
        try { Promise.resolve(settings.onStep?.(step)).catch(() => {}); } catch {}
      }
      return timings[name];
    };
    let worker;
    let context;
    let page;
    let workerHealthy = true;
    try {
      // 結帳前安全驗證不會按下最終送出，因此可用非白名單商品檢查
      // 配送、付款與收件資料；正式購買仍嚴格遵守黑／白名單。
      for (const candidate of batchProducts) {
        const strategy = funboxPurchaseStrategy(candidate, settings);
        if (!strategy.eligible && !settings?.verifyOnly && !settings?.confirmedManualAssignment) {
          throw new Error(strategy.label);
        }
      }
      worker = await this._acquireWarmWorker({apiOnly:false});
      checkpoint('workerAcquiredMs');
      context = worker.context;
      await this._ensureWarmWorkerLogin(worker);
      checkpoint('sessionReadyMs');
      page = await context.newPage();
      if (settings.action === 'checkout') await installFunboxCheckoutResourcePolicy(page);
      let quantity = 0;
      const addedItems = [];
      const deferredItems = [];
      let cartUrl = String(settings?.resumeCartUrl || '').trim() || 'https://shop.funbox.com.tw/cart';
      if (settings?.resumeCartUrl) {
        if (batchProducts.length !== 1) throw new Error('Funbox 合單不支援沿用舊購物車網址');
        if (!/^https:\/\/shop\.funbox\.com\.tw\/carts\//i.test(cartUrl)) {
          throw new Error('Funbox 既有購物車網址格式不正確，已停止續跑');
        }
        const strategy = funboxPurchaseStrategy(product, settings);
        quantity = Math.max(1, strategy.quantity);
        addedItems.push({ product, quantity });
        checkpoint('cartUrlReadyMs');
        this.log(`Funbox ${this.accountLabel} 沿用既有購物車進入結帳，不重複加購：${cartUrl}`);
      } else if (batchProducts.every((candidate) => candidate.variantId)) {
        // Cyberbiz keeps one server-side cart per account.  Even with one
        // worker per account, an old/manual cart can contaminate the next
        // purchase. Clean exactly once before this account's whole wave.
        // No automatic cart mutation before adding. Final cart reconciliation
        // still rejects unrelated products or unexpected quantities.
        const addTimeout = batchProducts.length > 1 ? FUNBOX_BATCH_ADD_TIMEOUT_MS : 12000;
        for (let index = 0; index < batchProducts.length; index += 1) {
          const candidate = batchProducts[index];
          const riskyCartItem = addedItems.find((item) => settings?.productRisk?.(item.product));
          if (riskyCartItem) {
            for (const remaining of batchProducts.slice(index)) {
              deferredItems.push({
                product: remaining,
                reason: `購物車既有商品 ${riskyCartItem.product.title} 出現缺貨訊號，停止加購並提前結帳`,
                purchaseStatus: 'deferred'
              });
            }
            this.log(
              `Funbox ${this.accountLabel} 合單收到缺貨訊號，提前封箱：已保留 ${addedItems.length} 款，`
              + `${deferredItems.length} 款移至同帳號下一張訂單。`
            );
            break;
          }
          try {
            const added = await this._addProductToCart(context, candidate, settings, { timeout: addTimeout });
            try { Promise.resolve(settings.onStep?.(safePurchaseStep({ label: 'API 加入購物車', state: 'success', at: new Date().toISOString(), elapsedMs: Date.now() - startedAt }))).catch(() => {}); } catch {}
            addedItems.push(added);
            quantity += added.quantity;
            this.log(`Funbox ${this.accountLabel} 合單加購 API 已回覆 ${addedItems.length}/${batchProducts.length}：${candidate.title}（待購物車核對）`);
          } catch (error) {
            let confirmedAfterTimeout = false;
            if (/timeout|timed out/i.test(String(error?.message || error))) {
              const snapshot = await this._cartContainsProduct(context, candidate).catch(() => null);
              if (snapshot?.cartUrl && /\/carts\//i.test(snapshot.cartUrl)) cartUrl = snapshot.cartUrl;
              if (snapshot?.present) {
                const strategy = funboxPurchaseStrategy(candidate, settings);
                const confirmed = { product: candidate, quantity: Math.max(1, strategy.quantity), uncertainResponse: true };
                addedItems.push(confirmed);
                quantity += confirmed.quantity;
                confirmedAfterTimeout = true;
                this.log(`Funbox ${this.accountLabel}｜${candidate.title} 回應逾時，但購物車確認已加入。`);
              }
            }
            if (!confirmedAfterTimeout) {
              deferredItems.push({ product: candidate, reason: conciseAutomationError(error), purchaseStatus: error?.purchaseStatus || 'failed' });
            }
            if (!addedItems.length) {
              if (batchProducts.length === 1) throw error;
              if (error?.purchaseStatus === 'stock_out' || error?.purchaseStatus === 'inventory_conflict') continue;
              if (!error.purchaseStatus && /timeout|timed out/i.test(String(error?.message || error))) {
                error.purchaseStatus = 'rate_limited';
              }
              error.deferredProducts = batchProducts.slice(index);
              throw error;
            }
            for (const remaining of batchProducts.slice(index + 1)) {
              deferredItems.push({ product: remaining, reason: '前一款加購異常，保住購物車既有商品並提前結帳', purchaseStatus: 'deferred' });
            }
            this.log(`Funbox ${this.accountLabel} 合單提前封箱：已保留 ${addedItems.length} 款，${deferredItems.length} 款移至下一張訂單。`);
            break;
          }
        }
        if (!addedItems.length) {
          const error = funboxPurchaseError('stock_out', 'Funbox 本輪合單沒有任何商品成功加入購物車');
          error.deferredProducts = deferredItems.map((item) => item.product);
          throw error;
        }
        checkpoint('cartAddedMs');
        if (settings.action !== 'checkout' && !/\/carts\//i.test(cartUrl)) {
          const cartResponse = await context.request.get('https://shop.funbox.com.tw/cart', { timeout: 12000 });
          cartUrl = cartResponse.url();
          await releaseResponse(cartResponse);
        }
        if (settings.action !== 'checkout') {
          if (!/\/carts\//i.test(cartUrl)) throw new Error('Funbox 購物車未產生結帳連結');
          checkpoint('cartUrlReadyMs');
        }
      } else {
        if (batchProducts.length !== 1) throw new Error('Funbox 合單商品缺少規格編號，已停止本輪以避免拆單污染');
        const strategy = funboxPurchaseStrategy(product, settings);
        quantity = Math.max(1, strategy.quantity);
        addedItems.push({ product, quantity });
        await this._login(page, context);
        await gotoWithAbortRetry(page, product.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        if (quantity > 1) await fillFirst(page, ['input[name="quantity"]', 'input[type="number"]'], quantity).catch(() => false);
        const addButton = await firstVisible(page, [
          'button:has-text("加入購物車")', 'button:has-text("立即購買")',
          '[data-testid*="add-to-cart"]', '#add-to-cart', '.add-to-cart'
        ]);
        if (!addButton || !await addButton.isEnabled()) throw new Error('商品目前無法加入購物車');
        await addButton.click();
        await page.waitForTimeout(800);
      }

      if (settings.action !== 'checkout') {
        return {
          status: 'carted', purchaseStatus: 'cart', quantity,
          durationMs: Date.now() - startedAt, timings,
          products: addedItems.map((item) => item.product),
          productResults: addedItems.map((item) => ({ ...item, status: 'carted' })),
          deferredProducts: deferredItems.map((item) => item.product),
          detail: `已加入 Funbox 購物車 ${addedItems.length} 款，未送出訂單${deferredItems.length ? `；${deferredItems.length} 款等待下一張` : ''}`
        };
      }
      const checkoutStaggerMs = Math.max(0, Number(settings?.checkoutStaggerMs) || 0);
      if (checkoutStaggerMs) await page.waitForTimeout(checkoutStaggerMs);
      const cartSnapshot = await readFunboxCart(context);
      const reconciled = reconcileFunboxCart(cartSnapshot, addedItems);
      if (reconciled.missing.length) {
        for (const item of reconciled.missing) deferredItems.push({ product: item.product,
          reason: 'API 加購回覆後，權威購物車未保留此商品；保住已確認品項', purchaseStatus: 'deferred' });
        addedItems.splice(0, addedItems.length, ...reconciled.matched);
        this.log(`Funbox ${this.accountLabel} 購物車核對｜保住 ${addedItems.length} 款｜${reconciled.missing.length} 款延後，不重送加購`);
      }
      cartUrl = cartSnapshot.cartUrl;
      this.log(`Funbox ${this.accountLabel} 購物車 API 已核對｜${addedItems.length} 款｜數量正確`);
      checkpoint('cartUrlReadyMs');
      checkpoint('cartApiVerifiedMs');
      // Wait for checkout's actual controls, not unrelated document scripts.
      await gotoWithAbortRetry(page, cartUrl, { waitUntil: 'commit', timeout: 25000 });
      checkpoint('checkoutPageLoadedMs');
      quantity = await verifyFunboxRenderedCart(page, addedItems);
      checkpoint('cartQuantityVerifiedMs');
      const useVirtualAtm = settings.payment === 'virtual_atm_home';
      let selectedCheckoutOption;
      let selectedCheckoutKeywords;
      let checkoutReadyDetail;
      if (useVirtualAtm) {
        const selectionStartedAt = Date.now() - startedAt;
        const { homeDelivery, homeShipping, virtualAtm, timings: selectionTimings } = await chooseFunboxVirtualAtmOptions(page);
        for (const [key, value] of Object.entries(selectionTimings)) timings[`payment_${key}`] = selectionStartedAt + value;
        selectedCheckoutOption = virtualAtm;
        checkpoint('virtualAtmSelectedMs');
        const sameBuyer = await firstVisible(page, [
          'label:has-text("同購買人")', 'button:has-text("同購買人")'
        ]);
        if (sameBuyer) await chooseCheckoutOption(page, [
          'label:has-text("同購買人")', 'button:has-text("同購買人")'
        ], '找不到 Funbox 同購買人選項').catch(() => {});
        // Select same-buyer first; only then apply and verify the desired
        // contact once. Do not fill twice across React's rerender.
        await fillFunboxHomeContact(page, this.getDeliveryProfile());
        checkpoint('deliveryContactAppliedMs');
        if (homeDelivery) {
          await assertCheckoutOptionSelected(
            page, homeDelivery, ['宅配'], 'Funbox 尚未正確套用宅配，已停止送單'
          );
        }
        await assertCheckoutOptionSelected(
          page, homeShipping, ['一般宅配'], 'Funbox 尚未正確套用一般宅配，已停止送單'
        );
        selectedCheckoutKeywords = ['虛擬ATM'];
        checkoutReadyDetail = 'Funbox 宅配、虛擬 ATM、收件地址與最終結帳按鈕均已就緒；未送出訂單';
      } else {
        const cod = await waitForFirstEnabled(page, [
          'button:has-text("7-11 貨到付款")',
          '[data-translate-keys="cod_names.seven"]', 'label:has-text("7-11 貨到付款")'
        ], { timeout: 5000, interval: 120 });
        if (!cod) throw new Error('找不到 7-11 貨到付款選項');
        await chooseCheckoutOption(page, [
          'button:has-text("7-11 貨到付款")',
          '[data-translate-keys="cod_names.seven"]', 'label:has-text("7-11 貨到付款")'
        ], '找不到 7-11 貨到付款選項');
        checkpoint('codSelectedMs');
        await page.waitForTimeout(250);
        await this._fillPickupContact(page);
        const savedStoreName = String(this.getPickupProfile().storeName || '').trim();
        const checkoutTextBeforeStore = await page.locator('body').innerText().catch(() => '');
        // Funbox 會同時在兩張 7-11 卡片顯示既有門市。再次點擊門市文字
        // 反而可能把配送方式切回「先付款」，已有門市時不要重選。
        if (!savedStoreName || !checkoutTextBeforeStore.includes(savedStoreName)) {
          await this._chooseSavedStore(page);
        }
        // 選門市元件可能重繪配送卡，最後再明確鎖回貨到付款。
        selectedCheckoutOption = await chooseCheckoutOption(page, [
          'button:has([data-translate-keys="cod_names.seven"])',
          'button:has-text("7-11 貨到付款")',
          '[data-translate-keys="cod_names.seven"]', 'label:has-text("7-11 貨到付款")'
        ], '找不到 7-11 貨到付款選項');
        await page.waitForTimeout(250);
        selectedCheckoutKeywords = ['7-11', '貨到付款'];
        checkoutReadyDetail = 'Funbox 7-11 貨到付款、門市、收件資料與最終結帳按鈕均已就緒；未送出訂單';
      }
      const bonusInput = await firstVisible(page, [
        '#bonus-for-use',
        'input[aria-label="請輸入會員紅利折抵點數"]',
        'input[placeholder*="紅利折抵"]', 'input[type="number"][name*="bonus"]'
      ]);
      // The displayed input may be zero while Cyberbiz's applied bonus is
      // nonzero. Decide from the submitted hidden value, not the text box.
      const bonusField = page.locator('input[name="bonus_used"]').first();
      const appliedBonus = await bonusField.count() ? await bonusField.inputValue() : null;
      if (bonusInput && (appliedBonus === null || Number(appliedBonus) !== 0)) {
        await bonusInput.fill('0');
        const confirmBonus = await firstVisible(page, ['button:has-text("確認")']);
        if (!confirmBonus) throw new Error('Funbox 找不到紅利折抵確認按鈕，已停止送單');
        await confirmBonus.evaluate(element => element.click());
        await page.waitForFunction(() => document.querySelector('input[name="bonus_used"]')?.value === '0',
          null, { timeout: 5000 });
      }
      await checkCheckoutAgreements(page);
      checkpoint('agreementsAppliedMs');
      await assertCheckoutOptionSelected(
        page,
        selectedCheckoutOption,
        selectedCheckoutKeywords,
        `Funbox 尚未正確套用${useVirtualAtm ? '虛擬 ATM' : ' 7-11 貨到付款'}，已停止送單`
      );
      await assertCheckoutFormReady(page, 'Funbox 結帳頁');
      if (useVirtualAtm) await verifyFunboxAtmContact(page, this.getDeliveryProfile());
      checkpoint('checkoutFormVerifiedMs');
      const checkout = await firstVisible(page, [
        '#checkout-button',
        'a.btn-lg:has-text("立即結帳")', 'button.btn-lg:has-text("立即結帳")',
        'a.btn-default:has-text("立即結帳")', 'button.btn-default:has-text("立即結帳")',
        '.btn-bloc:has-text("立即結帳")',
        'button:has-text("確認結帳")', 'button:has-text("立即結帳")'
      ]);
      if (!checkout || !await checkout.isEnabled()) throw new Error('Funbox 最終結帳按鈕尚未啟用');
      const finalRows = await page.locator('tr.line-item:has(input[data-testid="quantity-input"])').evaluateAll(rows =>
        rows.map(row => ({ url: row.querySelector('a[href*="/products/"]')?.getAttribute('href'),
          quantity: Number(row.querySelector('input[data-testid="quantity-input"]')?.value) })));
      assertFunboxCheckoutRows(finalRows, addedItems);
      checkpoint('cartFinalVerifiedMs');
      if (settings.verifyOnly) {
        const evidencePath = await saveCheckoutEvidence(page, settings.evidencePath, { liveFormValues: true });
        return {
          status: 'checkout_ready', quantity, durationMs: Date.now() - startedAt, timings,
          accountSlot: this.accountSlot,
          products: addedItems.map((item) => item.product),
          productResults: addedItems.map((item) => ({ ...item, status: 'checkout_ready' })),
          deferredProducts: deferredItems.map((item) => item.product),
          detail: checkoutReadyDetail,
          resultUrl: page.url(), evidencePath
        };
      }
      const checkoutUrl = page.url();
      checkpoint('orderSubmittingMs');
      await checkout.click();
      checkpoint('orderSubmittedMs');
      let success = false;
      let orderEvidence = '';
      let paymentDeadline = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(1500);
        const currentUrl = page.url();
        const bodyText = await page.locator('body').innerText().catch(() => '');
        if (/庫存不足|已售完|售完|售罄|sold\s*out/i.test(bodyText)) {
          throw funboxPurchaseError('stock_out', '結帳時商品已售完（已被其他人搶走）');
        }
        if (FUNBOX_CHECKOUT_LIMIT_WORDS.test(bodyText)) {
          throw funboxPurchaseError('checkout_limited', 'Funbox 結帳層級的限購／庫存檢查未通過');
        }
        if (/show_failed(?:=yes)?/i.test(currentUrl) || /付款失敗/i.test(bodyText)) {
          return {
            status: 'payment_failed', purchaseStatus: 'payment_failed', quantity,
            durationMs: Date.now() - startedAt, timings, accountSlot: this.accountSlot,
            detail: '訂單已建立，但網站回傳付款失敗（show_failed）', resultUrl: currentUrl
          };
        }
        if (/3d[ -]?secure|3ds/i.test(currentUrl) || /3d[ -]?secure|3ds|銀行.*驗證/i.test(bodyText)) {
          return {
            status: '3ds_pending', purchaseStatus: '3ds_pending', quantity,
            durationMs: Date.now() - startedAt, timings, accountSlot: this.accountSlot,
            detail: '訂單已建立，等待銀行 3DS 驗證', resultUrl: currentUrl
          };
        }
        const changedPage = currentUrl !== checkoutUrl && !/\/carts\//i.test(currentUrl);
        if (changedPage && (/order|thank|complete|success/i.test(currentUrl) || FUNBOX_ORDER_SUCCESS_WORDS.test(bodyText))) {
          orderEvidence = bodyText.match(/(?:訂單編號|訂單號碼|訂單序號)(?:為)?\s*[:：]?\s*([A-Z0-9-]{6,})/i)?.[1]
            || currentUrl.match(/\/orders\/([A-Za-z0-9-]+)/)?.[1]
            || '';
          if (!orderEvidence) continue;
          success = true;
          paymentDeadline = bodyText.match(/(?:付款|繳費|匯款)(?:期限|截止(?:時間|日)?)\s*[:：]?\s*([^\n]{4,40})/i)?.[1]?.trim()
            || bodyText.match(/請於\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*前完成轉帳/)?.[1] || '';
          checkpoint('orderConfirmedMs');
          break;
        }
      }
      if (!success) {
        const diagnostics = await page.evaluate(() => {
          const messages = [...document.querySelectorAll(
            '.error, .invalid-feedback, .help-block, [role="alert"], .alert, .text-danger'
          )]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            })
            .map((node) => String(node.textContent || '').trim())
            .filter(Boolean);
          const required = [...document.querySelectorAll('input[required], select[required], textarea[required]')]
            .filter((node) => !String(node.value || '').trim())
            .map((node) => node.getAttribute('name') || node.id || node.getAttribute('placeholder') || node.tagName);
          return { messages: [...new Set(messages)].slice(0, 5), required: [...new Set(required)].slice(0, 8) };
        }).catch(() => ({ messages: [], required: [] }));
        const detail = [
          diagnostics.messages.length ? `頁面提示：${diagnostics.messages.join('／')}` : '',
          diagnostics.required.length ? `未填欄位：${diagnostics.required.join('、')}` : ''
        ].filter(Boolean).join('；');
        throw new Error(`Funbox 未確認訂單成立；目前仍停在購物車／結帳頁：${page.url()}${detail ? `；${detail}` : ''}`);
      }
      const evidencePath = await saveCheckoutEvidence(page, settings.evidencePath).catch(() => '');
      return {
        status: 'ordered', purchaseStatus: 'success', quantity,
        durationMs: Date.now() - startedAt,
        timings,
        accountSlot: this.accountSlot,
        products: addedItems.map((item) => item.product),
        productResults: addedItems.map((item) => ({ ...item, status: 'ordered' })),
        deferredProducts: deferredItems.map((item) => item.product),
        orderNumber: orderEvidence,
        paymentUrl: useVirtualAtm ? page.url() : '',
        paymentDeadline,
        detail: `Funbox ${this.accountLabel} 訂單已成立${orderEvidence ? `（${orderEvidence}）` : ''}`,
        resultUrl: page.url(), evidencePath
      };
    } catch (error) {
      if (page && settings?.evidencePath) {
        await saveCheckoutEvidence(page, settings.evidencePath).catch(() => '');
      }
      if (/target page|context or browser|has been closed|browser closed/i.test(String(error?.message || error))) {
        workerHealthy = false;
      }
      if (!error.purchaseStatus) {
        error.purchaseStatus = funboxPurchaseResultStatus({ status: 'failed', error: error.message });
      }
      error.orderSubmitted = Number.isFinite(timings.orderSubmittingMs) || Number.isFinite(timings.orderSubmittedMs);
      if (error.orderSubmitted) {
        error.purchaseStatus = 'submitted_unconfirmed';
        this.purchaseHold = { productId: product.id, startedAt: new Date(startedAt).toISOString(), reason: '送單後未取得完整成立證據' };
      }
      error.timings = { ...timings };
      error.durationMs = Date.now() - startedAt;
      error.cartClear = this.lastCartClearEvidence || null;
      throw error;
    } finally {
      await page?.close().catch(() => {});
      // 一張訂單完成後直接銷毀該工作器，下一張訂單使用全新購物車。
      // 登入工作器會在背景立即補回，不再重用舊 carts/<token>。
      await this._releaseWarmWorker(worker, { healthy: false });
    }
  }

  async close() {
    this.warmPoolClosed = true;
    this.warmPoolEnabled = false;
    if (this.warmPoolTimer) clearInterval(this.warmPoolTimer);
    this.warmPoolTimer = null;
    const waiters = this.warmWorkerWaiters.splice(0);
    waiters.forEach(({ reject }) => reject(new Error('Funbox 購買器已停止')));
    const workers = this.warmWorkers.splice(0);
    await Promise.allSettled(workers.map((worker) => worker.context.close()));
    await super.close();
  }
}

export class MultiAccountFunboxPurchaseAdapter {
  constructor(options) {
    this.options = options;
    this.getAccounts = options.getAccounts || (() => []);
    this.independentQueues = true;
    this.maxConcurrency = 3;
    this.credentialFingerprints = new Map();
    // Cyberbiz 的購物車跟著帳號 Session 走。同帳號若同時用多個工作器，
    // 彼此的清空／加購會競爭同一張購物車。每個帳號因此必須逐件結帳；
    // A、B、C 三個不同帳號仍可同步進行。
    this.accountPurchaseTails = new Map();
    this.adapters = {};
    this._syncAccounts();
  }

  _syncAccounts() {
    const options = this.options;
    const slots = esliteAccountSlots(this.getAccounts().map(item => item.slot));
    for (const slot of slots) {
      if (this.adapters[slot]) continue;
      const legacySlot = slot === 'A';
      const adapter = new FunboxPurchaseAdapter({
        ...options,
        accountSlot: slot,
        workerCount: FUNBOX_WORKER_COUNT,
        profileName: legacySlot ? 'funbox' : `funbox-account-${slot.toLowerCase()}`,
        sessionFile: path.join(
          options.dataDir,
          'auto-purchase',
          legacySlot ? 'funbox-session.json' : `funbox-account-${slot.toLowerCase()}-session.json`
        ),
        getCredentials: () => {
          const account = this.getAccounts().find((item) => String(item.slot).toUpperCase() === slot) || {};
          return { account: String(account.account || ''), password: String(account.password || '') };
        },
        getPurchaseHold: () => options.getPurchaseHold?.(slot) || null,
        getPickupSetup: options.getPickupSetup ? () => options.getPickupSetup(slot) : undefined,
        onPickupOrderConfirmed:options.onPickupOrderConfirmed?(api,result,expectedAccount)=>options.onPickupOrderConfirmed(slot,api,result,expectedAccount):undefined,
        getSelectedPayment: () => options.getAccountPayment?.(slot) || 'virtual_atm_home',
        log: (message) => options.log?.(`Funbox 帳號 ${slot}｜${message}`)
      });
      this.adapters[slot] = adapter;
    }
  }

  _account(slot) {
    return this.getAccounts().find((item) => String(item.slot).toUpperCase() === slot) || {};
  }

  queueSlots() { return this._enabledEntries().map(([slot]) => slot); }

  async invalidateAccountSession(slot) {
    this._syncAccounts();
    const adapter = this.adapters[slot];
    if (!adapter) return;
    if (this.accountPurchaseTails.has(slot) || adapter.interactiveLogin || adapter.warmWorkerCreating
      || adapter.activePurchaseHold() || adapter.warmWorkers.some(worker => worker.busy)) {
      throw new Error('帳號仍在執行、登入或訂單待核對，暫時不能更換帳密');
    }
    await adapter.setWarmPoolEnabled(false);
    // Keep a recoverable backup of only this slot's session/profile, never erase it.
    const root = path.resolve(this.options.dataDir, 'auto-purchase') + path.sep;
    for (const file of [adapter.sessionFile, adapter.profileDirectory]) {
      const resolved = path.resolve(file);
      if (!resolved.startsWith(root)) throw new Error('登入資料位置不在指定帳號資料夾內');
      await fs.rename(resolved, resolved + '.account-change-' + Date.now()).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    adapter.loginState = 'needs_login'; adapter.lastVerifiedAt = null; adapter.nextVerifyAt = null;
  }

  accountIdentity(slot) {
    const account = String(this._account(slot).account || '').trim().toLowerCase();
    return account ? crypto.createHash('sha256').update(`funbox:${account}`).digest('hex') : '';
  }

  queueBlockReason(slot, settings = {}) {
    this._syncAccounts();
    const adapter = this.adapters[slot];
    if (!adapter || !this.queueSlots().includes(slot)) return '帳號未啟用或未設定';
    if (this.accountPurchaseTails.has(slot)) return '帳號忙碌';
    if (adapter.accountBrowser) return '帳號瀏覽器開啟中，關閉後恢復派單';
    if (adapter.cartActionUncertain) return '手動清車結果不明，請重新清車確認';
    if (adapter.activePurchaseHold()) return '訂單結果待查證';
    const payment = settings.accountPayments?.[slot] || settings.payment || this.options.getAccountPayment?.(slot) || 'virtual_atm_home';
    if (payment === 'seven_cod' && !adapter.apiAtmCheckout && adapter.getPickupSetup && !adapter.getPickupSetup()) return PICKUP_SETUP_REQUIRED;
    if (adapter.loginState === 'needs_login') return '需要登入';
    if (adapter.loginState === 'error') return '登入檢查待重試';
    return '';
  }

  _enabledEntries() {
    this._syncAccounts();
    return Object.entries(this.adapters).filter(([slot, adapter]) => {
      const account = this._account(slot);
      return account.enabled !== false && adapter.credentialsStatus().ready;
    });
  }

  credentialsStatus() {
    this._syncAccounts();
    const visible = new Set(esliteAccountSlots(this.getAccounts().map(item => item.slot)));
    const accounts = Object.entries(this.adapters).filter(([slot]) => visible.has(slot)).map(([slot, adapter]) => ({
      slot,
      ...adapter.credentialsStatus(),
      enabled: this._account(slot).enabled !== false
    }));
    return {
      ready: accounts.some((account) => account.ready && account.enabled),
      account: `${accounts.filter((account) => account.ready && account.enabled).length} 組已設定`,
      accounts
    };
  }

  runtimeStatus() {
    this._syncAccounts();
    const visible = new Set(esliteAccountSlots(this.getAccounts().map(item => item.slot)));
    const accounts = Object.entries(this.adapters).filter(([slot]) => visible.has(slot)).map(([slot, adapter]) => ({
      slot,
      busy: this.accountPurchaseTails.has(slot),
      enabled: this._account(slot).enabled !== false,
      ...adapter.runtimeStatus()
    }));
    return {
      state: accounts.some((account) => account.state === 'ready') ? 'ready'
        : accounts.some((account) => account.state === 'warming') ? 'warming' : 'disabled',
      maxConcurrency: this.maxConcurrency,
      accountCount: accounts.filter((account) => this.adapters[account.slot].credentialsStatus().ready && account.enabled).length,
      accounts,
      strategy: '各帳號獨立排序｜優先關鍵字優先｜其餘隨機｜一款一單｜最多三路並行'
    };
  }

  async setWarmPoolEnabled(enabled) {
    this._syncAccounts();
    const entries = Object.entries(this.adapters);
    for (let index = 0; index < entries.length; index += 1) {
      const [slot, adapter] = entries[index];
      const account = this._account(slot);
      const accountEnabled = Boolean(enabled && account.enabled !== false && adapter.credentialsStatus().ready);
      const fingerprint = `${account.account || ''}\u0000${account.password || ''}`;
      const changed = this.credentialFingerprints.get(slot) !== fingerprint;
      this.credentialFingerprints.set(slot, fingerprint);
      try {
        if (changed && adapter.warmPoolEnabled) {
          await adapter.setWarmPoolEnabled(false);
        }
        await adapter.setWarmPoolEnabled(accountEnabled);
      } catch (error) {
        adapter.lastVerifyError = conciseAutomationError(error);
      }
      // 啟用時錯開 A／B／C 的驗證，避免同一個 IP 在一瞬間送出三次登入。
      if (accountEnabled && index < entries.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, FUNBOX_LOGIN_STAGGER_MS));
      }
    }
  }

  async purchase(product, settings) {
    if (settings?.accountSlot) {
      const slot = String(settings.accountSlot).toUpperCase();
      const reason = this.queueBlockReason(slot, settings);
      if (reason) throw funboxPurchaseError('account_not_ready', reason);
      if (settings.accountIdentity && settings.accountIdentity !== this.accountIdentity(slot)) throw funboxPurchaseError('account_changed', '排隊後帳號已變更，未加車未送單');
      await settings.onAccountAssigned?.(slot);
      try { return { ...await this._purchaseWithAccountLock(slot, this.adapters[slot], product, settings), accountSlot: slot }; }
      catch (error) { error.accountSlot = slot; throw error; }
    }
    const entries = this._enabledEntries();
    if (!entries.length) throw new Error('尚未啟用任何 Funbox 多帳號帳密');
    const settled = await Promise.allSettled(entries.map(async ([slot, adapter]) => ({
      slot,
      result: await this._purchaseWithAccountLock(slot, adapter, product, settings)
    })));
    const accountResults = settled.map((entry, index) => {
      const slot = entries[index][0];
      if (entry.status === 'fulfilled') return { slot, ok: true, ...entry.value.result };
      const error = conciseAutomationError(entry.reason);
      const purchaseStatus = funboxPurchaseResultStatus({
        status: 'failed', purchaseStatus: entry.reason?.purchaseStatus, error
      });
      return {
        slot, ok: false, status: purchaseStatus, purchaseStatus, error,
        attempts: Math.max(1, Number(entry.reason?.attempts) || 1),
        retryHistory: Array.isArray(entry.reason?.retryHistory) ? entry.reason.retryHistory : []
      };
    });
    const successful = accountResults.filter((item) => item.ok);
    if (!successful.length) {
      const error = new Error(accountResults.map((item) => `帳號 ${item.slot}：${item.error}`).join('｜'));
      error.accountResults = accountResults;
      error.purchaseStatus = ['checkout_limited', 'stock_out', 'payment_failed', '3ds_pending', 'cart', 'failed']
        .find((candidate) => accountResults.some((item) => item.purchaseStatus === candidate)) || 'failed';
      throw error;
    }
    const preferredStatus = ['ordered', 'success', '3ds_pending', 'payment_failed', 'carted', 'cart'];
    const status = preferredStatus.find((candidate) => successful.some((item) => item.status === candidate)) || 'carted';
    const detail = accountResults.map((item) => item.ok
      ? `帳號 ${item.slot}：${item.detail}`
      : `帳號 ${item.slot}：失敗（${item.error}）`).join('｜');
    return {
      status,
      purchaseStatus: funboxPurchaseResultStatus({ status }),
      quantity: successful.reduce((total, item) => total + Math.max(1, Number(item.quantity) || 1), 0),
      accountResults,
      detail,
      resultUrl: successful.find((item) => item.resultUrl)?.resultUrl || ''
    };
  }

  async purchaseBatch(products, settings) {
    const batch = (Array.isArray(products) ? products : [products]).filter(Boolean);
    const entries = this._enabledEntries().map(([slot, adapter]) => [
      slot,
      adapter,
      batch.filter((product) => !Array.isArray(product._targetSlots) || product._targetSlots.includes(slot))
    ]).filter(([, , slotProducts]) => slotProducts.length);
    if (!entries.length) throw new Error('尚未啟用任何 Funbox 多帳號帳密');
    const settled = await Promise.allSettled(entries.map(async ([slot, adapter, slotProducts], index) => ({
      slot,
      result: await this._purchaseBatchWithAccountLock(slot, adapter, slotProducts, {
        ...settings,
        checkoutStaggerMs: index * 350
      })
    })));
    const accountResults = settled.map((entry, index) => {
      const slot = entries[index][0];
      if (entry.status === 'fulfilled') return { slot, ok: true, ...entry.value.result };
      const error = conciseAutomationError(entry.reason);
      const purchaseStatus = funboxPurchaseResultStatus({
        status: 'failed', purchaseStatus: entry.reason?.purchaseStatus, error
      });
      return {
        slot,
        ok: false,
        status: purchaseStatus,
        purchaseStatus,
        error,
        waves: Array.isArray(entry.reason?.waves) ? entry.reason.waves : [],
        timings: entry.reason?.timings || {},
        durationMs: entry.reason?.durationMs,
        orderSubmitted: Boolean(entry.reason?.orderSubmitted),
        cartClear: entry.reason?.cartClear || null,
        products: Array.isArray(entry.reason?.products) ? entry.reason.products : [],
        deferredProducts: Array.isArray(entry.reason?.deferredProducts) ? entry.reason.deferredProducts : entries[index][2],
        attempts: Math.max(1, Number(entry.reason?.attempts) || 1),
        retryHistory: Array.isArray(entry.reason?.retryHistory) ? entry.reason.retryHistory : []
      };
    });
    const successful = accountResults.filter((item) => item.ok);
    if (!successful.length) {
      const error = new Error(accountResults.map((item) => `帳號 ${item.slot}：${item.error}`).join('｜'));
      error.accountResults = accountResults;
      error.purchaseStatus = ['checkout_limited', 'stock_out', 'payment_failed', '3ds_pending', 'cart', 'failed']
        .find((candidate) => accountResults.some((item) => item.purchaseStatus === candidate)) || 'failed';
      throw error;
    }
    const preferredStatus = ['ordered', 'success', '3ds_pending', 'payment_failed', 'carted', 'cart'];
    const status = preferredStatus.find((candidate) => successful.some((item) => item.status === candidate)) || 'carted';
    return {
      status,
      purchaseStatus: funboxPurchaseResultStatus({ status }),
      quantity: successful.reduce((total, item) => total + Math.max(0, Number(item.quantity) || 0), 0),
      products: batch,
      accountResults,
      detail: accountResults.map((item) => item.ok
        ? `帳號 ${item.slot}：${item.detail}`
        : `帳號 ${item.slot}：失敗（${item.error}）`).join('｜'),
      resultUrl: successful.find((item) => item.resultUrl)?.resultUrl || ''
    };
  }

  async _purchaseBatchWithAccountLock(slot, adapter, products, settings) {
    const previous = this.accountPurchaseTails.get(slot) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const accountSettings = {
        ...settings,
        payment: settings?.accountPayments?.[slot] || settings?.payment || 'seven_cod'
      };
      let pending = [...products];
      const waves = [];
      const purchasedProducts = [];
      let totalQuantity = 0;
      const maximumWaves = Math.max(1, Math.min(products.length, 6));
      for (let waveNumber = 1; pending.length && waveNumber <= maximumWaves; waveNumber += 1) {
        try {
          const result = await adapter.purchaseBatch(pending, {
            ...accountSettings,
            checkoutStaggerMs: waveNumber === 1 ? accountSettings.checkoutStaggerMs : 0
          });
          const waveProducts = Array.isArray(result.products) ? result.products : pending;
          const deferredProducts = Array.isArray(result.deferredProducts) ? result.deferredProducts : [];
          waves.push({ waveNumber, ...result, products: waveProducts, deferredProducts });
          purchasedProducts.push(...waveProducts);
          totalQuantity += Math.max(0, Number(result.quantity) || 0);
          if (!deferredProducts.length || accountSettings.verifyOnly || accountSettings.action !== 'checkout') {
            pending = deferredProducts;
            break;
          }
          if (!['ordered', 'success'].includes(result.status)) {
            pending = deferredProducts;
            break;
          }
          adapter.log?.(`帳號 ${slot} 第一張訂單已封單，${deferredProducts.length} 款改由同一帳號建立第 ${waveNumber + 1} 張訂單。`);
          pending = deferredProducts;
        } catch (error) {
          error.waves = waves;
          error.products = purchasedProducts;
          error.deferredProducts = Array.isArray(error.deferredProducts) ? error.deferredProducts : pending;
          throw error;
        }
      }
      const last = waves.at(-1) || {};
      return {
        ...last,
        status: last.status || 'failed',
        purchaseStatus: funboxPurchaseResultStatus(last),
        quantity: totalQuantity,
        products: purchasedProducts,
        deferredProducts: pending,
        waves,
        payment: accountSettings.payment,
        detail: `${this.accountLabel || `帳號 ${slot}`} 共完成 ${waves.length} 張訂單／購物車，取得 ${purchasedProducts.length}/${products.length} 款${pending.length ? `；${pending.length} 款未完成` : ''}`
      };
    });
    this.accountPurchaseTails.set(slot, current);
    try {
      return await current;
    } finally {
      if (this.accountPurchaseTails.get(slot) === current) this.accountPurchaseTails.delete(slot);
    }
  }

  async purchaseAssignments(assignments, settings) {
    const normalized = (Array.isArray(assignments) ? assignments : []).map((assignment) => ({
      slot: String(assignment.slot || '').toUpperCase(),
      product: assignment.product,
      resumeCartUrl: String(assignment.cartUrl || assignment.resumeCartUrl || '').trim()
    }));
    if (!normalized.length || normalized.length > 3) {
      throw new Error('Funbox 一對一驗收必須指定 1～3 組帳號與商品');
    }
    const slots = normalized.map((assignment) => assignment.slot);
    if (new Set(slots).size !== slots.length || slots.some((slot) => !this.adapters[slot])) {
      throw new Error('Funbox 一對一驗收的帳號欄位必須是不同的 A、B、C');
    }
    const settled = await Promise.allSettled(normalized.map(async ({ slot, product, resumeCartUrl }, index) => {
      const adapter = this.adapters[slot];
      const account = this._account(slot);
      if (account.enabled === false || !adapter.credentialsStatus().ready) {
        throw new Error(`Funbox 帳號 ${slot} 尚未啟用或帳密不完整`);
      }
      return {
        slot,
        product,
        result: await this._purchaseWithAccountLock(slot, adapter, product, {
          ...settings,
          resumeCartUrl,
          checkoutStaggerMs: index * 450,
          evidencePath: settings?.evidenceDir
            ? path.join(
              settings.evidenceDir,
              `funbox-atm-${settings?.verifyOnly ? 'preflight' : 'order'}-account-${slot.toLowerCase()}-${index + 1}.png`
            )
            : settings?.evidencePath
        })
      };
    }));
    return settled.map((entry, index) => {
      const { slot, product } = normalized[index];
      if (entry.status === 'fulfilled') return { slot, product, ok: true, ...entry.value.result };
      const error = conciseAutomationError(entry.reason);
      return {
        slot,
        product,
        ok: false,
        status: funboxPurchaseResultStatus({
          status: 'failed', purchaseStatus: entry.reason?.purchaseStatus, error
        }),
        purchaseStatus: entry.reason?.purchaseStatus || 'failed',
        error,
        attempts: Math.max(1, Number(entry.reason?.attempts) || 1),
        retryHistory: Array.isArray(entry.reason?.retryHistory) ? entry.reason.retryHistory : []
      };
    });
  }

  async _purchaseWithAccountLock(slot, adapter, product, settings) {
    const previous = this.accountPurchaseTails.get(slot) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        if (settings?.accountIdentity && settings.accountIdentity !== this.accountIdentity(slot)) throw funboxPurchaseError('account_changed', '帳號已變更，未加車未送單');
        if (adapter.activePurchaseHold()) throw funboxPurchaseError('submitted_unconfirmed', '本帳號訂單結果待核對，禁止清車或再次送單');
        const accountSettings = {
          ...settings,
          payment: settings?.accountPayments?.[slot] || settings?.payment || 'seven_cod'
        };
        const maxAttempts = settings?.continuous ? 1 : Math.max(1, Math.min(3, Number(settings?.maxAttempts) || 3));
        const retryHistory = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const result = await adapter.purchase(product, accountSettings);
            return {
              ...result,
              payment: result.payment || accountSettings.payment,
              attempts: attempt,
              retryHistory
            };
          } catch (error) {
            const reason = conciseAutomationError(error);
            retryHistory.push({ attempt, reason, purchaseStatus: error?.purchaseStatus || 'failed' });
            if (funboxPurchaseResultStatus({
              status: 'failed', purchaseStatus: error?.purchaseStatus, error: reason
            }) === 'stock_out') {
              adapter.log?.(`遇到已售罄，帳號 ${slot} 強制停止，不再重試。`);
            }
            if (attempt >= maxAttempts || !shouldRetryFunboxPurchase(error)) {
              error.payment = accountSettings.payment;
              error.attempts = attempt;
              error.retryHistory = retryHistory;
              throw error;
            }
            const delayMs = attempt === 1 ? 350 : 900;
            adapter.log?.(`第 ${attempt} 次失敗：${reason}；${delayMs}ms 後以全新購物車重試。`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw new Error('Funbox 自動重試未取得結果');
      });
    this.accountPurchaseTails.set(slot, current);
    try {
      return await current;
    } finally {
      if (this.accountPurchaseTails.get(slot) === current) this.accountPurchaseTails.delete(slot);
    }
  }

  async testLogin({ accountSlot = 'A', interactive = true } = {}) {
    this._syncAccounts();
    const slot = String(accountSlot || 'A').toUpperCase();
    const adapter = this.adapters[slot];
    if (!adapter) throw new Error('找不到此 Funbox 帳號');
    return adapter.testLogin({ interactive });
  }

  async completeLogin({ accountSlot = 'A' } = {}) {
    this._syncAccounts();
    const slot = String(accountSlot || 'A').toUpperCase();
    const adapter = this.adapters[slot];
    if (!adapter) throw new Error('找不到此 Funbox 帳號');
    return adapter.completeLogin();
  }

  async maintainSession(options = {}) {
    const entries = this._enabledEntries();
    if (!entries.length) return { ok: false, skipped: true, reason: '尚未啟用任何 Funbox 帳號' };
    const settled = await Promise.allSettled(entries.map(async ([slot, adapter]) => {
      const previous = this.accountPurchaseTails.get(slot) || Promise.resolve();
      const current = previous.catch(() => {}).then(() => adapter.maintainSession(options));
      this.accountPurchaseTails.set(slot, current);
      try {
        return { slot, ...(await current) };
      } finally {
        if (this.accountPurchaseTails.get(slot) === current) this.accountPurchaseTails.delete(slot);
      }
    }));
    const accounts = settled.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : { slot: entries[index][0], ok: false, error: conciseAutomationError(result.reason) });
    return {
      ok: accounts.some((account) => account.ok),
      accounts,
      removed: accounts.reduce((total, account) => total + (Number(account.removed) || 0), 0)
    };
  }

  async close() {
    await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
  }
}

export function readEsliteAuthToken(storageState) {
  const localStorage = storageState?.origins
    ?.find((entry) => entry.origin === 'https://www.eslite.com')
    ?.localStorage || [];
  const localToken = localStorage.find((entry) => entry.name === 'auth._token.prd')?.value;
  const cookieToken = storageState?.cookies?.find((entry) => entry.name === 'auth._token.prd')?.value;
  const tokens = [localToken, cookieToken].filter((value) => value && !['false', 'null', 'undefined'].includes(value))
    .map((value) => { try { return decodeURIComponent(value); } catch { return value; } });
  // A stale localStorage token must not override a newer official cookie.
  return tokens.sort((a, b) => esliteTokenExpiryMs(b) - esliteTokenExpiryMs(a))[0] || '';
}

function esliteTokenExpiryMs(authorization) {
  const raw = String(authorization || '').replace(/^Bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number(payload?.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

async function createEsliteApiContext(sessionFile, {
  requestFactory = playwrightRequest,
  timeoutMs = 8000,
  now = () => Date.now()
} = {}) {
  let storageState;
  try {
    storageState = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  } catch {
    throw esliteApiError('找不到誠品登入狀態，請重新完成官方登入驗證', 'needs_login');
  }
  const authorization = readEsliteAuthToken(storageState);
  if (!authorization) throw esliteApiError('誠品登入憑證不存在，請重新完成官方登入驗證', 'needs_login');
  const expiresAtMs = esliteTokenExpiryMs(authorization);
  if (expiresAtMs && expiresAtMs <= now()) {
    throw esliteApiError('誠品登入憑證已到期，請重新完成官方登入驗證', 'needs_login');
  }
  const api = await requestFactory.newContext({
    baseURL: 'https://athena.eslite.com',
    storageState,
    timeout: timeoutMs,
    extraHTTPHeaders: {
      accept: 'application/json, text/plain, */*',
      authorization,
      origin: 'https://www.eslite.com',
      referer: 'https://www.eslite.com/'
    }
  });
  return { api, expiresAtMs };
}

export async function verifyEsliteApiSession(sessionFile, {
  requestFactory = playwrightRequest,
  timeoutMs = 8000,
  now = () => Date.now(), expectedAccount
} = {}) {
  let storageState;
  try {
    storageState = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  } catch {
    return { ok: false, loggedIn: false, reason: '找不到誠品登入狀態，請重新完成官方登入驗證' };
  }
  return verifyEsliteStorageState(storageState, { requestFactory, timeoutMs, now, expectedAccount });
}

export async function verifyEsliteStorageState(storageState, {
  requestFactory = playwrightRequest, timeoutMs = 8000, now = () => Date.now(), expectedAccount
} = {}) {
  const authorization = readEsliteAuthToken(storageState);
  if (!authorization) {
    return { ok: false, loggedIn: false, reason: '誠品登入憑證不存在，請重新完成官方登入驗證' };
  }
  const startedAt = now();
  let api;
  try {
    api = await requestFactory.newContext({
      baseURL: 'https://athena.eslite.com',
      storageState,
      timeout: timeoutMs,
      extraHTTPHeaders: {
        accept: 'application/json, text/plain, */*',
        authorization,
        origin: 'https://www.eslite.com',
        referer: 'https://www.eslite.com/'
      }
    });
    const response = await api.get(`/api/v2/member?t=${now()}`);
    const status = response.status();
    const durationMs = Math.max(0, now() - startedAt);
    if (status === 401) {
      return { ok: false, loggedIn: false, status, durationMs, reason: '誠品登入已失效，請重新完成官方登入驗證' };
    }
    if ([403, 429].includes(status)) {
      return { ok: false, loggedIn: null, status, durationMs, reason: `誠品會員 API 暫時受限（HTTP ${status}），保留既有登入狀態` };
    }
    if (status >= 500) {
      return { ok: false, loggedIn: null, status, durationMs, reason: `誠品會員 API 暫時無法回應（HTTP ${status}），保留既有登入狀態` };
    }
    let member = null;
    try { member = await response.json(); } catch {}
    if (response.ok() && member && (member.id || member.uuid || member.lms_member_id)) {
      if (expectedAccount) {
        try { await readEsliteMemberDetail(api, { expectedAccount, timeoutMs }); }
        catch (error) { return { ok: false, loggedIn: error.purchaseStatus === 'needs_login' ? false : null,
          status, durationMs: Math.max(0, now() - startedAt), reason: conciseAutomationError(error) }; }
      }
      return { ok: true, loggedIn: true, status, durationMs };
    }
    return {
      ok: false,
      loggedIn: null,
      status,
      durationMs,
      reason: `誠品會員 API 未回傳可確認的會員身分（HTTP ${status || '未知'}），保留既有登入狀態`
    };
  } catch (error) {
    return {
      ok: false,
      loggedIn: null,
      durationMs: Math.max(0, now() - startedAt),
      reason: `誠品會員 API 連線失敗，保留既有登入狀態：${conciseAutomationError(error)}`
    };
  } finally {
    await api?.dispose?.().catch(() => {});
  }
}

function esliteApiError(message, purchaseStatus = 'failed') {
  const error = new Error(message);
  error.purchaseStatus = purchaseStatus;
  return error;
}

async function esliteResponseJson(response) {
  try { return await response.json(); } catch { return null; }
  finally { await releaseResponse(response); }
}

export async function purchaseEsliteViaApi({
  sessionFile,
  product,
  settings,
  checkoutTemplate,
  requestFactory = playwrightRequest,
  apiContext = null,
  prevalidated = false,
  deadlineMs = ESLITE_API_ORDER_DEADLINE_MS,
  timeoutMs = 8000,
  log = () => {},
  onStep = () => {},
  now = () => Date.now()
}) {
  if (!checkoutTemplate?.checkout) throw esliteApiError('誠品帳號尚未建立 API 結帳範本', 'needs_setup');
  if (checkoutTemplate.paymentMode && settings.payment && checkoutTemplate.paymentMode !== settings.payment) {
    throw esliteApiError('誠品付款策略已變更，請先重新建立此帳號的 API 結帳範本', 'needs_setup');
  }
  const startedAt = now();
  const safeDeadlineMs = Math.max(1, Math.min(Number(deadlineMs) || ESLITE_API_ORDER_DEADLINE_MS, ESLITE_API_ORDER_WINDOW_MS));
  const deadlineAt = startedAt + safeDeadlineMs;
  const steps = [];
  const timings = { deadlineMs: safeDeadlineMs, targetMs: 6000, prevalidated: Boolean(prevalidated), steps };
  let api = apiContext;
  let ownsApi = false;
  let stage = 'session';
  let previousStepAt = startedAt;
  const checkpoint = (name, detail = '', state = 'info', extra = {}) => {
    stage = name;
    const time = now();
    const step = safePurchaseStep({ at: new Date(time).toISOString(), label: name, state,
      elapsedMs: time - startedAt, durationMs: time - previousStepAt, reason: detail, ...extra });
    previousStepAt = time;
    steps.push(step);
    log(`誠品下單｜${product.id}｜${step.displayLabel||name}｜累計 ${(step.elapsedMs / 1000).toFixed(3)} 秒${detail ? `｜${purchaseErrorSummary(detail)}` : ''}`);
    try { Promise.resolve(onStep(step)).catch(() => {}); } catch {}
  };
  const explicitlyRejected = (response, body) => response.status() === 422
    && !body?.order_id && !body?.order_number
    && (body?.success === false || (typeof body?.error === 'string' && body.error.trim())
      || (Array.isArray(body?.errors) && body.errors.length > 0)
      || (body?.errors && !Array.isArray(body.errors) && Object.keys(body.errors).length > 0));
  const timeoutForStep = (capMs = timeoutMs) => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw esliteApiError(`誠品 API 下單已超過 ${safeDeadlineMs / 1000} 秒安全期限，未送出新的訂單請求`, 'deadline_exceeded');
    return Math.max(1, Math.min(Number(capMs) || remaining, remaining));
  };
  const completedTimings = () => {
    timings.totalMs = Math.max(0, now() - startedAt);
    timings.deadlineMet = timings.totalMs <= safeDeadlineMs;
    timings.targetMet = timings.totalMs <= 6000;
    return timings;
  };
  // Only retry reads. A slow/missing add response must never cause another add.
  const readCart = async (label) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      checkpoint(label, `第 ${attempt}/2 次讀取官方購物車；只查詢，不重複加入商品`, 'start', { attempt });
      try {
        const response = await api.get(`/api/v2/cart/items?type=shopping&step=1&d=${now()}`, { timeout: timeoutForStep(attempt === 1 ? 5000 : 8000) });
        const body = await esliteResponseJson(response);
        if (response.status() === 401) throw esliteApiError('誠品核對購物車時登入失效，未送單', 'needs_login');
        if (response.ok() && Array.isArray(body?.cart?.cart_items)) return body.cart.cart_items;
        const error = esliteApiError(`購物車讀取暫時無法確認（HTTP ${response.status()}）`, 'cart_unknown');
        error.httpStatus = response.status();
        if (response.status() === 429) error.purchaseStatus = 'rate_limited';
        else if (response.status() >= 400 && response.status() < 500) error.purchaseStatus = 'cart_conflict';
        // Do not hammer a rate limit or retry a permanent contract error.
        if (response.status() === 429 || (response.status() < 500 && response.status() !== 200)) error.noRetry = true;
        throw error;
      } catch (error) {
        if (error.purchaseStatus === 'needs_login' || error.noRetry || attempt === 2 || deadlineAt - now() < 2500) throw error;
        checkpoint('購物車讀取補查', purchaseErrorSummary(error), 'retry', { attempt });
      }
    }
  };
  try {
    if (!api) {
      const created = await createEsliteApiContext(sessionFile, { requestFactory, timeoutMs, now });
      api = created.api;
      ownsApi = true;
    }
    timings.clientReadyMs = now() - startedAt;
    if (!prevalidated) {
      checkpoint('核對會員登入', '只確認會員，不讀車、不清車', 'start');
      const memberResponse = await api.get(`/api/v2/member?t=${now()}`, { timeout: timeoutForStep() });
      try {
      if (memberResponse.status() === 401) throw esliteApiError('誠品登入已失效，請重新登入', 'needs_login');
      if (!memberResponse.ok()) throw esliteApiError(`誠品會員 API 回傳 HTTP ${memberResponse.status()}`, 'rate_limited');
      const member = await esliteResponseJson(memberResponse);
      if (!member || !(member.id || member.uuid || member.lms_member_id)) {
        throw esliteApiError('誠品會員 API 沒有回傳可確認的會員身分，保留憑證並停止本次下單', 'unknown');
      }
      timings.sessionReadyMs = now() - startedAt;
      checkpoint('核對會員登入', '會員已確認，直接核對派單並加車', 'success');
      } finally { await releaseResponse(memberResponse); }
    }
    let quantity = Math.max(1, Math.min(Number(settings.quantity) || 1, Number(product.stock) || 1));
    let batchReceipt = {};
    if (settings.batchProducts) {
      checkpoint('核對派單任務', `${settings.batchProducts.length} 款合單；帳號 ${settings.accountSlot || '本帳號'}`, 'start', { taskNumber: settings.taskSequence || 1 });
      checkpoint('核對派單任務', '本批指定商品將依序加車；同帳號不併發改車', 'success', { taskNumber: settings.taskSequence || 1 });
      batchReceipt = await fillEsliteBatchCart({ api, products: settings.batchProducts, settings, readCart, timeoutForStep, checkpoint, now });
      quantity = batchReceipt.quantity;
    } else {
    checkpoint('核對派單任務', `${product.title||product.id} ×${quantity}；帳號 ${settings.accountSlot||'本帳號'}`, 'start', {taskNumber:settings.taskSequence||1});
    if (!product.id) throw esliteApiError('派單缺少商品識別，未加車','needs_setup');
    checkpoint('核對派單任務', '指定商品、數量與本帳號任務一致', 'success', {taskNumber:settings.taskSequence||1});
    let addUncertain = false;
    checkpoint('開始加車', `${product.title || product.id} ×${quantity}；只送一次加車請求`, 'start');
    let addResponse, addBody;
    try {
    addResponse = await api.post('/api/v2/cart/items', {
      data: { product_guid: String(product.id), qty: quantity, crosssell_items: [] },
      timeout: timeoutForStep(5000)
    });
    addBody = await esliteResponseJson(addResponse);
    } catch (error) {
      addUncertain = true;
      checkpoint('加車回應待核對', purchaseErrorSummary(error), 'retry');
    }
    if (addResponse && addResponse.status() >= 500) addUncertain = true;
    if (!addUncertain) {
    if (addResponse.status() === 401) throw esliteApiError('誠品登入在加車前失效，已停止下單', 'needs_login');
    if (addResponse.status() === 409) throw esliteApiError('誠品商品已無法加入購物車', 'inventory_conflict');
    if ([429, 503].includes(addResponse.status())) {
      throw esliteApiError(`誠品加入購物車暫時受限（HTTP ${addResponse.status()}）`, 'rate_limited');
    }
    if (!addResponse.ok()) {
      const reason = safePurchaseText(typeof addBody?.error === 'string' ? addBody.error : typeof addBody?.message === 'string' ? addBody.message : '', 160);
      const limited = /限購|已達.*上限|曾經購買|已購買過|purchase.*limit/i.test(reason);
      throw esliteApiError(`誠品加入購物車失敗（HTTP ${addResponse.status()}）${reason ? `：${reason}` : ''}`, limited ? 'purchase_limited' : 'cart_conflict');
    }
    const addedGuid = String(addBody?.product_guid || '');
    const addedQuantity = Number(addBody?.response_quantity ?? addBody?.request_quantity ?? 0);
    if (addedGuid !== String(product.id) || addedQuantity !== quantity) {
      if (addedGuid && addedGuid !== String(product.id)) throw esliteApiError('誠品 API 加入的商品與目標不符，已停止下單', 'cart_conflict');
      addUncertain = true;
    }
    }
    timings.cartAddedMs = now() - startedAt;
    if (!addUncertain) checkpoint('加車確認', `官方回傳指定商品 ${product.title || product.id} ×${quantity}；下一步核對單品購物車，尚未成立訂單`, 'success', { httpStatus: addResponse.status() });
    // Without a pre-task clear, every order must prove exact contents after
    // adding, even when an older caller omits strictSingleProductOrder.
    {
      let items = await readCart('核對單品購物車');
      // A timed-out add can commit after the first successful empty read.
      // One bounded delayed read is allowed; never re-add or accept a mixed cart.
      if (items.length === 0 && deadlineAt-now() >= 2500) {
        checkpoint('購物車讀取補查', '第一次查車仍空；等待官方同步後只補查一次，不重加商品', 'retry', {attempt:2});
        await new Promise(resolve=>setTimeout(resolve,400));
        items=await readCart('核對單品購物車');
      }
      if (items.length !== 1
        || String(items[0].product_guid || items[0].guid) !== String(product.id)
        || Number(items[0].qty ?? items[0].quantity) !== quantity) {
        throw esliteApiError('誠品購物車不是指定商品單獨一款或數量不符，未送單；不把殘留商品混入訂單', 'cart_conflict');
      }
      timings.singleProductVerifiedMs = now() - startedAt;
      if(addUncertain) checkpoint('加車確認','加車回應曾不明；現由官方購物車確認指定商品與數量，未再次加車','success');
      checkpoint('單品購物車確認', `購物車只有 ${product.title || product.id} ×${quantity}，沒有混入其他商品；下一步送出本帳號結帳資料`, 'success');
    }
    }
    if (settings.action !== 'checkout') {
      return { ...batchReceipt, status: 'carted', quantity, detail: '已由誠品 API 加入並核對指定商品，未清車、未送出訂單', timings: completedTimings() };
    }

    checkpoint('準備結帳資料', '使用本帳號結帳範本，核對付款、配送與收件資料；不借用其他帳號憑證', 'start');
    let checkout = {...structuredClone(checkoutTemplate.checkout),discount_point:0};
    let actualPayment = settings.payment;
    let paymentFallback = settings.paymentFallback;
    checkpoint('準備結帳資料', '已讀取本帳號結帳資料；下一步強制紅利為零', 'success');
    checkpoint('紅利折抵歸零中','強制覆寫 discount_point 為 0','start');
    checkpoint('紅利折抵已歸零', '本次送單 discount_point 固定為 0，不使用範本內既有紅利', 'success');
    checkpoint('可用配送與付款核對中', '檢查本帳號的配送／付款資料；不在結果不明時切換付款', 'start');
    if (settings.paymentFallback) checkpoint('可用配送與付款備援切換',
      `${settings.paymentFallback.reason}；共用宅配資料已核對，本次由 7-11 取貨付款改為宅配 ATM；紅利 0，原設定不變`, 'info');
    const validated = settings.batchProducts ? await verifyEsliteBatchQuote({ api, checkout, maxTotal: settings.maxTotal, timeoutForStep,
      requestedPayment: settings.payment, deliveryProfile: settings.deliveryProfile, linePayPrimeProvider: settings.linePayPrimeProvider })
      : settings.validateBeforeSubmit ? await settings.validateBeforeSubmit({api,checkout,product,quantity}) : null;
    if (validated?.paymentFallback) {
      checkout = validated.checkout; actualPayment = validated.payment; paymentFallback = validated.paymentFallback;
      checkpoint('可用配送與付款備援切換', `官方確認原付款不可用；已改用共用宅配${actualPayment === 'line_pay_home' ? ' LINE Pay（待付款）' : ' ATM'}並重新核對含運金額，紅利 0`, 'info');
    }
    checkpoint('可用配送與付款已核對', settings.batchProducts || settings.validateBeforeSubmit?'指定配送與付款已經本次官方購物車 API 驗證':'使用本帳號已保存的配送／付款範本；實際可購性仍由官方送單判定', 'success');
    if(actualPayment==='seven_cod') {
      checkpoint('取貨門市核對中', '核對本帳號的已保存門市資料，不使用其他帳號憑證', 'start');
      checkpoint('取貨門市已核對', `本帳號門市：${checkout.recipient?.store?.name||'範本未提供名稱'}；門市是否可配送由官方送單再次檢核`, 'success');
    }
    if(validated && Number.isFinite(validated.total)) checkpoint('含運總額已核對',`商品 ${validated.subtotal}＋運費上限 ${validated.fee}＝${validated.total}；紅利 0，符合本次授權上限`,'success');
    const paymentResult = { payment: actualPayment, requestedPayment: settings.requestedPayment || settings.payment, paymentFallback };
    if(settings.verifyOnly) return {...batchReceipt,...paymentResult,status:'checkout_ready',quantity,detail:'購物車、紅利及指定結帳資料已核對，未送單',timings:completedTimings()};
    // Persist once before the first POST. Retries may only follow explicit rejection.
    if (settings.onBeforeSubmit) {
      await settings.onBeforeSubmit({productId:String(product.id),quantity,payment:actualPayment,...batchReceipt});
      checkpoint('保存送單意圖', '本帳號本商品送單意圖已保存；回應不明時查單而非重送', 'success');
    }

    let checkoutResponse;
    let checkoutBody;
    // 先在送出前取得剩餘預算；安全窗口用完必須停止，不能把
    // 「根本尚未送出」誤記成結果不明。
    const checkoutAttemptsLimit = actualPayment === 'line_pay_home' ? 1 : 3;
    for (let attempt = 1; attempt <= checkoutAttemptsLimit; attempt += 1) {
      // The deadline gates NEW writes. An already dispatched checkout gets
      // its own bounded observation window, even with only 3s left to dispatch.
      timeoutForStep(1);
      const checkoutTimeoutMs = 15000;
      timings.checkoutResponseBudgetMs = checkoutTimeoutMs;
      timings.dispatchDeadlineMet = now() < deadlineAt;
      timings.checkoutSubmittedMs ??= now() - startedAt;
      timings.checkoutAttempts = attempt;
      checkpoint('開始送單', `第 ${attempt}/${checkoutAttemptsLimit} 次；使用本帳號的${actualPayment === 'seven_cod' ? '7-11 取貨付款' : actualPayment === 'line_pay_home' ? '宅配 LINE Pay（待付款）' : '宅配 ATM'}結帳資料，同帳號不併發重複送單`, 'start', {attempt});
      try {
      checkoutResponse = await api.post('/api/v1/orders/checkout', {
        data: { checkout },
        timeout: checkoutTimeoutMs
      });
      } catch (error) {
      timings.checkoutUncertainMs = now() - startedAt;
      timings.submitToResponseMs = timings.checkoutUncertainMs - timings.checkoutSubmittedMs;
      checkpoint('送單結果待核對', '未取得回應；禁止重送，保護帳號', 'unknown');
      return {
        ...batchReceipt, ...paymentResult, status: 'submitted_unconfirmed', quantity,
        detail: `誠品 API 送單連線中斷，可能已被網站接收；禁止自動重送，請至會員訂單人工確認：${conciseAutomationError(error)}`,
        timings: completedTimings()
      };
      }
      checkoutBody = await esliteResponseJson(checkoutResponse);
      timings.checkoutAttempts = attempt;
      checkpoint('送單回應', checkoutBody?.order_number || checkoutBody?.order_id ? '官方已回傳訂單識別，下一步判讀是否可確認成立；不再重送' : '官方尚未回傳訂單編號；下一步區分明確拒單與結果不明，不能僅憑回應碼宣告成功', 'info', { httpStatus: checkoutResponse.status(), attempt });
      // Retry only a structured, explicit 422 rejection, never a timeout or
      // ambiguous 5xx. An order identifier always prevents another submission.
      const rejected = explicitlyRejected(checkoutResponse, checkoutBody);
      const busy = rejected && /系統忙碌|系統繁忙|system.*busy|try again/i.test(JSON.stringify(checkoutBody));
      if (!busy || attempt === checkoutAttemptsLimit || deadlineAt - now() < 1200) break;
      checkpoint('網站忙碌，有限重試', `明確拒絕，本車第 ${attempt + 1} 次送單；不重複加車`, 'retry', { attempt: attempt + 1 });
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    timings.checkoutRespondedMs = now() - startedAt;
    timings.submitToResponseMs = timings.checkoutRespondedMs - timings.checkoutSubmittedMs;
    if (!checkoutResponse.ok() && (checkoutBody?.order_id || checkoutBody?.order_number)) {
      return { ...batchReceipt, ...paymentResult, status: 'submitted_unconfirmed', quantity,
        orderId: String(checkoutBody.order_number || checkoutBody.order_id),
        detail: `誠品回傳 HTTP ${checkoutResponse.status()} 但包含訂單編號；請人工核對，不自動重送`, timings: completedTimings() };
    }
    if (checkoutResponse.status() === 401) throw esliteApiError('誠品送單時登入已失效（HTTP 401），本次未被接受', 'needs_login');
    if (explicitlyRejected(checkoutResponse, checkoutBody)) {
      const busy = /系統忙碌|系統繁忙|system.*busy|try again/i.test(JSON.stringify(checkoutBody));
      throw esliteApiError('誠品送單明確拒絕（HTTP 422），本輪有限重試後仍未接受；不記為成功', busy ? 'checkout_busy' : 'checkout_rejected');
    }
    if ([422, 429, 500, 502, 503, 504].includes(checkoutResponse.status())) {
      return {
        ...batchReceipt, ...paymentResult, status: 'submitted_unconfirmed', quantity,
        detail: `誠品送單端點回傳 HTTP ${checkoutResponse.status()}；禁止自動重送或改買下一款，請至會員訂單人工確認`,
        timings: completedTimings()
      };
    }
    if (!checkoutResponse.ok()) {
      throw esliteApiError(`誠品送單未被接受（HTTP ${checkoutResponse.status()}）`, 'checkout_rejected');
    }
    const orderId = String(checkoutBody?.order_number || checkoutBody?.order_id || '').trim();
    if (!orderId) {
      return {
        ...batchReceipt, ...paymentResult, status: 'submitted_unconfirmed', quantity,
        detail: '誠品送單端點已回覆成功，但未提供可確認的訂單編號；禁止自動重送，請人工確認',
        timings: completedTimings()
      };
    }
    checkpoint('訂單確認', `官方送單 API 已回傳單號 ${orderId}；下一步保存訂單與私人通知，訂單成立不代表已付款`, 'success');
    return {
      ...batchReceipt, ...paymentResult, status: 'ordered', quantity, orderId,
      ...(validated ? { amount: validated.total } : {}),
      detail: `誠品 API 訂單已送出｜${orderId}`,
      resultUrl: `https://www.eslite.com/cart/step3?orderid=${encodeURIComponent(orderId)}`,
      timings: completedTimings()
    };
  } catch (error) {
    const failedStage = stage;
    // Checkout transport failures returned submitted_unconfirmed above. Only
    // failures before that protected boundary may start a fresh transaction.
    error.purchaseStatus ||= 'precheckout_unavailable';
    const last=steps[steps.length-1];
    checkpoint('本次停止', purchaseErrorSummary(error), 'failed', {stepNumber:last?.stepNumber||1,stepTitle:last?.stepTitle||'購物車'});
    error.timings ||= { ...completedTimings(), failedAtMs: Math.max(0, now() - startedAt) };
    error.timings.failedStage = failedStage;
    error.message = purchaseErrorSummary(error);
    log(`誠品下單停止｜${product.id}｜${failedStage}｜${error.timings.totalMs}ms｜${error.message}`);
    throw error;
  } finally {
    if (ownsApi) await api?.dispose?.().catch(() => {});
  }
}

export async function maintainEsliteApiSession(sessionFile, {
  clearCart = false,
  requestFactory = playwrightRequest,
  apiContext = null,
  timeoutMs = 8000,
  now = () => Date.now(), expectedAccount
} = {}) {
  const startedAt = now();
  let api = apiContext;
  let ownsApi = false;
  try {
    if (!api) {
      const created = await createEsliteApiContext(sessionFile, { requestFactory, timeoutMs, now });
      api = created.api;
      ownsApi = true;
    }
    const [memberResponse, cartResponse] = await Promise.all([
      api.get(`/api/v2/member?t=${now()}`, { timeout: timeoutMs }),
      clearCart ? api.get(`/api/v2/cart/items?type=shopping&step=1&d=${now()}`, { timeout: timeoutMs }) : Promise.resolve(null)
    ]);
    if (memberResponse.status() === 401) throw esliteApiError('誠品登入已失效，請重新登入', 'needs_login');
    const member = await esliteResponseJson(memberResponse);
    if (!memberResponse.ok() || !member || !(member.id || member.uuid || member.lms_member_id)) {
      throw esliteApiError(`誠品會員 API 無法確認登入（HTTP ${memberResponse.status()}）`, 'unknown');
    }
    if (expectedAccount) await readEsliteMemberDetail(api, { expectedAccount, timeoutMs });
    if (!clearCart) return { ok: true, loggedIn: true, removed: 0, cartEmpty: null, durationMs: now() - startedAt };
    if (!cartResponse?.ok()) throw esliteApiError(`誠品購物車 API 回傳 HTTP ${cartResponse?.status?.() || '未知'}`, 'cart_conflict');
    const cart = await esliteResponseJson(cartResponse);
    if (!Array.isArray(cart?.cart?.cart_items)) throw esliteApiError('購物車資料格式無法確認，未執行清車', 'cart_unknown');
    const items = cart.cart.cart_items;
    const deletions = await Promise.all(items.map((item) => api.delete('/api/v2/cart/items', {
      data: { cart_item_id: item.cart_item_id }, timeout: timeoutMs
    })));
    if (deletions.some((response) => !response.ok())) throw esliteApiError('誠品購物車未能完整清除', 'cart_conflict');
    await Promise.all(deletions.map(releaseResponse));
    const confirmation = await api.get(`/api/v2/cart/items?type=shopping&step=1&d=${now()}`, { timeout: timeoutMs });
    const confirmedCart = await esliteResponseJson(confirmation);
    if (!confirmation.ok() || !Array.isArray(confirmedCart?.cart?.cart_items) || confirmedCart.cart.cart_items.length) {
      throw esliteApiError('誠品清車後尚未確認空車，請重新檢查', 'cart_unknown');
    }
    return { ok: true, loggedIn: true, removed: items.length, cartEmpty: true, durationMs: now() - startedAt };
  } finally {
    if (ownsApi) await api?.dispose?.().catch(() => {});
  }
}

export class EslitePurchaseAdapter extends BrowserPurchaseAdapter {
  constructor(options) {
    const accountSlot = String(options.accountSlot || 'A').toUpperCase();
    const legacySlot = accountSlot === 'A';
    super({
      ...options,
      profileName: options.profileName || (legacySlot ? 'eslite' : `eslite-account-${accountSlot.toLowerCase()}`)
    });
    this.accountSlot = accountSlot;
    this.accountLabel = `帳號 ${accountSlot}`;
    this.sessionFile = options.sessionFile || path.join(
      options.dataDir,
      'auto-purchase',
      legacySlot ? 'eslite-session.json' : `eslite-account-${accountSlot.toLowerCase()}-session.json`
    );
    this.getCredentials = options.getCredentials || (() => ({
      account: String(options.account || ''), password: String(options.password || '')
    }));
    this.verifyAccountIdentity = options.verifyAccountIdentity === true;
    this.apiSessionVerifier = options.apiSessionVerifier || ((sessionFile) => verifyEsliteApiSession(sessionFile,
      { expectedAccount: this.verifyAccountIdentity ? this.getCredentials().account : undefined }));
    this.customApiSessionVerifier = Boolean(options.apiSessionVerifier);
    this.apiPurchaseRunner = options.apiPurchaseRunner || purchaseEsliteViaApi;
    this.apiMaintenanceRunner = options.apiMaintenanceRunner || maintainEsliteApiSession;
    this.apiOrderReader = options.apiOrderReader || readEsliteOrderHistory;
    this.apiContextFactory = options.apiContextFactory || ((sessionFile) => createEsliteApiContext(sessionFile));
    this.getCheckoutTemplate = options.getCheckoutTemplate || (() => null);
    this.getPickupSetup = options.getPickupSetup;
    this.getSelectedPayment = options.getSelectedPayment || (() => 'virtual_atm_home');
    this.accountSetupRunner = options.accountSetupRunner || prepareEsliteAccountViaApi;
    this.onMemberIdentified = options.onMemberIdentified || (async () => {});
    this.onAccountPrepared = options.onAccountPrepared || (async () => {});
    this.onLoginValidated = options.onLoginValidated || (async () => {});
    this.accountPreparationState = 'idle';
    this.accountPreparationError = '';
    this.accountPreparedAt = '';
    this.preparationJob = null;
    this.preparationRequested = null;
    this.accountPreparationLastAttemptMs = 0;
    this.apiOnly = options.apiOnly === true;
    this.autoLoginEnabled = options.autoLoginEnabled === true;
    this.loginRequestFactory = options.loginRequestFactory || playwrightRequest;
    this.manualLoginRequired = false;
    this.loginAttemptSubmitted = false;
    this.loginBusyAttempts = 0;
    this.loginBrowserContext = null;
    this.maintenanceCartUrl = 'https://www.eslite.com/cart';
    this.maintenanceHeadless = false;
    this.loginState = 'idle';
    this.lastVerifiedAt = '';
    this.nextVerifyAt = '';
    this.lastVerifyError = '';
    this.sessionHeartbeatEnabled = false;
    this.sessionHeartbeatTimer = null;
    this.sessionHeartbeatStartupTimer = null;
    this.heartbeatAcceleratedUntilMs = 0;
    this.sessionVerifyRunning = false;
    this.heartbeatChecks = 0;
    this.heartbeatFailures = 0;
    this.lastHeartbeatAt = '';
    this.lastHeartbeatResult = '尚未檢查';
    this.accountTail = Promise.resolve();
    this.accountBusy = 0;
    this.apiContext = null;
    this.apiContextSessionMtimeMs = 0;
    this.apiTokenExpiresAtMs = 0;
    this.apiReadyAtMs = 0;
    this.apiCartKnownEmpty = false;
    this.sessionRecoveryRunner = options.sessionRecoveryRunner || (args => this._recoverSessionInBackground(args));
    this.onSessionProblem = options.onSessionProblem || (() => {});
    this.sessionRecoveryAfterMs = 0;
    this.sessionRecoveryState = 'idle';
    this.lastBrowserSessionImportedAt = '';
    this.proactiveRenewalAttemptedExpiryMs = 0;
    this.loginRecoverySaveQueue = Promise.resolve();
    this.lastSessionAlert = '';
    this.lastTokenExpiresAtMs = 0;
    this.purchaseHold = null;
    this.getPersistedPurchaseHold = () => options.getPurchaseHold?.(this.accountSlot) || null;
    this.localSessionLoad = this.apiOnly ? this._loadStoredTokenStatus() : Promise.resolve();
  }

  activePurchaseHold() { return this.purchaseHold || this.getPersistedPurchaseHold(); }

  async _loadStoredTokenStatus() {
    try {
      const stored = JSON.parse(await fs.readFile(this.sessionFile, 'utf8'));
      const token = readEsliteAuthToken(stored);
      this.lastTokenExpiresAtMs = esliteTokenExpiryMs(token);
      const meta = await fs.readFile(`${this.sessionFile}.browser-import-meta.json`, 'utf8').then(JSON.parse).catch(() => null);
      if (meta?.version === 1 && typeof meta.importedAt === 'string') this.lastBrowserSessionImportedAt = meta.importedAt;
      if ((!token || (this.lastTokenExpiresAtMs && this.lastTokenExpiresAtMs <= Date.now())) && this.loginState === 'idle') {
        this.loginState = 'needs_login';
        this.sessionRecoveryState = 'needs_attention';
        this.lastVerifyError = '本地 API 憑證不存在或已到期；請在專用登入視窗登出後重新登入';
      }
      const recovery = await fs.readFile(`${this.sessionFile}.login-recovery.json`, 'utf8').then(JSON.parse).catch(() => null);
      if (recovery?.version === 1 && recovery.tokenExpiryMs === this.lastTokenExpiresAtMs) {
        this.manualLoginRequired = recovery.manualRequired === true;
        this.sessionRecoveryAfterMs = Math.max(0, Math.min(Date.now() + 15 * 60000, Number(recovery.afterMs) || 0));
        this.loginBusyAttempts = Math.max(0, Math.min(5, Number(recovery.busyAttempts) || 0));
        this.proactiveRenewalAttemptedExpiryMs = Number(recovery.proactiveExpiryMs) || 0;
        if (this.manualLoginRequired) {
          this.sessionRecoveryState = 'manual_required';
          this.lastVerifyError = '上次官方要求人工驗證，已保留暫停；不因重啟反覆送出登入';
        } else if (this.sessionRecoveryAfterMs > Date.now()) this.sessionRecoveryState = 'retry_pending';
      }
    } catch { /* No local session yet: keep idle, never infer an API login. */ }
  }

  _persistLoginRecovery() {
    const snapshot = { version: 1, tokenExpiryMs: this.lastTokenExpiresAtMs, manualRequired: this.manualLoginRequired,
      afterMs: this.sessionRecoveryAfterMs, busyAttempts: this.loginBusyAttempts,
      proactiveExpiryMs: this.proactiveRenewalAttemptedExpiryMs, at: new Date().toISOString() };
    this.loginRecoverySaveQueue = this.loginRecoverySaveQueue.catch(() => {}).then(async () => {
      // Failed browser probes may reset the in-memory expiry. Bind the pause
      // to the actual saved credential, and never create files for empty fixtures.
      const stored = await fs.readFile(this.sessionFile, 'utf8').then(JSON.parse).catch(() => null);
      if (!stored) return;
      snapshot.tokenExpiryMs = esliteTokenExpiryMs(readEsliteAuthToken(stored));
      await saveEsliteBrowserSession(`${this.sessionFile}.login-recovery.json`, snapshot);
    }).catch(() => {
        this.log('登入冷卻紀錄未能保存；目前暫停狀態仍保留。');
      });
    return this.loginRecoverySaveQueue;
  }

  async _recoverSessionInBackground({ renewAfterExpiryMs = 0 } = {}) {
    // Ordinary first-party login using the existing account profile. No visible
    // window and no CAPTCHA/Cloudflare bypass; those require the account owner.
    const context = await this._loginContext(true);
    try {
      const page = await context.newPage();
      await this._login(page, context, { interactive: false, renewAfterExpiryMs });
    } finally {
      await context.close();
      if (this.loginBrowserContext === context) this.loginBrowserContext = null;
    }
  }

  async _loginContext(headless) {
    await fs.mkdir(this.profileDirectory, { recursive: true });
    // Normal first-party Chrome; no webdriver override, stealth flag, or challenge bypass.
    this.loginBrowserContext = await this.persistentContextLauncher(this.profileDirectory, {
      headless, channel: 'chrome', locale: 'zh-TW', timezoneId: 'Asia/Taipei'
    });
    // A verified external-browser import belongs to this same account. The
    // next official login uses that saved state, not a stale private profile.
    if (this.lastBrowserSessionImportedAt) {
      try {
      const saved = JSON.parse(await fs.readFile(this.sessionFile, 'utf8'));
      const state = normalizeEsliteBrowserSession(saved).state;
      await this.loginBrowserContext.addCookies(state.cookies);
      await this.loginBrowserContext.addInitScript(seedEsliteAuthOnce,
        { origin: 'https://www.eslite.com', entries: state.origins[0].localStorage, marker: 'eslite-auth-import-' + crypto.randomUUID() });
      } catch { /* Expired imported tokens do not block normal official login. */ }
    }
    return this.loginBrowserContext;
  }

  async _recoverApiSession({ renewAfterExpiryMs = 0 } = {}) {
    if (this.apiOnly && !this.autoLoginEnabled) {
      this.sessionRecoveryState = 'needs_attention';
      throw esliteApiError('誠品 API 憑證需更新；官方目前沒有已驗證的 refresh API，請在專用登入視窗登出後重新登入，不自動開啟瀏覽器', 'needs_login');
    }
    if (this.manualLoginRequired || this.sessionRecoveryState === 'manual_required') throw esliteApiError('官方要求人工驗證，請開啟專用登入視窗完成；不反覆自動登入', 'human_required');
    if (Date.now() < this.sessionRecoveryAfterMs) throw esliteApiError('自動登入冷卻中，稍後自動再查；不重複送出', 'unknown');
    this.sessionRecoveryAfterMs = Date.now() + 15 * 60 * 1000;
    this.sessionRecoveryState = 'recovering';
    this.loginAttemptSubmitted = false;
    await this._persistLoginRecovery();
    this.log('登入憑證即將到期或已失效，開始背景恢復；不開前景視窗。');
    try {
      await this.sessionRecoveryRunner({ renewAfterExpiryMs });
      if (renewAfterExpiryMs) {
        const saved = JSON.parse(await fs.readFile(this.sessionFile, 'utf8'));
        const expiry = esliteTokenExpiryMs(readEsliteAuthToken(saved));
        if (expiry <= renewAfterExpiryMs) throw esliteApiError('官方前端未提供較新的登入憑證，保留原憑證；未延長到期時間', 'unknown');
        this.lastTokenExpiresAtMs = expiry;
      }
      await this._disposeApiContext();
      const result = this.autoLoginEnabled ? await this.apiSessionVerifier(this.sessionFile)
        : await this.apiMaintenanceRunner(this.sessionFile, { apiContext: await this._ensureApiContext(), clearCart: false, timeoutMs: 4000 });
      if (!result.ok || result.loggedIn !== true) throw esliteApiError('背景登入後仍未取得有效會員 API 證據', result.loggedIn === false ? 'needs_login' : 'unknown');
      if (!this.autoLoginEnabled) {
        this.apiCartKnownEmpty = result.cartEmpty === true;
        this.apiReadyAtMs = this.apiCartKnownEmpty ? Date.now() : 0;
      }
      this.sessionRecoveryState = 'recovered';
      this.manualLoginRequired = false;
      this.lastSessionAlert = '';
      this.log('背景登入恢復成功，會員 API 已確認；購物車保持帳號隔離。');
      await this._persistLoginRecovery();
      return result;
    } catch (error) {
      this.manualLoginRequired = error.purchaseStatus === 'human_required';
      this.sessionRecoveryState = this.manualLoginRequired ? 'manual_required' : 'retry_pending';
      if (error.purchaseStatus === 'login_busy') this._deferBusyLogin(error);
      await this._persistLoginRecovery();
      throw esliteApiError(`誠品背景登入恢復未完成：${conciseAutomationError(error)}`, error.purchaseStatus || (this.autoLoginEnabled ? 'unknown' : 'needs_login'));
    }
  }

  _alertSessionProblem(error) {
    const key = `${this.lastTokenExpiresAtMs}:${error.purchaseStatus || 'needs_login'}`;
    if (this.lastSessionAlert === key) return;
    this.lastSessionAlert = key;
    const detail = conciseAutomationError(error);
    this.log(`登入待命失敗｜${detail}`);
    Promise.resolve(this.onSessionProblem({ slot: this.accountSlot, detail })).catch((alertError) => {
      this.lastSessionAlert = '';
      this.log(`私人登入警告發送失敗：${conciseAutomationError(alertError)}`);
    });
  }

  _apiReady(nowMs = Date.now()) {
    return Boolean(
      this.apiContext
      && this.apiReadyAtMs > 0
      && (this.apiOnly ? this.loginState === 'ready' && !this.interactiveLogin
        : nowMs - this.apiReadyAtMs <= ESLITE_API_READY_TTL_MS)
      && (!this.apiTokenExpiresAtMs || this.apiTokenExpiresAtMs > nowMs)
    );
  }

  _heartbeatIntervalMs(nowMs = Date.now()) {
    if (this.sessionRecoveryState === 'retry_pending' && this.sessionRecoveryAfterMs > nowMs) {
      return Math.max(1000, this.sessionRecoveryAfterMs - nowMs);
    }
    return nowMs < this.heartbeatAcceleratedUntilMs
      ? ESLITE_SESSION_HEARTBEAT_ACCELERATED_MS
      : ESLITE_SESSION_HEARTBEAT_INTERVAL_MS;
  }

  _scheduleHeartbeat(delayMs = this._heartbeatIntervalMs()) {
    if (this.sessionHeartbeatTimer) clearTimeout(this.sessionHeartbeatTimer);
    this.sessionHeartbeatTimer = null;
    if (!this.sessionHeartbeatEnabled) return;
    let safeDelayMs = Math.max(1000, Number(delayMs) || this._heartbeatIntervalMs());
    if (this.lastTokenExpiresAtMs > Date.now() && Date.now() >= this.sessionRecoveryAfterMs) {
      const renewAhead = this.autoLoginEnabled && this.proactiveRenewalAttemptedExpiryMs !== this.lastTokenExpiresAtMs
        ? ESLITE_SESSION_RENEW_AHEAD_MS : 0;
      safeDelayMs = Math.min(safeDelayMs, Math.max(60_000, this.lastTokenExpiresAtMs - Date.now() - renewAhead));
    }
    this.nextVerifyAt = new Date(Date.now() + safeDelayMs).toISOString();
    this.sessionHeartbeatTimer = setTimeout(async () => {
      this.sessionHeartbeatTimer = null;
      if (!this.sessionHeartbeatEnabled) return;
      await this.verifyStoredSession({ source: 'heartbeat' }).catch(() => {});
      if (this.sessionHeartbeatEnabled) this._scheduleHeartbeat();
    }, safeDelayMs);
    this.sessionHeartbeatTimer.unref?.();
  }

  noteActivity({
    durationMs = ESLITE_SESSION_HEARTBEAT_ACCELERATION_DURATION_MS,
    delayMs = 0
  } = {}) {
    const nowMs = Date.now();
    if (this.activePurchaseHold()) return;
    this.heartbeatAcceleratedUntilMs = Math.max(
      this.heartbeatAcceleratedUntilMs,
      nowMs + Math.max(ESLITE_SESSION_HEARTBEAT_ACCELERATED_MS, Number(durationMs) || 0)
    );
    if (!this.sessionHeartbeatEnabled) return;
    if (!this._apiReady() && !this.sessionVerifyRunning && !this.accountBusy && !this.interactiveLogin) {
      if (this.sessionHeartbeatStartupTimer || nowMs - (this.lastActivityProbeAtMs || 0) < ESLITE_SESSION_HEARTBEAT_ACCELERATED_MS) return;
      const warmupDelayMs = Math.max(0, Number(delayMs) || 0);
      this.nextVerifyAt = new Date(nowMs + warmupDelayMs).toISOString();
      this.sessionHeartbeatStartupTimer = setTimeout(async () => {
        this.sessionHeartbeatStartupTimer = null;
        if (!this.sessionHeartbeatEnabled || this._apiReady()) return;
        this.lastActivityProbeAtMs = Date.now();
        await this.verifyStoredSession({ source: 'activity' }).catch(() => {});
        if (this.sessionHeartbeatEnabled) this._scheduleHeartbeat();
      }, warmupDelayMs);
      this.sessionHeartbeatStartupTimer.unref?.();
      return;
    }
    if (this.sessionHeartbeatStartupTimer) return;
    const nextAtMs = Date.parse(this.nextVerifyAt || '') || 0;
    if (!nextAtMs || nextAtMs - nowMs > ESLITE_SESSION_HEARTBEAT_ACCELERATED_MS) {
      this._scheduleHeartbeat(ESLITE_SESSION_HEARTBEAT_ACCELERATED_MS);
    }
  }

  _resetApiReadiness() {
    this.apiReadyAtMs = 0;
    this.apiCartKnownEmpty = false;
  }

  async _disposeApiContext() {
    const api = this.apiContext;
    this.apiContext = null;
    this.apiContextSessionMtimeMs = 0;
    this.apiTokenExpiresAtMs = 0;
    this._resetApiReadiness();
    await api?.dispose?.().catch(() => {});
  }

  async _ensureApiContext() {
    let mtimeMs = 0;
    try { mtimeMs = Number((await fs.stat(this.sessionFile)).mtimeMs) || 0; } catch {}
    try {
      const stored = JSON.parse(await fs.readFile(this.sessionFile, 'utf8'));
      this.lastTokenExpiresAtMs = esliteTokenExpiryMs(readEsliteAuthToken(stored));
    } catch {}
    if (this.apiContext && mtimeMs > 0 && mtimeMs === this.apiContextSessionMtimeMs) return this.apiContext;
    await this._disposeApiContext();
    const created = await this.apiContextFactory(this.sessionFile);
    this.apiContext = created?.api || created;
    this.apiTokenExpiresAtMs = Number(created?.expiresAtMs) || 0;
    this.apiContextSessionMtimeMs = mtimeMs;
    return this.apiContext;
  }

  async _purchaseContext() {
    const context = await this._context(this.sessionFile, { headless: false });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const type = request.resourceType();
      const url = request.url();
      const heavy = ['image', 'media', 'font'].includes(type);
      const telemetry = /(?:google-analytics\.com|doubleclick\.net|googlesyndication\.com|scorecardresearch\.com|criteo\.(?:com|net)|clarity\.ms)/i.test(url);
      try {
        if (heavy || telemetry) await route.abort();
        else await route.continue();
      } catch (error) {
        if (!/closed|disposed|already handled/i.test(String(error?.message || error))) throw error;
      }
    });
    return context;
  }

  credentialsStatus() {
    const { account, password } = this.getCredentials();
    return {
      ready: Boolean(account && password),
      account: maskAccount(account),
      loginState: this.loginState,
      lastVerifiedAt: this.lastVerifiedAt,
      nextVerifyAt: this.nextVerifyAt,
      lastVerifyError: this.lastVerifyError
    };
  }

  runtimeStatus() {
    const nowMs = Date.now();
    let paymentSelection;
    try { paymentSelection = resolveEsliteCheckoutSelection({ template: this.getCheckoutTemplate(), payment: this.getSelectedPayment(),
      deliveryProfile: this.getDeliveryProfile(), pickupUnavailable: Boolean(this.getPickupSetup && !this.getPickupSetup()) }); } catch {}
    return {
      accountBrowserOpen: Boolean(this.accountBrowser),
      cartActionUncertain: Boolean(this.cartActionUncertain),
      state: this.accountBusy ? 'busy' : this.loginState,
      interactiveLoginOpen: Boolean(this.interactiveLogin),
      loginState: this.loginState,
      lastVerifiedAt: this.lastVerifiedAt,
      nextVerifyAt: this.nextVerifyAt,
      lastVerifyError: this.lastVerifyError,
      heartbeatEnabled: this.sessionHeartbeatEnabled,
      heartbeatMode: nowMs < this.heartbeatAcceleratedUntilMs ? 'accelerated' : 'normal',
      heartbeatIntervalSeconds: this._heartbeatIntervalMs(nowMs) / 1000,
      heartbeatAcceleratedUntil: this.heartbeatAcceleratedUntilMs
        ? new Date(this.heartbeatAcceleratedUntilMs).toISOString()
        : '',
      heartbeatChecks: this.heartbeatChecks,
      heartbeatFailures: this.heartbeatFailures,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatResult: this.lastHeartbeatResult,
      accountSlot: this.accountSlot,
      apiReady: this._apiReady(nowMs) && (!this.apiOnly || Boolean(this.getCheckoutTemplate()?.checkout)),
      apiReadyUntil: this.apiReadyAtMs ? (this.apiOnly
        ? (this.apiTokenExpiresAtMs ? new Date(this.apiTokenExpiresAtMs).toISOString() : '')
        : new Date(this.apiReadyAtMs + ESLITE_API_READY_TTL_MS).toISOString()) : '',
      tokenExpiresAt: this.lastTokenExpiresAtMs ? new Date(this.lastTokenExpiresAtMs).toISOString() : '',
      sessionRecoveryState: this.sessionRecoveryState,
      browserSessionImportedAt: this.lastBrowserSessionImportedAt,
      recoveryAfter: this.sessionRecoveryAfterMs ? new Date(this.sessionRecoveryAfterMs).toISOString() : '',
      purchaseHold: this.activePurchaseHold(),
      checkoutTemplateReady: Boolean(this.getCheckoutTemplate()?.checkout),
      pickupSetupReady: this.getPickupSetup ? Boolean(this.getPickupSetup()) : undefined,
      pickupSetupRequired: this.getSelectedPayment() === 'seven_cod' && this.getPickupSetup && !this.getPickupSetup() && !paymentSelection?.paymentFallback,
      paymentFallbackReady: Boolean(paymentSelection?.paymentFallback),
      effectivePayment: paymentSelection?.payment,
      accountPreparationState: this.accountPreparationState,
      accountPreparationError: this.accountPreparationError,
      accountPreparedAt: this.accountPreparedAt,
      cartKnownEmpty: this.apiCartKnownEmpty,
      apiOnly: this.apiOnly,
      autoLoginEnabled: this.autoLoginEnabled,
      manualLoginRequired: this.manualLoginRequired,
      strategy: this.getCheckoutTemplate() ? (this.apiOnly ? 'api_single_product_guarded_path' : 'api_two_request_fast_path')
        : this.apiOnly ? 'api_template_required' : 'browser_fallback_needs_api_template'
    };
  }

  _markLoginReady({ keepRecoveryProblem = false } = {}) {
    this.loginState = 'ready';
    if (!keepRecoveryProblem) {
      this.sessionRecoveryState = 'idle';
      this.manualLoginRequired = false;
      this.loginBusyAttempts = 0;
    }
    if (this.accountPreparationState === 'human_required') {
      this.accountPreparationState = 'retry_pending';
      this.accountPreparationError = '';
    }
    this.lastVerifiedAt = new Date().toISOString();
    this.nextVerifyAt = new Date(Date.now() + this._heartbeatIntervalMs()).toISOString();
    this.lastVerifyError = '';
    this.lastSessionAlert = '';
    void this._persistLoginRecovery();
  }

  _markLoginProblem(error, state = 'error') {
    this.loginState = state;
    this.lastVerifiedAt = new Date().toISOString();
    this.nextVerifyAt = new Date(Date.now() + this._heartbeatIntervalMs()).toISOString();
    this.lastVerifyError = conciseAutomationError(error);
  }

  _deferBusyLogin(error) {
    this.manualLoginRequired = false;
    if (this.accountPreparationState === 'human_required') this.accountPreparationState = 'retry_pending';
    this.accountPreparationError = '';
    this.sessionRecoveryState = 'retry_pending';
    const seconds = Math.min(900, 60 * 2 ** Math.min(this.loginBusyAttempts++, 4));
    this.sessionRecoveryAfterMs = Date.now() + seconds * 1000;
    this._markLoginProblem(error, 'unknown');
    this.log(`登入忙碌｜${seconds} 秒後背景重試；不清除憑證、不操作購物車。`);
    void this._persistLoginRecovery();
    this._scheduleHeartbeat(seconds * 1000);
  }

  async _closeBusyLoginForRetry(error, context) {
    // A busy rejection is not an interactive challenge. Release only this
    // login attempt before arming the heartbeat; never leave its own guard
    // blocking the retry it just scheduled.
    if (this.interactiveLogin?.context === context) await this._closeInteractiveLogin();
    else await context.close().catch(() => {});
    if (this.loginBrowserContext === context) this.loginBrowserContext = null;
    this._deferBusyLogin(error);
    await this.loginRecoverySaveQueue;
    return { ok: false, pending: false, retryScheduled: true,
      nextRetryAt: new Date(this.sessionRecoveryAfterMs).toISOString(),
      message: this.lastVerifyError + '；本次登入視窗已關閉，冷卻後自動背景重試，不需手動按登入。' };
  }

  async _withAccountLock(work) {
    const previous = this.accountTail;
    let release;
    this.accountTail = new Promise((resolve) => { release = resolve; });
    await previous;
    this.accountBusy += 1;
    try {
      return await work();
    } finally {
      this.accountBusy = Math.max(0, this.accountBusy - 1);
      release();
    }
  }

  async importBrowserSession(storageState) {
    if (this.accountBusy || this.sessionVerifyRunning || this.activePurchaseHold()) {
      throw esliteApiError('本帳號正在執行或有待核對訂單，暫不能同步登入', 'account_not_ready');
    }
    return this._withAccountLock(async () => {
      const account = this.getCredentials().account;
      if (!account) throw esliteApiError('本帳號尚未設定，不能同步登入', 'needs_setup');
      const candidate = normalizeEsliteBrowserSession(storageState);
      const existing = await fs.readFile(this.sessionFile, 'utf8').then(JSON.parse).catch(() => null);
      if (esliteTokenExpiryMs(readEsliteAuthToken(existing)) > candidate.expiresAtMs) {
        throw esliteApiError('軟體已有較新的登入憑證，不以較舊瀏覽器狀態覆蓋', 'unknown');
      }
      const verified = await verifyEsliteStorageState(candidate.state, { requestFactory: this.loginRequestFactory,
        timeoutMs: 8000, expectedAccount: account });
      if (!verified.ok || verified.loggedIn !== true) {
        throw esliteApiError(verified.reason || '會員 API 未確認同一帳號，未覆寫登入資料', 'unknown');
      }
      if (this.getCredentials().account !== account || this.activePurchaseHold()) throw esliteApiError('帳號設定／任務已變更，未覆寫登入', 'account_not_ready');
      // Stop the old private-window watcher before it can overwrite the new
      // file. The ordinary Chrome tab is not owned by this adapter or closed.
      await this._closeInteractiveLogin();
      await saveEsliteBrowserSession(this.sessionFile, candidate.state);
      await this._disposeApiContext();
      this.lastTokenExpiresAtMs = candidate.expiresAtMs;
      this.lastBrowserSessionImportedAt = new Date().toISOString();
      await fs.writeFile(`${this.sessionFile}.browser-import-meta.json`, JSON.stringify({ version: 1, importedAt: this.lastBrowserSessionImportedAt }), 'utf8');
      this.sessionRecoveryAfterMs = 0; this.proactiveRenewalAttemptedExpiryMs = 0;
      this._markLoginReady();
      await this.loginRecoverySaveQueue;
      this.lastHeartbeatResult = '普通 Chrome 登入已同步，會員 API 與帳號身分已確認';
      if (this.sessionHeartbeatEnabled) this._scheduleHeartbeat();
      this.log('普通 Chrome 登入同步成功；只更新本帳號登入資料，未清車、未加車、未送單。');
      return { ok: true, loggedIn: true, accountSlot: this.accountSlot, expiresAt: new Date(candidate.expiresAtMs).toISOString(),
        message: `誠品帳號 ${this.accountSlot} 已同步普通 Chrome 登入；會員 API 200 與帳號身分核對成功，未清車／送單。` };
    });
  }

  scheduleAccountPreparation({ payment } = {}) {
    this.preparationRequested = { payment };
    this.accountPreparationState = 'queued';
    if (this.preparationJob) return this.preparationJob;
    this.preparationJob = Promise.resolve().then(async () => {
      while (this.preparationRequested) {
        const requested = this.preparationRequested;
        this.preparationRequested = null;
        await this.prepareAccount(requested);
      }
    }).finally(() => { this.preparationJob = null; });
    return this.preparationJob;
  }

  async prepareAccount({ payment } = {}) {
    return this._withAccountLock(async () => {
      this.accountPreparationState = 'running';
      this.accountPreparationLastAttemptMs = Date.now();
      this.accountPreparationError = '';
      const expectedCredentials = { ...this.getCredentials() };
      try {
        const pickupSetup = this.getPickupSetup?.();
        if (!expectedCredentials.account || !expectedCredentials.password) throw esliteApiError('請先填寫帳號與密碼', 'needs_setup');
        const login = await this._testLogin({ interactive: false });
        if (!login.ok) throw esliteApiError(login.message || '登入尚未確認', this.manualLoginRequired ? 'human_required'
          : this.loginState === 'needs_login' ? 'needs_login' : 'unknown');
        const result = await this.accountSetupRunner({ api: await this._ensureApiContext(),
          expectedAccount: expectedCredentials.account, payment,
          deliveryProfile: this.getDeliveryProfile(), pickupProfile: this.getPickupProfile(),
          pickupUnavailable: Boolean(this.getPickupSetup && !pickupSetup),
          existingTemplate: pickupSetup?.recipient && payment === 'seven_cod'
            ? { paymentMode: payment, checkout: { ...(this.getCheckoutTemplate()?.paymentMode === payment ? this.getCheckoutTemplate().checkout : {}), recipient: pickupSetup.recipient } }
            : this.getCheckoutTemplate(),
          onMember: profile => this.onMemberIdentified(profile, { expectedCredentials }) });
        const current = this.getCredentials();
        if (current.account !== expectedCredentials.account || current.password !== expectedCredentials.password) throw esliteApiError('帳密已變更，忽略舊的辨識結果', 'needs_setup');
        await this.onAccountPrepared(result.checkoutTemplate, { payment: result.checkoutTemplate.paymentMode || payment, requestedPayment: payment, expectedCredentials });
        if (result.checkoutTemplate.paymentFallback) this.log('7-11 取貨資料不可用 → 共用宅配資料核對完成 → 本次使用宅配 ATM 備援；原設定不變。');
        this.apiCartKnownEmpty = result.cartEmpty === true;
        this.apiReadyAtMs = this.apiCartKnownEmpty ? Date.now() : 0;
        this._markLoginReady();
        this.accountPreparedAt = new Date().toISOString();
        this.accountPreparationState = result.cartEmpty ? 'ready' : 'cart_not_empty';
        this.log(result.cartEmpty ? '會員與配送資料已自動辨識，加密保存；未加車、未送單。'
          : '會員與配送資料已保存；購物車有既有商品，未清除、未送單。');
        return { ok: true, cartEmpty: result.cartEmpty };
      } catch (error) {
        this.accountPreparationState = error.purchaseStatus === 'human_required' ? 'human_required'
          : error.purchaseStatus === 'needs_setup' ? 'incomplete' : 'retry_pending';
        this.accountPreparationError = purchaseErrorSummary(error);
        this.log('資料辨識尚未完成｜' + this.accountPreparationError);
        return { ok: false, reason: this.accountPreparationError };
      }
    });
  }

  async setWarmPoolEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.sessionHeartbeatEnabled === next) return;
    this.sessionHeartbeatEnabled = next;
    if (this.sessionHeartbeatTimer) clearInterval(this.sessionHeartbeatTimer);
    if (this.sessionHeartbeatStartupTimer) clearTimeout(this.sessionHeartbeatStartupTimer);
    this.sessionHeartbeatTimer = null;
    this.sessionHeartbeatStartupTimer = null;
    if (!next) {
      this.heartbeatAcceleratedUntilMs = 0;
      this.nextVerifyAt = '';
      this.lastHeartbeatResult = '監控或自動下單未啟用，心跳休眠';
      await this._disposeApiContext();
      return;
    }
    const laneIndex = Math.max(0, esliteSlotIndex(this.accountSlot));
    const startupDelayMs = 2500 + (laneIndex * ESLITE_SESSION_HEARTBEAT_LANE_GAP_MS);
    this.nextVerifyAt = new Date(Date.now() + startupDelayMs).toISOString();
    this.sessionHeartbeatStartupTimer = setTimeout(async () => {
      this.sessionHeartbeatStartupTimer = null;
      if (!this.sessionHeartbeatEnabled) return;
      await this.verifyStoredSession({ source: 'heartbeat' }).catch(() => {});
      if (this.sessionHeartbeatEnabled) this._scheduleHeartbeat();
    }, startupDelayMs);
    this.sessionHeartbeatStartupTimer.unref?.();
  }

  async verifyStoredSession({ source = 'manual', loginOnly = false } = {}) {
    await this.localSessionLoad;
    if (this.sessionVerifyRunning || this.accountBusy || this.interactiveLogin || this.accountBrowser) {
      return { ok: false, skipped: true, reason: this.interactiveLogin ? 'interactive_login' : 'busy' };
    }
    const { account, password } = this.getCredentials();
    if (!account || !password) return { ok: false, skipped: true, reason: 'credentials_missing' };
    this.sessionVerifyRunning = true;
    const previousAccountWork = this.accountTail;
    let releaseAccount;
    this.accountTail = new Promise((resolve) => { releaseAccount = resolve; });
    await previousAccountWork;
    this.accountBusy += 1;
    const previousLoginState = this.loginState;
    this.loginState = 'checking';
    try {
      // Heartbeat reads the same saved account token through Eslite's own member
      // API. Only expiry recovery may use a headless ordinary login; it never
      // opens a foreground window or solves a verification challenge.
      let result = this.customApiSessionVerifier || loginOnly
        ? await this.apiSessionVerifier(this.sessionFile)
        : await this.apiMaintenanceRunner(this.sessionFile, {
          clearCart: false,
          expectedAccount: this.verifyAccountIdentity ? this.getCredentials().account : undefined,
          apiContext: await this._ensureApiContext(),
          timeoutMs: 2500
        });
      if ((!this.apiOnly || this.autoLoginEnabled) && !this.customApiSessionVerifier && this.lastTokenExpiresAtMs > Date.now()
        && this.lastTokenExpiresAtMs - Date.now() <= ESLITE_SESSION_RENEW_AHEAD_MS
        && this.proactiveRenewalAttemptedExpiryMs !== this.lastTokenExpiresAtMs && !this.manualLoginRequired
        && Date.now() >= this.sessionRecoveryAfterMs) {
        this.proactiveRenewalAttemptedExpiryMs = this.lastTokenExpiresAtMs;
        const workingExpiry = this.lastTokenExpiresAtMs;
        try {
          result = await this._recoverApiSession({ renewAfterExpiryMs: workingExpiry });
        } catch (error) {
          // A proactive renewal failure is not proof the existing token expired.
          if (workingExpiry <= Date.now()) throw error;
          this.lastTokenExpiresAtMs = workingExpiry;
          this._alertSessionProblem(error);
          this.log('提前更新尚未完成；原憑證仍有效，保留已確認登入狀態。');
        }
      }
      if (result.loggedIn === false) {
        throw esliteApiError(result.reason || '誠品登入已失效，請重新完成官方登入驗證', 'needs_login');
      }
      if (result.loggedIn !== true) throw new Error(result.reason || '誠品會員 API 沒有足夠證據確認登入，保留原狀態並稍後重試');
      if (!this.customApiSessionVerifier && !loginOnly) {
        if (result.cartEmpty !== null) this.apiCartKnownEmpty = result.cartEmpty === true;
        this.apiReadyAtMs = Date.now();
      }
      this._markLoginReady({ keepRecoveryProblem: this.proactiveRenewalAttemptedExpiryMs === this.lastTokenExpiresAtMs
        && ['manual_required', 'retry_pending'].includes(this.sessionRecoveryState) });
      this.lastHeartbeatResult = `登入正常（API ${result.durationMs || 0}ms）`;
      return { ok: true, loggedIn: true, durationMs: result.durationMs || 0 };
    } catch (error) {
      if (error?.purchaseStatus === 'needs_login' || /登入憑證已到期|登入已失效/.test(String(error?.message || ''))) {
        if ((!this.apiOnly || this.autoLoginEnabled) && !this.customApiSessionVerifier && Date.now() >= this.sessionRecoveryAfterMs) {
          try {
            const recovered = await this._recoverApiSession();
            this._markLoginReady();
            this.lastHeartbeatResult = '背景登入恢復成功，會員 API 已確認';
            return { ok: true, loggedIn: true, recovered: true, durationMs: recovered.durationMs || 0 };
          } catch (recoveryError) { error = recoveryError; }
        }
        this.sessionRecoveryState = error.purchaseStatus === 'human_required' || this.manualLoginRequired ? 'manual_required'
          : this.autoLoginEnabled ? 'retry_pending' : 'needs_attention';
        this._markLoginProblem(error, ['unknown', 'login_busy'].includes(error.purchaseStatus) ? 'unknown' : 'needs_login');
        this.lastHeartbeatResult = conciseAutomationError(error);
        await this._disposeApiContext();
        if (!this.autoLoginEnabled || error.purchaseStatus === 'human_required') this._alertSessionProblem(error);
        return { ok: false, loggedIn: ['unknown', 'login_busy'].includes(error.purchaseStatus) ? null : false, reason: conciseAutomationError(error) };
      }
      // A blocked headless probe is not proof of logout. Keep it distinct from
      // needs_login so the purchase path can still verify with the trusted UI profile.
      if (this.loginState !== 'needs_login') {
        this.loginState = previousLoginState === 'ready' ? 'ready' : 'unknown';
        this.nextVerifyAt = new Date(Date.now() + this._heartbeatIntervalMs()).toISOString();
        this.lastVerifyError = conciseAutomationError(error);
      }
      this.heartbeatFailures += 1;
      this.lastHeartbeatResult = conciseAutomationError(error);
      return { ok: false, loggedIn: null, reason: conciseAutomationError(error) };
    } finally {
      if (source === 'heartbeat' || source === 'manual') {
        this.heartbeatChecks += 1;
        this.lastHeartbeatAt = new Date().toISOString();
      }
      this.sessionVerifyRunning = false;
      this.accountBusy = Math.max(0, this.accountBusy - 1);
      releaseAccount();
    }
  }

  async _loggedIn(page) {
    if (!page || page.isClosed() || /\/login(?:[/?#]|$)/i.test(page.url())) return false;
    if (await firstVisible(page, [
      'input[type="password"]', 'input[autocomplete="current-password"]'
    ])) return false;
    if (await anyPresent(page, [
      'a[href*="logout" i]', 'button:has-text("登出")', 'a:has-text("登出")'
    ])) return true;
    if (await firstVisible(page, [
      'a[href="/login"]', 'a:has-text("登入")', 'button:has-text("登入")'
    ])) return false;
    // Eslite's current member shell may render account navigation through
    // client-side buttons without a stable logout/member anchor. Reaching the
    // protected /member route without a login redirect, password field, or
    // visible login action is itself positive session evidence.
    if (/\/member(?:[/?#]|$)/i.test(page.url())) return true;
    return await anyPresent(page, [
      'a[href="/member"]', 'a[href^="/member/"]',
      'a[href="/cart/step1"]', 'a[href^="/cart"]'
    ]);
  }

  async _recordLoginDiagnostic(page, state, stage, interactive, authReply = null, authCleanup = null) {
    const diagnostic = { at: new Date().toISOString(), accountSlot: this.accountSlot,
      stage, mode: interactive ? 'visible' : 'background', status: state.status,
      signal: state.signal || 'page_text', message: state.message,
      ...(authReply ? {authReply} : {}),...(authCleanup ? {authCleanup} : {}) };
    this.log(`登入判讀｜${stage}｜${diagnostic.mode}｜${diagnostic.status}｜${diagnostic.signal}`);
    try {
      const directory = path.join(this.dataDir, 'diagnostics');
      await fs.mkdir(directory, { recursive: true });
      const base = path.join(directory, `eslite-login-${this.accountSlot}-latest`);
      await fs.writeFile(base + '.json', JSON.stringify(diagnostic, null, 2));
      if (typeof page.screenshot === 'function') await page.screenshot({ path: base + '.png', fullPage: false,
        mask: [page.locator('input[type="password"], input[autocomplete="current-password"]')] });
    } catch { /* Diagnostics must not alter authentication or hide its result. */ }
  }

  async _login(page, context, { interactive = false, manualOnly = false, renewAfterExpiryMs = 0 } = {}) {
    const { account, password } = this.getCredentials();
    if (!account || !password) throw esliteApiError('尚未儲存誠品帳密', 'needs_setup');
    this.loginState = 'checking';
    const saveIfValid = async () => {
      try { await this._validateBrowserLoginApi(page); }
      catch (error) { if (error.purchaseStatus === 'needs_login') return false; throw error; }
      if (renewAfterExpiryMs && this.lastTokenExpiresAtMs <= renewAfterExpiryMs) return false;
      await context.storageState({ path: this.sessionFile, indexedDB: true });
      this._markLoginReady();
      return true;
    };
    // Never navigate, log out, or send credentials when the existing API token works.
    if (await saveIfValid()) return true;
    const previousExpiry = this.lastTokenExpiresAtMs;
    let authDiagnostic = null;
    let authCleanup=null,cleanupMarker='';
    if(!renewAfterExpiryMs){
      cleanupMarker='eslite-expired-auth-'+crypto.randomUUID();
      const prepared=await prepareExpiredEsliteAuthBeforeNavigation({page,context,marker:cleanupMarker});
      authCleanup={cookiesRemoved:prepared.cookies,localScriptArmed:prepared.localCleanupArmed,localEntriesRemoved:null,preservedValidToken:prepared.preservedValidToken};
      if(prepared.cookies||prepared.localCleanupArmed)this.log(`首次開啟登入頁前：已移除 ${prepared.cookies} 個確認過期的登入 Cookie${prepared.localCleanupArmed?'；本頁將於官網腳本前核對並清除過期登入儲存':''}。安全驗證資料、有效憑證與購物車保留。`);
    }
    await page.goto('https://www.eslite.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
    if(authCleanup?.localScriptArmed){
      try{
        const count=await page.evaluate(marker=>{if(location.origin!=='https://www.eslite.com')return null;const raw=sessionStorage.getItem(marker);return raw===null?null:Number(raw);},cleanupMarker);
        if(Number.isInteger(count)&&count>=0&&count<=6)authCleanup.localEntriesRemoved=count;
      }catch{ /* A navigation failure is not proof that local cleanup ran. */ }
      this.log(authCleanup.localEntriesRemoved===null?'首次登入頁初始化：尚未確認本頁儲存清理執行，未宣稱已清除。':`首次登入頁初始化：已核對並移除 ${authCleanup.localEntriesRemoved} 項過期登入儲存，未清購物或安全驗證資料。`);
    }
    const checkChallenge = async (stage) => {
      const state = await readEsliteLoginState(page);
      if (state.status !== 'unknown') {
        await this._recordLoginDiagnostic(page, state, stage, interactive, authDiagnostic,authCleanup);
        const detail=authDiagnostic ? `（HTTP ${authDiagnostic.httpStatus ?? '未知'}；${({verification_message:'API 回覆提及驗證',credentials_message:'API 回覆提及帳密',account_status_message:'API 回覆提及帳號狀態',busy_message:'API 回覆忙碌',unknown:'API 未明確說明原因'})[authDiagnostic.reasonHint]}）` : '';
        throw esliteApiError(state.message+detail, state.status);
      }
      return state;
    };
    await checkChallenge('開啟登入頁');
    if (await saveIfValid()) return true;
    if (renewAfterExpiryMs) throw esliteApiError('官方前端未自動更新登入憑證；不登出、不提交帳密，保留原 API 登入', 'unknown');
    // Both probes above returned needs_login (expired/missing token or an
    // explicit member 401). Do NOT execute this on a busy/blocked/unknown probe.
    const cleared = await clearInvalidEsliteAuth({ page, context, confirmedInvalid: true });
    if (cleared.cookies || cleared.entries) {
      this.log('登入憑證已確認失效：已清除本帳號舊登入 Cookie／token；保留網站安全驗證資料、購物車與訂單。');
      await page.goto('https://www.eslite.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await checkChallenge('移除失效登入資料後');
    }
    // A stale member shell can redirect /login despite an expired API token.
    // Use the official logout control once; do not manufacture or modify tokens.
    if (!/\/login(?:[/?#]|$)/i.test(page.url())) {
      const logout = await firstVisible(page, ['button:has-text("登出")', 'a:has-text("登出")']);
      if (logout) await logout.click({ timeout: 5000 });
      await page.goto('https://www.eslite.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
    }
    await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await checkChallenge('讀取登入表單');
    const userFilled = await fillFirst(page, [
      'input[placeholder="台灣手機/會員卡號/自訂帳號"]', 'input[aria-label="台灣手機/會員卡號/自訂帳號"]',
      'input[placeholder*="手機"]', 'input[autocomplete="username"]', 'input[type="text"]'
    ], account);
    const passwordFilled = await fillFirst(page, ['input[placeholder*="密碼"]', 'input[type="password"]'], password);
    if (!userFilled || !passwordFilled) throw esliteApiError('登入表單尚未載入，稍後再試；未送出帳密', 'unknown');
    // A fresh page without a challenge must not inherit a stale manual-only flag.
    this.manualLoginRequired = false;
    if (this.accountPreparationState === 'human_required') {
      this.accountPreparationState = 'retry_pending';
      this.accountPreparationError = '';
    }
    if (interactive && (!this.autoLoginEnabled || manualOnly)) {
      this.sessionRecoveryState = 'interactive';
      throw esliteApiError('帳號密碼已預填；請自行按登入，程式不自動送出', 'needs_login');
    }
    const submit = await firstVisible(page, ['button:has-text("登入")', 'button[type="submit"]', 'input[type="submit"]']);
    if (!submit) throw esliteApiError('登入按鈕尚未載入，未送出帳密', 'unknown');
    await checkChallenge('送出前核對驗證服務');
    this.log('自動登入：官方表單送出一次；等待 API 確認，不操作購物車。');
    this.loginAttemptSubmitted = true;
    let authReply = null;
    const observeReply = response => {
      try {
        const url = new URL(response.url());
        if (url.hostname === 'athena.eslite.com' && response.request().method() === 'POST'
          && /login|auth|session|sign.?in|token/i.test(url.pathname)) authReply = response;
      } catch { /* Only record first-party authentication replies. */ }
    };
    page.on?.('response', observeReply);
    try {
    await submit.click({ timeout: 5000 });
    // Wait for the site's own auth plugin to issue a new JWT. No challenge solving.
    await page.waitForFunction((oldExpiry) => {
      const raw = localStorage.getItem('auth._token.prd') || '';
      try { return JSON.parse(atob(raw.replace(/^Bearer /i, '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 > Math.max(oldExpiry || 0, Date.now()); }
      catch { return false; }
    }, previousExpiry, { timeout: 12000 }).catch(() => {});
    if (await saveIfValid()) return true;
    // Read the already received first-party response; never replay a login.
    // Capture this BEFORE the busy modal short-circuits failure handling.
    if(authReply){
      let timer;
      try {
        const body=await Promise.race([Promise.resolve().then(()=>authReply.json()).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),2000);})]);
        authDiagnostic=summarizeEsliteAuthReply({url:authReply.url(),method:authReply.request().method(),httpStatus:authReply.status(),body});
        if(authDiagnostic)this.log(`登入 API 回應｜HTTP ${authDiagnostic.httpStatus}｜${authDiagnostic.endpoint}｜${authDiagnostic.reasonHint}`);
      } catch { /* Diagnostics must not replace the actual login result. */ }
      finally {clearTimeout(timer);}
    }
    await checkChallenge('登入送出後');
    if (authReply) {
      const state = classifyEsliteLogin({ httpStatus: authReply.status() });
      this.log(`登入回應｜HTTP ${authReply.status()}｜${state.status === 'unknown' ? '待 API 確認' : state.message}`);
      if (state.status !== 'unknown') { await this._recordLoginDiagnostic(page,state,'登入 API 拒絕',interactive,authDiagnostic,authCleanup);throw esliteApiError(state.message,state.status); }
    }
    await this._recordLoginDiagnostic(page,{status:'unknown',signal:'auth_reply_unconfirmed',message:'登入送出後尚未取得有效 API 憑證'},'登入送出後',interactive,authDiagnostic,authCleanup);
    throw esliteApiError('登入送出後尚未取得有效 API 憑證；稍後再查，不重複送出', 'unknown');
    } finally { page.off?.('response', observeReply); }
  }

  async testLogin(options = {}) {
    return this._withAccountLock(() => this._testLogin(options));
  }

  async _testLogin({ interactive = true, manualOnly = false } = {}) {
    if (this.accountBrowser) throw esliteApiError('此帳號瀏覽器已開啟，請先關閉後再更新登入', 'account_not_ready');
    await this.localSessionLoad;
    if (manualOnly && !interactive) throw esliteApiError('手動登入必須使用可見的專用視窗', 'needs_setup');
    if (manualOnly && this.interactiveLogin) return this.completeLogin();
    if (this.autoLoginEnabled && !manualOnly) {
      if (this.interactiveLogin) return this.completeLogin();
      const stored = await this.apiSessionVerifier(this.sessionFile);
      if (stored.ok && stored.loggedIn === true) {
        this._markLoginReady(); this.sessionRecoveryState = 'idle'; this.manualLoginRequired = false;
        return { ok: true, message: `會員 API 已確認登入（${stored.durationMs || 0}ms）；未開啟網頁、未送出帳密。` };
      }
      if (stored.loggedIn !== false) {
        this._markLoginProblem(esliteApiError(stored.reason || '會員 API 暫時無法確認', 'unknown'), 'unknown');
        return { ok: false, pending: false, message: this.lastVerifyError };
      }
      const manualEntry = interactive && (this.manualLoginRequired || this.sessionRecoveryState === 'manual_required');
      if (manualEntry) {
        // Only an actual official verification gate needs a manual window.
        manualOnly = true;
      } else if (Date.now() < this.sessionRecoveryAfterMs) {
        const remaining = this.sessionRecoveryAfterMs - Date.now();
        this.sessionRecoveryState = 'retry_pending';
        this._scheduleHeartbeat(remaining);
        return { ok: false, pending: false, retryScheduled: true,
          nextRetryAt: new Date(this.sessionRecoveryAfterMs).toISOString(),
          message: `自動登入冷卻中，${Math.ceil(remaining / 1000)} 秒後背景自動重試；不需手動按登入。` };
      } else {
        try {
          await this._recoverApiSession(); this._markLoginReady();
          return { ok: true, message: '背景自動登入完成，已由會員 API 驗證並保存；未操作購物車。' };
        } catch (error) {
          if (error.purchaseStatus !== 'human_required' || !interactive) {
            this._markLoginProblem(error, ['unknown', 'login_busy'].includes(error.purchaseStatus) ? 'unknown' : 'needs_login');
            return { ok: false, pending: false, message: conciseAutomationError(error) };
          }
          // Only an actual official challenge/block opens a foreground window.
        }
      }
    }
    await this._closeInteractiveLogin();
    const context = this.autoLoginEnabled ? await this._loginContext(!interactive)
      : await this._context(this.sessionFile, { headless: !interactive });
    const page = await context.newPage();
    try {
      await this._login(page, context, { interactive, manualOnly });
      await this._validateBrowserLoginApi(page);
      await context.close();
      await this._disposeApiContext();
      this._markLoginReady();
      this.sessionRecoveryState = 'idle';
      return { ok: true, message: '誠品會員 API 已確認登入成功，私人 session 已儲存。' };
    } catch (error) {
      // A closed window is neither an official refusal nor proof that the
      // previous challenge was resolved. Keep that gate until a fresh page or
      // a valid member API result proves otherwise; do not restart headless.
      if (page.isClosed?.() || /Target page, context or browser has been closed/i.test(error.message || '')) {
        await context.close().catch(() => {});
        if (this.loginBrowserContext === context) this.loginBrowserContext = null;
        if (this.sessionRecoveryState === 'manual_required') this.manualLoginRequired = true;
        this._markLoginProblem(esliteApiError('登入視窗已關閉，未取得新憑證；請重新開啟此帳號登入視窗', 'needs_login'), 'needs_login');
        await this._persistLoginRecovery();
        return { ok: false, pending: false, message: this.lastVerifyError };
      }
      if (error.purchaseStatus === 'login_busy') {
        if (this.autoLoginEnabled) return this._closeBusyLoginForRetry(error, context);
        this._deferBusyLogin(error);
        if (!interactive) {
          await context.close().catch(() => {});
          return { ok: false, pending: false, message: this.lastVerifyError + '；已安排背景重試。' };
        }
      }
      if (interactive) {
        this._markLoginProblem(error, ['unknown', 'login_busy'].includes(error.purchaseStatus) ? 'unknown'
          : /登入|驗證|密碼/.test(error.message) ? 'needs_login' : 'unknown');
        this.manualLoginRequired = error.purchaseStatus === 'human_required';
        if (this.manualLoginRequired) this.sessionRecoveryState = 'manual_required';
        if (manualOnly && !this.manualLoginRequired) this.sessionRecoveryState = 'interactive';
        await this._persistLoginRecovery();
        return this._keepInteractiveLogin({
          context, page, sessionFile: this.sessionFile, label: '誠品', error,
          keepOnBusy: !this.autoLoginEnabled,
          watchSameUrl: true, checkIntervalMs: 10000,
          validate: async (targetPage) => {
            try { await this._validateBrowserLoginApi(targetPage); return true; }
            catch (cause) {
              const session = this.interactiveLogin;
              if (session?.page !== targetPage) return false;
              const state = await readEsliteLoginState(targetPage);
              if (this.interactiveLogin !== session) return false;
              if (state.status === 'login_busy' && this.autoLoginEnabled) {
                await this._closeBusyLoginForRetry(esliteApiError(state.message, 'login_busy'), context);
                return false;
              }
              if (state.status === 'human_required') {
                this.manualLoginRequired = true; this.sessionRecoveryState = 'manual_required';
                await this._persistLoginRecovery();
              }
              throw cause;
            }
          },
          onValidated: async () => { await this._disposeApiContext(); this.sessionRecoveryState = 'idle'; this.manualLoginRequired = false; this._markLoginReady(); },
          onAfterClose: () => this.onLoginValidated()
        });
      }
      this._markLoginProblem(error, /登入|驗證/.test(error.message) ? 'needs_login' : 'error');
      if (error.purchaseStatus === 'human_required') {
        this.manualLoginRequired = true;
        this.sessionRecoveryState = 'manual_required';
        await this._persistLoginRecovery();
      }
      await context.close();
      throw error;
    }
  }

  async completeLogin() {
    let validationError;
    const result = await this._completeInteractiveLogin({
      label: '誠品',
      successMessage: '誠品會員 API 已確認登入成功，私人 session 已儲存。',
      validate: async (page) => {
        try { await this._validateBrowserLoginApi(page); return true; }
        catch (error) { validationError = error; throw error; }
      }
    });
    if (result.ok) {
      await this._disposeApiContext();
      this.sessionRecoveryState = 'idle';
      this.manualLoginRequired = false;
      this._markLoginReady();
    }
    else {
      const session = this.interactiveLogin;
      if (session?.page) {
        const state = await readEsliteLoginState(session.page);
        if (this.interactiveLogin !== session) return { ok: false, pending: false, message: '登入視窗已關閉或更新；未操作新的登入視窗。' };
        this.manualLoginRequired = state.status === 'human_required';
        if (!this.manualLoginRequired && this.accountPreparationState === 'human_required') {
          this.accountPreparationState = 'retry_pending';
          this.accountPreparationError = '';
        }
        if (state.status === 'login_busy') {
          if (this.autoLoginEnabled) {
            return this._closeBusyLoginForRetry(esliteApiError(state.message, 'login_busy'), session.context);
          }
          this._deferBusyLogin(esliteApiError(state.message, 'login_busy'));
          this.sessionRecoveryState = 'interactive';
          return { ok: false, pending: true, message: state.message + '；手動視窗依要求保留，關閉後才可背景重試；目前不重送登入。' };
        }
        if (state.status === 'human_required') this.sessionRecoveryState = 'manual_required';
      }
      if (validationError) result.message = `${conciseAutomationError(validationError)}；登入視窗保持開啟，未清除既有憑證。`;
      this._markLoginProblem(validationError || new Error(result.message),
        this.manualLoginRequired || validationError?.purchaseStatus === 'needs_login' ? 'needs_login' : 'unknown');
      await this._persistLoginRecovery();
    }
    return result;
  }

  async _validateBrowserLoginApi(page) {
    const context = page.context();
    const storage = await context.storageState({ indexedDB: true });
    const token = readEsliteAuthToken(storage);
    const expiry = esliteTokenExpiryMs(token);
    // A fresh/closed login tab has no token; it must not erase the expiry
    // evidence of the saved credential displayed in the dashboard.
    if (expiry) this.lastTokenExpiresAtMs = expiry;
    if (!token || (expiry && expiry <= Date.now())) {
      throw esliteApiError('畫面仍有登入資訊，但 API 憑證不存在或已過期；請在此專用視窗登出，再重新登入', 'needs_login');
    }
    const result = await verifyEsliteStorageState(storage, { requestFactory: this.loginRequestFactory, timeoutMs: 5000,
      expectedAccount: this.verifyAccountIdentity ? this.getCredentials().account : undefined });
    if (result.loggedIn === false) throw esliteApiError(result.status === 401 ? '會員 API 回覆 401；需更新登入憑證' : result.reason, 'needs_login');
    if (!result.ok) throw esliteApiError(result.reason || '會員 API 尚未確認登入', 'unknown');
    return true;
  }

  async _readCartSnapshot(page, product) {
    return page.evaluate(({ expectedUrl, expectedId }) => {
      const normalizedPath = (value) => {
        try { return new URL(value, location.origin).pathname.replace(/\/$/, '').toLowerCase(); }
        catch { return ''; }
      };
      const expectedPath = normalizedPath(expectedUrl);
      const expectedToken = String(expectedId || '').trim().toLowerCase();
      const anchors = [...document.querySelectorAll('a[href*="/product/"]')];
      const rows = [];
      for (const anchor of anchors) {
        let node = anchor;
        let cartRow = null;
        for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
          const className = String(node.className || '');
          const text = String(node.textContent || '');
          const hasQuantity = Boolean(node.querySelector?.('input[type="number"], select, [data-quantity]'));
          const hasRemove = /刪除|移除/.test(text);
          if (/cart[-_ ]?(?:item|product)|shopping[-_ ]?item/i.test(className) || hasQuantity || hasRemove) {
            cartRow = node;
            break;
          }
        }
        if (!cartRow) continue;
        const url = new URL(anchor.getAttribute('href'), location.origin).href;
        const rowPath = normalizedPath(url);
        const quantityControl = cartRow.querySelector('input[type="number"], select, [data-quantity]');
        const rawQuantity = quantityControl?.value
          || quantityControl?.getAttribute?.('data-quantity')
          || String(cartRow.textContent || '').match(/數量\s*[:：xX]?\s*(\d+)/)?.[1]
          || '';
        const parsedQuantity = Number.parseInt(rawQuantity, 10);
        rows.push({
          url,
          path: rowPath,
          text: String(anchor.textContent || cartRow.textContent || '').replace(/\s+/g, ' ').trim(),
          quantity: Number.isFinite(parsedQuantity) ? parsedQuantity : null
        });
      }
      const unique = [...new Map(rows.map((row) => [row.path || row.url, row])).values()];
      const expected = unique.find((row) => row.path === expectedPath
        || (expectedToken && (row.path.includes(expectedToken) || row.text.toLowerCase().includes(expectedToken))));
      return {
        expectedPresent: Boolean(expected),
        expectedQuantity: expected?.quantity ?? null,
        itemUrls: unique.map((row) => row.url),
        itemCount: unique.length
      };
    }, { expectedUrl: product.url, expectedId: product.id });
  }

  async _verifyOwnCart(page, product, quantity) {
    const snapshot = await this._readCartSnapshot(page, product);
    if (!snapshot.expectedPresent) {
      const error = new Error('誠品購物車沒有剛加入的指定商品，已停止結帳');
      error.purchaseStatus = 'cart_conflict';
      throw error;
    }
    if (snapshot.itemCount !== 1) {
      const error = new Error(`誠品購物車混入其他商品（目前辨識 ${snapshot.itemCount} 款），已停止結帳`);
      error.purchaseStatus = 'cart_conflict';
      throw error;
    }
    if (snapshot.expectedQuantity !== null && snapshot.expectedQuantity !== quantity) {
      const error = new Error(`誠品購物車數量不符（預期 ${quantity}，實際 ${snapshot.expectedQuantity}），已停止結帳`);
      error.purchaseStatus = 'cart_conflict';
      throw error;
    }
    return snapshot;
  }

  async maintainSession(options = {}) {
    if (this.accountBrowser) return { ok: false, skipped: true, reason: '帳號瀏覽器使用中' };
    options = { clearCart: false, ...options };
    return this._withAccountLock(async () => {
      try {
        if (this.activePurchaseHold() && options.clearCart !== false) throw esliteApiError('此帳號有結果不明訂單，禁止心跳清車；請先人工核對訂單', 'submitted_unconfirmed');
        const result = await this.apiMaintenanceRunner(this.sessionFile, {
          ...options,
          expectedAccount: this.verifyAccountIdentity ? this.getCredentials().account : undefined,
          apiContext: await this._ensureApiContext()
        });
        if (result.ok) {
          this.apiCartKnownEmpty = options.clearCart === false ? this.apiCartKnownEmpty : result.cartEmpty === true;
          this.apiReadyAtMs = this.apiCartKnownEmpty ? Date.now() : 0;
          this._markLoginReady();
        }
        return result;
      } catch (error) {
        this._resetApiReadiness();
        if (error?.purchaseStatus === 'needs_login') await this._disposeApiContext();
        if (error?.purchaseStatus === 'needs_login') this._markLoginProblem(error, 'needs_login');
        else this.lastVerifyError = purchaseErrorSummary(error);
        if (error?.purchaseStatus === 'needs_login') this._alertSessionProblem(error);
        throw error;
      }
    });
  }

  async close() {
    this.sessionHeartbeatEnabled = false;
    this.heartbeatAcceleratedUntilMs = 0;
    if (this.sessionHeartbeatTimer) clearInterval(this.sessionHeartbeatTimer);
    if (this.sessionHeartbeatStartupTimer) clearTimeout(this.sessionHeartbeatStartupTimer);
    this.sessionHeartbeatTimer = null;
    this.sessionHeartbeatStartupTimer = null;
    await this.loginBrowserContext?.close().catch(() => {});
    this.loginBrowserContext = null;
    await this._disposeApiContext();
    await super.close();
    await this.loginRecoverySaveQueue;
  }

  async purchase(product, settings) {
    return this._withAccountLock(async () => {
      if (this.accountBrowser || this.cartActionUncertain) throw esliteApiError('帳號瀏覽器使用中或清車待確認，未加車、未送單', 'account_not_ready');
      await this.localSessionLoad;
      const transactionDeadlineAt = Number(settings.apiDeadlineAt) || Date.now() + ESLITE_API_ORDER_WINDOW_MS;
      const preparationSteps = [];
      const preparationStartedAt = Date.now();
      const transactionStartedAt = new Date(preparationStartedAt).toISOString();
      const progress = (label, state, reason = '') => {
        const step = safePurchaseStep({ at: new Date().toISOString(), label, state, reason, elapsedMs: Date.now() - preparationStartedAt });
        preparationSteps.push(step);
        this.log(`誠品下單｜${product.id}｜${label}${reason ? `｜${purchaseErrorSummary(reason)}` : ''}`);
        if (state==='failed' || !/待命狀態確認|API 快線準備|會員與空車確認/.test(label)) {
          try { Promise.resolve(settings.onStep?.(step)).catch(() => {}); } catch {}
        }
      };
      const hold = this.activePurchaseHold();
      if (hold) throw esliteApiError(`誠品帳號有待確認訂單（商品 ${hold.productId}），禁止改買或清車；請先人工核對`, 'account_held');
      const selection = settings.captureCheckoutTemplate ? { checkoutTemplate: this.getCheckoutTemplate(), payment: settings.payment }
        : resolveEsliteCheckoutSelection({ template: this.getCheckoutTemplate(), payment: settings.payment,
          deliveryProfile: this.getDeliveryProfile(), pickupUnavailable: Boolean(this.getPickupSetup && !this.getPickupSetup()) });
      const checkoutTemplate = selection.checkoutTemplate;
      settings = { ...settings, payment: selection.payment, requestedPayment: selection.requestedPayment || settings.payment,
        paymentFallback: selection.paymentFallback };
      if (this.apiOnly && settings.verifyOnly && !settings.captureCheckoutTemplate) {
        if (!checkoutTemplate?.checkout) throw esliteApiError('尚未保存 API 結帳範本', 'needs_setup');
        if (checkoutTemplate.paymentMode && settings.payment && checkoutTemplate.paymentMode !== settings.payment) throw esliteApiError('付款設定與 API 範本不符', 'needs_setup');
        const api = await this._ensureApiContext();
        const result = await this.apiMaintenanceRunner(this.sessionFile, { apiContext: api, clearCart: false, timeoutMs: 5000 });
        if (!result.ok || result.loggedIn !== true) throw esliteApiError('會員 API 未確認登入', 'needs_login');
        this._markLoginReady();
        return { status: 'api_verified', payment: settings.payment, requestedPayment: settings.requestedPayment, paymentFallback: settings.paymentFallback, quantity: Number(settings.quantity) || 1,
          detail: '會員 API 與本地結帳範本已確認；純讀取，沒有加車、送單，也不是成功訂單', timings: { totalMs: result.durationMs || 0 } };
      }
      if (checkoutTemplate && !settings.verifyOnly && !settings.captureCheckoutTemplate) {
        // A verified warm session starts directly with the assigned product.
        // A cold session only checks membership; neither path clears the cart.
        const sessionPrevalidated = this._apiReady();
        try {
          const remainingDeadlineMs = Math.max(0, transactionDeadlineAt - Date.now());
          if (remainingDeadlineMs <= 0) {
            throw esliteApiError('誠品 API 下單已超過安全等待期限，未送出新的訂單請求', 'deadline_exceeded');
          }
          let result = await this.apiPurchaseRunner({
            sessionFile: this.sessionFile,
            product,
            settings: { ...settings, deliveryProfile: this.getDeliveryProfile(), strictSingleProductOrder: this.apiOnly || settings.strictSingleProductOrder === true },
            checkoutTemplate,
            apiContext: await this._ensureApiContext(),
            prevalidated: sessionPrevalidated,
            log: this.log,
            onStep: settings.onStep,
            deadlineMs: remainingDeadlineMs
          });
          if (result.status === 'submitted_unconfirmed') {
            // Hand off to the coordinator ONLY after preserving this account's
            // guard. It persists the receipt before scheduling background reads.
            // No order-history request occupies the shared purchase worker here.
            this.purchaseHold = { productId: product.id, products: result.products, quantity: Number(settings.quantity) || 1, startedAt: transactionStartedAt };
            progress('送單結果不明／轉背景查單', 'unknown', '保護原帳號；不重送、不清車，釋放購買工作器給其他帳號');
          }
          if (result.status === 'ordered') {
            this._markLoginReady();
            // 誠品成功建立訂單後會消耗該購物車；保留已預熱的 HTTP 連線，
            // 同帳號下一張訂單仍可直接走兩個請求。
            this.apiCartKnownEmpty = true;
            this.apiReadyAtMs = Date.now();
          } else {
            this._resetApiReadiness();
            if (result.status === 'submitted_unconfirmed') {
              this.purchaseHold ||= { productId: product.id, quantity: Number(settings.quantity) || 1, startedAt: transactionStartedAt };
            }
          }
          return { ...result, payment: result.payment || settings.payment, requestedPayment: result.requestedPayment || settings.requestedPayment,
            paymentFallback: result.paymentFallback || settings.paymentFallback };
        } catch (error) {
          this._resetApiReadiness();
          if (error?.purchaseStatus === 'needs_login') {
            await this._disposeApiContext();
            this._markLoginProblem(error, 'needs_login');
            this._alertSessionProblem(error);
          }
          error.payment = settings.payment;
          error.requestedPayment = settings.requestedPayment;
          error.paymentFallback = settings.paymentFallback;
          throw error;
        }
      }
      if (this.apiOnly && !settings.verifyOnly && !settings.captureCheckoutTemplate) {
        throw esliteApiError('誠品尚未保存這組帳號的 API 結帳範本，已停止；正式購買不改走瀏覽器', 'needs_setup');
      }
      return this._purchaseUnlocked(product, settings);
    });
  }

  async _purchaseUnlocked(product, settings) {
    if (this.interactiveLogin) {
      throw new Error('誠品正在等待人工登入驗證，完成登入後才可開始下單');
    }
    // 誠品會對 headless Chrome 回傳 Cloudflare「Attention Required」，即使同一份
    // 專用 profile 已通過人工驗證並維持登入。下單必須沿用可見的專用 Chrome，
    // 才能使用既有信任裝置與 Cookie；通知與其他平台監控不受這個視窗影響。
    const context = await this._purchaseContext();
    let capturedCheckoutPayload = null;
    let resolveCheckoutCapture;
    const checkoutCapture = settings.captureCheckoutTemplate
      ? new Promise((resolve) => { resolveCheckoutCapture = resolve; })
      : null;
    if (settings.captureCheckoutTemplate) {
      // Diagnostic setup mode: obtain the exact first-party payload assembled by
      // Eslite's current checkout UI, but abort it inside Playwright before a
      // single byte reaches the order endpoint. This can never create an order.
      await context.route('**/api/v1/orders/checkout**', async (route) => {
        try {
          capturedCheckoutPayload = route.request().postDataJSON();
        } catch {
          capturedCheckoutPayload = null;
        }
        await route.abort('blockedbyclient').catch(() => {});
        resolveCheckoutCapture?.(capturedCheckoutPayload);
      });
    }
    const page = await context.newPage();
    const purchaseStartedAt = Date.now();
    const timings = {};
    try {
      await this._login(page, context);
      timings.loginReadyMs = Date.now() - purchaseStartedAt;
      await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      // 商品頁是 Vue 動態渲染；domcontentloaded 時購買按鈕通常尚未掛載。
      // 等待實際按鈕出現，避免把可購商品誤判成無法加入購物車。
      await page.locator('button:has-text("加入購物車"), button:has-text("直接購買")')
        .first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
      const quantity = Math.max(1, Math.min(Number(settings.quantity) || 1, product.stock || 3));
      if (quantity > 1) {
        await fillFirst(page, [
          'input[type="number"][name*="qty"]', 'input[type="number"][class*="quantity"]',
          'input[type="number"]'
        ], quantity).catch(() => false);
      }
      const addSelectors = [
        'button:has-text("加入購物車")', 'button:has-text("立即購買")',
        '[data-testid*="add-to-cart"]', '[class*="add-to-cart"]'
      ];
      let addButton = await firstVisible(page, addSelectors);
      if (!addButton || !await addButton.isEnabled()) {
        const body = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
        if (!/無法購買|已售完|售罄|缺貨|補貨中/.test(body)) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await page.locator('button:has-text("加入購物車"), button:has-text("直接購買")')
            .first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
          addButton = await firstVisible(page, addSelectors);
        }
      }
      if (!addButton || !await addButton.isEnabled()) throw new Error('誠品商品目前無法加入購物車');
      timings.productReadyMs = Date.now() - purchaseStartedAt;
      await addButton.click();
      // 誠品的購物車由背景請求非同步更新；按鈕點擊後約需 3～5 秒，
      // 若過早進入購物車，step1/step2 會短暫顯示 0 件並中斷結帳。
      const cartReady = await page.waitForFunction(() => {
        const links = [...document.querySelectorAll('a[href^="/cart"]')];
        return links.some((link) => /購物車\([1-9]\d*\)/.test(link.textContent || ''));
      }, null, { timeout: 8000 }).then(() => true).catch(() => false);
      if (!cartReady) throw new Error('誠品加入購物車後未在 8 秒內完成同步');
      timings.cartAddedMs = Date.now() - purchaseStartedAt;
      await context.storageState({ path: this.sessionFile, indexedDB: true });

      await page.goto('https://www.eslite.com/cart/step1', { waitUntil: 'domcontentloaded', timeout: 25000 });
      const expectedCartPath = new URL(product.url).pathname.replace(/\/$/, '').toLowerCase();
      await page.waitForFunction((expectedPath) => [...document.querySelectorAll('a[href*="/product/"]')]
        .some((anchor) => {
          try { return new URL(anchor.getAttribute('href'), location.origin).pathname.replace(/\/$/, '').toLowerCase() === expectedPath; }
          catch { return false; }
        }), expectedCartPath, { timeout: 12000 }).catch(() => {});
      try {
        await this._verifyOwnCart(page, product, quantity);
        timings.cartVerifiedMs = Date.now() - purchaseStartedAt;
      } catch (error) {
        await saveCheckoutEvidence(page, settings.evidencePath).catch(() => '');
        throw error;
      }
      if (settings.action !== 'checkout') {
        return { status: 'carted', quantity, detail: '已加入並核對誠品獨立購物車，未送出訂單' };
      }
      // 誠品會先畫出 disabled 的結帳鍵，再等購物車金額與活動計算完成後啟用。
      // 不要抓住第一個舊節點等待 30 秒；以頁面狀態重新判斷並重新取得按鈕。
      await page.waitForFunction(() => {
        const button = document.querySelector('#cart-step1-checkout-btn');
        return button && !button.disabled;
      }, null, { timeout: 10000 }).catch(() => {});
      const checkout = await firstVisible(page, [
        '#cart-step1-checkout-btn:not([disabled])',
        'button:has-text("結帳"):not([disabled])', 'a:has-text("結帳")', '[class*="checkout"] button:not([disabled])'
      ]);
      if (!checkout || !await checkout.isEnabled()) throw new Error('誠品購物車尚未完成計算，結帳按鈕仍停用');
      await Promise.all([
        page.waitForURL('**/cart/step2**', { timeout: 15000 }),
        checkout.click({ timeout: 5000 })
      ]);
      timings.checkoutPageLoadedMs = Date.now() - purchaseStartedAt;
      await page.locator('text=選擇配送方式').first()
        .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      const payment = ESLITE_PAYMENTS.has(settings.payment) ? settings.payment : 'seven_cod';
      let shippingChoice;
      let paymentChoice;
      let checkoutReadyDetail;
      let shippingKeywords;
      let paymentKeywords;
      if (payment === 'virtual_atm_home') {
        shippingChoice = await chooseEsliteCheckoutOption(page, [
          '#step2-box-delivery .radio-option[title="台灣-宅配(台灣地區)"]',
          '#step2-box-delivery .radio-option[title*="宅配"]',
          '#step2-box-delivery label:has-text("宅配")', '#step2-box-delivery button:has-text("宅配")'
        ], 'delivery', '找不到誠品宅配選項');
        await page.waitForTimeout(500);
        const recent = await firstVisible(page, [
          'label:has-text("選擇近期寄送地址")', 'button:has-text("選擇近期寄送地址")',
          'input[type="radio"]:near(:text("選擇近期寄送地址"))', 'text=選擇近期寄送地址'
        ]);
        if (recent) await recent.click().catch(() => {});
        await page.waitForTimeout(350);
        const addressModal = await firstVisible(page, [
          '.ec-modal.address-book .modal-container', '.address-book .modal-container',
          '[role="dialog"]:has-text("地址")'
        ]);
        if (addressModal) {
          if (!await this._chooseSavedDeliveryAddress(page)) throw new Error('誠品已儲存地址中找不到指定宅配地址');
          await clickFirst(page, [
            '.ec-modal.address-book button:has-text("確認")',
            '.address-book .modal-container button:has-text("確認")',
            'div[role="dialog"] button:has-text("確認")'
          ], '找不到誠品已儲存宅配地址確認按鈕');
          await page.waitForTimeout(350);
        }
        await page.locator('#step2-box-payment .radio-option').first()
          .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        paymentChoice = await chooseEsliteCheckoutOption(page, [
          '#step2-box-payment .radio-option[title*="ATM"]',
          '#step2-box-payment .radio-option:has-text("ATM")',
          '#step2-box-payment label:has-text("ATM")', '#step2-box-payment button:has-text("ATM")'
        ], 'payment', '找不到誠品 ATM／轉帳付款選項');
        shippingKeywords = ['宅配'];
        paymentKeywords = ['atm'];
        checkoutReadyDetail = '誠品宅配、ATM／轉帳、已儲存收件資料與最終確認結帳按鈕均已就緒；未送出訂單';
      } else {
        shippingChoice = await chooseEsliteCheckoutOption(page, [
          '#step2-box-delivery .radio-option[title="台灣7-ELEVEN取貨"]',
          '#step2-box-delivery .radio-option[title*="7-ELEVEN"]',
          '#step2-box-delivery label:has-text("7-ELEVEN")',
          '#step2-box-delivery button:has-text("7-ELEVEN")'
        ], 'delivery', '找不到誠品 7-11 取貨選項');
        await page.waitForTimeout(700);
        const recent = await firstVisible(page, [
          'label:has-text("選擇近期寄送地址")', 'button:has-text("選擇近期寄送地址")',
          'input[type="radio"]:near(:text("選擇近期寄送地址"))',
          'text=選擇近期寄送地址'
        ]);
        if (recent) await recent.click().catch(() => {});
        await page.waitForTimeout(500);
        const storeName = String(this.getPickupProfile().storeName || '').trim();
        let storeSelected = false;
        let addressModal = await firstVisible(page, [
          '.ec-modal.address-book .modal-container', '.address-book .modal-container',
          '[role="dialog"]:has-text("門市")'
        ]);
        if (!addressModal) {
          const checkoutText = await page.locator('body').innerText().catch(() => '');
          if (storeName && checkoutText.includes(storeName) && /(?:近期寄送地址|取件門市|門市)/.test(checkoutText)) storeSelected = true;
        }
        if (!addressModal && !storeSelected) {
          const savedStore = await firstVisible(page, [
            'button:has-text("選擇已儲存門市")', 'button:has-text("已儲存門市")'
          ]);
          if (!savedStore) throw new Error('找不到誠品已儲存門市入口');
          await savedStore.click();
          await page.waitForTimeout(350);
          addressModal = await firstVisible(page, [
            '.ec-modal.address-book .modal-container', '.address-book .modal-container',
            '[role="dialog"]:has-text("門市")'
          ]);
        }
        if (addressModal) {
          if (!await this._chooseSavedStore(page)) throw new Error('誠品已儲存地址中找不到指定 7-11 門市');
          await clickFirst(page, [
            '.ec-modal.address-book button:has-text("確認")',
            '.address-book .modal-container button:has-text("確認")',
            'div[role="dialog"] button:has-text("確認")'
          ], '找不到誠品已儲存門市確認按鈕');
          await page.waitForTimeout(350);
          const checkoutText = await page.locator('body').innerText().catch(() => '');
          storeSelected = Boolean(storeName && checkoutText.includes(storeName));
        }
        if (!storeSelected) throw new Error('誠品指定 7-11 門市未成功套用');
        paymentChoice = await chooseEsliteCheckoutOption(page, [
          '[title*="7-ELEVEN超商取貨付款"]', '[title*="7-11超商取貨付款"]',
          'label:has-text("7-ELEVEN超商取貨付款")', 'label:has-text("7-11超商取貨付款")',
          'button:has-text("7-ELEVEN超商取貨付款")', 'button:has-text("7-11超商取貨付款")',
          'label:has-text("超商取貨付款")', 'text=7-ELEVEN超商取貨付款'
        ], 'payment', '找不到誠品 7-11 超商取貨付款選項');
        await this._fillPickupContact(page);
        shippingKeywords = ['7-eleven'];
        paymentKeywords = ['取貨付款'];
        checkoutReadyDetail = '誠品 7-11 取貨付款、近期門市、收件資料與最終確認結帳按鈕均已就緒；未送出訂單';
      }
      await checkCheckoutAgreements(page);
      await assertCheckoutOptionSelected(page, shippingChoice, shippingKeywords, '誠品尚未正確套用配送方式，已停止送單');
      await assertCheckoutOptionSelected(page, paymentChoice, paymentKeywords, '誠品尚未正確套用付款方式，已停止送單');
      await assertCheckoutFormReady(page, '誠品結帳頁');
      const finalButton = await firstVisible(page, ['button:has-text("確認結帳")', 'button:has-text("送出訂單")']);
      if (!finalButton || !await finalButton.isEnabled()) throw new Error('誠品最終確認結帳按鈕尚未啟用');
      timings.checkoutReadyMs = Date.now() - purchaseStartedAt;
      if (settings.captureCheckoutTemplate) {
        await finalButton.click();
        const payload = await Promise.race([
          checkoutCapture,
          new Promise((resolve) => setTimeout(() => resolve(null), 8000))
        ]);
        if (!payload?.checkout) throw new Error('誠品結帳資料格式攔截失敗；已中止且沒有送出訂單');
        timings.checkoutPayloadCapturedMs = Date.now() - purchaseStartedAt;
        return {
          status: 'checkout_template_captured', quantity, payment,
          detail: '已在送單前攔截並中止官方結帳請求；沒有送出訂單',
          checkoutTemplate: payload,
          timings
        };
      }
      if (settings.verifyOnly) {
        const evidencePath = await saveCheckoutEvidence(page, settings.evidencePath);
        return {
          status: 'checkout_ready', quantity,
          payment,
          detail: checkoutReadyDetail,
          resultUrl: page.url(), evidencePath, timings
        };
      }
      await finalButton.click();
      await Promise.race([
        page.waitForURL('**/cart/step3**', { timeout: 25000 }).catch(() => null),
        page.waitForFunction(() => /訂單(?:已)?(?:成立|完成|成功)|感謝(?:您的)?(?:訂購|購買)|訂單編號/i.test(document.body?.innerText || ''),
          { timeout: 25000 }).catch(() => null)
      ]);
      const confirmation = detectOrderConfirmation({
        platform: 'eslite', url: page.url(), bodyText: await page.locator('body').innerText().catch(() => '')
      });
      if (!confirmation.confirmed) return {
        status: 'submitted_unconfirmed', quantity,
        detail: `誠品已按下確認結帳，但尚未讀到完成頁，請勿重複送單並人工確認：${page.url()}`,
        resultUrl: page.url()
      };
      const orderId = confirmation.orderId;
      return {
        status: 'ordered', quantity,
        payment,
        detail: orderId ? `誠品訂單已送出｜${orderId}` : `誠品訂單已送出｜${confirmation.evidence}`,
        resultUrl: page.url(), orderId, timings
      };
    } catch (error) {
      error.timings = { ...timings, failedAtMs: Date.now() - purchaseStartedAt };
      await saveCheckoutEvidence(page, settings.evidencePath).catch(() => '');
      throw error;
    } finally {
      await context.close();
    }
  }
}

export class MultiAccountEslitePurchaseAdapter {
  constructor(options) {
    this.options = options;
    this.independentQueues = true;
    this.getAccounts = options.getAccounts || (() => []);
    this.busySlots = new Set();
    this.waiters = [];
    this.credentialFingerprints = new Map();
    this.accountSetupEnabled = typeof options.onAccountPrepared === 'function';
    this.getAccountPayment = slot => {
      const payment = options.getAccountPayment?.(slot);
      return ESLITE_PAYMENTS.has(payment) ? payment : 'virtual_atm_home';
    };
    this.adapters = {};
    this._syncAccounts();
  }

  _syncAccounts() {
    const options = this.options;
    for (const slot of esliteAccountSlots(this.getAccounts().map(item => item.slot))) {
      if (this.adapters[slot]) continue;
      const accountSlot = slot;
      const adapter = new EslitePurchaseAdapter({
        ...options,
        accountSlot,
        getCheckoutTemplate: () => options.getCheckoutTemplate?.(accountSlot) || null,
        getPickupSetup: options.getPickupSetup ? () => options.getPickupSetup(accountSlot) : undefined,
        getSelectedPayment: () => this.getAccountPayment(accountSlot),
        onMemberIdentified: (profile, context) => options.onMemberIdentified?.(accountSlot, profile, context),
        onAccountPrepared: (template, context) => options.onAccountPrepared?.(accountSlot, template, context),
        onLoginValidated: () => this.accountSetupEnabled ? this.scheduleAccountPreparation(accountSlot) : undefined,
        getCredentials: () => {
          const account = this._account(accountSlot);
          return { account: String(account.account || ''), password: String(account.password || '') };
        },
        log: (message) => options.log?.(`誠品帳號 ${accountSlot}｜${message}`)
      });
      this.adapters[slot] = adapter;
    }
  }

  _account(slot) {
    return this.getAccounts().find((item) => String(item.slot).toUpperCase() === slot) || {};
  }

  scheduleAccountPreparation(accountSlot = 'A') {
    this._syncAccounts();
    const slot = String(accountSlot || 'A').toUpperCase();
    const adapter = this.adapters[slot];
    if (!adapter) throw new Error('找不到此誠品帳號');
    if (!this.accountSetupEnabled) return { ok: false, message: '尚未設定自動資料辨識' };
    if (!adapter.credentialsStatus().ready || this._account(slot).enabled === false) return { ok: false, message: `誠品帳號 ${slot} 未設定或已停用` };
    adapter.scheduleAccountPreparation({ payment: this.getAccountPayment(slot) }).catch(error => {
      adapter.accountPreparationState = 'retry_pending';
      adapter.accountPreparationError = purchaseErrorSummary(error);
    });
    return { ok: true, pending: true, message: `誠品帳號 ${slot} 正在背景辨識會員、配送與結帳資料；不加車、不送單。` };
  }

  accountIdentity(slot) {
    const account = String(this._account(slot).account || '').trim().toLowerCase();
    return account ? crypto.createHash('sha256').update(`eslite:${account}`).digest('hex') : '';
  }

  queueSlots() { return this._enabledEntries().map(([slot]) => slot); }

  queueBlockReason(slot, settings = {}) {
    this._syncAccounts();
    const adapter = this.adapters[slot];
    if (!adapter || !this.queueSlots().includes(slot)) return '帳號未啟用或未設定';
    if (this.busySlots.has(slot) || adapter.accountBusy) return '帳號忙碌';
    if (adapter.accountBrowser) return '帳號瀏覽器開啟中，關閉後恢復派單';
    if (adapter.cartActionUncertain) return '手動清車結果不明，請重新清車確認';
    if (this.busySlots.size >= 3) return '等待可用下單線路';
    if (adapter.activePurchaseHold()) return '訂單結果待查證';
    const selectedPayment = settings.accountPayments?.[slot] || settings.payment || this.getAccountPayment(slot);
    let selection;
    try { selection = resolveEsliteCheckoutSelection({ template: adapter.getCheckoutTemplate(), payment: selectedPayment,
      deliveryProfile: adapter.getDeliveryProfile(), pickupUnavailable: Boolean(adapter.getPickupSetup && !adapter.getPickupSetup()) }); }
    catch (error) { return purchaseErrorSummary(error); }
    const template = selection.checkoutTemplate;
    if (!template?.checkout) return '缺少本帳號結帳範本';
    const payment = selection.payment;
    if (template.paymentMode && payment && template.paymentMode !== payment) return '付款設定與範本不符';
    if (adapter.loginState === 'needs_login') return '需要登入驗證';
    return '';
  }

  _enabledEntries() {
    this._syncAccounts();
    return Object.entries(this.adapters).filter(([slot, adapter]) => {
      const account = this._account(slot);
      return account.enabled !== false && adapter.credentialsStatus().ready;
    });
  }

  get maxConcurrency() {
    return Math.max(1, Math.min(3, this._enabledEntries().length));
  }

  credentialsStatus() {
    this._syncAccounts();
    const slots = esliteAccountSlots(this.getAccounts().map(item => item.slot));
    const accounts = slots.map(slot => [slot, this.adapters[slot]]).map(([slot, adapter]) => ({
      slot,
      ...adapter.credentialsStatus(),
      enabled: this._account(slot).enabled !== false
    }));
    return {
      ready: accounts.some((account) => account.ready && account.enabled),
      account: `${accounts.filter((account) => account.ready && account.enabled).length} 組已設定`,
      accounts
    };
  }

  runtimeStatus() {
    this._syncAccounts();
    const slots = esliteAccountSlots(this.getAccounts().map(item => item.slot));
    const accounts = slots.map(slot => [slot, this.adapters[slot]]).map(([slot, adapter]) => ({
      slot,
      enabled: this._account(slot).enabled !== false,
      busy: this.busySlots.has(slot),
      ...adapter.runtimeStatus()
    }));
    return {
      state: accounts.some((account) => account.busy) ? 'busy'
        : accounts.some((account) => account.loginState === 'ready') ? 'ready' : 'idle',
      maxConcurrency: this.maxConcurrency,
      accountCount: accounts.filter((account) => this.adapters[account.slot].credentialsStatus().ready && account.enabled).length,
      accounts,
      strategy: '各帳號獨立 Session、獨立單品購物車；最多三路並行，其餘排隊'
    };
  }

  async setWarmPoolEnabled(enabled) {
    this._syncAccounts();
    const entries = Object.entries(this.adapters);
    for (let index = 0; index < entries.length; index += 1) {
      const [slot, adapter] = entries[index];
      const account = this._account(slot);
      const accountEnabled = Boolean(enabled && account.enabled !== false && adapter.credentialsStatus().ready);
      const fingerprint = `${account.account || ''}\u0000${account.password || ''}`;
      const changed = this.credentialFingerprints.get(slot) !== fingerprint;
      this.credentialFingerprints.set(slot, fingerprint);
      if (changed && adapter.sessionHeartbeatEnabled) await adapter.setWarmPoolEnabled(false);
      await adapter.setWarmPoolEnabled(accountEnabled);
      if (accountEnabled && this.accountSetupEnabled && !adapter.preparationJob
        && Date.now() - adapter.accountPreparationLastAttemptMs >= 60000
        && (changed || (adapter.getCheckoutTemplate()?.requestedPayment || adapter.getCheckoutTemplate()?.paymentMode) !== this.getAccountPayment(slot)
          || (adapter.getCheckoutTemplate()?.paymentFallback && adapter.getPickupSetup?.()))) {
        this.scheduleAccountPreparation(slot);
      }
      if (accountEnabled && index < entries.length - 1) await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  noteActivity(options = {}) {
    let laneIndex = 0;
    for (const [slot, adapter] of this._enabledEntries()) {
      if (this._account(slot).enabled !== false) {
        adapter.noteActivity({ ...options, delayMs: laneIndex * ESLITE_SESSION_HEARTBEAT_LANE_GAP_MS });
        laneIndex += 1;
      }
    }
  }

  async _acquireAccount() {
    while (true) {
      const candidates = this._enabledEntries().filter(([slot, adapter]) => this.busySlots.size < 3 && !this.busySlots.has(slot) && !adapter.activePurchaseHold?.());
      const available = candidates.find(([, adapter]) => adapter._apiReady?.())
        || candidates.find(([, adapter]) => adapter.loginState !== 'needs_login');
      if (available) {
        this.busySlots.add(available[0]);
        return available;
      }
      if (!this._enabledEntries().length) throw new Error('尚未啟用任何誠品多帳號帳密');
      if (!this.busySlots.size) {
        throw esliteApiError('誠品沒有可用購買帳號：各帳號登入已失效或有待確認訂單；本次未加車、未送單', 'needs_login');
      }
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  _releaseAccount(slot) {
    this.busySlots.delete(slot);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  async purchase(product, settings) {
    const requestedSlot = settings.accountSlot;
    let selected;
    if (requestedSlot) {
      const reason = this.queueBlockReason(requestedSlot, settings);
      if (reason) throw esliteApiError(reason, 'account_not_ready');
      this.busySlots.add(requestedSlot);
      selected = [requestedSlot, this.adapters[requestedSlot]];
    } else selected = await this._acquireAccount();
    const [slot, adapter] = selected;
    const startedAt = Date.now();
    try {
      await settings?.onAccountAssigned?.(slot);
      if (settings.accountIdentity && settings.accountIdentity !== this.accountIdentity(slot)) {
        throw esliteApiError('排隊後帳號已變更，本次未加車未送單', 'account_changed');
      }
      const payment = ESLITE_PAYMENTS.has(settings?.accountPayments?.[slot])
        ? settings.accountPayments[slot]
        : ['A', 'B', 'C'].includes(slot) ? settings.payment : this.getAccountPayment(slot);
      const result = await adapter.purchase(product, {
        ...settings,
        payment,
        apiDeadlineAt: startedAt + ESLITE_API_ORDER_WINDOW_MS
      });
      return { ...result, accountSlot: slot, payment: result.payment || payment, durationMs: Date.now() - startedAt };
    } catch (error) {
      error.accountSlot = slot;
      error.payment ||= settings?.accountPayments?.[slot] || (['A', 'B', 'C'].includes(slot) ? settings.payment : this.getAccountPayment(slot));
      error.durationMs = Date.now() - startedAt;
      throw error;
    } finally {
      this._releaseAccount(slot);
    }
  }

  async preflight(product, settings, { accountSlot = 'A', payment, evidencePath = '' } = {}) {
    this._syncAccounts();
    const slot = String(accountSlot || 'A').toUpperCase();
    const adapter = this.adapters[slot];
    if (!adapter) throw new Error('找不到此誠品帳號');
    const account = this._account(slot);
    if (account.enabled === false || !adapter.credentialsStatus().ready) {
      throw new Error(`誠品帳號 ${slot} 尚未啟用或未設定帳密`);
    }
    const selectedPayment = ESLITE_PAYMENTS.has(payment)
      ? payment
      : ESLITE_PAYMENTS.has(settings?.accountPayments?.[slot])
        ? settings.accountPayments[slot]
        : ['A', 'B', 'C'].includes(slot) ? settings.payment : this.getAccountPayment(slot);
    const startedAt = Date.now();
    try {
      const result = await adapter.purchase(product, {
        ...settings,
        payment: selectedPayment,
        verifyOnly: true,
        evidencePath
      });
      return { ...result, accountSlot: slot, payment: result.payment || selectedPayment, durationMs: Date.now() - startedAt };
    } catch (error) {
      error.accountSlot = slot;
      error.payment = selectedPayment;
      error.durationMs = Date.now() - startedAt;
      throw error;
    }
  }

  async testLogin({ accountSlot = 'A', interactive = true, manualOnly = false } = {}) {
    this._syncAccounts();
    const slot = String(accountSlot || 'A').toUpperCase();
    const adapter = this.adapters[slot];
    if (!adapter) throw new Error('找不到此誠品帳號');
    const result = await adapter.testLogin({ interactive, manualOnly });
    if (result.ok && this.accountSetupEnabled) this.scheduleAccountPreparation(slot);
    return result;
  }

  async completeLogin({ accountSlot = 'A' } = {}) {
    this._syncAccounts();
    const slot = String(accountSlot || 'A').toUpperCase();
    const adapter = this.adapters[slot];
    if (!adapter) throw new Error('找不到此誠品帳號');
    if (adapter.interactiveLogin) {
      const result = await adapter.completeLogin();
      if (result.ok && this.accountSetupEnabled) this.scheduleAccountPreparation(slot);
      return result;
    }
    const result = await adapter.verifyStoredSession({ source: 'manual', loginOnly: true });
    if (result.ok) {
      if (this.accountSetupEnabled) return this.scheduleAccountPreparation(slot);
      return { ok: true, pending: false, message: `誠品帳號 ${slot} 登入狀態正常。` };
    }
    if (result.loggedIn === false) {
      return { ok: false, pending: false, message: `誠品帳號 ${slot} 已登出，請重新開啟登入視窗。` };
    }
    return {
      ok: false,
      pending: false,
      message: `誠品帳號 ${slot} 暫時無法確認：${result.reason || '網站未完整回應'}；既有登入狀態未被清除。`
    };
  }

  async importBrowserSession({ accountSlot, storageState } = {}) {
    this._syncAccounts();
    const slot = String(accountSlot || '').toUpperCase();
    if (!isEsliteAccountSlot(slot) || !this.adapters[slot]) throw new Error('誠品帳號欄位不存在');
    if (this.busySlots.has(slot)) throw new Error('此帳號正在下單，不能同步登入');
    const result = await this.adapters[slot].importBrowserSession(storageState);
    if (result.ok && this.accountSetupEnabled) this.scheduleAccountPreparation(slot);
    return result;
  }

  async maintainSession(options = {}) {
    const entries = this._enabledEntries();
    if (!entries.length) return { ok: false, skipped: true, reason: '尚未啟用任何誠品帳號' };
    const settled = await Promise.allSettled(entries.map(async ([slot, adapter]) => ({
      slot,
      ...(await adapter.maintainSession(options))
    })));
    const accounts = settled.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : { slot: entries[index][0], ok: false, error: conciseAutomationError(result.reason) });
    return { ok: accounts.some((account) => account.ok), accounts };
  }

  async close() {
    const waiters = this.waiters.splice(0);
    waiters.forEach((resolve) => resolve());
    await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
  }
}


export class AutoPurchaseCoordinator {
  constructor({
    state, getConfig, adapters, notifyPrivate, log = () => {},
    isPlatformMonitoringEnabled = () => true, esliteHistoryFile = '',
    continuousEsliteTasks = false, esliteTaskClock = Date.now, esliteQueueRandom = Math.random,
    continuousFunboxTasks = false, funboxTaskClock = Date.now, funboxQueueRandom = Math.random, funboxHistoryFile = ''
  }) {
    this.state = state;
    this.getConfig = getConfig;
    this.adapters = adapters;
    this.notifyPrivate = notifyPrivate;
    this.log = log;
    this.isPlatformMonitoringEnabled = isPlatformMonitoringEnabled;
    this.esliteRestockTasks = continuousEsliteTasks ? new EsliteRestockTasks({ now: esliteTaskClock,maxAttempts:3 }) : null;
    this.funboxRestockTasks = continuousFunboxTasks ? new EsliteRestockTasks({ now: funboxTaskClock,maxAttempts:3 }) : null;
    this.funboxQueueRandom = funboxQueueRandom;
    this.funboxProductOrder = new Map();
    this.funboxHistoryFile = funboxHistoryFile;
    this.funboxHistoryTail = Promise.resolve();
    this.esliteQueueRandom = esliteQueueRandom;
    this.esliteProductOrder = new Map();
    this.esliteDispatchSequence = 0;
    this.queue = [];
    this.queuedKeys = new Set();
    this.funboxPendingWave = new Map();
    this.funboxWaveTimer = null;
    this.funboxWaveSequence = 0;
    this.funboxInventorySignals = new Map();
    this.activeWorkers = 0;
    this.activeByPlatform = new Map();
    this.activeEsliteSlots = new Set();
    this.esliteQueueTimer = null;
    this.maxWorkers = 4;
    this.scheduling = false;
    this.idleResolvers = [];
    this.maintenanceTimer = null;
    this.maintenanceRunning = false;
    this.paused = false;
    this.esliteHistoryFile = esliteHistoryFile;
    this.esliteHistoryTail = Promise.resolve();
    this.privateDeliveries = new Set();
    this.heldEsliteChecks = new Map();
    this.heldEsliteWork = new Set();
    this.orderStatusRefresher = new PurchaseOrderStatusRefresher({
      getStorage: () => this._storage(), save: () => this.state.save(),
      isBusy: platform => this._orderStatusBusy(platform),
      readOrder: (platform, record) => this._readOrderStatus(platform, record)
    });
    for (const entry of this._storage().privateOutbox || []) {
      if (entry.status === 'pending') {
        entry.status = 'interrupted';
        entry.error = '通知傳送期間程式中斷，可能已送達；不自動重複發送';
      }
    }
    // Old errors may include Playwright headers. Retain the record, not the dump.
    for (const record of [...Object.values(this._storage().records), ...this._storage().recent]) {
      if (record.error) record.error = purchaseErrorSummary(record.error);
      if (record.detail) record.detail = safePurchaseText(record.detail);
    }
    for (const record of Object.values(this._storage().records)) {
      if (!['eslite', 'funbox'].includes(record.platform) || record.status !== 'processing') continue;
      // Assigned work interrupted by a restart may have reached checkout. Keep
      // that account protected until the owner checks the official order list.
      record.status = record.accountSlot ? 'submitted_unconfirmed' : 'failed';
      record.purchaseStatus = record.accountSlot ? 'interrupted_unconfirmed' : 'interrupted_before_assignment';
      record.completedAt = new Date().toISOString();
      record.detail = record.accountSlot ? '程式中斷，無法確認是否成立；請核對官方訂單。' : '程式在分配帳號前中斷，尚未進行購買。';
      void this._recordEsliteAttempt(record).catch((error) => this.log(`誠品中斷紀錄保存失敗：${conciseAutomationError(error)}`));
    }
  }

  _recordFunboxEvidence(record, step) {
    if (!this.funboxHistoryFile || !record) return Promise.resolve();
    const file = step ? path.join(path.dirname(this.funboxHistoryFile), 'funbox-steps.jsonl') : this.funboxHistoryFile;
    const evidence = step ? { taskId: record.taskId, productId: record.product?.id, accountSlot: record.accountSlot, ...safePurchaseStep(step) }
      : { platform: 'funbox', taskId: record.taskId, product: compactProduct(record.product), accountSlot: record.accountSlot,
        mode: record.mode || 'single', products: (record.products || []).map(p => ({ ...compactProduct(p), quantity: p.quantity })),
        skippedProducts: (record.skippedProducts || []).map(p => ({ id: p.id, reason: safePurchaseText(p.reason) })),
        status: record.status, purchaseStatus: record.purchaseStatus, orderNumber: record.orderNumber || '', payment: record.payment,
        transport:record.transport || '',quantity:record.quantity,amount:record.amount,resultUrl:record.resultUrl || '',paymentUrl:record.paymentUrl || '',
        bankCode:record.bankCode || '',bankAccount:record.bankAccount || '',paymentDeadline:record.paymentDeadline || '',atmInfoReady:record.atmInfoReady,
        startedAt: record.startedAt, completedAt: record.completedAt, durationMs: record.durationMs,
        error: record.error ? purchaseErrorSummary(record.error) : '', steps: (record.steps || []).map(safePurchaseStep) };
    this.funboxHistoryTail = this.funboxHistoryTail.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, JSON.stringify(evidence) + '\n', 'utf8');
    });
    return this.funboxHistoryTail;
  }

  async _recordEsliteAttempt(record) {
    if (record.platform === 'funbox') return this._recordFunboxEvidence(record);
    if (record.platform !== 'eslite' || !this.esliteHistoryFile) return;
    // Allowlist: no login data, checkout payloads, addresses or payment tokens.
    const evidence = {
      platform: 'eslite', product: compactProduct(record.product), accountSlot: record.accountSlot,
      mode: record.mode || 'single', quantity: record.quantity, products: (record.products || []).map(p => ({ ...compactProduct(p), quantity: p.quantity })),
      skippedProducts: (record.skippedProducts || []).map(p => ({ id: p.id, reason: safePurchaseText(p.reason) })),
      payment: record.payment, status: record.status, purchaseStatus: record.purchaseStatus,
      requestedPayment: record.requestedPayment || record.payment,
      ...(record.paymentFallback ? { paymentFallback: { from: record.paymentFallback.from, to: record.paymentFallback.to,
        reason: purchaseErrorSummary(record.paymentFallback.reason) } } : {}),
      orderId: record.orderId || '', startedAt: record.startedAt, completedAt: record.completedAt,
      reconciled: record.reconciled === true, resolvedAt: record.resolvedAt || '', previousStatus: record.previousStatus || '',
      resolutionSource: record.resolutionSource || '', orderCheck: record.orderCheck || null,
      durationMs: record.durationMs, error: record.error ? conciseAutomationError(record.error) : '',
      taskId: record.taskId || '', steps: (record.steps || []).map(safePurchaseStep),
      detail: safePurchaseText(record.detail),
      timings: record.timings || null
    };
    this.esliteHistoryTail = this.esliteHistoryTail.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.esliteHistoryFile), { recursive: true });
      await fs.appendFile(this.esliteHistoryFile, `${JSON.stringify(evidence)}\n`, 'utf8');
    });
    await this.esliteHistoryTail;
  }

  _recordEsliteStep(record, step) {
    if (record?.platform === 'funbox') return this._recordFunboxEvidence(record, step);
    if (!this.esliteHistoryFile) return Promise.resolve();
    const file = path.join(path.dirname(this.esliteHistoryFile), 'eslite-steps.jsonl');
    const evidence = { taskId: record.taskId, productId: record.product.id,
      accountSlot: record.accountSlot || '', ...safePurchaseStep(step) };
    this.esliteHistoryTail = this.esliteHistoryTail.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(evidence)}\n`, 'utf8');
    });
    return this.esliteHistoryTail;
  }

  async _queuePrivateResult(message, record) {
    const storage = this._storage();
    storage.privateOutbox ||= [];
    const entry = { id: record.taskId || `${record.platform}-${Date.now()}`, message,
      status: 'pending', createdAt: new Date().toISOString() };
    storage.privateOutbox.push(entry);
    storage.privateOutbox = storage.privateOutbox.filter(item => item.status !== 'sent').concat(storage.privateOutbox.filter(item => item.status === 'sent').slice(-30));
    try { await this.state.save(); } catch (error) {
      entry.status = 'failed'; entry.error = purchaseErrorSummary(error);
      record.notification = { status: 'failed', error: '通知待送紀錄保存失敗；購買結果不變' };
      this.log(`私人通知待送紀錄保存失敗：${entry.error}`);
      return;
    }
    const delivery = this._deliverPrivateResult(message).then(async () => {
      entry.status = 'sent'; entry.completedAt = new Date().toISOString();
      record.notification = { status: 'sent', at: entry.completedAt };
    }, async error => {
      entry.status = 'failed'; entry.error = purchaseErrorSummary(error);
      record.notification = { status: 'failed', error: entry.error };
      this.log(`私人購買通知失敗（購買結果已保存）：${entry.error}`);
    }).then(async () => {
      const step = safePurchaseStep({ at: new Date().toISOString(), label: entry.status === 'sent' ? '私人通知已送出' : '私人通知失敗／購買結果保留',
        state: entry.status === 'sent' ? 'success' : 'failed', elapsedMs: Date.now() - Date.parse(record.startedAt), reason: entry.error || '' });
      record.steps.push(step);
      await this._recordEsliteStep(record, step).catch(error => this.log(`通知步驟保存失敗：${purchaseErrorSummary(error)}`));
      await this.state.save();
    }).catch(error => this.log(`通知狀態保存失敗：${purchaseErrorSummary(error)}`));
    this.privateDeliveries.add(delivery);
    delivery.finally(() => this.privateDeliveries.delete(delivery));
  }

  _storage() {
    this.state.data.commerce ||= {};
    this.state.data.commerce.autoPurchase ||= { records: {}, recent: [] };
    const storage = this.state.data.commerce.autoPurchase;
    storage.records ||= {};
    storage.recent ||= [];
    storage.maintenance ||= { completedSlots: {}, recent: [] };
    storage.maintenance.completedSlots ||= {};
    storage.maintenance.recent ||= [];
    return storage;
  }

  _ledger() {
    const storage = this._storage(), ledger = new PurchaseLedger(storage);
    // Import evidence without deleting history. Undated legacy rows remain guarded below.
    for (const record of [...Object.values(storage.records), ...storage.recent]) {
      const slot = record.accountSlot || record.slot, identity = record.accountIdentity || this.adapters[record.platform]?.accountIdentity?.(slot);
      const reference = record.orderNumber || record.orderId;
      if (!identity || !reference || record.verifyOnly || !['ordered', 'success', 'payment_failed', '3ds_pending', 'canceled', 'cancelled', 'shipped', 'completed'].includes(record.status)) continue;
      const products = record.products?.length ? record.products : [record.product];
      const items = products.filter(Boolean).map(p => ({ id: record.platform === 'funbox' ? canonicalFunboxProductId(p.url, p.id) : p.id,
        quantity: Number(p.quantity) || (products.length === 1 ? Number(record.quantity) : 0) || (record.platform === 'funbox' && /隨機強化組/.test(p.title) ? 3 : 1) }));
      const at = record.completedAt || record.startedAt;
      if (!taipeiPurchaseDay(at)) continue;
      try { ledger.recordOrder({ platform: record.platform, identity, reference, at, items }); }
      catch { /* Keep conservative existing evidence; never refund uncertain legacy quantity. */ }
    }
    return ledger;
  }

  _plan(item, config = normalizeAutoPurchaseConfig(this.getConfig())) {
    const settings = config[item.platform], storage = this._storage();
    const identity = item.accountIdentity || this.adapters[item.platform]?.accountIdentity?.(item.accountSlot);
    const clock = this._restockTasks(item.platform)?.now() || Date.now();
    const result = planAccountPurchase({ platform: item.platform, product: item.product, settings, identity, ledger: this._ledger(), at: clock,
      purchased: Boolean(storage.eslitePurchased?.[identity]?.[item.product.id]) });
    const previous = storage.records[item.key];
    if (item.platform === 'eslite' && previous?.purchaseStatus === 'purchase_limited') return { ...result, eligible: false, reason: 'official_permanent_limit' };
    if (item.platform === 'funbox') {
      const legacy = storage.funboxPurchased?.[identity]?.[item.product.id];
      if (legacy && !taipeiPurchaseDay(legacy.purchasedAt)) return { ...result, eligible: false, reason: 'legacy_date_unknown' };
      if (legacy && taipeiPurchaseDay(legacy.purchasedAt) === taipeiPurchaseDay(clock)
        && !Object.values(this._ledger().data.orders).some(o => o.platform === 'funbox' && o.identity === identity && o.day === taipeiPurchaseDay(clock) && o.items.some(p => p.id === item.product.id))) return { ...result, eligible: false, reason: 'legacy_quantity_unknown' };
      if (previous?.purchaseStatus === 'checkout_limited' && (!taipeiPurchaseDay(previous.completedAt) || taipeiPurchaseDay(previous.completedAt) === taipeiPurchaseDay(clock))) return { ...result, eligible: false, reason: 'official_daily_limit' };
    }
    if (!compatibleWithPayment(item.product, settings.accountPayments?.[item.accountSlot] || settings.payment, settings)) return { ...result, eligible: false, reason: 'manual_delivery_rule' };
    return result;
  }

  observeFunboxInventory(products = [], observedAt = Date.now()) {
    for (const product of Array.isArray(products) ? products : []) {
      const compact = compactProduct(product);
      try {
        const slug = new URL(compact.url).pathname.match(/\/products\/([^/?#]+)/i)?.[1];
        if (slug) compact.id = decodeURIComponent(slug).trim().toLowerCase();
      } catch {}
      if (!compact.id) continue;
      this.funboxInventorySignals.set(compact.id, {
        available: product.available !== false,
        stock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : null,
        observedAt: Number(observedAt) || Date.now()
      });
      if (this.funboxRestockTasks && this.adapters.funbox?.independentQueues) {
        const sourceAt = Number(product.observedAtMs) > 0 ? Number(product.observedAtMs) : Number(observedAt);
        const previous = this.funboxRestockTasks.products.get(compact.id);
        const signature = JSON.stringify([product.variantId ?? '', product.stock ?? null, product.qtyCap ?? null]);
        // The final merged scan is not a new HTTP observation of the same response.
        if (previous && sourceAt <= previous.observedAt && signature === previous.signature && product.available === previous.available) continue;
        const observation = { ...product, id: compact.id, freshObservationAt: new Date(sourceAt).toISOString() };
        const config = normalizeAutoPurchaseConfig(this.getConfig());
        if (this.paused || !config.enabled || !config.funbox.enabled || !this.isPlatformMonitoringEnabled('funbox')) this._clearFunboxEvent();
        else if (this.funboxRestockTasks.observe(observation) && observation.available === true) {
          void this.enqueue('funbox', [observation], { observationOnly: true }).catch(error => this.log(purchaseErrorSummary(error)));
        }
      }
    }
    return this.funboxInventorySignals.size;
  }

  notePlatformActivity(platform, options = {}) {
    const adapter = this.adapters[platform];
    if (!adapter || typeof adapter.noteActivity !== 'function') return false;
    adapter.noteActivity(options);
    return true;
  }

  _funboxProductRisk(product, since = 0) {
    let id = String(product?.id || '').trim().toLowerCase();
    try {
      const slug = new URL(product?.url || '').pathname.match(/\/products\/([^/?#]+)/i)?.[1];
      if (slug) id = decodeURIComponent(slug).trim().toLowerCase();
    } catch {}
    const signal = this.funboxInventorySignals.get(id);
    if (!signal || signal.observedAt < since) return null;
    if (signal.available === false || signal.stock === 0) return { ...signal, reason: 'sold_out' };
    return null;
  }

  getStatus() {
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const storage = this._storage();
    const runtime = Object.fromEntries(Object.entries(this.adapters).map(([platform, adapter]) => [
      platform,
      typeof adapter.runtimeStatus === 'function' ? adapter.runtimeStatus() : {}
    ]));
    for (const account of runtime.eslite?.accounts || []) {
      const identity = this.adapters.eslite.accountIdentity?.(account.slot);
      account.purchasedProductCount = Object.keys(storage.eslitePurchased?.[identity] || {}).length;
      account.purchaseHistorySyncedAt = storage.esliteHistorySync?.[identity]?.at || '';
      account.purchaseHistoryComplete = storage.esliteHistorySync?.[identity]?.complete === true;
    }
    for (const account of runtime.funbox?.accounts || []) {
      const identity = this.adapters.funbox.accountIdentity?.(account.slot);
      const purchased = new Set(Object.keys(storage.funboxPurchased?.[identity] || {}));
      for (const record of Object.values(storage.records)) {
        if (record.platform === 'funbox' && (record.accountSlot || record.slot) === account.slot
          && (!record.accountIdentity || record.accountIdentity === identity) && record.orderNumber
          && ['ordered', 'success', 'payment_failed', '3ds_pending', 'canceled', 'shipped', 'completed'].includes(record.status)) {
          purchased.add(canonicalFunboxProductId(record.product?.url, record.product?.id));
        }
      }
      account.purchasedProductCount = purchased.size;
    }
    return {
      ...config,
      paused: this.paused,
      processing: this.activeWorkers > 0 || this.funboxPendingWave.size > 0,
      activeWorkers: this.activeWorkers,
      notificationPending: this.privateDeliveries.size,
      queued: this.queue.length + this.funboxPendingWave.size,
      esliteRestockEvent: this.esliteRestockTasks?.status() || { active: false, productCount: 0 },
      esliteWaitingTasks: this._esliteWaitingTasks(config),
      funboxRestockEvent: this.funboxRestockTasks?.status() || { active: false, productCount: 0 },
      funboxWaitingTasks: this._funboxWaitingTasks(config),
      funboxOrders: Object.values(storage.records).filter(record => record.platform === 'funbox')
        .sort((a, b) => (Date.parse(b.completedAt || b.startedAt) || 0) - (Date.parse(a.completedAt || a.startedAt) || 0)).slice(0, 200),
      esliteOrders: Object.values(storage.records).filter(record => record.platform === 'eslite')
        .sort((a, b) => (Date.parse(b.completedAt || b.startedAt) || 0) - (Date.parse(a.completedAt || a.startedAt) || 0)).slice(0, 200),
      orderStatusSync: storage.orderStatusSync || {},
      queue: this.queue.map((item) => ({
        platform: item.platform,
        accountSlot: item.accountSlot || '', productId: item.product?.id || '',
        enqueuedAt: item.enqueuedAt || '', expiresAt: item.expiresAt || '',
        priorityKeyword: item.accountSlot ? (item.platform === 'funbox' ? this._funboxPriority(item.product, config) : this._eslitePriority(item.product, config)).keyword : '',
        blockedReason: item.accountSlot ? this.adapters[item.platform]?.queueBlockReason?.(item.accountSlot, config[item.platform])
          || (item.continuous ? this._restockTasks(item.platform)?.reason(item.product.id, item.key, item.accountIdentity) : '') || '' : '',
        title: item.product?.title || item.products?.map((product) => product.title).join('＋') || '合單波次'
      })),
      runtime,
      inProgress: Object.values(storage.records).filter(record => record.status === 'processing'),
      maintenance: {
        times: [...CART_MAINTENANCE_TIMES],
        running: this.maintenanceRunning,
        ...(storage.maintenance || {})
      },
      credentials: Object.fromEntries(Object.entries(this.adapters).map(([platform, adapter]) => [
        platform, adapter.credentialsStatus()
      ])),
      recent: storage.recent.slice(0, 12)
    };
  }

  async applyRuntimeConfig() {
    if (this.paused) return this.getStatus();
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    if (!config.enabled || !config.eslite.enabled || !this.isPlatformMonitoringEnabled('eslite')) this._clearEsliteEvent();
    if (!config.enabled || !config.funbox.enabled || !this.isPlatformMonitoringEnabled('funbox')) this._clearFunboxEvent();
    const tasks = Object.entries(this.adapters).map(async ([platform, adapter]) => {
      const monitoringEnabled = Boolean(this.isPlatformMonitoringEnabled(platform));
      const enabled = Boolean(config.enabled && config[platform]?.enabled && monitoringEnabled);
      if (typeof adapter.setTurboEnabled === 'function') await adapter.setTurboEnabled(enabled);
      if (typeof adapter.setWarmPoolEnabled === 'function') await adapter.setWarmPoolEnabled(enabled);
    });
    await Promise.allSettled(tasks);
    this._sortEsliteQueue();
    void this._schedule();
    this._ensureMaintenanceSchedule();
    return this.getStatus();
  }

  _ensureMaintenanceSchedule() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      void this._runDueMaintenance();
    }, 60 * 1000);
    this.maintenanceTimer.unref?.();
    const startup = setTimeout(() => void this._runDueMaintenance(), 5000);
    startup.unref?.();
  }

  async _runDueMaintenance(now = new Date()) {
    if (this.maintenanceRunning || this.activeWorkers || this.queue.length || this.funboxPendingWave.size) return { deferred: true };
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    if (!config.enabled) return { skipped: true, reason: 'disabled' };
    const storage = this._storage();
    const day = localDayKey(now);
    storage.maintenance.completedSlots[day] ||= {};
    const currentMinute = localMinuteKey(now);
    const slot = CART_MAINTENANCE_TIMES.find((time) => time <= currentMinute
      && !storage.maintenance.completedSlots[day][time]);
    if (!slot) return { skipped: true, reason: 'not_due' };
    const result = await this.runMaintenance({ clearCart: false, reason: `每日 ${slot}` });
    if (!result.deferred) {
      storage.maintenance.completedSlots[day][slot] = new Date().toISOString();
      const oldDays = Object.keys(storage.maintenance.completedSlots).sort().slice(0, -7);
      oldDays.forEach((oldDay) => delete storage.maintenance.completedSlots[oldDay]);
      await this.state.save();
    }
    return result;
  }

  async runMaintenance({ clearCart = true, reason = '手動保養' } = {}) {
    if (this.maintenanceRunning || this.activeWorkers || this.queue.length || this.funboxPendingWave.size) {
      this.log(`購物車保養延後：購買工作器正在執行，絕不清空進行中的購物車。`);
      return { deferred: true, reason: 'purchase_in_progress', results: [] };
    }
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const platforms = Object.entries(this.adapters).filter(([platform, adapter]) =>
      config.enabled && config[platform]?.enabled && this.isPlatformMonitoringEnabled(platform)
      && adapter.credentialsStatus?.().ready
      && typeof adapter.maintainSession === 'function'
    );
    if (!platforms.length) return { deferred: true, reason: 'no_active_platform', results: [] };
    this.maintenanceRunning = true;
    const startedAt = new Date().toISOString();
    try {
      const settled = await Promise.allSettled(platforms.map(async ([platform, adapter]) => ({
        platform,
        result: await adapter.maintainSession({ clearCart })
      })));
      const results = settled.map((entry, index) => entry.status === 'fulfilled'
        ? entry.value
        : {
            platform: platforms[index][0],
            result: { ok: false, error: conciseAutomationError(entry.reason) }
          });
      const record = { reason, clearCart, startedAt, completedAt: new Date().toISOString(), results };
      const storage = this._storage();
      storage.maintenance.lastRun = record;
      storage.maintenance.recent.unshift(record);
      storage.maintenance.recent = storage.maintenance.recent.slice(0, 14);
      await this.state.save();
      for (const { platform, result } of results) {
        const label = PLATFORM_LABELS[platform] || platform;
        if (result.ok) {
          const removed = Number(result.removed) || 0;
          this.log(`${label} 登入狀態正常；每日購物車保養完成，清除 ${removed} 件舊商品。`);
        } else {
          this.log(`${label} 每日購物車保養未完成：${result.reason || result.error || '登入狀態無法確認'}`);
        }
      }
      return { deferred: false, results, startedAt, completedAt: record.completedAt };
    } finally {
      this.maintenanceRunning = false;
    }
  }

  async runFunboxAssignments(assignments, { verifyOnly = false, evidenceDir = '' } = {}) {
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const adapter = this.adapters.funbox;
    if (!adapter || typeof adapter.purchaseAssignments !== 'function') {
      throw new Error('Funbox 多帳號一對一購買器尚未啟用');
    }
    if (!config.enabled || !config.funbox.enabled) {
      throw new Error('Funbox 自動下單主開關尚未開啟');
    }
    const settings = {
      ...config.funbox,
      action: 'checkout',
      verifyOnly: Boolean(verifyOnly),
      // Only this explicit A/B/C acceptance-test entry may bypass the normal
      // Beyblade whitelist. Regular monitor candidates still obey it.
      confirmedManualAssignment: true,
      evidenceDir,
      onBeforeSubmit: async intent => {
        const assignment = assignments.find(item => String(item.slot).toUpperCase() === intent.accountSlot && String(item.product?.id) === String(intent.productId));
        if (!assignment) throw new Error('驗收送單意圖與指派帳號／商品不符');
        const key = `funbox:${assignment.product.id || assignment.product.url}:${intent.accountSlot}`;
        this._storage().records[key] = {platform:'funbox',accountSlot:intent.accountSlot,accountIdentity:adapter.accountIdentity?.(intent.accountSlot),
          product:assignment.product,status:'processing',startedAt:new Date().toISOString(),manualAssignment:true,submitIntent:intent};
        if (this.state.writeSnapshot) await this.state.writeSnapshot(); else await this.state.save();
      }
    };
    const accountResults = await adapter.purchaseAssignments(assignments, settings);
    const completedAt = new Date().toISOString();
    const storage = this._storage();
    for (const accountResult of accountResults) {
      const record = {
        platform: 'funbox',
        product: accountResult.product,
        ...accountResult,
        accountSlot:accountResult.slot,
        accountIdentity:adapter.accountIdentity?.(accountResult.slot),
        completedAt,
        manualAssignment: true,
        verifyOnly: Boolean(verifyOnly)
      };
      storage.recent.unshift(record);
      if (!verifyOnly) {
        const key = `funbox:${accountResult.product?.id || accountResult.product?.url}:${accountResult.slot}`;
        storage.records[key] = record;
        if (record.accountIdentity && ['ordered','success'].includes(record.status) && record.orderNumber) {
          storage.funboxPurchased ||= {};storage.funboxPurchased[record.accountIdentity] ||= {};
          storage.funboxPurchased[record.accountIdentity][canonicalFunboxProductId(record.product.url,record.product.id)] = {orderNumber:record.orderNumber,purchasedAt:completedAt};
        }
      }
    }
    storage.recent = storage.recent.slice(0, 30);
    await this.state.save();
    if (!verifyOnly) {
      await this._notifyFunboxAssignmentResults(accountResults);
    }
    return {
      ok: accountResults.every((result) => result.ok),
      verifyOnly: Boolean(verifyOnly),
      payment: settings.payment,
      accountResults
    };
  }

  async runPlatformPreflight(platform, product, { evidencePath = '', accountSlot = 'A', payment } = {}) {
    if (platform !== 'eslite') throw new Error('目前單平台送單前驗證只支援誠品線上');
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const adapter = this.adapters[platform];
    if (!adapter || !config.enabled || !config[platform]?.enabled) {
      throw new Error('誠品自動下單主開關尚未開啟');
    }
    if (this.maintenanceRunning || (this.activeByPlatform.get(platform) || 0) > 0) {
      throw new Error('誠品購買線正在執行，請稍後再做送單前驗證');
    }
    const parsedUrl = new URL(String(product?.url || ''));
    if (!/(?:^|\.)eslite\.com$/i.test(parsedUrl.hostname)) throw new Error('誠品送單前驗證只接受 eslite.com 商品網址');
    this.activeWorkers += 1;
    this.activeByPlatform.set(platform, 1);
    const startedAt = new Date().toISOString();
    try {
      const settings = { ...config[platform], action: 'checkout', verifyOnly: true, evidencePath };
      const result = typeof adapter.preflight === 'function'
        ? await adapter.preflight(compactProduct(product), settings, { accountSlot, payment, evidencePath })
        : await adapter.purchase(compactProduct(product), settings);
      const record = {
        platform,
        product: compactProduct(product),
        ...result,
        startedAt,
        completedAt: new Date().toISOString(),
        manualPreflight: true,
        verifyOnly: true
      };
      const storage = this._storage();
      storage.recent.unshift(record);
      storage.recent = storage.recent.slice(0, 30);
      await this.state.save();
      return { ok: ['checkout_ready', 'api_verified'].includes(result.status), result };
    } catch (error) {
      const storage = this._storage();
      storage.recent.unshift({
        platform,
        product: compactProduct(product),
        status: 'failed',
        purchaseStatus: error.purchaseStatus || '',
        accountSlot: error.accountSlot || String(accountSlot || 'A').toUpperCase(),
        payment: error.payment || payment || '',
        durationMs: Number(error.durationMs) || (Date.now() - Date.parse(startedAt)),
        ...(error.timings ? { timings: error.timings } : {}),
        error: conciseAutomationError(error),
        startedAt,
        completedAt: new Date().toISOString(),
        manualPreflight: true,
        verifyOnly: true
      });
      storage.recent = storage.recent.slice(0, 30);
      await this.state.save();
      throw error;
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      this.activeByPlatform.delete(platform);
      if (!this.activeWorkers && !this.queue.length && !this.funboxPendingWave.size && !this.funboxWaveTimer) {
        const resolvers = this.idleResolvers.splice(0);
        resolvers.forEach((resolve) => resolve());
      }
      void this._schedule();
    }
  }

  _restockTasks(platform) { return platform === 'funbox' ? this.funboxRestockTasks : this.esliteRestockTasks; }

  _clearFunboxEvent() {
    this.funboxRestockTasks?.reset();
    this.funboxProductOrder.clear();
    this.queue = this.queue.filter(item => {
      if (item.platform !== 'funbox' || !item.accountSlot) return true;
      this.queuedKeys.delete(item.key); return false;
    });
  }

  _funboxHandled(product, slot, identity) {
    const storage = this._storage();
    if (!this._plan({ platform: 'funbox', product, accountSlot: slot, accountIdentity: identity, key: `funbox:${product.id}:${identity}` }).eligible) return true;
    const key = `funbox:${product.id}:${identity}`, attempt = this.funboxRestockTasks?.attempts.get(key);
    // A daily guard is not a permanent stop. Only the date bucket changes;
    // unknown orders/cart holds and stale stock observations remain protected.
    if (attempt?.quotaDay && attempt.quotaDay !== taipeiPurchaseDay(this.funboxRestockTasks.now())
      && !['submitted_unconfirmed', 'processing', 'cart', 'carted'].includes(attempt.outcome)) this.funboxRestockTasks.attempts.delete(key);
    const current = storage.records[`funbox:${product.id}:${identity}`];
    const legacy = Object.values(storage.records).filter(record => record.platform === 'funbox'
      && (record.accountSlot || record.slot) === slot && canonicalFunboxProductId(record.product?.url, record.product?.id) === product.id);
    return [current, ...legacy].some(record => record && !record.verifyOnly
      && (!record.accountIdentity || record.accountIdentity === identity)
      && (['cart', 'carted', 'submitted_unconfirmed'].includes(record.status)
        || !taipeiPurchaseDay(record.completedAt || record.startedAt) && COMPLETED_STATUSES.has(record.status)));
  }

  _funboxPriority(product, config = normalizeAutoPurchaseConfig(this.getConfig())) {
    const index = config.funbox.priorityKeywords.findIndex(keyword => containsFunboxKeyword(product.title, keyword));
    return { index: index < 0 ? Number.MAX_SAFE_INTEGER : index, keyword: index < 0 ? '' : config.funbox.priorityKeywords[index] };
  }

  _sortFunboxQueue() {
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const items = sortPurchaseTasks(this.queue.filter(item => item.platform === 'funbox' && item.accountSlot), config.funbox);
    let index = 0;
    this.queue = this.queue.map(item => item.platform === 'funbox' && item.accountSlot ? items[index++] : item);
  }

  _funboxWaitingTasks(config) {
    const tasks = this.funboxRestockTasks, adapter = this.adapters.funbox;
    if (!tasks?.active() || !adapter?.independentQueues) return [];
    const waiting = [];
    for (const { product } of tasks.products.values()) {
      if (!funboxPurchaseStrategy(product, config.funbox).eligible) continue;
      for (const slot of adapter.queueSlots()) {
        const identity = adapter.accountIdentity(slot), key = `funbox:${product.id}:${identity}`;
        if (!identity || this.queuedKeys.has(key) || this._funboxHandled(product, slot, identity)) continue;
        waiting.push({ platform: 'funbox', accountSlot: slot, productId: product.id, title: product.title,
          blockedReason: adapter.queueBlockReason(slot, config.funbox) || tasks.reason(product.id, key, identity) || '等待新觀測派送',
          retryAt: tasks.attempts.get(key)?.nextAt ? new Date(tasks.attempts.get(key).nextAt).toISOString() : '' });
      }
    }
    return waiting;
  }

  _enqueueFunboxTasks(product, raw, config, observationOnly) {
    const tasks = this.funboxRestockTasks, adapter = this.adapters.funbox;
    if (!this.isPlatformMonitoringEnabled('funbox')) { this._clearFunboxEvent(); return 0; }
    if (tasks && !observationOnly) {
      if (!['new_product', 'restock', 'purchase_ready'].includes(raw.reason) || !tasks.observe({ ...raw, id: product.id,
        freshObservationAt: raw.freshObservationAt || raw.detectedAt }, { activate: true })) return 0;
    }
    if (!this.funboxProductOrder.has(product.id)) this.funboxProductOrder.set(product.id, this.funboxProductOrder.size + 1);
    let accepted = 0;
    for (const slot of adapter.queueSlots()) {
      const identity = adapter.accountIdentity(slot), key = `funbox:${product.id}:${identity}`;
      if (!identity || this._funboxHandled(product, slot, identity)) continue;
      const entry = tasks?.products.get(product.id), queued = this.queue.find(item => item.key === key);
      if (queued && entry) { queued.product = product; queued.expiresAt = new Date(entry.observedAt + tasks.freshnessMs).toISOString(); }
      if (this.queuedKeys.has(key) || tasks?.reason(product.id, key, identity)) continue;
      const legacySignature = this._storage().records[`funbox:${product.id}`]?.stockOutSignature;
      if (legacySignature && legacySignature === funboxInventorySignature(product)) continue;
      this.queue.push({ key, platform: 'funbox', product, accountSlot: slot, accountIdentity: identity,
        continuous: Boolean(tasks), discoveryOrder: this.funboxProductOrder.get(product.id), rank: this.funboxQueueRandom(),
        enqueuedAt: new Date().toISOString(), expiresAt: new Date(tasks ? entry.observedAt + tasks.freshnessMs : Date.now() + 120000).toISOString() });
      this.queuedKeys.add(key); accepted++;
    }
    return accepted;
  }

  _clearEsliteEvent() {
    this.esliteRestockTasks?.reset();
    this.esliteProductOrder.clear();
    this.queue = this.queue.filter(item => {
      if (item.platform !== 'eslite' || !item.continuous) return true;
      this.queuedKeys.delete(item.key);
      return false;
    });
  }

  _esliteEligible(product, config) {
    return purchasePolicy('eslite', product, config.eslite).eligible;
  }

  _eslitePriority(product, config = normalizeAutoPurchaseConfig(this.getConfig())) {
    const index = config.eslite.priorityKeywords.findIndex(keyword => containsFunboxKeyword(product.title, keyword));
    return { index: index < 0 ? Number.MAX_SAFE_INTEGER : index, keyword: index < 0 ? '' : config.eslite.priorityKeywords[index] };
  }

  _sortEsliteQueue() {
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const pending = sortPurchaseTasks(this.queue.filter(item => item.platform === 'eslite' && item.accountSlot), config.eslite);
    let index = 0;
    this.queue = this.queue.map(item => item.platform === 'eslite' && item.accountSlot ? pending[index++] : item);
  }

  _esliteWaitingTasks(config) {
    const tasks = this.esliteRestockTasks;
    if (!tasks?.active()) return [];
    const storage = this._storage(), adapter = this.adapters.eslite;
    const waiting = [];
    for (const { product } of tasks.products.values()) {
      if (!this._esliteEligible(product, config)) continue;
      for (const slot of adapter.queueSlots()) {
        const identity = adapter.accountIdentity(slot), key = `eslite:${product.id}:${identity}`;
        if (!identity || this.queuedKeys.has(key) || storage.eslitePurchased?.[identity]?.[product.id]
          || COMPLETED_STATUSES.has(storage.records[key]?.status) || storage.records[key]?.purchaseStatus === 'purchase_limited') continue;
        waiting.push({ platform: 'eslite', accountSlot: slot, productId: product.id, title: product.title,
          blockedReason: adapter.queueBlockReason(slot, config.eslite) || tasks.reason(product.id, key, identity) || '等待新觀測派送',
          retryAt: tasks.attempts.get(key)?.nextAt ? new Date(tasks.attempts.get(key).nextAt).toISOString() : '' });
      }
    }
    return waiting;
  }

  observeEslitePurchaseProduct(product) {
    const tasks = this.esliteRestockTasks;
    if (!tasks) return;
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    if (this.paused || !config.enabled || !config.eslite.enabled || !this.isPlatformMonitoringEnabled('eslite')) {
      this._clearEsliteEvent();
      return;
    }
    if (!tasks.observe(product)) return;
    // No timer-driven re-submissions. This callback is invoked only by a new
    // official source observation, independent of public notification dedup.
    if (product.available && this._esliteEligible(product, config)) {
      void this.enqueue('eslite', [product], { observationOnly: true }).catch(error => this.log(purchaseErrorSummary(error)));
    }
    void this._schedule();
  }

  async enqueue(platform, products = [], { observationOnly = false } = {}) {
    if (this.paused) return { accepted: 0, ignored: products.length, reason: 'system_paused' };
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    if (!config.enabled || !config[platform]?.enabled || !this.adapters[platform]) {
      return { accepted: 0, ignored: products.length, reason: 'disabled' };
    }
    const storage = this._storage();
    let accepted = 0;
    let excluded = 0;
    for (const raw of products) {
      const product = compactProduct(raw);
      if (platform === 'eslite' && (raw.stock == null || raw.stock === '')) product.stock = null;
      if (!product.id || !product.url) continue;
      if (platform === 'funbox') {
        try {
          const slug = new URL(product.url).pathname.match(/\/products\/([^/?#]+)/i)?.[1];
          if (slug) product.id = decodeURIComponent(slug).trim().toLowerCase();
        } catch {
          // Keep the supplied id as a fallback for legacy/manual records.
        }
        const strategy = funboxPurchaseStrategy(product, config.funbox);
        if (!strategy.eligible) {
          excluded += 1;
          this.log(`私人自動購買略過：Funbox｜${product.title}｜${strategy.label}；公開通知維持。`);
          continue;
        }
        product.purchasePriority = strategy.priority;
        if (this.adapters.funbox.independentQueues) {
          accepted += this._enqueueFunboxTasks(product, raw, config, observationOnly);
          continue;
        }
      }
      if (platform === 'eslite') {
        const skippedKeyword = config.eslite.skipBuyKeywords.find((keyword) =>
          containsFunboxKeyword(product.title, keyword));
        if (skippedKeyword) {
          excluded += 1;
          this.log(`私人自動購買略過：誠品｜${product.title}｜命中黑名單 ${skippedKeyword}；公開通知維持。`);
          continue;
        }
        if (config.eslite.buyMode === 'whitelist'
          && !config.eslite.buyKeywords.some((keyword) => containsFunboxKeyword(product.title, keyword))) {
          excluded += 1;
          this.log(`私人自動購買略過：誠品｜${product.title}｜未命中購物網站白名單；公開通知維持。`);
          continue;
        }
        const adapter = this.adapters.eslite;
        if (adapter.independentQueues) {
          const continuous = Boolean(this.esliteRestockTasks);
          if (continuous) {
            if (!this.isPlatformMonitoringEnabled('eslite')) { this._clearEsliteEvent(); continue; }
            if (!observationOnly && (!['new_product', 'restock'].includes(raw.reason)
              || !this.esliteRestockTasks.observe(raw, { activate: true }))) continue;
          }
          storage.eslitePurchased ||= {};
          if (!this.esliteProductOrder.has(product.id)) this.esliteProductOrder.set(product.id, ++this.esliteDispatchSequence);
          for (const slot of adapter.queueSlots()) {
            const identity = adapter.accountIdentity(slot);
            if (!identity || storage.eslitePurchased[identity]?.[product.id]) continue;
            const key = `eslite:${product.id}:${identity}`;
            if (!this._plan({ platform, product, accountSlot: slot, accountIdentity: identity, key }, config).eligible) continue;
            if (continuous) {
              const entry = this.esliteRestockTasks.products.get(product.id);
              const queued = this.queue.find(item => item.key === key);
              if (queued && entry) {
                queued.product = product;
                queued.expiresAt = new Date(entry.observedAt + this.esliteRestockTasks.freshnessMs).toISOString();
              }
              if (this.esliteRestockTasks.reason(product.id, key, identity)) continue;
            }
            if (this.queuedKeys.has(key) || COMPLETED_STATUSES.has(storage.records[key]?.status)
              || storage.records[key]?.purchaseStatus === 'purchase_limited') continue;
            this.queue.push({ key, platform, product, accountSlot: slot, accountIdentity: identity, continuous,
              discoveryOrder: this.esliteProductOrder.get(product.id),
              rank: this.esliteQueueRandom(), enqueuedAt: new Date().toISOString(), expiresAt: new Date(continuous
                ? this.esliteRestockTasks.products.get(product.id).observedAt + this.esliteRestockTasks.freshnessMs
                : Date.now() + 120000).toISOString() });
            this.queuedKeys.add(key);
            accepted++;
          }
          continue;
        }
      }
      const key = `${platform}:${product.id}`;
      if (platform === 'funbox' && storage.records[key]?.stockOutSignature) {
        const previousSignature = String(storage.records[key].stockOutSignature);
        const currentSignature = funboxInventorySignature(product);
        if (previousSignature === currentSignature) continue;
        delete storage.records[key].stockOutSignature;
        delete storage.records[key].stockOutAt;
        this.log(`Funbox「${product.title}」官方庫存資料已變化，解除先前售罄保護並重新嘗試。`);
      }
      let completed = COMPLETED_STATUSES.has(storage.records[key]?.status)
        && !(platform === 'funbox' && storage.records[key]?.status === 'submitted_unconfirmed');
      if (platform === 'funbox' && !completed) {
        const accounts = this.adapters.funbox.credentialsStatus?.().accounts;
        const readySlots = Array.isArray(accounts)
          ? accounts.filter((account) => account.ready && account.enabled !== false).map((account) => account.slot)
          : [];
        if (readySlots.length) {
          product._targetSlots = readySlots.filter((slot) => !COMPLETED_STATUSES.has(storage.records[`${key}:${slot}`]?.status));
          completed = product._targetSlots.length === 0;
        }
      }
      if (this.queuedKeys.has(key) || completed) continue;
      if (platform === 'funbox') this.funboxPendingWave.set(key, { key, product });
      else this.queue.push({ key, platform, product, enqueuedAt: new Date().toISOString() });
      this.queuedKeys.add(key);
      accepted += 1;
    }
    if (platform === 'funbox' && accepted > 0 && !this.adapters.funbox.independentQueues) {
      if (!this.funboxWaveTimer) {
        this.funboxWaveTimer = setTimeout(() => this._flushFunboxWave(), FUNBOX_WAVE_COLLECT_MS);
        this.funboxWaveTimer.unref?.();
      }
    }
    if (accepted) {
      this.log(platform === 'funbox' && !this.adapters.funbox.independentQueues
        ? `私人自動購買：${PLATFORM_LABELS[platform]} 收入本輪 ${accepted} 件商品，等待 ${FUNBOX_WAVE_COLLECT_MS}ms 合單。`
        : `私人自動購買：${PLATFORM_LABELS[platform]} 已排入 ${accepted} 件商品。`);
      if (platform !== 'funbox' || this.adapters.funbox.independentQueues) {
        // Collect synchronous candidates from the same observation batch before
        // selecting an independently randomized order for each account.
        queueMicrotask(() => {
          this._sortEsliteQueue();
          this._sortFunboxQueue();
          void this._schedule();
        });
      }
    }
    return { accepted, ignored: Math.max(0, products.length - accepted), excluded };
  }

  _flushFunboxWave() {
    if (this.funboxWaveTimer) clearTimeout(this.funboxWaveTimer);
    this.funboxWaveTimer = null;
    const pending = [...this.funboxPendingWave.values()].sort((left, right) =>
      (left.product.purchasePriority ?? Number.MAX_SAFE_INTEGER)
      - (right.product.purchasePriority ?? Number.MAX_SAFE_INTEGER));
    this.funboxPendingWave.clear();
    if (!pending.length) return;
    if (typeof this.adapters.funbox?.purchaseBatch !== 'function') {
      this.queue.push(...pending.map(({ key, product }) => ({ key, platform: 'funbox', product })));
      void this._schedule();
      return;
    }
    this.funboxWaveSequence += 1;
    const products = pending.map((item) => item.product);
    const keys = pending.map((item) => item.key);
    this.queue.push({
      key: `funbox-wave:${Date.now()}:${this.funboxWaveSequence}`,
      keys,
      platform: 'funbox',
      products,
      product: {
        id: `wave-${this.funboxWaveSequence}`,
        title: `FUNBOX 合單｜${products.map((product) => product.title).join('＋')}`,
        url: products[0]?.url || '',
        detectedAt: products[0]?.detectedAt || new Date().toISOString()
      }
    });
    this.log(`私人自動購買：Funbox 第 ${this.funboxWaveSequence} 輪封箱，共 ${products.length} 款；A／B／C 各自建立完整購物車。`);
    void this._schedule();
  }

  _nextRunnableIndex() {
    return this.queue.findIndex((item) => {
      const adapter = this.adapters[item.platform];
      const limit = Math.max(1, Number(adapter?.maxConcurrency) || 1);
      if (item.accountSlot) {
        const settings = normalizeAutoPurchaseConfig(this.getConfig())[item.platform];
        if (settings.accountModes?.[item.accountSlot] === 'batch' && Date.now() < Date.parse(item.enqueuedAt) + settings.batchCollectMs) return false;
        if (this.activeEsliteSlots.has(`${item.platform}:${item.accountSlot}`)) return false;
        if (adapter.accountIdentity(item.accountSlot) !== item.accountIdentity) return true; // Drop stale account assignment in _processItem.
        if (adapter.queueBlockReason(item.accountSlot, normalizeAutoPurchaseConfig(this.getConfig())[item.platform])) return false;
        if (item.continuous && this._restockTasks(item.platform).reason(item.product.id, item.key, item.accountIdentity)) return false;
      }
      return (this.activeByPlatform.get(item.platform) || 0) < limit;
    });
  }

  async _schedule() {
    if (this.paused) return;
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      const config = normalizeAutoPurchaseConfig(this.getConfig());
      if (!config.enabled || !config.eslite.enabled || !this.isPlatformMonitoringEnabled('eslite')) this._clearEsliteEvent();
      if (!config.enabled || !config.funbox.enabled || !this.isPlatformMonitoringEnabled('funbox')) this._clearFunboxEvent();
      this._sortEsliteQueue();
      this._sortFunboxQueue();
      this._queueHeldEsliteChecks(config);
      const expired = this.queue.filter(item => item.expiresAt
        && Date.parse(item.expiresAt) <= (item.continuous ? this._restockTasks(item.platform).now() : Date.now()));
      if (expired.length) {
        this.queue = this.queue.filter(item => !expired.includes(item));
        for (const item of expired) {
          this.queuedKeys.delete(item.key);
          this.log(`${PLATFORM_LABELS[item.platform]}帳號 ${item.accountSlot}｜佇列逾期取消，未加車未送單｜${item.product.title}`);
          const record = { platform: item.platform, accountSlot: item.accountSlot, accountIdentity: item.accountIdentity,
            product: item.product, status: 'queue_expired', signalAt: item.enqueuedAt, completedAt: new Date().toISOString(),
            detail: item.continuous ? 'API 觀測已過期，未加車未送單；等下次新鮮可購觀測補回任務'
              : '佇列超過兩分鐘，未加車未送單；下一次真實補貨訊號可重新排隊', steps: [] };
          this._storage().records[item.key] = record;
          void this._recordEsliteAttempt(record).catch(error => this.log(purchaseErrorSummary(error)));
        }
        void this.state.save().catch(error => this.log(purchaseErrorSummary(error)));
      }
      while (this.activeWorkers < this.maxWorkers) {
        const index = this._nextRunnableIndex();
        if (index < 0) break;
        const [item] = this.queue.splice(index, 1);
        if (item.accountSlot && config[item.platform].accountModes?.[item.accountSlot] === 'batch') {
          item.batchItems = selectAccountBatch(item, this.queue, config[item.platform], candidate => this._plan(candidate, config).eligible
            && (!candidate.continuous || !this._restockTasks(candidate.platform).reason(candidate.product.id, candidate.key, candidate.accountIdentity))
            && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now()));
          this.queue = this.queue.filter(candidate => !item.batchItems.includes(candidate));
        }
        if (item.accountSlot) this.activeEsliteSlots.add(`${item.platform}:${item.accountSlot}`);
        this.activeWorkers += 1;
        this.activeByPlatform.set(item.platform, (this.activeByPlatform.get(item.platform) || 0) + 1);
        void this._processItem(item).catch(error => {
          this.log(`購買工作異常停止：${purchaseErrorSummary(error)}`);
          const record = this._storage().records[item.key];
          if (record?.status === 'processing' && record.accountSlot) {
            record.status = 'submitted_unconfirmed';
            record.detail = '工作異常中止，保留查單保護；不自動重送';
            const adapter = this.adapters[item.platform]?.adapters?.[record.accountSlot];
            if (adapter) adapter.purchaseHold = { productId: item.product.id, quantity: record.quantity || 1, startedAt: record.startedAt };
            void this.state.save().catch(() => {});
          }
        }).finally(() => {
          if (item.accountSlot) this.activeEsliteSlots.delete(`${item.platform}:${item.accountSlot}`);
          this.activeWorkers -= 1;
          const remaining = (this.activeByPlatform.get(item.platform) || 1) - 1;
          if (remaining > 0) this.activeByPlatform.set(item.platform, remaining);
          else this.activeByPlatform.delete(item.platform);
          if (!this.activeWorkers && !this.queue.length && !this.funboxPendingWave.size && !this.funboxWaveTimer) {
            const resolvers = this.idleResolvers.splice(0);
            resolvers.forEach((resolve) => resolve());
          }
          void this._schedule();
        });
      }
    } finally {
      this.scheduling = false;
      if (this.esliteQueueTimer) clearTimeout(this.esliteQueueTimer);
      const deadlines = this.queue.filter(item => item.expiresAt).map(item => Date.parse(item.expiresAt)
        - (item.continuous ? this._restockTasks(item.platform).now() : Date.now()));
      const dispatchConfig = normalizeAutoPurchaseConfig(this.getConfig());
      for (const item of this.queue) if (dispatchConfig[item.platform].accountModes?.[item.accountSlot] === 'batch') {
        const wait = Date.parse(item.enqueuedAt) + dispatchConfig[item.platform].batchCollectMs - Date.now();
        if (wait > 0) deadlines.push(wait);
      }
      if (deadlines.length) {
        // Local readiness polling only; no storefront request is made here.
        this.esliteQueueTimer = setTimeout(() => void this._schedule(), Math.max(1, Math.min(1000, ...deadlines)));
        this.esliteQueueTimer.unref?.();
      }
      if (!this.activeWorkers && !this.queue.length && !this.funboxPendingWave.size && !this.funboxWaveTimer) {
        this.idleResolvers.splice(0).forEach(resolve => resolve());
      }
    }
  }

  async _processFunboxWave(item) {
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const settings = config.funbox;
    const products = Array.isArray(item.products) ? item.products : [];
    const keys = Array.isArray(item.keys) ? item.keys : products.map((product) => `funbox:${product.id}`);
    if (!config.enabled || !settings?.enabled || !products.length) {
      keys.forEach((key) => this.queuedKeys.delete(key));
      return;
    }
    const storage = this._storage();
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    for (let index = 0; index < products.length; index += 1) {
      storage.records[keys[index]] = {
        ...(storage.records[keys[index]] || {}),
        platform: 'funbox', product: products[index], status: 'processing', startedAt
      };
    }
    await this.state.save();
    const sameProduct = (left, right) => String(left?.id || left?.url || '') === String(right?.id || right?.url || '')
      || String(left?.url || '') === String(right?.url || '');
    try {
      const result = await this.adapters.funbox.purchaseBatch(products, {
        ...settings,
        productRisk: (product) => this._funboxProductRisk(product, startedAtMs)
      });
      const completedAt = new Date().toISOString();
      const waveRecord = {
        platform: 'funbox', product: item.product, products, ...result, startedAt, completedAt, wave: true
      };
      storage.recent.unshift(waveRecord);
      storage.recent = storage.recent.slice(0, 30);
      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        const key = keys[index];
        const targetSlots = Array.isArray(product._targetSlots)
          ? product._targetSlots
          : result.accountResults.map((account) => account.slot);
        for (const account of result.accountResults) {
          if (!targetSlots.includes(account.slot)) continue;
          const purchased = (account.products || []).some((candidate) => sameProduct(candidate, product));
          const wave = (account.waves || []).find((candidate) =>
            (candidate.products || []).some((waveProduct) => sameProduct(waveProduct, product)));
          const accountStatus = purchased
            ? (wave?.status || account.status || 'ordered')
            : (account.deferredProducts || []).some((candidate) => sameProduct(candidate, product))
              ? 'deferred'
              : (account.status || 'failed');
          storage.records[`${key}:${account.slot}`] = {
            platform: 'funbox', product, slot: account.slot, payment: account.payment,
            status: accountStatus, purchaseStatus: funboxPurchaseResultStatus({ status: accountStatus }),
            orderNumber: wave?.orderNumber || '', resultUrl: wave?.resultUrl || '', completedAt
          };
        }
        const allAccountsComplete = targetSlots.length > 0 && targetSlots.every((slot) =>
          COMPLETED_STATUSES.has(storage.records[`${key}:${slot}`]?.status));
        storage.records[key] = {
          platform: 'funbox', product,
          status: allAccountsComplete ? 'ordered' : 'partial',
          accountResults: result.accountResults,
          completedAt
        };
      }
      await this.state.save();
      await this._notifyFunboxBatchResults(products, result.accountResults);
      this.log(`私人自動購買完成：Funbox 合單｜${products.length} 款｜${result.detail}`);
    } catch (error) {
      const completedAt = new Date().toISOString();
      const accountResults = Array.isArray(error.accountResults) ? error.accountResults : [];
      const wavePurchaseStatus = funboxPurchaseResultStatus({
        status: 'failed', purchaseStatus: error.purchaseStatus, error: error.message
      });
      const confirmedStockOut = wavePurchaseStatus === 'stock_out';
      storage.recent.unshift({
        platform: 'funbox', product: item.product, products, status: wavePurchaseStatus,
        error: error.message, accountResults, startedAt, completedAt, wave: true
      });
      storage.recent = storage.recent.slice(0, 30);
      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        const key = keys[index];
        const targetSlots = Array.isArray(product._targetSlots)
          ? product._targetSlots
          : accountResults.map((account) => account.slot);
        for (const account of accountResults) {
          if (!targetSlots.includes(account.slot)) continue;
          const purchased = (account.products || []).some((candidate) => sameProduct(candidate, product));
          const wave = (account.waves || []).find((candidate) =>
            (candidate.products || []).some((waveProduct) => sameProduct(waveProduct, product)));
          const accountStatus = purchased
            ? (wave?.status || 'ordered')
            : (account.deferredProducts || []).some((candidate) => sameProduct(candidate, product))
              ? 'deferred'
              : (account.status || 'failed');
          storage.records[`${key}:${account.slot}`] = {
            platform: 'funbox', product, slot: account.slot, payment: account.payment,
            status: accountStatus, purchaseStatus: funboxPurchaseResultStatus({ status: accountStatus }),
            orderNumber: wave?.orderNumber || '', resultUrl: wave?.resultUrl || '',
            error: purchased ? '' : account.error || error.message, completedAt
          };
        }
        const allAccountsComplete = targetSlots.length > 0 && targetSlots.every((slot) =>
          COMPLETED_STATUSES.has(storage.records[`${key}:${slot}`]?.status));
        storage.records[key] = {
          platform: 'funbox', product,
          status: allAccountsComplete ? 'ordered' : confirmedStockOut ? 'stock_out' : 'partial',
          error: error.message, accountResults, completedAt,
          ...(confirmedStockOut ? {
            stockOutSignature: funboxInventorySignature(product),
            stockOutAt: completedAt
          } : {})
        };
      }
      await this.state.save();
      if (accountResults.length) await this._notifyFunboxBatchResults(products, accountResults);
      else {
        const message = formatPlatformPurchaseNotification('funbox', item.product, {
          status: 'failed', error: error.message
        });
        await this._deliverPrivateResult(message).catch(() => {});
      }
      this.log(`私人自動購買失敗：Funbox 合單｜${products.length} 款｜${error.message}`);
    } finally {
      keys.forEach((key) => this.queuedKeys.delete(key));
    }
  }

  async _processItem(item) {
    const members = item.batchItems || [item];
    const releaseKeys = () => members.forEach(member => this.queuedKeys.delete(member.key));
    if (item.continuous && (this._restockTasks(item.platform).reason(item.product.id, item.key, item.accountIdentity)
      || !(item.platform === 'funbox' ? funboxPurchaseStrategy(item.product, normalizeAutoPurchaseConfig(this.getConfig()).funbox).eligible
        : this._esliteEligible(item.product, normalizeAutoPurchaseConfig(this.getConfig()))))) {
      releaseKeys();
      return;
    }
    if (item.accountSlot && !this.isPlatformMonitoringEnabled(item.platform)) {
      releaseKeys();
      return;
    }
    if (item.accountSlot && (this.adapters[item.platform].accountIdentity(item.accountSlot) !== item.accountIdentity
      || !this._plan(item).eligible)) {
      releaseKeys();
      this.log(`${PLATFORM_LABELS[item.platform]}帳號 ${item.accountSlot}｜取消過期帳號指派或已購商品｜${item.product.title}`);
      return;
    }
    if (item.platform === 'funbox' && Array.isArray(item.products) && !item.accountSlot) {
      return this._processFunboxWave(item);
    }
    const config = normalizeAutoPurchaseConfig(this.getConfig());
    const settings = config[item.platform];
    if (!config.enabled || !settings?.enabled) {
      releaseKeys();
      return;
    }
    const storage = this._storage();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const taskId = `${item.platform}-${startedAtMs}-${item.product.id}${item.accountSlot ? `-${item.accountSlot}` : ''}`;
    const batch = members.filter(member => this._plan(member, config).eligible).map(member => ({ ...member.product, quantity: this._plan(member, config).quantity }));
    const isBatch = Boolean(item.batchItems);
    const saveBoundary = () => this.state.writeSnapshot ? this.state.writeSnapshot() : this.state.save();
    const steps = [];
    const emitStep = raw => {
      const step = safePurchaseStep({ ...raw, at: raw.at || new Date().toISOString(), elapsedMs: Date.now() - startedAtMs });
      steps.push(step);
      const current = storage.records[item.key];
      if (current?.taskId === taskId) current.steps = steps;
      return this._recordEsliteStep(current, step).catch(error => this.log(`步驟紀錄保存失敗：${purchaseErrorSummary(error)}`));
    };
    storage.records[item.key] = {
      ...(storage.records[item.key] || {}),
      platform: item.platform,
      product: item.product,
      ...(isBatch ? { products: batch, mode: 'batch' } : { mode: 'single' }),
      status: 'processing',
      startedAt, taskId, steps, signalAt: item.enqueuedAt || startedAt,
      ...(item.accountIdentity ? { accountIdentity: item.accountIdentity, accountSlot: item.accountSlot } : {})
    };
    const priorityKeyword = item.accountSlot ? (item.platform === 'funbox' ? this._funboxPriority(item.product, config) : this._eslitePriority(item.product, config)).keyword : '';
    storage.records[item.key].priorityKeyword = priorityKeyword;
    if ((item.platform === 'eslite' || item.accountSlot) && this.state.writeSnapshot) {
      // Assignment below is the durable boundary before any storefront write.
      // Do not spend two 350ms debounce periods before starting that boundary.
      void this.state.save().catch(error => this.log(`購買排隊狀態保存失敗：${purchaseErrorSummary(error)}`));
    } else await this.state.save();
    let officialResult = null;
    try {
      const result = await this.adapters[item.platform].purchase(item.product, item.platform === 'eslite' || item.accountSlot ? {
        ...settings,
        accountSlot: item.accountSlot,
        accountIdentity: item.accountIdentity,
        continuous: item.continuous,
        quantity: batch[0]?.quantity || settings.quantity,
        plannedQuantity: batch[0]?.quantity,
        ...(isBatch ? { batchProducts: batch, maxTotal: settings.batchMaxTotal } : {}),
        taskSequence:item.discoveryOrder||1,
        onAccountAssigned: async (slot) => {
          storage.records[item.key].accountSlot = slot;
          if (item.accountIdentity) this._ledger().reserve(taskId, item.platform, item.accountIdentity, batch.map(p => ({ id: p.id, quantity: p.quantity })), startedAt);
          await saveBoundary();
        },
        onBeforeSubmit: async intent => {
          const record = storage.records[item.key];
          if (intent.products?.length) record.products = intent.products;
          record.submitIntent = {...intent,at:new Date().toISOString()};
          if (this.state.writeSnapshot) await this.state.writeSnapshot();
          else await this.state.save();
        },
        onStep: emitStep
      } : settings);
      officialResult = result;
      const record = {
        platform: item.platform,
        product: item.product,
        ...result,
        taskId, steps, signalAt: item.enqueuedAt || startedAt,
        accountSlot: result.accountSlot || storage.records[item.key].accountSlot || '',
        ...(item.accountIdentity ? { accountIdentity: item.accountIdentity } : {}),
        startedAt,
        durationMs: Number(result.durationMs) || (Date.now() - startedAtMs),
        completedAt: new Date().toISOString()
      };
      record.mode = isBatch ? 'batch' : 'single';
      if (isBatch && !record.products?.length && ['ordered', 'success'].includes(record.status)) {
        record.status = 'submitted_unconfirmed'; record.detail = '合單缺少已核對品項清單，保留帳號保護';
      }
      if (isBatch && ['ordered', 'success'].includes(record.status) && (new Set(record.products.map(p => p.id)).size !== record.products.length
        || record.products.some(p => !Number.isInteger(Number(p.quantity)) || Number(p.quantity) < 1
          || !batch.some(planned => planned.id === p.id && Number(p.quantity) <= planned.quantity)))) {
        record.status = 'submitted_unconfirmed'; record.detail = '合單回傳品項或數量超出本批派單，保留帳號保護';
        record.products = storage.records[item.key]?.submitIntent?.products || batch;
      }
      if (isBatch && !record.products?.length) record.products = storage.records[item.key]?.submitIntent?.products || batch;
      if (isBatch) record.quantity = record.products.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
      if (item.accountSlot && ['ordered', 'success', 'payment_failed', '3ds_pending'].includes(record.status) && !(record.orderNumber || record.orderId)) {
        record.status = 'submitted_unconfirmed'; record.purchaseStatus = 'submitted_unconfirmed';
        record.detail = '尚無可驗證訂單編號，保留帳號核對保護，不宣告成功';
      }
      if (record.status === 'submitted_unconfirmed' && item.accountSlot) {
        const child = this.adapters[item.platform]?.adapters?.[item.accountSlot];
        if (child) child.purchaseHold = { productId: item.product.id, products: record.products, quantity: record.quantity || batch[0]?.quantity, startedAt };
      }
      storage.records[item.key] = record;
      const receiptItems = (record.products?.length ? record.products : [{ ...item.product, quantity: record.quantity || batch[0]?.quantity || 1 }])
        .map(p => ({ id: p.id, quantity: Number(p.quantity) || 1 }));
      this._ledger().settle(taskId, { ...record, items: receiptItems });
      if (isBatch) for (const member of members) {
        const bought = receiptItems.find(p => p.id === member.product.id);
        const skipped = record.skippedProducts?.find(p => p.id === member.product.id);
        const excluded = Boolean(skipped) || !bought;
        storage.records[member.key] = { ...record, product: member.product, quantity: bought?.quantity || 0,
          status: excluded ? 'skipped' : record.status, products: record.products,
          batchParentStatus: record.status,
          ...(skipped ? { purchaseStatus: skipped.reason, detail: skipped.reason === 'batch_deferred'
            ? '本車封箱時間到，尚未加車；等待新庫存觀測後接續下一單' : skipped.reason } : {}) };
        if (!excluded && bought && ['ordered', 'success'].includes(record.status)) {
          storage[`${item.platform}Purchased`] ||= {}; storage[`${item.platform}Purchased`][item.accountIdentity] ||= {};
          storage[`${item.platform}Purchased`][item.accountIdentity][member.product.id] = { orderNumber: record.orderNumber, orderId: record.orderId,
            purchasedAt: record.completedAt, quantity: bought?.quantity || 1 };
        }
      }
      if (item.platform === 'funbox' && item.accountIdentity && ['ordered', 'success'].includes(record.status) && record.orderNumber) {
        storage.funboxPurchased ||= {}; storage.funboxPurchased[item.accountIdentity] ||= {};
        if (receiptItems.some(p => p.id === item.product.id)) storage.funboxPurchased[item.accountIdentity][item.product.id] = { orderNumber: record.orderNumber, purchasedAt: record.completedAt, quantity: receiptItems.find(p => p.id === item.product.id).quantity };
      }
      if (item.platform === 'eslite' && item.accountIdentity && record.status === 'ordered' && record.orderId) {
        storage.eslitePurchased ||= {};
        storage.eslitePurchased[item.accountIdentity] ||= {};
        if (receiptItems.some(p => p.id === item.product.id)) storage.eslitePurchased[item.accountIdentity][item.product.id] = {
          orderId: record.orderId, purchasedAt: record.completedAt, source: record.reconciled ? 'official_query' : 'checkout_response'
        };
      }
      if (record.detail) record.detail = safePurchaseText(record.detail);
      if (record.error) record.error = purchaseErrorSummary(record.error);
      emitStep({ label: record.status === 'ordered' ? '訂單成立' : record.status === 'submitted_unconfirmed' ? '結果不明／帳號保護' : '本次流程完成', state: record.status === 'submitted_unconfirmed' ? 'unknown' : 'success', reason: record.detail });
      if (item.accountSlot) emitStep({ label: '私人通知排隊（不阻塞後續購買）', reason:'購買結果已交給通知流程；尚未代表通知送達，下單佇列可繼續處理下一件', state: 'info' });
      storage.recent.unshift(record);
      storage.recent = storage.recent.slice(0, 30);
      await this.state.save().catch(error => {
        this.log(`購買結果狀態保存失敗：${purchaseErrorSummary(error)}`);
        if (item.accountSlot) {
          const adapter = this.adapters[item.platform]?.adapters?.[record.accountSlot];
          if (adapter) adapter.purchaseHold = { productId: item.product.id, startedAt, quantity: record.quantity || settings.quantity, reason: '結果保存失敗' };
        }
      });
      await this._recordEsliteAttempt(record).catch((error) => this.log(`誠品永久購買紀錄寫入失敗：${error.message}`));
      if (item.platform === 'funbox' && Array.isArray(result.accountResults)) {
        await this._notifyFunboxAccountResults(item.product, result.accountResults);
      } else {
        const displayProduct = isBatch ? { ...item.product, title: record.products.map(p => `${p.title || p.id} ×${p.quantity}`).join(' ＋ ') } : item.product;
        const message = item.platform === 'funbox' && item.accountSlot ? (isBatch ? formatFunboxAccountBatchNotification(batch, { slot: item.accountSlot, payment: record.payment, waves: [record], products: ['ordered', 'success'].includes(record.status) ? record.products : [], deferredProducts: record.skippedProducts || [], ok: ['ordered', 'success'].includes(record.status), error: record.status === 'submitted_unconfirmed' ? '送單結果待核對；禁止重送' : record.error }) : formatFunboxAccountPurchaseNotification(item.product, record)) : formatPlatformPurchaseNotification(item.platform, displayProduct, record);
        if (item.accountSlot || item.platform === 'eslite') await this._queuePrivateResult(message, record);
        else await this._deliverPrivateResult(message).catch(error => this.log(`私人購買通知失敗：${purchaseErrorSummary(error)}`));
      }
      this.log(`私人自動購買${result.status === 'submitted_unconfirmed' ? '待核對' : '流程完成'}：${PLATFORM_LABELS[item.platform]}｜${item.product.title}｜${safePurchaseText(result.detail)}`);
    } catch (error) {
      const record = {
        platform: item.platform,
        product: item.product,
        ...(officialResult?.orderNumber ? { orderNumber: officialResult.orderNumber } : {}),
        ...(officialResult?.orderId ? { orderId: officialResult.orderId } : {}),
        status: (officialResult && (officialResult.status === 'submitted_unconfirmed' || officialResult.orderNumber || officialResult.orderId)) || error.orderSubmitted || error.purchaseStatus === 'submitted_unconfirmed' ? 'submitted_unconfirmed' : item.platform === 'funbox'
          ? funboxPurchaseResultStatus({ status: 'failed', purchaseStatus: error.purchaseStatus, error: error.message })
          : 'failed',
        error: purchaseErrorSummary(error),
        purchaseStatus: error.purchaseStatus || 'failed',
        startedAt,
        taskId, steps, signalAt: item.enqueuedAt || startedAt,
        accountSlot: error.accountSlot || storage.records[item.key].accountSlot || '',
        ...(item.accountIdentity ? { accountIdentity: item.accountIdentity } : {}),
        payment: error.payment || '',
        durationMs: Number(error.durationMs) || (Date.now() - startedAtMs),
        ...(error.timings ? { timings: error.timings } : {}),
        ...(Array.isArray(error.accountResults) ? { accountResults: error.accountResults } : {}),
        completedAt: new Date().toISOString()
      };
      record.mode = isBatch ? 'batch' : 'single';
      if (isBatch) record.products = storage.records[item.key]?.submitIntent?.products || error.products || batch;
      storage.records[item.key] = record;
      this._ledger().settle(taskId, record);
      if (isBatch) for (const member of members) storage.records[member.key] = { ...record, product: member.product };
      if (record.status === 'submitted_unconfirmed' && item.accountSlot) {
        const adapter = this.adapters[item.platform]?.adapters?.[item.accountSlot];
        if (adapter) adapter.purchaseHold = { productId: item.product.id, products: record.products, quantity: batch[0]?.quantity, startedAt, reason: '送單結果待核對' };
      }
      emitStep({ label: '本次停止／未確認成立', state: 'failed', reason: record.error });
      if (item.accountSlot) emitStep({ label: '私人通知排隊（不阻塞後續購買）', reason:'失敗／待核對結果交給通知流程；通知不會阻塞其他帳號購買', state: 'info' });
      storage.recent.unshift(record);
      storage.recent = storage.recent.slice(0, 30);
      await this.state.save();
      await this._recordEsliteAttempt(record).catch((historyError) => this.log(`誠品永久購買紀錄寫入失敗：${historyError.message}`));
      if (item.platform === 'funbox' && Array.isArray(error.accountResults)) {
        await this._notifyFunboxAccountResults(item.product, error.accountResults);
      } else {
        const message = item.platform === 'funbox' && item.accountSlot ? formatFunboxAccountPurchaseNotification(item.product, record) : formatPlatformPurchaseNotification(item.platform, item.product, record);
        if (item.accountSlot || item.platform === 'eslite') await this._queuePrivateResult(message, record);
        else await this._deliverPrivateResult(message).catch(notificationError => this.log(`私人購買失敗通知失敗：${purchaseErrorSummary(notificationError)}`));
      }
      this.log(`私人自動購買失敗：${PLATFORM_LABELS[item.platform]}｜${item.product.title}｜${purchaseErrorSummary(error)}`);
    } finally {
      for (const member of members) if (member.continuous) {
        const record = storage.records[member.key];
        const retryable = item.platform === 'funbox' && record.status === 'failed'
          && /timeout|timed out|ECONN|ENET|socket|HTTP\s*(?:500|502|503|504)|逾時|中斷|暫時|連線/i.test(record.error || '');
        const completed = retryable ? { ...record, purchaseStatus: 'precheckout_unavailable' } : { ...record };
        if (item.platform === 'funbox') {
          completed.quotaDay = taipeiPurchaseDay(this.funboxRestockTasks.now());
          completed.allowQuotaContinuation = ['ordered', 'success'].includes(record.status) && this._plan(member, config).eligible;
        }
        this._restockTasks(item.platform).complete(member.product.id, member.key, completed, item.accountIdentity);
      }
      releaseKeys();
    }
  }

  async _notifyFunboxAccountResults(product, accountResults) {
    const deliveries = await Promise.allSettled(accountResults.map((accountResult) => {
      const message = formatFunboxAccountPurchaseNotification(product, accountResult);
      return this._deliverPrivateResult(message);
    }));
    const failed = deliveries.filter((delivery) => delivery.status === 'rejected');
    if (failed.length) {
      this.log(`Funbox 多帳號購買結果完成，但有 ${failed.length} 則私人 Discord 通知傳送失敗。`);
    }
  }

  async _notifyFunboxBatchResults(products, accountResults) {
    const deliveries = await Promise.allSettled(accountResults.map((accountResult) =>
      this._deliverPrivateResult(formatFunboxAccountBatchNotification(products, accountResult))));
    const failed = deliveries.filter((delivery) => delivery.status === 'rejected');
    if (failed.length) this.log(`Funbox 合單結果完成，但有 ${failed.length} 則私人 Discord 通知傳送失敗。`);
  }

  async _notifyFunboxAssignmentResults(accountResults) {
    const deliveries = await Promise.allSettled(accountResults.map((accountResult) => {
      const message = formatFunboxAccountPurchaseNotification(accountResult.product, accountResult);
      return this._deliverPrivateResult(message);
    }));
    const failed = deliveries.filter((delivery) => delivery.status === 'rejected');
    if (failed.length) {
      this.log(`Funbox 一對一購買結果完成，但有 ${failed.length} 則私人 Discord 通知傳送失敗。`);
    }
  }

  async _deliverPrivateResult(message) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.notifyPrivate(message.text, {
          discordPreview: message.preview,
          discordAudience: 'private'
        });
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    throw lastError || new Error('私人 Discord 通知傳送失敗');
  }

  whenIdle() {
    if (!this.activeWorkers && !this.queue.length && !this.funboxPendingWave.size && !this.funboxWaveTimer) {
      return Promise.allSettled([...this.privateDeliveries]);
    }
    return new Promise((resolve) => this.idleResolvers.push(resolve)).then(() => Promise.allSettled([...this.privateDeliveries]));
  }

  async testLogin(platform, options = {}) {
    const adapter = this.adapters[platform];
    if (!adapter) throw new Error('不支援這個購物平台');
    return adapter.testLogin({
      interactive: options.interactive !== false,
      accountSlot: options.accountSlot,
      manualOnly: options.manualOnly === true
    });
  }

  async accountAction({ platform, accountSlot, action } = {}) {
    if (action === 'clear-all-carts') return this.clearAllAccountCarts(platform);
    if (platform === 'funbox' && this._storage?.()?.externalAccountReservations?.[accountSlot]) throw new Error('此帳號由特別任務保留，跳過一般帳號工具');
    if (!['funbox', 'eslite'].includes(platform) || !isEsliteAccountSlot(accountSlot)
      || !['clear-cart', 'open-browser'].includes(action)) throw new Error('平台、帳號或操作不正確');
    const multi = this.adapters[platform];
    multi?._syncAccounts();
    const adapter = multi?.adapters[accountSlot];
    if (!adapter?.credentialsStatus().ready) throw new Error('此帳號尚未設定');
    if (this.maintenanceRunning || this.activeEsliteSlots?.has(`${platform}:${accountSlot}`) || multi.busySlots?.has(accountSlot) || multi.accountPurchaseTails?.has(accountSlot)
      || adapter.accountBusy || adapter.sessionVerifyRunning || adapter.warmWorkerCreating
      || adapter.warmWorkers?.some(worker => worker.busy)) throw new Error('此帳號正在執行，請稍後再試');
    if (action === 'clear-cart' && (adapter.activePurchaseHold() || adapter.accountBrowser || adapter.interactiveLogin)) {
      throw new Error('此帳號有待核對訂單或瀏覽器使用中，禁止清車；請先核對並關閉視窗');
    }
    // Reserve synchronously before the first await. A queued purchase must
    // never slip between the guard and an account-level cart mutation.
    let release;
    const reservation = new Promise(resolve => { release = resolve; });
    multi.accountPurchaseTails?.set(accountSlot, reservation);
    multi.busySlots?.add(accountSlot);
    try {
      if (action === 'open-browser') return await adapter.openAccountBrowser(() => { void this._schedule(); });
      let result;
      try {
        if (platform === 'eslite') result = await adapter.maintainSession({ clearCart: true });
        else {
          let worker;
          try {
            worker = await adapter._acquireWarmWorker({ apiOnly: true });
            await adapter._ensureWarmWorkerLogin(worker);
            const evidence = await clearFunboxCart(worker.context);
            adapter.lastCartClearEvidence = { ...evidence, state: 'empty_verified' };
            result = { ok: true, removed: evidence.removed };
          } finally { await adapter._releaseWarmWorker(worker); }
        }
        if (!result.ok) throw new Error(result.error || result.reason || '官方尚未確認清車完成');
        adapter.cartActionUncertain = false;
      } catch (error) { adapter.cartActionUncertain = true; error.cartClearAttempted = true; throw error; }
      return { ok: true, removed: result.removed || 0, message: `${PLATFORM_LABELS[platform]} 帳號 ${accountSlot}：已清空並由官方重新確認，移除 ${result.removed || 0} 款商品；未送單。` };
    } finally {
      release();
      if (multi.accountPurchaseTails?.get(accountSlot) === reservation) multi.accountPurchaseTails.delete(accountSlot);
      multi.busySlots?.delete(accountSlot);
      void this._schedule();
    }
  }

  async clearAllAccountCarts(platform) {
    if (!['funbox', 'eslite'].includes(platform)) throw new Error('不支援這個購物平台');
    const multi = this.adapters[platform];
    multi?._syncAccounts();
    const entries = Object.entries(multi?.adapters || {}).filter(([, adapter]) => adapter.credentialsStatus().ready);
    // Launch synchronously: accountAction reserves each idle slot before its
    // first await. Busy/held slots are skipped, never queued for a later clear.
    const results = await Promise.all(entries.map(async ([accountSlot]) => {
      try {
        const result = await this.accountAction({ platform, accountSlot, action: 'clear-cart' });
        return { accountSlot, status: 'cleared', removed: result.removed || 0 };
      } catch (error) {
        return { accountSlot, status: error.cartClearAttempted ? 'failed' : 'skipped', reason: purchaseErrorSummary(error) };
      }
    }));
    const cleared = results.filter(item => item.status === 'cleared').length;
    const skipped = results.filter(item => item.status === 'skipped').length;
    const failed = results.filter(item => item.status === 'failed').length;
    const removed = results.reduce((sum, item) => sum + (item.removed || 0), 0);
    const details = results.filter(item => item.status !== 'cleared').map(item => `${item.accountSlot}：${item.reason}`).join('；');
    return { ok: failed === 0 && skipped === 0, results, cleared, skipped, failed, removed,
      message: `${PLATFORM_LABELS[platform]} 全清完成：${cleared}/${entries.length} 個帳號已確認空車，移除 ${removed} 款；跳過 ${skipped}、失敗 ${failed}。${details ? ' ' + details : ''}${entries.length ? '' : ' 尚無已設定帳號。'}` };
  }

  async completeLogin(platform, options = {}) {
    const adapter = this.adapters[platform];
    if (!adapter) throw new Error('不支援這個購物平台');
    if (typeof adapter.completeLogin !== 'function') throw new Error('此平台尚未支援手動登入確認');
    return adapter.completeLogin({ accountSlot: options.accountSlot });
  }

  async reset(platform, productId) {
    const key = `${platform}:${productId}`;
    const records = this._storage().records;
    if (Object.values(records).some(record => record.platform === platform && record.product?.id === productId && record.status === 'submitted_unconfirmed')) {
      throw new Error('此筆送單結果尚未確認，不能重設防重送紀錄；請先至官方會員訂單核對。');
    }
    delete records[key];
    if (platform === 'funbox') {
      for (const name of Object.keys(records)) if (name.startsWith(key + ':')) delete records[name];
      for (const purchased of Object.values(this._storage().funboxPurchased || {})) delete purchased[productId];
    }
    await this.state.save();
    return { message: '已清除這件商品的私人購買紀錄；下次重新補貨可再次執行。' };
  }

  _orderStatusBusy(platform) {
    const multi = this.adapters[platform];
    return this.activeWorkers > 0 || this.queue.length > 0 || this.maintenanceRunning
      || Boolean(multi?.busySlots?.size || multi?.accountPurchaseTails?.size)
      || Object.values(multi?.adapters || {}).some(adapter => adapter.accountBusy || adapter.interactiveLogin
        || adapter.warmWorkers?.some(worker => worker.busy));
  }

  refreshOrderStatuses(options) { return this.orderStatusRefresher.refresh(options); }

  async probeEslitePayments({ accountSlot, productId, cartOnly, cleanupOnly = false } = {}) {
    if (cartOnly !== true || !['A', 'D'].includes(accountSlot)) throw new Error('僅允許已授權的 A／D 帳號只加車核對，不送單');
    const multi = this.adapters.eslite;
    multi?._syncAccounts?.();
    const adapter = multi?.adapters?.[accountSlot];
    const hold = adapter?.activePurchaseHold();
    if (!adapter || this.activeWorkers || this.queue.length || adapter.accountBusy || adapter.interactiveLogin
      || hold && !(cleanupOnly && hold.scope === 'cart_probe' && hold.productId === productId))
      throw new Error('目前帳號或搶購流程忙碌／待核對，不進行探測');
    const identity = multi.accountIdentity(accountSlot);
    if (!identity) throw new Error('帳號尚未設定');
    multi.busySlots.add(accountSlot);
    try {
      return await adapter._withAccountLock(async () => {
        if (identity !== multi.accountIdentity(accountSlot)) throw new Error('帳號已變更，未加車');
        if (cleanupOnly) {
          if (hold?.accountIdentity !== identity) throw new Error('測試商品不是目前帳號，未刪除');
          const result = await cleanupEslitePaymentProbe({ api: await adapter._ensureApiContext(), hold, expectedAccount: adapter.getCredentials().account });
          if (result.cleanupConfirmed && result.remainingOtherItems === 0) {
            delete this._storage().esliteCartProbeHolds[accountSlot]; adapter.purchaseHold = null;
            adapter.apiCartKnownEmpty = true; adapter.apiReadyAtMs = Date.now(); await this.state.save();
          }
          return { ...result, accountSlot };
        }
        const result = await probeEslitePaymentChoices({ api: await adapter._ensureApiContext(), productId,
          expectedAccount: adapter.getCredentials().account });
        if (result.cartChanged) {
          adapter._resetApiReadiness();
          if (result.cleanupConfirmed && result.remainingOtherItems === 0) {
            adapter.apiCartKnownEmpty = true;
            adapter.apiReadyAtMs = Date.now();
          }
        }
        if (result.cartChanged && !result.cleanupConfirmed) {
          const hold = { scope: 'cart_probe', productId, cartItemId: result.cartItemId, accountIdentity: identity, startedAt: new Date().toISOString(),
            reason: '付款選項測試商品清理待核對；本次沒有送單' };
          adapter.purchaseHold = hold;
          this._storage().esliteCartProbeHolds ||= {};
          this._storage().esliteCartProbeHolds[accountSlot] = hold;
          await this.state.save();
        }
        return { ...result, accountSlot };
      });
    } finally { multi.busySlots.delete(accountSlot); void this._schedule(); }
  }

  async _readOrderStatus(platform, record) {
    const multi = this.adapters[platform];
    multi?._syncAccounts?.();
    const adapter = multi?.adapters?.[record.accountSlot];
    if (!adapter || !multi.accountIdentity(record.accountSlot)
      || record.accountIdentity && record.accountIdentity !== multi.accountIdentity(record.accountSlot)) throw new Error('原帳號已更換或未設定，保留訂單紀錄');
    if (this._orderStatusBusy(platform)) return { deferred: true };
    if (platform === 'eslite') return adapter._withAccountLock(async () => {
      const result = await readEsliteOrderStatus(await adapter._ensureApiContext(), record);
      if (record.accountIdentity && record.accountIdentity !== multi.accountIdentity(record.accountSlot)) throw new Error('查單途中帳號變更，保留原結果');
      return result;
    });
    // Reserve the same lock used by purchase; reuse only saved HTTP cookies, not
    // a checkout worker, browser page, login request, or cart endpoint.
    let release;
    const reservation = new Promise(resolve => { release = resolve; });
    multi.accountPurchaseTails.set(record.accountSlot, reservation);
    let api;
    try {
      api = await playwrightRequest.newContext({ storageState: adapter.sessionFile });
      const result = await readFunboxOrderStatus(api, record);
      if (record.accountIdentity && record.accountIdentity !== multi.accountIdentity(record.accountSlot)) throw new Error('查單途中帳號變更，保留原結果');
      return result;
    } finally {
      await api?.dispose();
      if (multi.accountPurchaseTails.get(record.accountSlot) === reservation) multi.accountPurchaseTails.delete(record.accountSlot);
      release();
      void this._schedule();
    }
  }

  async resolveFunboxHold({ accountSlot, confirmedNoOrder } = {}) {
    const slot = String(accountSlot || '').toUpperCase(), multi = this.adapters.funbox;
    if (!isEsliteAccountSlot(slot) || confirmedNoOrder !== true || multi?.accountPurchaseTails.has(slot)) throw new Error('請先核對官方訂單未成立，且帳號必須閒置');
    const adapter = multi?.adapters?.[slot];
    if (!adapter) throw new Error('找不到此 Funbox 帳號');
    const identity = multi.accountIdentity(slot), resolved = [];
    const reservationsBackup = structuredClone(this._ledger().data.reservations);
    // Reserve the account across persistence. No purchase may race a hold release.
    let release;
    const reservation = new Promise(resolve => { release = resolve; });
    multi.accountPurchaseTails.set(slot, reservation);
    try {
    for (const record of Object.values(this._storage().records)) {
      if (record.platform === 'funbox' && (record.accountSlot || record.slot) === slot
        && (!record.accountIdentity || record.accountIdentity === identity) && record.status === 'submitted_unconfirmed') {
        record.status = 'manually_confirmed_no_order'; record.resolvedAt = new Date().toISOString();
        resolved.push(record);
        await this._recordFunboxEvidence(record);
      }
    }
    for (const record of resolved) this._ledger().settle(record.taskId, { status: 'manually_confirmed_no_order' });
    await this.state.save(); adapter.purchaseHold = null;
    for (const record of resolved) {
      const id = canonicalFunboxProductId(record.product?.url, record.product?.id);
      this.funboxRestockTasks?.attempts.delete(`funbox:${id}:${identity}`);
      // Invalidate the old lease; only a subsequent official snapshot can renew it.
      const entry = this.funboxRestockTasks?.products.get(id);
      if (entry) entry.observedAt = 0;
    }
    return { message: `Funbox 帳號 ${slot} 已解除保護；需等下一次真實可購觀測，才會重新派送。` };
    } catch (error) {
      this._ledger().data.reservations = reservationsBackup;
      for (const record of resolved) record.status = 'submitted_unconfirmed';
      throw error;
    } finally {
      if (multi.accountPurchaseTails.get(slot) === reservation) multi.accountPurchaseTails.delete(slot);
      release();
    }
  }

  _syncEsliteRecordCopies(record) {
    const storage = this._storage();
    const same = item => item.platform === 'eslite' && item.accountSlot === record.accountSlot
      && (record.taskId ? item.taskId === record.taskId : item.startedAt === record.startedAt && item.product?.id === record.product?.id);
    const copies = storage.recent.filter(same);
    for (const copy of copies) Object.assign(copy, structuredClone(record));
    if (!copies.length) storage.recent.unshift(structuredClone(record));
    storage.recent = storage.recent.slice(0, 30);
  }

  async resolveEsliteHold({ accountSlot, confirmedNoOrder, taskId, taskIds } = {}) {
    const slot = String(accountSlot || '').toUpperCase();
    if (!isEsliteAccountSlot(slot) || confirmedNoOrder !== true) {
      throw new Error('必須先人工核對官方會員訂單，確認沒有成立訂單後，才能解除保護。');
    }
    if (taskIds != null && !Array.isArray(taskIds)) throw new Error('請提供明確的任務清單');
    const targets = [...new Set(taskId ? [taskId] : taskIds || [])];
    if (!targets.length || targets.length > 100 || targets.some(id => typeof id !== 'string' || !id || id.length > 250)) {
      throw new Error('請選擇要確認未成立的那筆任務，不能直接解除整個帳號的新訂單。');
    }
    const multi = this.adapters.eslite, adapter = multi?.adapters?.[slot];
    if (!adapter || adapter.accountBusy || multi.busySlots.has(slot) || adapter.sessionVerifyRunning
      || this.activeEsliteSlots.has(`eslite:${slot}`)) {
      throw new Error('此帳號正在處理，請稍後再解除保護。');
    }
    multi.busySlots.add(slot);
    try { return await adapter._withAccountLock(async () => {
      const identity = multi.accountIdentity?.(slot) || '';
      const records = Object.values(this._storage().records).filter((record) =>
        record.platform === 'eslite' && record.accountSlot === slot && record.status === 'submitted_unconfirmed'
        && targets.includes(record.taskId) && (!record.accountIdentity || record.accountIdentity === identity));
      if (records.length !== targets.length) throw new Error('這筆任務已更新、已核對或帳號已更換；請重新整理，不會解除其他訂單。');
      const originals = records.map(record => [record, structuredClone(record)]);
      const copies = this._storage().recent.filter(item => item.platform === 'eslite' && item.accountSlot === slot && targets.includes(item.taskId))
        .map(item => [item, structuredClone(item)]);
      const reservations = this._ledger().data.reservations;
      const reservationsBackup = new Map(targets.map(id => [id, reservations[id] ? structuredClone(reservations[id]) : null]));
      for (const record of records) {
        record.previousStatus = record.status;
        record.status = 'manually_confirmed_no_order';
        record.resolvedAt = new Date().toISOString();
        record.resolutionSource = 'user_confirmed_no_order';
        record.detail = '使用者已核對官方訂單並確認本筆未成立；釋放本筆額度，不清車、不重送本筆。';
        record.steps ||= [];
        record.steps.push(safePurchaseStep({ at: record.resolvedAt, label: '人工確認訂單未成立', state: 'success', stepNumber: 12,
          stepTitle: '核對正式訂單', reason: record.detail, elapsedMs: Math.max(0, Date.now() - (Date.parse(record.startedAt) || Date.now())) }));
        this._ledger().settle(record.taskId, { status: 'manually_confirmed_no_order' });
      }
      const recentBefore = [...this._storage().recent];
      for (const record of records) this._syncEsliteRecordCopies(record);
      try { await this.state.save(); }
      catch (error) {
        for (const [id, before] of reservationsBackup) { if (before) reservations[id] = before; else delete reservations[id]; }
        for (const [record, before] of [...originals, ...copies]) {
          for (const key of Object.keys(record)) delete record[key]; Object.assign(record, before);
        }
        // Remove only snapshots inserted for these targets; preserve updates
        // another account may have made while persistence was pending.
        this._storage().recent = this._storage().recent.filter(item => recentBefore.includes(item) || !targets.includes(item.taskId));
        throw error;
      }
      const remaining = Object.values(this._storage().records).filter(record => record.platform === 'eslite' && record.accountSlot === slot
        && record.status === 'submitted_unconfirmed' && (!record.accountIdentity || record.accountIdentity === identity));
      const pending = remaining[0];
      if (adapter.purchaseHold?.scope !== 'cart_probe') adapter.purchaseHold = pending
        ? { productId: pending.product?.id, quantity: pending.quantity || 1, startedAt: pending.startedAt } : null;
      adapter._resetApiReadiness();
      for (const record of records) await this._recordEsliteAttempt(record);
      return { resolved: records.length, pending: remaining.length,
        message: `帳號 ${slot}：${records.length} 筆已標記「人工確認未成立」，本筆額度已釋放。${pending ? '另有待核對訂單，帳號仍受保護。' : '帳號訂單保護已解除。'}未清車、未重送本筆；原始紀錄保留。` };
    }); } finally { multi.busySlots.delete(slot); }
  }

  _queueHeldEsliteChecks(config) {
    if (this.paused || !config.enabled || !config.eslite.enabled || !this.isPlatformMonitoringEnabled('eslite') || !this.esliteRestockTasks?.active()) return;
    for (const record of Object.values(this._storage().records)) {
      const slot = record.accountSlot;
      if (record.platform !== 'eslite' || record.status !== 'submitted_unconfirmed' || !slot
        || !this.adapters.eslite?.adapters?.[slot] || this.heldEsliteChecks.has(slot)
        || (record.holdRecheckCount || 0) >= 2 || !Number.isFinite(Date.parse(record.startedAt))
        || Date.now() - Date.parse(record.startedAt) > 5 * 60000) continue;
      const timer = setTimeout(() => {
        this.heldEsliteChecks.delete(slot);
        const work = this._runHeldEsliteCheck(record).catch(error => this.log(`誠品帳號 ${slot} 補查未完成：${purchaseErrorSummary(error)}`));
        this.heldEsliteWork.add(work); work.finally(() => {
          this.heldEsliteWork.delete(work);
          this._queueHeldEsliteChecks(normalizeAutoPurchaseConfig(this.getConfig()));
        });
      }, record.holdRecheckCount ? 30000 : 1000);
      timer.unref?.(); this.heldEsliteChecks.set(slot, timer);
    }
  }

  async _runHeldEsliteCheck(record) {
    const config = normalizeAutoPurchaseConfig(this.getConfig()), slot = record.accountSlot;
    const multi = this.adapters.eslite, adapter = multi?.adapters?.[slot];
    if (this.paused || !config.enabled || !config.eslite.enabled || !this.isPlatformMonitoringEnabled('eslite')
      || !this.esliteRestockTasks?.active() || record.status !== 'submitted_unconfirmed'
      || (record.holdRecheckCount || 0) >= 2 || !adapter || adapter.accountBusy || adapter.interactiveLogin
      || !Number.isFinite(Date.parse(record.startedAt)) || Date.now()-Date.parse(record.startedAt)>5*60000
      || multi.busySlots?.has(slot) || this.heldEsliteWork.size >= 2
      || record.accountIdentity && record.accountIdentity !== multi.accountIdentity(slot)) return;
    record.holdRecheckCount = (record.holdRecheckCount || 0) + 1;
    record.holdRecheckAt = new Date().toISOString();
    // Batch member rows share one checkout task. They must not each acquire
    // a fresh pair of background attempts after the parent exhausts its limit.
    for (const copy of Object.values(this._storage().records)) {
      if (record.taskId && copy.taskId === record.taskId && copy.platform === 'eslite' && copy.accountSlot === slot) {
        copy.holdRecheckCount = record.holdRecheckCount;
        copy.holdRecheckAt = record.holdRecheckAt;
      }
    }
    await this.state.save();
    try {
      const result = await this.reconcileEsliteAccount({ accountSlot: slot, background: true });
      record.steps ||= [];
      record.steps.push(safePurchaseStep({at:new Date().toISOString(),elapsedMs:Date.now()-Date.parse(record.startedAt),
        label:result.resolved?'正式訂單背景補查確認':'送單結果不明／背景補查仍待核對',stepNumber:12,stepTitle:'核對正式訂單',
        state:result.resolved?'success':'unknown',reason:result.resolved?'官方確認後解除本帳號保護，下一筆需新鮮庫存觀測':'未查到不代表未成立；本帳號保護保留，其他帳號繼續'}));
    } catch (error) {
      record.steps ||= [];
      record.steps.push(safePurchaseStep({at:new Date().toISOString(),elapsedMs:Date.now()-Date.parse(record.startedAt),stepNumber:12,
        stepTitle:'核對正式訂單',label:'送單結果不明／背景補查暫時失敗',state:'unknown',reason:purchaseErrorSummary(error)}));
    }
    for (const copy of this._storage().recent.filter(item => item.platform === 'eslite' && item.accountSlot === slot
      && (record.taskId && item.taskId === record.taskId || item.startedAt === record.startedAt && item.product?.id === record.product?.id))) Object.assign(copy, record);
    await this.state.save(); await this._recordEsliteAttempt(record);
    void this._schedule();
  }

  async reconcileEsliteAccount({ accountSlot, background = false } = {}) {
    const slot = String(accountSlot || '').toUpperCase();
    const multi = this.adapters.eslite;
    const adapter = multi?.adapters?.[slot];
    if (!adapter || adapter.accountBusy || multi.busySlots.has(slot)) throw new Error('帳號不存在或正在處理，請稍後再查單');
    const identity = multi.accountIdentity(slot);
    if (!identity) throw new Error('帳號尚未設定');
    multi.busySlots.add(slot);
    let result;
    try { result = await adapter._withAccountLock(async () => {
      const storage = this._storage();
      const records = Object.values(storage.records).filter(record => record.platform === 'eslite'
        && record.accountSlot === slot && record.status === 'submitted_unconfirmed'
        && (!record.accountIdentity || record.accountIdentity === identity));
      // Import only this authenticated account's official orders. No PII is stored.
      let history;
      try { history = await adapter.apiOrderReader(await adapter._ensureApiContext(), background ? {
        startedAt: records[0]?.startedAt, maxPages: 1, maxDetails: 6, timeoutMs: 3000, maxDurationMs: 6000
      } : { maxPages: 3, maxDetails: 30, timeoutMs: 5000, maxDurationMs: 20000 }); }
      catch (error) {
        for (const record of records) {
          record.orderCheck = { at: new Date().toISOString(), result: 'error', reason: purchaseErrorSummary(error) };
          this._syncEsliteRecordCopies(record);
        }
        await this.state.save();
        throw error;
      }
      if (identity !== multi.accountIdentity(slot)) throw new Error('查單途中帳號已變更；保留待核對，不解除保護');
      storage.eslitePurchased ||= {};
      storage.eslitePurchased[identity] ||= {};
      for (const order of history.orders) for (const item of order.items.filter(item => !item.canceled)) {
        storage.eslitePurchased[identity][item.id] = { orderId: order.orderId, purchasedAt: order.createdAt, source: 'official_query' };
      }
      storage.esliteHistorySync ||= {};
      storage.esliteHistorySync[identity] = { at: new Date().toISOString(), complete: history.complete };
      let resolved = 0;
      for (const record of records) {
        const order = record.products?.length ? matchEsliteProductOrder(history.orders, { products: record.products, startedAt: record.startedAt })
          : matchEsliteSingleProductOrder(history.orders, { productId: record.product.id, quantity: record.quantity || 1, startedAt: record.startedAt });
        record.orderCheck = { at: new Date().toISOString(), result: order ? 'matched' : 'not_found', complete: history.complete === true,
          reason: order ? '官方找到唯一吻合訂單' : history.complete ? '本次官方查詢無吻合訂單；可人工核對後確認未成立' : '本次查詢範圍不完整；尚無吻合訂單，不代表未成立' };
        if (!order) { this._syncEsliteRecordCopies(record); continue; }
        record.previousStatus = record.status;
        Object.assign(record, order, { status: 'ordered', reconciled: true, accountIdentity: identity,
          resolvedAt: new Date().toISOString(), detail: '官方會員訂單已確認成立；未重送結帳請求' });
        if (!background) {
          record.steps ||= [];
          record.steps.push(safePurchaseStep({ at: record.resolvedAt, label: '官方查單已確認成立', state: 'success', stepNumber: 12,
            stepTitle: '核對正式訂單', reason: '官方唯一吻合訂單已保存；本次未重送',
            elapsedMs: Math.max(0, Date.now() - (Date.parse(record.startedAt) || Date.now())) }));
        }
        this._ledger().settle(record.taskId, { ...record, items: order.items.map(p=>({id:p.id,quantity:p.quantity})) });
        this._syncEsliteRecordCopies(record);
        resolved++;
      }
      for (const record of Object.values(storage.records).filter(record => record.platform === 'eslite'
        && record.accountSlot === slot && record.accountIdentity === identity && record.reconciled
        && record.status === 'ordered' && history.orders.some(order => order.orderId === record.orderId))) {
        const existing = storage.recent.find(item => item.taskId && item.taskId === record.taskId
          || item.platform === 'eslite' && item.accountSlot === slot && item.startedAt === record.startedAt && item.product?.id === record.product.id);
        if (existing) Object.assign(existing, record);
        else storage.recent.unshift({ ...record });
      }
      storage.recent = storage.recent.slice(0, 30);
      // Failure to save must keep the account protected.
      try { await this.state.save(); }
      catch (error) {
        // Keep the in-memory guard too, even if the durable save failed.
        adapter.purchaseHold ||= { productId: records[0]?.product.id || 'unknown', startedAt: records[0]?.startedAt || new Date().toISOString(), reason: '查單結果保存失敗' };
        for (const record of records.filter(record => record.reconciled)) record.status = 'submitted_unconfirmed';
        throw error;
      }
      for (const record of records) await this._recordEsliteAttempt(record);
      if (resolved && !records.some(record => record.status === 'submitted_unconfirmed')) {
        adapter.purchaseHold = null;
        adapter._resetApiReadiness();
      }
      const pending = records.filter(record => record.status === 'submitted_unconfirmed').length;
      return { resolved, pending, purchasedCount: Object.keys(storage.eslitePurchased[identity]).length,
        complete: history.complete, message: `帳號 ${slot}：查詢完成，找到 ${resolved} 筆吻合訂單。${pending ? `另 ${pending} 筆未找到吻合訂單，仍待確認；若已人工核對沒有訂單，請在該筆按「確認未成立」。` : '目前沒有待核對訂單。'}${history.complete ? '' : ' 本次查詢不完整。'}未清車、未重送。` };
    }); } finally { multi.busySlots.delete(slot); }
    void this._schedule();
    return result;
  }

  async suspend() {
    this.paused = true;
    for (const timer of this.heldEsliteChecks.values()) clearTimeout(timer);
    this.heldEsliteChecks.clear();
    await Promise.allSettled([...this.heldEsliteWork]);
    this._clearEsliteEvent();
    this._clearFunboxEvent();
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    if (this.esliteQueueTimer) clearTimeout(this.esliteQueueTimer);
    this.esliteQueueTimer = null;
    if (this.funboxWaveTimer) clearTimeout(this.funboxWaveTimer);
    this.funboxWaveTimer = null;
    this.funboxPendingWave.clear();
    this.queue.length = 0;
    this.queuedKeys.clear();
    await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
    return this.getStatus();
  }

  async resume() {
    this.paused = false;
    return this.applyRuntimeConfig();
  }

  async close() {
    await this.suspend();
    await this.esliteHistoryTail.catch(() => {});
    await this.funboxHistoryTail.catch(() => {});
    await Promise.allSettled([...this.privateDeliveries]);
  }
}
