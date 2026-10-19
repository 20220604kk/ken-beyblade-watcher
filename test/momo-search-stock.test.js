import assert from 'node:assert/strict';
import test from 'node:test';
import { ShoppingSiteMonitor } from '../src/shopping-sites.js';

test('momo falls back to the official search payload for presale stock', async () => {
  const target = {
    id: 'momo-ux20',
    name: 'momo Funbox',
    siteName: 'momo',
    url: 'https://www.momoshop.com.tw/product/15462751',
    enabled: true
  };
  const productHtml = `
    <title>BEYBLADE X UX-20</title>
    <meta property="og:title" content="BEYBLADE X UX-20">
    <a href="${target.url}"><h3>BEYBLADE X UX-20</h3></a>
    ${String.raw`\"goodsSortedCode\":\"2301600043\"`}
  `.padEnd(240, ' ');
  const searchHtml = String.raw`
    self.__next_f.push([1,"{\"goodsCode\":\"15462751\",\"goodsName\":\"BEYBLADE X UX-20\",\"goodsPrice\":\"$$595\",\"goodsStock\":\"379\"}"])
  `;
  const fetcher = async (url) => {
    if (String(url).includes('/getRecommendGoods')) {
      return Response.json({
        success: true,
        resultCode: '200',
        rtnData: { goodsInfoList: [] }
      });
    }
    if (String(url).includes('/search/UX-20')) {
      return new Response(searchHtml, { status: 200 });
    }
    return new Response(productHtml, { status: 200 });
  };
  const state = { data: {}, async save() {} };
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher,
    notify: async () => {}
  });

  await monitor.scan();
  const product = state.data.commerce.shoppingSites.targets[target.id].seen['15462751'];
  assert.equal(product.variants[0].stock, 379);
  assert.equal(product.stockSource, 'momo-search-goodsStock');
});
