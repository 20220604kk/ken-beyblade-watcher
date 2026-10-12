// Read-only classification. Generic help text mentioning verification is not a challenge.
export function classifyEsliteLogin({ text = '', challengeVisible = false, verificationInputVisible = false, httpStatus = 0 } = {}) {
  if (challengeVisible || /sorry,? you have been blocked|unable to access eslite\.com|attention required|access denied|請完成人機驗證|請完成圖形驗證/i.test(text)
    || (verificationInputVisible && /驗證碼|簡訊驗證|圖形驗證/.test(text))) {
    return { status: 'human_required', message: '官方顯示驗證或攔截畫面，請在專用視窗完成；不自動破解' };
  }
  if ([429, 500, 502, 503, 504].includes(httpStatus) || /系統忙碌|系統繁忙|稍後再試|system.*busy|temporarily unavailable/i.test(text)) {
    return { status: 'login_busy', message: '官方登入暫時忙碌，冷卻後再試；不是人工驗證' };
  }
  if (/密碼錯誤|帳號或密碼錯誤|帳號不存在|登入失敗/i.test(text)) {
    return { status: 'needs_setup', message: '官方回覆登入失敗，請檢查帳密；不反覆送出' };
  }
  if (httpStatus === 403) return { status: 'login_busy', message: '官方登入暫時受限（HTTP 403），冷卻後再查；尚未確認需要人工驗證' };
  return { status: 'unknown', message: '登入尚未取得有效 API 憑證，保留資料並稍後再查' };
}

export async function readEsliteLoginState(page) {
  if (typeof page?.locator !== 'function') return classifyEsliteLogin();
  let text = '';
  try { text = await page.locator('body').innerText({ timeout: 2500 }); }
  catch { /* Navigation or closed pages are unknown, not proof of a logout. */ }
  const visible = async selector => {
    try {
      const locator = page.locator(selector);
      if (typeof locator.count !== 'function' || typeof locator.nth !== 'function') return false;
      for (let i = 0, count = await locator.count(); i < Math.min(count, 12); i++) {
        if (await locator.nth(i).isVisible()) return true;
      }
    } catch { /* Incomplete page is unknown, never assumed to require verification. */ }
    return false;
  };
  return classifyEsliteLogin({ text,
    challengeVisible: await visible('iframe[src*="challenges.cloudflare.com"], iframe[src*="/recaptcha/api2/bframe"], #challenge-running, #challenge-stage'),
    verificationInputVisible: await visible('input[autocomplete="one-time-code"], input[placeholder*="驗證碼"], input[aria-label*="驗證碼"]') });
}
