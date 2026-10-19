import { load } from 'cheerio';

export const JAPAN_STORE_TARGETS = [
  { id: 'japan-ocn-official-beyblade', name: 'OCN 官網 Beyblade 搜尋', siteName: 'OCN 官網', sourceType: 'ocn',
    url: 'https://nttxstore.jp/shop/goods/search.aspx?search=x&ct=&keyword=beyblade&search=search', enabled: true, minIntervalSeconds: 60 },
  { id: 'japan-nojima-beyblade', name: 'Nojima Beyblade 搜尋', siteName: 'Nojima Online', sourceType: 'nojima',
    url: 'https://online.nojima.co.jp/app/catalog/list/init?searchCategoryCode=0&searchMethod=0&searchWord=beyblade', enabled: true, minIntervalSeconds: 60 },
  { id: 'japan-toysrus-beyblade', name: '日本玩具反斗城 CX-20／BX-54 優先搜尋', siteName: '玩具反斗城.jp', sourceType: 'toysrus',
    url: 'https://www.toysrus.co.jp/ja-jp/search/?q=%E3%83%99%E3%82%A4%E3%83%96%E3%83%AC%E3%83%BC%E3%83%89&lang=ja_JP', focusKeywords: ['CX-20', 'BX-54'], enabled: true, minIntervalSeconds: 60 }
];
export const isJapanStore = source => ['ocn', 'nojima', 'toysrus'].includes(source);
export function ensureJapanStoreTargets(targets) {
  for (const target of JAPAN_STORE_TARGETS) {
    if (!targets.some(item => item.id === target.id || item.url === target.url || item.sourceType === target.sourceType)) targets.push({ ...target });
  }
}
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const yen = value => { const n = Number(String(value ?? '').replace(/[,￥¥円\s]/g, '')); return Number.isSafeInteger(n) && n > 0 ? `¥${n.toLocaleString('en-US')}` : ''; };
const hosts = { ocn: 'nttxstore.jp', nojima: 'online.nojima.co.jp', toysrus: 'www.toysrus.co.jp' };
const failure = (message, code = 'scan_failed') => Object.assign(new Error(message), { code });
function officialUrl(value, base, source) {
  if (!value) return '';
  try { const u = new URL(value, base); if (u.protocol !== 'https:' || u.hostname !== hosts[source] || u.username || u.password) return ''; u.hash = ''; return u.href; } catch { return ''; }
}
export function classifyJapanStoreUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.hostname === 'nttxstore.jp' && url.pathname === '/shop/goods/search.aspx' && clean(url.searchParams.get('keyword'))) {
    return { ...JAPAN_STORE_TARGETS[0], url: url.href, defaultName: 'OCN 官網商品搜尋', parserLabel: 'OCN 清單＋商品頁庫存核對' };
  }
  if (url.hostname === 'online.nojima.co.jp' && url.pathname === '/app/catalog/list/init' && clean(url.searchParams.get('searchWord'))) {
    return { ...JAPAN_STORE_TARGETS[1], url: url.href, defaultName: 'Nojima 商品搜尋', parserLabel: 'Nojima 官方結構化資料（目前存取受限）' };
  }
  if (url.hostname === 'www.toysrus.co.jp' && (url.pathname === '/ja-jp/' || url.pathname.startsWith('/ja-jp/search/') || url.pathname === '/ja-jp/beyblade-x/')) {
    return { ...JAPAN_STORE_TARGETS[2], url: url.pathname.startsWith('/ja-jp/search/') ? url.href : JAPAN_STORE_TARGETS[2].url,
      defaultName: '日本玩具反斗城 陀螺搜尋', parserLabel: '玩具反斗城商品卡片／庫存解析' };
  }
  return null;
}
function structuredProducts($) {
  const out = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if ([value['@type']].flat().includes('Product')) out.push(value);
    else Object.values(value).forEach(visit);
  }
  $('script[type="application/ld+json"]').each((_, n) => { try { visit(JSON.parse($(n).text())); } catch { /* no guessed fallback */ } });
  return out;
}
function schemaAvailability(value) {
  const name = String(value || '').split('/').pop();
  return ['InStock', 'PreOrder', 'LimitedAvailability'].includes(name) ? true
    : ['OutOfStock', 'SoldOut', 'Discontinued'].includes(name) ? false : null;
}
export function parseOcnList(html, base) {
  const $ = load(html), seen = new Set(), result = [];
  $('.block-thumbnail-t--item').each((_, node) => {
    const e = $(node), a = e.find('a[href]').first(), url = officialUrl(a.attr('href'), base, 'ocn');
    const id = url && new URL(url).pathname.match(/^\/shop\/g\/g([A-Z0-9]+)\/$/i)?.[1]?.toUpperCase();
    const title = clean(e.find('.block-thumbnail-t--goods-name').text());
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    result.push({ id, title, url, price: yen(e.find('.block-thumbnail-t--price').first().text()),
      imageUrl: officialUrl(e.find('img').attr('src'), base, 'ocn'), available: null });
  });
  const total = clean($('.pager-total,.pager-count').first().text()).match(/全\s*([\d,]+)\s*件/)?.[1];
  // Refuse incomplete discovery instead of pretending missing pages are sold out.
  if (total && Number(total.replace(/,/g, '')) !== result.length) throw failure('OCN 搜尋結果分頁或截斷；保留既有基線');
  return result;
}
export function parseOcnDetail(html, expected) {
  const $ = load(html);
  const candidates = structuredProducts($).filter(product => !product.mpn || String(product.mpn).toUpperCase() === expected.id);
  if (candidates.length !== 1) throw failure('OCN 商品身份資料不完整；保留既有基線');
  const product = candidates[0], offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const available = schemaAvailability(offer?.availability), price = yen(offer?.price);
  if (!clean(product.name) || offer?.priceCurrency !== 'JPY' || !price || available === null) throw failure('OCN 價格或庫存狀態未確認；保留既有基線');
  return { ...expected, title: clean(product.name), price, available, availabilityKnown: true,
    detail: clean($('.block-goods-stock-msg').text()) || `OCN｜${String(offer.availability).split('/').pop()}` };
}
export function parseToysRUsProducts(html, base) {
  const $ = load(html), seen = new Set(), products = [];
  $('.product-tile[data-pid]').each((_, n) => {
    const e = $(n), id = clean(e.attr('data-pid'));
    const a = e.find('a[itemprop="url"],a.card-link').first(), url = officialUrl(a.attr('href'), base, 'toysrus');
    const title = clean(e.find('[itemprop="name"]').text());
    if (!id || !title || !url || !/\/[^/]+\.html$/.test(new URL(url).pathname) || seen.has(id)) return;
    seen.add(id);
    let meta = {}; try { meta = JSON.parse(e.attr('data-metadata') || '{}'); } catch { /* require explicit DOM state */ }
    const unavailable = /在庫なし|在庫切れ|完売|販売終了/.test(clean(e.find('.availability-container').text())) || meta.location_id === 'out_of_stock';
    const cart = e.find('button.add-to-cart-tile').filter((_, button) => !$(button).is('[disabled],[aria-disabled="true"]')).length > 0;
    const available = unavailable ? false : cart || meta.location_id === 'in_stock' ? true : null;
    products.push({ id, title, url, price: yen(e.find('.sales .value').attr('content') || meta.price),
      imageUrl: officialUrl(e.find('img').attr('data-src') || e.find('img').attr('src'), base, 'toysrus'),
      available, availabilityKnown: available !== null, detail: available === null ? '官網可購狀態未確認' : /予約/.test(title) ? '官網預購商品' : '日本玩具反斗城' });
  });
  return products;
}
export function parseNojimaProducts(html, base) {
  const $ = load(html), products = [], seen = new Set();
  // Currently unverified on the live search response (HTTP 403). Only accept
  // explicit standard product+offer evidence; listing presence is not inventory.
  for (const product of structuredProducts($)) {
    const url = officialUrl(product.url, base, 'nojima');
    const id = url && new URL(url).pathname.match(/^\/commodity\/\d+\/(\d+)\/$/)?.[1];
    const title = clean(product.name), offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    if (!id || !title || seen.has(id) || offer?.priceCurrency !== 'JPY') continue;
    seen.add(id);
    const secretSale = /シークレット販売|抽選/.test(title);
    const available = secretSale ? false : schemaAvailability(offer.availability);
    products.push({ id, title, url, price: yen(offer.price), imageUrl: officialUrl([product.image].flat()[0], base, 'nojima'),
      available, availabilityKnown: available !== null, detail: secretSale ? '抽選／限定資格商品，不當作一般可購補貨' : 'Nojima 官網結構化資料' });
  }
  return products;
}
export function parseJapanStoreProducts(html, target) {
  return target.sourceType === 'ocn' ? parseOcnList(html, target.url) : target.sourceType === 'toysrus'
    ? parseToysRUsProducts(html, target.url) : parseNojimaProducts(html, target.url);
}
async function readHtml(url, source, fetcher) {
  if (!officialUrl(url, url, source)) throw failure('拒絕讀取非指定官網網址');
  let r;
  try { r = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/html', 'Accept-Language': 'ja-JP,ja;q=0.9' } }); }
  catch { throw failure('官網讀取逾時或連線中斷；保留既有基線'); }
  if ([403, 429, 503].includes(r.status)) throw failure(`官網 HTTP ${r.status}，停止本輪並降速；不繞過驗證`, 'verification_required');
  if (r.status !== 200) throw failure(`官網 HTTP ${r.status}，不接受跳轉或部分回覆`);
  let html;
  try { html = await r.text(); } catch { throw failure('官網回覆讀取中斷；保留既有基線'); }
  if (/安全にロード中|正在執行安全驗證|Access Denied|Just a moment|Robot Check|cf-chl-widget|_cf_chl_opt/i.test(html.slice(0,12000))) throw failure('官網回傳安全驗證頁；保留既有基線並降速', 'verification_required');
  return html;
}
export function toysRUsDiscoveryUrls(target) {
  const focus = [...new Set((target.focusKeywords || []).filter(word => /^(?:BX|CX|UX)-\d{2}$/i.test(word)))].slice(0, 2);
  return [...new Set([...focus.map(word => {
    const url = new URL('/ja-jp/search/', 'https://www.toysrus.co.jp');
    url.searchParams.set('q', word); url.searchParams.set('lang', 'ja_JP'); return url.href;
  }), target.url])];
}
function explicitEmptyItemList(html) {
  const $ = load(html);
  let empty = false;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if ([value['@type']].flat().includes('ItemList') && Array.isArray(value.itemListElement) && value.itemListElement.length === 0) empty = true;
    Object.values(value).forEach(visit);
  };
  $('script[type="application/ld+json"]').each((_, node) => { try { visit(JSON.parse($(node).text())); } catch { /* not proof of zero results */ } });
  return empty;
}
function parseToysDetail(html, expected) {
  const $ = load(html);
  const product = structuredProducts($).find(p => String(p.sku || p.productID) === expected.id
    || officialUrl(p.url, expected.url, 'toysrus') === expected.url);
  const offer = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  const available = schemaAvailability(offer?.availability);
  if (!product || !clean(product.name) || offer?.priceCurrency !== 'JPY' || !yen(offer.price) || available === null) {
    throw failure('玩具反斗城已知商品頁庫存未確認；保留既有基線');
  }
  return { ...expected, title: clean(product.name), price: yen(offer.price), available, availabilityKnown: true };
}
export async function readJapanStoreProducts(target, { fetcher = fetch, knownProducts = [] } = {}) {
  if (target.sourceType === 'toysrus') {
    const found = new Map();
    // Discovery queries use the official search form. A challenge aborts the
    // whole round, never tries another URL as a way around that challenge.
    for (const url of toysRUsDiscoveryUrls(target)) {
      const html = await readHtml(url, 'toysrus', fetcher), rows = parseToysRUsProducts(html, url);
      if (!rows.length && !explicitEmptyItemList(html)) throw failure('玩具反斗城搜尋頁無法確認結果；保留基線，不當作售罄');
      for (const row of rows) found.set(row.id, row);
    }
    const missing = knownProducts.filter(p => !found.has(p.id) && officialUrl(p.url, target.url, 'toysrus')
      && /^\/ja-jp\/[^/]+\.html$/.test(new URL(p.url).pathname));
    if (missing.length > 24) throw failure('玩具反斗城已知商品超過單輪直查上限 24 件；保留基線');
    for (const old of missing) found.set(old.id, parseToysDetail(await readHtml(old.url, 'toysrus', fetcher), old));
    const rows = [...found.values()];
    // The monitor only accepts zero when every search supplied explicit proof.
    Object.defineProperty(rows, 'verifiedEmpty', { value: rows.length === 0 });
    return rows;
  }
  const products = parseJapanStoreProducts(await readHtml(target.url, target.sourceType, fetcher), target);
  if (!products.length) throw failure('官網沒有可驗證商品資料；不把空白或驗證頁當作售罄');
  if (target.sourceType !== 'ocn') return products;
  if (products.length > 48) throw failure('OCN 品項超過本輪安全上限 48 件，需調整分頁方案');
  const confirmed = new Array(products.length);
  let cursor = 0, stopped = false;
  // At most two detail reads. Drain in-flight reads before reporting failure;
  // an incomplete batch never replaces the stored inventory baseline.
  const work = async () => {
    while (!stopped && cursor < products.length) {
      const i = cursor++;
      try { confirmed[i] = parseOcnDetail(await readHtml(products[i].url, 'ocn', fetcher), products[i]); }
      catch (error) { stopped = true; throw error; }
    }
  };
  const results = await Promise.allSettled([work(), work()]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return confirmed;
}
