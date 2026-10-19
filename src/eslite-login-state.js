// Read-only classification. Generic help text mentioning verification is not a challenge.
export function classifyEsliteLogin({ text = '', challengeVisible = false, verificationInputVisible = false, httpStatus = 0 } = {}) {
  if (challengeVisible || /sorry,? you have been blocked|unable to access eslite\.com|attention required|access denied|請完成人機驗證|請完成圖形驗證/i.test(text)
    || (verificationInputVisible && /驗證碼|簡訊驗證|圖形驗證/.test(text))) {
    return { status: 'human_required', message: '官方顯示驗證或攔截畫面，請在專用視窗完成；不自動破解' };
  }
  if (/無法連至\s*reCAPTCHA\s*服務|could not connect to (?:the )?recaptcha service/i.test(text)) {
    return { status: 'login_busy', message: '官方 reCAPTCHA 驗證服務連線失敗，本次停止登入；尚未證實帳密錯誤，不反覆提交' };
  }
  if ([429, 500, 502, 503, 504].includes(httpStatus) || /系統忙碌|系統繁忙|稍後再試|system.*busy|temporarily unavailable/i.test(text)) {
    return { status: 'login_busy', message: '官方回覆登入忙碌／暫時拒絕；尚不能確認是否與驗證有關，冷卻後再查' };
  }
  if (/密碼錯誤|帳號或密碼錯誤|帳號不存在|登入失敗/i.test(text)) {
    return { status: 'needs_setup', message: '官方回覆登入失敗，請檢查帳密；不反覆送出' };
  }
  if (httpStatus === 403) return { status: 'login_busy', message: '官方登入暫時受限（HTTP 403），冷卻後再查；尚未確認需要人工驗證' };
  return { status: 'unknown', message: '登入尚未取得有效 API 憑證，保留資料並稍後再查' };
}

// Authentication responses may contain credentials or member data. Retain only
// a fixed set of derived labels, never the response body or request payload.
export function summarizeEsliteAuthReply({url,method,httpStatus,body}={}) {
  let endpoint;
  try { const target=new URL(url);if(target.origin!=='https://athena.eslite.com'||method!=='POST'||!/login|auth|session|sign.?in|token/i.test(target.pathname))return null;endpoint=target.pathname.replace(/\d{5,}/g,'[id]'); }
  catch{return null;}
  const messages=[];
  const visit=(value,depth=0,inMessage=false)=>{
    if(depth>3||!value||typeof value!=='object')return;
    for(const [key,item]of Object.entries(value).slice(0,30)){
      const messageField=/^(?:messages?|msg|err_?msg|error_?(?:description|messages?)|details?|errors?)$/i.test(key);
      if((messageField||inMessage&&Array.isArray(value))&&typeof item==='string')messages.push(item.slice(0,800));
      else if(typeof item==='object')visit(item,depth+1,messageField||inMessage);
    }
  };
  visit(body);
  const text=messages.join(' ');
  const reasonHint=/captcha|recaptcha|驗證失敗|驗證碼錯誤|人機驗證|機器人/i.test(text)?'verification_message'
    :/密碼錯誤|帳號或密碼|帳號不存在|invalid.{0,15}(?:password|credential)|incorrect.{0,15}password/i.test(text)?'credentials_message'
    :/鎖定|停權|停用|locked|suspended|disabled/i.test(text)?'account_status_message'
    :/忙碌|繁忙|busy|unavailable/i.test(text)?'busy_message':'unknown';
  return {endpoint,httpStatus:Number.isInteger(httpStatus)?httpStatus:null,replyType:body&&typeof body==='object'?'json':'unavailable',reasonHint};
}

// Playwright isVisible() also accepts opacity:0 and off-screen frames. Google
// preloads those frames on normal login pages; their existence is not a prompt.
export function eslitePromptActuallyRendered(element) {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  if (!view || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
    || rect.top >= view.innerHeight || rect.left >= view.innerWidth) return false;
  for (let node = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || Number(style.opacity) === 0) return false;
  }
  return true;
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
        const candidate = locator.nth(i);
        if (await candidate.isVisible()
          && (typeof candidate.evaluate !== 'function' || await candidate.evaluate(eslitePromptActuallyRendered))) return true;
      }
    } catch { /* Incomplete page is unknown, never assumed to require verification. */ }
    return false;
  };
  const challengeVisible = await visible('iframe[src*="challenges.cloudflare.com"], iframe[src*="/recaptcha/api2/bframe"], iframe[src*="/recaptcha/enterprise/bframe"], #challenge-running, #challenge-stage');
  const verificationInputVisible = await visible('input[autocomplete="one-time-code"], input[placeholder*="驗證碼"], input[aria-label*="驗證碼"]');
  const result = classifyEsliteLogin({ text, challengeVisible, verificationInputVisible });
  return { ...result, signal: /無法連至\s*reCAPTCHA\s*服務|could not connect to (?:the )?recaptcha service/i.test(text) ? 'verification_connection_error'
    : challengeVisible ? 'visible_challenge' : verificationInputVisible ? 'visible_verification_input'
    : result.status === 'human_required' ? 'official_block_text' : result.status === 'login_busy' ? 'official_busy_text' : 'page_text' };
}
