// Explicitly authorized, one-order research harness; not production automation.
// Does not bypass verification, clear carts, retry mutations, or expose tokens.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { load } from 'cheerio';

const ORIGIN = 'https://www.amazon.co.jp';
const safePath = url => new URL(url).pathname.replace(/(\/checkout\/p\/)[^/]+/, '$1<flow>');
const visibleText = $ => { const copy = $.root().clone(); copy.find('script,style,noscript').remove(); return copy.text().replace(/\s+/g, ' ').trim(); };

export class AmazonHttpCheckoutComparison {
  constructor(input) {
    this.input = input;
    this.cookies = input.cookies;
    this.requests = [];
    this.chunks = [];
    this.submitted = false;
    this.addAttempted = false;
    this.asin = 'B00SIVY08Q';
    this.maxYen = 306;
    // Real prior order IDs belong in ephemeral private input, never source.
    this.oldOrderIds = new Set(input.baselineOrderIds || []);
  }
  static async consumeSession(file) {
    const resolved = path.resolve(file);
    const allowed = path.resolve('D:/codex/beyblade-watcher/data/records/amazon-http-tests/comparison-session.tmp.json');
    if (resolved !== allowed) throw new Error('Unexpected session handoff path');
    let input;
    try { input = JSON.parse(await fs.readFile(resolved, 'utf8')); }
    finally { await fs.unlink(resolved); }
    return new AmazonHttpCheckoutComparison(input);
  }
  async chunk(name, work) {
    const start = performance.now();
    try { return await work(); }
    finally { this.chunks.push({name, ms: performance.now() - start}); }
  }
  cookieHeader(url) {
    return this.cookies.filter(c => {
      const d = c.domain.replace(/^\./, '');
      return (url.hostname === d || url.hostname.endsWith('.' + d)) && url.pathname.startsWith(c.path || '/')
        && (!c.expires || c.expires < 0 || c.expires > Date.now() / 1000);
    }).map(c => `${c.name}=${c.value}`).join('; ');
  }
  updateCookies(response, url) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const c = {name: pair.slice(0, at), value: pair.slice(at + 1), domain: url.hostname, path: '/', expires: -1};
      for (const attribute of attributes) {
        const [rawName, ...rest] = attribute.trim().split('='); const value = rest.join('=');
        if (rawName.toLowerCase() === 'domain') c.domain = value;
        if (rawName.toLowerCase() === 'path') c.path = value;
        if (rawName.toLowerCase() === 'expires') c.expires = Date.parse(value) / 1000;
        if (rawName.toLowerCase() === 'max-age') c.expires = Date.now() / 1000 + Number(value);
      }
      if (!['amazon.co.jp', 'www.amazon.co.jp'].includes(c.domain.replace(/^\./, ''))) continue;
      this.cookies = this.cookies.filter(old => !(old.name === c.name && old.domain.replace(/^\./, '') === c.domain.replace(/^\./, '') && old.path === c.path));
      this.cookies.push(c);
    }
  }
  async request(url, {method = 'GET', body, referer} = {}) {
    for (let redirects = 0; redirects < 6; redirects++) {
      const target = new URL(url, ORIGIN);
      if (target.origin !== ORIGIN) throw new Error('Unexpected cross-origin route; stop');
      if (/\/(?:ap\/signin|ap\/mfa)/.test(target.pathname)) throw new Error('Login required; stop');
      // API transport accepts the official response format; do not restrict
      // negotiation to a partial browser document Accept list.
      const headers = {Cookie: this.cookieHeader(target), Accept: '*/*'};
      for (const name of ['User-Agent', 'Accept-Language']) {
        const value = this.input.headers?.[name] || this.input.headers?.[name.toLowerCase()];
        if (value) headers[name] = value;
      }
      if (referer) headers.Referer = referer;
      if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers.Origin = ORIGIN; }
      const start = performance.now();
      const response = await fetch(target, {method, body: body?.toString(), headers, redirect: 'manual', signal: AbortSignal.timeout(15000)});
      const headersMs = performance.now() - start;
      this.updateCookies(response, target);
      const html = await response.text();
      this.requests.push({method, path: safePath(target), status: response.status, headersMs, bodyMs: performance.now() - start,
        fieldNames: body ? [...new Set(body.keys())] : []});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location');
        if (!next) throw new Error('Redirect missing destination');
        url = new URL(next, target).href;
        referer = target.href;
        if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; }
        continue;
      }
      if (response.status !== 200) {
        this.lastFailure = {status: response.status, contentType: response.headers.get('content-type'),
          title: load(html)('title').text().slice(0,120),
          verificationWords: /Robot Check|Enter the characters you see|画像に表示されている文字|captcha/i.test(html),
          responseBytes: Buffer.byteLength(html)};
        throw new Error(`HTTP ${response.status}; no mutation retry`);
      }
      if (/Robot Check|Enter the characters you see|画像に表示されている文字|<form[^>]*captcha/i.test(html)) throw new Error('Verification required; stop');
      return {url: target.href, html, $: load(html)};
    }
    throw new Error('Too many redirects; stop');
  }
  form(page, form, submitName) {
    const $ = page.$;
    const fields = new URLSearchParams();
    $(form).find('input[name],select[name],textarea[name],button[name]').each((_, node) => {
      const e = $(node), type = (e.attr('type') || '').toLowerCase(), name = e.attr('name');
      if (!name || e.is('[disabled]') || ['button', 'reset', 'image'].includes(type)) return;
      if (['checkbox', 'radio'].includes(type) && !e.is('[checked]')) return;
      if ((type === 'submit' || node.tagName === 'button') && name !== submitName) return;
      const value = node.tagName === 'select' ? e.find('option[selected]').first().attr('value') ?? e.find('option').first().attr('value') : e.attr('value');
      fields.append(name, value ?? (type === 'checkbox' ? 'on' : ''));
    });
    const url = new URL($(form).attr('action') || page.url, page.url);
    if (url.origin !== ORIGIN) throw new Error('Unexpected form origin');
    return {url: url.href, method: ($(form).attr('method') || 'GET').toUpperCase(), fields};
  }
  async sendForm(page, form, submitName, overrides = {}) {
    const contract = this.form(page, form, submitName);
    for (const [name, value] of Object.entries(overrides)) contract.fields.set(name, value);
    if (contract.method === 'GET') {
      const url = new URL(contract.url); for (const [k,v] of contract.fields) url.searchParams.append(k,v);
      return this.request(url, {referer: page.url});
    }
    if (contract.method !== 'POST') throw new Error('Unexpected form method');
    return this.request(contract.url, {method: 'POST', body: contract.fields, referer: page.url});
  }
  async prepare() {
    return this.chunk('read_and_quote', async () => {
      const cart = await this.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
      if (cart.$('#nav-cart-count').text().trim() !== '0' || !cart.$('h1,h2,h3').text().includes('您的亚马逊购物车为空')) throw new Error('Existing cart is not confirmed empty; no clearing');
      const aodUrl = new URL(this.input.url);
      if (aodUrl.origin !== ORIGIN || !aodUrl.pathname.startsWith('/gp/product/ajax/aodAjaxMain/')) throw new Error('Unexpected offer endpoint');
      this.offerPage = await this.request(aodUrl.href);
      const $ = this.offerPage.$;
      this.offer = $('#aod-offer').filter((_, n) => {
        const e = $(n), p = e.find('.apex-pricetopay-accessibility-label,.a-price .a-offscreen').first().text().trim()
          || e.find('.apex-pricetopay-value').first().text().trim();
        return /^JP¥\s*306$/.test(p) && e.find('#aod-offer-soldBy').text().includes('ミーニャ')
          && e.find('[href*="seller=A1HLALVITCV2M3"]').length > 0
          && /免费/.test(e.find('[data-csa-c-delivery-price]').attr('data-csa-c-delivery-price') || '');
      }).first();
      if (!this.offer.length) throw new Error('Approved offer not found');
      const form = this.offer.find('form').first();
      const contract = this.form(this.offerPage, form, 'submit.addToCart');
      if (!new URL(contract.url).pathname.startsWith('/cart/add-to-cart/')) throw new Error('Unexpected add endpoint');
      if (contract.fields.get('items[0.base][asin]') !== this.asin || !contract.fields.has('items[0.base][quantity]')
        || !['', '1'].includes(contract.fields.get('items[0.base][quantity]'))
        || !contract.fields.get('anti-csrftoken-a2z')) throw new Error('Invalid fresh add contract');
      this.addForm = form;
      return {cartEmpty: true, asin: this.asin, quantity: 1, priceYen:306, shippingYen:0};
    });
  }
  async addAndEnterCheckout() {
    return this.chunk('add_and_checkout', async () => {
      if (!this.addForm || this.addAttempted || !this.oldOrderIds.size) throw new Error('Add prohibited, missing private order baseline, or already attempted');
      this.addAttempted = true;
      // The official AOD JS populates this initially empty hidden field.
      // Set only the user's explicitly authorized single-unit quantity.
      const added = await this.sendForm(this.offerPage, this.addForm, 'submit.addToCart', {'items[0.base][quantity]':'1'});
      if (added.$('#nav-cart-count').text().trim() !== '1' || !visibleText(added.$).includes('商品已加入购物车')) throw new Error('Add result uncertain; inspect cart, never re-add');
      const checkoutForm = added.$('form').filter((_, n) => added.$(n).find('[name="proceedToRetailCheckout"],[name="proceedToCheckout"]').length > 0).first();
      if (!checkoutForm.length) throw new Error('Checkout entry form unavailable; preserve cart');
      const contract = this.form(added, checkoutForm, 'proceedToRetailCheckout');
      if (new URL(contract.url).pathname !== '/checkout/entry/cart' || contract.fields.get('cartItemCount') !== '1') throw new Error('Unexpected checkout entry contract');
      this.review = await this.sendForm(added, checkoutForm, 'proceedToRetailCheckout');
      const canonical = this.form(this.review, this.review.$('#spc-form').first(), 'placeYourOrder1');
      const canonicalUrl = new URL(canonical.url);
      if (!/\/checkout\/p\/[^/]+\/spc\/place-order$/.test(canonicalUrl.pathname)) throw new Error('Unexpected canonical review route');
      canonicalUrl.pathname = canonicalUrl.pathname.replace(/\/place-order$/, '');
      this.review.url = canonicalUrl.href;
      return this.describeReview();
    });
  }
  describeReview() {
    const p = this.review, $ = p.$, text = visibleText($);
    return {path:safePath(p.url), hasExpectedItem:text.includes('RAF60'),
      forms:$('form').map((_, n) => { const f=this.form(p,n); return {id:$(n).attr('id'),method:f.method,path:safePath(f.url),names:[...new Set(f.fields.keys())], currencyFields:[...f.fields].filter(([name])=>/selectedCurrencyOption|currencyToggleTransition|placeYourOrderButtonText|selectedTnCOption|currencyOptions/.test(name))}; }).get(),
      radios:$('input[type="radio"]').filter((_,n)=>/currency|accb/i.test($(n).attr('name')||'')||/currency|accb/i.test($(n).attr('id')||'')).map((_,n)=>({id:$(n).attr('id'),name:$(n).attr('name'),value:$(n).attr('value'),checked:$(n).is('[checked]')})).get(),
      totalSnippets:text.match(/(?:订单总计|配送费|商品)\s*[:：][^:：]{0,65}/g)?.slice(0,5)};
  }
  async selectOfferedJPY() {
    // Currency switching is local official UI state, not a separate API.
    // The response contains both currency quotes. Bind the JPY choice to the
    // final POST; never mistake a hidden JPY quote for the selected currency.
    return this.chunk('select_offered_jpy', async () => {
      const $ = this.review.$;
      const form = $('form').filter((_,n)=>$(n).find('[name="selectedCurrencyOption"]').attr('value') === 'MARKETPLACE'
        && /JPY/.test($(n).find('[name="placeYourOrderButtonText"]').attr('value')||'')).first();
      if (!form.length || !$('input[name="currencyOptions"][value="MARKETPLACE"]').length) throw new Error('Official JPY choice missing');
      this.currencyChoice = form.find('[name="selectedCurrencyOption"]').attr('value');
      this.submitLabel = form.find('[name="placeYourOrderButtonText"]').attr('value');
      return this.verifyReview();
    });
  }
  verifyReview() {
    const text=visibleText(this.review.$);
    const total=text.match(/订单总计\s*[:：]\s*(?:JPY|JP¥)\s*([\d,]+(?:\.\d+)?)/)?.[1];
    const shipping=text.match(/配送费\s*[:：]\s*(?:JPY|JP¥)\s*([\d,]+(?:\.\d+)?)/)?.[1];
    const subtotal=text.match(/商品\s*[:：]\s*(?:JPY|JP¥)\s*([\d,]+(?:\.\d+)?)/)?.[1];
    if (Number(total)!==306 || Number(shipping)!==0 || Number(subtotal)!==306 || !text.includes('RAF60') || !text.includes('ミーニャ')) throw new Error('Final price, currency, shipping, or item mismatch; no submission');
    if (this.currencyChoice !== 'MARKETPLACE' || !this.addAttempted || !this.addForm) throw new Error('JPY choice or single-unit cart identity not confirmed');
    const identity = this.form(this.offerPage,this.addForm,'submit.addToCart');
    if (identity.fields.get('items[0.base][asin]') !== this.asin) throw new Error('Cart ASIN binding lost');
    return {totalYen:306,shippingYen:0,pointsUsed:0,quantity:1};
  }
  async submitOnceAndConfirm() {
    return this.chunk('submit_and_confirm', async () => {
      const quote=this.verifyReview();
      if (this.submitted) throw new Error('Order submission already attempted');
      const form=this.review.$('form').filter((_,n)=>/\/spc\/place-order$/.test(new URL(this.review.$(n).attr('action')||this.review.url,this.review.url).pathname)).first();
      if (!form.length) throw new Error('Final official form missing');
      const contract=this.form(this.review,form,'placeYourOrder1');
      if (!contract.fields.get('anti-csrftoken-a2z')) throw new Error('Fresh CSRF missing');
      this.submitted=true;
      const thanks=await this.sendForm(this.review,form,'placeYourOrder1', {
        currentCurrencyOption:this.currencyChoice, placeYourOrder1:this.submitLabel,
        hasWorkingJavascript:'1', setOrderingPrefs:''
      });
      if (!visibleText(thanks.$).includes('订单已提交')) throw new Error('Submission result unknown; check orders, never resubmit');
      const history=await this.request('/-/zh/gp/your-account/order-history?ref_=typ_rev_edit_mult');
      const link=history.$('a[href*="/your-orders/order-details"]').filter((_,n)=>{
        const id=new URL(history.$(n).attr('href'),history.url).searchParams.get('orderID');
        return id && !this.oldOrderIds.has(id);
      }).first();
      // Some server-rendered order cards expose identity in widget metadata
      // before their links are hydrated. This is an official order-card ID,
      // not an arbitrary number, session ID, or checkout purchaseId.
      const cardOrderIds=history.$('.order-card').map((_,n)=>history.$(n).attr('data-csa-c-slot-id')
        ?.match(/^amzn1\.yourorders\.order-card\.(\d{3}-\d{7}-\d{7})$/)?.[1]).get();
      const freshCardId=cardOrderIds.find(id=>!this.oldOrderIds.has(id));
      if (!link.length && !freshCardId) throw new Error('New official order not yet listed; never resubmit');
      const detailUrl=link.length ? new URL(link.attr('href'),history.url)
        : new URL('/your-orders/order-details?orderID='+freshCardId,ORIGIN);
      const orderId=detailUrl.searchParams.get('orderID');
      const detail=await this.request(detailUrl);
      const text=visibleText(detail.$);
      if (!text.includes(orderId) || !text.includes('RAF60') || !/金额\s*[:：]\s*JP¥\s*306\b/.test(text)
        || !/配送费\/手续费\s*[:：]\s*JP¥\s*0\b/.test(text)) throw new Error('Official detail unresolved; no new submission');
      this.orderId=orderId;
      this.result={orderId,detailUrl:detailUrl.href,...quote,route:'independent_http',submitCount:1};
      return this.result;
    });
  }
  summary() { return {result:this.result||null,added:this.addAttempted,submitted:this.submitted,
    activeMs:this.chunks.reduce((n,c)=>n+c.ms,0),chunks:this.chunks,requests:this.requests,lastFailure:this.lastFailure}; }
}
