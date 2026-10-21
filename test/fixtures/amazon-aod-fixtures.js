export const retailAsin = 'B0TEST0099';
export function retailAod({ asin = retailAsin, price = 9900, seller = 'AN1VRQENFRJN5', condition = '新品', available = true, malformed = false } = {}) {
  return `<div id="aod-container"><h1 id="aod-asin-title-text">BEYBLADE X CX-99 Fixture</h1><div id="aod-offer-list">
    ${available ? `<div id="aod-offer"><div id="aod-offer-heading">${condition}</div>
    <div id="aod-offer-soldBy"><a href="/sp?seller=${seller}">${seller === 'AN1VRQENFRJN5' ? 'Amazon.co.jp' : 'Third-party'}</a></div>
    <div id="aod-offer-shipsFrom">Amazon.co.jp</div><span class="a-price"><span class="a-offscreen">￥${price}</span></span>
    <form method="post" action="/cart/add-to-cart/ref=synthetic">
      <input name="items[0.base][asin]" value="${asin}"><input name="items[0.base][offerListingId]" value="synthetic-offer">
      ${malformed ? '' : '<input name="anti-csrftoken-a2z" value="synthetic-token">'}
      <input name="items[0.base][quantity]" value="1"><button name="submit.addToCart">Add</button>
    </form></div>` : '現在在庫切れ'}</div></div>`;
}
