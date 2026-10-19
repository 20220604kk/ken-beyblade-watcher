import { load } from 'cheerio';

export function canonicalRakutenItemUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'item.rakuten.co.jp' || url.username || url.password || url.port
    || !/^\/[^/]+\/[^/]+\/?$/.test(url.pathname) || /^\/[^/]+\/(?:c|s)\/?$/.test(url.pathname)) {
    throw new Error('不是可確認的日本樂天單品網址');
  }
  url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/?$/, '/');
  return url.href;
}

// Parse only the official product's embedded JSON. Never execute scripts or
// infer availability from recommendations, metadata, or generic cart buttons.
export function parseRakutenItem(html, pageUrl) {
  const url = canonicalRakutenItemUrl(pageUrl), path = new URL(url).pathname;
  const [shopSlug, itemSlug] = path.split('/').filter(Boolean).map(decodeURIComponent);
  const $ = load(String(html || ''));
  let app;
  try { app = JSON.parse($('#item-page-app-data').text()); }
  catch { throw new Error('樂天單品缺少有效官方商品資料，保留既有基線'); }
  const item = app?.newApi?.itemInfoSku || app?.api?.data?.itemInfoSku;
  if (!item || String(item.manageNumber) !== itemSlug || app.shop?.shopUrl !== shopSlug) {
    throw new Error('樂天單品的店舖或商品識別不符，保留既有基線');
  }
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.includes('\uFFFD')) throw new Error('樂天單品名稱不完整或解碼失敗，保留既有基線');
  if (item.inventoryType !== 'single') throw new Error('樂天單品為多規格或未知庫存格式，保留既有基線');
  const purchase = item.purchaseInfo, condition = purchase?.purchaseBySellType?.purchaseCondition;
  const stockCondition = purchase?.newPurchaseSku?.stockCondition;
  const stock = purchase?.newPurchaseSku?.quantity;
  if (!Number.isInteger(stock) || stock < 0) throw new Error('樂天單品沒有可確認庫存數量，保留既有基線');
  const variants = purchase?.variantMappedInventories;
  if (variants && (!Array.isArray(variants) || variants.length !== 1 || variants[0].quantity !== stock
    || String(variants[0].sku) !== String(item.variantId))) {
    throw new Error('樂天單品規格庫存不一致，保留既有基線');
  }
  let available;
  if (item.hideItem === true || item.draftItem === true) available = false;
  else if (condition === 'sold-out' && stock === 0 && (!stockCondition || stockCondition === 'sold-out')) available = false;
  else if (condition === 'enabled' && stock > 0 && stockCondition !== 'sold-out' && item.features?.displayNormalCartButton === true) available = true;
  else throw new Error('樂天單品販售條件未知或與庫存矛盾，保留既有基線');
  const amount = Number(item.taxIncludedPrice ?? purchase?.purchaseBySellType?.normalPurchase?.price?.minPrice);
  const image = item.media?.images?.[0]?.location || item.oldImage || '';
  return [{ id: path.replace(/\/$/, ''), title, url, stock, available,
    price: Number.isFinite(amount) && amount > 0 ? `¥${amount.toLocaleString('en-US')}` : '',
    imageUrl: /^https:\/\//.test(image) ? image : '',
    detail: `${app.shop.shopName || shopSlug}｜官方單品資料｜${available ? '可購買' : '目前不可購買'}｜庫存 ${stock}` }];
}
