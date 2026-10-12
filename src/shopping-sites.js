import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import { readAndReleaseResponse, releaseResponse } from './api-response.js';
import { chromium, request as playwrightRequest } from 'playwright';
import { monitoringRoute } from './monitoring-resources.js';

const PRODUCT_WORDS = /(?:BEYBLADE|戰鬥陀螺|陀螺)/i;
const BEYBLADE_MODEL_WORDS = /\b(?:BXG|BX|UX|CX)-\d{2}\b/i;
const NON_TOY_WORDS = /(?:攻略|漫畫|雜誌|月刊|季刊|圖鑑|貼紙|著色|拼圖|卡牌|童書|電子書|e-?book|背包|書包|便當袋|水壺|鉛筆盒|紙陀螺|收納包|收納盒|吊飾|鑰匙圈)/i;
const STOCK_THRESHOLDS = [100, 50, 20, 10];
const UNAVAILABLE_WORDS = /售完補貨中|補貨中|無法購買|可訂購時通知我|貨到通知|缺貨中|暫無庫存|已售完|售罄/;
const AVAILABLE_WORDS = /加入購物車|放入購物車|立即購買|直接購買|可購買/;
const BLOCKED_PAGE_WORDS = /Attention Required!|Sorry, you have been blocked|cf-error-details|Cloudflare Ray ID/i;

function cleanText(value) {
  return String(value || '').replace(/\\u0026/g, '&').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return '';
  }
}

function productIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.match(/\/goodsDetail\/([^/?#]+)/i)?.[1]
      || parsed.pathname.match(/\/product\/(\d+)/i)?.[1]
      || parsed.searchParams.get('i_code')
      || parsed.pathname.match(/(TP\d{7,}|\d{8,})/)?.[1]
      || parsed.pathname.split('/').filter(Boolean).at(-1)
      || url;
  } catch {
    return url;
  }
}

export function canonicalEsliteProductUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('請貼上完整的誠品商品網址');
  }
  if (!/(?:^|\.)eslite\.com$/i.test(parsed.hostname)) {
    throw new Error('誠品單品專線只接受 eslite.com 商品網址');
  }
  const id = parsed.pathname.match(/\/product\/(\d{8,})/i)?.[1] || '';
  if (!id) throw new Error('這個網址沒有可辨識的誠品商品編號');
  return `https://www.eslite.com/product/${id}`;
}

function productLink(url) {
  return /momoshop\.com\.tw\/(?:product\/|goods\.momo|TP\/[^/]+\/goodsDetail\/)/i.test(url)
    || /eslite\.com\/product\//i.test(url)
    || /shop\.tcsb\.com\.tw\/(?:v2\/)?SalePage\/Index\//i.test(url)
    || /mmtoyshop\.com\/item\//i.test(url);
}

function isMmToyTarget(target) {
  return target?.sourceType === 'mmtoy-category'
    || /mmtoyshop\.com\/category\//i.test(target?.url || '');
}

function isSenSenTarget(target) {
  return target?.sourceType === 'sensen-cyberbiz-collection'
    || /sen-sen\.com\.tw\/collections\//i.test(target?.url || '');
}

function isTwjTarget(target) {
  return target?.sourceType === 'twj-cyberbiz-collection'
    || /(?:^|\.)twj\.tw\/collections\//i.test(target?.url || '');
}

function isMomoStoreTarget(target) {
  return target?.sourceType === 'momo-store-api'
    || /momoshop\.com\.tw\/TP\/[^/]+\/main/i.test(target?.url || '');
}

function isMomoStoreProductUrl(url) {
  return /momoshop\.com\.tw\/TP\/[^/]+\/goodsDetail\/TP\d+/i.test(url || '');
}

const SENSEN_NON_BEYBLADE_WORDS = /(?:收納箱|收納盒|收納包|外出箱|檢查板|檢查盤|戰鬥台|對戰台|競技場|圖鑑|攻略|漫畫|雜誌|貼紙|著色|拼圖|卡牌|童書|背包|書包|便當袋|水壺|鉛筆盒|吊飾|鑰匙圈)/i;

export function parseSenSenCollectionData(data, pageUrl = 'https://www.sen-sen.com.tw/') {
  const products = [];
  for (const candidate of Array.isArray(data) ? data : []) {
    const title = cleanText(candidate?.title);
    const url = absoluteUrl(candidate?.url, pageUrl);
    if (!title || !url || !BEYBLADE_MODEL_WORDS.test(title) || SENSEN_NON_BEYBLADE_WORDS.test(title)) continue;
    const variants = (Array.isArray(candidate?.variants) ? candidate.variants : []).map((variant) => {
      const rawStock = Number(variant?.inventory_quantity);
      const stock = Number.isFinite(rawStock) ? Math.max(0, rawStock) : 0;
      const name = cleanText(variant?.option1 || variant?.sku || title);
      return {
        id: cleanText(variant?.id || name),
        name,
        stock,
        available: stock > 0,
        stockSource: 'sensen-cyberbiz-inventory'
      };
    });
    const numericPrice = Number(candidate?.price);
    products.push({
      id: cleanText(candidate?.id || productIdFromUrl(url)),
      title,
      url,
      imageUrl: absoluteUrl(candidate?.photo, pageUrl),
      price: Number.isFinite(numericPrice) && numericPrice > 0 ? `NT$${numericPrice.toLocaleString('zh-TW')}` : '',
      available: variants.some((variant) => variant.available),
      status: variants.some((variant) => variant.available) ? 'available' : '售完',
      variants,
      stockSource: 'sensen-cyberbiz-inventory'
    });
  }
  return products;
}

export function parseTwjCollectionData(data, pageUrl = 'https://www.twj.tw/') {
  const products = [];
  for (const candidate of Array.isArray(data) ? data : []) {
    const title = cleanText(candidate?.title);
    const url = absoluteUrl(candidate?.url, pageUrl);
    if (!title || !url || !PRODUCT_WORDS.test(title)) continue;

    const variants = (Array.isArray(candidate?.variants) ? candidate.variants : []).map((variant) => {
      const rawStock = Number(variant?.inventory_quantity);
      const stock = Number.isFinite(rawStock) ? Math.max(0, rawStock) : 0;
      const name = cleanText(variant?.option1 || variant?.sku || title);
      return {
        id: cleanText(variant?.id || name),
        name,
        stock,
        available: stock > 0,
        stockSource: 'twj-cyberbiz-inventory'
      };
    });
    const numericPrice = Number(candidate?.price);
    const available = variants.some((variant) => variant.available);
    products.push({
      id: cleanText(candidate?.id || productIdFromUrl(url)),
      title,
      url,
      imageUrl: absoluteUrl(candidate?.photo, pageUrl),
      price: Number.isFinite(numericPrice) && numericPrice > 0
        ? `NT$${numericPrice.toLocaleString('zh-TW')}`
        : '',
      available,
      status: available ? 'available' : '商品已售完',
      variants,
      stockSource: 'twj-cyberbiz-inventory'
    });
  }
  return products;
}

function isMmToyCustomerOnly(value) {
  return /(?:限客(?:訂)?|客訂|指定(?:帳號|買家|客人)|專屬(?:賣場|下單))/i.test(cleanText(value));
}

export function parseMmToyCategoryData(data, pageUrl = 'https://mmtoyshop.com/') {
  const products = [];
  for (const candidate of Array.isArray(data?.products) ? data.products : []) {
    const id = cleanText(candidate.id || candidate.route);
    const title = cleanText(candidate.title);
    const route = cleanText(candidate.route);
    if (!id || !route || !title || !isTrackedBeybladeToy(title, pageUrl)) continue;

    const rawSpecs = Array.isArray(candidate.specs) ? candidate.specs : [];
    const publicSpecs = rawSpecs.filter((spec) => !isMmToyCustomerOnly(
      `${spec?.size_name || ''} ${spec?.option_name || ''} ${spec?.option_values || ''}`
    ));
    const restrictedSpecs = rawSpecs.filter((spec) => !publicSpecs.includes(spec));
    const variants = publicSpecs.map((spec) => {
      const stock = Math.max(0, Number(spec?.quantity) || 0);
      const name = cleanText(spec?.size_name || spec?.option_name || spec?.option_values || title);
      return {
        id: cleanText(spec?.id || name),
        name,
        stock,
        available: stock > 0,
        stockSource: 'mmtoy-category-spec'
      };
    });

    const aggregateStock = Math.max(0, Number(candidate.quantity) || 0);
    const hasRestrictedSpecs = restrictedSpecs.length > 0;
    // BVSHOP's product-level quantity can lag behind its spec rows. When specs
    // exist, only the selected spec quantity represents something a shopper can
    // actually buy. Falling back to the aggregate here caused false restocks and
    // sent the order worker to pages that still showed "補貨中".
    if (!variants.length && !hasRestrictedSpecs) {
      variants.push({
        id,
        name: title,
        stock: aggregateStock,
        available: aggregateStock > 0,
        stockSource: 'mmtoy-category-total'
      });
    }

    const available = variants.some((variant) => variant.available);
    const numericPrice = Number(candidate.shownPrice ?? candidate.special_price ?? candidate.price);
    products.push({
      id,
      title,
      url: absoluteUrl(`/item/${route}`, pageUrl),
      imageUrl: absoluteUrl(candidate.photo || candidate.photos?.[0]?.url, pageUrl),
      price: Number.isFinite(numericPrice) && numericPrice > 0
        ? `NT$${numericPrice.toLocaleString('zh-TW')}`
        : '',
      available,
      status: available ? 'available' : cleanText(candidate.soldout_hint || '補貨中'),
      variants,
      stockSource: variants[0]?.stockSource || '',
      restrictedVariantCount: restrictedSpecs.length
    });
  }
  return products;
}

function isKingstoneUrl(url) {
  return /shop\.tcsb\.com\.tw/i.test(url);
}

function isEsliteUrl(url) {
  try {
    return /(?:^|\.)eslite\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isTrackedBeybladeToy(title, pageUrl) {
  const text = cleanText(title);
  if (isKingstoneUrl(pageUrl)) {
    return /BEYBLADE\s*X/i.test(text)
      && BEYBLADE_MODEL_WORDS.test(text)
      && !/(?:書|紙陀螺|漫畫|背包|書包|收納包|貼紙|吊飾|鑰匙圈|戰鬥盤|競技場|發射器|握把)/i.test(text);
  }
  if (!isEsliteUrl(pageUrl)) return PRODUCT_WORDS.test(text);
  return /(?:BEYBLADE\s*X|戰鬥陀螺)/i.test(text)
    && BEYBLADE_MODEL_WORDS.test(text)
    && !NON_TOY_WORDS.test(text);
}

function productAvailability(context, pageUrl) {
  if (UNAVAILABLE_WORDS.test(context)) return false;
  if (/eslite\.com/i.test(pageUrl)) return AVAILABLE_WORDS.test(context) ? true : null;
  return true;
}

export function shoppingSiteName(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (hostname === 'momoshop.com.tw') return 'momo購物網';
    if (hostname === 'eslite.com') return '誠品線上';
    if (hostname === 'shop.tcsb.com.tw') return '墊腳石購物網';
    if (hostname === 'twj.tw') return '童無忌';
    if (hostname.endsWith('shopee.tw')) return '蝦皮購物';
    if (hostname.endsWith('coupang.com')) return '酷澎';
    if (hostname.endsWith('pchome.com.tw')) return 'PChome 24h購物';
    if (hostname.endsWith('books.com.tw')) return '博客來';
    return hostname;
  } catch {
    return '購物網站';
  }
}

export function parseMomoVariants(html) {
  const text = String(html || '');
  const variants = [];
  const seen = new Set();
  const pattern = /\\?"goodsTypeAName\\?":\\?"([^"\\]+)\\?"/g;
  const matches = [...text.matchAll(pattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = cleanText(match[1]);
    const looksLikeDimensions = /^\d+(?:\.\d+)?(?:\s*[*x×]\s*\d+(?:\.\d+)?){1,2}(?:\s*(?:cm|公分))?$/i.test(name);
    if (!name || looksLikeDimensions || seen.has(name)) continue;
    const nextOffset = matches[index + 1]?.index;
    const section = text.slice(match.index, Number.isFinite(nextOffset) ? nextOffset : match.index + 1800);
    const stock = Number(section.match(/\\?"goodsNum\\?":\\?"(\d+)\\?"/)?.[1]);
    if (!Number.isFinite(stock)) continue;
    const code = cleanText(section.match(/\\?"goodsTypeCode\\?":\\?"([^"\\]+)\\?"/)?.[1]);
    const rawPrice = cleanText(section.match(/\\?"goodsTypePrice\\?"[\s\S]{0,300}?\\?"price\\?":\\?"([\d,]+)\\?"/)?.[1]);
    const imageUrl = cleanText(section.match(/\\?"goodsTypeAImgUrl\\?":\\?"(https?:[^"\\]+)\\?"/)?.[1]);
    seen.add(name);
    variants.push({
      id: name,
      name,
      stock,
      available: stock > 0,
      ...(code ? { code } : {}),
      ...(rawPrice ? { price: `$${rawPrice}` } : {}),
      ...(imageUrl ? { imageUrl } : {})
    });
  }
  return variants;
}

function detailedMomoVariants(product) {
  return (product?.variants || []).filter((variant) => variant.id !== '__momo_store_total__');
}

function isLikelyMomoMultiVariant(product, previous) {
  const modelCodes = new Set(
    [...String(product?.title || '').matchAll(/\b(?:BXG|BX|UX|CX)-\d{2}\b/gi)]
      .map((match) => match[0].toUpperCase())
  );
  return product?.multiVariant === true
    || modelCodes.size > 1
    || detailedMomoVariants(previous).length > 1;
}

function momoStoreListingSignalChanged(product, previous, previousTarget) {
  if (!previous) return true;
  const previousLastSeenAt = Date.parse(previous.lastSeenAt || '');
  const previousScanAt = Date.parse(previousTarget?.lastScanAt || '');
  const reappearedAfterMissingScan = Number.isFinite(previousLastSeenAt)
    && Number.isFinite(previousScanAt)
    && previousLastSeenAt < previousScanAt;
  return reappearedAfterMissingScan
    || Number(previous.stock) !== Number(product.stock)
    || previous.available !== product.available
    || cleanText(previous.status) !== cleanText(product.status)
    || cleanText(previous.price) !== cleanText(product.price);
}

export function parseMomoStoreGoodsData(data, pageUrl) {
  const rows = Array.isArray(data?.rtnGoodsData?.goodsInfoList)
    ? data.rtnGoodsData.goodsInfoList
    : [];
  return rows.map((item) => {
    const id = cleanText(item?.goodsCode);
    const title = cleanText(item?.goodsName);
    const url = absoluteUrl(
      cleanText(item?.goodsUrl)
        || (id ? `/TP/${new URL(pageUrl).pathname.match(/\/TP\/([^/]+)/i)?.[1] || ''}/goodsDetail/${id}` : ''),
      pageUrl
    );
    const rawStock = Number(item?.goodsStock);
    const stock = Number.isFinite(rawStock) ? Math.max(0, rawStock) : null;
    const available = stock !== null ? stock > 0 : !UNAVAILABLE_WORDS.test(cleanText(item?.onSaleDescription));
    const rawPrice = cleanText(item?.goodsPrice || item?.SALE_PRICE);
    const rangePrice = item?.goodsPriceModel?.rangePrice;
    const minPrice = cleanText(rangePrice?.minPrice);
    const maxPrice = cleanText(rangePrice?.maxPrice);
    return {
      id: id || productIdFromUrl(url),
      title,
      url,
      imageUrl: absoluteUrl(item?.imgUrl, pageUrl),
      price: minPrice && maxPrice && minPrice !== maxPrice ? `$${minPrice}~$${maxPrice}` : rawPrice ? `$${rawPrice}` : '',
      stock,
      available,
      multiVariant: Boolean(minPrice && maxPrice && minPrice !== maxPrice),
      status: available ? 'available' : cleanText(item?.onSaleDescription) || 'unavailable',
      stockSource: 'momo-store-category-api',
      variants: stock === null ? [] : [{
        id: '__momo_store_total__',
        name: '商品頁總庫存',
        stock,
        available,
        stockSource: 'momo-store-category-api'
      }]
    };
  }).filter((product) => (
    product.id
    && product.url
    && isTrackedBeybladeToy(product.title, product.url)
  ));
}

export function momoStoreDetailRequest(productUrl) {
  const url = new URL(productUrl);
  const entpCode = url.pathname.match(/\/TP\/([^/]+)\/goodsDetail\//i)?.[1] || '';
  const goodsCode = url.pathname.match(/\/goodsDetail\/(TP\d+)/i)?.[1] || '';
  if (!entpCode || !goodsCode) throw new Error('momo 店＋商品網址缺少商店或商品編號');
  return {
    host: 'momoshop',
    data: {
      addressData: {
        areaName: '', countryName: '', inputAddress: '', postalCode: '', receiverSeq: '', whCode: ''
      },
      categoryCode: '',
      entpCode,
      fgDiscount: false,
      goodsCode,
      hour: '',
      imgType: 'webp',
      isShowDely: true,
      simOrderYn: '0',
      sourcePage: '',
      tag: '1',
      ecTagNos: ['']
    }
  };
}

function momoStoreVariantRows(goodsData) {
  const specForm = (Array.isArray(goodsData?.formData) ? goodsData.formData : [])
    .find((form) => String(form?.formType) === '5');
  const multiple = specForm?.goodsMutipleType?.goodsMutipleTypeInfo;
  if (Array.isArray(multiple) && multiple.length) return multiple;
  return Array.isArray(specForm?.goodsTypeInfo) ? specForm.goodsTypeInfo : [];
}

function momoStoreShippingLabel(value) {
  const text = cleanText(value);
  const match = text.match(/預計\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*出貨/i);
  if (!match) return text;
  return `${String(Number(match[2])).padStart(2, '0')}/${String(Number(match[3])).padStart(2, '0')} 出貨`;
}

export function parseMomoStoreDetailData(data, productUrl, previous = null) {
  const goods = data?.rtnGoodsData;
  if (!goods || data?.success !== true || String(data?.resultCode || '') !== '200') return null;
  const rows = momoStoreVariantRows(goods);
  const overallBlocked = String(goods?.canTipStock ?? '') === '0';
  const variants = rows.map((row) => {
    const name = cleanText(row?.goodsTypeAName || row?.goodsType || row?.goodsTypeBName);
    const code = cleanText(row?.goodsTypeCode);
    const stock = Math.max(0, Number(row?.goodsNum) || 0);
    const rowBlocked = String(row?.canTipStock ?? '') === '0';
    const rawPrice = cleanText(row?.goodsTypePrice?.basePrice?.price);
    const shippingText = cleanText(row?.goodsPaymentDescription);
    const shippingLabel = momoStoreShippingLabel(shippingText);
    return {
      id: name || code,
      name: name || code || '單一規格',
      code,
      stock,
      available: stock > 0 && !overallBlocked && !rowBlocked,
      ...(rawPrice ? { price: `$${rawPrice}` } : {}),
      ...(row?.goodsTypeAImgUrl || row?.goodsTypeImgUrl
        ? { imageUrl: absoluteUrl(row.goodsTypeAImgUrl || row.goodsTypeImgUrl, productUrl) }
        : {}),
      ...(shippingText ? { shippingText } : {}),
      ...(shippingLabel ? { shippingLabel } : {}),
      stockSource: 'momo-store-detail-api'
    };
  }).filter((variant) => variant.id);
  const fallbackStock = Math.max(0, Number(goods?.goodsStock) || 0);
  const fallbackAvailable = fallbackStock > 0 && !overallBlocked;
  const available = variants.length
    ? variants.some((variant) => variant.available)
    : fallbackAvailable;
  const prices = variants
    .map((variant) => Number(String(variant.price || '').replace(/[^\d]/g, '')))
    .filter((price) => Number.isFinite(price) && price > 0);
  const minimumPrice = prices.length ? Math.min(...prices) : null;
  const maximumPrice = prices.length ? Math.max(...prices) : null;
  const id = cleanText(goods.goodsCode) || productIdFromUrl(productUrl);
  return {
    ...(previous || {}),
    id,
    title: cleanText(goods.goodsName) || previous?.title || id,
    url: productUrl,
    imageUrl: absoluteUrl(goods.imgUrl, productUrl) || previous?.imageUrl || '',
    price: minimumPrice && maximumPrice
      ? minimumPrice === maximumPrice ? `$${minimumPrice}` : `$${minimumPrice}~$${maximumPrice}`
      : previous?.price || '',
    stock: variants.length
      ? variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0)
      : fallbackStock,
    available,
    multiVariant: variants.length > 1,
    status: available ? 'available' : cleanText(goods.onSaleDescription) || 'unavailable',
    stockSource: 'momo-store-detail-api',
    variants: variants.length ? variants : [{
      id: '__momo_store_total__',
      name: '商品頁總庫存',
      stock: fallbackStock,
      available: fallbackAvailable,
      stockSource: 'momo-store-detail-api'
    }]
  };
}

export function momoStoreGoodsRequest(targetUrl, page = 1) {
  const url = new URL(targetUrl);
  const entpCode = url.pathname.match(/\/TP\/([^/]+)/i)?.[1] || '';
  const brandName = cleanText(url.searchParams.get('brand'));
  const brandCode = cleanText(url.searchParams.get('brandNo'));
  if (!entpCode) throw new Error('momo 店＋網址缺少商店編號');
  return {
    host: 'momoshop',
    data: {
      entpCode,
      brandName: brandName ? [brandName] : [],
      brandCode: brandCode ? [brandCode] : [],
      cateType: '',
      cateLevel: '',
      cateCode: '',
      cp: 'N',
      curPage: String(Math.max(1, Number(page) || 1)),
      custNo: '',
      first: 'N',
      freeze: 'N',
      imgType: 'webp',
      indexInfoList: [],
      NAM: 'N',
      normal: '',
      prefere: 'N',
      moExpressYN: 'N',
      vendorSYN: 'N',
      crossBorderYN: 'N',
      priceE: '9999999',
      priceS: '0',
      searchType: '1',
      sortType: '1',
      salesSort: '',
      recommendGroup: '',
      isSpecialSortType: true,
      specialSortType: '',
      specialGoodsType: '',
      stockYN: 'N',
      superstore: 'N',
      threeHours: 'N',
      tomorrow: 'N',
      tvshop: 'N',
      video: 'N',
      cycle: 'N',
      cod: 'N',
      superstorePay: 'N',
      superstoreFree: 'N',
      brandSeriesList: [],
      commentRate: '',
      moCoinFeedback: 'N',
      discount: 'N'
    }
  };
}

export function parseMomoSaleStart(html, now = new Date()) {
  const decoded = String(html || '')
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-f]{4})/gi, (_, value) => String.fromCharCode(Number.parseInt(value, 16)));
  const descriptions = [...decoded.matchAll(/"goodsPaymentDescription"\s*:\s*"([^"]+)"/g)]
    .map((match) => cleanText(match[1]));
  const candidates = descriptions.length ? descriptions : [cleanText(decoded)];
  const taipeiParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: 'numeric'
    }).formatToParts(now).map((part) => [part.type, part.value])
  );
  for (const candidate of candidates) {
    const match = candidate.match(
      /(?:(\d{4})[/.年-])?(\d{1,2})[/.月-](\d{1,2})日?\s*(上午|下午)?\s*(\d{1,2}):(\d{2})\s*(?:開賣|開售|開始販售|開始銷售)/i
    );
    if (!match) continue;
    let year = Number(match[1] || taipeiParts.year);
    const month = Number(match[2]);
    const day = Number(match[3]);
    let hour = Number(match[5]);
    const minute = Number(match[6]);
    if (match[4] === '下午' && hour < 12) hour += 12;
    if (match[4] === '上午' && hour === 12) hour = 0;
    const build = (targetYear) => new Date(
      `${targetYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`
    );
    let saleStart = build(year);
    if (!match[1] && saleStart.getTime() < now.getTime() - 180 * 24 * 60 * 60 * 1000) {
      year += 1;
      saleStart = build(year);
    }
    if (Number.isFinite(saleStart.getTime())) return saleStart.toISOString();
  }
  return null;
}

function isMomoProductUrl(url) {
  return /momoshop\.com\.tw\/(?:product\/\d+|goods\/GoodsDetail\.jsp\?[^#]*\bi_code=\d+)/i.test(url);
}

function isMomoListingUrl(url) {
  return /momoshop\.com\.tw\/(?:categories\/\d+|search\/|search\/searchShop\.jsp)/i.test(url);
}

function isMomoCategoryTarget(target) {
  return target?.sourceType === 'momo-category'
    || /momoshop\.com\.tw\/categories\/\d+/i.test(target?.url || '');
}

function isEsliteExhibitionUrl(url) {
  return /eslite\.com\/exhibitions\/[^/?#]+/i.test(url);
}

function isEsliteKeywordTarget(target) {
  return target?.sourceType === 'eslite-keywords';
}

function safeDiagnosticMessage(error, fallback = '未知錯誤') {
  const raw = String(error?.message || error || fallback)
    .replace(/(^|\n)\s*-\s*(?:cookie|authorization):[^\n]*/gi, '$1  - credential: [已遮罩]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已遮罩]')
    .replace(/\b(cookie|authorization)\s*:\s*[^\n]+/gi, '$1: [已遮罩]');
  return cleanText(raw).slice(0, 600) || fallback;
}

function esliteExhibitionCode(url) {
  try {
    return new URL(url).pathname.match(/\/exhibitions\/([^/?#]+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

function momoGoodsSortedCode(html) {
  return String(html || '').match(/\\?"goodsSortedCode\\?":\\?"([^"\\]+)\\?"/)?.[1] || '';
}

function momoProductMetadata(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  const title = cleanText(
    $('meta[property="og:title"]').attr('content')
    || $('meta[name="title"]').attr('content')
    || $('title').text()
  ).replace(/\s*-\s*momo購物網[\s\S]*$/i, '');
  const imageUrl = absoluteUrl(
    $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content'),
    pageUrl
  );
  const explicitPrice = cleanText(
    $('meta[property="product:price:amount"]').attr('content')
    || $('meta[itemprop="price"]').attr('content')
  );
  const decoded = String(html || '')
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-f]{4})/gi, (_, value) => String.fromCharCode(Number.parseInt(value, 16)));
  const structuredPrice = decoded.match(
    /"price"\s*:\s*"?(?<price>\d[\d,]*)"?(?:\s*[,}])/
  )?.groups?.price || '';
  const numericPrice = Number(String(explicitPrice || structuredPrice).replace(/,/g, ''));
  return {
    title,
    imageUrl,
    price: Number.isFinite(numericPrice) && numericPrice > 0
      ? `$${numericPrice.toLocaleString('en-US')}`
      : ''
  };
}

export function parseEsliteExhibitData(data, pageUrl) {
  const candidates = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.product_guid && value.name) candidates.push(value);
    Object.values(value).forEach(visit);
  };
  visit(data);

  const products = new Map();
  for (const candidate of candidates) {
    const id = cleanText(candidate.product_guid);
    const title = cleanText(candidate.name);
    if (!id || !title || !isTrackedBeybladeToy(title, pageUrl) || products.has(id)) continue;
    const stock = Number(candidate.stock);
    const hasStock = candidate.stock != null && candidate.stock !== '' && Number.isFinite(stock);
    const status = cleanText(candidate.status || candidate.product_button_status);
    const unavailable = /can_not_buy|cannot_buy|sold_out|out_of_stock|unavailable|off_sale|not_started|coming_soon/i.test(status);
    const available = hasStock
      ? stock > 0 && !unavailable
      : unavailable
        ? false
        : /can_buy|available|in_stock|on_sale/i.test(status)
          ? true
          : null;
    products.set(id, {
      id,
      title,
      url: absoluteUrl(`/product/${id}`, pageUrl),
      imageUrl: absoluteUrl(candidate.image, pageUrl),
      price: '',
      available,
      status,
      availabilitySource: 'eslite-exhibition-api',
      variants: hasStock
        ? [{
            id,
            name: title,
            stock,
            available,
            stockSource: 'eslite-book-exhibit'
          }]
        : [],
      stockSource: hasStock ? 'eslite-book-exhibit' : ''
    });
  }
  return [...products.values()];
}

export function parseEsliteSearchData(data, pageUrl = 'https://www.eslite.com/') {
  const products = new Map();
  for (const candidate of Array.isArray(data?.results) ? data.results : []) {
    const id = cleanText(candidate.id || candidate.product_guid || candidate.guid);
    const title = cleanText(candidate.name || candidate.product_name);
    if (!id || !title || !isTrackedBeybladeToy(title, pageUrl) || products.has(id)) continue;
    if (candidate.is_book === true || candidate.is_ebook === true || candidate.product_type === 'book') continue;

    const buttonStatus = cleanText(candidate.button_status || candidate.product_button_status || candidate.status);
    const availability = cleanText(candidate.availability);
    const statusText = `${buttonStatus} ${availability}`;
    const unavailable = /can_not_buy|cannot_buy|sold_out|out_of_stock|unavailable|off_sale|not_started|coming_soon|not_add_to_notice/i.test(statusText)
      || /OUT_OF_STOCK/i.test(availability);
    const available = unavailable
      ? false
      : /add_to_shopping_cart|can_buy|in_stock|available|on_sale/i.test(statusText)
        ? true
        : null;
    const numericPrice = Number(candidate.final_price ?? candidate.price ?? candidate.sale_price);
    products.set(id, {
      id,
      title,
      url: absoluteUrl(`/product/${id}`, pageUrl),
      imageUrl: absoluteUrl(candidate.product_photo_url || candidate.image || candidate.image_url, pageUrl),
      price: Number.isFinite(numericPrice) && numericPrice > 0
        ? `NT$${numericPrice.toLocaleString('zh-TW')}`
        : '',
      available,
      status: buttonStatus || availability,
      variants: [],
      stockSource: '',
      availabilitySource: 'eslite-search-api'
    });
  }
  return [...products.values()];
}

// Stock alone is not a buy signal: unpublished products may have inventory.
export function isEsliteSourceBuySignal(product) {
  if (product?.available !== true) return false;
  const status = cleanText(product.status).toLowerCase();
  if (/can_not_buy|cannot_buy|sold_out|unavailable|off_sale|not_started|coming_soon/i.test(status)) return false;
  return /^(?:add_to_shopping_cart|can_buy|in_stock|on_sale)$/.test(status);
}

export function parseEslitePurchaseStatus(data, product = {}) {
  const status = cleanText(data?.product_button_status || data?.button_status || data?.status);
  const rawStock = Number(data?.stock);
    const hasStock = data?.stock != null && data.stock !== '' && Number.isFinite(rawStock);
  const stock = hasStock ? Math.max(0, rawStock) : null;
  const unavailable = /can_not_buy|cannot_buy|sold_out|out_of_stock|unavailable|off_sale|not_started|coming_soon|not_add_to_notice/i.test(status);
  const available = unavailable
    ? false
    : /add_to_shopping_cart|can_buy|in_stock|available|on_sale/i.test(status)
      ? !hasStock || stock > 0
      : hasStock
        ? stock > 0
        : null;
  const salePrice = Number(data?.retail_price);
  const regularPrice = Number(data?.final_price);
  const displayPrice = Number.isFinite(salePrice) && salePrice > 0 ? salePrice : regularPrice;
  const id = cleanText(data?.product_guid || product.id || productIdFromUrl(product.url || ''));
  const title = cleanText(product.title || data?.name || data?.product_name);

  return {
    ...product,
    id: id || product.id,
    title: title || product.title,
    available,
    status,
    price: Number.isFinite(displayPrice) && displayPrice > 0
      ? `NT$${displayPrice.toLocaleString('zh-TW')}`
      : product.price || '',
    variants: hasStock && id
      ? [{ id, name: title || id, stock, available: available === true, stockSource: 'eslite-purchase-status' }]
      : product.variants || [],
    stockSource: hasStock ? 'eslite-purchase-status' : product.stockSource || '',
    availabilitySource: 'eslite-purchase-status'
  };
}

export function parseEsliteProductPage(html, pageUrl = 'https://www.eslite.com/') {
  const $ = cheerio.load(String(html || ''));
  const exactPurchaseButtons = $('button, a').filter((_, element) => {
    const text = cleanText($(element).text());
    return text === '加入購物車' || text === '直接購買';
  });
  let enabledPurchaseButton = false;
  let disabledPurchaseButton = false;
  exactPurchaseButtons.each((_, element) => {
    const node = $(element);
    const disabled = node.is('[disabled]')
      || node.attr('aria-disabled') === 'true'
      || /(?:disabled|is-disabled|unavailable)/i.test(node.attr('class') || '');
    if (disabled) disabledPurchaseButton = true;
    else enabledPurchaseButton = true;
  });

  const mainText = cleanText($('main').text() || $('[role="main"]').text() || $('body').text());
  const unavailable = UNAVAILABLE_WORDS.test(mainText)
    || /(?:can_not_buy|cannot_buy|sold_out|out_of_stock)/i.test(String(html || ''));
  const title = cleanText(
    $('meta[property="og:title"]').attr('content')
    || $('h1').first().text()
    || $('title').text()
  ).replace(/\s*[|｜-]\s*誠品線上.*$/i, '');
  const imageUrl = absoluteUrl(
    $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content'),
    pageUrl
  );
  const priceText = cleanText(
    $('meta[property="product:price:amount"]').attr('content')
    || $('[itemprop="price"]').attr('content')
  ) || mainText.match(/NT\$\s*[\d,]+/)?.[0] || '';
  const numericPrice = Number(String(priceText).replace(/[^\d]/g, ''));

  return {
    available: enabledPurchaseButton ? true : unavailable || disabledPurchaseButton ? false : null,
    status: enabledPurchaseButton ? 'add_to_shopping_cart' : unavailable || disabledPurchaseButton ? 'can_not_buy' : '',
    title,
    imageUrl,
    price: Number.isFinite(numericPrice) && numericPrice > 0
      ? `NT$${numericPrice.toLocaleString('zh-TW')}`
      : ''
  };
}

export function parseShoppingPage(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  const products = [];
  const seen = new Set();

  $('a[href]').each((_, anchor) => {
    const url = absoluteUrl($(anchor).attr('href'), pageUrl);
    if (!url || !productLink(url)) return;
    const id = productIdFromUrl(url);
    if (!id || seen.has(id)) return;
    const matchedCard = $(anchor).closest('li, article, .product, .product-item, .goodsItem, .item, div');
    const card = matchedCard.length ? matchedCard : $(anchor).parent();
    const image = $(anchor).find('img').first().add(card.find('img').first()).first();
    const title = cleanText(
      $(anchor).find('h1,h2,h3,h4').first().text()
      || image.attr('alt')
      || $(anchor).attr('title')
      || $(anchor).text()
    );
    if (!title || !isTrackedBeybladeToy(title, pageUrl)) return;
    const context = cleanText(card.text());
    const availabilityContext = cleanText(`${context} ${$(anchor).closest('.exhibit-card, .product-in-article').text()}`);
    const esliteCard = $(anchor).closest('.exhibit-card, .product-in-article, .product-item, li, article');
    const cardProductIds = new Set(esliteCard.find('a[href*="/product/"]').toArray()
      .map((element) => productIdFromUrl(absoluteUrl($(element).attr('href'), pageUrl))));
    const enabledEsliteButton = /(^|\.)eslite\.com$/i.test(new URL(url).hostname)
      && esliteCard.length > 0 && cardProductIds.size === 1 && cardProductIds.has(id)
      && esliteCard.find('button').toArray().some((element) => {
        const button = $(element);
        return /^(加入購物車|直接購買)$/.test(cleanText(button.text()))
          && !button.is('[disabled]') && button.attr('aria-disabled') !== 'true'
          && !/disabled|unavailable/i.test(button.attr('class') || '');
      }) && !UNAVAILABLE_WORDS.test(availabilityContext);
    const price = availabilityContext.match(/(?:NT\$|\$)\s?[\d,]+(?:\s?[~-]\s?(?:NT\$|\$)?\s?[\d,]+)?/)?.[0] || '';
    seen.add(id);
    products.push({
      id,
      title,
      url,
      imageUrl: absoluteUrl(image.attr('src') || image.attr('data-src') || image.attr('data-original'), pageUrl),
      price,
      available: enabledEsliteButton ? true : productAvailability(availabilityContext, pageUrl),
      ...(enabledEsliteButton ? { status: 'add_to_shopping_cart', availabilitySource: 'eslite-listing-button' } : {}),
      variants: []
    });
  });

  if (!products.length && productLink(pageUrl)) {
    const encodedTitle = String(html || '').match(/\\?"goodsName\\?":\\?"([^"\\]+)\\?"/)?.[1] || '';
    const title = cleanText(
      $('h1,h2,h3').filter((_, element) => PRODUCT_WORDS.test($(element).text())).first().text()
      || encodedTitle
    );
    if (title) {
      const context = cleanText($('body').text());
      const variants = parseMomoVariants(html);
      const pageAvailability = productAvailability(context, pageUrl);
      const encodedImage = String(html || '').match(/https:\/\/[^"\\]+\/(?:goodsimg|spec)\/[^"\\]+\.(?:jpg|jpeg|png|webp)/i)?.[0] || '';
      const encodedPrice = String(html || '').match(/\\?"(?:minPrice|price)\\?":\\?"([\d,]+)\\?"/)?.[1] || '';
      products.push({
        id: productIdFromUrl(pageUrl),
        title,
        url: pageUrl,
        imageUrl: absoluteUrl($('meta[property="og:image"]').attr('content') || encodedImage || $('img').first().attr('src'), pageUrl),
        price: context.match(/(?:NT\$|\$)\s?[\d,]+(?:\s?[~-]\s?(?:NT\$|\$)?\s?[\d,]+)?/)?.[0] || (encodedPrice ? `$${encodedPrice}` : ''),
        // 商品頁的正式可購／不可購狀態優先於 Next.js 預載的 goodsNum。
        // momo 可能在開賣前或售罄後仍保留正數庫存，不能讓它反轉頁面狀態。
        available: pageAvailability === null
          ? variants.length ? variants.some((variant) => variant.available) : null
          : pageAvailability,
        variants
      });
    }
  }
  if (isMomoProductUrl(pageUrl)) {
    const metadata = momoProductMetadata(html, pageUrl);
    const currentId = productIdFromUrl(pageUrl);
    const current = products.find((product) => product.id === currentId) || products[0];
    if (current) {
      current.title = metadata.title || current.title;
      current.imageUrl = metadata.imageUrl || current.imageUrl;
      current.price = metadata.price || current.price;
    }
  }
  if (productLink(pageUrl)) {
    const currentId = productIdFromUrl(pageUrl);
    const variants = parseMomoVariants(html);
    const current = products.find((product) => product.id === currentId) || products[0];
    if (current && variants.length) {
      // momo 會在正式開賣前先把 goodsNum 寫進頁面，也可能在售罄後
      // 暫時保留該數字。商品頁若已明確顯示不可購買，不得再被這個
      // 預載／殘留數量翻回有貨。
      const explicitlyUnavailable = current.available === false;
      current.variants = explicitlyUnavailable
        ? variants.map((variant) => ({ ...variant, available: false }))
        : variants;
      current.available = explicitlyUnavailable ? false : variants.some((variant) => variant.available);
    }
  }
  return products;
}

export function shoppingProductExcludeMatch(product, keywords = []) {
  const searchable = [
    product?.id,
    product?.url,
    product?.title,
    ...(Array.isArray(product?.variants) ? product.variants.map((variant) => variant?.name || variant?.title) : [])
  ]
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-TW');
  if (!searchable) return '';
  return (Array.isArray(keywords) ? keywords : [])
    .map((keyword) => String(keyword || '').trim())
    .find((keyword) => keyword && searchable.includes(keyword.normalize('NFKC').toLocaleLowerCase('zh-TW'))) || '';
}

function stockThreshold(previousStock, currentStock) {
  if (!Number.isFinite(previousStock) || !Number.isFinite(currentStock) || currentStock >= previousStock) return null;
  return STOCK_THRESHOLDS.filter((threshold) => previousStock > threshold && currentStock <= threshold).at(-1) || null;
}

function notificationEvent(event, product, variant) {
  if (event === 'verification-pending') return { icon: '🆕', title: `新商品頁｜${product.title}`, color: 0x8b5cf6, footer: '商品已被來源捕獲；可購狀態仍待確認，尚未觸發購買' };
  if (event === 'coming-soon') return { icon: '⏳', title: `即將開賣｜${product.title}`, color: 0xf59e0b, footer: '誠品已建立商品頁；尚未開放加入購物車' };
  if (event === 'listed-unavailable') return { icon: '🆕', title: `新商品頁｜${product.title}`, color: 0x8b5cf6, footer: '商品頁剛出現在專區；首次掃描時已售罄' };
  if (event === 'restock') return { icon: '🔔', title: `規格補貨｜${variant?.name || product.title}`, color: 0x3c82f6, footer: '既有商品恢復可購買' };
  if (event === 'low-stock') return { icon: '📉', title: `庫存提醒｜${variant?.name || product.title}`, color: 0xf59e0b, footer: '前台可售數量跨過提醒門檻' };
  if (event === 'sold-out') return { icon: '⛔', title: `售罄提醒｜${variant?.name || product.title}`, color: 0x6b7280, footer: '商品或款式已無法購買' };
  return { icon: '🚨', title: `新品上架｜${product.title}`, color: 0xe5484d, footer: '購物專區出現新的商品頁' };
}

function compactNotificationText(value, maxLength = 70) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function shoppingProductLabel(product, maxLength = 48) {
  const title = compactNotificationText(product?.title || '戰鬥陀螺', 180);
  const model = title.match(/\b(?:BXG|BX|CX|UX)-\d+\b/i);
  if (!model) return compactNotificationText(title, maxLength);
  let focused = title.slice(model.index);
  focused = focused.replace(/\s+(?:戰鬥|對戰|復古|熱血)(?:\s+.*)?$/u, '').trim();
  focused = focused.replace(/\s+隨機強化組$/u, '').trim();
  return compactNotificationText(focused, maxLength);
}

function mmToyEventLabel(event) {
  if (event === 'sold-out') return '售罄';
  if (event === 'low-stock') return '庫存提醒';
  if (event === 'listed-unavailable') return '新商品頁（目前售罄）';
  if (event === 'new') return '新品上架';
  return '補貨';
}

function isSpecificMomoStoreVariant(target, variant) {
  return isMomoStoreTarget(target)
    && variant
    && variant.id !== '__momo_store_total__';
}

function stockNotificationItemName(target, product, variant) {
  if (isSpecificMomoStoreVariant(target, variant)) return variant.name;
  return variant ? `${product.title}｜${variant.name}` : product.title;
}

export function notificationPreview(target, product, variant, event = 'new', { test = false } = {}) {
  if (isMmToyTarget(target)) {
    const detail = notificationEvent(event, product, variant);
    const stock = Number(variant?.stock ?? product?.stock);
    const facts = [
      mmToyEventLabel(event),
      product.price || '',
      Number.isFinite(stock) ? `可售 ${stock} 組` : ''
    ].filter(Boolean).join('｜');
    return `${test ? '🧪' : detail.icon} M.M小舖｜${shoppingProductLabel(product)}\n${facts || '點擊查看商品頁'}`;
  }
  const source = `${target.siteName || shoppingSiteName(target.url)}｜${target.name}`;
  const detail = notificationEvent(event, product, variant);
  if (event === 'new') {
    const stockText = Number.isFinite(Number(variant?.stock)) ? `\n前台可售 ${variant.stock} 組` : '';
    return `${detail.icon} ${source} 新品上架｜${product.title}\n${product.price || '點擊查看售價'}${stockText}`;
  }
  if (event === 'listed-unavailable') return `${detail.icon} ${source} 發現新商品頁｜${product.title}\n掃描時已售罄，已啟動高速追蹤`;
  if (event === 'verification-pending') return `${detail.icon} ${source} 發現新商品頁｜${product.title}\n可購狀態待確認，尚未觸發購買`;
  if (event === 'coming-soon') return `${detail.icon} ${source} 即將開賣｜${product.title}\n商品已建檔，等待開放加入購物車`;
  if (event === 'sold-out') return `${detail.icon} ${source} 售罄｜${variant?.name || product.title}\n點擊查看商品頁`;
  const stockText = variant?.stock !== undefined ? `目前 ${variant.stock} 組` : '恢復可購買';
  return `${detail.icon} ${source} ${event === 'low-stock' ? '庫存提醒' : '補貨'}｜${variant?.name || product.title}\n${stockText}｜點擊前往商品頁`;
}

export function notificationEmbed(target, product, variant, event = 'new', { test = false } = {}) {
  const detail = notificationEvent(event, product, variant);
  if (isMmToyTarget(target)) {
    const stock = Number(variant?.stock ?? product?.stock);
    const label = shoppingProductLabel(product, 80);
    const description = [
      test ? '**測試說明：** 模擬補貨通知，不是真實販售' : '',
      `**陀螺：** [${label}](${product.url})`,
      `**商品：** ${product.title}`,
      variant ? `**補貨款式：** ${variant.name}` : '',
      Number.isFinite(stock) ? `**前台可售：** ${stock} 組` : '',
      '',
      `**🛒 商品頁：** [立即前往](${product.url})`
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
    return {
      author: { name: '陀螺通知監控儀表・購物網站', url: product.url },
      title: `${test ? '🧪' : detail.icon} ${mmToyEventLabel(event)}｜${label}`,
      url: product.url,
      color: detail.color,
      description,
      thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
      footer: { text: test ? '模擬通知・不是真實販售' : detail.footer },
      timestamp: new Date().toISOString()
    };
  }
  const preciseMomoVariant = isSpecificMomoStoreVariant(target, variant);
  const itemTitle = preciseMomoVariant ? variant.name : product.title;
  const itemPrice = preciseMomoVariant ? variant.price : product.price;
  const description = [
    `**購物網站：** ${target.siteName || shoppingSiteName(target.url)}`,
    `**監控專區：** ${target.name}`,
    `**商品：** ${itemTitle}`,
    variant && event !== 'new' && !preciseMomoVariant ? `**補貨款式：** ${variant.name}` : '',
    variant?.stock !== undefined ? `**前台可售：** ${variant.stock} 組` : '',
    event === 'listed-unavailable' ? '**首次狀態：** 已售罄／補貨中' : '',
    event === 'verification-pending' ? '**首次狀態：** 可購狀態待確認，尚未觸發購買' : '',
    event === 'coming-soon' ? '**首次狀態：** 即將開賣，尚未開放加入購物車' : '',
    itemPrice ? `**價格：** ${itemPrice}` : '',
    '',
    `**🛒 購買：** [立即前往商品頁](${product.url})`
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  return {
    author: { name: '陀螺通知監控儀表・購物網站', url: product.url },
    title: `${detail.icon} ${detail.title}`,
    url: product.url,
    color: detail.color,
    description,
    thumbnail: (preciseMomoVariant ? variant.imageUrl : product.imageUrl) ? { url: preciseMomoVariant ? variant.imageUrl : product.imageUrl } : undefined,
    footer: { text: detail.footer },
    timestamp: new Date().toISOString()
  };
}

export function esliteExhibitionNotification(target, page, { detectedAt = new Date().toISOString() } = {}) {
  const title = cleanText(page.title || 'BEYBLADE X 戰鬥陀螺策展');
  const productCount = Math.max(0, Number(page.productCount) || 0);
  const url = String(page.url || '').trim();
  const countText = productCount ? `目前策展頁列出 ${productCount} 件戰鬥陀螺商品。` : '策展頁已可正式讀取。';
  return {
    text: `🚨 誠品重點預警：戰鬥陀螺策展頁已上架\n系統判定：準備補貨／開賣\n${title}\n${countText}\n${url}`,
    options: {
      discordAudience: 'public',
      discordPreview: `🚨 誠品策展頁已上架｜準備補貨／開賣\n${title}${productCount ? `｜${productCount} 件商品` : ''}`,
      embeds: [{
        author: { name: '陀螺通知監控儀表・誠品重點預警', url },
        title: `🚨 策展頁已上架｜${title}`,
        url,
        color: 0xf97316,
        description: [
          '**系統判定：** 準備補貨／開賣',
          `**監控專區：** ${target.name}`,
          productCount ? `**策展商品：** ${productCount} 件` : '',
          '**提醒：** 策展頁上架不等於商品已可購買，監控將繼續追蹤商品狀態。',
          '',
          `**🛒 策展頁：** [立即前往](${url})`
        ].filter(Boolean).join('\n'),
        thumbnail: page.imageUrl ? { url: page.imageUrl } : undefined,
        footer: { text: '誠品策展頁上架重點預警' },
        timestamp: detectedAt
      }]
    }
  };
}

export class ShoppingSiteMonitor {
  constructor({
    state,
    getTargets,
    getExcludeKeywords = () => [],
    notify,
    onPurchaseCandidate = null,
    onEsliteDiscoveryActivity = null,
    onEslitePurchaseObservation = null,
    getPendingSaleReminder = () => null,
    onPendingSaleDetected = null,
    log = () => {},
    fetcher = fetch,
    browserLauncher = (options) => chromium.launch(options),
    isEsliteMonitoringAllowed = () => true,
    esliteApiSessionFile = '',
    esliteRequestFactory = playwrightRequest,
    mmToyDiscoveryIntervalMs = 30_000,
    momoStoreDiscoveryIntervalMs = 30_000,
    esliteBlockedRetryMs = 30_000,
    esliteApiOnly = false
  }) {
    this.state = state;
    this.getTargets = getTargets;
    this.getExcludeKeywords = typeof getExcludeKeywords === 'function' ? getExcludeKeywords : () => [];
    this.notify = notify;
    this.onPurchaseCandidate = typeof onPurchaseCandidate === 'function' ? onPurchaseCandidate : null;
    this.onEslitePurchaseObservation = typeof onEslitePurchaseObservation === 'function' ? onEslitePurchaseObservation : null;
    this.onEsliteDiscoveryActivity = typeof onEsliteDiscoveryActivity === 'function'
      ? onEsliteDiscoveryActivity
      : null;
    this.getPendingSaleReminder = typeof getPendingSaleReminder === 'function'
      ? getPendingSaleReminder
      : () => null;
    this.onPendingSaleDetected = typeof onPendingSaleDetected === 'function'
      ? onPendingSaleDetected
      : null;
    this.log = log;
    this.fetcher = fetcher;
    this.browserLauncher = browserLauncher;
    this.isEsliteMonitoringAllowed = isEsliteMonitoringAllowed;
    this.esliteApiSessionFile = String(esliteApiSessionFile || '');
    this.esliteRequestFactory = esliteRequestFactory;
    this.esliteApiOnly = esliteApiOnly === true;
    this.esliteApiContext = null;
    this.esliteApiContextPromise = null;
    this.browser = null;
    this.browserPromise = null;
    this.running = false;
    this.runningTargets = new Set();
    this.notificationTasks = new Set();
    this.momoStockSeeds = new Map();
    this.momoStoreLastDiscoveryAt = new Map();
    this.momoStoreLastLogAt = new Map();
    this.esliteHolmesTemplates = new Map(Object.entries(state.data?.commerce?.shoppingSites?.esliteApiRoutes || {}).filter(([, value]) => {
      try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'holmes.eslite.com' && url.pathname === '/v1/search'; } catch { return false; }
    }));
    this.eslitePurchaseStatusApiTemplate = 'https://athena.eslite.com/api/v4/products/{productId}/purchase_status';
    this.esliteSearchBrowserBlockedUntil = 0;
    this.esliteSearchApiBlockedUntil = 0;
    this.esliteSearchRateLimitCount = 0;
    this.esliteExhibitBlockedUntil = 0;
    this.eslitePageBlockedUntil = 0;
    this.esliteProductBlockedUntil = new Map();
    this.esliteRecentEvents = new Map();
    this.esliteVerificationJobs = new Map();
    this.esliteVerificationQueue = [];
    this.esliteVerificationActive = 0;
    this.esliteVerificationFailures = new Map();
    this.esliteClosed = false;
    this.esliteApiSessionMtimeMs = 0;
    this.esliteLegacyExhibitRetryAt = 0;
    this.esliteDiscoveryJobs = new Map();
    this.esliteLastProductTimeoutSummaryAt = 0;
    this.esliteBlockedRetryMs = Math.max(5_000, Number(esliteBlockedRetryMs) || 30_000);
    this.mmToyPage = null;
    this.mmToyLastDiscoveryAt = 0;
    this.mmToyDiscoveryIntervalMs = Math.max(10_000, Number(mmToyDiscoveryIntervalMs) || 30_000);
    this.momoStoreDiscoveryIntervalMs = Math.max(
      10_000,
      Number(momoStoreDiscoveryIntervalMs) || 30_000
    );
  }

  esliteManualStorage() {
    this.state.data.commerce ||= {};
    this.state.data.commerce.shoppingSites ||= { targets: {} };
    const storage = this.state.data.commerce.shoppingSites;
    storage.targets ||= {};
    storage.esliteManualProducts ||= {};
    return storage.esliteManualProducts;
  }

  esliteManualProducts() {
    return Object.values(this.esliteManualStorage())
      .sort((left, right) => String(right.addedAt || '').localeCompare(String(left.addedAt || '')));
  }

  async addEsliteManualProduct(value, metadata = {}) {
    const url = canonicalEsliteProductUrl(value);
    const id = productIdFromUrl(url);
    const storage = this.esliteManualStorage();
    const previous = storage[id] || {};
    const now = new Date().toISOString();
    storage[id] = {
      ...previous,
      id,
      title: cleanText(metadata.title || previous.title || `誠品商品 ${id}`),
      url,
      imageUrl: cleanText(metadata.imageUrl || previous.imageUrl),
      price: cleanText(metadata.price || previous.price),
      available: metadata.available ?? previous.available ?? null,
      status: cleanText(metadata.status || previous.status),
      variants: Array.isArray(previous.variants) ? previous.variants : [],
      source: previous.source || 'manual',
      addedAt: previous.addedAt || now,
      updatedAt: now,
      lastCheckedAt: previous.lastCheckedAt || '',
      lastError: ''
    };
    await this.state.save();
    return storage[id];
  }

  async deleteEsliteManualProduct(value) {
    const raw = String(value || '').trim();
    let id = /^\d{8,}$/.test(raw) ? raw : '';
    if (!id) id = productIdFromUrl(canonicalEsliteProductUrl(raw));
    const storage = this.esliteManualStorage();
    const existing = storage[id];
    if (!existing) throw new Error(`誠品單品資料庫中找不到商品 ${id}`);
    delete storage[id];
    await this.state.save();
    return existing;
  }

  emitPurchaseCandidate(candidate) {
    if (!this.onPurchaseCandidate) return false;
    try {
      const task = this.onPurchaseCandidate(candidate);
      Promise.resolve(task).catch((error) => {
        this.log(`即時購買交接失敗：${error.message}`);
      });
      return true;
    } catch (error) {
      this.log(`即時購買交接失敗：${error.message}`);
      return false;
    }
  }

  notifyInBackground(text, options) {
    let notification;
    try {
      notification = this.notify(text, options);
    } catch (error) {
      notification = Promise.reject(error);
    }
    const task = Promise.resolve(notification);
    this.notificationTasks.add(task);
    task.then(
      () => this.notificationTasks.delete(task),
      (error) => {
        this.notificationTasks.delete(task);
        this.log(`背景通知失敗：${error.message}`);
      }
    );
    return task;
  }

  queueEsliteVerification(target, product, source, onVerified = () => {}) {
    const key = `${target.id}:${product.id}`;
    if (this.esliteClosed) return Promise.resolve(null);
    if (this.esliteVerificationJobs.has(key)) return this.esliteVerificationJobs.get(key);
    let resolve;
    const task = new Promise((done) => { resolve = done; });
    this.esliteVerificationJobs.set(key, task);
    this.esliteVerificationQueue.push({ key, target, product, source, resolve, onVerified });
    this._drainEsliteVerification();
    return task;
  }

  _drainEsliteVerification() {
    // Keep overload probes out of the discovery lanes; four concurrent reads,
    // not an unbounded burst of 23 requests against a busy server.
    while (!this.esliteClosed && this.esliteVerificationActive < 4 && this.esliteVerificationQueue.length) {
      const job = this.esliteVerificationQueue.shift();
      this.esliteVerificationActive += 1;
      void (async () => {
        try {
          const result = await this.verifyEsliteProduct(job.product);
          const currentTarget = this.getTargets().find((item) => String(item.id) === String(job.target.id));
          if (this.esliteClosed || job.target.enabled === false || currentTarget?.enabled === false || !this.isEsliteMonitoringAllowed(job.target)) return;
          const verified = result !== job.product && ['eslite-product-page', 'eslite-purchase-status'].includes(result?.availabilitySource);
          if (!verified) return;
          const confirmed = { ...result, verificationPending: false };
          job.onVerified(confirmed);
          this.applyImmediateEsliteObservations(job.target, [confirmed], {
            source: `${job.source}->purchase-status`, authoritative: true
          });
          job.resolve(confirmed);
        } catch (error) {
          this.log(`誠品單品背景確認失敗｜${job.product.id}｜${safeDiagnosticMessage(error)}`);
        } finally {
          job.resolve(null);
          this.esliteVerificationJobs.delete(job.key);
          this.esliteVerificationActive -= 1;
          this._drainEsliteVerification();
        }
      })();
    }
  }

  _backoffEsliteProduct(id) {
    const failures = Math.min(4, (this.esliteVerificationFailures.get(id) || 0) + 1);
    this.esliteVerificationFailures.set(id, failures);
    this.esliteProductBlockedUntil.set(id, Date.now() + Math.min(5000, 1000 * 2 ** (failures - 1)));
    // Evict old identities to keep long-running monitoring bounded.
    if (this.esliteVerificationFailures.size > 500) {
      for (const key of this.esliteVerificationFailures.keys()) {
        if (Number(this.esliteProductBlockedUntil.get(key) || 0) < Date.now() - 120000) {
          this.esliteVerificationFailures.delete(key);
          this.esliteProductBlockedUntil.delete(key);
        }
      }
    }
  }

  claimEsliteEvent(targetId, productId, event, now = Date.now()) {
    const key = `${targetId}:${productId}:${event}`;
    const previous = Number(this.esliteRecentEvents.get(key)) || 0;
    if (now - previous < 30_000) return false;
    this.esliteRecentEvents.set(key, now);
    if (this.esliteRecentEvents.size > 500) {
      for (const [storedKey, timestamp] of this.esliteRecentEvents) {
        if (now - timestamp > 10 * 60_000) this.esliteRecentEvents.delete(storedKey);
      }
    }
    return true;
  }

  applyImmediateEsliteObservations(target, items, {
    source = 'unknown',
    authoritative = false
  } = {}) {
    if (!Array.isArray(items) || !items.length) return { observed: 0, dispatched: 0 };
    this.state.data.commerce ||= {};
    this.state.data.commerce.shoppingSites ||= { targets: {} };
    const storage = this.state.data.commerce.shoppingSites;
    storage.targets ||= {};
    const saved = storage.targets[target.id] ||= { initialized: false, seen: {} };
    saved.seen ||= {};
    const observedAt = new Date().toISOString();
    let observedCount = 0;
    let dispatched = 0;

    for (const item of items) {
      if (!item?.id || !/eslite\.com\/product\//i.test(item.url || '')) continue;
      if (shoppingProductExcludeMatch(item, this.getExcludeKeywords())) continue;
      const id = String(item.id);
      const previous = saved.seen[id];
      const previousSellable = previous?.available === true
        || (previous?.variants || []).some((variant) => variant.available === true);
      const observedSellable = item.available === true
        || (item.variants || []).some((variant) => variant.available === true);
      const preservePositive = previousSellable && !observedSellable && !authoritative;
      const merged = {
        ...previous,
        ...item,
        title: item.title || previous?.title,
        imageUrl: item.imageUrl || previous?.imageUrl,
        price: item.price || previous?.price,
        available: preservePositive ? true : item.available ?? previous?.available ?? null,
        variants: preservePositive
          ? previous?.variants || item.variants || []
          : item.variants?.length ? item.variants : previous?.variants || [],
        firstSeenAt: previous?.firstSeenAt || observedAt,
        lastSeenAt: observedAt,
        lastObservationSource: source,
        lastObservationAt: observedAt
      };
      saved.seen[id] = merged;
      if (!previous || previousSellable !== observedSellable) {
        this.log(`誠品商品觀測｜${id}｜${item.title}｜來源 ${source}｜${observedSellable ? '可購' : '尚未確認可購'}｜${observedAt}`);
      }
      observedCount += 1;

      if (!saved.initialized) continue;
      // Never refresh purchase freshness from merged historical baselines.
      // Steady sellable products still update tasks, without another notice.
      if (item.verificationPending !== true && (authoritative && typeof item.available === 'boolean'
        || isEsliteSourceBuySignal(item))) {
        const freshVariant = (item.variants || []).find(variant => variant.available === true);
        try {
          Promise.resolve(this.onEslitePurchaseObservation?.({ ...item,
            stock: freshVariant?.stock ?? item.stock ?? null,
            variantId: freshVariant?.id || item.variantId || null,
            freshObservationAt: observedAt, detectionSource: source })).catch(error => this.log(`誠品購買觀測交接失敗：${error.message}`));
        } catch (error) { this.log(`誠品購買觀測交接失敗：${error.message}`); }
      }
      const stockVariant = (item.variants || []).find(variant => variant.available === true
        && variant.stock != null && variant.stock !== '' && Number.isFinite(Number(variant.stock)))
        || (item.variants || []).find(variant => variant.stock != null && variant.stock !== '' && Number.isFinite(Number(variant.stock)));
      if (!previous) {
        if (!this.claimEsliteEvent(target.id, id, 'new')) continue;
        if (observedSellable) {
          const candidate = {
            ...merged,
            stock: stockVariant?.stock ?? item.stock ?? null,
            variantId: stockVariant?.id || null,
            variantName: stockVariant?.name || '',
            reason: 'new_product',
            siteName: target.siteName || shoppingSiteName(target.url),
            targetId: target.id,
            targetName: target.name,
            detectionSource: source,
            freshObservationAt: observedAt
          };
          this.emitPurchaseCandidate(candidate);
          const noticeStartedAt = Date.now();
          this.notifyInBackground(
            `購物網站：${candidate.siteName}\n監控專區：${target.name}\n發現可購買的戰鬥陀螺新品：${merged.title}${stockVariant ? `｜前台可售 ${stockVariant.stock} 組` : ''}\n${merged.url}`,
            { discordPreview: notificationPreview(target, merged, stockVariant), embeds: [notificationEmbed(target, merged, stockVariant)], discordAudience: 'public' }
          ).then((messageId) => this.log(`誠品商品推播送達｜${id}｜${Date.now() - noticeStartedAt}ms｜${messageId || 'ok'}`), () => {});
        } else {
          const event = /verification_pending/i.test(merged.status || '') ? 'verification-pending'
            : /coming_soon/i.test(merged.status || '') ? 'coming-soon' : 'listed-unavailable';
          this.notifyInBackground(
            `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n誠品出現新的戰鬥陀螺商品：${merged.title}\n${event === 'verification-pending' ? '可購狀態待確認，尚未觸發購買。' : '目前尚未開放購買；已持續直查商品狀態。'}\n${merged.url}`,
            { discordPreview: notificationPreview(target, merged, null, event), embeds: [notificationEmbed(target, merged, null, event)], discordAudience: 'public' }
          );
        }
        dispatched += 1;
      } else if (!previousSellable && observedSellable && this.claimEsliteEvent(target.id, id, 'available')) {
        const candidate = {
          ...merged,
          stock: stockVariant?.stock ?? item.stock ?? null,
          variantId: stockVariant?.id || null,
          variantName: stockVariant?.name || '',
          reason: 'restock',
          siteName: target.siteName || shoppingSiteName(target.url),
          targetId: target.id,
          targetName: target.name,
          detectionSource: source,
          freshObservationAt: observedAt
        };
        this.emitPurchaseCandidate(candidate);
        const noticeStartedAt = Date.now();
        this.notifyInBackground(
          `購物網站：${candidate.siteName}\n監控專區：${target.name}\n商品恢復可購買：${merged.title}${stockVariant ? `｜前台可售 ${stockVariant.stock} 組` : ''}\n${merged.url}`,
          { discordPreview: notificationPreview(target, merged, stockVariant, 'restock'), embeds: [notificationEmbed(target, merged, stockVariant, 'restock')], discordAudience: 'public' }
        ).then((messageId) => this.log(`誠品商品推播送達｜${id}｜${Date.now() - noticeStartedAt}ms｜${messageId || 'ok'}`), () => {});
        dispatched += 1;
      }
    }

    if (observedCount) {
      saved.lastImmediateObservationAt = observedAt;
      saved.lastImmediateObservationSource = source;
      void this.state.save().catch((error) => this.log(`誠品即時狀態保存失敗：${error.message}`));
    }
    return { observed: observedCount, dispatched };
  }

  async applyImmediateEsliteDiscoveryPage(target, page) {
    const key = String(page?.url || '').trim();
    if (!key) return { notified: false };
    this.state.data.commerce ||= {};
    this.state.data.commerce.shoppingSites ||= { targets: {} };
    const storage = this.state.data.commerce.shoppingSites;
    storage.targets ||= {};
    const saved = storage.targets[target.id] ||= { initialized: false, seen: {} };
    saved.discoveryPages ||= {};
    const previousPage = saved.discoveryPages[key];
    const observedAt = new Date().toISOString();

    if (page.isLive === false) {
      saved.discoveryPages[key] = {
        ...previousPage,
        ...page,
        isLive: false,
        alertPolicyVersion: 2,
        lastUnavailableAt: observedAt
      };
      await this.state.save().catch((error) => this.log(`誠品策展狀態保存失敗：${safeDiagnosticMessage(error)}`));
      return { notified: false };
    }

    try {
      this.onEsliteDiscoveryActivity?.({ target, page, observedAt });
    } catch (error) {
      this.log(`誠品策展預熱交接失敗：${safeDiagnosticMessage(error)}`);
    }

    const detectedAt = previousPage?.firstSeenAt || observedAt;
    const legacyPolicyUpgrade = previousPage
      && Number(previousPage.alertPolicyVersion) !== 2
      && previousPage.notifiedAt;
    const shouldNotify = !previousPage?.notifiedAt
      || previousPage?.isLive === false
      || legacyPolicyUpgrade;
    let notifiedAt = previousPage?.notifiedAt || '';
    let messageId = '';
    if (shouldNotify) {
      const notification = esliteExhibitionNotification(target, page, { detectedAt: observedAt });
      try {
        messageId = await this.notify(notification.text, notification.options);
        notifiedAt = observedAt;
        this.log(`${target.name}：誠品策展頁準備補貨重點預警已即時送達｜Discord 訊息 ID ${messageId || 'ok'}｜${key}`);
      } catch (error) {
        this.log(`${target.name}：誠品策展頁重點預警傳送失敗，下輪會重試｜${safeDiagnosticMessage(error)}`);
      }
    }

    saved.discoveryPages[key] = {
      ...previousPage,
      ...page,
      isLive: true,
      alertPolicyVersion: 2,
      firstSeenAt: detectedAt,
      lastSeenAt: observedAt,
      notifiedAt
    };
    await this.state.save().catch((error) => this.log(`誠品策展狀態保存失敗：${safeDiagnosticMessage(error)}`));
    return { notified: Boolean(shouldNotify && notifiedAt === observedAt), messageId };
  }

  async ensureBrowser() {
    if (this.browser && typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
      this.browser = null;
    }
    if (this.browser) return this.browser;
    // Multiple independent targets can arrive on the same tick. Share only the
    // launch promise, not their pages, sessions, results or scan schedules.
    if (!this.browserPromise) {
      this.browserPromise = Promise.resolve().then(() => this.browserLauncher({ headless: true }))
        .then((browser) => { this.browser = browser; return browser; })
        .finally(() => { this.browserPromise = null; });
    }
    return this.browserPromise;
  }

  async newPage(options = {}) {
    let browser = await this.ensureBrowser();
    const prepare = async (page) => {
      if (typeof page.route === 'function') {
        await page.route('**/*', monitoringRoute());
      }
      return page;
    };
    try {
      return await prepare(await browser.newPage(options));
    } catch (error) {
      if (!/Target page, context or browser has been closed/i.test(error.message)) throw error;
      await browser.close().catch(() => {});
      this.browser = null;
      browser = await this.ensureBrowser();
      return prepare(await browser.newPage(options));
    }
  }

  async ensureMmToyPage() {
    if (this.mmToyPage && !this.mmToyPage.isClosed()) return this.mmToyPage;
    this.mmToyPage = await this.newPage({
      locale: 'zh-TW',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    });
    await this.mmToyPage.goto('https://mmtoyshop.com/category?keyword=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA', {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });
    return this.mmToyPage;
  }

  async fetchMmToyQuery(page, endpoint, pageNumber, limit = 100) {
    return page.evaluate(async ({ endpoint, pageNumber, limit }) => {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set('page', String(pageNumber));
      // BVSHOP defaults to 24 products per page. Its API accepts `limit=100`,
      // allowing the current 64-product MM catalogue to be read with one
      // request instead of three. This is essential when the target enters the
      // 3-second hot path: lower request volume means fewer 429 blind spots.
      url.searchParams.set('limit', String(limit));
      const response = await fetch(url.href, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`MM小舖商品 API HTTP ${response.status}`);
      return response.json();
    }, { endpoint, pageNumber, limit });
  }

  async fetchAllMmToyQueryPages(page, endpoint) {
    const first = await this.fetchMmToyQuery(page, endpoint, 1, 100);
    const lastPage = Math.min(10, Math.max(1, Number(first?.lastPage) || 1));
    const remaining = await Promise.all(
      Array.from({ length: lastPage - 1 }, (_, index) => (
        this.fetchMmToyQuery(page, endpoint, index + 2, 100)
      ))
    );
    return [first, ...remaining];
  }

  async fetchMomoRecommendations(goodsCode, goodsSortedCode) {
    const response = await this.fetcher('https://www.momoshop.com.tw/api/moecapp/getRecommendGoods', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        device: '4',
        pf: '1'
      },
      body: JSON.stringify({
        host: 'ecmobile',
        data: {
          categoryCode: '',
          ccguid: '',
          ccsession: '',
          curGoodsInfoListSize: 0,
          curPage: 1,
          custNo: '',
          goodsCode,
          goodsSortedCode,
          imgType: 'webp',
          pageType: '1',
          recommendType: '8'
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`momo recommendation API ${response.status}`);
    const data = await response.json();
    if (!data?.success || String(data?.resultCode) !== '200') {
      throw new Error(data?.resultMessage || 'momo recommendation API failed');
    }
    return data?.rtnData?.goodsInfoList || [];
  }

  async fetchMomoSearchStock(product, goodsCode) {
    const keyword = cleanText(product.title).match(/\b(?:BXG|BX|UX|CX)-\d{2}\b/i)?.[0];
    const queries = [...new Set([goodsCode, keyword?.toUpperCase()].filter(Boolean))];
    for (const query of queries) {
      const response = await this.fetcher(
        `https://www.momoshop.com.tw/search/${encodeURIComponent(query)}`,
        {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-TW,zh;q=0.9',
          'Cache-Control': 'no-cache',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
        },
        signal: AbortSignal.timeout(15000)
        }
      );
      if (!response.ok) continue;
      const html = (await response.text()).replace(/\\"/g, '"');
      const marker = `"goodsCode":"${goodsCode}"`;
      let offset = 0;
      while ((offset = html.indexOf(marker, offset)) !== -1) {
        const item = html.slice(offset, offset + 5000);
        const stock = Number(item.match(/"goodsStock":"(\d+)"/)?.[1]);
        if (Number.isFinite(stock)) {
          return {
            stock,
            title: cleanText(item.match(/"goodsName":"([^"]+)"/)?.[1]) || product.title,
            imageUrl: product.imageUrl,
            price: product.price,
            source: 'momo-search-goodsStock'
          };
        }
        offset += marker.length;
      }
    }
    return null;
  }

  async fetchMomoActualStock(product, html) {
    const goodsCode = productIdFromUrl(product.url);
    const goodsSortedCode = momoGoodsSortedCode(html);
    if (!/^\d+$/.test(goodsCode)) return null;

    const findTarget = (items) => items.find((item) => String(item?.goodsCode) === goodsCode);
    const readTarget = (item, seedGoodsCode) => {
      const stock = Number(item?.goodsStock);
      if (!Number.isFinite(stock)) return null;
      this.momoStockSeeds.set(goodsCode, { seedGoodsCode, goodsSortedCode });
      return {
        stock,
        title: cleanText(item.goodsName) || product.title,
        imageUrl: absoluteUrl(item.imgUrl, product.url) || product.imageUrl,
        price: cleanText(item.goodsPrice) || product.price,
        source: 'momo-recommendation-goodsStock'
      };
    };

    const cached = this.momoStockSeeds.get(goodsCode);
    if (cached) {
      const cachedItems = await this.fetchMomoRecommendations(cached.seedGoodsCode, cached.goodsSortedCode || goodsSortedCode);
      const cachedTarget = findTarget(cachedItems);
      if (cachedTarget) return readTarget(cachedTarget, cached.seedGoodsCode);
      this.momoStockSeeds.delete(goodsCode);
    }

    const relatedItems = await this.fetchMomoRecommendations(goodsCode, goodsSortedCode);
    const directTarget = findTarget(relatedItems);
    if (directTarget) return readTarget(directTarget, goodsCode);

    const candidates = relatedItems
      .filter((item) => /^\d+$/.test(String(item?.goodsCode || '')))
      .filter((item) => PRODUCT_WORDS.test(cleanText(item?.goodsName)))
      .slice(0, 6);
    for (const candidate of candidates) {
      const seedGoodsCode = String(candidate.goodsCode);
      const items = await this.fetchMomoRecommendations(seedGoodsCode, goodsSortedCode);
      const target = findTarget(items);
      if (target) return readTarget(target, seedGoodsCode);
    }
    return this.fetchMomoSearchStock(product, goodsCode);
  }

  async loadMomoStoreProducts(target) {
    const endpoint = 'https://3pf.momo.com.tw/shop/app/category/goods/query/v1';
    const products = new Map();
    let maxPage = 1;
    for (let page = 1; page <= Math.min(maxPage, 10); page += 1) {
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-TW,zh;q=0.9',
          'Content-Type': 'application/json;charset=UTF-8',
          Origin: 'https://www.momoshop.com.tw',
          Referer: 'https://www.momoshop.com.tw/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36'
        },
        body: JSON.stringify(momoStoreGoodsRequest(target.url, page)),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`momo 店＋商品 API 回傳 ${response.status}`);
      const data = await response.json();
      if (data?.success !== true || String(data?.resultCode || '') !== '200') {
        throw new Error(data?.resultMessage || 'momo 店＋商品 API 回傳失敗');
      }
      for (const product of parseMomoStoreGoodsData(data, target.url)) products.set(product.id, product);
      const returnedMaxPage = Number(data?.maxPage);
      maxPage = Number.isFinite(returnedMaxPage) && returnedMaxPage > 0 ? returnedMaxPage : 1;
    }
    return [...products.values()];
  }

  logMomoStoreThrottled(key, message, intervalMs = 60_000) {
    const now = Date.now();
    const previous = Number(this.momoStoreLastLogAt.get(key)) || 0;
    if (now - previous < intervalMs) return;
    this.momoStoreLastLogAt.set(key, now);
    this.log(message);
  }

  async fetchMomoStoreProductDetail(product) {
    const endpoint = 'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1';
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Content-Type': 'application/json;charset=UTF-8',
        Origin: 'https://www.momoshop.com.tw',
        Referer: product.url,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36'
      },
      body: JSON.stringify(momoStoreDetailRequest(product.url)),
      signal: AbortSignal.timeout(4_000)
    });
    if (!response.ok) throw new Error(`momo 店＋詳細 API 回傳 ${response.status}`);
    const data = await response.json();
    const parsed = parseMomoStoreDetailData(data, product.url, product);
    if (!parsed) throw new Error(data?.resultMessage || 'momo 店＋詳細 API 沒有可用商品資料');
    return parsed;
  }

  async loadMomoStoreDirectProducts(target, previousTarget) {
    const knownProducts = Object.values(previousTarget?.seen || {})
      .filter((product) => isMomoStoreProductUrl(product?.url));
    const productsById = new Map(knownProducts.map((product) => [String(product.id), product]));
    const discoveryIntervalMs = Math.max(
      10_000,
      Number(target.discoveryIntervalSeconds) * 1000 || this.momoStoreDiscoveryIntervalMs
    );
    const lastDiscoveryAt = Number(this.momoStoreLastDiscoveryAt.get(String(target.id))) || 0;
    const discoveryDue = !previousTarget?.initialized || Date.now() - lastDiscoveryAt >= discoveryIntervalMs;
    let discoverySucceeded = false;

    if (discoveryDue) {
      try {
        const discovered = await this.loadMomoStoreProducts(target);
        for (const product of discovered) productsById.set(String(product.id), {
          ...productsById.get(String(product.id)),
          ...product
        });
        this.momoStoreLastDiscoveryAt.set(String(target.id), Date.now());
        discoverySucceeded = true;
      } catch (error) {
        if (!productsById.size) throw error;
        this.logMomoStoreThrottled(
          `discovery:${target.id}`,
          `${target.name}：momo 店＋新品清單暫時失敗，已知商品專線仍持續直查：${error.message}`
        );
      }
    }

    const candidates = [...productsById.values()];
    if (!candidates.length) return [];
    const settled = await Promise.allSettled(
      candidates.map((product) => this.fetchMomoStoreProductDetail(product))
    );
    const products = [];
    let directSuccesses = 0;
    settled.forEach((result, index) => {
      const product = candidates[index];
      if (result.status === 'fulfilled') {
        directSuccesses += 1;
        products.push(result.value);
        return;
      }
      const previous = previousTarget?.seen?.[product.id];
      this.logMomoStoreThrottled(
        `detail:${product.id}`,
        `${target.name}｜${product.title || product.id}：momo 詳細 API 暫時無法讀取，保留既有庫存基線：${result.reason?.message || result.reason}`
      );
      // A transient API error must not become a false sold-out/restock event.
      // Existing products keep their exact last baseline; newly discovered
      // products wait for a healthy detail response before entering the DB.
      if (previous) products.push({ ...previous, directCheckError: true });
    });

    if (!directSuccesses && !discoverySucceeded) {
      throw new Error('momo 店＋所有已知商品詳細 API 均暫時無法讀取');
    }
    products.sourceMode = discoveryDue ? 'momo-store-direct-with-discovery' : 'momo-store-direct';
    products.discoveryPerformed = discoverySucceeded;
    products.directSuccesses = directSuccesses;
    return products;
  }

  async resolveMomoStoreVariants(products, previousTarget) {
    return Promise.all(products.map(async (product) => {
      const previous = previousTarget?.seen?.[product.id];
      const previousVariants = detailedMomoVariants(previous);
      if (!isLikelyMomoMultiVariant(product, previous)) return product;

      const listingSignalChanged = momoStoreListingSignalChanged(product, previous, previousTarget);

      // The store listing API exposes only the total stock for a product page.
      // A product can disappear and reappear while the aggregate stock still
      // says zero. That reappearance is a useful inventory signal: verify its
      // exact variants once instead of blindly copying zero to every variant.
      if (product.available === false && previousVariants.length && !listingSignalChanged) {
        return {
          ...product,
          variants: previousVariants.map((variant) => ({
            ...variant,
            stock: 0,
            available: false,
            stockSource: 'momo-store-category-api'
          }))
        };
      }

      try {
        if (product.available === false && listingSignalChanged) {
          this.log(`${product.title}：momo 分類 API 出現變化，即使總庫存為 0 仍複查各規格。`);
        }
        const detail = await this.inspectProduct(product.url, { includeStock: false });
        const variants = detailedMomoVariants(detail);
        if (detail && variants.length) {
          return {
            ...product,
            title: detail.title || product.title,
            imageUrl: detail.imageUrl || product.imageUrl,
            variants,
            available: variants.some((variant) => variant.available),
            stockSource: 'momo-product-variant-data'
          };
        }
        throw new Error('商品頁沒有回傳可辨識的款式資料');
      } catch (error) {
        this.log(`${product.title}：momo 款式明細暫時無法取得，保留總庫存但延後推播：${error.message}`);
        // Never turn an aggregate total into a named restock. Keep the last
        // exact baseline when available; otherwise wait for a later detail read.
        return {
          ...product,
          variants: previousVariants,
          variantDetailPending: true
        };
      }
    }));
  }

  async loadHtml(url) {
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      },
      signal: AbortSignal.timeout(20000)
    });
    const body = await response.text();
    const dynamicMomoStore = /momoshop\.com\.tw\/TP\/[^/]+\/main/i.test(url)
      && !/\/goodsDetail\//i.test(body);
    const dynamicMomoListing = isMomoListingUrl(url)
      && parseShoppingPage(body, url).length === 0;
    const dynamicEslitePage = /eslite\.com\/exhibitions\//i.test(url);
    const dynamicKingstoneSearch = /shop\.tcsb\.com\.tw\/v2\/Search/i.test(url)
      && !/\/SalePage\/Index\//i.test(body);
    if (response.ok && body.length > 100 && !BLOCKED_PAGE_WORDS.test(body)
      && !dynamicMomoStore && !dynamicMomoListing && !dynamicEslitePage && !dynamicKingstoneSearch) return body;
    const page = await this.newPage({
      locale: 'zh-TW',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if (/momoshop\.com\.tw\/TP\/[^/]+\/main/i.test(url)) {
        await page.waitForSelector('a[href*="/goodsDetail/"]', { timeout: 8000 }).catch(() => {});
      } else if (isMomoListingUrl(url)) {
        const productsLoaded = await page.waitForSelector('a[href*="/product/"], a[href*="/goods/GoodsDetail.jsp"]', { timeout: 12000 }).catch(() => null);
        if (!productsLoaded) throw new Error('momo 官方分類商品尚未完整載入，已保留上次基線');
      } else if (/shop\.tcsb\.com\.tw\/v2\/Search/i.test(url)) {
        const productsLoaded = await page.waitForSelector('a[href*="/SalePage/Index/"]', { timeout: 12000 }).catch(() => null);
        if (!productsLoaded) throw new Error('墊腳石搜尋商品尚未完整載入，已保留上次基線');
      } else if (/eslite\.com/i.test(url)) {
        const productLinkLoaded = await page.waitForSelector('a[href*="/product/"]', { timeout: 15000 }).catch(() => null);
        const productStatusLoaded = await page.waitForSelector('.exhibit-card button, .product-in-article button, button[class*="cart"]', { timeout: 15000 }).catch(() => null);
        if (!productLinkLoaded || !productStatusLoaded) {
          throw new Error('誠品商品狀態尚未完整載入，已保留上次基線');
        }
      } else {
        await page.waitForTimeout(1800);
      }
      const content = await page.content();
      if (BLOCKED_PAGE_WORDS.test(content)) throw new Error('購物網站阻擋本次讀取，已保留上次基線');
      return content;
    } finally {
      await page.close();
    }
  }

  async loadEsliteExhibitProducts(url) {
    if (this.esliteApiOnly) return this.loadEsliteExhibitProductsApi(url);
    if (Date.now() < this.esliteExhibitBlockedUntil) {
      throw new Error('誠品官方活動頁暫時無法讀取，搜尋與單品仍持續監控中');
    }
    const code = esliteExhibitionCode(url);
    if (!code) throw new Error('誠品策展代碼無法辨識');
    const apiUrl = `https://athena.eslite.com/api/v1/book_exhibits/${encodeURIComponent(code)}`;
    // Try the official endpoint directly. A retired endpoint must not cause a
    // six-second wait for a browser response on every scan.
    if (Date.now() >= this.esliteLegacyExhibitRetryAt) {
      try {
        const response = await this.fetcher(apiUrl, { signal: AbortSignal.timeout(1800), headers: { Accept: 'application/json' } });
        if (response.ok) {
          const products = parseEsliteExhibitData(await response.json(), url);
          if (products.length) {
            products.discoveryPage = { url, title: 'BEYBLADE X 戰鬥陀螺策展', productCount: products.length, isLive: true };
            return products;
          }
        } else if ([404, 405, 410].includes(response.status)) {
          this.esliteLegacyExhibitRetryAt = Date.now() + 5 * 60_000;
        }
      } catch { /* Discovery remains available through the ordinary page. */ }
    }
    const page = await this.newPage({
      locale: 'zh-TW',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    });
    try {
      const pageFallback = async (reason) => {
        // The legacy book_exhibits request now commonly returns 404 before the
        // Vue exhibition component has finished rendering. Give the current
        // page a short, bounded chance to expose its rendered content first.
        if (typeof page.waitForSelector === 'function') {
          await page.waitForSelector(
            'a[href*="/product/"]:has-text("BEYBLADE"), a[href*="/product/"]:has-text("戰鬥陀螺")',
            { timeout: 3500 }
          ).catch(() => {});
        }
        const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
        const content = typeof page.content === 'function' ? await page.content().catch(() => '') : '';
        const currentUrl = typeof page.url === 'function' ? page.url() : url;
        if (BLOCKED_PAGE_WORDS.test(`${title} ${content}`)) {
          throw new Error('誠品完整頁面受 Cloudflare 阻擋，搜尋與單品仍持續監控中');
        }
        const missingPage = /\/error\/404(?:[/?#]|$)/i.test(currentUrl)
          || /(?:^|\s)404(?:\s|$)|頁面不存在/i.test(title)
          || /(?:404\s*頁面不存在|找不到您要的頁面)/i.test(content);
        if (missingPage) {
          const products = [];
          products.discoveryPage = {
            url,
            title: 'BEYBLADE X 戰鬥陀螺策展',
            productCount: 0,
            imageUrl: '',
            isLive: false,
            unavailableReason: 'page_not_found'
          };
          this.log('誠品策展頁目前未上架（404）；已記錄關閉狀態，重新開啟時會再次重點通知。');
          return products;
        }
        const products = parseShoppingPage(content, url);
        const cleanTitle = cleanText(title).replace(/\s*[｜|]\s*誠品線上.*$/i, '');
        const liveExhibition = /(?:BEYBLADE\s*X|戰鬥陀螺|精選策展)/i.test(`${cleanTitle} ${content}`)
          && !/\/error\/404(?:[/?#]|$)/i.test(currentUrl);
        if (!products.length && !liveExhibition) {
          throw new Error(`${reason}，且策展頁本身沒有可辨識商品，搜尋與單品仍持續監控中`);
        }
        products.discoveryPage = {
          url,
          title: cleanTitle || 'BEYBLADE X 戰鬥陀螺策展',
          productCount: products.length,
          imageUrl: products.find((product) => product.imageUrl)?.imageUrl || '',
          isLive: true
        };
        this.log(`誠品策展舊 API 無法使用，已確認策展頁開啟並讀取 ${products.length} 件商品。`);
        return products;
      };
      const apiResponsePromise = Date.now() < this.esliteLegacyExhibitRetryAt
        ? Promise.resolve({ waitError: new Error('舊策展 API 已停用') })
        : page.waitForResponse(
        (response) => response.url() === apiUrl,
        // 誠品會在活動前後反覆上、下架策展入口。API 若仍有效通常會在
        // 首屏數秒內回來；縮短失效入口的等待，避免拖慢其他搜尋來源。
        { timeout: 1800 }
      ).catch((error) => ({ waitError: error }));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
      const apiResponse = await apiResponsePromise;
      if (apiResponse?.waitError) {
        const products = await pageFallback('誠品官方活動 API 未回應');
        this.esliteExhibitBlockedUntil = 0;
        return products;
      }
      if (typeof apiResponse.status === 'function' && apiResponse.status() !== 200) {
        const products = await pageFallback(`誠品官方活動 API 回傳 HTTP ${apiResponse.status()}`);
        this.esliteExhibitBlockedUntil = 0;
        return products;
      }
      const products = parseEsliteExhibitData(await apiResponse.json(), url);
      if (!products.length) {
        const fallbackProducts = await pageFallback('誠品官方策展 API 本次沒有回傳戰鬥陀螺商品');
        this.esliteExhibitBlockedUntil = 0;
        return fallbackProducts;
      }
      products.discoveryPage = {
        url,
        title: cleanText(typeof page.title === 'function' ? await page.title().catch(() => '') : '')
          .replace(/\s*[｜|]\s*誠品線上.*$/i, '') || 'BEYBLADE X 戰鬥陀螺策展',
        productCount: products.length,
        imageUrl: products.find((product) => product.imageUrl)?.imageUrl || '',
        isLive: true
      };
      this.esliteExhibitBlockedUntil = 0;
      return products;
    } catch (error) {
      this.esliteExhibitBlockedUntil = Date.now() + Math.max(60_000, this.esliteBlockedRetryMs);
      throw error;
    } finally {
      await page.close();
    }
  }

  eslitePurchaseStatusUrl(productId) {
    return this.eslitePurchaseStatusApiTemplate.replace('{productId}', encodeURIComponent(productId));
  }

  async loadEsliteExhibitProductsApi(url) {
    const code = esliteExhibitionCode(url);
    if (!code) throw new Error('誠品策展代碼無法辨識');
    const response = await this.requestEslitePublicApi(`https://athena.eslite.com/api/v1/book_exhibits/${encodeURIComponent(code)}`, url, 2500);
    const status = response.status;
    let body;
    try { body = await response.json(); } finally { await response.dispose?.(); }
    // Confirm the official missing-exhibition contract, not just any HTTP 404.
    const missing = status === 404 && body?.code === '404' && body?.message === 'Book Exhibit Not Found';
    if (missing) return Object.assign([], { discoveryPage: {
      url, title: 'BEYBLADE X 戰鬥陀螺策展', productCount: 0, isLive: false,
      unavailableReason: 'page_not_found', source: 'eslite-exhibition-api'
    } });
    if (!response.ok) throw new Error(`誠品策展 API HTTP ${status}；保留基線，不啟動瀏覽器`);
    if (!body || typeof body.name !== 'string' || !Array.isArray(body.contents)) {
      throw new Error('誠品策展 API 格式變更，不能判定已開放；不啟動瀏覽器');
    }
    const products = parseEsliteExhibitData(body, url);
    products.discoveryPage = { url, title: body.name, productCount: products.length,
      isLive: products.length > 0, unavailableReason: products.length ? '' : 'no_products', source: 'eslite-exhibition-api' };
    return products;
  }

  async requestEslitePublicApi(apiUrl, referer, timeoutMs = 2500) {
    const isSearch = new URL(apiUrl).hostname === 'holmes.eslite.com';
    if (isSearch && Date.now() < this.esliteSearchApiBlockedUntil) return { ok: false, status: 429, dispose: async () => {} };
    const observe = (response, headers) => {
      if (isSearch && response.status === 429) {
        const value = headers?.['retry-after'] || headers?.get?.('retry-after');
        const seconds = Number(value);
        const retryMs = value ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()) : 0;
        this.esliteSearchRateLimitCount = Math.min(5, this.esliteSearchRateLimitCount + 1);
        const waitMs = Math.max(15000, Math.min(15 * 60000, retryMs || 15000 * 2 ** (this.esliteSearchRateLimitCount - 1)));
        this.esliteSearchApiBlockedUntil = Date.now() + waitMs;
        this.log(`誠品搜尋暫時限流｜等待 ${Math.ceil(waitMs / 1000)} 秒再查；策展監控不受影響`);
      } else if (isSearch && response.ok) this.esliteSearchRateLimitCount = 0;
      return response;
    };
    const api = await this.ensureEsliteApiContext();
    if (api) {
      const response = await api.get(apiUrl, { headers: { authorization: '', referer }, timeout: timeoutMs });
      return observe({ ok: response.ok(), status: response.status(), json: () => readAndReleaseResponse(response, 'json'), dispose: () => releaseResponse(response) }, response.headers?.());
    }
    const response = await this.fetcher(apiUrl, { headers: { Accept: 'application/json', Origin: 'https://www.eslite.com', Referer: referer }, signal: AbortSignal.timeout(timeoutMs) });
    return observe(response, response.headers);
  }

  async resetEsliteApiContext() {
    await this.esliteApiContextPromise?.catch(() => {});
    await this.esliteApiContext?.dispose?.().catch(() => {});
    this.esliteApiContext = null;
    this.esliteApiContextPromise = null;
  }

  async ensureEsliteApiContext() {
    if (this.esliteApiSessionFile) {
      const mtime = await fs.stat(this.esliteApiSessionFile).then((stat) => stat.mtimeMs).catch(() => 0);
      if (this.esliteApiContext && mtime !== this.esliteApiSessionMtimeMs) await this.resetEsliteApiContext();
      this.esliteApiSessionMtimeMs = mtime;
    }
    if (this.esliteApiContext) return this.esliteApiContext;
    if (!this.esliteApiSessionFile || !this.esliteRequestFactory?.newContext) return null;
    if (!this.esliteApiContextPromise) {
      this.esliteApiContextPromise = (async () => {
        let storageState;
        try {
          storageState = JSON.parse(await fs.readFile(this.esliteApiSessionFile, 'utf8'));
        } catch {
          return null;
        }
        const localStorage = storageState?.origins
          ?.find((entry) => entry.origin === 'https://www.eslite.com')
          ?.localStorage || [];
        const rawAuthorization = localStorage.find((entry) => entry.name === 'auth._token.prd')?.value
          || storageState?.cookies?.find((entry) => entry.name === 'auth._token.prd')?.value
          || '';
        let authorization = rawAuthorization;
        try { authorization = decodeURIComponent(rawAuthorization); } catch {}
        // Public stock checks do not need a member identity. Never attach an
        // expired purchase token to the monitoring API.
        try {
          const payload = JSON.parse(Buffer.from(String(authorization).replace(/^Bearer\s+/i, '').split('.')[1], 'base64url'));
          if (payload.exp && payload.exp * 1000 <= Date.now()) authorization = '';
        } catch {}
        const context = await this.esliteRequestFactory.newContext({
          baseURL: 'https://athena.eslite.com',
          storageState: authorization && !this.esliteApiOnly ? storageState : {
            ...storageState, cookies: (storageState.cookies || []).filter((cookie) => !/^auth\./i.test(cookie.name))
          },
          timeout: 4_000,
          extraHTTPHeaders: {
            accept: 'application/json, text/plain, */*',
            ...(authorization && !this.esliteApiOnly ? { authorization } : {}),
            origin: 'https://www.eslite.com',
            referer: 'https://www.eslite.com/'
          }
        });
        this.esliteApiContext = context;
        return context;
      })().finally(() => { this.esliteApiContextPromise = null; });
    }
    return this.esliteApiContextPromise;
  }

  async requestEslitePurchaseStatus(apiUrl, product) {
    const api = await this.ensureEsliteApiContext();
    if (api) {
      const response = await api.get(apiUrl, {
        headers: { referer: product.url },
        timeout: 4_000
      });
      return {
        ok: response.ok(),
        status: response.status(),
        json: () => readAndReleaseResponse(response, 'json'),
        dispose: () => releaseResponse(response)
      };
    }
    return this.fetcher(apiUrl, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Cache-Control': 'no-cache',
        Origin: 'https://www.eslite.com',
        Referer: product.url,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36'
      },
      signal: AbortSignal.timeout(4_000)
    });
  }

  async verifyEsliteProduct(product) {
    const productId = productIdFromUrl(product.url);
    if (Date.now() < Number(this.esliteProductBlockedUntil.get(productId) || 0)) return product;
    if (/^\d{8,}$/.test(productId)) {
      const apiUrl = this.eslitePurchaseStatusUrl(productId);
      let useBrowserFallback = false;
      try {
        const response = await this.requestEslitePurchaseStatus(apiUrl, product);
        const status = Number(response.status) || 0;
        if (response.ok) {
          let data = null;
          try { data = await response.json(); } catch {}
          const hasPurchaseStatus = data && typeof data === 'object' && (
            cleanText(data.product_button_status || data.button_status || data.status)
            || Number.isFinite(Number(data.stock))
            || cleanText(data.product_guid)
          );
          if (hasPurchaseStatus) {
            this.esliteProductBlockedUntil.delete(productId);
            this.esliteVerificationFailures.delete(productId);
            return parseEslitePurchaseStatus(data, product);
          }
          // A healthy endpoint returning an unrecognisable body usually means
          // the route or response contract changed. Rebuild it from the real
          // product page once instead of treating the product as sold out.
          useBrowserFallback = true;
          this.log(`誠品 purchase_status API 格式已變更｜${product.title}：改由背景頁面重新確認端點。`);
        } else if ([404, 405, 410].includes(status)) {
          await response.dispose?.();
          // Only a missing/removed endpoint may start the headless browser
          // fallback and rediscover the actual purchase_status route.
          useBrowserFallback = true;
          this.log(`誠品 purchase_status API 端點失效（HTTP ${status}）｜${product.title}：改由背景頁面重新確認。`);
        } else {
          await response.dispose?.();
          if ([401, 403].includes(status)) await this.resetEsliteApiContext();
          this._backoffEsliteProduct(productId);
          this.log(`誠品 purchase_status API 暫時無法讀取（HTTP ${status || '未知'}）｜${product.title}：保留基線，不啟動瀏覽器。`);
        }
      } catch (error) {
        this._backoffEsliteProduct(productId);
        this.log(`誠品 purchase_status API 連線失敗｜${product.title}：${safeDiagnosticMessage(error)}；保留基線，不啟動瀏覽器。`);
      }

      if (useBrowserFallback && this.esliteApiOnly) {
        this._backoffEsliteProduct(productId);
        this.log(`誠品單品 API 無可信結果｜${product.title}：保留待確認狀態；API-only 不開啟商品頁。`);
        return product;
      }
      if (useBrowserFallback) {
        if (Date.now() < this.eslitePageBlockedUntil) return product;
        const page = await this.newPage({
          locale: 'zh-TW',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
        });
        try {
          const apiResponsePromise = page.waitForResponse(
            (response) => {
              try {
                const observed = new URL(response.url());
                return observed.hostname === 'athena.eslite.com'
                  && observed.pathname.includes(`/products/${encodeURIComponent(productId)}/purchase_status`)
                  && response.status() === 200;
              } catch {
                return false;
              }
            },
            { timeout: 4000 }
          ).catch((error) => ({ waitError: error }));
          await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 12000 });
          const response = await apiResponsePromise;
          if (!response?.waitError) {
            const data = await response.json();
            const observedUrl = response.url?.() || apiUrl;
            this.eslitePurchaseStatusApiTemplate = observedUrl.replace(encodeURIComponent(productId), '{productId}');
            this.eslitePageBlockedUntil = 0;
            this.esliteProductBlockedUntil.delete(productId);
            return parseEslitePurchaseStatus(data, product);
          }
          const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
          const content = typeof page.content === 'function' ? await page.content().catch(() => '') : '';
          if (BLOCKED_PAGE_WORDS.test(`${title} ${content}`)) {
            this.eslitePageBlockedUntil = Date.now() + this.esliteBlockedRetryMs;
            this.log(`誠品完整商品頁受 Cloudflare 阻擋，${Math.round(this.esliteBlockedRetryMs / 1000)} 秒後再探測；直接 API、搜尋 API 仍持續監控。`);
          }
          this.esliteProductBlockedUntil.set(productId, Date.now() + this.esliteBlockedRetryMs);
        } catch (error) {
          this.esliteProductBlockedUntil.set(productId, Date.now() + this.esliteBlockedRetryMs);
          this.log(`誠品 purchase_status 背景備援確認失敗｜${product.title}：${safeDiagnosticMessage(error)}`);
        } finally {
          await page.close();
        }
      }
    }
    // 數字 GUID 商品若直接 API 與必要的端點重建都沒有得到可信結果，
    // 保留上次狀態；不再開第二個頁面或把暫時錯誤誤判為售罄。
    if (/^\d{8,}$/.test(productId) || this.esliteApiOnly) return product;
    try {
      const html = await this.loadHtml(product.url);
      const detail = parseEsliteProductPage(html, product.url);
      if (detail.available === null) return product;
      return {
        ...product,
        title: detail.title || product.title,
        imageUrl: detail.imageUrl || product.imageUrl,
        price: detail.price || product.price,
        available: detail.available,
        status: detail.status || product.status,
        availabilitySource: 'eslite-product-page'
      };
    } catch (error) {
      this.log(`誠品商品頁確認失敗｜${product.title}：${safeDiagnosticMessage(error)}`);
      return product;
    }
  }

  async loadEsliteKeywordProducts(target) {
    this.esliteClosed = false;
    const keywords = [...new Set(
      (Array.isArray(target.keywords) ? target.keywords : ['BEYBLADE X', '戰鬥陀螺'])
        .map((keyword) => cleanText(keyword))
        .filter(Boolean)
    )].slice(0, 6);
    const discoveryUrls = [...new Set(
      (Array.isArray(target.discoveryUrls) ? target.discoveryUrls : [])
        .map((url) => cleanText(url))
        .filter((url) => isEsliteExhibitionUrl(url))
    )].slice(0, 6);
    const categorySearches = (Array.isArray(target.categorySearches) ? target.categorySearches : [])
      .map((item) => ({
        keyword: cleanText(typeof item === 'string' ? item : item?.keyword),
        categoryId: cleanText(typeof item === 'string' ? '' : item?.categoryId)
      }))
      .filter((item) => item.keyword && /^\d+$/.test(item.categoryId))
      .slice(0, 4);
    const latestSearches = (Array.isArray(target.latestSearches) ? target.latestSearches : [])
      .map((item) => ({
        keyword: cleanText(typeof item === 'string' ? item : item?.keyword),
        categoryId: cleanText(typeof item === 'string' ? '' : item?.categoryId),
        sort: 'manufacturer_date desc',
        maxPages: 1
      }))
      .filter((item) => item.keyword && (!item.categoryId || /^\d+$/.test(item.categoryId)))
      .slice(0, 4);
    const brandSearches = (Array.isArray(target.brandSearches) ? target.brandSearches : [])
      .map((item) => ({
        keyword: cleanText(typeof item === 'string' ? item : item?.keyword),
        brands: [...new Set(
          (Array.isArray(item?.brands) ? item.brands : [])
            .map((brand) => cleanText(brand))
            .filter(Boolean)
        )].slice(0, 5),
        sort: '_weight_ desc',
        maxPages: Math.min(2, Math.max(1, Number(item?.maxPages) || 1))
      }))
      .filter((item) => item.keyword && item.brands.length)
      .slice(0, 4);
    const normalizeSearchKeyword = (value) => cleanText(value)
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .toLocaleLowerCase('zh-TW');
    const searchProfiles = [...new Map([
      // 本週突襲優先：一般索引只讀前 40 筆；最新上架另有第一頁高速入口。
      ...latestSearches,
      ...brandSearches,
      ...keywords.map((keyword) => ({ keyword, categoryId: '', sort: '_weight_ desc', maxPages: 2 })),
      ...categorySearches.map((profile) => ({ ...profile, sort: '_weight_ desc', maxPages: 2 }))
    ].map((profile) => [
      `${normalizeSearchKeyword(profile.keyword)}|${profile.categoryId || ''}|${profile.sort}|${(profile.brands || []).join(',').toLocaleLowerCase('zh-TW')}`,
      profile
    ])).values()];
    if (!searchProfiles.length && !discoveryUrls.length) throw new Error('誠品至少需要一組搜尋關鍵字、分類搜尋或官方活動頁');

    const products = new Map();
    const sourceProductIds = new Set();
    const searchProductIds = new Set();
    const discoveryPages = [];
    let successfulSources = 0;
    let searchSuccesses = 0;
    const checkedAt = new Date().toISOString();
    const routeStatus = {
      exhibition: {
        enabled: discoveryUrls.length > 0,
        status: discoveryUrls.length ? 'checking' : 'disabled',
        urls: discoveryUrls,
        productCount: 0,
        checkedAt: ''
      },
      search: {
        enabled: searchProfiles.length > 0,
        status: searchProfiles.length ? 'checking' : 'disabled',
        profileCount: searchProfiles.length,
        productCount: 0,
        checkedAt: ''
      },
      product: {
        mode: 'source-triggered',
        requestedCount: 0,
        verifiedCount: 0,
        failedCount: 0,
        checkedAt: ''
      }
    };
    const mergeProducts = (items) => {
      for (const item of items) {
        const previous = products.get(item.id);
        const previousVerified = ['eslite-product-page', 'eslite-purchase-status'].includes(previous?.availabilitySource);
        const itemVerified = isEsliteSourceBuySignal(item) || ['eslite-product-page', 'eslite-purchase-status'].includes(item?.availabilitySource);
        products.set(item.id, previous
          ? {
              ...previous,
              ...item,
              title: item.title || previous.title,
              imageUrl: item.imageUrl || previous.imageUrl,
              price: item.price || previous.price,
              available: previousVerified && !itemVerified ? previous.available : item.available ?? previous.available,
              status: previousVerified && !itemVerified ? previous.status : item.status || previous.status,
              variants: previousVerified && !itemVerified
                ? previous.variants
                : item.variants?.length ? item.variants : previous.variants,
              stockSource: previousVerified && !itemVerified ? previous.stockSource : item.stockSource || previous.stockSource,
              availabilitySource: itemVerified ? item.availabilitySource : previous.availabilitySource || item.availabilitySource
            }
          : item);
      }
    };

    const knownProducts = Object.values(
      this.state.data?.commerce?.shoppingSites?.targets?.[target.id]?.seen || {}
    ).filter((product) => (
      product?.id
      && /eslite\.com\/product\//i.test(product.url || '')
      && isTrackedBeybladeToy(product.title, product.url)
    ));
    const manualProducts = this.esliteManualProducts();
    const manualProductIds = new Set(manualProducts.map((product) => String(product.id)));
    const directlyVerified = new Map();

    // 歷史基線只用於比對，不再逐筆輪詢。個別商品 API 只會由策展頁或
    // 搜尋頁本輪實際出現的商品觸發，避免舊商品拖慢兩條發現線。
    mergeProducts([...knownProducts, ...manualProducts]);
    const verifySourceProducts = async (items, source) => {
      const eligible = items.filter((item) => item?.id && /eslite\.com\/product\//i.test(item.url || ''));
      if (eligible.length) this.log(`誠品來源讀到商品｜${source}｜${eligible.length} 件｜${new Date().toISOString()}`);
      for (const item of eligible) {
        if (isEsliteSourceBuySignal(item)) {
          const confirmed = { ...item, verificationPending: false, availabilitySource: item.availabilitySource || 'eslite-source-buy-button' };
          directlyVerified.set(String(item.id), confirmed);
          mergeProducts([confirmed]);
          this.applyImmediateEsliteObservations(target, [confirmed], { source: `${source}->官方可購狀態` });
          continue;
        }
        // Expose new identities promptly without inventing buyability. Unknown
        // status verification cannot block discovery, notification or paging.
        this.applyImmediateEsliteObservations(target, [{ ...item, available: null, variants: [], status: 'verification_pending' }], { source });
        mergeProducts([{ ...item, verificationPending: true }]);
        routeStatus.product.requestedCount += 1;
        void this.queueEsliteVerification(target, item, source, (confirmed) => {
          directlyVerified.set(String(item.id), confirmed);
          mergeProducts([confirmed]);
          routeStatus.product.verifiedCount += 1;
          routeStatus.product.checkedAt = new Date().toISOString();
        });
      }
    };

    const scanSearchProfile = async ({ keyword, categoryId, brands = [], sort = '_weight_ desc', maxPages = 5 }) => {
      if (Date.now() < this.esliteSearchApiBlockedUntil) return;
      let keywordSucceeded = false;
      const normalizedBrands = [...new Set(
        (Array.isArray(brands) ? brands : []).map((brand) => cleanText(brand)).filter(Boolean)
      )].slice(0, 5);
      const expectedBrandFilter = JSON.stringify(normalizedBrands);
      const templateKey = `${normalizeSearchKeyword(keyword)}|${categoryId || ''}|${sort}|${normalizedBrands.join(',').toLocaleLowerCase('zh-TW')}`;
      let holmesApiTemplate = this.esliteHolmesTemplates.get(templateKey) || '';
      if (!holmesApiTemplate && this.esliteApiOnly) {
        // Same first-party contract observed in the official search bundle and
        // previously captured routes; no browser bootstrap or fabricated visitor.
        const route = new URL('https://holmes.eslite.com/v1/search');
        route.searchParams.set('q', keyword);
        route.searchParams.set('sort', 'desc');
        if (sort === 'manufacturer_date desc') route.searchParams.set('sort_field', 'publish_time');
        route.searchParams.set('final_price', '0,');
        route.searchParams.set('exp', categoryId ? 'b' : 'c');
        if (categoryId) route.searchParams.set('categories', categoryId);
        if (normalizedBrands.length) route.searchParams.set('brandName', expectedBrandFilter);
        holmesApiTemplate = route.href;
      }
      // 誠品前端即使網址寫 size=100，Holmes API 仍固定每次回傳 20 筆。
      // 2026-08 誠品已把 start 解釋為「從 0 開始的頁碼」，不是商品 offset。
      // start=1 才是第 2 頁；舊的 start=20 會讓 Holmes API 誤查 page_no=21。
      const pageLimit = Math.min(5, Math.max(1, Number(maxPages) || 1));
      for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
        const expectedPageNo = pageIndex + 1;
        const categoryQuery = categoryId ? `&categories=%5B${encodeURIComponent(categoryId)}%5D` : '';
        const brandQuery = normalizedBrands.length
          ? `&brands=${encodeURIComponent(Buffer.from(expectedBrandFilter, 'utf8').toString('base64'))}`
          : '';
        const searchUrl = `https://www.eslite.com/Search?keyword=${encodeURIComponent(keyword)}&final_price=0,&publishDate=0&sort=${encodeURIComponent(sort)}&size=20&display=list&start=${pageIndex}${categoryQuery}&exp=${categoryId ? 'b' : 'c'}${brandQuery}`;
        let payload = null;
        let pageProducts = null;
        let lastError = null;

        // 第 1 頁成功後，後續頁直接沿用誠品前端實際呼叫的 Holmes API。
        // 這會保留官方 visitor_id，也不再依賴搜尋畫面是否真的觸發第 2 頁請求。
        if (holmesApiTemplate) {
          let templateInvalid = false;
          try {
            const apiUrl = new URL(holmesApiTemplate);
            apiUrl.searchParams.set('page_no', String(expectedPageNo));
            apiUrl.searchParams.set('page_size', '20');
            apiUrl.searchParams.set('facet', 'false');
            const apiResponse = this.esliteApiOnly
              ? await this.requestEslitePublicApi(apiUrl.href, searchUrl, 2500)
              : await this.fetcher(apiUrl.href, {
              headers: {
                Accept: 'application/json, text/plain, */*',
                'Accept-Language': 'zh-TW,zh;q=0.9',
                Origin: 'https://www.eslite.com',
                Referer: searchUrl,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36'
              },
              signal: AbortSignal.timeout(2500)
            });
            if (!apiResponse.ok) {
              templateInvalid = [400, 404, 422].includes(apiResponse.status);
              await apiResponse.dispose?.();
              throw new Error(`Holmes API 回傳 ${apiResponse.status}`);
            }
            payload = await apiResponse.json();
            if (!Array.isArray(payload?.results)) {
              templateInvalid = true;
              throw new Error('Holmes API 缺少 results');
            }
            if (Number.isFinite(Number(payload?.page_no)) && Number(payload.page_no) !== expectedPageNo) {
              templateInvalid = true;
              throw new Error(`Holmes API 回傳錯誤頁碼 ${payload.page_no}`);
            }
          } catch (error) {
            lastError = error;
            // 逾時、429、5xx 只是暫時失敗；保留曾成功的 API 網址，下輪可直接恢復。
            if (templateInvalid) {
              this.esliteHolmesTemplates.delete(templateKey);
              holmesApiTemplate = '';
            }
          }
        }

        // 誠品偶爾不會在第一次導航觸發 Holmes 搜尋；單頁最多重試一次。
        let browserAttempted = false;
        for (let attempt = 1; !this.esliteApiOnly && !payload && !holmesApiTemplate && attempt <= 1 && Date.now() >= this.esliteSearchBrowserBlockedUntil; attempt += 1) {
          browserAttempted = true;
          const page = await this.newPage({
            locale: 'zh-TW',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
          });
          try {
            const responsePromise = page.waitForResponse((response) => {
              try {
                const url = new URL(response.url());
                const responseKeyword = normalizeSearchKeyword(url.searchParams.get('q'));
                const responseCategory = cleanText(url.searchParams.get('categories'));
                const responseBrandFilter = cleanText(url.searchParams.get('brandName'));
                const responsePageNo = Number(url.searchParams.get('page_no'));
                return url.hostname === 'holmes.eslite.com'
                  && url.pathname === '/v1/search'
                  && responseKeyword === normalizeSearchKeyword(keyword)
                  && (categoryId ? responseCategory === categoryId : !responseCategory)
                  && (normalizedBrands.length ? responseBrandFilter === expectedBrandFilter : !responseBrandFilter)
                  && responsePageNo === expectedPageNo
                  && url.searchParams.get('facet') !== 'true';
              } catch {
                return false;
              }
            }, { timeout: 5000 }).then((response) => {
              // Capture the actual official route even when DOM cards render
              // first. Otherwise the next scan needlessly opens the UI again.
              if (typeof response.url === 'function') {
                const captured = new URL(response.url());
                if (captured.hostname === 'holmes.eslite.com' && captured.pathname === '/v1/search') {
                  holmesApiTemplate = captured.href;
                  this.esliteHolmesTemplates.set(templateKey, holmesApiTemplate);
                  this.state.data.commerce ||= {};
                  this.state.data.commerce.shoppingSites ||= { targets: {} };
                  this.state.data.commerce.shoppingSites.esliteApiRoutes = Object.fromEntries(this.esliteHolmesTemplates);
                  void this.state.save().catch((error) => this.log(`誠品搜尋 API 路線保存失敗：${safeDiagnosticMessage(error)}`));
                }
              }
              return response;
            }).catch((error) => ({ waitError: error }));
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            // 新版誠品有時已把搜尋結果畫在頁面，卻不再送出舊版 Holmes XHR。
            // 先讀畫面；只在畫面尚未產生結果時才等待 API，避免白等 15 秒後漏抓。
            if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(350);
            if (typeof page.content === 'function') {
              const html = await page.content();
              const domProducts = parseShoppingPage(html, searchUrl);
              const explicitEmpty = /很抱歉[，,]?查無|全部商品\s*[（(]?\s*0\s*[）)]?/i.test(cleanText(html));
              if (domProducts.length || explicitEmpty) {
                pageProducts = domProducts;
                payload = {
                  results: [],
                  page_no: expectedPageNo,
                  page_size: 20,
                  total_size: domProducts.length
                };
              }
            }
            if (!payload) {
              const response = await responsePromise;
              if (response?.waitError) throw response.waitError;
              if (typeof response.status === 'function' && response.status() !== 200) {
                throw new Error(`Holmes API 回傳 ${response.status()}`);
              }
              payload = await response.json();
              if (typeof response.url === 'function') {
                holmesApiTemplate = response.url();
                this.esliteHolmesTemplates.set(templateKey, holmesApiTemplate);
                this.state.data.commerce.shoppingSites.esliteApiRoutes = Object.fromEntries(this.esliteHolmesTemplates);
                void this.state.save().catch((error) => this.log(`誠品搜尋 API 路線保存失敗：${safeDiagnosticMessage(error)}`));
              }
            }
            break;
          } catch (error) {
            lastError = error;
            if (/Holmes API 回傳 (403|429|5\d\d)/.test(error.message)) break;
          } finally {
            await page.close();
          }
        }

        if (!payload) {
          if (this.esliteApiOnly) this.log(`誠品搜尋 API 無法讀取｜${keyword}｜第 ${expectedPageNo} 頁｜${safeDiagnosticMessage(lastError)}；保留基線，不開啟瀏覽器。`);
          if (browserAttempted && Date.now() >= this.esliteSearchBrowserBlockedUntil) {
            const retrySeconds = Math.round(Math.max(60_000, this.esliteBlockedRetryMs) / 1000);
            this.esliteSearchBrowserBlockedUntil = Date.now() + retrySeconds * 1000;
            this.log(`${target.name}｜誠品搜尋頁暫時無法讀取（${categoryId ? `分類 ${categoryId}、` : ''}${normalizedBrands.length ? `品牌 ${normalizedBrands.join('、')}、` : ''}「${keyword}」第 ${expectedPageNo} 頁：${safeDiagnosticMessage(lastError)}）；暫停重開搜尋頁 ${retrySeconds} 秒，既有商品基線繼續檢查。`);
          }
          break;
        }
        if (browserAttempted) this.esliteSearchBrowserBlockedUntil = 0;

        const rows = Array.isArray(payload?.results) ? payload.results : [];
        const parsedProducts = pageProducts || parseEsliteSearchData(payload, searchUrl);
        parsedProducts.forEach((product) => {
          sourceProductIds.add(String(product.id));
          searchProductIds.add(String(product.id));
        });
        routeStatus.search.productCount = searchProductIds.size;
        await verifySourceProducts(
          parsedProducts,
          sort === 'manufacturer_date desc' ? 'holmes-latest' : 'holmes-search'
        );
        keywordSucceeded = true;
        const pageSize = Math.max(1, Number(payload?.page_size) || 20);
        const totalSize = Number(payload?.total_size);
        const reachedLastPage = rows.length < pageSize
          || (Number.isFinite(totalSize) && expectedPageNo * pageSize >= totalSize);
        // Holmes 的 total_size 會比使用者看到的搜尋頁索引更晚更新。一般搜尋既然
        // 已明確設定讀兩頁，就固定讀滿兩頁，避免新品已在第 2 頁但 API 仍回報
        // 只有一頁而漏抓；單頁「最新上架」入口仍可依回傳結果提早結束。
        if (reachedLastPage && pageLimit === 1) break;
      }
      if (keywordSucceeded) {
        successfulSources += 1;
        searchSuccesses += 1;
      }
    };
    const searchLane = async () => {
      // 誠品 Cloudflare 對同一來源瞬間開太多搜尋頁很敏感；搜尋線內每批最多兩組。
      for (let index = 0; index < searchProfiles.length; index += 2) {
        await Promise.all(searchProfiles.slice(index, index + 2).map(scanSearchProfile));
      }
      routeStatus.search.checkedAt = new Date().toISOString();
      routeStatus.search.status = Date.now() < this.esliteSearchApiBlockedUntil ? 'cooldown' : searchSuccesses > 0 ? 'healthy' : 'error';
      routeStatus.search.retryAt = this.esliteSearchApiBlockedUntil > Date.now() ? new Date(this.esliteSearchApiBlockedUntil).toISOString() : '';
    };
    const exhibitLane = async () => {
      let exhibitSuccesses = 0;
      await Promise.all(discoveryUrls.map(async (url) => {
        if (Date.now() < this.esliteExhibitBlockedUntil) {
          routeStatus.exhibition.status = 'blocked';
          return;
        }
        try {
          const exhibitProducts = await this.loadEsliteExhibitProducts(url);
          const discoveryPage = exhibitProducts.discoveryPage || {
            url,
            title: 'BEYBLADE X 戰鬥陀螺策展',
            productCount: exhibitProducts.length,
            imageUrl: exhibitProducts.find((product) => product.imageUrl)?.imageUrl || '',
            isLive: true
          };
          // The exhibition alert is its own fast lane. Send it as soon as this
          // source resolves instead of waiting for search and baseline checks.
          if (!this.esliteDiscoveryJobs.has(url)) {
            const task = this.applyImmediateEsliteDiscoveryPage(target, discoveryPage);
            this.esliteDiscoveryJobs.set(url, task);
            this.notificationTasks.add(task);
            task.catch((error) => this.log(`誠品策展預警失敗：${safeDiagnosticMessage(error)}`)).finally(() => {
              this.esliteDiscoveryJobs.delete(url);
              this.notificationTasks.delete(task);
            });
          }
          exhibitProducts.forEach((product) => sourceProductIds.add(String(product.id)));
          routeStatus.exhibition.productCount += exhibitProducts.length;
          // Stock notifications must not wait for Discord's exhibition alert.
          await verifySourceProducts(exhibitProducts, 'exhibition-page');
          discoveryPages.push(discoveryPage);
          successfulSources += 1;
          exhibitSuccesses += 1;
        } catch (error) {
          this.log(`${target.name}｜官方活動頁暫時無法讀取：${safeDiagnosticMessage(error)}`);
        }
      }));
      routeStatus.exhibition.checkedAt = new Date().toISOString();
      if (routeStatus.exhibition.status !== 'blocked') {
        routeStatus.exhibition.status = exhibitSuccesses > 0 ? 'healthy' : 'error';
      }
    };

    // 策展與搜尋同時起跑。先命中商品的來源建立唯一驗證 Promise；另一條線
    // 若同時看到同一商品會共用結果，因此不互等、也不重複推播或下單。
    await Promise.all([searchLane(), exhibitLane()]);
    const sourceProductCount = sourceProductIds.size;
    const verified = [...products.values()];
    const freshVerifiedCount = directlyVerified.size;

    const manualStorage = this.esliteManualStorage();
    for (const product of verified) {
      if (
        !directlyVerified.has(String(product.id))
        || !manualProductIds.has(String(product.id))
        || !manualStorage[product.id]
      ) continue;
      manualStorage[product.id] = {
        ...manualStorage[product.id],
        ...product,
        source: manualStorage[product.id].source || 'manual',
        addedAt: manualStorage[product.id].addedAt || checkedAt,
        updatedAt: checkedAt,
        lastCheckedAt: checkedAt,
        lastError: ''
      };
    }

    if (!successfulSources && !freshVerifiedCount) throw new Error('誠品關鍵字、商品頁與官方活動來源本次皆無法讀取，已保留上次基線');
    verified.sourceProductCount = sourceProductCount;
    verified.successfulSources = successfulSources;
    verified.freshVerifiedCount = freshVerifiedCount;
    verified.discoveryPages = discoveryPages;
    verified.esliteRoutes = routeStatus;
    return verified;
  }

  async loadMmToyCategoryProducts(target, { fast = false } = {}) {
    const categoryUrl = new URL(target.url);
    const categoryEndpoint = categoryUrl.pathname.replace(/^\/category\//i, '/category/query/');
    const searchEndpoint = '/category/query?keyword=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA';
    const products = new Map();
    const now = Date.now();
    // The keyword result currently contains the full public catalogue and is
    // the lightweight source used during a 3-second burst. The category source
    // is still merged every 30 seconds (and on every normal scan) so a newly
    // created item that has not entered the search index cannot stay hidden.
    const includeDiscoverySource = !fast
      || now - this.mmToyLastDiscoveryAt >= this.mmToyDiscoveryIntervalMs;
    const endpoints = includeDiscoverySource
      ? [categoryEndpoint, searchEndpoint]
      : [searchEndpoint];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const page = await this.ensureMmToyPage();
        // MM occasionally creates a product without assigning it to the Beyblade
        // category. Merge the category and full-store keyword results so those
        // short-lived listings are still visible. Fetch all result pages in
        // parallel; the old page-by-page navigation took roughly 20 seconds.
        const sources = await Promise.all(
          endpoints.map((endpoint) => this.fetchAllMmToyQueryPages(page, endpoint))
        );
        for (const data of sources.flat()) {
          for (const product of parseMmToyCategoryData(data, target.url)) products.set(product.id, product);
        }
        if (includeDiscoverySource) this.mmToyLastDiscoveryAt = now;
        break;
      } catch (error) {
        // Closing the page and immediately replaying every query doubles the
        // traffic exactly when BVSHOP asks us to slow down. Keep the session and
        // let the scheduler try the next lightweight snapshot instead.
        if (/MM小舖商品 API HTTP 429/i.test(error.message)) throw error;
        await this.mmToyPage?.close().catch(() => {});
        this.mmToyPage = null;
        if (attempt > 0) throw error;
      }
    }
    if (!products.size) throw new Error('MM小舖商品 API 本次沒有回傳戰鬥陀螺，已保留上次基線');
    return [...products.values()];
  }

  async loadSenSenCollectionProducts(target) {
    const collectionUrl = new URL(target.url);
    collectionUrl.search = '';
    collectionUrl.hash = '';
    collectionUrl.pathname = `${collectionUrl.pathname.replace(/\/$/, '')}.json`;
    collectionUrl.searchParams.set('limit', '100');
    collectionUrl.searchParams.set('page', '1');
    const response = await this.fetcher(collectionUrl.href, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36'
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`森森文具商品 API 回傳 ${response.status}`);
    const products = parseSenSenCollectionData(await response.json(), target.url);
    if (!products.length) throw new Error('森森文具商品 API 本次沒有回傳正式陀螺，已保留上次基線');
    return products;
  }

  async loadTwjCollectionProducts(target) {
    const collectionUrl = new URL(target.url);
    collectionUrl.search = '';
    collectionUrl.hash = '';
    collectionUrl.pathname = `${collectionUrl.pathname.replace(/\/$/, '')}.json`;
    collectionUrl.searchParams.set('limit', '100');
    collectionUrl.searchParams.set('page', '1');
    const response = await this.fetcher(collectionUrl.href, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36'
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`童無忌商品 API 回傳 ${response.status}`);
    const products = parseTwjCollectionData(await response.json(), target.url);
    if (!products.length) throw new Error('童無忌商品 API 本次沒有回傳戰鬥陀螺商品，已保留上次基線');
    return products;
  }

  async inspectProduct(url, { includeStock = true } = {}) {
    const html = await this.loadHtml(url);
    const parsed = parseShoppingPage(html, url);
    const targetId = productIdFromUrl(url);
    const product = parsed.find((item) => item.id === targetId) || parsed[0];
    if (!product) return null;
    const enriched = await this.enrichProduct(product, {
      sourceHtml: html,
      actualMomoStock: includeStock && isMomoProductUrl(url)
    });
    return {
      ...enriched,
      saleStartAt: /momoshop\.com\.tw/i.test(url) ? parseMomoSaleStart(html) : null
    };
  }

  async verifyKnownMomoProduct(url, {
    notifyStockChanges = true,
    reason = 'direct-check'
  } = {}) {
    if (!isMomoProductUrl(url)) throw new Error('單品直查目前只接受 momo 商品網址');
    this.state.data.commerce ||= {};
    this.state.data.commerce.shoppingSites ||= { targets: {} };
    const storage = this.state.data.commerce.shoppingSites;
    const productId = productIdFromUrl(url);
    const matchingTargets = this.getTargets()
      .filter((target) => target.enabled !== false && isMomoCategoryTarget(target))
      .map((target) => ({ target, saved: storage.targets?.[target.id] }))
      .filter(({ saved }) => saved?.seen?.[productId]);
    if (!matchingTargets.length) {
      return { checked: 0, notified: 0, restocked: 0, purchaseCandidates: [], skipped: true };
    }

    const product = await this.inspectProduct(url, { includeStock: true });
    if (!product) throw new Error(`momo 商品 ${productId} 單品頁無法解析`);
    const checkedAt = new Date().toISOString();
    const excludedBy = shoppingProductExcludeMatch(product, this.getExcludeKeywords());
    if (excludedBy) {
      for (const { target, saved } of matchingTargets) {
        saved.excluded ||= {};
        const previousExcluded = saved.excluded[productId];
        saved.excluded[productId] = {
          id: productId,
          title: product.title,
          url: product.url,
          reason: `命中排除關鍵字「${excludedBy}」`,
          firstSeenAt: previousExcluded?.firstSeenAt || checkedAt,
          lastSeenAt: checkedAt
        };
        saved.lastDirectCheckAt = checkedAt;
        saved.lastDirectCheckProductId = productId;
        saved.lastDirectCheckError = '';
        if (!previousExcluded || previousExcluded.reason !== saved.excluded[productId].reason) {
          this.log(`${target.name}｜${product.title}：已掃描但排除，命中關鍵字「${excludedBy}」，不推播、不下單。`);
        }
      }
      await this.state.save();
      return {
        checked: 1,
        excluded: 1,
        notified: 0,
        restocked: 0,
        product: { ...product, available: false, excludedBy },
        purchaseCandidates: [],
        skipped: false
      };
    }
    const stockVariant = (product.variants || []).find((variant) => Number.isFinite(Number(variant.stock)));
    const sellable = product.available === true
      && (!stockVariant || stockVariant.available === true)
      && (!stockVariant || Number(stockVariant.stock) > 0);
    const observed = {
      ...product,
      available: sellable,
      status: sellable ? 'available' : 'unavailable',
      variants: (product.variants || []).map((variant) => ({
        ...variant,
        available: sellable && variant.available === true
      })),
      lastSeenAt: checkedAt,
      lastDirectCheckAt: checkedAt,
      directCheckReason: reason
    };

    let notified = 0;
    let restocked = 0;
    const purchaseCandidates = [];
    let emitted = false;
    for (const { target, saved } of matchingTargets) {
      const previous = saved.seen[productId];
      const previouslySellable = previous.available === true
        || (previous.variants || []).some((variant) => variant.available === true);
      saved.seen[productId] = {
        ...previous,
        ...observed,
        firstSeenAt: previous.firstSeenAt || checkedAt,
        saleStartAt: previous.saleStartAt || product.saleStartAt || null,
        missingStreak: 0,
        ...(sellable ? { lastAvailableAt: checkedAt } : { lastUnavailableAt: checkedAt })
      };
      saved.lastDirectCheckAt = checkedAt;
      saved.lastDirectCheckProductId = productId;
      saved.lastDirectCheckError = '';

      if (!emitted && !previouslySellable && sellable) {
        const candidate = {
          ...observed,
          stock: stockVariant?.stock ?? null,
          variantId: stockVariant?.id || null,
          variantName: stockVariant?.name || '',
          reason: 'restock',
          siteName: target.siteName || shoppingSiteName(target.url),
          targetId: target.id,
          targetName: target.name,
          detectionSource: reason
        };
        purchaseCandidates.push(candidate);
        this.emitPurchaseCandidate(candidate);
        if (notifyStockChanges) {
          this.notifyInBackground(
            `購物網站：${candidate.siteName}\n監控專區：${target.name}\n商品恢復可購買：${observed.title}${stockVariant ? `｜前台可售 ${stockVariant.stock} 組` : ''}\n${observed.url}`,
            {
              discordPreview: notificationPreview(target, observed, stockVariant, 'restock'),
              embeds: [notificationEmbed(target, observed, stockVariant, 'restock')],
              discordAudience: 'public'
            }
          );
          notified += 1;
        }
        restocked += 1;
        emitted = true;
      }
    }
    await this.state.save();
    this.log(
      `momo 單品直查｜${observed.title}｜${sellable ? `確認可售${stockVariant ? ` ${stockVariant.stock} 組` : ''}` : '目前不可購買'}｜來源：${reason}`
    );
    return {
      checked: 1,
      notified,
      restocked,
      product: observed,
      purchaseCandidates,
      skipped: false
    };
  }

  async enrichProduct(product, { force = false, sourceHtml = '', actualMomoStock = false } = {}) {
    if (actualMomoStock && isMomoProductUrl(product.url)) {
      const html = sourceHtml || '';
      const explicitlyUnavailable = Boolean(html) && product.available === false;
      try {
        const actual = await this.fetchMomoActualStock(product, html);
        if (actual) {
          const stockSource = actual.source || 'momo-recommendation-goodsStock';
          const available = actual.stock > 0 && !explicitlyUnavailable;
          return {
            ...product,
            title: actual.title,
            imageUrl: actual.imageUrl,
            price: actual.price,
            available,
            stockSource,
            variants: [{
              id: product.id,
              name: actual.title,
              stock: actual.stock,
              available,
              stockSource
            }]
          };
        }
        this.log(`${product.title}: momo 完整庫存暫時無法取得，沿用前台 goodsNum。`);
      } catch (error) {
        this.log(`${product.title}: momo 完整庫存查詢失敗：${error.message}`);
      }
      const variants = parseMomoVariants(html);
      return {
        ...product,
        variants: variants.length
          ? variants.map((variant) => ({ ...variant, available: explicitlyUnavailable ? false : variant.available }))
          : product.variants,
        available: explicitlyUnavailable
          ? false
          : variants.length ? variants.some((variant) => variant.available) : product.available
      };
    }
    if (!/momoshop\.com\.tw\/TP\//i.test(product.url) || (!force && product.variants?.length)) return product;
    const html = await this.loadHtml(product.url);
    const variants = parseMomoVariants(html);
    return {
      ...product,
      variants,
      available: variants.length ? variants.some((variant) => variant.available) : product.available
    };
  }

  async scan({
    notifyStockChanges = true,
    inventoryOnly = false,
    targetIds = null,
    mmToyFast = false
  } = {}) {
    const requestedIds = targetIds ? new Set(targetIds.map(String)) : null;
    const requestedTargets = this.getTargets().filter((item) => (
      item.enabled !== false
      && (!requestedIds || requestedIds.has(String(item.id)))
      && !this.runningTargets.has(String(item.id))
    ));
    if (!requestedTargets.length) return { skipped: true };
    for (const target of requestedTargets) this.runningTargets.add(String(target.id));
    this.running = true;
    const startedAt = Date.now();
    const completedAt = new Date().toISOString();
    const summary = {
      completedAt,
      mode: inventoryOnly ? 'inventory-boost' : 'full',
      checkedTargets: 0,
      checkedProducts: 0,
      excluded: 0,
      discovered: 0,
      unavailableListings: 0,
      ignoredUnavailable: 0,
      restocked: 0,
      stockChanged: 0,
      notified: 0,
      variantChanges: [],
      purchaseCandidates: [],
      purchaseCandidatesDispatched: Boolean(this.onPurchaseCandidate),
      errors: []
    };
    try {
      this.state.data.commerce ||= {};
      this.state.data.commerce.shoppingSites ||= { targets: {} };
      const storage = this.state.data.commerce.shoppingSites;
      storage.targets ||= {};
      for (const target of requestedTargets) {
        try {
          const savedTarget = storage.targets[target.id];
          const baselineChanged = Boolean(
            target.baselineVersion
            && savedTarget
            && savedTarget.baselineVersion !== target.baselineVersion
          );
          const previousTarget = baselineChanged
            ? { initialized: false, seen: {}, baselineVersion: target.baselineVersion }
            : savedTarget || { initialized: false, seen: {} };
          let products;
          let scanSourceMode = '';
          let momoDirectSuccesses = 0;
          if (inventoryOnly) {
            const knownMomoVariantProducts = Object.values(previousTarget.seen || {})
              .filter((product) => (
                /momoshop\.com\.tw\/TP\/[^/]+\/goodsDetail\//i.test(product.url)
                || isMomoProductUrl(product.url)
              ));
            if (!knownMomoVariantProducts.length) continue;
            products = await Promise.all(
              knownMomoVariantProducts.map((product) => this.enrichProduct(product, {
                force: true,
                actualMomoStock: isMomoProductUrl(product.url)
              }))
            );
          } else if (isMmToyTarget(target)) {
            products = await this.loadMmToyCategoryProducts(target, { fast: mmToyFast });
          } else if (isSenSenTarget(target)) {
            products = await this.loadSenSenCollectionProducts(target);
          } else if (isTwjTarget(target)) {
            products = await this.loadTwjCollectionProducts(target);
          } else if (isEsliteKeywordTarget(target)) {
            products = await this.loadEsliteKeywordProducts(target);
          } else if (isEsliteExhibitionUrl(target.url)) {
            products = await this.loadEsliteExhibitProducts(target.url);
          } else if (isMomoStoreTarget(target)) {
            products = await this.loadMomoStoreDirectProducts(target, previousTarget);
            scanSourceMode = products.sourceMode || 'momo-store-direct';
            momoDirectSuccesses = Number(products.directSuccesses) || 0;
          } else {
            const html = await this.loadHtml(target.url);
            const parsed = parseShoppingPage(html, target.url);
            // momo 官方分類只接受一般商品頁。/TP/ 是「店+」商家賣場，
            // 可能混入個人商家或溢價商品，不得進入官方原價通知基線。
            const scopedProducts = isMomoCategoryTarget(target)
              ? parsed.filter((product) => isMomoProductUrl(product.url))
              : parsed;
            const targetProductId = productLink(target.url) ? productIdFromUrl(target.url) : '';
            products = await Promise.all(
              scopedProducts.slice(0, 40).map((product) => this.enrichProduct(product, {
                sourceHtml: product.id === targetProductId ? html : '',
                actualMomoStock: isMomoProductUrl(product.url)
                  && (isMomoProductUrl(target.url) || isMomoListingUrl(target.url))
              }))
            );
          }
          const activeDiscoveryPages = Array.isArray(products.discoveryPages) ? products.discoveryPages : [];
          const esliteScan = isEsliteKeywordTarget(target) ? {
            sourceProductCount: Number(products.sourceProductCount) || 0,
            successfulSources: Number(products.successfulSources) || 0,
            freshVerifiedCount: Number(products.freshVerifiedCount) || 0,
            routes: products.esliteRoutes || null
          } : null;
          summary.checkedTargets += 1;
          const scannedProducts = products;
          const currentProductIds = new Set(scannedProducts.map((product) => String(product.id)));
          const excludedProducts = [];
          const includedProducts = [];
          for (const product of scannedProducts) {
            const excludedBy = shoppingProductExcludeMatch(product, this.getExcludeKeywords());
            if (excludedBy) excludedProducts.push({ product, excludedBy });
            else includedProducts.push(product);
          }
          summary.checkedProducts += scannedProducts.length;
          summary.excluded += excludedProducts.length;
          const nextExcluded = {};
          for (const { product, excludedBy } of excludedProducts) {
            const previousExcluded = previousTarget.excluded?.[product.id];
            nextExcluded[product.id] = {
              id: product.id,
              title: product.title,
              url: product.url,
              reason: `命中排除關鍵字「${excludedBy}」`,
              firstSeenAt: previousExcluded?.firstSeenAt || completedAt,
              lastSeenAt: completedAt
            };
            if (!previousExcluded || previousExcluded.reason !== nextExcluded[product.id].reason) {
              this.log(`${target.name}｜${product.title}：已掃描但排除，命中關鍵字「${excludedBy}」，不推播、不下單。`);
            }
          }
          products = includedProducts;
          const nextSeen = { ...previousTarget.seen };
          const nextDiscoveryPages = { ...(previousTarget.discoveryPages || {}) };
          for (const page of activeDiscoveryPages) {
            const key = String(page.url || '').trim();
            if (!key) continue;
            const previousPage = nextDiscoveryPages[key];
            if (page.isLive === false) {
              nextDiscoveryPages[key] = {
                ...previousPage,
                ...page,
                isLive: false,
                alertPolicyVersion: 2,
                lastUnavailableAt: completedAt
              };
              continue;
            }
            const detectedAt = previousPage?.firstSeenAt || completedAt;
            const legacyPolicyUpgrade = previousPage
              && Number(previousPage.alertPolicyVersion) !== 2
              && previousPage.notifiedAt;
            // Do not repeat while the page stays live, but allow one new alert
            // after a confirmed unavailable -> live transition. The versioned
            // policy upgrades old lifetime-only dedupe records exactly once.
            const shouldNotify = !previousPage?.notifiedAt
              || previousPage?.isLive === false
              || legacyPolicyUpgrade;
            let notifiedAt = previousPage?.notifiedAt || '';
            if (shouldNotify) {
              const notification = esliteExhibitionNotification(target, page, { detectedAt: completedAt });
              try {
                const messageId = await this.notify(notification.text, notification.options);
                notifiedAt = completedAt;
                summary.notified += 1;
                this.log(`${target.name}：誠品策展頁準備補貨重點預警已送達｜Discord 訊息 ID ${messageId || 'ok'}｜${key}`);
              } catch (error) {
                this.log(`${target.name}：誠品策展頁重點預警傳送失敗，下輪會重試｜${error.message}`);
              }
            }
            nextDiscoveryPages[key] = {
              ...previousPage,
              ...page,
              isLive: true,
              alertPolicyVersion: 2,
              firstSeenAt: detectedAt,
              lastSeenAt: completedAt,
              notifiedAt
            };
          }
          for (const originalProduct of products) {
            const previous = previousTarget.seen[originalProduct.id];
            let product = originalProduct;
            let pendingSaleReminder = this.getPendingSaleReminder(product, completedAt);

            // A new momo item may expose a positive goodsNum before its actual
            // sale time.  Inspect only the newly discovered product once; do
            // not add a detail-page request to every normal inventory round.
            const previousPendingStart = previous?.status === 'pending_sale'
              && Date.parse(previous.saleStartAt || '') > Date.parse(completedAt)
              ? previous.saleStartAt
              : '';
            if (!pendingSaleReminder && previousPendingStart) {
              pendingSaleReminder = { saleStartAt: previousPendingStart };
            }
            if (
              !pendingSaleReminder
              && previousTarget.initialized
              && !previous
              && isMomoCategoryTarget(target)
              && isMomoProductUrl(product.url)
            ) {
              try {
                const detailHtml = await this.loadHtml(product.url);
                const saleStartAt = parseMomoSaleStart(detailHtml, new Date(completedAt));
                if (saleStartAt && Date.parse(saleStartAt) > Date.parse(completedAt)) {
                  const metadata = momoProductMetadata(detailHtml, product.url);
                  product = {
                    ...product,
                    title: metadata.title || product.title,
                    imageUrl: metadata.imageUrl || product.imageUrl,
                    price: metadata.price || product.price,
                    saleStartAt
                  };
                  pendingSaleReminder = { saleStartAt, autoDetected: true };
                  if (this.onPendingSaleDetected) {
                    try {
                      await this.onPendingSaleDetected({
                        ...product,
                        targetId: target.id,
                        targetName: target.name,
                        siteName: target.siteName || shoppingSiteName(target.url)
                      });
                    } catch (error) {
                      this.log(`${target.name}｜${product.title}：自動保存待售提醒失敗：${error.message}`);
                    }
                  }
                }
              } catch (error) {
                // Product discovery must remain useful even when the one-time
                // detail inspection is temporarily blocked.
                this.log(`${target.name}｜${product.title}：新商品開賣時間暫時無法讀取：${error.message}`);
              }
            }
            const pendingSaleStartAt = typeof pendingSaleReminder === 'string'
              ? pendingSaleReminder
              : pendingSaleReminder?.saleStartAt || '';
            // momo sometimes exposes a future product's goodsNum before the buy
            // button is enabled.  That is reservation metadata, not sellable
            // stock.  Persist it as pending/unavailable so alternating listing
            // and detail reads cannot emit a restock on every scan.
            const normalizedProduct = pendingSaleReminder
              ? {
                  ...product,
                  available: false,
                  status: 'pending_sale',
                  saleStartAt: pendingSaleStartAt,
                  variants: (product.variants || []).map((variant) => ({
                    ...variant,
                    available: false
                  }))
                }
              : product;
            const observed = previous && normalizedProduct.available === null
              ? { ...normalizedProduct, available: previous.available }
              : normalizedProduct;
            const now = { ...observed, firstSeenAt: previous?.firstSeenAt || completedAt, lastSeenAt: completedAt };
            nextSeen[product.id] = now;
            if (isEsliteKeywordTarget(target) && observed.verificationPending === true) {
              // 策展／搜尋只負責發現；單品 API 尚未確認時只保存待驗證基線，
              // 不以索引頁的狀態推播、下單或製造可購／售罄跳動。
              continue;
            }
            if (pendingSaleReminder) {
              const previouslySellable = previous?.available === true
                || (previous?.variants || []).some((variant) => variant.available === true);
              if (!previous || previouslySellable) {
                const stockVariant = (product.variants || []).find((variant) => Number.isFinite(Number(variant.stock)));
                const stockText = stockVariant ? `；預載數量 ${stockVariant.stock} 組` : '';
                this.log(`${target.name}｜${observed.title}：待售至 ${pendingSaleStartAt || '設定時間'}${stockText}，不視為可購買且不推播補貨。`);
              }
              if (!previous) summary.ignoredUnavailable += 1;
              continue;
            }
            if (!previous) {
              if (previousTarget.initialized && observed.available === true) {
                const stockVariant = (observed.variants || []).find((variant) => Number.isFinite(Number(variant.stock)));
                const stockText = stockVariant ? `\n前台可售：${stockVariant.stock} 組` : '';
                const candidate = {
                  ...observed,
                  stock: stockVariant?.stock ?? null,
                  variantId: stockVariant?.id || null,
                  variantName: stockVariant?.name || '',
                  reason: 'new_product',
                  siteName: target.siteName || shoppingSiteName(target.url),
                  targetId: target.id,
                  targetName: target.name
                };
                summary.purchaseCandidates.push(candidate);
                this.emitPurchaseCandidate(candidate);
                summary.discovered += 1;
                this.notifyInBackground(
                  `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n發現可購買的戰鬥陀螺新品：${observed.title}${stockText}\n${observed.url}`,
                  {
                    discordPreview: notificationPreview(target, observed, stockVariant),
                    embeds: [notificationEmbed(target, observed, stockVariant)],
                    discordAudience: isMmToyTarget(target) ? 'mmtoy' : 'public'
                  }
                );
                summary.notified += 1;
              } else if (
                previousTarget.initialized
                && (
                  /momoshop\.com\.tw\/TP\/[^/]+\/main/i.test(target.url)
                  || isMomoCategoryTarget(target)
                )
              ) {
                summary.discovered += 1;
                summary.unavailableListings += 1;
                this.notifyInBackground(
                  `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n發現新的戰鬥陀螺商品頁：${observed.title}\n首次掃描時已售罄／補貨中；已啟動高速追蹤。\n${observed.url}`,
                  {
                    discordPreview: notificationPreview(target, observed, null, 'listed-unavailable'),
                    embeds: [notificationEmbed(target, observed, null, 'listed-unavailable')],
                    discordAudience: isMmToyTarget(target) ? 'mmtoy' : 'public'
                  }
                );
                summary.notified += 1;
                this.log(`${target.name}：發現新商品頁「${observed.title}」，首次掃描時已售罄，仍通知並啟動高速追蹤。`);
              } else if (
                previousTarget.initialized
                && isEsliteKeywordTarget(target)
                && /coming_soon/i.test(observed.status || '')
              ) {
                summary.discovered += 1;
                summary.unavailableListings += 1;
                this.notifyInBackground(
                  `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n誠品已建立即將開賣商品：${observed.title}\n目前尚未開放加入購物車；已持續直查商品狀態。\n${observed.url}`,
                  {
                    discordPreview: notificationPreview(target, observed, null, 'coming-soon'),
                    embeds: [notificationEmbed(target, observed, null, 'coming-soon')],
                    discordAudience: 'public'
                  }
                );
                summary.notified += 1;
                this.log(`${target.name}：發現即將開賣商品「${observed.title}」，已預警並持續追蹤 purchase_status。`);
              } else if (
                previousTarget.initialized
                && isEsliteKeywordTarget(target)
              ) {
                summary.discovered += 1;
                summary.unavailableListings += 1;
                this.notifyInBackground(
                  `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n誠品出現新的戰鬥陀螺商品：${observed.title}\n目前尚未開放購買；已持續直查商品狀態。\n${observed.url}`,
                  {
                    discordPreview: notificationPreview(target, observed, null, 'listed-unavailable'),
                    embeds: [notificationEmbed(target, observed, null, 'listed-unavailable')],
                    discordAudience: 'public'
                  }
                );
                summary.notified += 1;
                this.log(`${target.name}：發現新的戰鬥陀螺商品「${observed.title}」，目前尚未開放購買，已先推播。`);
              } else if (previousTarget.initialized) {
                summary.ignoredUnavailable += 1;
                this.log(`${target.name}：發現「${observed.title}」，目前無法購買，只建立基線不通知。`);
              }
              continue;
            }
            const previousVariants = new Map((previous.variants || []).map((variant) => [variant.id, variant]));
            for (const variant of observed.variants || []) {
              const oldVariant = previousVariants.get(variant.id);
              if (oldVariant && Number(oldVariant.stock) !== Number(variant.stock)) {
                const change = {
                  targetId: target.id,
                  targetName: target.name,
                  productId: observed.id,
                  productTitle: observed.title,
                  variantId: variant.id,
                  variantName: variant.name,
                  previousStock: Number(oldVariant.stock),
                  currentStock: Number(variant.stock),
                  url: observed.url
                };
                summary.variantChanges.push(change);
                this.log(`${target.name}｜${observed.title}｜${variant.name}：前台可售 ${oldVariant.stock} → ${variant.stock} 組。`);
              }
              const variantRestocked = (!oldVariant || oldVariant.available === false) && variant.available === true;
              if (variantRestocked) {
                const candidate = {
                  ...observed,
                  stock: variant.stock,
                  variantId: variant.id,
                  variantName: variant.name,
                  reason: 'restock',
                  siteName: target.siteName || shoppingSiteName(target.url),
                  targetId: target.id,
                  targetName: target.name
                };
                summary.purchaseCandidates.push(candidate);
                this.emitPurchaseCandidate(candidate);
              }
              if (notifyStockChanges && variantRestocked) {
                summary.restocked += 1;
                this.notifyInBackground(
                  `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n規格補貨：${stockNotificationItemName(target, observed, variant)}｜前台可售 ${variant.stock} 組\n${observed.url}`,
                  { discordPreview: notificationPreview(target, observed, variant, 'restock'), embeds: [notificationEmbed(target, observed, variant, 'restock')], discordAudience: isMmToyTarget(target) ? 'mmtoy' : 'public' }
                );
                summary.notified += 1;
              } else if (notifyStockChanges && oldVariant?.available === true && variant.available === false) {
                summary.stockChanged += 1;
                if (isMmToyTarget(target)) {
                  this.log(`${target.name}｜${observed.title}｜${variant.name}：已售罄，狀態已更新但不推播。`);
                } else {
                  this.notifyInBackground(
                    `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n售罄提醒：${stockNotificationItemName(target, observed, variant)}｜前台可售 0 組\n${observed.url}`,
                    { discordPreview: notificationPreview(target, observed, variant, 'sold-out'), embeds: [notificationEmbed(target, observed, variant, 'sold-out')], discordAudience: 'public' }
                  );
                  summary.notified += 1;
                }
              } else if (notifyStockChanges && oldVariant?.available === true && variant.available === true) {
                const threshold = stockThreshold(Number(oldVariant.stock), Number(variant.stock));
                if (threshold !== null) {
                  summary.stockChanged += 1;
                  this.notifyInBackground(
                    `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n庫存提醒：${stockNotificationItemName(target, observed, variant)}｜${oldVariant.stock} → ${variant.stock} 組${variant.stock <= 10 ? '｜即將銷售完畢' : ''}\n${observed.url}`,
                    { discordPreview: notificationPreview(target, observed, variant, 'low-stock'), embeds: [notificationEmbed(target, observed, variant, 'low-stock')], discordAudience: isMmToyTarget(target) ? 'mmtoy' : 'public' }
                  );
                  summary.notified += 1;
                }
              }
            }
            const hasPreviousVariants = Boolean((previous.variants || []).length);
            const hasCurrentVariants = Boolean((observed.variants || []).length);
            const productRestocked = !hasPreviousVariants && !hasCurrentVariants
              && previous.available === false && observed.available === true;
            if (productRestocked) {
              const candidate = {
                ...observed,
                reason: 'restock',
                siteName: target.siteName || shoppingSiteName(target.url),
                targetId: target.id,
                targetName: target.name
              };
              summary.purchaseCandidates.push(candidate);
              this.emitPurchaseCandidate(candidate);
            }
            if (notifyStockChanges && productRestocked) {
              summary.restocked += 1;
              this.notifyInBackground(
                `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n商品恢復可購買：${observed.title}\n${observed.url}`,
                { discordPreview: notificationPreview(target, observed, null, 'restock'), embeds: [notificationEmbed(target, observed, null, 'restock')], discordAudience: isMmToyTarget(target) ? 'mmtoy' : 'public' }
              );
              summary.notified += 1;
            } else if (notifyStockChanges && !hasPreviousVariants && !hasCurrentVariants && previous.available === true && observed.available === false) {
              summary.stockChanged += 1;
              if (isMmToyTarget(target)) {
                this.log(`${target.name}｜${observed.title}：已售罄，狀態已更新但不推播。`);
              } else {
                this.notifyInBackground(
                  `購物網站：${target.siteName || shoppingSiteName(target.url)}\n監控專區：${target.name}\n售罄提醒：${observed.title}\n${observed.url}`,
                  { discordPreview: notificationPreview(target, observed, null, 'sold-out'), embeds: [notificationEmbed(target, observed, null, 'sold-out')], discordAudience: 'public' }
                );
                summary.notified += 1;
              }
            }
          }
          if (!inventoryOnly && isMomoCategoryTarget(target)) {
            for (const [id, stored] of Object.entries(nextSeen)) {
              if (currentProductIds.has(String(id))) continue;
              stored.missingStreak = Math.max(0, Number(stored.missingStreak) || 0) + 1;
              if (stored.missingStreak >= 2) {
                const wasSellable = stored.available === true
                  || (stored.variants || []).some((variant) => variant.available === true);
                stored.available = false;
                stored.status = 'unavailable';
                stored.variants = (stored.variants || []).map((variant) => ({
                  ...variant,
                  stock: 0,
                  available: false
                }));
                stored.confirmedAbsentAt ||= completedAt;
                if (wasSellable) this.log(`${target.name}｜${stored.title}：連續兩輪未出現在健康分類頁，已轉為不可購買但保留歷史基線。`);
              }
            }
          }
          storage.targets[target.id] = {
            initialized: true,
            seen: nextSeen,
            discoveryPages: nextDiscoveryPages,
            excluded: nextExcluded,
            lastScanAt: completedAt,
            lastProductCount: products.length,
            ...(esliteScan ? {
              lastSourceProductCount: esliteScan.sourceProductCount,
              lastSuccessfulSources: esliteScan.successfulSources,
              lastFreshVerifiedCount: esliteScan.freshVerifiedCount,
              esliteRoutes: esliteScan.routes || previousTarget.esliteRoutes || null
            } : {}),
            lastExcludedCount: excludedProducts.length,
            baselineVersion: target.baselineVersion || '',
            lastError: ''
          };
          if (!inventoryOnly) {
            if (esliteScan) {
              this.log(`${target.name}：本輪來源讀取 ${esliteScan.sourceProductCount} 件、即時商品頁確認 ${esliteScan.freshVerifiedCount} 件；合併既有基線後追蹤 ${products.length} 件。`);
            } else if (scanSourceMode.startsWith('momo-store-direct')) {
              const hadChanges = summary.restocked > 0
                || summary.stockChanged > 0
                || summary.discovered > 0
                || summary.variantChanges.length > 0;
              if (hadChanges || scanSourceMode.endsWith('with-discovery')) {
                this.log(`${target.name}：momo 詳細 API 專線確認 ${momoDirectSuccesses}/${products.length} 件${scanSourceMode.endsWith('with-discovery') ? '；新品清單亦已更新' : ''}。`);
              } else {
                this.logMomoStoreThrottled(
                  `healthy:${target.id}`,
                  `${target.name}：momo 詳細 API 專線運作正常，追蹤 ${products.length} 件商品。`
                );
              }
            } else {
              this.log(`${target.name}：讀取 ${products.length} 件商品。`);
            }
          }
        } catch (error) {
          summary.errors.push(`${target.name}：${error.message}`);
          storage.targets[target.id] = {
            ...(storage.targets[target.id] || { initialized: false, seen: {} }),
            lastScanAt: completedAt,
            lastError: error.message
          };
          this.log(`${target.name} 掃描失敗：${error.message}`);
        }
      }
      summary.durationMs = Date.now() - startedAt;
      storage.lastScan = summary;
      if (!inventoryOnly) storage.lastFullScanAt = summary.completedAt;
      await this.state.save();
      return summary;
    } finally {
      for (const target of requestedTargets) this.runningTargets.delete(String(target.id));
      this.running = this.runningTargets.size > 0;
    }
  }

  async close() {
    this.esliteClosed = true;
    for (const job of this.esliteVerificationQueue.splice(0)) {
      this.esliteVerificationJobs.delete(job.key);
      job.resolve(null);
    }
    await Promise.allSettled([...this.esliteVerificationJobs.values()]);
    await Promise.allSettled([...this.notificationTasks]);
    await this.resetEsliteApiContext();
    await this.browserPromise?.catch(() => {});
    await this.mmToyPage?.close().catch(() => {});
    this.mmToyPage = null;
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.esliteHolmesTemplates.clear();
    this.momoStoreLastDiscoveryAt.clear();
    this.momoStoreLastLogAt.clear();
    this.esliteSearchBrowserBlockedUntil = 0;
    this.esliteExhibitBlockedUntil = 0;
  }
}
