import { load } from 'cheerio';
import { AMAZON_HTTP_ORIGIN, parseAmazonDirectBuyForm } from './amazon-jp-http.js';
import { clickAndWaitForAmazonNavigation } from './amazon-jp-single-order.js';

// A new attempt after a proven pre-submit shell. Same account/context, fresh
// product form, one native Buy Now. Never clicks Continue or Place Order.
// Final validation and single-send protection remain in the HTTP transaction.
export async function openAmazonBrowserDirectEntry(page, snapshot, { canContinue = () => true } = {}) {
  const check = () => { if (!canContinue()) throw new Error('日亞任務已停止，本次不直購'); };
  check();
  const target = new URL(`/dp/${snapshot.asin}`, AMAZON_HTTP_ORIGIN);
  target.searchParams.set('m', 'AN1VRQENFRJN5');
  target.searchParams.set('language', 'ja_JP'); target.searchParams.set('currency', 'JPY');
  let latest;
  const trace = [];
  const observe = response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      latest = response;
      trace.push({ url: response.url(), method: response.request().method(), status: response.status(), responseReceived: true });
    }
  };
  page.on('response', observe);
  try {
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const guard = async scope => {
      const url = new URL(page.url());
      if (url.origin !== AMAZON_HTTP_ORIGIN) throw new Error('日亞瀏覽器離開官方網域，本次不送單');
      const status = latest?.status();
      if ([429, 503].includes(status) || latest?.headers()['retry-after']) {
        const raw = latest?.headers()['retry-after'];
        const delay = /^\d+$/.test(raw || '') ? Number(raw) * 1000 : Date.parse(raw || '') - Date.now();
        throw Object.assign(new Error(`日亞 HTTP ${status}，停止本輪並降速`), { code: 'AMAZON_RATE_LIMITED', requestScope: scope, retryAfterMs: Math.max(60_000, delay || 0) });
      }
      const html = await page.content(), $ = load(html);
      if (/\/ap\/cvf/.test(url.pathname) || $('#captchacharacters,form[action*="validateCaptcha"]').length || /Robot Check|画像に表示されている文字/.test($('body').text())) {
        throw Object.assign(new Error('日亞要求人工驗證，請開啟專用視窗'), { code: 'AMAZON_VERIFICATION_REQUIRED', requestScope: scope });
      }
      if (/\/ap\/(?:signin|mfa)/.test(url.pathname) || $('#ap_email,form[name="signIn"]').length) {
        throw Object.assign(new Error('日亞需要重新登入，請開啟專用視窗'), { code: 'AMAZON_LOGIN_REQUIRED', requestScope: scope });
      }
      if (status !== 200) throw new Error(`日亞瀏覽器 HTTP ${status ?? '未知'}，未取得可用頁面`);
      return { url: url.href, html, $, status };
    };
    await guard('product');
    await page.waitForSelector('#buybox #buy-now-button, #desktop_buybox #buy-now-button', { state: 'visible', timeout: 3_000 }).catch(() => {});
    check();
    const product = await guard('product');
    parseAmazonDirectBuyForm(product, snapshot);
    const button = page.locator('#buybox #buy-now-button, #desktop_buybox #buy-now-button').first();
    if (!await button.isVisible() || !await button.isEnabled()) throw new Error('商品頁立即購買按鈕不可操作');
    check();
    await clickAndWaitForAmazonNavigation(page, button);
    await page.waitForFunction(() => document.querySelector('#spc-form,#ap_email,#captchacharacters,.a-alert-content')
      || /\/ap\/(?:signin|mfa|cvf)/.test(location.pathname), null, { timeout: 3_000 }).catch(() => {});
    check();
    return { ...await guard('checkout'), entryTrace: trace };
  } finally { page.off('response', observe); }
}
