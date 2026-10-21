import { load } from 'cheerio';

const ORIGIN = 'https://www.amazon.co.jp';
export function amazonCheckoutStockState(page, asin) {
  const $ = page.$ || load(page.html || '');
  const text = $('body').text().replace(/\s+/g, ' ');
  if (/Amazon\s*カートは空です|ショッピングカートは空|购物车为空|購物車為空|(?:Amazon|shopping)\s+cart\s+is\s+empty/i.test(text)) return 'empty';
  const stock = /ご指定の数量をご用意できません|リクエストされた数量は入手できなくなりました|リクエストされ[\s\S]{0,8}数量は入手できなくなりました|无法再提供您所请求的数量|無法再提供您所請求的數量|not able to provide.*quantity|此商品缺货[，,]?\s*您无法购买|此商品缺貨[，,]?\s*您無法購買/i.test(text);
  if (!stock) return 'other';
  const asins = new Set($('[data-asin],input[name="ASIN"],input[name="asin"],a[href*="/dp/"]').toArray().map(n => {
    const e = $(n); return e.attr('data-asin') || e.attr('value') || e.attr('href')?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];
  }).filter(v => /^[A-Z0-9]{10}$/i.test(v || '')).map(v => v.toUpperCase()));
  if (asins.size && (asins.size !== 1 || !asins.has(asin))) return 'mismatch';
  return 'stock_wait';
}

// Use only a URL actually received from this checkout. Never derive a flow ID,
// replay an entry POST, press quantity-zero Continue, or GET the final endpoint.
export function amazonStockWaitUrl(value) {
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password
    || !/^(?:\/checkout\/(?:entry\/(?:buynow|cart)|p\/[^/]+\/(?:spc|update-items|items|itemselect))\/?|\/gp\/buy\/spc\/handlers\/display\.html)$/.test(url.pathname)) throw Object.assign(new Error('紅字頁沒有可安全重查的官方結帳位址，保留待核對'), { code: 'AMAZON_CART_REVIEW' });
  return url.href;
}
