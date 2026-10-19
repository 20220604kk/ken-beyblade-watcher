// Read-only diagnostic. Never adds to cart, submits an order, or retries.
// The ephemeral input comes from the user's authorized Amazon session.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { load } from 'cheerio';

const inputPath = path.resolve(process.argv[2] || '');
const privateRoot = path.resolve('data/records/amazon-http-tests');
if (path.dirname(inputPath) !== privateRoot || path.basename(inputPath) !== 'comparison-session.tmp.json') {
  throw new Error('Only the named private diagnostic input is accepted');
}
let session;
try {
  session = JSON.parse(await fs.readFile(inputPath, 'utf8'));
} finally {
  // Remove the credential-bearing handoff before any external request.
  await fs.unlink(inputPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
const target = new URL(session.url);
if (target.origin !== 'https://www.amazon.co.jp' || !target.pathname.startsWith('/gp/product/ajax/aodAjaxMain/')) {
  throw new Error('Only the observed Amazon AOD read endpoint is accepted');
}
const cookies = (session.cookies || []).filter(cookie => {
  const domain = cookie.domain.replace(/^\./, '');
  return (domain === 'amazon.co.jp' || domain === 'www.amazon.co.jp')
    && target.pathname.startsWith(cookie.path || '/')
    && (!cookie.expires || cookie.expires < 0 || cookie.expires > Date.now() / 1000);
});
const headers = { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
for (const name of ['User-Agent', 'Accept-Language', 'Accept', 'Referer', 'X-Requested-With']) {
  const value = session.headers?.[name] || session.headers?.[name.toLowerCase()];
  if (value) headers[name] = value;
}
const started = performance.now();
try {
  const response = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const headersMs = performance.now() - started;
  const html = await response.text();
  const bodyMs = performance.now() - started;
  const $ = load(html);
  const blocked = /Robot Check|Enter the characters you see|画像に表示されている文字|captcha/i.test(html);
  const offers = $('#aod-offer').map((_, offer) => {
    const node = $(offer);
    return {
      priceText: node.find('.a-price .a-offscreen, .apex-pricetopay-accessibility-label').first().text().trim()
        || node.find('.apex-pricetopay-value').first().text().replace(/\s+/g, ' ').trim(),
      sellerText: node.find('#aod-offer-soldBy').text().replace(/\s+/g, ' ').trim(),
      shippingText: node.find('[data-csa-c-delivery-price]').attr('data-csa-c-delivery-price') || '',
      formPaths: node.find('form').map((_, form) => {
        const action = $(form).attr('action');
        return action ? new URL(action, target).pathname : null;
      }).get(),
      formFieldNames: [...new Set(node.find('input[name]').map((_, field) => $(field).attr('name')).get().filter(Boolean))]
    };
  }).get();
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(), method: 'GET', path: target.pathname,
    status: response.status, mime: response.headers.get('content-type'),
    headersMs: Math.round(headersMs), bodyMs: Math.round(bodyMs),
    blocked, offers, responseBytes: Buffer.byteLength(html),
    cartMutated: false, orderSubmitted: false,
    sessionFileRemoved: true,
    caveat: 'Independent HTTP transport using the same authorized session; not a browser network request or a completed checkout comparison.'
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({method: 'GET', path: target.pathname, failed: true,
    errorName: error.name, elapsedMs: Math.round(performance.now() - started),
    cartMutated: false, orderSubmitted: false, sessionFileRemoved: true}, null, 2));
  process.exitCode = 1;
} finally {
  session = null;
  headers.Cookie = '';
}
