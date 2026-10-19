// One bounded, authenticated BX-11 checkout inspection. Final submission is
// prohibited by the transport guard, not merely by a UI convention.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AmazonJpHttpClient, parseAmazonHttpCart, amazonHttpForm } from '../src/amazon-jp-http.js';
import { validateAmazonJpProductCheckout } from '../src/amazon-jp-product-order.js';
import { AmazonCheckoutEvidence, evidenceEndpoint } from '../src/amazon-checkout-evidence.js';
import { amazonThreeSteps } from '../src/amazon-three-steps.js';
import { safePurchaseText } from '../src/purchase-diagnostics.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const folder = path.join(project, 'data', 'diagnostics', 'amazon-bx11-check');
const cleanupOnly = process.argv.includes('--cleanup-only');
const directProduct = process.argv.includes('--direct-product');
const reportFile = path.join(folder, cleanupOnly ? 'latest-cleanup.json' : directProduct ? 'direct-product.json' : 'latest.json');
const target = 'B0C533Q31X';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = async () => {
  const response = await fetch('http://127.0.0.1:3210/api/status?view=shared&logs=0');
  if (!response.ok) throw new Error('Local controller unavailable');
  return (await response.json()).japanAuctions.amazonJpProductOrders.find(item => item.slot === 'A');
};
const settings = async payload => {
  const response = await fetch('http://127.0.0.1:3210/japan/amazon-product-order/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!response.ok) { const body = await response.json(); throw new Error(body.error || body.message || 'Cannot pause A'); }
};
const payload = state => Object.fromEntries(['slot','enabled','mode','fastLane','targetUrl','targetSuccessCount','maxShippingYen','priceToleranceYen'].map(key => [key, state[key]]));
await fs.mkdir(folder, { recursive: true });
const record = { id: `${Date.now()}-${crypto.randomUUID()}`, at: new Date().toISOString(),
  asin: target, status: 'starting', finalSubmissions: 0, http: [], events: [], preparation: {}, cleanup: {} };
const evidence = new AmazonCheckoutEvidence(folder, { saveRecord: async () => {} });
let context, original, paused = false, client, previousCartIds = new Set(), postStarted = false;
const save = async () => {
  record.steps = amazonThreeSteps(record.events);
  await fs.writeFile(reportFile, JSON.stringify(record, null, 2) + '\n');
};
try {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const current = await status();
    if (current.apiTransactionStatus || current.status === 'needs_review') throw new Error('A has unresolved transaction; no test mutation performed');
    if (current.interactive || current.evidencePending) throw new Error('A has an active account operation; no test mutation performed');
    if (!current.running) {
      original = payload(current);
      try { await settings({ ...original, enabled: false }); paused = true; break; }
      catch (error) { if (!/正在檢查或結帳/.test(error.message)) throw error; }
    }
    await pause(150);
  }
  if (!paused) throw new Error('No idle window; A was left unchanged');
  record.preparation.aPausedAt = new Date().toISOString();
  context = await chromium.launchPersistentContext(path.join(project, 'data', 'auto-purchase', 'browser-profiles', 'amazon-jp-product-order'), {
    channel: 'chrome', headless: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', timeout: 15_000
  });
  if (cleanupOnly) {
    const previous = JSON.parse(await fs.readFile(path.join(folder, 'latest.json'), 'utf8'));
    if (previous.asin !== target || previous.finalSubmissions !== 0 || previous.transactionPhase !== 'buy_now'
      || !previous.cleanup?.error || !previous.cleanup?.ownItemId || previous.cleanup?.testItemRemoved || previous.cleanup?.testItemNotPresent
      || !previous.http.some(item => item.method === 'POST' && item.endpoint === '/checkout/entry/buynow' && item.status === 200)
      || Date.now() - Date.parse(previous.at) > 3600_000) throw new Error('No recent owned BX-11 test mutation to clean');
    record.cleanup.originalTestId = previous.id;
    record.cleanup.expectedItemId = previous.cleanup.ownItemId;
    postStarted = true;
    throw Object.assign(new Error('cleanup only'), { code: 'PROBE_CLEANUP_ONLY' });
  }
  const request = { fetch: async (url, options) => {
    const u = new URL(url), method = options.method || 'GET';
    if (u.origin !== 'https://www.amazon.co.jp') throw new Error('External origin prohibited');
    if (method !== 'GET') {
      if (method !== 'POST' || u.pathname !== '/checkout/entry/buynow' || postStarted) throw new Error('Final submission and repeated buy-now are prohibited');
      const current = await status();
      if (current.enabled || current.running || current.targetUrl !== original.targetUrl) throw new Error('A settings changed during test; stopped before POST');
      postStarted = true;
    }
    const start = performance.now();
    const response = await context.request.fetch(url, options);
    record.http.push({ method, endpoint: evidenceEndpoint(url), status: response.status(), ms: Math.round(performance.now() - start) });
    return response;
  } };
  client = new AmazonJpHttpClient({ request, directBuyNow: true,
    recordStep: async (name, detail) => record.events.push({ name, ...detail, at: new Date().toISOString() }),
    checkpoint: async tx => { record.transactionPhase = tx?.phase || ''; await save(); },
    captureEvidence: (kind, input) => evidence.enqueue(record, kind, input) });
  // Outside measured checkout: establish that cleanup can only remove our new
  // test item, never an item already in the active cart or saved-for-later.
  const before = await client.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
  if (!before.$('#sc-active-cart').length && !parseAmazonHttpCart(before).empty) throw new Error('Cannot identify original cart; no test mutation performed');
  if (before.$(`#sc-active-cart [data-asin="${target}"]`).length) throw new Error('BX-11 already in cart; no test mutation performed');
  previousCartIds = new Set(before.$('#sc-active-cart [data-itemid]').toArray().map(node => before.$(node).attr('data-itemid')));
  const started = performance.now();
  record.events.push({ name: 'refresh_start', at: new Date().toISOString() });
  const offer = await (directProduct ? client.readDirectOffer(target) : client.readOffer(target));
  if (!offer.sellerConfirmed || !(offer.addCartAvailable || offer.buyNowAvailable) || !(offer.priceYen > 0 && offer.priceYen <= 1000)) throw new Error('No qualifying BX-11 retail offer');
  record.priceYen = offer.priceYen;
  record.events.push({ name: 'product_evaluated', result: 'qualified', at: new Date().toISOString() });
  const prepared = await client.prepareDirectCheckout(offer);
  record.parsedReview = { asin: prepared.review.checkout.asin, asins: prepared.review.checkout.asins,
    code: prepared.review.checkout.code, title: prepared.review.checkout.title,
    itemCount: prepared.review.checkout.itemCount, quantity: prepared.review.checkout.quantity,
    sellerConfirmed: prepared.review.checkout.sellerConfirmed, deliveryConfirmed: prepared.review.checkout.deliveryConfirmed,
    totalYen: prepared.review.checkout.totalYen, shippingYen: prepared.review.checkout.shippingYen,
    identitySource: prepared.review.checkout.identitySource };
  if (!prepared.review.checkout.asin) {
    const $ = prepared.reviewPage.$, item = $('#checkout-item-block-0');
    const identityHints = [];
    $('script').each((_, node) => {
      const raw = $(node).html() || '';
      if (!raw.includes(target)) return;
      identityHints.push({ type: $(node).attr('type') || 'javascript', hasTarget: true,
        asinKeys: [...raw.matchAll(/([A-Za-z][A-Za-z0-9_.$-]{0,40})["']?\s*[:=]\s*["']?(B[A-Z0-9]{9})(?=["'\s&,<])/g)].map(match => ({ key: match[1], asin: match[2] })).slice(0,20) });
    });
    record.identityHints = { targetOccurrences: prepared.reviewPage.html.split(target).length - 1, scripts: identityHints,
      attributes: $('*').toArray().flatMap(node => Object.entries(node.attribs || {}).filter(([,value]) => value.includes(target)).map(([name]) => ({ tag: node.tagName, name }))).slice(0,25) };
    record.identityLayout = item.find('*').addBack().toArray().filter(node => Object.keys(node.attribs || {}).some(key => /asin|state|item/.test(key)) || node.tagName === 'script')
      .map(node => ({ tag: node.tagName, attributes: Object.keys(node.attribs || {}),
        inputName: $(node).is('input') ? $(node).attr('name') : undefined,
        stateKeys: (() => { try { return Object.keys(JSON.parse($(node).html() || '{}')); } catch { return []; } })() })).slice(0,40);
  }
  validateAmazonJpProductCheckout(prepared.review.checkout, { asin: target, code: 'BX-11', msrpYen: offer.priceYen, toleranceYen: 0, maxShippingYen: 500 });
  const submit = prepared.reviewPage.$('[name="placeYourOrder1"]').filter((_, node) => !prepared.reviewPage.$(node).is('[disabled]'));
  if (!submit.length) throw new Error('Final button is missing or disabled');
  record.events.push({ name: 'checkout_verified', at: new Date().toISOString() });
  record.measuredToReadyMs = Math.round(performance.now() - started);
  record.review = { finalButtonLocated: true, finalButtonName: 'placeYourOrder1',
    finalMethod: prepared.review.contract.method, finalEndpoint: evidenceEndpoint(prepared.review.contract.url),
    asin: prepared.review.checkout.asin, itemCount: prepared.review.checkout.itemCount, quantity: prepared.review.checkout.quantity,
    sellerConfirmed: prepared.review.checkout.sellerConfirmed, deliveryConfirmed: prepared.review.checkout.deliveryConfirmed,
    shippingYen: prepared.review.checkout.shippingYen, totalYen: prepared.review.checkout.totalYen, pointsUsed: prepared.review.checkout.pointsUsed };
  const offline = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const nativeContext = await offline.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await nativeContext.route('**/*', route => route.abort());
    const nativePage = await nativeContext.newPage();
    await nativePage.setContent(prepared.reviewPage.html, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    const native = await nativePage.evaluate(base => {
      const form = document.querySelector('#spc-form');
      const b = [...form.elements].find(e => e.name === 'placeYourOrder1' && !e.disabled);
      if (!b) return null;
      return { endpoint: new URL(b.getAttribute('formaction') ?? form.getAttribute('action'), base).pathname,
        method: (b.getAttribute('formmethod') ?? form.method).toUpperCase(),
        fields: [...new FormData(form, b)].filter(([name]) => name).map(([name, value]) => [name, name === b.name && !b.hasAttribute('value') ? '' : value]) };
    }, prepared.reviewPage.url);
    const local = prepared.review.contract;
    record.nativeFinal = { buttonLocated: Boolean(native),
      methodMatches: native?.method === local.method,
      endpointMatches: native?.endpoint === new URL(local.url).pathname,
      fieldsMatch: JSON.stringify([...local.fields]) === JSON.stringify(native?.fields),
      fieldCount: native?.fields.length || 0, localizedDefaultSubmitLabelExcluded: true };
    if (!record.nativeFinal.methodMatches || !record.nativeFinal.endpointMatches || !record.nativeFinal.fieldsMatch) throw new Error('Final API contract differs from native form submission');
  } finally { await offline.close(); }
  record.status = 'ready_to_submit_not_submitted';
} catch (error) {
  if (error.code === 'PROBE_CLEANUP_ONLY') record.status = 'cleanup_only';
  else {
    client?.captureFailure(error);
    record.status = 'failed'; record.error = safePurchaseText(error);
    record.errorCode = error.code || '';
    process.exitCode = 1;
  }
} finally {
  // Only remove a newly-created, exact BX-11 active cart item. This cleanup
  // client cannot add, buy-now or place an order.
  if (context && postStarted) {
    try {
      const cleanup = new AmazonJpHttpClient({ request: { fetch: async (url, options) => {
        const u = new URL(url);
        if (u.origin !== 'https://www.amazon.co.jp' || !(options.method === 'POST' ? /^\/cart(?:\/|$)/.test(u.pathname) : /\/gp\/cart\/view\.html$/.test(u.pathname))) throw new Error('Cleanup endpoint prohibited');
        if (options.method === 'POST' && (!options.data || /submit\.(?:buy|add)|placeYourOrder/.test(new URLSearchParams(options.data).toString()))) throw new Error('Cleanup mutation prohibited');
        return context.request.fetch(url, options);
      } } });
      const cart = await cleanup.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
      const ownItems = cart.$(`#sc-active-cart [data-asin="${target}"][data-itemid]`).toArray()
        .filter(node => !previousCartIds.has(cart.$(node).attr('data-itemid')))
        .filter(node => !cleanupOnly || cart.$(node).attr('data-itemid') === record.cleanup.expectedItemId);
      if (ownItems.length > 1) throw new Error('Test item is ambiguous; cart left untouched');
      if (ownItems.length === 1) {
        const own = cart.$(ownItems[0]), id = own.attr('data-itemid');
        record.cleanup.ownItemId = id;
        const remove = own.find('input[name^="submit.delete-active."],button[name^="submit.delete-active."],input[name^="submit.delete."],button[name^="submit.delete."]').first();
        const form = remove.closest('form');
        const contract = amazonHttpForm(cart, form, remove.attr('name'));
        if (!remove.length || !remove.attr('name').endsWith(id) || contract.method !== 'POST') throw new Error('Test cleanup form not verified');
        await cleanup.sendForm(cart, form, remove.attr('name'));
        const after = await cleanup.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
        if (after.$(`#sc-active-cart [data-itemid="${id}"]`).length) throw new Error('Test cleanup not confirmed; never repeated');
        record.cleanup.testItemRemoved = true;
      } else record.cleanup.testItemNotPresent = true;
    } catch (error) { record.cleanup.error = safePurchaseText(error); }
  }
  await evidence.queue;
  await context?.close().catch(error => { record.preparation.closeError = safePurchaseText(error); });
  if (paused) {
    try {
      const current = await status();
      if (current.targetUrl === original.targetUrl && !current.enabled && !current.running) {
        await settings(original); record.preparation.originalSettingsRestored = true;
      } else record.preparation.restoreSkipped = 'User settings changed; not overwritten';
    } catch (error) { record.preparation.restoreError = safePurchaseText(error); }
  }
  record.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify(record));
}
