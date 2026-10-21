// Bounded, read-only waits. No fixed sleep, clicks, credentials or body dumps.
export async function waitForAmazonProductReady(page, status = 200, timeoutMs = 2_000) {
  const started = Date.now();
  if ([404, 429, 503].includes(Number(status)) || typeof page.waitForFunction !== 'function') {
    return { state: 'immediate', waitedMs: 0 };
  }
  let handle;
  try {
    handle = await page.waitForFunction(() => {
      const body = document.body?.innerText || '';
      const text = selector => document.querySelector(selector)?.textContent?.trim() || '';
      if (document.querySelector('#captchacharacters, form[action*="validateCaptcha"], input[name="cvf_captcha_input"]')
        || /Robot Check|Enter the characters you see|画像に表示されている文字/i.test(body)) return 'human_verification';
      if (/\/(?:ap\/signin|ap\/mfa)/i.test(location.pathname)) return 'login';
      if (/ページが見つかりません|何かお探しですか|Page Not Found|Sorry! Something went wrong|アクセスが集中/i.test(body)) return 'error_page';
      if (!text('#productTitle')) return false;
      if (/在庫切れ|現在お取り扱いできません|一時的に在庫切れ|Currently unavailable|Out of stock|暫無庫存|目前無貨|目前缺貨|目前無法購買/i.test(text('#availability'))) return 'unavailable';
      const button = [...document.querySelectorAll('#buy-now-button, #pre-order-button, #preorder-button, #add-to-cart-button, [name="submit.pre-order"], [name="submit.preorder"], input[name="submit.buy-now"], input[name="submit.add-to-cart"]')]
        .find(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true'
          && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden'
          && element.getClientRects().length > 0);
      const price = text('#corePrice_feature_div .a-price .a-offscreen, #apex_desktop .priceToPay .a-offscreen, #apex_desktop .a-price .a-offscreen, #desktop_buybox .a-price .a-offscreen');
      const seller = document.querySelector('input[name="merchantID"], input[name="merchantId"]')
        || /販売元|出品者|卖家|賣家|Seller/i.test(body);
      return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && price && seller ? 'offer' : false;
    }, undefined, { timeout: timeoutMs, polling: 100 });
    return { state: await handle.jsonValue(), waitedMs: Date.now() - started };
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    return { state: 'time_limit', waitedMs: Date.now() - started };
  } finally { await handle?.dispose?.(); }
}

export function amazonProductRecoveryDelay(failures) {
  return [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(4, Math.max(0, Number(failures) - 1))];
}
