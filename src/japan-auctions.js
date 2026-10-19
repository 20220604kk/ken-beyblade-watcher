import fs from 'node:fs/promises';
import { monitoringRoute } from './monitoring-resources.js';
import path from 'node:path';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { chromium } from 'playwright';
import { canonicalRakutenItemUrl, parseRakutenItem } from './rakuten-item.js';
import { isJapanStore, classifyJapanStoreUrl, parseJapanStoreProducts, readJapanStoreProducts } from './japan-stores.js';

const BLOCKED_WORDS = /Just a moment|Checking your browser|Attention Required|Reference\s*#|アクセスが集中|Bot detection|通信に問題があるためアクセスを遮断|正在執行安全驗證|驗證您是人類|請稍候|セキュリティ検証|人間であることを確認/i;
const BLOCKED_MARKUP = /cdn-cgi\/challenge-platform|cf-chl-widget|_cf_chl_opt|challenges\.cloudflare\.com\/turnstile/i;
const HTTP_FAST_PATH_SOURCES = new Set(['rakuten-item', 'rakuten-search', 'rakuten-books', 'taiyo']);
export const JAPAN_AUCTION_NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const JAPAN_AUCTION_NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const JAPAN_1999_BEYBLADE_LIST_URL = 'https://www.1999.co.jp/list/2613/7/1?soldout=0';
export const JAPAN_RAKUTEN_MARKET_URL = 'https://search.rakuten.co.jp/search/mall/beyblade/';

export function ensureRakutenMarketTarget(targets) {
  if (targets.some(target => target.id === 'japan-rakuten-market-beyblade' || target.url === JAPAN_RAKUTEN_MARKET_URL)) return;
  targets.push({ id: 'japan-rakuten-market-beyblade', name: '日本樂天全市場 Beyblade 搜尋（第 1 頁）',
    siteName: '日本樂天市場', sourceType: 'rakuten-search', url: JAPAN_RAKUTEN_MARKET_URL, enabled: true });
}

export function japanAuctionFailureDelayMs(sourceType, failureCount, baseIntervalSeconds, { verificationRequired = false } = {}) {
  const baseMs = Math.max(1, Number(baseIntervalSeconds) || 20) * 1000;
  if (sourceType !== 'edion' && !isJapanStore(sourceType) && !verificationRequired) return baseMs;
  const attempt = Math.max(1, Number(failureCount) || 1);
  return Math.min(15 * 60_000, Math.max(60_000, baseMs * (2 ** Math.min(attempt, 6))));
}

export const DEFAULT_JAPAN_EXCLUDE_KEYWORDS = [
  'ギアケース',
  'Gear Case',
  'デッキケース',
  'Deck Case',
  'バトルボックス',
  'バトルケース',
  '戰鬥盒',
  '战斗盒',
  '戰鬥箱',
  '战斗箱',
  '收納包'
];

const LEGACY_BEYBLADE_WORDS = /メタルファイト|metal\s*fight|ベイブレード\s*バースト|beyblade\s*burst|爆転シュート|bakuten\s*shoot/i;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).href; } catch { return ''; }
}

function productId(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '') || url;
  } catch {
    return url;
  }
}

function canonical1999ProductId(value) {
  try {
    const parsed = new URL(String(value || ''), 'https://www.1999.co.jp/');
    const itemNumber = parsed.pathname.match(/(?:^|\/)(\d{7,})(?:\/$|$)/)?.[1];
    return itemNumber || productId(parsed.href);
  } catch {
    return productId(value);
  }
}

function normalize1999RecordMap(records = {}) {
  const normalized = {};
  for (const [legacyId, record] of Object.entries(records || {})) {
    const id = canonical1999ProductId(record?.url || record?.id || legacyId);
    if (!id) continue;
    normalized[id] = {
      ...record,
      id,
      ...(/^\d{7,}$/.test(id) ? { url: `https://www.1999.co.jp/${id}` } : {})
    };
  }
  return normalized;
}

export function japanAuctionProductKey(product) {
  const title = normalizedProductText(product).toUpperCase();
  const model = title.match(/(?:^|[^A-Z0-9])(BXG|BX|UX|CX)\s*-?\s*(\d{1,3})(?!\d)/i);
  if (model) {
    const code = `${model[1].toUpperCase()}-${model[2]}`;
    // BX-00 is reused for many genuinely different limited products, so its
    // whole title remains part of the identity instead of merging every BX-00.
    return code === 'BX-00' ? `model:${code}:${title}` : `model:${code}`;
  }
  const stableId = clean(product?.id) || productId(product?.url || '');
  return stableId ? `product:${stableId}` : `title:${title}`;
}

function htmlCharset(response, bytes) {
  const contentType = String(response?.headers?.get?.('content-type') || '');
  const headerMatch = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i);
  if (headerMatch?.[1]) return headerMatch[1];
  const head = Buffer.from(bytes).subarray(0, 4096).toString('latin1');
  const metaMatch = head.match(/charset\s*=\s*["']?([a-z0-9_-]+)/i);
  return metaMatch?.[1] || 'utf-8';
}

async function decodeHtmlResponse(response) {
  if (typeof response?.arrayBuffer !== 'function') return response.text();
  const bytes = Buffer.from(await response.arrayBuffer());
  const declared = htmlCharset(response, bytes).trim().toLowerCase();
  const charset = declared === 'shift-jis' || declared === 'shift_jis' || declared === 'sjis'
    ? 'shift_jis'
    : declared === 'eucjp' || declared === 'x-euc-jp'
      ? 'euc-jp'
      : declared;
  return iconv.decode(bytes, iconv.encodingExists(charset) ? charset : 'utf-8');
}

function normalizedProductText(product) {
  return clean(typeof product === 'string' ? product : product?.title)
    .normalize('NFKC');
}

export function isBeybladeXProduct(product) {
  const text = normalizedProductText(product);
  if (!text || LEGACY_BEYBLADE_WORDS.test(text)) return false;
  return /BEYBLADE\s*X|ベイブレード\s*X/i.test(text)
    || /(?:^|[^A-Z0-9])(?:BXG|BX|UX|CX)\s*-?\s*\d{1,3}(?!\d)/i.test(text);
}

export function japanProductBlacklistMatch(product, keywords = []) {
  const searchable = normalizedProductText(product).toLocaleLowerCase('ja-JP');
  if (!searchable) return '';
  return (Array.isArray(keywords) ? keywords : [])
    .map((keyword) => clean(keyword))
    .find((keyword) => keyword && searchable.includes(keyword.normalize('NFKC').toLocaleLowerCase('ja-JP'))) || '';
}

export function japanProductExclusionReason(product, keywords = []) {
  if (!isBeybladeXProduct(product)) return '非 BEYBLADE X 世代';
  const keyword = japanProductBlacklistMatch(product, keywords);
  return keyword ? `命中黑名單關鍵字「${keyword}」` : '';
}

export function approximateTwdFromYen(value, rate = 0.22) {
  const text = clean(value);
  if (!text || !/[￥¥円]|\bJPY\b/i.test(text)) return null;
  const match = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const yen = Number(match[1]);
  if (!Number.isFinite(yen) || yen <= 0) return null;
  return Math.round((yen * rate) / 10) * 10;
}

export function formatJapanPriceWithApproxTwd(value) {
  const price = clean(value);
  const twd = approximateTwdFromYen(price);
  return twd === null ? price : `${price}（約 NT$${twd.toLocaleString('en-US')}）`;
}

export function classifyJapanAuctionUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('請貼上完整的日本網站網址');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('網址必須使用 http 或 https');
  url.protocol = 'https:';
  url.hash = '';
  const store = classifyJapanStoreUrl(url.href);
  if (store) return store;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === '1999.co.jp' && /\/(?:eng\/search|search|list(?:\/|$))/i.test(url.pathname)) {
    return {
      sourceType: '1999', siteName: '1999.co.jp', defaultName: '1999.co.jp 商品清單',
      url: url.href, parserLabel: '1999 商品清單解析器'
    };
  }
  if (host === 'item.rakuten.co.jp' && /\/c\//i.test(url.pathname)) {
    return {
      sourceType: 'rakuten', siteName: '樂天市場', defaultName: '日本樂天商品專區',
      url: url.href, parserLabel: '日本樂天分類頁解析器'
    };
  }
  if (host === 'item.rakuten.co.jp') {
    return { sourceType: 'rakuten-item', siteName: '日本樂天單品', defaultName: '日本樂天單品直查',
      url: canonicalRakutenItemUrl(url.href), parserLabel: '日本樂天官方單品資料解析器' };
  }
  if (host === 'search.rakuten.co.jp' && /\/search\/mall\//i.test(url.pathname)) {
    const shopId = clean(url.searchParams.get('sid'));
    return {
      sourceType: 'rakuten-search', siteName: '日本樂天', defaultName: shopId ? '日本樂天店舖商品搜尋' : '日本樂天全市場商品搜尋（第 1 頁）',
      url: url.href, ...(shopId ? { shopId } : {}), parserLabel: shopId ? '日本樂天店舖搜尋頁解析器' : '日本樂天全市場搜尋頁解析器'
    };
  }
  if (host === 'books.rakuten.co.jp' && /^\/search\/?$/i.test(url.pathname)) {
    const keyword = clean(url.searchParams.get('sitem'));
    if (!keyword) throw new Error('樂天 Books 搜尋頁必須包含搜尋關鍵字');
    return {
      sourceType: 'rakuten-books', siteName: '樂天 Books', defaultName: `樂天 Books ${keyword} 搜尋`,
      url: url.href, parserLabel: '樂天 Books 商品搜尋解析器'
    };
  }
  if (host === 'edion.com' && /\/item_list\.html$/i.test(url.pathname)) {
    return {
      sourceType: 'edion', siteName: 'EDION', defaultName: 'EDION Beyblade 商品搜尋',
      url: url.href, parserLabel: 'EDION 商品清單解析器'
    };
  }
  if (host === 'taiyo-market.com' && /^\/shop\/shopbrand\.html$/i.test(url.pathname)) {
    if (!/beyblade/i.test(clean(url.searchParams.get('search')))) {
      throw new Error('Taiyo Market 搜尋頁必須包含 search=beyblade');
    }
    url.searchParams.set('page', '1');
    url.searchParams.set('search', 'beyblade');
    url.searchParams.set('sort', 'price_desc');
    return {
      sourceType: 'taiyo', siteName: 'Taiyo Market', defaultName: 'Taiyo Market Beyblade 第 1 頁',
      url: url.href, parserLabel: 'Taiyo Market 首頁 48 項價格排序解析器'
    };
  }
  throw new Error('目前可自動辨識：1999.co.jp 日本國內商品清單、日本樂天單品／分類頁／搜尋頁、樂天 Books、EDION、Taiyo Market、OCN、Nojima、日本玩具反斗城商品搜尋頁');
}

export function parse1999Products(html, pageUrl = 'https://www.1999.co.jp/') {
  const $ = cheerio.load(String(html || ''));
  const products = [];
  const seen = new Set();
  $('div.c-card__info').each((_, element) => {
    const card = $(element);
    const anchor = card.find('a.c-card__info-links[href]').first();
    const url = absoluteUrl(anchor.attr('href'), pageUrl);
    const title = clean(card.find('div.c-card__title').first().text() || anchor.text());
    const id = canonical1999ProductId(url);
    if (!url || !title || !id || seen.has(id)) return;
    const rawPrice = clean(card.find('div.c-card__price-element').first().text());
    const priceMatch = rawPrice.match(/[\d,]+/);
    const image = card.closest('.c-card, li, article').find('img').first();
    seen.add(id);
    products.push({
      id, title, url,
      imageUrl: absoluteUrl(image.attr('data-src') || image.attr('src'), pageUrl),
      price: priceMatch ? `¥${priceMatch[0]}` : rawPrice,
      available: true,
      detail: clean(card.find('div.c-card__maker').first().text())
    });
  });
  return products;
}

function deduplicateTitle(value) {
  const title = clean(value);
  if (title.length % 2 === 0 && title.slice(0, title.length / 2) === title.slice(title.length / 2)) {
    return title.slice(0, title.length / 2);
  }
  return title;
}

export function parseRakutenProducts(html, pageUrl = 'https://item.rakuten.co.jp/') {
  const $ = cheerio.load(String(html || ''));
  const visuals = new Map();
  $('#risFil a[href]').each((_, element) => {
    const anchor = $(element);
    if (!anchor.find('.categoryWindowImg').length) return;
    const url = absoluteUrl(anchor.attr('href'), pageUrl);
    if (!url) return;
    const image = anchor.find('.categoryWindowImg img').first();
    visuals.set(url, {
      imageUrl: absoluteUrl(image.attr('data-src') || image.attr('src'), pageUrl),
      soldOut: anchor.find('.soldout_category_window').length > 0
    });
  });
  const products = [];
  const seen = new Set();
  $('#risFil a.category_itemnamelink[href]').each((_, element) => {
    const anchor = $(element);
    const url = absoluteUrl(anchor.attr('href'), pageUrl);
    const title = deduplicateTitle(anchor.text());
    if (!url || !title || seen.has(url)) return;
    const visual = visuals.get(url) || {};
    seen.add(url);
    products.push({
      id: productId(url), title, url,
      imageUrl: visual.imageUrl || '',
      price: clean(anchor.parent().find('.category_itemprice').first().text()),
      available: visual.soldOut !== true
    });
  });
  return products;
}

export function parseRakutenSearchProducts(html, pageUrl = 'https://search.rakuten.co.jp/search/mall/') {
  const $ = cheerio.load(String(html || ''));
  let expectedShopId = '';
  try { expectedShopId = clean(new URL(pageUrl).searchParams.get('sid')); } catch { /* use every visible result */ }
  const products = [];
  const seen = new Set();
  $('[data-card-type="item"][data-track-itemid], .searchresultitem').each((_, element) => {
    const card = $(element);
    const cardShopId = clean(card.attr('data-shop-id'));
    if (expectedShopId && cardShopId && cardShopId !== expectedShopId) return;
    const anchor = card.find('h2 a[href*="item.rakuten.co.jp"], a[href*="item.rakuten.co.jp"]').filter((__, item) => clean($(item).text())).first();
    const fallbackAnchor = card.find('a[href*="item.rakuten.co.jp"]').first();
    const href = anchor.attr('href') || fallbackAnchor.attr('href');
    if (!href) return;
    const url = absoluteUrl(href, pageUrl);
    // Ads/redirects without a genuine item URL must not become fake products.
    try { if (new URL(url).hostname !== 'item.rakuten.co.jp') return; } catch { return; }
    const title = deduplicateTitle(anchor.text() || card.find('h2').first().text() || fallbackAnchor.find('img').attr('alt'));
    if (!url || !title || seen.has(productId(url))) return;
    const rawPrice = clean(card.attr('data-track-price') || card.find('[class*="price"]').first().text());
    const priceMatch = rawPrice.match(/[\d,]+/);
    const image = card.find('img').first();
    const text = clean(card.text());
    const unavailable = /売り切れ|売切れ|販売終了|在庫切れ|完売|sold\s*out/i.test(text)
      || card.is('.soldout, .sold_out')
      || card.find('.soldout, .sold_out, [class*="soldout"]').length > 0;
    const id = productId(url);
    seen.add(id);
    products.push({
      id, title, url,
      imageUrl: absoluteUrl(image.attr('data-src') || image.attr('src'), pageUrl),
      price: priceMatch ? `¥${Number(priceMatch[0].replace(/,/g, '')).toLocaleString('en-US')}` : rawPrice,
      available: !unavailable,
      detail: cardShopId ? `樂天店舖 ID：${cardShopId}` : ''
    });
  });
  return products;
}

export function parseRakutenBooksProducts(html, pageUrl = 'https://books.rakuten.co.jp/search') {
  const $ = cheerio.load(String(html || ''));
  const products = [];
  const seen = new Set();
  $('.rbcomp__item-list__item').each((_, element) => {
    const card = $(element);
    const category = clean(card.find('.rbcomp__category').first().text());
    if (category && !/おもちゃ|ゲーム|グッズ/i.test(category)) return;
    const anchor = card.find('h3 a[href*="/rb/"]').first();
    const rawUrl = absoluteUrl(anchor.attr('href'), pageUrl);
    const title = deduplicateTitle(card.find('.rbcomp__item-list__item__title').first().text() || anchor.text());
    if (!rawUrl || !title) return;
    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      parsed.search = '';
      parsed.hash = '';
      url = parsed.href;
    } catch { /* retain the visible product URL */ }
    const id = productId(url);
    if (seen.has(id)) return;
    const stockText = clean(card.find('.rbcomp__item-list__item__stock').first().text());
    const explicitlyAvailable = /在庫あり|予約受付中|注文可能|取り寄せ/i.test(stockText);
    const explicitlyUnavailable = /ご注文できない商品|在庫切れ|品切れ|販売終了|売り切れ|完売/i.test(stockText);
    const rawPrice = clean(card.find('.rbcomp__item-list__item__price').first().text());
    const priceMatch = rawPrice.match(/[\d,]+/);
    const image = card.find('img').first();
    seen.add(id);
    products.push({
      id,
      title,
      url,
      imageUrl: absoluteUrl(image.attr('data-src') || image.attr('src'), pageUrl),
      price: priceMatch ? `¥${Number(priceMatch[0].replace(/,/g, '')).toLocaleString('en-US')}` : rawPrice,
      available: explicitlyAvailable && !explicitlyUnavailable,
      detail: stockText ? `樂天 Books：${stockText}` : '樂天 Books：庫存狀態未明'
    });
  });
  return products;
}

export function parseEdionProducts(html, pageUrl = 'https://www.edion.com/item_list.html') {
  const $ = cheerio.load(String(html || ''));
  const products = [];
  const seen = new Set();
  $('a[href*="/detail.html?p_cd="]').each((_, element) => {
    const anchor = $(element);
    const rawUrl = absoluteUrl(anchor.attr('href'), pageUrl);
    if (!rawUrl) return;
    let itemCode = '';
    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      itemCode = clean(parsed.searchParams.get('p_cd'));
      if (itemCode) {
        parsed.search = '';
        parsed.searchParams.set('p_cd', itemCode);
        url = parsed.href;
      }
    } catch { /* keep the original URL */ }
    const id = itemCode || productId(rawUrl);
    if (!id || seen.has(id)) return;
    const card = anchor.closest('li');
    const title = deduplicateTitle(anchor.text() || anchor.find('img[alt]').first().attr('alt') || card.find('a[href*="/detail.html?p_cd="]').filter((__, item) => clean($(item).text())).first().text());
    if (!title) return;
    const text = clean(card.text());
    const stockMatch = text.match(/在庫数\s*(\d+)\s*(?:台|個|点)?/i);
    const stock = stockMatch ? Number(stockMatch[1]) : null;
    const unavailable = /販売終了|販売を終了|予定数終了|完売|在庫切れ|売り切れ|sold\s*out/i.test(text)
      || stock === 0
      || card.is('.soldout, .sold_out')
      || card.find('.soldout, .sold_out, [class*="soldout"]').length > 0;
    const image = card.find('img').first();
    const priceMatch = text.match(/[￥¥]\s*([\d,]+)/);
    seen.add(id);
    products.push({
      id,
      title,
      url,
      imageUrl: absoluteUrl(image.attr('data-src') || image.attr('src'), pageUrl),
      price: priceMatch ? `¥${priceMatch[1]}` : '',
      available: !unavailable,
      detail: stock !== null ? `EDION 前台庫存：${stock}` : 'EDION 官方網路商店'
    });
  });
  return products;
}

export function parseTaiyoMarketProducts(html, pageUrl = 'https://taiyo-market.com/shop/shopbrand.html?page=1&search=beyblade&sort=price_desc') {
  const $ = cheerio.load(String(html || ''));
  const products = [];
  const seen = new Set();
  $('.detail a.name[href]').slice(0, 48).each((_, element) => {
    const anchor = $(element);
    const card = anchor.closest('li');
    const rawUrl = absoluteUrl(anchor.attr('href'), pageUrl);
    const title = deduplicateTitle(anchor.text() || card.find('.imgWrap img[alt]').first().attr('alt'));
    if (!rawUrl || !title) return;
    let id = '';
    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      id = clean(parsed.searchParams.get('brandcode'));
      if (id) {
        parsed.search = '';
        parsed.searchParams.set('brandcode', id);
        url = parsed.href;
      }
    } catch { /* keep visible URL */ }
    id ||= productId(rawUrl);
    if (!id || seen.has(id)) return;
    const rawPrice = clean(card.find('.detail p.price').first().text());
    const priceMatch = rawPrice.match(/[\d,]+/);
    const soldOut = card.find('.btnWrap .soldout').length > 0
      || /品切れ|在庫切れ|売り切れ|完売|販売終了/i.test(clean(card.find('.btnWrap').text()));
    const cartAvailable = card.find('.btnWrap a[href*="basket.html"][href*="brandcode="]').length > 0;
    const image = card.find('.imgWrap img').first();
    const barcode = clean(card.find('.detail .else li').last().text());
    seen.add(id);
    products.push({
      id,
      title,
      url,
      imageUrl: absoluteUrl(image.attr('data-src') || image.attr('src'), pageUrl),
      price: priceMatch ? `¥${Number(priceMatch[0].replace(/,/g, '')).toLocaleString('en-US')}` : rawPrice,
      available: cartAvailable && !soldOut,
      detail: barcode ? `Taiyo Market｜JAN ${barcode}` : 'Taiyo Market 日本玩具店'
    });
  });
  return products;
}

export function parseJapanAuctionPage(html, target) {
  if (isJapanStore(target.sourceType)) return parseJapanStoreProducts(html, target);
  if (target.sourceType === 'rakuten-item') return parseRakutenItem(html, target.url);
  if (target.sourceType === '1999') return parse1999Products(html, target.url);
  if (target.sourceType === 'rakuten') return parseRakutenProducts(html, target.url);
  if (target.sourceType === 'rakuten-search') return parseRakutenSearchProducts(html, target.url);
  if (target.sourceType === 'rakuten-books') return parseRakutenBooksProducts(html, target.url);
  if (target.sourceType === 'edion') return parseEdionProducts(html, target.url);
  if (target.sourceType === 'taiyo') return parseTaiyoMarketProducts(html, target.url);
  throw new Error(`尚未支援日本網站：${target.sourceType}`);
}

export function japanAuctionNotification(product, target, kind = 'new') {
  const status = kind === 'restock' ? '恢復販售' : '新商品可購買';
  const description = [
    `商品：${product.title}`,
    product.price ? `價格：${formatJapanPriceWithApproxTwd(product.price)}` : '',
    product.detail ? `資訊：${product.detail}` : '',
    `狀態：${status}`,
    '',
    `[🛒 立即前往商品頁](${product.url})`
  ].filter(Boolean).join('\n');
  return {
    text: `🇯🇵 ${target.siteName}｜${status}｜${product.title}`,
    options: {
      discordAudience: 'japan',
      username: '日拍追蹤',
      discordPreview: `🇯🇵 ${target.siteName} ${status}｜${product.title}`,
      embeds: [{
        title: `🇯🇵 ${target.siteName}｜${status}`,
        url: product.url,
        description,
        color: target.sourceType.startsWith('rakuten') ? 0xbf0000 : target.sourceType === 'edion' ? 0x005bac : target.sourceType === 'taiyo' ? 0xf59e0b : 0x2563eb,
        thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
        footer: { text: '陀螺通知監控儀表・日本拍賣' },
        timestamp: new Date().toISOString()
      }]
    }
  };
}

export function japanAuctionTestNotification() {
  const target = {
    siteName: '1999.co.jp',
    sourceType: '1999'
  };
  const product = {
    id: '11172934',
    title: 'ベイブレードX UX-15 シャークスケイルデッキセット',
    price: '4,200円',
    detail: 'UX-15 鯊鯨狂鯊牌組／TAKARA TOMY',
    url: 'https://www.1999.co.jp/11172934'
  };
  const notification = japanAuctionNotification(product, target, 'restock');
  return {
    text: `🧪 測試通知｜${notification.text}`,
    options: {
      ...notification.options,
      discordPreview: `🧪 測試｜1999.co.jp UX-15 恢復販售`,
      embeds: notification.options.embeds.map((embed) => ({
        ...embed,
        title: `🧪 測試｜${embed.title}`,
        footer: { text: '本機測試通知・不是真實補貨｜陀螺通知監控儀表・日本拍賣' }
      }))
    },
    product
  };
}

export class JapanAuctionMonitor {
  constructor({ dataDir, state, getTargets, getExcludeKeywords = () => [], log = () => {}, notify, onAvailabilitySignal = async () => {}, fetcher = fetch }) {
    this.dataDir = dataDir;
    this.state = state;
    this.getTargets = getTargets;
    this.getExcludeKeywords = getExcludeKeywords;
    this.log = log;
    this.notify = notify;
    this.onAvailabilitySignal = onAvailabilitySignal;
    this.fetcher = fetcher;
    this.context = null;
    this.contextPromise = null;
    this.pages = new Map();
    this.scans = new Map();
  }

  notificationRoot() {
    this.state.data.commerce ||= {};
    this.state.data.commerce.japanAuctions ||= { targets: {} };
    const root = this.state.data.commerce.japanAuctions;
    root.targets ||= {};
    root.recentNotifications ||= {};
    return root;
  }

  seedRecentNotifications(now = Date.now()) {
    const root = this.notificationRoot();
    if (root.recentNotificationsSeededAt) return;
    for (const [targetId, targetState] of Object.entries(root.targets)) {
      for (const product of Object.values(targetState?.products || {})) {
        if (product?.available !== true) continue;
        const key = japanAuctionProductKey(product);
        if (!key || root.recentNotifications[key]) continue;
        root.recentNotifications[key] = {
          lastNotifiedAt: targetState.lastScanAt || new Date(now).toISOString(),
          title: product.title || '',
          targetId,
          siteName: '既有可購基線',
          seeded: true
        };
      }
    }
    root.recentNotificationsSeededAt = new Date(now).toISOString();
  }

  recentNotification(product, now = Date.now()) {
    const root = this.notificationRoot();
    const key = japanAuctionProductKey(product);
    const record = root.recentNotifications[key];
    const at = Date.parse(record?.lastNotifiedAt || '');
    return Number.isFinite(at) && now - at < JAPAN_AUCTION_NOTIFICATION_COOLDOWN_MS
      ? { key, record }
      : { key, record: null };
  }

  recordNotification(product, target, now = Date.now()) {
    const root = this.notificationRoot();
    const key = japanAuctionProductKey(product);
    root.recentNotifications[key] = {
      lastNotifiedAt: new Date(now).toISOString(),
      title: product.title || '',
      targetId: target.id,
      siteName: target.siteName || target.name || ''
    };
    for (const [oldKey, record] of Object.entries(root.recentNotifications)) {
      const at = Date.parse(record?.lastNotifiedAt || '');
      if (!Number.isFinite(at) || now - at > JAPAN_AUCTION_NOTIFICATION_RETENTION_MS) {
        delete root.recentNotifications[oldKey];
      }
    }
  }

  async ensureContext() {
    if (this.context) return this.context;
    if (this.contextPromise) return this.contextPromise;
    this.contextPromise = (async () => {
      await fs.mkdir(path.join(this.dataDir, 'japan-auction-browser-profile'), { recursive: true });
      const context = await chromium.launchPersistentContext(
        path.join(this.dataDir, 'japan-auction-browser-profile'),
        {
          headless: true,
          channel: 'chrome',
          locale: 'ja-JP',
          timezoneId: 'Asia/Tokyo',
          viewport: { width: 1365, height: 900 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          args: ['--disable-blink-features=AutomationControlled']
        }
      );
      await context.route('**/*', monitoringRoute({ blockStyles: true }));
      context.once('close', () => {
        if (this.context === context) this.context = null;
        this.pages.clear();
      });
      this.context = context;
      return context;
    })().finally(() => {
      this.contextPromise = null;
    });
    return this.contextPromise;
  }

  async pageFor(target) {
    const current = this.pages.get(target.id);
    if (current && !current.isClosed()) return current;
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.pages.set(target.id, page);
    return page;
  }

  async closePageFor(target) {
    const page = this.pages.get(target.id);
    this.pages.delete(target.id);
    await page?.close().catch(() => {});
  }

  async loadWithHttp(target) {
    const response = await this.fetcher(target.url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.7',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await decodeHtmlResponse(response);
    if (html.length < 900 || BLOCKED_WORDS.test(html.slice(0, 4000))) {
      throw new Error('HTTP 快速路徑收到流量驗證頁或不完整內容');
    }
    const parsedProducts = parseJapanAuctionPage(html, target);
    if (!parsedProducts.length) throw new Error('HTTP 快速路徑沒有讀到商品');
    if (target.sourceType === 'taiyo' && parsedProducts.some((product) => /\uFFFD/.test(product.title))) {
      throw new Error('HTTP 快速路徑的 Taiyo 日文解碼失敗');
    }
    if (target.sourceType === 'taiyo' && parsedProducts.length !== 48) {
      throw new Error(`HTTP 快速路徑的 Taiyo 品項數為 ${parsedProducts.length}，不是 48`);
    }
    await this.closePageFor(target);
    return html;
  }

  async load(target) {
    if (HTTP_FAST_PATH_SOURCES.has(target.sourceType)) {
      try {
        return await this.loadWithHttp(target);
      } catch (error) {
        this.log(`${target.name || target.siteName}：HTTP 快速路徑失敗，改用瀏覽器備援：${error.message}`);
      }
    }
    const page = await this.pageFor(target);
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const initialTitle = await page.title().catch(() => '');
    const initialBody = clean(await page.locator('body').innerText().catch(() => ''));
    const initialHtml = await page.content().catch(() => '');
    await this.rejectChallenge(target, page, initialTitle, initialBody, initialHtml);
    if (response && response.status() >= 400) {
      await this.closePageFor(target);
      throw new Error(`網站回傳 HTTP ${response.status()}，本輪保留既有基線`);
    }
    if (target.sourceType === 'rakuten') await page.waitForSelector('#risFil', { timeout: 20_000 });
    if (target.sourceType === 'rakuten-item') await page.waitForSelector('#item-page-app-data', { state: 'attached', timeout: 15_000 });
    if (target.sourceType === 'rakuten-search') await page.waitForSelector('.searchresultitem, main, body', { timeout: 20_000 });
    if (target.sourceType === 'rakuten-books') await page.waitForSelector('.rbcomp__item-list__item, main, body', { timeout: 20_000 });
    if (target.sourceType === '1999') {
      try {
        await page.waitForSelector('div.c-card__info', { state: 'attached', timeout: 15_000 });
      } catch (error) {
        await this.rejectChallenge(target, page, await page.title().catch(() => ''),
          clean(await page.locator('body').innerText().catch(() => '')), await page.content().catch(() => ''));
        await this.closePageFor(target);
        throw new Error(`1999 商品清單未載入，本輪保留既有基線：${error.message}`);
      }
    }
    if (target.sourceType === 'edion') {
      try {
        await page.waitForSelector('a[href*="/detail.html?p_cd="]', { timeout: 10_000 });
      } catch (error) {
        const blockedTitle = await page.title().catch(() => '');
        const blockedBody = clean(await page.locator('body').innerText().catch(() => ''));
        const blockedHtml = await page.content().catch(() => '');
        if (BLOCKED_WORDS.test(`${blockedTitle} ${blockedBody.slice(0, 800)}`) || BLOCKED_MARKUP.test(blockedHtml)) {
          const baselineCount = Object.keys(this.state.data.commerce?.japanAuctions?.targets?.[target.id]?.products || {}).length;
          await this.closePageFor(target);
          throw Object.assign(new Error(`EDION 回傳 Cloudflare 人機驗證頁，本輪保留 ${baselineCount} 件既有基線並降速重試`), { code: 'verification_required' });
        }
        throw new Error(`EDION 商品清單在 10 秒內沒有載入，本輪保留既有基線：${error.message}`);
      }
    }
    if (target.sourceType === 'taiyo') await page.waitForSelector('.detail a.name[href]', { timeout: 20_000 });
    const html = await page.content();
    const body = clean(await page.locator('body').innerText().catch(() => ''));
    await this.rejectChallenge(target, page, await page.title(), body, html);
    if (html.length < 900 || BLOCKED_WORDS.test(`${await page.title()} ${body.slice(0, 600)}`)) {
      throw new Error('網站回傳流量驗證頁，本輪不更新基線');
    }
    return html;
  }

  async rejectChallenge(target, page, title, body, html) {
    const wordsBlocked = BLOCKED_WORDS.test(`${title} ${body.slice(0, 800)}`);
    // Healthy pages may include passive security scripts. Require absence of
    // actual product cards before treating markup alone as a challenge.
    const markupBlocked = BLOCKED_MARKUP.test(html) && !parseJapanAuctionPage(html, target).length;
    if (!wordsBlocked && !markupBlocked) return;
    const baselineCount = Object.keys(this.state.data.commerce?.japanAuctions?.targets?.[target.id]?.products || {}).length;
    await this.closePageFor(target);
    throw Object.assign(new Error(`${target.siteName || target.name || target.sourceType} 回傳 Cloudflare／流量驗證頁（需人工驗證），本輪保留 ${baselineCount} 件既有基線並降速重試`), {
      code: 'verification_required'
    });
  }

  async inspectTarget(target) {
    const parsedProducts = await this.productsFor(target);
    if (target.sourceType === 'taiyo' && parsedProducts.length !== 48) {
      throw new Error(`Taiyo Market 第 1 頁應有 48 項，目前只讀到 ${parsedProducts.length} 項，本輪不更新基線`);
    }
    if (!parsedProducts.length) throw new Error('解析器沒有讀到商品，請確認網址是商品清單／搜尋頁，而且目前有結果');
    const products = parsedProducts.filter((product) => !japanProductExclusionReason(product, this.getExcludeKeywords()));
    if (!products.length) throw new Error(`讀到 ${parsedProducts.length} 件商品，但沒有符合 BEYBLADE X 世代且未命中黑名單的商品`);
    return {
      checkedProducts: products.length,
      excludedProducts: parsedProducts.length - products.length,
      availableProducts: products.filter((product) => product.available).length,
      sampleProducts: products.slice(0, 3).map((product) => ({ title: product.title, price: product.price }))
    };
  }

  async productsFor(target) {
    return isJapanStore(target.sourceType)
      ? readJapanStoreProducts(target, { fetcher: this.fetcher, knownProducts: Object.values(this.status(target).products || {}) })
      : parseJapanAuctionPage(await this.load(target), target);
  }

  scanTarget(target) {
    if (target.sourceType === 'edion' && target.transport === 'chrome-bridge') {
      return Promise.resolve({ targetId: target.id, skipped: true, reason: 'chrome_bridge' });
    }
    return this.singleScan(target, () => this.performScanTarget(target));
  }

  ingestBrowserProducts(target, products) {
    return this.singleScan(target, () => this.performScanTarget(target, products));
  }

  singleScan(target, work) {
    const id = String(target.id);
    if (this.scans.has(id)) return this.scans.get(id);
    const scan = work().finally(() => {
      if (this.scans.get(id) === scan) this.scans.delete(id);
    });
    this.scans.set(id, scan);
    return scan;
  }

  async performScanTarget(target, browserProducts = null) {
    const startedAt = Date.now();
    const root = this.notificationRoot();
    this.seedRecentNotifications(startedAt);
    const storage = root.targets;
    const storedPrevious = storage[target.id] || { initialized: false, products: {} };
    const previous = target.sourceType === '1999'
      ? {
          ...storedPrevious,
          products: normalize1999RecordMap(storedPrevious.products),
          excluded: normalize1999RecordMap(storedPrevious.excluded)
        }
      : storedPrevious;
    try {
      const parsedProducts = browserProducts || await this.productsFor(target);
      if (target.sourceType === 'taiyo' && parsedProducts.length !== 48) {
        throw new Error(`Taiyo Market 第 1 頁應有 48 項，目前只讀到 ${parsedProducts.length} 項，本輪不更新基線`);
      }
      if (!parsedProducts.length && !(target.sourceType === 'toysrus' && parsedProducts.verifiedEmpty === true)) {
        throw new Error('解析器沒有讀到任何商品，可能是網站驗證頁或版型異常；本輪保留既有基線');
      }
      const excludedProducts = [];
      const products = [];
      for (const product of parsedProducts) {
        if (isJapanStore(target.sourceType) && product.available === null && previous.products?.[product.id]) {
          product.available = previous.products[product.id].available;
        }
        if (browserProducts && product.available === undefined) {
          product.available = previous.products?.[product.id]?.available === true;
        }
        const reason = japanProductExclusionReason(product, this.getExcludeKeywords());
        if (reason) excludedProducts.push({ product, reason });
        else products.push(product);
      }
      const current = Object.fromEntries(products.map((product) => [product.id, { ...product, missingRounds: 0 }]));
      // Whole-market ranking moves items between pages. Absence on page 1 is
      // not proof of stock-out, and must not manufacture a later restock event.
      const rankingOnly = isJapanStore(target.sourceType)
        || target.sourceType === 'rakuten-search' && !new URL(target.url).searchParams.get('sid');
      let discovered = 0;
      let restocked = 0;
      let notified = 0;
      let suppressed = 0;
      const recoveringFromEmptyResult = previous.initialized
        && previous.lastRawProductCount !== undefined
        && Number(previous.lastRawProductCount) === 0
        && Object.keys(previous.products || {}).length > 0;
      if (previous.initialized) {
        for (const product of products) {
          if (!product.available) continue;
          const old = previous.products?.[product.id];
          // An older build accepted EDION challenge pages as a valid zero-item
          // scan and marked every known product unavailable. On the first
          // healthy recovery, keep notifying genuinely new IDs but do not
          // emit a false restock storm for already-known products.
          const becameAvailable = old && (old.available === false || isJapanStore(target.sourceType) && old.available === null);
          const kind = old ? (becameAvailable && !recoveringFromEmptyResult ? 'restock' : '') : 'new';
          if (!kind) continue;
          if (kind === 'new') discovered += 1; else restocked += 1;
          const recent = this.recentNotification(product, startedAt);
          if (recent.record) {
            suppressed += 1;
            this.log(`${target.name}：近期已通知相同品項，略過重複推播與日亞 F5 提示｜${product.title}`);
            continue;
          }
          const message = japanAuctionNotification(product, target, kind);
          void Promise.resolve(this.onAvailabilitySignal(product, { source: target.siteName, kind }))
            .catch((error) => this.log(`${target.siteName} 同品項日亞 F5 提示失敗：${error.message}`));
          await this.notify(message.text, message.options);
          this.recordNotification(product, target, startedAt);
          notified += 1;
        }
      }
      const excludedIds = new Set(excludedProducts.map(({ product }) => product.id));
      for (const [id, old] of Object.entries(previous.products || {})) {
        // A product that is still present but now excluded must leave the active
        // baseline entirely. Keeping it as unavailable creates a false restock
        // the next time another loader returns the same product.
        if (!current[id] && !excludedIds.has(id) && !japanProductExclusionReason(old, this.getExcludeKeywords())) {
          const missingRounds = Number(old.missingRounds || 0) + 1;
          current[id] = { ...old, missingRounds, available: !browserProducts && !rankingOnly && missingRounds >= 2 ? false : old.available };
        }
      }
      const previousExcluded = previous.excluded || {};
      const excluded = Object.fromEntries(excludedProducts.map(({ product, reason }) => [product.id, {
        id: product.id,
        title: product.title,
        url: product.url,
        reason,
        firstSeenAt: previousExcluded[product.id]?.firstSeenAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
      }]));
      storage[target.id] = {
        initialized: true,
        products: current,
        excluded,
        lastScanAt: new Date().toISOString(),
        lastProductCount: products.length,
        lastRawProductCount: parsedProducts.length,
        lastExcludedCount: excludedProducts.length,
        lastError: '',
        lastErrorCode: '',
        recoveredFromEmptyResultAt: recoveringFromEmptyResult ? new Date().toISOString() : previous.recoveredFromEmptyResultAt
      };
      await this.state.save();
      this.log(`${target.name}：原始 ${parsedProducts.length} 件，保留 ${products.length} 件 BEYBLADE X 商品、排除 ${excludedProducts.length} 件${previous.initialized ? `，新品 ${discovered}、補貨 ${restocked}、通知 ${notified}、近期重複略過 ${suppressed}` : '，首次建立安全基線（不通知）'}。`);
      return { targetId: target.id, checkedProducts: products.length, excluded: excludedProducts.length, discovered, restocked, notified, suppressed, durationMs: Date.now() - startedAt, changed: discovered + restocked > 0 };
    } catch (error) {
      storage[target.id] = { ...previous, lastError: error.message, lastErrorCode: error.code || 'scan_failed', lastAttemptAt: new Date().toISOString() };
      await this.state.save();
      throw error;
    }
  }

  status(target) {
    return this.state.data.commerce?.japanAuctions?.targets?.[target.id] || {};
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.contextPromise = null;
    this.pages.clear();
  }
}
