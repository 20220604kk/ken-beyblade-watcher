// Adapted from the owner's single-product extension at 284b522 (v2.0.6).
// Only returned official contracts are followed; no invented checkout tokens.
import { load } from 'cheerio';
const ORIGIN = 'https://www.amazon.co.jp';
export const AMAZON_BUY_SELECTOR = ['#buybox', '#desktop_buybox'].flatMap(root =>
  ['#buy-now-button', '#pre-order-button', '#preorder-button', '[name="submit.buy-now"]',
    '[name="submit.pre-order"]', '[name="submit.preorder"]'].map(button => `${root} ${button}`)).join(',');

export function amazonBuyButton($) {
  return $(AMAZON_BUY_SELECTOR).filter((_, node) => {
    const e = $(node);
    return ['input', 'button'].includes(node.tagName) && !e.is('[disabled],[aria-disabled="true"]')
      && /^(?:submit\.(?:buy-now|pre-order|preorder))$/.test(e.attr('name') || '')
      && (e.attr('type') || (node.tagName === 'button' ? 'submit' : '')).toLowerCase() === 'submit';
  }).first();
}

export function amazonProductPrice($, parseYen) {
  for (const region of ['#corePriceDisplay_desktop_feature_div', '#corePrice_feature_div', '#apex_desktop', '#desktop_buybox', '#buybox']) {
    const values = $(region).find('.apex-pricetopay-accessibility-label,.apex-pricetopay-value,.priceToPay .a-offscreen,.apexPriceToPay .a-offscreen,.a-price:not(.a-text-price) .a-offscreen,#price_inside_buybox')
      .filter((_, n) => !$(n).closest('.a-text-price,del,s,[hidden],[aria-hidden="true"]').length)
      .toArray().map(n => parseYen($(n).text())).filter(n => n > 0);
    const unique = [...new Set(values)];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) return null;
  }
  return null;
}

function official(value, base) {
  try {
    const url = new URL(value, base);
    return url.origin === ORIGIN && !url.username && !url.password ? url : null;
  } catch { return null; }
}
export function amazonReviewUrl(value, base = ORIGIN) {
  const url = official(value, base);
  return url && ![...url.searchParams].some(([k, v]) => /placeyourorder|enroll|subscribe|start.?trial/i.test(k)
    || /^(?:accept|enroll|subscribe|start.?trial|place.?order)$/i.test(v))
    && /^\/(?:checkout\/p\/[^/]+\/(?:spc|itemselect)|gp\/buy\/spc\/handlers\/display\.html)\/?$/.test(url.pathname) ? url.href : null;
}

// A final form identifies its own SPC flow. Its final endpoint is NEVER read.
export function amazonCheckoutRenderUrl(page) {
  const $ = page.$ || load(page.html || ''), candidates = new Set();
  const add = value => { const url = amazonReviewUrl(value, page.url); if (url) candidates.add(url); };
  $('form[action]').each((_, n) => {
    const url = official($(n).attr('action'), page.url);
    if (url && /^\/checkout\/p\/[^/]+\/spc\/place-order\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/place-order\/?$/, ''); add(url.href);
    }
  });
  $('a[href]').each((_, n) => add($(n).attr('href')));
  $('meta[http-equiv]').each((_, n) => {
    if (/^refresh$/i.test($(n).attr('http-equiv'))) add($(n).attr('content')?.match(/url\s*=\s*["']?([^"']+)/i)?.[1]?.trim());
  });
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    for (const [key, child] of Object.entries(value).slice(0, 200)) {
      if (/^(?:redirectUrl|redirectURL|checkoutUrl|checkoutURL)$/.test(key) && typeof child === 'string') add(child);
      else if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  $('script[type="application/json"],script[type="a-state"]').each((_, n) => {
    const raw = $(n).text(); if (raw.length > 200_000) return;
    try { walk(JSON.parse(raw)); } catch { /* never execute returned scripts */ }
  });
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function amazonPrimeDecline(page, formContract) {
  const $ = page.$;
  if (!/Prime|プライム|会员|會員/i.test($('body').text())) return null;
  const refusal = /(?:いいえ|登録しない|申し込まない|辞退|しないで続行|No\s*,?\s*thanks|decline|不，谢谢|不，謝謝|不需要|不加入|暫不|暂不)/i;
  const forbidden = /accept|enroll|subscribe|start.?trial|placeyourorder/i;
  const valid = contract => {
    const url = official(contract.url, page.url); if (!url) return false;
    const fields = [...contract.fields];
    if ([...url.searchParams, ...fields].some(([k, v]) => forbidden.test(k) || /^(?:accept|enroll|subscribe|start.?trial)$/i.test(v))) return false;
    const actions = [...url.searchParams.getAll('action'), ...contract.fields.getAll('action')];
    const decline = /^\/(?:-\/(?:zh|en|ja)\/)?(?:gp\/(?:buy\/)?)?prime\/handler$/.test(url.pathname)
      && actions.length === 1 && actions[0] === 'decline';
    return contract.method === 'GET' ? decline || Boolean(amazonReviewUrl(url.href))
      : contract.method === 'POST' && decline && Boolean(contract.fields.get('anti-csrftoken-a2z'));
  };
  const candidates = [];
  $('a[href]').each((_, n) => {
    if (!refusal.test($(n).text())) return;
    const url = official($(n).attr('href'), page.url);
    if (url) { const c = { url: url.href, method: 'GET', fields: new URLSearchParams() }; if (valid(c)) candidates.push(c); }
  });
  $('input[type="submit"][name],button[name]').each((_, n) => {
    const button = $(n);
    if (button.is('[disabled],[aria-disabled="true"]') || !refusal.test(button.attr('value') + ' ' + button.text())) return;
    try { const c = formContract(page, button.closest('form'), button.attr('name')); if (valid(c)) candidates.push(c); } catch { /* incomplete decline is not permission to enroll */ }
  });
  const unique = new Map(candidates.map(c => [JSON.stringify([c.url, c.method, c.fields.toString()]), c]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export function amazonCartEntry(page, formContract) {
  const $ = page.$, candidates = [];
  const add = contract => {
    const url = official(contract.url, page.url);
    const counts = [...(url?.searchParams.getAll('cartItemCount') || []), ...contract.fields.getAll('cartItemCount')];
    if (url?.pathname !== '/checkout/entry/cart' || !counts.length || counts.some(v => v !== '1')) return;
    if (contract.method === 'POST' && !contract.fields.get('anti-csrftoken-a2z')) return;
    if (!['GET', 'POST'].includes(contract.method)) return;
    candidates.push(contract);
  };
  $('a[href]').each((_, n) => { const url = official($(n).attr('href'), page.url); if (url) add({ url: url.href, method: 'GET', fields: new URLSearchParams() }); });
  $('[name="proceedToRetailCheckout"],[name="proceedToCheckout"]').each((_, n) => {
    try { add(formContract(page, $(n).closest('form'), $(n).attr('name'))); } catch { /* no guessing */ }
  });
  const unique = new Map(candidates.map(c => [JSON.stringify([c.url, c.method, c.fields.toString()]), c]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export function amazonSmartWagonEntry(page, asin, formContract) {
  const $ = page.$;
  if (!/^\/cart\/add-to-cart(?:\/|$)/.test(new URL(page.url).pathname)
    || !/カートに追加|已加入(?:购物车|購物車)|Added to cart/i.test($('#sw-atc-confirmation').text())
    || $('#nav-cart-count').text().trim() !== '1') return null;
  const ids = new Set($('#sw-atc-details-single-container a[href*="/dp/"]').toArray()
    .map(n => official($(n).attr('href'), page.url)?.pathname.match(/\/dp\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]).filter(Boolean));
  return ids.size === 1 && ids.has(asin) ? amazonCartEntry(page, formContract) : null;
}

export function amazonItemSelection(page, asin, formContract) {
  const from = official(page.url, ORIGIN), $ = page.$;
  if (!from || !/^\/checkout\/p\/[^/]+\/itemselect\/?$/.test(from.pathname)) return null;
  const roots = $('[id^="item-block-"],[id^="checkout-item-block-"],.lineitem,.checkout-item-block')
    .filter((_, n) => /^(?:checkout-item-block|item-block)-\d+$/.test($(n).attr('id') || '') || $(n).is('.lineitem,.checkout-item-block'));
  if (roots.length !== 1) return null;
  const row = roots.first();
  const ids = new Set(row.find('[data-asin],input[name="ASIN"],input[name="asin"],a[href*="/dp/"]')
    .addBack('[data-asin]').toArray().map(n => $(n).attr('data-asin') || $(n).attr('value')
      || official($(n).attr('href'), page.url)?.pathname.match(/\/dp\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]).filter(Boolean));
  const quantities = row.find('[data-a-selector="inner-value"],select[name*="quantity"] option[selected],input[name*="quantity"]')
    .toArray().map(n => $(n).attr('value') ?? $(n).text().trim());
  if (ids.size !== 1 || !ids.has(asin) || !quantities.length || quantities.some(v => v !== '1')
    || !/(?:販売元|出品者|卖家|賣家|Seller)\s*[:：]?\s*Amazon\.co\.jp(?![\w.-])/i.test(row.text())
    || /中古|二手|Used|Renewed/i.test(row.text())) return null;
  const prefix = from.pathname.replace(/\/itemselect\/?$/, '/'), candidates = [];
  $('input[type="submit"][name],button[name]').each((_, n) => {
    const button = $(n);
    if (button.is('[disabled],[aria-disabled="true"]') || !/次に進|続行|Continue|继续|繼續/i.test(button.attr('value') + ' ' + button.text())) return;
    try {
      const contract = formContract(page, button.closest('form'), button.attr('name'));
      const to = official(contract.url, page.url);
      if (!to || ![prefix + 'spc', prefix + 'itemselect'].includes(to.pathname.replace(/\/$/, ''))
        || !['GET', 'POST'].includes(contract.method) || contract.method === 'POST' && !contract.fields.get('anti-csrftoken-a2z')
        || [...to.searchParams, ...contract.fields].some(([k, v]) => /placeyourorder|enroll|subscribe|start.?trial/i.test(k)
          || /quantity|(?:^|\.)qty(?:$|\[)/i.test(k) && v !== '1')) return;
      candidates.push(contract);
    } catch { /* actual, unique official continuation only */ }
  });
  return candidates.length === 1 ? candidates[0] : null;
}
