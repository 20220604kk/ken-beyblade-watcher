// Read-only contract inspection. No account profile/cookies, cart request,
// buy-now POST, checkout request, order lookup, or final order submission.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { request, chromium } from 'playwright';
import { load } from 'cheerio';
import { amazonHttpForm, parseAmazonDirectBuyForm } from '../src/amazon-jp-http.js';

const asin = process.argv[2] || 'B0C533Q31X';
if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('Invalid ASIN');
const url = `https://www.amazon.co.jp/dp/${asin}?m=AN1VRQENFRJN5&language=ja_JP&currency=JPY`;
const api = await request.newContext();
let browser;
try {
  const response = await api.get(url, { timeout: 15_000, maxRetries: 0 });
  const html = await response.text(), $ = load(html);
  const button = $('#buy-now-button').first(), form = button.closest('form');
  if (response.status() !== 200 || !button.length) throw new Error(`Product form unavailable: HTTP ${response.status()}`);
  const page = { url, $, html, status: response.status() };
  const contract = amazonHttpForm(page, form, 'submit.buy-now');
  const quote = Number(contract.fields.get('items[0.base][customerVisiblePrice][amount]'));
  const validation = parseAmazonDirectBuyForm(page, { asin, priceYen: quote,
    freshOfferId: contract.fields.get('items[0.base][offerListingId]') });
  // Offline native DOM is the oracle for submitter action/fields. Disable page
  // scripts and abort all resource requests, so it cannot talk to Amazon.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
  let blockedResources = 0;
  await context.route('**/*', route => { blockedResources++; return route.abort(); });
  const dom = await context.newPage();
  await dom.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  const native = await dom.evaluate(base => {
    const b = document.querySelector('#buy-now-button'), f = b.form;
    return { url: new URL(b.getAttribute('formaction') ?? f.getAttribute('action') ?? '', base).href,
      method: (b.getAttribute('formmethod') ?? f.method).toUpperCase(),
      fields: [...new FormData(f, b).entries()].filter(([name]) => name)
        .map(([name, value]) => [name, name === b.name && !b.hasAttribute('value') ? '' : value]) };
  }, url);
  const fieldsMatch = JSON.stringify([...contract.fields]) === JSON.stringify(native.fields);
  const report = { at: new Date().toISOString(), asin, httpStatus: response.status(),
    parentAction: form.attr('action'), buttonAction: button.attr('formaction') || '',
    resolvedEndpoint: new URL(validation.contract.url).pathname, method: contract.method,
    matchesNativeAction: contract.url === native.url, matchesNativeMethod: contract.method === native.method,
    matchesNativeFields: fieldsMatch, localizedDefaultSubmitLabelExcluded: !button.is('[value]'),
    fieldCount: native.fields.length, parsedFieldCount: [...contract.fields].length,
    mismatchedFieldNames: [...new Set([...contract.fields.keys(), ...native.fields.map(([name]) => name)])]
      .filter(name => JSON.stringify(contract.fields.getAll(name)) !== JSON.stringify(native.fields.filter(([key]) => key === name).map(([,value]) => value))),
    blockedResources, externalMutations: 0, checkoutRequests: 0, ordersCreated: 0 };
  const output = fileURLToPath(new URL('../data/diagnostics/amazon-direct-contract-check.json', import.meta.url));
  await fs.mkdir(fileURLToPath(new URL('../data/diagnostics/', import.meta.url)), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (!report.matchesNativeAction || !report.matchesNativeMethod || !fieldsMatch) throw new Error('HTTP contract differs from native DOM submission');
} finally { await browser?.close(); await api.dispose(); }
