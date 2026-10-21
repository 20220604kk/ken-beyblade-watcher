// Authenticated Amazon website HTTP contracts, not a public purchasing API.
// The account's BrowserContext.request owns cookies; no credential handoff files.
import { load } from 'cheerio';
import { amazonCheckoutStockState, amazonStockWaitUrl } from './amazon-checkout-stock-wait.js';
import { AMAZON_JP_SELLER_ID, extractModelCode, parseYen } from './amazon-jp-monitor.js';
import { amazonBuyButton, amazonProductPrice, amazonCheckoutRenderUrl, amazonPrimeDecline,
  amazonCartEntry, amazonSmartWagonEntry, amazonItemSelection } from './amazon-checkout-flow.js';

export const AMAZON_HTTP_ORIGIN = 'https://www.amazon.co.jp';
const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const text = value => String(value || '').replace(/\s+/g, ' ').trim();
const bodyText = $ => {
  const root = $.root().clone();
  root.find('script,style,noscript').remove();
  root.find('div,p,section,h1,h2,h3,h4,h5,li,tr,td,span,br').prepend(' ').append(' ');
  return text(root.text());
};
const fail = (message, code = 'AMAZON_HTTP_CONTRACT') => Object.assign(new Error(message), { code });
const isSeller = ($, scope) => scope.find(`a[href*="seller=${AMAZON_JP_SELLER_ID}"]`).toArray()
  .some(node => { try { return new URL($(node).attr('href'), AMAZON_HTTP_ORIGIN).searchParams.get('seller') === AMAZON_JP_SELLER_ID; } catch { return false; } })
  || /(?:販売元|出品者|卖家|賣家|Seller)\s*[:：]?\s*(?:Amazon\.co\.jp|アマゾンジャパン)(?![A-Za-z0-9._-])/i.test(text(scope.text()));
const stockLimited = value => /購入数の上限|購入数量制限|maximum purchase quantity|ご指定の数量をご用意できません|无法再提供您所请求的数量|已達.*限購|已达到.*上限/i.test(value);

export function amazonAodUrl(asin) {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw fail('日亞 ASIN 格式無效');
  const url = new URL('/gp/product/ajax/aodAjaxMain/ref=dp_aod_unknown_mbc', AMAZON_HTTP_ORIGIN);
  url.searchParams.set('asin', asin);
  url.searchParams.set('pc', 'dp');
  url.searchParams.set('isonlyrenderofferlist', 'false');
  return url.href;
}

export function amazonHttpForm(page, form, submitName = '') {
  const $ = page.$;
  if (!$(form).length) throw fail('日亞官方表單缺失，本次不送出');
  const formNode = $(form).get(0), formId = $(form).attr('id');
  // Form-associated controls can live outside their owning form, or inside a
  // different form. Descendant-only scraping included unrelated CSRF fields.
  const controls = $('input[name],select[name],textarea[name],button[name]').filter((_, node) => {
    const explicitOwner = $(node).attr('form');
    return explicitOwner !== undefined ? Boolean(formId && explicitOwner === formId)
      : $(node).closest('form').get(0) === formNode;
  });
  const submitters = controls.filter((_, node) => {
    const control = $(node), type = (control.attr('type') || (node.tagName === 'button' ? 'submit' : 'text')).toLowerCase();
    return control.attr('name') === submitName && type === 'submit' && !control.is('[disabled]');
  });
  if (submitters.length > 1) throw fail('日亞送出按鈕不唯一，本次不送出');
  const submitter = submitters.first();
  // Native HTML submission gives the clicked button's attributes precedence.
  // Amazon's Buy Now uses /checkout/entry/buynow, while its enclosing form's
  // handle-buy-box action can return 404. Never guess or hardcode a fallback.
  const action = submitter.attr('formaction') ?? $(form).attr('action');
  const method = (submitter.attr('formmethod') ?? $(form).attr('method') ?? 'GET').toUpperCase();
  const encoding = (submitter.attr('formenctype') ?? $(form).attr('enctype') ?? 'application/x-www-form-urlencoded').toLowerCase();
  const url = new URL(action || page.url, page.url);
  if (url.origin !== AMAZON_HTTP_ORIGIN || url.username || url.password) throw fail('日亞表單不是官方網域');
  if (!['GET', 'POST'].includes(method)) throw fail('日亞表單方法未支援');
  if (method === 'POST' && encoding !== 'application/x-www-form-urlencoded') throw fail('日亞表單編碼未支援');
  const fields = new URLSearchParams();
  controls.each((_, node) => {
    const e = $(node), type = (e.attr('type') || '').toLowerCase(), name = e.attr('name');
    if (!name || e.is('[disabled]') || ['button', 'reset', 'image', 'file'].includes(type)) return;
    if (['checkbox', 'radio'].includes(type) && !e.is('[checked]')) return;
    if ((type === 'submit' || node.tagName === 'button') && name !== submitName) return;
    const value = node.tagName === 'select'
      ? e.find('option[selected]').first().attr('value') ?? e.find('option').first().attr('value')
      : node.tagName === 'textarea' ? e.text() : e.attr('value');
    fields.append(name, value ?? (type === 'checkbox' ? 'on' : ''));
  });
  return { url: url.href, method, fields };
}

export function parseAmazonAod(page, asin) {
  const $ = page.$;
  const title = text($('#aod-asin-title-text').first().text());
  const offers = $('#aod-offer, #aod-pinned-offer').toArray().map(node => {
    const scope = $(node);
    const priceText = text(scope.find('.apex-pricetopay-accessibility-label,.a-price .a-offscreen').first().text())
      || text(scope.find('.apex-pricetopay-value').first().text());
    const condition = text(scope.find('#aod-offer-heading, #aod-offer-condition').text());
    const newCondition = /^(?:新品|全新(?:品)?|New)(?:\s|$)/i.test(condition);
    const form = scope.find('form').filter((_, n) => $(n).find('[name="items[0.base][asin]"]').attr('value') === asin).first();
    let contract;
    try { if (form.length) contract = amazonHttpForm(page, form, 'submit.addToCart'); } catch { /* fail closed */ }
    const addAvailable = Boolean(contract && contract.method === 'POST'
      && /^\/cart\/add-to-cart(?:\/|$)/.test(new URL(contract.url).pathname)
      && contract.fields.get('items[0.base][asin]') === asin
      && contract.fields.get('items[0.base][offerListingId]')
      && contract.fields.get('anti-csrftoken-a2z')
      && ['', '1'].includes(contract.fields.get('items[0.base][quantity]')));
    const priceYen = parseYen(priceText);
    const sellerConfirmed = isSeller($, scope.find('#aod-offer-soldBy'));
    // Only classifications and booleans escape the parser, never form values,
    // offer IDs, CSRF tokens, cookies or raw response bodies.
    const rejected = [];
    if (!sellerConfirmed) rejected.push('seller_not_amazon');
    if (!newCondition) rejected.push('condition_not_new');
    if (!form.length) rejected.push('missing_add_form');
    else if (!contract) rejected.push('invalid_form_contract');
    else {
      if (contract.method !== 'POST') rejected.push('invalid_add_method');
      if (!/^\/cart\/add-to-cart(?:\/|$)/.test(new URL(contract.url).pathname)) rejected.push('invalid_add_path');
      if (contract.fields.get('items[0.base][asin]') !== asin) rejected.push('wrong_asin');
      if (!contract.fields.get('items[0.base][offerListingId]')) rejected.push('missing_offer_id');
      if (!contract.fields.get('anti-csrftoken-a2z')) rejected.push('missing_csrf');
      if (!['', '1'].includes(contract.fields.get('items[0.base][quantity]'))) rejected.push('invalid_quantity');
    }
    if (!(priceYen > 0)) rejected.push('price_unreadable');
    return { form, contract, priceText, priceYen, sellerConfirmed, rejected,
      newCondition, addAvailable, purchaseLimited: stockLimited(text(scope.text())) };
  });
  const eligible = offers.filter(o => o.sellerConfirmed && o.newCondition && o.addAvailable && o.priceYen > 0);
  eligible.sort((a, b) => a.priceYen - b.priceYen);
  const offer = eligible[0];
  const retail = offers.filter(item => item.sellerConfirmed);
  const retailNew = retail.filter(item => item.newCondition);
  const decision = offer ? 'qualified' : !offers.length ? 'no_offers'
    : !retail.length ? 'no_amazon_retail_offer' : !retailNew.length ? 'no_new_amazon_retail_offer'
      : !retailNew.some(item => item.addAvailable) ? 'retail_contract_incomplete' : 'retail_price_unreadable';
  const rejectionCounts = {};
  for (const item of offers) for (const reason of item.rejected) rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
  // An explicit AOD scaffold or sold-out message is required; blank HTTP 200
  // must not silently become an ordinary out-of-stock observation.
  const recognized = Boolean(title && ($('#aod-container, #aod-offer-list, #aod-filter-offer-count-string, #aod-offer, #aod-pinned-offer').length
    || /在庫切れ|現在お取り扱い|没有其他购买选项|No offers/i.test(bodyText($))));
  const snapshot = { url: `${AMAZON_HTTP_ORIGIN}/dp/${asin}`, asin, title, code: extractModelCode(title),
    priceText: offer?.priceText || '', priceYen: offer?.priceYen || null,
    sellerConfirmed: Boolean(offer), purchaseLimited: offer?.purchaseLimited || false,
    buyNowAvailable: false, addCartAvailable: Boolean(offer), loginRequired: false,
    pageIssue: recognized ? '' : 'product_unreadable', transport: 'api',
    diagnostic: { httpStatus: 200, hasProductTitle: Boolean(title), hasPrice: Boolean(offer?.priceYen),
      hasBuyButton: Boolean(offer), offerCount: offers.length, transport: 'api',
      decision, retailOfferCount: retail.length, retailNewOfferCount: retailNew.length,
      retailAddableCount: retailNew.filter(item => item.addAvailable).length, rejectionCounts } };
  return { snapshot, offer };
}

export function amazonOfferDecisionText(diagnostic = {}) {
  return ({ no_direct_buy_button: '商品頁目前沒有可用的立即購買按鈕；未進入結帳，繼續等待補貨',
    no_offers: '報價列表目前沒有商品報價',
    no_amazon_retail_offer: '目前報價中沒有確認為 Amazon.co.jp 自營的賣家',
    no_new_amazon_retail_offer: '有自營報價，但未確認為全新商品',
    retail_contract_incomplete: '有全新自營報價，但加車表單或必要欄位不完整（不能判定售罄）',
    retail_price_unreadable: '有全新自營加車表單，但無法辨識日圓價格（不能判定售罄）'
  })[diagnostic.decision] || '未取得符合條件的可購報價，原因尚未明確';
}

export function parseAmazonDirectBuyForm(page, expected) {
  const $ = page.$, button = amazonBuyButton($);
  if (!button.length) {
    throw fail('商品頁沒有可用的立即購買按鈕', 'AMAZON_DIRECT_BUY_UNAVAILABLE');
  }
  const form = button.closest('form'), submitName = button.attr('name'), contract = amazonHttpForm(page, form, submitName);
  const merchant = contract.fields.get('merchantID');
  const asins = [contract.fields.get('ASIN'), contract.fields.get('items[0.base][asin]')].filter(Boolean);
  const quoteCurrency = contract.fields.get('items[0.base][customerVisiblePrice][currencyCode]');
  const quoteAmount = Number(contract.fields.get('items[0.base][customerVisiblePrice][amount]'));
  const visiblePrice = amazonProductPrice($, parseYen);
  const price = quoteCurrency === 'JPY' && quoteAmount > 0 ? quoteAmount : visiblePrice;
  let sameFreshOffer = false;
  try { sameFreshOffer = Boolean(expected.freshOfferId) && decodeURIComponent(contract.fields.get('offerListingID') || '') === decodeURIComponent(expected.freshOfferId); }
  catch { /* an unbound or malformed offering is not price evidence */ }
  // Display currency may be TWD. Never convert it ourselves or call it JPY:
  // only the exact fresh AOD offering can carry its verified JPY quote forward.
  // The final official checkout must still reconcile JPY amounts exactly.
  const priceConfirmed = price === expected.priceYen
    || price === null && quoteCurrency !== 'JPY' && sameFreshOffer;
  const quantities = ['quantity', 'items[0.base][quantity]'].map(k => contract.fields.get(k)).filter(v => v !== null && v !== '');
  const sellerScope = $('#merchantInfoFeature_feature_div, #merchant-info, #tabular-buybox');
  if (contract.method !== 'POST' || !/^(?:\/gp\/product\/handle-buy-box\/[^?#]+|\/checkout\/entry\/buynow\/?$)/.test(new URL(contract.url).pathname)
    || !contract.fields.get('anti-csrftoken-a2z') || !contract.fields.get('offerListingID')
    || !asins.length || asins.some(asin => asin !== expected.asin) || !quantities.length || quantities.some(v => v !== '1')
    || /中古|二手|非全新|Used|Renewed/i.test(text($('#buybox #condition, #buybox .condition').text()))
    || !priceConfirmed) throw fail('立即購買商品／賣家／價格或表單未核對，不改走加車', 'AMAZON_DIRECT_BUY_CONTRACT');
  if (merchant !== AMAZON_JP_SELLER_ID || !isSeller($, sellerScope)) {
    throw fail('主購買區未確認為 Amazon.co.jp 自營，可另讀 AOD 核對', 'AMAZON_DIRECT_BUY_SELLER');
  }
  return { form, contract, submitName };
}

export function amazonOrderIdFromCompletion(page) {
  const $ = page.$, url = new URL(page.url, AMAZON_HTTP_ORIGIN);
  if (url.origin !== AMAZON_HTTP_ORIGIN || !/\/(?:gp\/buy\/thankyou\/|checkout\/.*(?:thank|confirmation))/.test(url.pathname)
    || !/订单已提交|訂單已提交|ご注文ありがとうござい(?:ます|ました)|注文が確定|Thank you.*order|Order placed/i.test(bodyText($))) return '';
  const labelled = bodyText($).match(/(?:注文番号|订单编号|訂單編號|Order (?:number|#))\s*[:：#]?\s*(\d{3}-\d{7}-\d{7})/i)?.[1];
  const ids = [...new Set([labelled, ...$('a[href*="order-details"]').toArray().map(node => {
    try {
      const link = new URL($(node).attr('href'), page.url);
      const id = link.searchParams.get('orderID');
      return link.origin === AMAZON_HTTP_ORIGIN && ORDER_ID.test(id || '') ? id : '';
    } catch { return ''; }
  })].filter(Boolean))];
  // purchaseId / executionId are never an order number.
  return ids.length === 1 ? ids[0] : '';
}

function exactTargetCart(cart, asin) {
  return cart.count === 1 && cart.items.length === 1
    && cart.items[0].asin === asin && cart.items[0].quantity === 1;
}

function cartMatchesFreshOffer(page, offer) {
  const encoded = page.$('#sc-active-cart [data-asin]').first().attr('data-encoded-offering');
  const fresh = offer?.contract?.fields.get('items[0.base][offerListingId]');
  if (!encoded || !fresh) return false;
  // Bind the cart's seller/condition offer, not just the ASIN. Both values stay
  // in memory and are never put in diagnostics or the durable transaction.
  try { return decodeURIComponent(encoded) === decodeURIComponent(fresh); }
  catch { return false; }
}

export function parseAmazonHttpCart(page) {
  const $ = page.$;
  const countText = text($('#nav-cart-count').first().text());
  const count = /^\d+$/.test(countText) ? Number(countText) : null;
  const items = $('#sc-active-cart [data-asin]').filter((_, n) => {
    const e = $(n);
    return e.attr('data-asin') && !e.is('[data-removed="true"]') && !e.parents('[data-asin]').length;
  }).toArray().map(n => {
    const e = $(n);
    const q = e.attr('data-quantity') || e.find('select[name*="quantity"] option[selected], input[name*="quantity"]').first().attr('value')
      || text(e.find('[data-a-selector="inner-value"]').first().text());
    return { asin: e.attr('data-asin'), quantity: /^\d+$/.test(q || '') ? Number(q) : null,
      sellerConfirmed: isSeller($, e) };
  });
  const empty = count === 0 && !items.length && /购物车为空|購物車為空|カートは空|カートに商品はありません|cart is empty/i.test(bodyText($));
  return { count, items, empty };
}

function moneyAfter(value, labels) {
  const pattern = new RegExp(`(?:${labels})\\s*[:：]?\\s*(?:JPY\\s*|JP[¥￥]\\s*|[¥￥]\\s*)([\\d,]+(?:\\.\\d+)?)`, 'gi');
  const amounts = [...value.matchAll(pattern)].map(m => Number(m[1].replace(/,/g, '')));
  const distinct = [...new Set(amounts)];
  return distinct.length === 1 && Number.isSafeInteger(distinct[0]) ? distinct[0] : null;
}

export function parseAmazonHttpReview(page, expected) {
  const $ = page.$, value = bodyText($);
  if (amazonCheckoutStockState(page, expected.asin) === 'empty') throw fail('Amazon 購物車已空，回商品頁等待新報價', 'AMAZON_CHECKOUT_CART_EMPTY');
  // The official update-items page is an ordinary stock race, not a missing
  // final-submit contract. Never press its Continue button or submit quantity 0.
  if (!$('#spc-form').length && amazonCheckoutStockState(page, expected.asin) === 'stock_wait') {
    throw fail('結帳時庫存不足，尚未執行最終送單；回到商品監控重試', 'AMAZON_CHECKOUT_STOCK_CHANGED');
  }
  const form = $('#spc-form').first();
  // A 200 header/footer shell is neither stock loss nor a usable checkout.
  if (!form.length && $('#nav-checkout-title, #nav-checkout-title-header').length
    && !$('[id^="item-block-"], [id^="checkout-item-block-"], .lineitem, .a-alert-content, input[type="submit"], button[type="submit"]').length) {
    throw fail('安全結帳只收到空白頁框，未取得商品與送單表單；下一輪改用背景瀏覽器入口', 'AMAZON_CHECKOUT_SHELL');
  }
  const contract = amazonHttpForm(page, form, 'placeYourOrder1');
  if (contract.method !== 'POST' || !/^\/checkout\/p\/[^/]+\/spc\/place-order$/.test(new URL(contract.url).pathname)
    || !contract.fields.get('anti-csrftoken-a2z') || !contract.fields.get('currentViewId')) throw fail('日亞最終結帳契約未完整取得');
  const titles = [...new Set($('[id^="item-block-product-title-"], [id^="checkout-item-block-item-primary-title-"], .lineitem-title-text')
    .toArray().map(n => text($(n).text())).filter(Boolean))];
  const linkedAsins = $('a[href*="/dp/"], a[href*="/gp/product/"]').toArray()
    .filter(n => $(n).closest('[id^="item-block"], [id^="checkout-item-block"], .lineitem, .checkout-item-block').length)
    .map(n => $(n).attr('href')?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase()).filter(Boolean);
  const itemRoots = $('[id^="checkout-item-block-"], [id^="item-block-"], .lineitem, .checkout-item-block')
    .filter((_, n) => /^(?:checkout-item-block|item-block)-\d+$/.test($(n).attr('id') || '') || $(n).is('.lineitem,.checkout-item-block'));
  const metadataAsins = [];
  const collect = value => { if (/^[A-Z0-9]{10}$/i.test(value || '')) metadataAsins.push(value.toUpperCase()); };
  function collectState(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^asin$/i.test(key)) collect(child);
      else if (child && typeof child === 'object') collectState(child);
    }
  }
  itemRoots.each((_, root) => {
    const controls = $(root).find('*').addBack();
    controls.each((_, node) => {
      const e = $(node);
      collect(e.attr('data-asin')); collect(e.attr('data-csa-c-asin'));
      // Live Tango checkout shows the ASIN as a hidden text marker, not a
      // product link. Scope it to the actual item's description, never ads,
      // arbitrary page text, or the expected/requested ASIN.
      if (e.is('span.aok-hidden') && e.parent().is('#col-item-block-description')) collect(text(e.text()));
      if (e.is('input') && /(?:^|[\[.])asin(?:\]|$)/i.test(e.attr('name') || '')) collect(e.attr('value'));
      if (e.is('script[type="a-state"],script[type="application/json"]')) {
        try { collectState(JSON.parse(e.html() || '')); } catch { /* no unstructured string scraping */ }
      }
    });
  });
  const asins = [...new Set([...linkedAsins, ...metadataAsins])];
  const quantities = $('[data-a-selector="inner-value"], select[name*="quantity"] option[selected]').toArray()
    .map(n => text($(n).text())).filter(v => /^\d+$/.test(v)).map(Number);
  const quantityLabel = value.match(/(?:数量|數量|個数|Quantity)\s*[:：]?\s*(\d+)/i)?.[1];
  const quantity = quantities.length && quantities.every(q => q === 1) ? 1 : quantities.length ? null : quantityLabel ? Number(quantityLabel) : null;
  const currencyForm = $('form').filter((_, n) => $(n).find('[name="selectedCurrencyOption"]').attr('value') === 'MARKETPLACE'
    && /JPY/.test($(n).find('[name="placeYourOrderButtonText"]').attr('value') || '')).first();
  const hasChoice = currencyForm.length && $('input[name="currencyOptions"][value="MARKETPLACE"]').length;
  const selectedJPY = contract.fields.get('currentCurrencyOption') === 'MARKETPLACE';
  if (!hasChoice && !selectedJPY) throw fail('日亞沒有可核對的 JPY 官方付款選項');
  const label = hasChoice ? currencyForm.find('[name="placeYourOrderButtonText"]').attr('value') : contract.fields.get('placeYourOrder1');
  if (!label || !/JPY|注文を確定|Place your order/i.test(label)) throw fail('日亞 JPY 送單按鈕契約未辨識');
  const totalYen = moneyAfter(value, '注文合計|注文の合計|ご請求額|订单总计|訂單總計|Order total');
  const shippingYen = moneyAfter(value, '配送料(?:・手数料)?|配送費(?:/手續費)?|配送费(?:/手续费)?|运费|運費|Shipping(?: & handling)?');
  const subtotalYen = moneyAfter(value, '商品の小計|商品(?:の合計)?|Items(?: subtotal)?');
  // Full-price reconciliation prevents a silently applied points balance or
  // promotion from being mistaken for the approved quote. Unknown != zero.
  const pointsInputs = $('input[name]').toArray().filter(n => /(?:pointsToApply|pointsToRedeem|redeemPoints|usePoints)/i.test($(n).attr('name')));
  const pointsApplied = pointsInputs.some(n => {
    const e = $(n); return ['checkbox', 'radio'].includes(e.attr('type')) ? e.is('[checked]') : !['', '0', 'false'].includes(e.attr('value') || '');
  }) || /(?:ポイント利用|使用点数|使用點數|Points applied)\s*[:：]?\s*(?:JPY\s*|[¥￥]\s*)?[1-9][\d,]*/i.test(value);
  if (pointsApplied || subtotalYen !== expected.priceYen || totalYen !== subtotalYen + shippingYen) throw fail('日亞折點／折扣或金額無法核對，保留購物車、不送單');
  const checkout = { url: page.url, asin: asins[0] || '', asins, title: titles[0] || '', itemTitles: titles,
    identitySource: metadataAsins.length ? 'line_item_metadata' : linkedAsins.length ? 'line_item_link' : 'missing',
    code: extractModelCode(titles[0]), itemCount: titles.length, quantity,
    sellerConfirmed: $('[id^="item-block-product-title-"], [id^="checkout-item-block-item-primary-title-"], .lineitem-title-text').toArray()
      .every(n => isSeller($, $(n).parents('[id^="item-block"], [id^="checkout-item-block"], .lineitem, .checkout-item-block').first())),
    deliveryConfirmed: Boolean(text($('#shipping-address, #shipping-address-section, [data-testid="shipping-address"], .shipping-address, #change-delivery-link #deliver-to-address-text').text()))
      || /(?:お届け先|配送先|配送地址|收貨地址|Shipping address)\s*[:：]\s*\S+/i.test(value),
    shippingYen, totalYen, pointsUsed: 0, stockLimited: stockLimited(value) };
  return { checkout, form, contract, overrides: { currentCurrencyOption: 'MARKETPLACE', placeYourOrder1: label,
    hasWorkingJavascript: '1', setOrderingPrefs: '' } };
}

export function amazonOfficialOrderIds(page) {
  const $ = page.$;
  const cards = $('.order-card').toArray();
  const recognized = Boolean(cards.length || /注文.*ありません|尚无订单|没有订单|No orders|You have not placed any orders/i.test(bodyText($)));
  if (!recognized) throw fail('日亞官方訂單列表未完整取得');
  const ids = cards.flatMap(n => {
    const e = $(n);
    const metadata = e.attr('data-csa-c-slot-id')?.match(/^amzn1\.yourorders\.order-card\.(\d{3}-\d{7}-\d{7})$/)?.[1];
    const links = e.find('a[href*="/your-orders/order-details"]').toArray().map(a => {
      try { const url = new URL($(a).attr('href'), page.url); return url.origin === AMAZON_HTTP_ORIGIN ? url.searchParams.get('orderID') : null; } catch { return null; }
    });
    const values = [metadata, ...links].filter(id => ORDER_ID.test(id || ''));
    if (!values.length) throw fail('日亞訂單卡片沒有正式識別資料，不能當作空基準');
    return values;
  });
  return [...new Set(ids)];
}

export function matchesAmazonOfficialDetail(page, orderId, expected) {
  const $ = page.$, value = bodyText($);
  const asins = [...new Set($('a[href*="/dp/"], a[href*="/gp/product/"]').toArray()
    .map(n => $(n).attr('href')?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]).filter(Boolean))];
  const total = moneyAfter(value, '総計|注文合計|注文の合計|ご請求額|订单总计|訂單總計|金额|金額|Grand Total|Order total');
  const shipping = moneyAfter(value, '配送料(?:・手数料)?|配送费/手续费|配送費/手續費|Shipping(?: & handling)?');
  const cancelled = /キャンセル済み|已取消|訂單取消|Cancelled|Canceled/i.test(value);
  // An unrelated new order is not ours. Missing quantity/time proof stays
  // unresolved rather than guessing from the first new card.
  const explicitQuantity = value.match(/(?:数量|數量|個数|Quantity)\s*[:：]?\s*(\d+)/i)?.[1];
  // The live order-detail page omits a quantity label for a single unit. Do
  // not infer "1" merely from absence: require both official item subtotal
  // and the Amazon seller's unit price to equal the approved one-unit price.
  const subtotal = moneyAfter(value, '商品小计|商品小計|商品の小計|Items subtotal');
  const unitPrice = moneyAfter(value, '(?:販売元|卖家|賣家|Seller)\\s*[:：]?\\s*(?:Amazon\\.co\\.jp|アマゾンジャパン)');
  const quantity = explicitQuantity ? Number(explicitQuantity)
    : subtotal === expected.priceYen && unitPrice === expected.priceYen ? 1 : null;
  return ORDER_ID.test(orderId) && value.includes(orderId) && !cancelled
    && asins.length === 1 && asins[0] === expected.asin && quantity === 1
    && total === expected.totalYen && shipping === expected.shippingYen && isSeller($, $.root());
}

export class AmazonJpHttpClient {
  constructor({ request, recordStep = async () => {}, checkpoint = async () => {}, canContinue = () => true, parallelPreflight = false, fastCheckout = false, directBuyNow = false, idleOrderBaseline = null, captureEvidence = () => {}, authorizeFinalSubmit = async () => {}, browserDirectEntry = null,
    stockWaitEnabled = false, stockWaitIntervalMs = 1000, retailFallbackEnabled = false, stockWait = null, onStockWait = async () => {}, waitFor = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.transport = request;
    this.recordStep = recordStep;
    this.checkpoint = checkpoint;
    this.canContinue = canContinue;
    this.authorizeFinalSubmit = authorizeFinalSubmit;
    this.browserDirectEntry = browserDirectEntry;
    this.parallelPreflight = parallelPreflight === true;
    this.fastCheckout = fastCheckout === true;
    this.directBuyNow = directBuyNow === true;
    this.idleOrderBaseline = idleOrderBaseline;
    this.addAttempted = false;
    this.submitted = false;
    this.captureEvidence = captureEvidence;
    this.checkoutEvidenceStarted = false;
    this.checkoutTrace = [];
    Object.assign(this, { stockWaitEnabled, stockWait, onStockWait, waitFor, retailFallbackEnabled });
    this.stockWaitIntervalMs = Math.min(1000, Math.max(250, Number(stockWaitIntervalMs) || 1000));
  }

  beginCheckoutEvidence(page) {
    this.checkoutEvidenceStarted=true;this.evidenceFallback=page;
    this.lastCheckoutResponse=null;this.lastCheckoutRequest=null;
    this.emitEvidence('entry',page,{source:'02 入口前一頁；尚未取得安全結帳回應'});
  }

  emitEvidence(kind,page,extra={}) {
    try {
      const result=this.captureEvidence(kind,{html:page?.html ?? page?.$?.html?.() ?? '',url:page?.url,
        status:page?.status,method:this.lastCheckoutRequest?.method || 'GET',trace:this.checkoutTrace.map(item=>({...item})),...extra});
      result?.catch?.(()=>{});
    } catch { /* Evidence capture cannot turn a purchase into a retry. */ }
  }

  captureFailure(error) {
    if(!this.checkoutEvidenceStarted)return;
    const response=this.lastCheckoutRequest?.responseReceived?this.lastCheckoutResponse:null;
    this.emitEvidence('failure',response || this.evidenceFallback,{url:this.lastCheckoutRequest?.url,
      status:this.lastCheckoutRequest?.status ?? null,method:this.lastCheckoutRequest?.method,
      source:response?'官方失敗回應（離線呈現）':'未收到回應；前一頁僅供定位',error:error.message,errorCode:error.code});
  }

  async request(url, { method = 'GET', fields, referer } = {}) {
    const started = performance.now();
    const requestMethod = method;
    const requestPath = new URL(url, AMAZON_HTTP_ORIGIN).pathname;
    const requestScope = /order-history|\/your-orders\/orders/.test(requestPath) ? 'order_history'
      : /order-details/.test(requestPath) ? 'order_detail'
        : /\/checkout\/|\/gp\/buy\/|handle-buy-box|\/prime\/handler(?:\/|$)/.test(requestPath) ? 'checkout'
          : /\/gp\/cart\/|^\/cart(?:\/|$)/.test(requestPath) ? 'cart'
            : /\/dp\/|\/gp\/product\/|aodAjaxMain/.test(requestPath) ? 'product' : 'other';
    try {
    for (let redirects = 0; redirects < 6; redirects++) {
      const target = new URL(url, AMAZON_HTTP_ORIGIN);
      if (target.origin !== AMAZON_HTTP_ORIGIN) throw fail('日亞 API 拒絕跨網域請求');
      if (/\/ap\/(?:mfa|cvf)/i.test(target.pathname)) throw fail('此流程要求額外驗證，商品登入狀態另行核對', 'AMAZON_VERIFICATION_REQUIRED');
      if (/\/ap\/signin/i.test(target.pathname) && method !== 'GET') throw fail('登入只使用官方登入視窗，本流程不代送登入表單', 'AMAZON_LOGIN_REQUIRED');
      const headers = { Accept: '*/*', 'Accept-Language': 'ja-JP,zh-CN;q=0.8,en;q=0.6' };
      if (referer) headers.Referer = referer;
      if (fields) Object.assign(headers, { Origin: AMAZON_HTTP_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' });
      if(this.checkoutEvidenceStarted){this.lastCheckoutRequest={url:target.href,method,status:null,responseReceived:false};this.checkoutTrace.push(this.lastCheckoutRequest);this.checkoutTrace=this.checkoutTrace.slice(-60);}
      let response, html, status, responseHeaders;
      try {
        // maxRetries=0 is essential: a timed-out mutation must never be replayed.
        response = await this.transport.fetch(target.href, { method, data: fields?.toString(), headers,
          timeout: 15_000, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false });
        status = response.status(); responseHeaders = response.headers(); html = await response.text();
        if(this.checkoutEvidenceStarted){Object.assign(this.lastCheckoutRequest,{status,responseReceived:true});this.lastCheckoutResponse={url:target.href,html,status};}
      } catch { throw fail(`日亞 API ${method === 'POST' ? '送出後回應不明' : '讀取逾時或連線中斷'}`, 'AMAZON_HTTP_TIMEOUT'); }
      finally { await response?.dispose?.().catch(() => {}); }
      if ([429, 503].includes(status) || responseHeaders['retry-after']) {
        const raw = responseHeaders['retry-after'];
        const retry = /^\d+$/.test(raw || '') ? Number(raw) * 1000 : Date.parse(raw || '') - Date.now();
        throw Object.assign(fail(`日亞 HTTP ${status}，停止本輪並降速`, 'AMAZON_RATE_LIMITED'),
          { httpStatus: status, retryAfterMs: Math.max(60_000, Number.isFinite(retry) ? retry : 0) });
      }
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (method === 'POST' && [307, 308].includes(status)) throw fail('日亞要求重送 POST，保留狀態並停止，不重送');
        if (!responseHeaders.location) throw fail('日亞跳轉目標缺失');
        url = new URL(responseHeaders.location, target).href; referer = target.href;
        if (method === 'POST') { method = 'GET'; fields = undefined; }
        continue;
      }
      const $ = load(html || '');
      if ($('form[action*="validateCaptcha"], #captchacharacters, form[action*="/ap/cvf"]').length
        || /Robot Check|Enter the characters you see|画像に表示されている文字/i.test(bodyText($))) throw fail('日亞要求人工驗證，請在登入視窗處理', 'AMAZON_VERIFICATION_REQUIRED');
      if ($('#ap_email, #ap_password, form[name="signIn"]').length) throw fail('此流程顯示官方登入表單，請開啟登入視窗核對', 'AMAZON_LOGIN_REQUIRED');
      if (status === 404) {
        if (this.checkoutEvidenceStarted) throw fail('日亞結帳入口回傳 HTTP 404，尚未取得安全結帳頁；保留證據，不重送', 'AMAZON_CHECKOUT_NOT_FOUND');
        throw fail('日亞 API 商品／頁面不存在', 'AMAZON_PRODUCT_NOT_FOUND');
      }
      if (status !== 200) throw fail(`日亞 HTTP ${status}，未取得可用契約`);
      const durationMs = Math.round(performance.now() - started);
      // Do not store query strings or flow/session IDs in timing telemetry.
      // Polling already records quoteMs in the snapshot; do not add another
      // synchronous state-file write to every two-second read.
      if (!/aodAjaxMain/.test(requestPath)) await this.recordStep('api_request_complete', { durationMs, method: requestMethod,
        result: /\/gp\/cart\/view/.test(requestPath) ? 'cart'
          : /order-history/.test(requestPath) ? 'order_history' : /order-details/.test(requestPath) ? 'order_detail'
            : /\/checkout\/entry\/cart/.test(requestPath) ? 'checkout_entry' : /\/spc\/place-order$/.test(requestPath) ? 'submit'
              : /\/cart\/add-to-cart\//.test(requestPath) ? 'add_cart' : 'official_response' });
      return { url: target.href, $, durationMs, html, status };
    }
    throw fail('日亞 API 跳轉次數超過上限');
    } catch (error) {
      // Keep the ORIGINAL operation across a sign-in redirect. No query,
      // cookies, session IDs or HTML enter the diagnostic metadata.
      error.requestScope = requestScope;
      if (requestScope === 'checkout' && error.code === 'AMAZON_LOGIN_REQUIRED') {
        error.code = 'AMAZON_CHECKOUT_AUTH_REQUIRED'; error.message = '結帳流程需要再次登入確認；商品監控繼續';
      }
      throw error;
    }
  }

  async sendForm(page, form, submitName, overrides = {}) {
    const contract = amazonHttpForm(page, form, submitName);
    for (const [k, v] of Object.entries(overrides)) contract.fields.set(k, v);
    if (contract.method === 'GET') {
      const url = new URL(contract.url);
      for (const [k, v] of contract.fields) url.searchParams.append(k, v);
      return this.request(url, { referer: page.url });
    }
    return this.request(contract.url, { method: 'POST', fields: contract.fields, referer: page.url });
  }

  async readOffer(asin) {
    const started = performance.now();
    const page = await this.request(amazonAodUrl(asin), { referer: `${AMAZON_HTTP_ORIGIN}/dp/${asin}` });
    const parsingStarted = performance.now();
    const parsed = parseAmazonAod(page, asin);
    parsed.snapshot.diagnostic.offerParseMs = Math.round(performance.now() - parsingStarted);
    parsed.snapshot.diagnostic.responseMs = page.durationMs;
    parsed.snapshot.diagnostic.quoteMs = Math.round(performance.now() - started);
    this.offerPage = page; this.offer = parsed.offer;
    this.offerSnapshot = parsed.snapshot; this.offerAt = Date.now();
    return parsed.snapshot;
  }

  async readRetailOffer(asin) {
    const started = performance.now();
    let direct;
    try { direct = await this.readDirectOffer(asin); }
    catch (error) {
      if (!this.retailFallbackEnabled || error.code !== 'AMAZON_DIRECT_BUY_SELLER') throw error;
    }
    if (!this.retailFallbackEnabled || direct?.buyNowAvailable || direct?.pageIssue || direct?.purchaseLimited) return direct;
    // AOD is a second website read only when the main Buy Box is unsuitable.
    // Its selected contract remains account-local and must be used this round.
    const snapshot = this.directAodProbe || await this.readOffer(asin);
    snapshot.offerSource = 'aod'; snapshot.diagnostic.route = 'aod_fallback';
    snapshot.diagnostic.quoteMs = Math.round(performance.now() - started);
    return snapshot;
  }

  async readDirectOffer(asin) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw fail('日亞 ASIN 格式無效');
    this.directProductPage = null; this.directProductSnapshot = null; this.directAodProbe = null;
    const started = performance.now();
    const page = await this.request(`/dp/${asin}?m=${AMAZON_JP_SELLER_ID}&language=ja_JP&currency=JPY`);
    const productReadAt = Date.now();
    const $ = page.$, button = amazonBuyButton($);
    const title = text($('#productTitle').first().text());
    const snapshot = { url: page.url, asin, title, code: extractModelCode(title),
      priceYen: null, priceText: '', sellerConfirmed: false, purchaseLimited: stockLimited(bodyText($)),
      buyNowAvailable: false, addCartAvailable: false, loginRequired: false,
      pageIssue: title ? '' : 'product_unreadable', transport: 'api',
      diagnostic: { httpStatus: page.status, hasProductTitle: Boolean(title), transport: 'api',
        route: 'direct_product', decision: 'no_direct_buy_button', responseMs: page.durationMs } };
    if (button.length && !button.is('[disabled],[aria-disabled="true"]')) {
      const contract = amazonHttpForm(page, button.closest('form'), button.attr('name'));
      const currency = contract.fields.get('items[0.base][customerVisiblePrice][currencyCode]');
      const amount = Number(contract.fields.get('items[0.base][customerVisiblePrice][amount]'));
      let price = currency === 'JPY' && amount > 0 ? amount
        : amazonProductPrice($, parseYen);
      let freshOfferId;
      // Only ambiguous display currency needs an AOD quote. Ordinary JPY
      // product pages need a single GET, not AOD then the same product GET.
      if (!(price > 0)) {
        const aod = await this.readOffer(asin);
        this.directAodProbe = aod;
        if (aod.sellerConfirmed && aod.priceYen > 0) {
          price = aod.priceYen;
          freshOfferId = this.offer?.contract?.fields.get('items[0.base][offerListingId]');
        }
      }
      if (price > 0) {
        parseAmazonDirectBuyForm(page, { asin, priceYen: price, freshOfferId });
        Object.assign(snapshot, { priceYen: price, priceText: `JPY ${price}`, sellerConfirmed: true, buyNowAvailable: true });
        snapshot.diagnostic.decision = 'qualified';
        this.directProductPage = page; this.directProductSnapshot = snapshot;
        this.directProductAt = productReadAt; this.directFreshOfferId = freshOfferId;
      } else snapshot.diagnostic.decision = 'retail_price_unreadable';
    }
    snapshot.diagnostic.hasBuyButton = snapshot.buyNowAvailable;
    snapshot.diagnostic.hasPrice = snapshot.priceYen > 0;
    snapshot.diagnostic.quoteMs = Math.round(performance.now() - started);
    return snapshot;
  }

  async confirmOrder(transaction, { attempts = 2 } = {}) {
    if (['direct_buy_now', 'aod_fast'].includes(transaction.route) && transaction.phase === 'confirmed' && ORDER_ID.test(transaction.orderId || '')) {
      return { status: 'ordered', snapshot: { orderId: transaction.orderId, url: `${AMAZON_HTTP_ORIGIN}/your-orders/order-details?orderID=${transaction.orderId}`, transport: 'api' } };
    }
    if (['direct_buy_now', 'aod_fast'].includes(transaction.route) && !Array.isArray(transaction.baselineOrderIds)) {
      // No pre-purchase history query on the direct path. Never misidentify an
      // older same-item order as this one when a completion response was lost.
      const confirmed = transaction.phase === 'confirmed' && ORDER_ID.test(transaction.orderId || '');
      return { status: confirmed ? 'ordered' : 'submitted_unconfirmed', snapshot: { orderId: confirmed ? transaction.orderId : '',
        url: confirmed ? `${AMAZON_HTTP_ORIGIN}/your-orders/order-details?orderID=${transaction.orderId}` : `${AMAZON_HTTP_ORIGIN}/your-orders/orders`, transport: 'api' } };
    }
    // Read-only reconciliation, even if the order POST timed out. Never use a
    // thank-you purchaseId as an order number or select an arbitrary new order.
    const baseline = new Set(transaction.baselineOrderIds || []);
    for (let round = 0; round < Math.min(3, Math.max(1, attempts)); round++) {
      await this.recordStep('api_order_check', { step: 8 });
      const history = await this.request('/-/zh/gp/your-account/order-history?ref_=typ_rev_edit_mult');
      const matches = [];
      const candidates = amazonOfficialOrderIds(history).filter(id => !baseline.has(id));
      if (candidates.length > 5) break; // Never infer uniqueness from a truncated candidate set.
      for (const id of candidates) {
        const detail = await this.request(`/your-orders/order-details?orderID=${id}`);
        if (matchesAmazonOfficialDetail(detail, id, transaction)) matches.push({ orderId: id, url: detail.url });
      }
      if (matches.length === 1) return { status: 'ordered', snapshot: { ...matches[0], confirmed: true, transport: 'api' } };
      if (matches.length > 1) break; // Ambiguous same-product orders require review.
    }
    return { status: 'submitted_unconfirmed', snapshot: { orderId: '', url: `${AMAZON_HTTP_ORIGIN}/your-orders/orders`, transport: 'api' } };
  }

  async checkout(snapshot, { beforeSubmit }) {
    if (this.directBuyNow) return this.checkoutDirect(snapshot, { beforeSubmit });
    if (this.addAttempted || this.submitted || !this.offer?.form) throw fail('日亞 API 禁止重複加車或送單');
    if (!this.canContinue()) throw fail('日亞任務已停止，本次不加車');
    const readCart = () => this.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
    const readHistory = () => this.request('/-/zh/gp/your-account/order-history?ref_=typ_rev_edit_mult');
    const preflightStarted = performance.now();
    let cartPage, history;
    if (this.parallelPreflight) {
      // Both are read-only. Drain both even on failure before releasing the
      // account lock; never allow an in-flight read to outlive this attempt.
      const results = await Promise.allSettled([readCart(), readHistory()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) {
        // A server cooldown must win over a simultaneous local/cart failure.
        const restricted = results.filter(result => result.status === 'rejected')
          .map(result => result.reason).find(error => error.code === 'AMAZON_RATE_LIMITED');
        throw restricted || failed.reason;
      }
      [cartPage, history] = results.map(result => result.value);
    } else {
      cartPage = await readCart();
    }
    const initialCart = parseAmazonHttpCart(cartPage);
    const resumeCart = this.fastCheckout && exactTargetCart(initialCart, snapshot.asin)
      && initialCart.items[0].sellerConfirmed && cartMatchesFreshOffer(cartPage, this.offer);
    if (!initialCart.empty && !resumeCart) throw fail('日亞購物車已有商品或無法確認空車；不清除、不加車', 'AMAZON_CART_REVIEW');
    await this.recordStep(resumeCart ? 'api_cart_resume' : 'api_cart_empty', { step: 2,
      ...(resumeCart ? { result: 'exact_target_quantity_one' } : {}) });
    history ||= await readHistory();
    const baselineOrderIds = amazonOfficialOrderIds(history); // [] is valid for a new account, not an unreadable page.
    if (this.parallelPreflight) await this.recordStep('api_preflight_ready', { step: 2, durationMs: Math.round(performance.now() - preflightStarted), parallel: true });
    const transaction = { phase: resumeCart ? 'cart_ready' : 'adding', asin: snapshot.asin, title: snapshot.title, code: snapshot.code,
      priceYen: snapshot.priceYen, quantity: 1, baselineOrderIds, startedAt: new Date().toISOString(),
      route: resumeCart ? 'existing_target_cart' : 'fresh_add' };
    await this.checkpoint(transaction);
    if (!this.canContinue()) {
      if (!resumeCart) await this.checkpoint(null);
      throw fail('日亞任務已停止，本次不加車／不送單');
    }
    // Claim this client even when reusing a cart: it can enter checkout only once.
    this.addAttempted = true;
    let added;
    let verifiedCartPage = cartPage;
    if (!resumeCart) {
      await this.recordStep('api_add_cart', { step: 3 });
      try { added = await this.sendForm(this.offerPage, this.offer.form, 'submit.addToCart', { 'items[0.base][quantity]': '1' }); }
      catch (error) {
        // A rejected/throttled/verification response is not permission to issue
        // more requests. Preserve the unresolved intent for manual review.
        if (error.code !== 'AMAZON_HTTP_TIMEOUT') throw error;
        await this.recordStep('api_cart_check', { step: 4 });
      }
      const inlineCart = added && this.fastCheckout && parseAmazonHttpCart(added);
      if (inlineCart && exactTargetCart(inlineCart, snapshot.asin) && inlineCart.items[0].sellerConfirmed) {
        verifiedCartPage = added;
        await this.recordStep('api_cart_inline_verified', { step: 4, result: 'fresh_add_response' });
      } else verifiedCartPage = await this.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
    }
    const cart = parseAmazonHttpCart(verifiedCartPage);
    if (!exactTargetCart(cart, snapshot.asin)) {
      throw fail('日亞加車結果／商品數量無法確認；保留購物車，不再加一次', 'AMAZON_CART_REVIEW');
    }
    await this.recordStep('api_cart_verified', { step: 4 });
    transaction.phase = 'cart_ready'; await this.checkpoint(transaction);
    if (!this.canContinue()) throw fail('日亞任務已停止，保留已加入商品、不送單');
    let entryPage = added;
    let entry = entryPage?.$('form').filter((_, n) => entryPage.$(n).find('[name="proceedToRetailCheckout"],[name="proceedToCheckout"]').length).first();
    if (!entry?.length) { entryPage = verifiedCartPage; entry = entryPage.$('form').filter((_, n) => entryPage.$(n).find('[name="proceedToRetailCheckout"],[name="proceedToCheckout"]').length).first(); }
    const submitName = entryPage.$(entry).find('[name="proceedToRetailCheckout"]').length ? 'proceedToRetailCheckout' : 'proceedToCheckout';
    const entryContract = amazonHttpForm(entryPage, entry, submitName);
    // Only the read-only entry contract exercised during research is enabled.
    if (entryContract.method !== 'GET' || new URL(entryContract.url).pathname !== '/checkout/entry/cart'
      || entryContract.fields.get('cartItemCount') !== '1') throw fail('日亞結帳入口不是已驗證契約；保留購物車');
    this.beginCheckoutEvidence(entryPage);
    await this.recordStep('api_checkout_entry', { step: 5 });
    const reviewPage = await this.sendForm(entryPage, entry, submitName);
    this.emitEvidence('response',reviewPage,{source:'官方結帳入口回應（離線呈現）'});
    const action = amazonHttpForm(reviewPage, reviewPage.$('#spc-form').first(), 'placeYourOrder1').url;
    const canonical = new URL(action); canonical.pathname = canonical.pathname.replace(/\/place-order$/, '');
    reviewPage.url = canonical.href;
    const review = parseAmazonHttpReview(reviewPage, transaction);
    await beforeSubmit(review.checkout);
    Object.assign(transaction, { totalYen: review.checkout.totalYen, shippingYen: review.checkout.shippingYen });
    if (!this.canContinue()) throw fail('日亞任務已停止或目標變更，本次不送單');
    transaction.phase = 'submitted';
    await this.checkpoint(transaction); // Durable intent before any order POST.
    if (!this.canContinue()) { transaction.phase = 'cart_ready'; await this.checkpoint(transaction); throw fail('日亞任務已停止，本次不送單'); }
    await this.recordStep('submit_order', { step: 7, transport: 'api' });
    this.submitted = true;
    try { await this.sendForm(reviewPage, review.form, 'placeYourOrder1', review.overrides); }
    catch (error) {
      if (['AMAZON_RATE_LIMITED', 'AMAZON_LOGIN_REQUIRED', 'AMAZON_CHECKOUT_AUTH_REQUIRED', 'AMAZON_VERIFICATION_REQUIRED'].includes(error.code)) throw error;
      await this.recordStep('api_submit_unknown', { step: 8 });
    }
    const result = await this.confirmOrder(transaction);
    if (result.status === 'ordered') { transaction.phase = 'confirmed'; transaction.orderId = result.snapshot.orderId; await this.checkpoint(transaction); }
    await this.recordStep('submit_result', { step: 8, status: result.status, orderId: result.snapshot.orderId });
    return result;
  }

  async prepareDirectCheckout(snapshot) {
    if (this.addAttempted || this.submitted) throw fail('日亞禁止重複直購或送單');
    if (!this.canContinue()) throw fail('日亞任務已停止，本次不直購');
    if (this.stockWaitEnabled && this.stockWait?.asin === snapshot.asin) {
      const tx = { ...this.stockWait.tx, phase: 'buy_now', route: this.stockWait.tx.route || 'direct_buy_now' };
      await this.checkpoint(tx); this.addAttempted = true;
      this.checkoutEvidenceStarted = true;
      const page = await this.request(amazonStockWaitUrl(this.stockWait.url));
      this.emitEvidence('response', page, { source: '保留結帳頁的唯讀重查回應' });
      const reviewPage = await this.advanceCheckout(await this.waitAtCheckout(page, tx, snapshot), tx);
      const review = parseAmazonHttpReview(reviewPage, tx);
      return { tx, reviewPage, review };
    }
    if (snapshot.offerSource === 'aod' && this.retailFallbackEnabled) return this.prepareFastAodCheckout(snapshot);
    // Reuse only the exact snapshot and validated form obtained by THIS client
    // in the current round. Never reuse a previous poll/other ASIN/session.
    const reuse = this.directProductSnapshot === snapshot && this.directProductPage
      && Date.now() - this.directProductAt >= 0 && Date.now() - this.directProductAt <= 5_000;
    const productPage = reuse ? this.directProductPage
      : await this.request(`/dp/${snapshot.asin}?m=${AMAZON_JP_SELLER_ID}&language=ja_JP&currency=JPY`);
    const { form, submitName } = parseAmazonDirectBuyForm(productPage, { ...snapshot,
      freshOfferId: reuse ? this.directFreshOfferId : this.offer?.contract?.fields.get('items[0.base][offerListingId]') });
    if (!this.canContinue()) throw fail('日亞任務已停止，本次不直購');
    const tx = { phase: 'buy_now', route: 'direct_buy_now', asin: snapshot.asin, title: snapshot.title,
      code: snapshot.code, priceYen: snapshot.priceYen, quantity: 1, startedAt: new Date().toISOString() };
    const baseline = this.idleOrderBaseline;
    const baselineAge = Date.now() - Date.parse(baseline?.at || '');
    if (baseline?.asin === snapshot.asin && baselineAge >= 0 && baselineAge <= 30_000 && Array.isArray(baseline.ids)) {
      tx.baselineOrderIds = [...baseline.ids]; tx.baselineCapturedAt = baseline.at;
    }
    await this.checkpoint(tx);
    if (!this.canContinue()) { await this.checkpoint(null); throw fail('日亞任務已停止，本次不直購'); }
    this.addAttempted = true;
    this.beginCheckoutEvidence(productPage);
    await this.recordStep('buy_now_click', { step: 1, transport: 'api' });
    if (!this.canContinue()) { await this.checkpoint(null); throw fail('日亞任務已停止，本次不直購'); }
    let reviewPage;
    const confirmationPath = value => /\/(?:gp\/buy\/thankyou\/|checkout\/.*(?:thank|confirmation))/.test(String(value || ''));
    try {
      if (this.browserDirectEntry) {
        reviewPage = await this.browserDirectEntry(snapshot, { canContinue: this.canContinue });
        const entryTrace = reviewPage.entryTrace?.slice(-8) || [];
        this.lastCheckoutRequest = entryTrace.at(-1) || { url: reviewPage.url, method: 'GET', status: reviewPage.status, responseReceived: true };
        this.lastCheckoutResponse = reviewPage;
        this.checkoutTrace.push(...(entryTrace.length ? entryTrace : [this.lastCheckoutRequest]));
      } else reviewPage = await this.sendForm(productPage, form, submitName);
    }
    catch (error) {
      if (confirmationPath(this.lastCheckoutRequest?.url)) { this.submitted = true; tx.phase = 'submitted'; await this.checkpoint(tx); }
      throw error;
    }
    this.emitEvidence('response',reviewPage,{source:'官方結帳入口回應（離線呈現）'});
    if (confirmationPath(reviewPage.url)) {
      this.submitted = true; tx.phase = 'submitted'; await this.checkpoint(tx);
      throw fail('直購後意外出現訂單確認頁；保留查單，不自動重試', 'AMAZON_UNEXPECTED_COMPLETION');
    }
    if (!this.canContinue()) throw fail('日亞任務已停止，本次不送單');
    // Parse only this response: no cart entry, old orders, cleanup or page tour.
    reviewPage = await this.advanceCheckout(reviewPage, tx);
    if (this.stockWaitEnabled) reviewPage = await this.waitAtCheckout(reviewPage, tx, snapshot);
    reviewPage = await this.advanceCheckout(reviewPage, tx);
    const review = parseAmazonHttpReview(reviewPage, tx);
    return { tx, reviewPage, review };
  }

  async sendContract(page, contract) {
    if (!this.canContinue()) throw fail('日亞任務已停止，本次不續行');
    if (contract.method === 'GET') {
      const url = new URL(contract.url);
      for (const [k, v] of contract.fields) url.searchParams.append(k, v);
      return this.request(url.href, { referer: page.url });
    }
    return this.request(contract.url, { method: 'POST', fields: contract.fields, referer: page.url });
  }

  async advanceCheckout(page, tx) {
    const seen = new Set();
    for (let hop = 0; hop < 6; hop++) {
      if (/\/(?:gp\/buy\/thankyou\/|checkout\/.*(?:thank|confirmation))/.test(new URL(page.url).pathname)) {
        this.submitted = true;
        if (tx) { tx.phase = 'submitted'; await this.checkpoint(tx); }
        throw fail('結帳續行意外出現完成頁，保留查單，不重試', 'AMAZON_UNEXPECTED_COMPLETION');
      }
      // Stock pages belong to the retained GET loop, never Continue/qty-zero.
      if (amazonCheckoutStockState(page, '') !== 'other' || page.$('#spc-form').length) return page;
      const decline = amazonPrimeDecline(page, amazonHttpForm);
      const selection = tx ? amazonItemSelection(page, tx.asin, amazonHttpForm) : null;
      const render = decline || selection ? null : amazonCheckoutRenderUrl(page);
      // An item-selection page must pass identity/quantity checks before any
      // continuation; a link to SPC cannot bypass those checks.
      const isSelection = /\/checkout\/p\/[^/]+\/itemselect\/?$/.test(new URL(page.url).pathname);
      const next = decline || selection || (!isSelection && render && render !== page.url ? { url: render, method: 'GET', fields: new URLSearchParams() } : null);
      if (!next) return page;
      const key = JSON.stringify([next.method, next.url, next.fields.toString()]);
      if (seen.has(key)) throw fail('日亞結帳續行重複，保留待核對', 'AMAZON_CART_REVIEW');
      seen.add(key);
      await this.recordStep(decline ? 'checkout_prime_decline' : selection ? 'checkout_item_continue' : 'checkout_render', { step: 2 });
      page = await this.sendContract(page, next);
    }
    throw fail('日亞結帳續行超過上限，保留待核對', 'AMAZON_CART_REVIEW');
  }

  async prepareFastAodCheckout(snapshot) {
    const age = Date.now() - this.offerAt;
    if (snapshot !== this.offerSnapshot || !this.offer || age < 0 || age > 5000
      || this.offer.priceYen !== snapshot.priceYen || !snapshot.sellerConfirmed || snapshot.pageIssue || snapshot.purchaseLimited) throw fail('AOD 報價已過期或不是本輪自營表單', 'AMAZON_CART_REVIEW');
    const fields = new URLSearchParams(this.offer.contract.fields);
    if (fields.getAll('items[0.base][asin]').length !== 1 || fields.get('items[0.base][asin]') !== snapshot.asin
      || fields.getAll('items[0.base][offerListingId]').length !== 1 || fields.getAll('anti-csrftoken-a2z').length !== 1
      || [...fields.keys()].some(k => /^items\[(?!0\.base\])/.test(k))) throw fail('AOD 表單含重複或額外商品，保留待核對', 'AMAZON_CART_REVIEW');
    fields.set('items[0.base][quantity]', '1');
    const tx = { phase: 'adding', route: 'aod_fast', asin: snapshot.asin, title: snapshot.title,
      code: snapshot.code, priceYen: snapshot.priceYen, quantity: 1, startedAt: new Date().toISOString() };
    await this.checkpoint(tx);
    if (!this.canContinue()) { await this.checkpoint(null); throw fail('日亞任務已停止，本次不加車'); }
    this.addAttempted = true; this.beginCheckoutEvidence(this.offerPage);
    await this.recordStep('add_to_cart', { step: 1, transport: 'api' });
    // An unknown add stays locked. No pre-cart/history GET, no replay on timeout.
    let page = await this.sendContract(this.offerPage, { ...this.offer.contract, fields });
    this.emitEvidence('response', page, { source: 'AOD 官方加車回應' });
    if (/\/(?:gp\/buy\/thankyou\/|checkout\/.*(?:thank|confirmation))/.test(new URL(page.url).pathname)) {
      this.submitted = true; tx.phase = 'submitted'; await this.checkpoint(tx);
      throw fail('加車後意外出現訂單完成頁，保留查單', 'AMAZON_UNEXPECTED_COMPLETION');
    }
    page = await this.advanceCheckout(page, tx);
    let entry = amazonSmartWagonEntry(page, snapshot.asin, amazonHttpForm);
    const isReview = Boolean(page.$('#spc-form').length);
    const stock = amazonCheckoutStockState(page, snapshot.asin);
    if (!entry && !isReview && stock === 'other') {
      // Ordinary cart fallback verifies the exact offering and seller. Never
      // delete or alter a pre-existing/mixed cart to make the fast path fit.
      if (!exactTargetCart(parseAmazonHttpCart(page), snapshot.asin)) page = await this.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
      const cart = parseAmazonHttpCart(page);
      if (!exactTargetCart(cart, snapshot.asin) || !cart.items[0].sellerConfirmed || !cartMatchesFreshOffer(page, this.offer)) {
        throw fail('AOD 加車後購物車不是同一全新自營單品，保留待核對', 'AMAZON_CART_REVIEW');
      }
      entry = amazonCartEntry(page, amazonHttpForm);
      if (!entry) throw fail('購物車沒有唯一可用的官方結帳入口', 'AMAZON_CART_REVIEW');
    }
    // Only a received safe checkout can be resumed after restart.
    if (entry) page = await this.sendContract(page, entry);
    tx.phase = 'buy_now'; await this.checkpoint(tx);
    page = await this.advanceCheckout(page, tx);
    if (this.stockWaitEnabled) page = await this.waitAtCheckout(page, tx, snapshot);
    const reviewPage = await this.advanceCheckout(page, tx);
    return { tx, reviewPage, review: parseAmazonHttpReview(reviewPage, tx) };
  }

  async waitAtCheckout(page, tx, snapshot) {
    let count = this.stockWait?.refreshCount || 0;
    while (this.canContinue()) {
      if (/\/(?:gp\/buy\/thankyou\/|checkout\/.*(?:thank|confirmation))/.test(new URL(page.url).pathname)) {
        this.submitted = true; tx.phase = 'submitted'; await this.checkpoint(tx);
        throw fail('重查結帳時出現完成頁，保留查單，不再刷新', 'AMAZON_UNEXPECTED_COMPLETION');
      }
      const state = amazonCheckoutStockState(page, tx.asin);
      const productReturned = /^\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(new URL(page.url).pathname)
        && (page.$ || load(page.html || ''))('#productTitle').length;
      if (state === 'empty' || productReturned) {
        await this.onStockWait(null); await this.checkpoint(null); this.stockWait = null;
        await this.recordStep('checkout_cart_empty', { step: 2 });
        throw fail('Amazon 購物車已空，回商品頁等待新報價', 'AMAZON_CHECKOUT_CART_EMPTY');
      }
      if (state === 'mismatch') throw fail('紅字頁商品與本次任務不符，保留待核對', 'AMAZON_CART_REVIEW');
      if (state !== 'stock_wait') return page;
      const url = amazonStockWaitUrl(amazonCheckoutRenderUrl(page) || page.url);
      const previous = this.stockWait;
      this.stockWait = { asin: tx.asin, url, tx: { ...tx }, snapshot, since: previous?.since || new Date().toISOString(), refreshCount: count };
      await this.onStockWait(this.stockWait, { durable: !previous || previous.url !== url });
      if (count === 0 || count % 30 === 0) await this.recordStep('checkout_stock_wait', { step: 2, refreshCount: count, state: 'waiting' });
      await this.waitFor(Math.max(0, this.stockWaitIntervalMs - (Number(page.durationMs) || 0)));
      if (!this.canContinue()) throw fail('任務已停止，保留紅字頁位置，未送單', 'AMAZON_STOCK_WAIT_STOPPED');
      // Read-only refresh of the received page, not a replay of Buy Now.
      page = await this.request(url); count++;
    }
    throw fail('任務已停止，未送單', 'AMAZON_STOCK_WAIT_STOPPED');
  }

  async checkoutDirect(snapshot, { beforeSubmit }) {
    const { tx, reviewPage, review } = await this.prepareDirectCheckout(snapshot);
    await beforeSubmit(review.checkout);
    if (this.stockWaitEnabled && this.stockWait) {
      // A stock competition can last minutes. An idle history baseline from
      // before it cannot safely attribute somebody else's same-item order.
      delete tx.baselineOrderIds; delete tx.baselineCapturedAt;
      this.emitEvidence('response', reviewPage, { source: '紅字頁回流後的官方結帳回應' });
      await this.onStockWait(null); this.stockWait = null;
    }
    Object.assign(tx, { totalYen: review.checkout.totalYen, shippingYen: review.checkout.shippingYen, phase: 'submitted' });
    if (!this.canContinue()) throw fail('日亞任務已停止，本次不送單');
    await this.checkpoint(tx);
    if (!this.canContinue()) { tx.phase = 'buy_now'; await this.checkpoint(tx); throw fail('日亞任務已停止，本次不送單'); }
    await this.recordStep('submit_order', { step: 2, transport: 'api' });
    if (!this.canContinue()) { tx.phase = 'buy_now'; await this.checkpoint(tx); throw fail('日亞任務已停止，本次不送單'); }
    try { await this.authorizeFinalSubmit(); }
    catch (error) { tx.phase = 'buy_now'; await this.checkpoint(tx); throw error; }
    this.submitted = true;
    let completed;
    try { completed = await this.sendForm(reviewPage, review.form, 'placeYourOrder1', review.overrides); }
    catch (error) {
      if (['AMAZON_RATE_LIMITED', 'AMAZON_LOGIN_REQUIRED', 'AMAZON_CHECKOUT_AUTH_REQUIRED', 'AMAZON_VERIFICATION_REQUIRED'].includes(error.code)) throw error;
    }
    let orderId = completed ? amazonOrderIdFromCompletion(completed) : '';
    let result = { status: orderId ? 'ordered' : 'submitted_unconfirmed', snapshot: { orderId,
      url: orderId ? `${AMAZON_HTTP_ORIGIN}/your-orders/order-details?orderID=${orderId}` : `${AMAZON_HTTP_ORIGIN}/your-orders/orders`,
      confirmed: Boolean(orderId), transport: 'api' } };
    if (!orderId && Array.isArray(tx.baselineOrderIds)) {
      result = await this.confirmOrder(tx); orderId = result.snapshot.orderId;
    }
    if (orderId) { Object.assign(tx, { phase: 'confirmed', orderId }); await this.checkpoint(tx); }
    await this.recordStep('submit_result', { step: 3, status: result.status, orderId });
    return result;
  }

  async readIdleOrderBaseline(asin) {
    const at = new Date().toISOString();
    const history = await this.request('/-/zh/gp/your-account/order-history?ref_=typ_rev_edit_mult');
    return { asin, at, ids: amazonOfficialOrderIds(history) };
  }

  async clearIdleCart() {
    if (!this.canContinue() || this.addAttempted || this.submitted) throw fail('非待機狀態，不清購物車');
    let page = await this.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
    let removed = 0;
    while (true) {
      const cart = parseAmazonHttpCart(page);
      if (cart.empty) return { removed, empty: true };
      if (!this.canContinue()) throw fail('待機清車已停止');
      const $ = page.$, rows = $('#sc-active-cart [data-asin][data-itemid]').filter((_, n) => !$(n).parents('[data-asin]').length);
      if (!rows.length || rows.length !== cart.items.length || removed >= 25) throw fail('待機購物車資料不完整，停止清車');
      const row = rows.first(), form = row.closest('form#activeCartViewForm');
      const submit = row.find('input[type="submit"][name^="submit.delete-active."]').first();
      const submitName = submit.attr('name');
      if (submitName !== `submit.delete-active.${row.attr('data-itemid')}`) throw fail('待機清車按鈕無法對應商品');
      const contract = amazonHttpForm(page, form, submitName);
      if (contract.method !== 'POST' || !/^\/cart(?:\/|$)/.test(new URL(contract.url).pathname)
        || !contract.fields.get('anti-csrftoken-a2z')) throw fail('待機清車契約未確認');
      const id = row.attr('data-itemid');
      try { await this.sendForm(page, form, submitName); }
      catch (error) { if (error.code !== 'AMAZON_HTTP_TIMEOUT') throw error; }
      // Read once after a timeout, never replay a mutation whose result is unknown.
      page = await this.request('/-/zh/gp/cart/view.html?ref_=nav_cart');
      if (page.$('#sc-active-cart [data-itemid]').toArray().some(n => page.$(n).attr('data-itemid') === id)) throw fail('待機清車未確認，不重送');
      removed++;
    }
  }
}
