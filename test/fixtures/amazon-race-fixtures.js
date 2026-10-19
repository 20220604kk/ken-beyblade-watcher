export const asin = 'B0TEST0001';
export const origin = 'https://www.amazon.co.jp';
const input = (name, value) => `<input type="hidden" name="${name}" value="${value}">`;
export function product({ seller = 'AN1VRQENFRJN5', price = 880, target = asin, available = true } = {}) {
  return `<!doctype html><title>Offline test product</title><span id="nav-link-accountList-nav-line-1">Hello, Test</span>
    <h1 id="productTitle">BEYBLADE X BX-40</h1><div id="buybox"><div id="merchantInfoFeature_feature_div">Seller: ${seller === 'AN1VRQENFRJN5' ? 'Amazon.co.jp' : 'Other'}</div>
    <form method="post" action="/gp/product/handle-buy-box/ref=fixture">${input('anti-csrftoken-a2z', 'synthetic-token')}${input('ASIN', target)}
    ${input('offerListingID', 'synthetic-offer')}${input('merchantID', seller)}${input('items[0.base][quantity]', 1)}
    ${input('items[0.base][customerVisiblePrice][currencyCode]', 'JPY')}${input('items[0.base][customerVisiblePrice][amount]', price)}
    ${available ? '<input id="buy-now-button" type="submit" name="submit.buy-now" value="Buy now" formaction="/checkout/entry/buynow">' : ''}</form></div>`;
}
export function review({ target = asin, quantity = 1, shipping = 500, total = 1380, seller = 'Amazon.co.jp', points = false, mixed = false, jpy = true } = {}) {
  return `<!doctype html><title>Offline test checkout</title><section id="item-block-1"><span id="item-block-product-title-1">BEYBLADE X BX-40</span>
    <a href="/dp/${target}">Item</a><span data-a-selector="inner-value">${quantity}</span><p>販売元: ${seller}</p></section>
    ${mixed ? '<section id="item-block-2"><span id="item-block-product-title-2">Other item</span><a href="/dp/B0TEST0002">Item</a></section>' : ''}
    <div id="shipping-address">Synthetic test destination</div><p>商品: JPY 880 配送费: JPY ${shipping} 订单总计: JPY ${total}</p>
    ${points ? input('pointsToApply', 100) : ''}<form id="spc-form" method="post" action="/checkout/p/fixture/spc/place-order">
    ${input('anti-csrftoken-a2z', 'synthetic-review-token')}${input('currentViewId', 'fixture-view')}${input('currentCurrencyOption', jpy ? 'MARKETPLACE' : 'LOCAL')}
    <input type="submit" name="placeYourOrder1" value="Place your order JPY"></form>`;
}
export function completion(id = '000-0000000-0000002') {
  return `<!doctype html><title>Offline test confirmation</title><h1>订单已提交，谢谢！</h1><p>订单编号 ${id}</p>`;
}
