// Runs in an isolated extension world. Only native DOM clicks; no fetch,
// arbitrary selectors, page-world code, credential reads, or form POST replay.
export async function amazonDomAction(command, expected = {}) {
  if (location.origin !== 'https://www.amazon.co.jp') throw new Error('非日亞官方分頁');
  const visible = node => node && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length > 0;
  const buy = () => [...document.querySelectorAll('#buybox #buy-now-button, #desktop_buybox #buy-now-button')].find(visible);
  const submit = () => [...document.querySelectorAll('#spc-form [name="placeYourOrder1"], #spc-form #placeYourOrder input[type=submit], #spc-form #placeYourOrder button')].find(visible);
  const blocked = () => /\/ap\/(?:signin|mfa|challenge)|\/errors\/validateCaptcha/i.test(location.pathname)
    || !!document.querySelector('input[type=password], #captchacharacters, iframe[src*="captcha"]')
    || /Robot Check|Enter the characters you see|画像に表示されている文字/i.test(document.title + document.body.innerText);
  if (blocked()) return { blocked: true, url: location.href };
  const guard = () => JSON.stringify({ url: location.href,
    form: (document.querySelector('#spc-form') || buy()?.form)?.outerHTML || '',
    items: [...document.querySelectorAll('[id^="checkout-item-block-"], [id^="item-block-"], #order-summary, #subtotals-marketplace-table, #shipping-address, #change-delivery-link, #corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #merchantInfoFeature_feature_div, #merchant-info, #tabular-buybox')].map(n => n.innerText),
    controls: [...(document.querySelector('#spc-form')?.elements || buy()?.form?.elements || [])].map(n => [n.name, n.value, n.checked]) });
  if (command === 'buy' || command === 'submit') {
    if (location.href !== expected.url || guard() !== expected.guard) throw new Error('核對後頁面已變更，本次不點擊');
    const button = command === 'buy' ? buy() : submit();
    if (!button || button.form?.method.toLowerCase() !== 'post') throw new Error('官方購買按鈕不可操作');
    if (command === 'submit' && document.querySelector('#spc-form [name="currentCurrencyOption"]')?.value !== 'MARKETPLACE') throw new Error('非 JPY 結帳，不送單');
    button.click();
    return { clicked: true };
  }
  if (command === 'jpy') {
    const radio = document.querySelector('input[name="currencyOptions"][value="MARKETPLACE"]');
    if (!visible(radio) || radio.checked) throw new Error('無法切換 JPY；不送單');
    radio.click(); return { changed: true };
  }
  if (command !== 'read') throw new Error('未知的分頁指令');
  const ready = () => document.querySelector('#productTitle') || submit() || /thank|confirmation/i.test(location.pathname) || blocked();
  if (!ready()) await new Promise(resolve => {
    const finish = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
    const observer = new MutationObserver(() => { if (ready()) finish(); });
    const timer = setTimeout(finish, 3000); observer.observe(document.documentElement, { subtree: true, childList: true });
  });
  if (blocked()) return { blocked: true, url: location.href };
  const copy = document.documentElement.cloneNode(true);
  // Serialize current values rather than stale initial checked/value attributes.
  const source = document.querySelectorAll('input,select,textarea'), dest = copy.querySelectorAll('input,select,textarea');
  source.forEach((node, i) => {
    const clone = dest[i]; if (!clone) return;
    if (node.type === 'password') { clone.remove(); return; }
    if (node.tagName === 'SELECT') [...clone.options].forEach((o, index) => { o.toggleAttribute('selected', node.options[index]?.selected); });
    else { clone.setAttribute('value', node.value); clone.toggleAttribute('checked', Boolean(node.checked)); }
  });
  // Scripts are not needed for the local form parser. This also omits unrelated
  // inline account/payment metadata. Raw HTML is transient, loopback-only.
  copy.querySelectorAll('script,iframe,noscript').forEach(n => n.remove());
  const html = '<!doctype html>' + copy.outerHTML;
  if (html.length > 3_000_000) throw new Error('分頁過大，暫停核對');
  return { url: location.href, html, guard: guard(), account: document.querySelector('#nav-link-accountList-nav-line-1')?.innerText.trim() || '',
    product: !!document.querySelector('#productTitle'), checkout: !!document.querySelector('#spc-form'),
    stockChanged: !document.querySelector('#spc-form') && /ご指定の数量をご用意できません|无法再提供您所请求的数量|無法再提供您所請求的數量|not able to provide.*quantity/i.test(document.body.innerText),
    complete: /\/(?:gp\/buy\/thankyou\/|checkout\/.*(?:thank|confirmation))/.test(location.pathname) };
}
