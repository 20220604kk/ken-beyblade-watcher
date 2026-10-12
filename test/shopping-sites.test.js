import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalEsliteProductUrl, esliteExhibitionNotification, momoStoreDetailRequest, momoStoreGoodsRequest, parseEsliteExhibitData, parseEsliteProductPage, parseEslitePurchaseStatus, parseEsliteSearchData, parseMomoSaleStart, parseMomoStoreDetailData, parseMomoStoreGoodsData, parseMomoVariants, parseShoppingPage, parseTwjCollectionData, shoppingProductExcludeMatch, ShoppingSiteMonitor
} from '../src/shopping-sites.js';

function momoStoreDetailFixture({
  goodsCode = 'TP00024510018641',
  goodsName = 'BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00',
  variants = []
} = {}) {
  return {
    success: true,
    resultCode: '200',
    rtnGoodsData: {
      goodsCode,
      goodsName,
      imgUrl: 'https://example.com/product.webp',
      canTipStock: '1',
      formData: [{
        formType: '5',
        goodsMutipleType: { goodsMutipleTypeInfo: variants }
      }]
    }
  };
}

test('購物網站排除關鍵字同時比對商品名稱與規格名稱', () => {
  assert.equal(shoppingProductExcludeMatch({
    title: '新款 BEYBLADE X BX-12',
    variants: [{ name: '紫煞魂-3G 戰鬥盒（內襯另購）' }]
  }, ['戰鬥盒']), '戰鬥盒');
  assert.equal(shoppingProductExcludeMatch({
    title: 'BEYBLADE X 戰鬥陀螺專用收納包',
    variants: []
  }, ['戰鬥盒', '收納包']), '收納包');
  assert.equal(shoppingProductExcludeMatch({ title: 'BEYBLADE X UX-21', variants: [] }, ['戰鬥盒']), '');
});

test('購物網站可用商品編號精準排除 momo 單品', () => {
  const product = {
    id: '15714217',
    title: 'BEYBLADE X 戰鬥陀螺 CX-00 迪卡狂怒',
    url: 'https://www.momoshop.com.tw/product/15714217',
    variants: []
  };
  assert.equal(shoppingProductExcludeMatch(product, ['15714217']), '15714217');
  assert.equal(shoppingProductExcludeMatch(product, ['15714218']), '');
});

test('命中購物網站排除詞的可購商品不推播也不交給自動下單', async () => {
  const target = {
    id: 'excluded-shopping-product',
    name: '墊腳石 momo 專區',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072',
    enabled: true
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: { initialized: true, seen: {} } } } } },
    async save() {}
  };
  const notifications = [];
  const purchases = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    getExcludeKeywords: () => ['戰鬥盒'],
    notify: async (text) => notifications.push(text),
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });
  monitor.enrichProduct = async (product) => product;
  // 直接替換此輪來源，讓測試只驗證排除發生在通知與購買之前。
  monitor.loadHtml = async () => '<article><a href="https://www.momoshop.com.tw/product/19990001"><h3>新款 戰鬥盒 3G 戰鬥陀螺 BX-12</h3><button>加入購物車</button></a></article>'.padEnd(240, ' ');

  const result = await monitor.scan();
  assert.equal(result.excluded, 1);
  assert.equal(result.notified, 0);
  assert.equal(result.purchaseCandidates.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(purchases.length, 0);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].excluded['19990001'].reason, '命中排除關鍵字「戰鬥盒」');
});

test('童無忌專區 API 可辨識精確庫存、售罄、價格與圖片', () => {
  const products = parseTwjCollectionData([
    {
      url: '/products/20268beyblade-x-ux-21',
      photo: '/media/ux21.jpeg',
      title: '【2026.8】BEYBLADE X UX-21 惡魔冥界改造組 戰鬥陀螺 TAKARA TOMY正版',
      price: 895,
      variants: [{ id: 87543551, option1: 'UX-21 惡魔冥界改造組', inventory_quantity: 0 }]
    },
    {
      url: '/products/beyblade-x-cx-18',
      photo: '/media/cx18.jpeg',
      title: 'BEYBLADE X 戰鬥陀螺 CX-18 腕龍鞭打 隨機強化組',
      price: 350,
      variants: [{ id: 87543552, option1: 'CX-18', inventory_quantity: 7 }]
    },
    { url: '/products/tomica', title: 'TOMICA 多美小汽車', price: 250, variants: [] }
  ], 'https://www.twj.tw/collections/beyblade-x');

  assert.equal(products.length, 2);
  assert.equal(products[0].id, '20268beyblade-x-ux-21');
  assert.equal(products[0].available, false);
  assert.equal(products[0].variants[0].stock, 0);
  assert.equal(products[0].price, 'NT$895');
  assert.equal(products[0].imageUrl, 'https://www.twj.tw/media/ux21.jpeg');
  assert.equal(products[1].available, true);
  assert.equal(products[1].variants[0].stock, 7);
});

test('momo 倒數商品頁可從付款說明辨識台灣開賣時間', () => {
  const html = String.raw`\"goodsPaymentDescription\":\"7/24 00:00 開賣\",\"onSaleTimestamp\":0`;
  assert.equal(
    parseMomoSaleStart(html, new Date('2026-07-23T07:00:00.000Z')),
    '2026-07-23T16:00:00.000Z'
  );
});

test('解析 momo 店+複數款式的精確可售數量', () => {
  const html = String.raw`self.__next_f.push([1,"{\"goodsMutipleTypeInfo\":[{\"canTipStock\":\"0\",\"goodsTypeAName\":\"UX-14 天蠍長矛0-70Z\",\"goodsTypeBName\":\"單一規格\",\"goodsNum\":\"0\"},{\"canTipStock\":\"1\",\"goodsTypeAName\":\"CX-15 邪神狂怒\",\"goodsTypeBName\":\"單一規格\",\"goodsNum\":\"18\"}]}" ])`;
  assert.deepEqual(parseMomoVariants(html), [
    { id: 'UX-14 天蠍長矛0-70Z', name: 'UX-14 天蠍長矛0-70Z', stock: 0, available: false },
    { id: 'CX-15 邪神狂怒', name: 'CX-15 邪神狂怒', stock: 18, available: true }
  ]);
});

test('momo 店＋商品 API 只保留戰鬥陀螺並取得商品頁總庫存', () => {
  const pageUrl = 'https://www.momoshop.com.tw/TP/TP0002451/main?brand=TAKARA%20TOMY&brandNo=20190717104950516&curPage=1';
  const data = {
    rtnGoodsData: {
      goodsInfoList: [
        {
          goodsCode: 'TP00024510018641',
          goodsName: '【TAKARA TOMY】BEYBLADE X 戰鬥陀螺 CX-13/UX-21/BX-00 蒼龍神劍 V2',
          goodsUrl: ' https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018641',
          imgUrl: 'https://example.com/bx00.webp',
          goodsPrice: '350',
          goodsStock: '2',
          onSaleDescription: ''
        },
        {
          goodsCode: 'TP00024510017611',
          goodsName: '【TAKARA TOMY】新！寶可夢抓抓機',
          goodsStock: '1'
        }
      ]
    }
  };
  const products = parseMomoStoreGoodsData(data, pageUrl);
  assert.equal(products.length, 1);
  assert.equal(products[0].id, 'TP00024510018641');
  assert.equal(products[0].price, '$350');
  assert.equal(products[0].available, true);
  assert.equal(products[0].variants[0].stock, 2);
  assert.equal(products[0].stockSource, 'momo-store-category-api');
  const request = momoStoreGoodsRequest(pageUrl, 2);
  assert.equal(request.data.entpCode, 'TP0002451');
  assert.deepEqual(request.data.brandName, ['TAKARA TOMY']);
  assert.deepEqual(request.data.brandCode, ['20190717104950516']);
  assert.equal(request.data.curPage, '2');
});

test('momo 店＋詳細 API 請求與解析可取得精確規格、庫存、價格及出貨日', () => {
  const productUrl = 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018641';
  const request = momoStoreDetailRequest(productUrl);
  assert.equal(request.data.entpCode, 'TP0002451');
  assert.equal(request.data.goodsCode, 'TP00024510018641');
  const product = parseMomoStoreDetailData(momoStoreDetailFixture({
    variants: [
      {
        goodsTypeAName: 'CX-13 龍王閃擊', goodsTypeCode: '00001', goodsNum: '0', canTipStock: '0',
        goodsTypePrice: { basePrice: { price: '895' } }
      },
      {
        goodsTypeAName: 'BX-00 蒼龍神劍3-60F V2', goodsTypeCode: '00003', goodsNum: '1', canTipStock: '1',
        goodsTypePrice: { basePrice: { price: '495' } },
        goodsPaymentDescription: '預計2026/10/06出貨'
      }
    ]
  }), productUrl);
  assert.equal(product.available, true);
  assert.equal(product.stock, 1);
  assert.equal(product.price, '$495~$895');
  assert.deepEqual(
    product.variants.map((variant) => [variant.code, variant.stock, variant.available]),
    [['00001', 0, false], ['00003', 1, true]]
  );
  assert.equal(product.variants[1].shippingLabel, '10/06 出貨');
  assert.equal(product.stockSource, 'momo-store-detail-api');
});

test('momo 店＋專區以商品 API 發現補貨，不等待動態品牌頁', async () => {
  const target = {
    id: 'momo-store-api',
    name: '墊腳石 TAKARA TOMY 專區',
    siteName: 'momo購物網',
    sourceType: 'momo-store-api',
    url: 'https://www.momoshop.com.tw/TP/TP0002451/main?brand=TAKARA%20TOMY&brandNo=20190717104950516&curPage=1',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018641';
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                TP00024510018641: {
                  id: 'TP00024510018641',
                  title: 'BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00',
                  url: productUrl,
                  available: false,
                  variants: [{ id: '__momo_store_total__', name: '商品頁總庫存', stock: 0, available: false }]
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const requested = [];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async (url, options) => {
      requested.push({ url, options });
      if (url === 'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1') {
        return new Response(JSON.stringify(momoStoreDetailFixture({
          variants: [
            { goodsTypeAName: 'CX-13 龍王閃擊', goodsNum: '2', canTipStock: '1', goodsTypeAImgUrl: 'https://example.com/cx13.jpg', goodsTypeCode: '00001', goodsTypePrice: { basePrice: { price: '495' } } },
            { goodsTypeAName: 'UX-21 惡魔冥界改造組', goodsNum: '0', canTipStock: '0', goodsTypeCode: '00002', goodsTypePrice: { basePrice: { price: '895' } } },
            { goodsTypeAName: 'BX-00 蒼龍神劍3-60F V2', goodsNum: '0', canTipStock: '0', goodsTypeCode: '00003', goodsTypePrice: { basePrice: { price: '350' } } }
          ]
        })), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        success: true,
        resultCode: '200',
        maxPage: '1',
        rtnGoodsData: {
          goodsInfoList: [{
            goodsCode: 'TP00024510018641',
            goodsName: 'BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00',
            goodsUrl: productUrl,
            goodsPrice: '350',
            goodsStock: '2',
            goodsPriceModel: { rangePrice: { minPrice: '350', maxPrice: '895' } }
          }]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    notify: async (text, options) => notifications.push({ text, options })
  });
  const result = await monitor.scan();
  assert.equal(requested.length, 2);
  assert.equal(requested[0].url, 'https://3pf.momo.com.tw/shop/app/category/goods/query/v1');
  assert.equal(requested[1].url, 'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1');
  assert.equal(JSON.parse(requested[0].options.body).data.entpCode, 'TP0002451');
  assert.equal(JSON.parse(requested[1].options.body).data.goodsCode, 'TP00024510018641');
  assert.equal(result.restocked, 1);
  assert.equal(result.notified, 1);
  assert.match(notifications[0].text, /規格補貨：CX-13 龍王閃擊｜前台可售 2 組/);
  assert.doesNotMatch(notifications[0].text, /規格補貨：BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00/);
  assert.match(notifications[0].options.embeds[0].description, /\*\*商品：\*\* CX-13 龍王閃擊/);
  assert.match(notifications[0].options.embeds[0].description, /\*\*價格：\*\* \$495/);
  assert.doesNotMatch(notifications[0].options.embeds[0].description, /\*\*商品：\*\* BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00/);
  assert.deepEqual(
    state.data.commerce.shoppingSites.targets[target.id].seen.TP00024510018641.variants.map((variant) => [variant.name, variant.stock]),
    [['CX-13 龍王閃擊', 2], ['UX-21 惡魔冥界改造組', 0], ['BX-00 蒼龍神劍3-60F V2', 0]]
  );

  const second = await monitor.scan();
  assert.equal(second.restocked, 0);
  assert.equal(second.notified, 0);
  assert.equal(requested.length, 3);
  assert.equal(requested[2].url, 'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1');
});

test('momo 店＋商品重新出現在分類 API 時即使總庫存仍為零也複查規格', async () => {
  const target = {
    id: 'momo-store-reappeared',
    name: '墊腳石 TAKARA TOMY 專區',
    siteName: 'momo購物網',
    sourceType: 'momo-store-api',
    url: 'https://www.momoshop.com.tw/TP/TP0002451/main?brand=TAKARA%20TOMY&brandNo=20190717104950516&curPage=1',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018641';
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              lastScanAt: '2026-09-16T09:51:40.000Z',
              seen: {
                TP00024510018641: {
                  id: 'TP00024510018641',
                  title: 'BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00',
                  url: productUrl,
                  stock: 0,
                  available: false,
                  status: '售完補貨中',
                  price: '$350~$895',
                  lastSeenAt: '2026-09-16T09:51:20.000Z',
                  variants: [
                    { id: 'CX-13 龍王閃擊', name: 'CX-13 龍王閃擊', code: '00001', stock: 0, available: false },
                    { id: 'UX-21 惡魔冥界改造組', name: 'UX-21 惡魔冥界改造組', code: '00002', stock: 0, available: false },
                    { id: 'BX-00 蒼龍神劍3-60F V2', name: 'BX-00 蒼龍神劍3-60F V2', code: '00003', stock: 0, available: false }
                  ]
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const requested = [];
  const logs = [];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async (url) => {
      requested.push(url);
      if (url === 'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1') {
        return new Response(JSON.stringify(momoStoreDetailFixture({
          variants: [
            { goodsTypeAName: 'CX-13 龍王閃擊', goodsNum: '0', canTipStock: '0', goodsTypeCode: '00001' },
            { goodsTypeAName: 'UX-21 惡魔冥界改造組', goodsNum: '0', canTipStock: '0', goodsTypeCode: '00002' },
            { goodsTypeAName: 'BX-00 蒼龍神劍3-60F V2', goodsNum: '1', canTipStock: '1', goodsTypeCode: '00003', goodsTypePrice: { basePrice: { price: '350' } } }
          ]
        })), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        success: true,
        resultCode: '200',
        maxPage: '1',
        rtnGoodsData: {
          goodsInfoList: [{
            goodsCode: 'TP00024510018641',
            goodsName: 'BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00',
            goodsUrl: productUrl,
            goodsPrice: '350',
            goodsStock: '0',
            onSaleDescription: '售完補貨中',
            goodsPriceModel: { rangePrice: { minPrice: '350', maxPrice: '895' } }
          }]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    log: (message) => logs.push(message),
    notify: async (text) => notifications.push(text)
  });

  const result = await monitor.scan();

  assert.deepEqual(requested, [
    'https://3pf.momo.com.tw/shop/app/category/goods/query/v1',
    'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1'
  ]);
  assert.equal(result.restocked, 1);
  assert.equal(result.notified, 1);
  assert.match(logs.join('\n'), /詳細 API 專線確認 1\/1 件/);
  assert.match(notifications[0], /BX-00 蒼龍神劍3-60F V2/);
  const saved = state.data.commerce.shoppingSites.targets[target.id].seen.TP00024510018641;
  assert.equal(saved.available, true);
  assert.equal(saved.variants.find((variant) => variant.code === '00003').stock, 1);
});

test('momo 店＋快速專線不等分類清單也能由已知單品抓到 0→1 且只通知一次', async () => {
  const productUrl = 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018641';
  const target = {
    id: 'momo-store-fast-line',
    name: '墊腳石 TAKARA TOMY 專區',
    siteName: 'momo購物網',
    sourceType: 'momo-store-api',
    url: 'https://www.momoshop.com.tw/TP/TP0002451/main?curPage=1',
    enabled: true
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: {
      initialized: true,
      seen: {
        TP00024510018641: {
          id: 'TP00024510018641',
          title: 'BEYBLADE X 戰鬥陀螺 CX-13／UX-21／BX-00',
          url: productUrl,
          available: false,
          variants: [{ id: 'BX-00 蒼龍神劍3-60F V2', name: 'BX-00 蒼龍神劍3-60F V2', code: '00003', stock: 0, available: false }]
        }
      }
    } } } } },
    async save() {}
  };
  const requested = [];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async (url) => {
      requested.push(url);
      assert.equal(url, 'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1');
      return new Response(JSON.stringify(momoStoreDetailFixture({
        variants: [{
          goodsTypeAName: 'BX-00 蒼龍神劍3-60F V2', goodsTypeCode: '00003',
          goodsNum: '1', canTipStock: '1', goodsTypePrice: { basePrice: { price: '495' } }
        }]
      })), { status: 200 });
    },
    notify: async (text) => notifications.push(text)
  });
  monitor.momoStoreLastDiscoveryAt.set(target.id, Date.now());

  const first = await monitor.scan();
  const second = await monitor.scan();
  assert.equal(first.restocked, 1);
  assert.equal(first.notified, 1);
  assert.equal(second.restocked, 0);
  assert.equal(second.notified, 0);
  assert.equal(requested.length, 2);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /BX-00 蒼龍神劍3-60F V2/);
});

test('momo 店＋詳細 API 全部失敗時保留既有基線且不製造假事件', async () => {
  const productUrl = 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018641';
  const target = {
    id: 'momo-store-api-failure',
    name: '墊腳石 TAKARA TOMY 專區',
    sourceType: 'momo-store-api',
    url: 'https://www.momoshop.com.tw/TP/TP0002451/main?curPage=1',
    enabled: true
  };
  const baseline = {
    id: 'TP00024510018641', title: 'BEYBLADE X BX-00', url: productUrl, available: true,
    variants: [{ id: 'BX-00', name: 'BX-00', stock: 4, available: true }]
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: { initialized: true, seen: { [baseline.id]: baseline } } } } } },
    async save() {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async () => new Response('busy', { status: 503 }),
    notify: async (text) => notifications.push(text)
  });
  monitor.momoStoreLastDiscoveryAt.set(target.id, Date.now());

  const result = await monitor.scan();
  assert.equal(result.notified, 0);
  assert.equal(result.restocked, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(notifications.length, 0);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen[baseline.id].variants[0].stock, 4);
});

test('momo 商品頁明示不可購買時不被預載 goodsNum 誤判為有貨', () => {
  const pageUrl = 'https://www.momoshop.com.tw/product/15670779';
  const html = `
    <html><head><title>【TAKARA TOMY】BEYBLADE X CX-18+UX-02</title></head>
    <body>
      <h1>【TAKARA TOMY】BEYBLADE X 戰鬥陀螺X CX-18+UX-02</h1>
      <button>可訂購時通知我</button>
      ${String.raw`self.__next_f.push([1,"{\"goodsTypeAName\":\"CX-18+UX-02\",\"goodsNum\":\"72\"}"])`}
    </body></html>
  `;
  const product = parseShoppingPage(html, pageUrl)[0];

  assert.equal(product.available, false);
  assert.equal(product.variants[0].stock, 72);
  assert.equal(product.variants[0].available, false);
});

test('momo 待售基線可由開賣單品直查轉為有貨且只通知一次', async () => {
  const target = {
    id: 'momo-limited',
    name: 'momo 戰鬥陀螺限量發售',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/product/15670779';
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                15670779: {
                  id: '15670779',
                  title: 'CX-18+UX-02',
                  url: productUrl,
                  available: false,
                  status: 'pending_sale',
                  saleStartAt: '2026-09-08T16:00:00.000Z',
                  variants: [{ id: '15670779', name: 'CX-18+UX-02', stock: 72, available: false }]
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const notifications = [];
  const candidates = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    notify: async (text) => notifications.push(text),
    onPurchaseCandidate: (candidate) => candidates.push(candidate)
  });
  monitor.inspectProduct = async () => ({
    id: '15670779',
    title: '【TAKARA TOMY】BEYBLADE X 戰鬥陀螺X CX-18+UX-02',
    url: productUrl,
    price: '$745',
    available: true,
    variants: [{ id: '15670779', name: 'CX-18+UX-02', stock: 18, available: true }]
  });

  const first = await monitor.verifyKnownMomoProduct(productUrl, { reason: 'scheduled-sale-direct-check' });
  const second = await monitor.verifyKnownMomoProduct(productUrl, { reason: 'scheduled-sale-direct-check' });

  assert.equal(first.restocked, 1);
  assert.equal(first.notified, 1);
  assert.equal(second.restocked, 0);
  assert.equal(second.notified, 0);
  assert.equal(notifications.length, 1);
  assert.equal(candidates.length, 1);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen['15670779'].status, 'available');
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen['15670779'].variants[0].stock, 18);
});

test('momo 單品直查命中排除詞時不會轉成補貨候選', async () => {
  const target = {
    id: 'momo-direct-excluded', name: 'momo 墊腳石專區', siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072', enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/product/19990001';
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: {
      initialized: true,
      seen: { 19990001: { id: '19990001', title: 'BX-12', url: productUrl, available: false, variants: [] } }
    } } } } },
    async save() {}
  };
  const purchases = [];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    getExcludeKeywords: () => ['戰鬥盒'],
    notify: async (text) => notifications.push(text),
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });
  monitor.inspectProduct = async () => ({
    id: '19990001', title: '新款 戰鬥盒 3G 戰鬥陀螺 BX-12', url: productUrl,
    available: true, variants: [{ id: 'purple', name: '紫煞魂', stock: 20, available: true }]
  });

  const result = await monitor.verifyKnownMomoProduct(productUrl, { reason: 'scheduled-sale-direct-check' });
  assert.equal(result.excluded, 1);
  assert.equal(result.notified, 0);
  assert.equal(result.purchaseCandidates.length, 0);
  assert.equal(purchases.length, 0);
  assert.equal(notifications.length, 0);
});

test('momo 商品離開健康分類頁後仍保留歷史基線並在兩輪後轉為不可購買', async () => {
  const target = {
    id: 'momo-history',
    name: 'momo 官方分類',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072',
    enabled: true
  };
  const card = (id, title) => `
    <article><a href="https://www.momoshop.com.tw/product/${id}">
      <img alt="${title}"><h3>${title}</h3><button>加入購物車</button>
    </a></article>
  `.padEnd(240, ' ');
  const pages = [
    card('15670001', 'BEYBLADE X UX-21'),
    card('15670001', 'BEYBLADE X UX-21')
  ];
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                15670779: {
                  id: '15670779',
                  title: 'BEYBLADE X CX-18+UX-02',
                  url: 'https://www.momoshop.com.tw/product/15670779',
                  available: true,
                  missingStreak: 0
                },
                15670001: {
                  id: '15670001',
                  title: 'BEYBLADE X UX-21',
                  url: 'https://www.momoshop.com.tw/product/15670001',
                  available: true,
                  missingStreak: 0
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async () => new Response(pages.shift(), { status: 200 }),
    notify: async () => {}
  });
  monitor.enrichProduct = async (product) => product;

  await monitor.scan();
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen['15670779'].available, true);
  await monitor.scan();

  const historical = state.data.commerce.shoppingSites.targets[target.id].seen['15670779'];
  assert.equal(historical.available, false);
  assert.equal(historical.missingStreak, 2);
  assert.ok(historical.confirmedAbsentAt);
  assert.equal(historical.url, 'https://www.momoshop.com.tw/product/15670779');
});

test('momo 一般商品頁優先讀取正式商品圖片與結構化促銷價', () => {
  const pageUrl = 'https://www.momoshop.com.tw/product/15462748';
  const products = parseShoppingPage(`
    <html>
      <head>
        <title>【TAKARA TOMY】BEYBLADE X BX-32 - momo購物網 - 好評推薦</title>
        <meta property="og:title" content="【TAKARA TOMY】BEYBLADE X BX-32 - momo購物網 - 好評推薦">
        <meta property="og:image" content="https://i.example/15462748_R_m.webp">
        <script type="application/ld+json">{"@type":"Product","offers":{"priceCurrency":"TWD","price":"1250"}}</script>
      </head>
      <body>
        <a href="${pageUrl}"><h3>BEYBLADE X BX-32</h3></a>
        <span>未滿 $490 運費 $75</span>
        ${String.raw`\"goodsTypeAName\":\"57*12.5*42\",\"goodsNum\":\"20\"`}
      </body>
    </html>
  `, pageUrl);
  assert.equal(products[0].title, '【TAKARA TOMY】BEYBLADE X BX-32');
  assert.equal(products[0].imageUrl, 'https://i.example/15462748_R_m.webp');
  assert.equal(products[0].price, '$1,250');
  assert.deepEqual(products[0].variants, []);
});

test('momo 一般商品以推薦 API goodsStock 取得未截斷庫存', async () => {
  const target = {
    id: 'momo-bx35',
    name: 'momo Funbox',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/product/15462753',
    enabled: true
  };
  const html = `
    <h3>BEYBLADE X BX-35 隨機強化組Vol.04</h3>
    <a href="${target.url}">BEYBLADE X BX-35 隨機強化組Vol.04</a>
    ${String.raw`\"goodsSortedCode\":\"2301600043\"`}
    ${String.raw`\"goodsTypeAName\":\"單一規格\",\"goodsNum\":\"20\"`}
  `.padEnd(240, ' ');
  const recommendationRequests = [];
  const fetcher = async (url, options = {}) => {
    if (!String(url).includes('/getRecommendGoods')) {
      return new Response(html, { status: 200 });
    }
    const request = JSON.parse(options.body);
    const goodsCode = request.data.goodsCode;
    recommendationRequests.push(goodsCode);
    const goodsInfoList = goodsCode === '15462753'
      ? [{
          goodsCode: '15462754',
          goodsName: 'BEYBLADE X UX-04 極限衝擊對戰組U',
          goodsStock: '168'
        }]
      : [{
          goodsCode: '15462753',
          goodsName: 'BEYBLADE X BX-35 隨機強化組Vol.04',
          goodsStock: '1008',
          goodsPrice: '$295',
          imgUrl: 'https://example.com/bx35.webp'
        }];
    return Response.json({
      success: true,
      resultCode: '200',
      rtnData: { goodsInfoList }
    });
  };
  const state = { data: {}, async save() {} };
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher,
    notify: async () => {}
  });

  const result = await monitor.scan();
  const product = state.data.commerce.shoppingSites.targets[target.id].seen['15462753'];
  assert.equal(result.checkedProducts, 1);
  assert.deepEqual(recommendationRequests, ['15462753', '15462754']);
  assert.equal(product.variants[0].stock, 1008);
  assert.equal(product.stockSource, 'momo-recommendation-goodsStock');
});

test('momo 數字分類頁發現的商品也會反查完整 goodsStock', async () => {
  const target = {
    id: 'momo-category-stock',
    name: 'momo Funbox 戰鬥陀螺',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2186500036',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/product/15462753';
  const html = `
    <article>
      <a href="${productUrl}">
        <img alt="BEYBLADE X BX-35 隨機強化組Vol.04">
        <h3>BEYBLADE X BX-35 隨機強化組Vol.04</h3>
      </a>
    </article>
  `.padEnd(240, ' ');
  const fetchedUrls = [];
  const fetcher = async (url, options = {}) => {
    fetchedUrls.push(String(url));
    if (!String(url).includes('/getRecommendGoods')) {
      return new Response(html, { status: 200 });
    }
    const goodsCode = JSON.parse(options.body).data.goodsCode;
    return Response.json({
      success: true,
      resultCode: '200',
      rtnData: {
        goodsInfoList: goodsCode === '15462753'
          ? [{ goodsCode: '15462754', goodsName: 'BEYBLADE X UX-04', goodsStock: '168' }]
          : [{ goodsCode: '15462753', goodsName: 'BEYBLADE X BX-35', goodsStock: '1008' }]
      }
    });
  };
  const state = { data: {}, async save() {} };
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher,
    notify: async () => {}
  });

  await monitor.scan();
  const product = state.data.commerce.shoppingSites.targets[target.id].seen['15462753'];
  assert.equal(product.variants[0].stock, 1008);
  assert.deepEqual(fetchedUrls, [
    target.url,
    'https://www.momoshop.com.tw/api/moecapp/getRecommendGoods',
    'https://www.momoshop.com.tw/api/moecapp/getRecommendGoods'
  ]);
});

test('momo 數字分類初始 HTML 尚未帶商品時改由瀏覽器等待動態清單', async () => {
  const url = 'https://www.momoshop.com.tw/categories/2701202072';
  let browserUsed = false;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} },
    getTargets: () => [],
    notify: async () => {},
    fetcher: async () => new Response('<html><body>分類商品載入中</body></html>'.padEnd(180, ' ')),
    browserLauncher: async () => ({
      async newPage() {
        browserUsed = true;
        return {
          async goto() {},
          async waitForSelector() { return {}; },
          async content() {
            return '<article><a href="/product/15358813"><h3>BEYBLADE X 戰鬥陀螺X BX-51 旋風發射器 黑綠</h3></a><span>可訂購時通知我</span></article>';
          },
          async close() {}
        };
      },
      async close() {}
    })
  });
  try {
    const products = parseShoppingPage(await monitor.loadHtml(url), url);
    assert.equal(browserUsed, true);
    assert.equal(products.length, 1);
    assert.equal(products[0].id, '15358813');
    assert.equal(products[0].available, false);
  } finally {
    await monitor.close();
  }
});

test('解析購物專區內的戰鬥陀螺商品', () => {
  const products = parseShoppingPage(`
    <article><a href="/product/15305482"><img alt="BEYBLADE X BX-45 武士魂斬" src="/bx45.jpg"><h3>BEYBLADE X BX-45 武士魂斬</h3></a><span>$495</span></article>
    <article><a href="/product/999"><h3>一般文具</h3></a></article>
  `, 'https://www.momoshop.com.tw/categories/2186500036');
  assert.equal(products.length, 1);
  assert.equal(products[0].id, '15305482');
  assert.match(products[0].url, /product\/15305482/);
});

test('墊腳石官網只保留有正式型號的陀螺玩具並辨識貨到通知', () => {
  const pageUrl = 'https://shop.tcsb.com.tw/v2/Search?q=%22戰鬥陀螺%22&shopId=32014';
  const products = parseShoppingPage(`
    <article><a href="/V2/SalePage/Index/1001"><img data-original="/cx13.jpg" alt="BEYBLADE X 戰鬥陀螺 CX-13 龍王閃擊"><h3>BEYBLADE X 戰鬥陀螺 CX-13 龍王閃擊</h3></a><button>加入購物車</button><span>NT$495</span></article>
    <article><a href="/V2/SalePage/Index/1002"><img src="/ux20.jpg"><h3>BEYBLADE X 戰鬥陀螺 UX-20 榮耀武神</h3></a><button>貨到通知</button></article>
    <article><a href="/V2/SalePage/Index/1003"><h3>戰鬥陀螺趣味百科書</h3></a></article>
    <article><a href="/V2/SalePage/Index/1004"><h3>IMPACT 戰鬥陀螺A4兒童後背包</h3></a></article>
    <article><a href="/V2/SalePage/Index/1005"><h3>BEYBLADE X 戰鬥陀螺 BX-51 旋風發射器</h3></a></article>
  `, pageUrl);
  assert.equal(products.length, 2);
  assert.equal(products[0].id, '1001');
  assert.equal(products[0].available, true);
  assert.match(products[0].imageUrl, /cx13\.jpg/);
  assert.equal(products[1].id, '1002');
  assert.equal(products[1].available, false);
});

test('墊腳石搜尋頁的初始 HTML 沒有商品時會等待瀏覽器動態內容', async () => {
  const url = 'https://shop.tcsb.com.tw/v2/Search?q=%22戰鬥陀螺%22&shopId=32014';
  let browserUsed = false;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} },
    getTargets: () => [],
    notify: async () => {},
    fetcher: async () => new Response('<html><body>搜尋載入中</body></html>'.padEnd(180, ' ')),
    browserLauncher: async () => ({
      async newPage() {
        browserUsed = true;
        return {
          async goto() {},
          async waitForSelector() { return {}; },
          async content() {
            return '<a href="/SalePage/Index/1001"><h3>BEYBLADE X 戰鬥陀螺 CX-13 龍王閃擊</h3></a><button>貨到通知</button>';
          },
          async close() {}
        };
      },
      async close() {}
    })
  });
  try {
    const products = parseShoppingPage(await monitor.loadHtml(url), url);
    assert.equal(browserUsed, true);
    assert.equal(products.length, 1);
    assert.equal(products[0].available, false);
  } finally {
    await monitor.close();
  }
});

test('誠品策展商品顯示無法購買時建立缺貨基線', () => {
  const products = parseShoppingPage(`
    <div class="exhibit-card product-in-article">
      <a class="product-image-wrap" href="/product/10042014802683132117006"><img alt="BEYBLADE X戰鬥陀螺/ UX-14/ 天蠍長矛0-70Z"></a>
      <a href="/product/10042014802683132117006">BEYBLADE X戰鬥陀螺/ UX-14/ 天蠍長矛0-70Z</a>
      <button>無法購買</button>
    </div>
  `, 'https://www.eslite.com/exhibitions/CU202503-00091');
  assert.equal(products.length, 1);
  assert.equal(products[0].available, false);
});

test('誠品只有明確出現購買按鈕才判定為可購', () => {
  const pageUrl = 'https://www.eslite.com/exhibitions/CU202503-00091';
  const product = '<a href="/product/10042014802683132117006"><h3>BEYBLADE X UX-14</h3></a>';
  assert.equal(parseShoppingPage(`<div class="exhibit-card">${product}</div>`, pageUrl)[0].available, null);
  assert.equal(parseShoppingPage(`<div class="exhibit-card">${product}<button>加入購物車</button></div>`, pageUrl)[0].available, true);
  assert.equal(parseShoppingPage(`<div class="exhibit-card">${product}<button>售罄</button></div>`, pageUrl)[0].available, false);
});

test('誠品官方策展 API 可一次解析多項商品、可購狀態與庫存', () => {
  const products = parseEsliteExhibitData({
    contents: [
      {
        product: {
          product_guid: '10042014802683132117006',
          name: 'BEYBLADE X戰鬥陀螺/ UX-14/ 天蠍長矛0-70Z',
          image: 'https://example.com/ux14.jpg',
          status: 'can_not_buy',
          stock: 0
        }
      },
      {
        book_list: [
          {
            product_guid: '10042014802683183210008',
            name: 'BEYBLADE X戰鬥陀螺/ BX-35/ 隨機強化組 Vol. 04',
            image: 'https://example.com/bx35.jpg',
            status: 'can_buy',
            stock: 108
          },
          {
            product_guid: '10042014802683183208005',
            name: 'BEYBLADE X戰鬥陀螺/ BX-00/ 暴風天馬3-70RA',
            status: 'can_buy',
            stock: 108
          }
        ]
      }
    ]
  }, 'https://www.eslite.com/exhibitions/CU202503-00091');

  assert.equal(products.length, 3);
  assert.equal(products[0].available, false);
  assert.equal(products[0].variants[0].stock, 0);
  assert.equal(products[1].available, true);
  assert.equal(products[1].variants[0].stock, 108);
  assert.equal(products[1].stockSource, 'eslite-book-exhibit');
  assert.match(products[1].url, /10042014802683183210008/);
});

test('誠品搜尋 API 只保留有正式型號的陀螺玩具並讀取可購狀態', () => {
  const products = parseEsliteSearchData({
    results: [
      {
        id: 'toy-ux20',
        name: 'BEYBLADE X戰鬥陀螺 UX-20 榮耀武神LF',
        availability: 'IN_STOCK',
        button_status: 'add_to_shopping_cart',
        final_price: 490,
        product_photo_url: 'https://example.com/ux20.jpg',
        is_book: false
      },
      {
        id: 'toy-bx35',
        name: 'BEYBLADE X戰鬥陀螺 BX-35 隨機強化組 Vol.04',
        availability: 'OUT_OF_STOCK',
        button_status: 'can_not_buy',
        final_price: 295,
        is_book: false
      },
      {
        id: 'book-1',
        name: 'BEYBLADE X戰鬥陀螺 BX-35 攻略圖鑑',
        availability: 'IN_STOCK',
        button_status: 'add_to_shopping_cart',
        is_book: true
      },
      {
        id: 'magazine-1',
        name: 'BEYBLADE X 戰鬥陀螺月刊',
        availability: 'IN_STOCK',
        button_status: 'add_to_shopping_cart'
      }
    ]
  });
  assert.equal(products.length, 2);
  assert.equal(products[0].available, true);
  assert.equal(products[0].price, 'NT$490');
  assert.equal(products[0].imageUrl, 'https://example.com/ux20.jpg');
  assert.equal(products[1].available, false);
});

test('誠品單品網址會正規化，並永久加入或刪除單品資料庫', async () => {
  const state = { data: {}, saves: 0, async save() { this.saves += 1; } };
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [], notify: async () => {}
  });
  const url = canonicalEsliteProductUrl('https://www.eslite.com/product/10042014802683232221009?utm_source=test');
  assert.equal(url, 'https://www.eslite.com/product/10042014802683232221009');
  const added = await monitor.addEsliteManualProduct(url, {
    title: 'BEYBLADE X戰鬥陀螺/ CX-19/ 鱷魚裂甲', price: 'NT$350', available: false
  });
  assert.equal(added.id, '10042014802683232221009');
  assert.equal(monitor.esliteManualProducts().length, 1);
  const deleted = await monitor.deleteEsliteManualProduct(added.id);
  assert.equal(deleted.id, added.id);
  assert.equal(monitor.esliteManualProducts().length, 0);
  assert.equal(state.saves, 2);
});

test('誠品單品基線不再自行輪詢，只有策展或搜尋命中才驗證商品', async () => {
  const id = '10042014802683232221009';
  const state = {
    data: { commerce: { shoppingSites: { targets: {}, esliteManualProducts: {
      [id]: {
        id, title: 'BEYBLADE X戰鬥陀螺/ CX-19/ 鱷魚裂甲',
        url: `https://www.eslite.com/product/${id}`, available: false,
        source: 'manual', addedAt: '2026-09-18T00:00:00.000Z'
      }
    } } } },
    async save() {}
  };
  const target = {
    id: 'eslite-manual-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords',
    keywords: ['BEYBLADE X'], discoveryUrls: []
  };
  const verified = [];
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({ json: async () => ({ results: [] }) }),
        goto: async () => {}, close: async () => {}
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => {
    verified.push(product.id);
    return { ...product, available: true, status: 'add_to_shopping_cart', availabilitySource: 'eslite-purchase-status' };
  };
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.deepEqual(verified, []);
    assert.equal(products[0].id, id);
    assert.equal(products[0].available, false);
    assert.equal(monitor.esliteManualProducts()[0].available, false);
    assert.equal(Boolean(monitor.esliteManualProducts()[0].lastCheckedAt), false);
  } finally {
    await monitor.close();
  }
});

test('誠品商品頁的實際購買按鈕優先於搜尋索引狀態', () => {
  const buyable = parseEsliteProductPage(`
    <html><head><meta property="og:title" content="BEYBLADE X UX-14 天蠍長矛｜誠品線上"></head>
    <body><main><h1>BEYBLADE X UX-14 天蠍長矛</h1><button>加入購物車</button></main></body></html>
  `, 'https://www.eslite.com/product/ux14');
  assert.equal(buyable.available, true);
  assert.equal(buyable.status, 'add_to_shopping_cart');

  const soldOut = parseEsliteProductPage(`
    <html><body><main><h1>BEYBLADE X UX-14 天蠍長矛</h1><button disabled>加入購物車</button><p>無法購買</p></main></body></html>
  `, 'https://www.eslite.com/product/ux14');
  assert.equal(soldOut.available, false);
});

test('誠品 purchase_status API 為商品可購與庫存的最終依據', () => {
  const upcoming = parseEslitePurchaseStatus({
    product_guid: '10042014802683209796004',
    product_button_status: 'coming_soon_not_book',
    stock: 0,
    final_price: 250,
    retail_price: 225
  }, { title: 'BEYBLADE X戰鬥陀螺 BX-57', url: 'https://www.eslite.com/product/10042014802683209796004' });
  assert.equal(upcoming.available, false);
  assert.equal(upcoming.status, 'coming_soon_not_book');
  assert.equal(upcoming.variants[0].stock, 0);
  assert.equal(upcoming.price, 'NT$225');

  const buyable = parseEslitePurchaseStatus({
    product_guid: '10042014802683209796004',
    product_button_status: 'add_to_shopping_cart',
    stock: 36,
    retail_price: 225
  }, upcoming);
  assert.equal(buyable.available, true);
  assert.equal(buyable.variants[0].stock, 36);
  assert.equal(buyable.stockSource, 'eslite-purchase-status');
});

test('誠品已知單品優先直接呼叫 purchase_status API，不啟動瀏覽器', async () => {
  let fetches = 0;
  let openedPages = 0;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    fetcher: async (url, options) => {
      fetches += 1;
      assert.equal(url, 'https://athena.eslite.com/api/v4/products/10042014802683066235005/purchase_status');
      assert.equal(options.headers.Origin, 'https://www.eslite.com');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          product_guid: '10042014802683066235005',
          product_button_status: 'add_to_shopping_cart',
          stock: 8,
          retail_price: 595
        })
      };
    },
    browserLauncher: async () => ({
      newPage: async () => { openedPages += 1; throw new Error('不應開啟瀏覽器'); },
      close: async () => {}
    })
  });
  const product = {
    id: '10042014802683066235005', title: 'BEYBLADE X CX-06',
    url: 'https://www.eslite.com/product/10042014802683066235005', available: false
  };
  try {
    const verified = await monitor.verifyEsliteProduct(product);
    assert.equal(verified.available, true);
    assert.equal(verified.variants[0].stock, 8);
    assert.equal(verified.availabilitySource, 'eslite-purchase-status');
    assert.equal(fetches, 1);
    assert.equal(openedPages, 0);
  } finally {
    await monitor.close();
  }
});

test('誠品單品掃描可重用帳號 A 的輕量 API 連線，不載入商品頁', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-purchase-status-'));
  const sessionFile = path.join(tempDir, 'eslite-session.json');
  await fs.writeFile(sessionFile, JSON.stringify({
    cookies: [],
    origins: [{
      origin: 'https://www.eslite.com',
      localStorage: [{ name: 'auth._token.prd', value: 'Bearer%20test-token' }]
    }]
  }));
  let apiRequests = 0;
  let disposed = false;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    esliteApiSessionFile: sessionFile,
    fetcher: async () => { throw new Error('不應改走一般 fetch'); },
    esliteRequestFactory: {
      newContext: async (options) => {
        assert.equal(options.extraHTTPHeaders.authorization, 'Bearer test-token');
        return {
          get: async (url) => {
            apiRequests += 1;
            assert.match(url, /\/api\/v4\/products\/10042014802683066235005\/purchase_status$/);
            return {
              ok: () => true,
              status: () => 200,
              json: async () => ({ product_button_status: 'add_to_shopping_cart', stock: 5 })
            };
          },
          dispose: async () => { disposed = true; }
        };
      }
    },
    browserLauncher: async () => { throw new Error('不應開啟瀏覽器'); }
  });
  const product = {
    id: '10042014802683066235005', title: 'BEYBLADE X CX-06',
    url: 'https://www.eslite.com/product/10042014802683066235005', available: false
  };
  try {
    const verified = await monitor.verifyEsliteProduct(product);
    assert.equal(verified.available, true);
    assert.equal(verified.variants[0].stock, 5);
    assert.equal(apiRequests, 1);
  } finally {
    await monitor.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  assert.equal(disposed, true);
});

test('誠品 purchase_status 遇到 403 時只冷卻並重建 API 連線，不開商品頁', async () => {
  let openedPages = 0;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    esliteBlockedRetryMs: 5000,
    fetcher: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    browserLauncher: async () => ({
      newPage: async () => { openedPages += 1; throw new Error('不應開啟瀏覽器'); },
      close: async () => {}
    })
  });
  const product = {
    id: '10042014802683066235005', title: 'BEYBLADE X CX-06',
    url: 'https://www.eslite.com/product/10042014802683066235005', available: false
  };
  try {
    assert.deepEqual(await monitor.verifyEsliteProduct(product), product);
    assert.equal(openedPages, 0);
    assert.ok(monitor.esliteProductBlockedUntil.get(product.id) > Date.now());
  } finally {
    await monitor.close();
  }
});

test('誠品完整頁面遇到 Cloudflare 時暫停重複渲染，但搜尋監控不中斷', async () => {
  let openedPages = 0;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    esliteBlockedRetryMs: 5000,
    fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    browserLauncher: async () => ({
      newPage: async () => {
        openedPages += 1;
        return {
          waitForResponse: async () => ({ waitError: new Error('timeout') }),
          goto: async () => {}, title: async () => 'Attention Required! | Cloudflare',
          content: async () => '<div id="cf-error-details">blocked</div>', close: async () => {}
        };
      },
      close: async () => {}
    })
  });
  const product = {
    id: '10042014802683066235005', title: 'BEYBLADE X CX-06',
    url: 'https://www.eslite.com/product/10042014802683066235005', available: false
  };
  try {
    assert.deepEqual(await monitor.verifyEsliteProduct(product), product);
    assert.deepEqual(await monitor.verifyEsliteProduct(product), product);
    assert.equal(openedPages, 1);
    assert.ok(monitor.eslitePageBlockedUntil > Date.now());
  } finally {
    await monitor.close();
  }
});

test('誠品策展 API 失敗只暫停策展頁，不會跳過已知單品確認', async () => {
  const product = {
    id: '10042014802683066235005', title: 'BEYBLADE X CX-06',
    url: 'https://www.eslite.com/product/10042014802683066235005', available: false
  };
  let openedPages = 0;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ product_button_status: 'add_to_shopping_cart', stock: 2 })
    }),
    browserLauncher: async () => ({
      newPage: async () => {
        openedPages += 1;
        return openedPages === 1
          ? {
              waitForResponse: async () => ({ waitError: new Error('timeout') }),
              goto: async () => {}, title: async () => 'Attention Required! | Cloudflare',
              content: async () => '<div id="cf-error-details">blocked</div>', close: async () => {}
            }
          : { waitForResponse: async () => ({ waitError: new Error('unexpected') }), goto: async () => {}, close: async () => {} };
      },
      close: async () => {}
    })
  });
  try {
    await assert.rejects(monitor.loadEsliteExhibitProducts('https://www.eslite.com/exhibitions/CU202608-00061'), /Cloudflare/);
    assert.ok(monitor.esliteExhibitBlockedUntil > Date.now());
    assert.equal(monitor.eslitePageBlockedUntil, 0);
    const verified = await monitor.verifyEsliteProduct(product);
    assert.equal(verified.available, true);
    assert.equal(openedPages, 1);
  } finally {
    await monitor.close();
  }
});

test('誠品策展舊 API 回傳 404 時直接解析策展頁商品，不等待搜尋索引', async () => {
  let rendered = false;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({ status: () => 404 }),
        goto: async () => {},
        waitForSelector: async () => { rendered = true; },
        title: async () => 'BEYBLADE X 戰鬥陀螺｜誠品線上',
        content: async () => rendered ? `
          <article class="exhibit-card">
            <a href="/product/10042014802683179742001"><h3>BEYBLADE X戰鬥陀螺/ BX-10/ 極限衝擊戰鬥盤</h3><img src="/bx10.jpg"></a>
            <button>加入購物車</button><span>NT$850</span>
          </article>` : '<div id="app"></div>',
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  try {
    const products = await monitor.loadEsliteExhibitProducts('https://www.eslite.com/exhibitions/CU202608-00061');
    assert.equal(products.length, 1);
    assert.equal(products[0].id, '10042014802683179742001');
    assert.equal(products[0].available, true);
    assert.equal(products.discoveryPage.productCount, 1);
    assert.equal(products.discoveryPage.isLive, true);
    assert.equal(monitor.esliteExhibitBlockedUntil, 0);
  } finally {
    await monitor.close();
  }
});

test('誠品策展頁轉到 404 時回報已下架供重開去重使用', async () => {
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({ status: () => 404 }),
        goto: async () => {},
        waitForSelector: async () => {},
        url: () => 'https://www.eslite.com/error/404',
        title: async () => '404 頁面不存在 │ 誠品線上',
        content: async () => '<main>404 頁面不存在</main>',
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  try {
    const products = await monitor.loadEsliteExhibitProducts('https://www.eslite.com/exhibitions/CU202608-00061');
    assert.equal(products.length, 0);
    assert.equal(products.discoveryPage.isLive, false);
    assert.equal(products.discoveryPage.unavailableReason, 'page_not_found');
    assert.equal(monitor.esliteExhibitBlockedUntil, 0);
  } finally {
    await monitor.close();
  }
});

test('誠品單一商品未回傳 purchase_status 時只冷卻該商品', async () => {
  let openedPages = 0;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    esliteBlockedRetryMs: 5000,
    fetcher: async (url) => String(url).includes('10042014802683066235005')
      ? ({ ok: false, status: 503, json: async () => ({}) })
      : ({ ok: false, status: 404, json: async () => ({}) }),
    browserLauncher: async () => ({
      newPage: async () => {
        openedPages += 1;
        return {
          waitForResponse: async () => ({ json: async () => ({ product_button_status: 'add_to_shopping_cart', stock: 3 }) }),
          goto: async () => {}, close: async () => {}
        };
      },
      close: async () => {}
    })
  });
  const first = { id: '10042014802683066235005', title: 'BEYBLADE X CX-06', url: 'https://www.eslite.com/product/10042014802683066235005', available: false };
  const second = { id: '10042014802683179742001', title: 'BEYBLADE X BX-10', url: 'https://www.eslite.com/product/10042014802683179742001', available: false };
  try {
    assert.deepEqual(await monitor.verifyEsliteProduct(first), first);
    assert.deepEqual(await monitor.verifyEsliteProduct(first), first);
    const verified = await monitor.verifyEsliteProduct(second);
    assert.equal(verified.available, true);
    assert.equal(openedPages, 1);
    assert.equal(monitor.eslitePageBlockedUntil, 0);
    assert.ok(monitor.esliteProductBlockedUntil.get(first.id) > Date.now());
  } finally {
    await monitor.close();
  }
});

test('誠品多線同時命中同一補貨時只推播與交接一次', async () => {
  const id = '10042014802683179742001';
  const target = {
    id: 'eslite-parallel-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords'
  };
  const state = { data: { commerce: { shoppingSites: { targets: { [target.id]: {
    initialized: true,
    seen: { [id]: { id, title: 'BEYBLADE X BX-10', url: `https://www.eslite.com/product/${id}`, available: false, variants: [] } }
  } } } } }, async save() {} };
  const notifications = [];
  const purchases = [];
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [target],
    notify: async (text) => notifications.push(text),
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });
  const available = {
    id, title: 'BEYBLADE X BX-10 極限衝擊戰鬥盤', url: `https://www.eslite.com/product/${id}`,
    available: true, status: 'add_to_shopping_cart', variants: [{ id, name: 'BX-10', stock: 56, available: true }]
  };
  monitor.applyImmediateEsliteObservations(target, [available], { source: 'holmes-latest' });
  monitor.applyImmediateEsliteObservations(target, [{ ...available, availabilitySource: 'eslite-purchase-status' }], { source: 'purchase-status', authoritative: true });
  await Promise.resolve();
  assert.equal(notifications.length, 1);
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].detectionSource, 'holmes-latest');
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen[id].available, true);
});

test('誠品精確片語可搭配兒童玩具分類 42773 作為額外搜尋入口', async () => {
  const target = {
    id: 'eslite-category-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords',
    keywords: [], categorySearches: [{ keyword: '"BEYBLADE X"', categoryId: '42773' }], discoveryUrls: []
  };
  const visited = [];
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({ json: async () => ({ results: [{
          id: 'bx33', name: 'BEYBLADE X戰鬥陀螺 BX-33 皓戰猛虎',
          availability: 'IN_STOCK', button_status: 'coming_soon_not_book'
        }] }) }),
        goto: async (url) => visited.push(url), close: async () => {}
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(products.length, 1);
    assert.equal(products[0].status, 'coming_soon_not_book');
    assert.match(visited[0], /keyword=%22BEYBLADE%20X%22/i);
    assert.match(visited[0], /categories=%5B42773%5D/i);
  } finally {
    await monitor.close();
  }
});

test('誠品 TAKARA TOMY 品牌精確搜尋會帶入官方 brands 條件並獨立合併', async () => {
  const target = {
    id: 'eslite-brand-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords',
    keywords: [], categorySearches: [], latestSearches: [],
    brandSearches: [{ keyword: '"beyblade"', brands: ['TAKARA TOMY'], maxPages: 1 }],
    discoveryUrls: []
  };
  const visited = [];
  let predicateVerified = false;
  const response = (url) => ({ url: () => url, status: () => 200 });
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async (predicate) => {
          const apiUrl = 'https://holmes.eslite.com/v1/search?q=%22beyblade%22&brandName=%5B%22TAKARA%20TOMY%22%5D&page_no=1&page_size=20&facet=false';
          assert.equal(predicate(response(apiUrl)), true);
          predicateVerified = true;
          return {
            url: () => apiUrl,
            json: async () => ({
              results: [{
                id: 'cx99', name: 'BEYBLADE X戰鬥陀螺 CX-99 測試陀螺',
                availability: 'IN_STOCK', button_status: 'add_to_shopping_cart'
              }],
              page_no: 1, page_size: 20, total_size: 1
            })
          };
        },
        goto: async (url) => visited.push(url),
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(predicateVerified, true);
    assert.equal(products[0].id, 'cx99');
    assert.match(visited[0], /keyword=%22beyblade%22/i);
    assert.match(visited[0], /brands=WyJUQUtBUkEgVE9NWSJd/i);
  } finally {
    await monitor.close();
  }
});

test('誠品搜尋頁已有商品時直接讀取畫面，不等待缺席的 Holmes 回應', async () => {
  const target = {
    id: 'eslite-dom-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords',
    keywords: [], categorySearches: [], latestSearches: [{ keyword: 'BEYBLADE X' }], discoveryUrls: []
  };
  let closed = false;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => new Promise(() => {}),
        goto: async () => {},
        waitForTimeout: async () => {},
        content: async () => `
          <main><article class="product-item">
            <a href="/product/10042014802689999999001">
              <img alt="BEYBLADE X戰鬥陀螺 CX-99 測試陀螺" src="/test.webp">
            </a>
            <span>NT$595</span><button>加入購物車</button>
          </article></main>`,
        close: async () => { closed = true; }
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(products.length, 1);
    assert.equal(products[0].id, '10042014802689999999001');
    assert.equal(products[0].available, true);
    assert.equal(closed, true);
  } finally {
    await monitor.close();
  }
});

test('誠品收納包與收納盒不列入陀螺販售通知', () => {
  const products = parseEsliteSearchData({ results: [
    { id: 'bx25', name: 'BEYBLADE X戰鬥陀螺 BX-25 專業收納包', button_status: 'coming_soon_not_book' },
    { id: 'bx57', name: 'BEYBLADE X戰鬥陀螺 BX-57 3V3對戰收納盒 黑', button_status: 'coming_soon_not_book' },
    { id: 'bx33', name: 'BEYBLADE X戰鬥陀螺 BX-33 皓戰猛虎', button_status: 'add_to_shopping_cart' }
  ] });
  assert.deepEqual(products.map((product) => product.id), ['bx33']);
});

test('誠品最新上架搜尋不依賴分類並只讀第一頁快速發現新品', async () => {
  const target = {
    id: 'eslite-latest-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords',
    keywords: [], categorySearches: [], latestSearches: [{ keyword: '"BEYBLADE X"' }], discoveryUrls: []
  };
  const visited = [];
  const rows = [
    { id: 'bx33', name: 'BEYBLADE X戰鬥陀螺 BX-33 皓戰猛虎', availability: 'IN_STOCK', button_status: 'add_to_shopping_cart' },
    ...Array.from({ length: 19 }, (_, index) => ({ id: `book-${index}`, name: `Beyblade X, Vol. ${index + 1}` }))
  ];
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({ json: async () => ({ results: rows }) }),
        goto: async (url) => visited.push(url), close: async () => {}
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(products.length, 1);
    assert.equal(products[0].id, 'bx33');
    assert.equal(visited.length, 1);
    assert.match(visited[0], /sort=manufacturer_date%20desc/i);
    assert.doesNotMatch(visited[0], /categories=/i);
  } finally {
    await monitor.close();
  }
});

test('誠品關鍵字來源會合併多組搜尋結果並以商品 ID 去重', async () => {
  const target = {
    id: 'eslite-keywords-test',
    name: '誠品戰鬥陀螺關鍵字探索',
    siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X',
    sourceType: 'eslite-keywords',
    keywords: ['BEYBLADE X', '戰鬥陀螺'],
    discoveryUrls: [],
    enabled: true
  };
  const payloads = [
    { results: [{ id: 'ux20', name: 'BEYBLADE X戰鬥陀螺 UX-20 榮耀武神LF', availability: 'IN_STOCK', button_status: 'add_to_shopping_cart' }] },
    { results: [
      { id: 'ux20', name: 'BEYBLADE X戰鬥陀螺 UX-20 榮耀武神LF', availability: 'IN_STOCK', button_status: 'add_to_shopping_cart' },
      { id: 'bx35', name: 'BEYBLADE X戰鬥陀螺 BX-35 隨機強化組 Vol.04', availability: 'OUT_OF_STOCK', button_status: 'can_not_buy' }
    ] }
  ];
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} },
    getTargets: () => [target],
    notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({ json: async () => payloads.shift() }),
        goto: async () => {},
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(products.length, 2);
    assert.equal(products.find((product) => product.id === 'ux20').available, true);
    assert.equal(products.find((product) => product.id === 'bx35').available, false);
  } finally {
    await monitor.close();
  }
});

test('誠品不再採用會回傳矛盾結果的主題與可購篩選器', async () => {
  const target = {
    id: 'eslite-available-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords',
    keywords: ['BEYBLADE X'], discoveryUrls: [],
    availabilityUrl: 'https://www.eslite.com/Search?keyword=戰鬥陀螺&status=add_to_shopping_cart&themes=test'
  };
  const payloads = [
    { results: [{ id: 'ux14', name: 'BEYBLADE X戰鬥陀螺 UX-14 天蠍長矛', availability: 'OUT_OF_STOCK', button_status: 'can_not_buy' }] },
    { results: [] },
    { results: [{ id: 'ux14', name: 'BEYBLADE X戰鬥陀螺 UX-14 天蠍長矛', availability: 'IN_STOCK', button_status: 'add_to_shopping_cart', final_price: 595 }] }
  ];
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({ waitForResponse: async () => ({ json: async () => payloads.shift() }), goto: async () => {}, close: async () => {} }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(products.length, 1);
    assert.equal(products[0].available, false);
    assert.equal(payloads.length, 1);
  } finally {
    await monitor.close();
  }
});

test('誠品關鍵字搜尋會讀取第 21 筆以後的商品', async () => {
  const target = {
    id: 'eslite-pagination-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=戰鬥陀螺', sourceType: 'eslite-keywords',
    keywords: ['戰鬥陀螺'], discoveryUrls: []
  };
  const payloads = [
    { results: Array.from({ length: 20 }, (_, index) => ({ id: `book-${index}`, name: `一般書籍 ${index}` })) },
    { results: [{ id: 'bx50', name: 'BEYBLADE X戰鬥陀螺 BX-50 天堂日輪', availability: 'IN_STOCK', button_status: 'add_to_shopping_cart' }] }
  ];
  const visited = [];
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({ json: async () => payloads.shift() }),
        goto: async (url) => visited.push(url), close: async () => {}
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(products.length, 1);
    assert.equal(products[0].id, 'bx50');
    assert.match(visited[0], /start=0/);
    assert.match(visited[1], /start=1/);
  } finally {
    await monitor.close();
  }
});

test('誠品搜尋不相信延遲的 total_size，固定確認第二頁', async () => {
  const target = {
    id: 'eslite-page-count-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=戰鬥陀螺', sourceType: 'eslite-keywords',
    keywords: ['戰鬥陀螺'], discoveryUrls: []
  };
  const visited = [];
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({
          json: async () => ({
            results: Array.from({ length: 20 }, (_, index) => ({ id: `book-${index}`, name: `一般書籍 ${index}` })),
            page_no: 1,
            page_size: 20,
            total_size: 20
          })
        }),
        goto: async (url) => visited.push(url),
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  try {
    await monitor.loadEsliteKeywordProducts(target);
    assert.equal(visited.length, 2);
    assert.match(visited[0], /start=0/);
    assert.match(visited[1], /start=1/);
  } finally {
    await monitor.close();
  }
});

test('誠品第二頁沿用第一頁 Holmes API，不依賴搜尋畫面再次觸發請求', async () => {
  const target = {
    id: 'eslite-direct-page-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=戰鬥陀螺', sourceType: 'eslite-keywords',
    keywords: ['戰鬥陀螺'], discoveryUrls: []
  };
  const visited = [];
  const fetched = [];
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    fetcher: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        json: async () => ({
          results: [{ id: 'ux21', name: 'BEYBLADE X戰鬥陀螺 UX-21 惡魔冥界改造組', availability: 'IN_STOCK', button_status: 'add_to_shopping_cart' }],
          page_no: 2,
          page_size: 20,
          total_size: 21
        })
      };
    },
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async () => ({
          url: () => 'https://holmes.eslite.com/v1/search?q=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&page_no=1&page_size=20&facet=false&visitor_id=test-visitor',
          json: async () => ({
            results: Array.from({ length: 20 }, (_, index) => ({ id: `book-${index}`, name: `一般書籍 ${index}` })),
            page_no: 1,
            page_size: 20,
            total_size: 21
          })
        }),
        goto: async (url) => visited.push(url),
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(visited.length, 1);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], /page_no=2/);
    assert.match(fetched[0], /visitor_id=test-visitor/);
    assert.equal(products[0].id, 'ux21');
  } finally {
    await monitor.close();
  }
});

test('誠品 Holmes API 樣板可跨掃描輪次重用，正常時不再重開搜尋頁', async () => {
  const target = {
    id: 'eslite-template-cache-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=戰鬥陀螺', sourceType: 'eslite-keywords',
    keywords: ['戰鬥陀螺'], discoveryUrls: []
  };
  let openedPages = 0;
  const fetched = [];
  const payload = {
    results: [{ id: 'bx52', name: 'BEYBLADE X戰鬥陀螺 BX-52', availability: 'IN_STOCK', button_status: 'add_to_shopping_cart' }],
    page_no: 1, page_size: 20, total_size: 1
  };
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    fetcher: async (url) => {
      fetched.push(url);
      const pageNo = Number(new URL(url).searchParams.get('page_no')) || 1;
      return { ok: true, json: async () => ({ ...payload, page_no: pageNo }) };
    },
    browserLauncher: async () => ({
      newPage: async () => {
        openedPages += 1;
        return {
          waitForResponse: async () => ({
            url: () => 'https://holmes.eslite.com/v1/search?q=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&page_no=1&page_size=20&facet=false&visitor_id=cached-visitor',
            json: async () => payload
          }),
          goto: async () => {}, close: async () => {}
        };
      },
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    await monitor.loadEsliteKeywordProducts(target);
    await monitor.loadEsliteKeywordProducts(target);
    assert.equal(openedPages, 1);
    assert.equal(fetched.length, 3);
    assert.match(fetched[0], /visitor_id=cached-visitor/);
    assert.match(fetched[0], /page_no=2/);
    assert.match(fetched[1], /page_no=1/);
    assert.match(fetched[2], /page_no=2/);
  } finally {
    await monitor.close();
  }
});

test('誠品 Holmes 暫時回傳 429 時保留 API 樣板，不啟動瀏覽器且下一輪 API 可恢復', async () => {
  const target = {
    id: 'eslite-transient-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=戰鬥陀螺', sourceType: 'eslite-keywords',
    keywords: [], latestSearches: [{ keyword: '戰鬥陀螺' }], discoveryUrls: []
  };
  const payload = {
    results: [{ id: 'bx52', name: 'BEYBLADE X戰鬥陀螺 BX-52', button_status: 'can_not_buy' }],
    page_no: 1, page_size: 20, total_size: 1
  };
  let openedPages = 0;
  let apiCalls = 0;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    fetcher: async () => {
      apiCalls += 1;
      return apiCalls === 1
        ? { ok: false, status: 429 }
        : { ok: true, json: async () => payload };
    },
    browserLauncher: async () => ({
      newPage: async () => {
        openedPages += 1;
        return {
          waitForResponse: async () => openedPages === 1
            ? { url: () => 'https://holmes.eslite.com/v1/search?q=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&page_no=1&page_size=20&facet=false&visitor_id=test', json: async () => payload }
            : { waitError: new Error('response timeout') },
          goto: async () => {}, close: async () => {}
        };
      },
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    assert.equal((await monitor.loadEsliteKeywordProducts(target)).length, 1);
    assert.equal(monitor.esliteHolmesTemplates.size, 1);
    await assert.rejects(monitor.loadEsliteKeywordProducts(target), /本次皆無法讀取/);
    assert.equal(monitor.esliteHolmesTemplates.size, 1);
    assert.equal(monitor.esliteSearchBrowserBlockedUntil, 0);
    assert.equal((await monitor.loadEsliteKeywordProducts(target)).length, 1);
    assert.equal(openedPages, 1);
    assert.equal(apiCalls, 2);
  } finally {
    await monitor.close();
  }
});

test('誠品搜尋頁連續失敗時全組關鍵字共用退避，舊驗證標記不能偽裝本輪成功', async () => {
  const target = {
    id: 'eslite-outage-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=戰鬥陀螺', sourceType: 'eslite-keywords',
    keywords: ['戰鬥陀螺', 'BEYBLADE X', 'UX-21'], discoveryUrls: []
  };
  const known = {
    id: '10042014802683232221009', title: 'BEYBLADE X戰鬥陀螺 UX-21',
    url: 'https://www.eslite.com/product/10042014802683232221009',
    available: false, availabilitySource: 'eslite-purchase-status'
  };
  const logs = [];
  let openedPages = 0;
  const monitor = new ShoppingSiteMonitor({
    state: { data: { commerce: { shoppingSites: { targets: { [target.id]: { seen: { [known.id]: known } } } } } }, async save() {} },
    getTargets: () => [target], notify: async () => {}, log: (message) => logs.push(message),
    browserLauncher: async () => ({
      newPage: async () => {
        openedPages += 1;
        return {
          waitForResponse: async () => ({ waitError: new Error('response timeout') }),
          goto: async () => {}, close: async () => {}
        };
      },
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, availabilitySource: 'eslite-purchase-status' });
  try {
    await assert.rejects(monitor.loadEsliteKeywordProducts(target), /本次皆無法讀取/);
    const firstRoundPages = openedPages;
    assert.ok(firstRoundPages > 0 && firstRoundPages <= 4);
    await assert.rejects(monitor.loadEsliteKeywordProducts(target), /本次皆無法讀取/);
    assert.equal(openedPages, firstRoundPages);
    assert.equal(logs.filter((message) => message.includes('誠品搜尋頁暫時無法讀取')).length, 1);
  } finally {
    await monitor.close();
  }
});

test('誠品搜尋只接受正確頁碼且非 facet 的 Holmes 回應', async () => {
  const target = {
    id: 'eslite-response-match-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=戰鬥陀螺', sourceType: 'eslite-keywords',
    keywords: ['戰鬥陀螺'], discoveryUrls: []
  };
  const response = (url) => ({ url: () => url, status: () => 200 });
  let predicateVerified = false;
  const monitor = new ShoppingSiteMonitor({
    state: { data: {}, async save() {} }, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({
        waitForResponse: async (predicate) => {
          assert.equal(predicate(response('https://holmes.eslite.com/v1/search?q=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&page_no=1&page_size=20&facet=true')), false);
          assert.equal(predicate(response('https://holmes.eslite.com/v1/search?q=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&page_no=2&page_size=20&facet=false')), false);
          assert.equal(predicate(response('https://holmes.eslite.com/v1/search?q=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&page_no=1&page_size=20&facet=false')), true);
          predicateVerified = true;
          return {
            json: async () => ({ results: [], page_no: 1, page_size: 20, total_size: 0 })
          };
        },
        goto: async () => {},
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  try {
    await monitor.loadEsliteKeywordProducts(target);
    assert.equal(predicateVerified, true);
  } finally {
    await monitor.close();
  }
});

test('誠品搜尋暫時移除既有商品時保留基線但不直查商品頁', async () => {
  const target = {
    id: 'eslite-known-test', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords',
    keywords: ['BEYBLADE X'], discoveryUrls: []
  };
  const state = { data: { commerce: { shoppingSites: { targets: { [target.id]: { seen: {
    ux14: { id: 'ux14', title: 'BEYBLADE X戰鬥陀螺 UX-14 天蠍長矛', url: 'https://www.eslite.com/product/ux14', available: false }
  } } } } } }, async save() {} };
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [target], notify: async () => {},
    browserLauncher: async () => ({
      newPage: async () => ({ waitForResponse: async () => ({ json: async () => ({ results: [] }) }), goto: async () => {}, close: async () => {} }),
      close: async () => {}
    })
  });
  monitor.verifyEsliteProduct = async (product) => ({ ...product, available: true, availabilitySource: 'eslite-product-page' });
  try {
    const products = await monitor.loadEsliteKeywordProducts(target);
    assert.equal(products.length, 1);
    assert.equal(products[0].available, false);
  } finally {
    await monitor.close();
  }
});

test('誠品策展同時上架多項商品時逐項通知並附前台庫存', async () => {
  const target = {
    id: 'eslite-api-test',
    name: 'BEYBLADE X 精選策展',
    siteName: '誠品線上',
    url: 'https://www.eslite.com/exhibitions/CU202503-00091',
    enabled: true
  };
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                '10042014802683132117006': {
                  id: '10042014802683132117006',
                  title: 'BEYBLADE X UX-14 天蠍長矛',
                  url: 'https://www.eslite.com/product/10042014802683132117006',
                  available: false,
                  variants: [{
                    id: '10042014802683132117006',
                    name: 'BEYBLADE X UX-14 天蠍長矛',
                    stock: 0,
                    available: false
                  }]
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const apiData = {
    contents: [{
      book_list: [
        {
          product_guid: '10042014802683132117006',
          name: 'BEYBLADE X UX-14 天蠍長矛',
          status: 'can_not_buy',
          stock: 0
        },
        {
          product_guid: '10042014802683183210008',
          name: 'BEYBLADE X BX-35 隨機強化組 Vol. 04',
          status: 'can_buy',
          stock: 108
        },
        {
          product_guid: '10042014802683183208005',
          name: 'BEYBLADE X BX-00 暴風天馬3-70RA',
          status: 'can_buy',
          stock: 108
        },
        {
          product_guid: '10042014802683183209002',
          name: 'BEYBLADE X BX-33 皓銀戰狼',
          status: 'can_buy',
          stock: 36
        },
        {
          product_guid: '10042014802683183207008',
          name: 'BEYBLADE X UX-04 極限衝擊對戰組U',
          status: 'can_buy',
          stock: 41
        },
        {
          product_guid: '10042014802683183206001',
          name: 'BEYBLADE X UX-20 榮耀聖劍',
          status: 'can_buy',
          stock: 144
        },
        {
          product_guid: '10042014802683183205004',
          name: 'BEYBLADE X BX-18 發射器',
          status: 'can_buy',
          stock: 36
        },
        {
          product_guid: '10042014802683183204007',
          name: 'BEYBLADE X BXG-01 龍騎士',
          status: 'can_buy',
          stock: 120
        }
      ]
    }]
  };
  const page = {
    waitForResponse: async () => ({
      url: () => 'https://athena.eslite.com/api/v1/book_exhibits/CU202503-00091',
      status: () => 200,
      json: async () => apiData
    }),
    goto: async () => {},
    close: async () => {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    browserLauncher: async () => ({
      newPage: async () => page,
      close: async () => {}
    }),
    notify: async (text, options) => notifications.push({ text, options })
  });

  const result = await monitor.scan();
  assert.equal(result.checkedProducts, 8);
  assert.equal(result.discovered, 7);
  assert.equal(result.notified, 7);
  assert.equal(notifications.length, 7);
  assert.match(notifications[0].text, /BX-35/);
  assert.match(notifications[0].text, /前台可售：108 組/);
  assert.match(notifications[0].options.discordPreview, /前台可售 108 組/);
  assert.equal(notifications[0].options.embeds[0].description.includes('**前台可售：** 108 組'), true);
});

test('誠品策展頁首次可讀就發準備補貨重點預警且不重複', async () => {
  const target = {
    id: 'eslite-exhibition-alert', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords', enabled: true
  };
  const product = {
    id: '10042014802683132117006', title: 'BEYBLADE X戰鬥陀螺 UX-14 天蠍長矛',
    url: 'https://www.eslite.com/product/10042014802683132117006',
    imageUrl: 'https://s2.eslite.com/ux14.jpg', available: false, variants: []
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: {
      initialized: true, seen: { [product.id]: product }
    } } } } },
    async save() {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [target],
    notify: async (text, options) => notifications.push({ text, options })
  });
  monitor.loadEsliteKeywordProducts = async () => {
    const products = [{ ...product }];
    products.discoveryPages = [{
      url: 'https://www.eslite.com/exhibitions/CU202608-00061',
      title: 'BEYBLADE X戰鬥陀螺｜基本入門、強化改造',
      productCount: 5,
      imageUrl: product.imageUrl
    }];
    return products;
  };

  const first = await monitor.scan();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await monitor.scan();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.notified, 1);
  assert.equal(second.notified, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /誠品重點預警/);
  assert.match(notifications[0].text, /準備補貨／開賣/);
  assert.match(notifications[0].text, /CU202608-00061/);
  assert.match(notifications[0].options.discordPreview, /策展頁已上架/);
  assert.equal(notifications[0].options.embeds[0].thumbnail.url, product.imageUrl);
  assert.ok(state.data.commerce.shoppingSites.targets[target.id].discoveryPages[
    'https://www.eslite.com/exhibitions/CU202608-00061'
  ].notifiedAt);
});

test('誠品策展頁確認下架後重新開啟只再通知一次', async () => {
  const target = {
    id: 'eslite-exhibition-reopen', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords', enabled: true
  };
  const pageUrl = 'https://www.eslite.com/exhibitions/CU202608-00061';
  const product = {
    id: '10042014802683132117006', title: 'BEYBLADE X戰鬥陀螺 UX-14 天蠍長矛',
    url: 'https://www.eslite.com/product/10042014802683132117006', available: false, variants: []
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: {
      initialized: true,
      seen: { [product.id]: product },
      discoveryPages: { [pageUrl]: {
        url: pageUrl, title: 'BEYBLADE X 戰鬥陀螺策展', productCount: 1,
        isLive: true, notifiedAt: '2026-09-17T02:21:54.000Z'
      } }
    } } } } },
    async save() {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [target],
    notify: async (text, options) => notifications.push({ text, options })
  });
  let isLive = false;
  monitor.loadEsliteKeywordProducts = async () => {
    const products = [{ ...product }];
    products.discoveryPages = [{
      url: pageUrl,
      title: 'BEYBLADE X戰鬥陀螺｜基本入門、強化改造',
      productCount: isLive ? 1 : 0,
      isLive
    }];
    return products;
  };

  const closed = await monitor.scan();
  isLive = true;
  const reopened = await monitor.scan();
  const stillOpen = await monitor.scan();

  assert.equal(closed.notified, 0);
  assert.equal(reopened.notified, 1);
  assert.equal(stillOpen.notified, 0);
  assert.equal(notifications.length, 1);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].discoveryPages[pageUrl].isLive, true);
  assert.ok(state.data.commerce.shoppingSites.targets[target.id].discoveryPages[pageUrl].lastUnavailableAt);
});

test('誠品舊版永久去重紀錄在長時間不可讀後只遷移補通知一次', async () => {
  const target = {
    id: 'eslite-exhibition-legacy-reopen', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords', enabled: true
  };
  const pageUrl = 'https://www.eslite.com/exhibitions/CU202608-00061';
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: {
      initialized: true,
      seen: {},
      discoveryPages: { [pageUrl]: {
        url: pageUrl,
        title: 'BEYBLADE X 戰鬥陀螺策展',
        productCount: 1,
        lastSeenAt: '2026-09-17T02:21:54.000Z',
        notifiedAt: '2026-09-17T02:21:54.000Z'
      } }
    } } } } },
    async save() {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [target], notify: async (text) => notifications.push(text)
  });
  monitor.loadEsliteKeywordProducts = async () => {
    const products = [];
    products.discoveryPages = [{
      url: pageUrl,
      title: 'BEYBLADE X戰鬥陀螺｜基本入門、強化改造',
      productCount: 1,
      isLive: true
    }];
    products.sourceProductCount = 1;
    products.successfulSources = 1;
    return products;
  };

  const migrated = await monitor.scan();
  const repeated = await monitor.scan();

  assert.equal(migrated.notified, 1);
  assert.equal(repeated.notified, 0);
  assert.equal(notifications.length, 1);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].discoveryPages[pageUrl].isLive, true);
});

test('誠品策展快線不等待搜尋或過往基線就先完成推播', async () => {
  const pageUrl = 'https://www.eslite.com/exhibitions/CU202608-00061';
  const product = {
    id: '10042014802683132117006',
    title: 'BEYBLADE X戰鬥陀螺 UX-14 天蠍長矛',
    url: 'https://www.eslite.com/product/10042014802683132117006',
    available: false,
    variants: []
  };
  const target = {
    id: 'eslite-three-lanes', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords', enabled: true,
    keywords: [], discoveryUrls: [pageUrl]
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: {
      initialized: true, seen: { [product.id]: product }
    } } } } },
    async save() {}
  };
  let releaseBaseline;
  const baselineGate = new Promise((resolve) => { releaseBaseline = resolve; });
  let resolveNotification;
  const notificationArrived = new Promise((resolve) => { resolveNotification = resolve; });
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    browserLauncher: async () => ({ close: async () => {} }),
    notify: async (text) => {
      notifications.push(text);
      resolveNotification();
      return 'discord-fast-lane';
    }
  });
  monitor.loadEsliteExhibitProducts = async () => {
    const products = [{ ...product }];
    products.discoveryPage = {
      url: pageUrl,
      title: 'BEYBLADE X戰鬥陀螺｜基本入門、強化改造',
      productCount: 1,
      isLive: true
    };
    return products;
  };
  monitor.verifyEsliteProduct = async (item) => {
    await baselineGate;
    return item;
  };

  let loadSettled = false;
  const loadPromise = monitor.loadEsliteKeywordProducts(target).finally(() => { loadSettled = true; });
  await Promise.race([
    notificationArrived,
    new Promise((_, reject) => setTimeout(() => reject(new Error('策展快線未先完成推播')), 1000))
  ]);
  assert.equal(loadSettled, false);
  assert.equal(notifications.length, 1);
  releaseBaseline();
  await loadPromise;
  await monitor.loadEsliteKeywordProducts(target);
  assert.equal(notifications.length, 1);
  await monitor.close();
});

test('誠品策展重點通知會明確標示尚未等於可購買', () => {
  const notification = esliteExhibitionNotification(
    { name: '誠品戰鬥陀螺關鍵字探索' },
    {
      url: 'https://www.eslite.com/exhibitions/CU202608-00061',
      title: 'BEYBLADE X戰鬥陀螺｜基本入門、強化改造',
      productCount: 5
    },
    { detectedAt: '2026-09-17T02:30:00.000Z' }
  );
  assert.match(notification.options.embeds[0].description, /準備補貨／開賣/);
  assert.match(notification.options.embeds[0].description, /不等於商品已可購買/);
  assert.equal(notification.options.embeds[0].timestamp, '2026-09-17T02:30:00.000Z');
});

test('誠品新出現的即將開賣商品會先預警但不交給購買工作器', async () => {
  const target = {
    id: 'eslite-coming-soon', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords', enabled: true
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: { initialized: true, seen: {} } } } } },
    async save() {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state, getTargets: () => [target], notify: async (text, options) => notifications.push({ text, options })
  });
  monitor.loadEsliteKeywordProducts = async () => [{
    id: '10042014802683209796004',
    title: 'BEYBLADE X戰鬥陀螺 CX-12 鳳凰閃焰',
    url: 'https://www.eslite.com/product/10042014802683209796004',
    price: 'NT$225', available: false, status: 'coming_soon_not_book', variants: []
  }];

  const result = await monitor.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.discovered, 1);
  assert.equal(result.notified, 1);
  assert.equal(result.purchaseCandidates.length, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].options.discordPreview, /即將開賣/);
});

test('誠品即將開賣商品切換為可購時會同步推播並交給購買工作器', async () => {
  const target = {
    id: 'eslite-live-sale', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords', enabled: true
  };
  const product = {
    id: '10042014802683210000001', title: 'BEYBLADE X戰鬥陀螺 CX-12 鳳凰閃焰',
    url: 'https://www.eslite.com/product/10042014802683210000001', price: 'NT$350'
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: {
      initialized: true,
      seen: { [product.id]: {
        ...product, available: false, status: 'coming_soon_not_book',
        variants: [{ id: product.id, name: product.title, stock: 0, available: false }]
      } }
    } } } } },
    async save() {}
  };
  const notifications = [];
  const purchases = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    notify: async (text, options) => notifications.push({ text, options }),
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });
  monitor.loadEsliteKeywordProducts = async () => [{
    ...product, available: true, status: 'add_to_shopping_cart',
    variants: [{ id: product.id, name: product.title, stock: 12, available: true }]
  }];

  const result = await monitor.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.restocked, 1);
  assert.equal(result.notified, 1);
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].stock, 12);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].options.discordPreview, /補貨|可購/);
});

test('誠品新陀螺即使先顯示無法購買也會在出現當下推播', async () => {
  const target = {
    id: 'eslite-listed-unavailable', name: '誠品戰鬥陀螺關鍵字探索', siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE%20X', sourceType: 'eslite-keywords', enabled: true
  };
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: { initialized: true, seen: {} } } } } },
    async save() {}
  };
  const notifications = [];
  const purchases = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    notify: async (text, options) => notifications.push({ text, options }),
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });
  monitor.loadEsliteKeywordProducts = async () => [{
    id: '10042014802683210000002', title: 'BEYBLADE X戰鬥陀螺 UX-20 榮耀武神',
    url: 'https://www.eslite.com/product/10042014802683210000002',
    price: 'NT$350', available: false, status: 'can_not_buy', variants: []
  }];

  const result = await monitor.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.discovered, 1);
  assert.equal(result.notified, 1);
  assert.equal(purchases.length, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /出現新的戰鬥陀螺商品/);
  assert.match(notifications[0].options.discordPreview, /新商品頁/);
});

test('新出現但仍缺貨的商品頁只建立基線，實際補貨後才通知', async () => {
  const target = { id: 'shopping-category', name: '測試專區', siteName: 'momo購物網', url: 'https://www.momoshop.com.tw/categories/test', enabled: true };
  const state = { data: {}, async save() {} };
  const known = '<article><a href="/product/11111111"><h3>BEYBLADE X 既有商品</h3></a><span>售完補貨中</span></article>'.padEnd(220, ' ');
  const unavailable = '<article><a href="/product/22222222"><h3>BEYBLADE X 新增保留頁</h3></a><span>售完補貨中</span></article>'.padEnd(220, ' ');
  const available = '<article><a href="/product/22222222"><h3>BEYBLADE X 新增保留頁</h3></a><button>加入購物車</button></article>'.padEnd(220, ' ');
  const pages = [known, known + unavailable, known + available];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async () => new Response(pages.shift(), { status: 200 }),
    notify: async (text) => notifications.push(text)
  });
  await monitor.scan();
  const missingStock = await monitor.scan();
  const restocked = await monitor.scan();
  assert.equal(missingStock.ignoredUnavailable, 1);
  assert.equal(missingStock.notified, 0);
  assert.equal(restocked.restocked, 1);
  assert.equal(restocked.notified, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /商品恢復可購買/);
});

test('基線後才通知新品與款式補貨', async () => {
  const target = { id: 'momo-test', name: 'momo 測試', url: 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510017974', enabled: true };
  const state = { data: {}, async save() {} };
  const pages = [
    `<h3>BEYBLADE X 戰鬥陀螺</h3><a href="${target.url}">BEYBLADE X 戰鬥陀螺</a>${String.raw`\"goodsTypeAName\":\"UX-14\",\"goodsNum\":\"0\"`}`,
    `<h3>BEYBLADE X 戰鬥陀螺</h3><a href="${target.url}">BEYBLADE X 戰鬥陀螺</a>${String.raw`\"goodsTypeAName\":\"UX-14\",\"goodsNum\":\"12\"`}`
  ];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async () => new Response(pages.shift(), { status: 200 }),
    notify: async (text) => notifications.push(text)
  });
  const first = await monitor.scan();
  const second = await monitor.scan();
  assert.equal(first.notified, 0);
  assert.equal(second.restocked, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /購物網站：momo購物網/);
  assert.match(notifications[0], /監控專區：momo 測試/);
  assert.match(notifications[0], /UX-14/);
});

test('複數款式庫存依 100、50、20、10 與售罄門檻通知', async () => {
  const target = { id: 'momo-stock', name: '墊腳石 TAKARA TOMY 專區', siteName: 'momo購物網', url: 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018109', enabled: true };
  const state = { data: {}, async save() {} };
  const html = (stock) => `<h3>BEYBLADE X 戰鬥陀螺</h3><a href="${target.url}">BEYBLADE X 戰鬥陀螺</a>${String.raw`\"goodsTypeAName\":\"CX-15 測試款\",\"goodsNum\":\"${stock}\"`}`;
  const pages = [html(132), html(68), html(49), html(9), html(0)];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async () => new Response(pages.shift(), { status: 200 }),
    notify: async (text, options) => notifications.push({ text, options })
  });
  await monitor.scan();
  const at100 = await monitor.scan();
  const at50 = await monitor.scan();
  const at10 = await monitor.scan();
  const soldOut = await monitor.scan();
  assert.equal(at100.stockChanged, 1);
  assert.equal(at50.stockChanged, 1);
  assert.equal(at10.stockChanged, 1);
  assert.equal(soldOut.stockChanged, 1);
  assert.equal(notifications.length, 4);
  assert.match(notifications[0].text, /132 → 68/);
  assert.match(notifications[2].text, /即將銷售完畢/);
  assert.match(notifications[3].text, /售罄提醒/);
  assert.match(notifications[0].options.discordPreview, /momo購物網｜墊腳石 TAKARA TOMY 專區/);
});

test('關閉庫存提醒時仍更新基線但不推播補貨', async () => {
  const target = { id: 'momo-muted', name: '自訂暱稱', url: 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018175', enabled: true };
  const state = { data: {}, async save() {} };
  const pages = [
    `<h3>BEYBLADE X 戰鬥陀螺</h3><a href="${target.url}">BEYBLADE X 戰鬥陀螺</a>${String.raw`\"goodsTypeAName\":\"BXG-01\",\"goodsNum\":\"0\"`}`,
    `<h3>BEYBLADE X 戰鬥陀螺</h3><a href="${target.url}">BEYBLADE X 戰鬥陀螺</a>${String.raw`\"goodsTypeAName\":\"BXG-01\",\"goodsNum\":\"15\"`}`
  ];
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async () => new Response(pages.shift(), { status: 200 }),
    notify: async (text) => notifications.push(text)
  });
  await monitor.scan({ notifyStockChanges: false });
  const second = await monitor.scan({ notifyStockChanges: false });
  assert.equal(second.restocked, 0);
  assert.equal(second.notified, 0);
  assert.equal(notifications.length, 0);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen.TP00024510018175.variants[0].stock, 15);
});

test('補貨高速模式略過專區頁並直接重讀已知 momo 複數商品', async () => {
  const productUrl = 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018109';
  const target = {
    id: 'momo-burst',
    name: '墊腳石 TAKARA TOMY 專區',
    siteName: 'momo購物網',
    sourceType: 'momo-store-api',
    url: 'https://www.momoshop.com.tw/TP/TP0002451/main?curPage=1',
    enabled: true
  };
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                TP00024510018109: {
                  id: 'TP00024510018109',
                  title: 'BEYBLADE X 戰鬥陀螺複數款式',
                  url: productUrl,
                  available: false,
                  variants: [
                    { id: 'UX-11 衝擊龍神豪華組', name: 'UX-11 衝擊龍神豪華組', stock: 0, available: false }
                  ]
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const requestedUrls = [];
  const logs = [];
  const notifications = [];
  const html = `<h3>BEYBLADE X 戰鬥陀螺複數款式</h3>${String.raw`\"goodsTypeAName\":\"UX-11 衝擊龍神豪華組\",\"goodsNum\":\"6\"`}`.padEnd(220, ' ');
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async (url) => {
      requestedUrls.push(url);
      return new Response(html, { status: 200 });
    },
    log: (message) => logs.push(message),
    notify: async (text) => notifications.push(text)
  });
  const result = await monitor.scan({ inventoryOnly: true });
  assert.equal(result.mode, 'inventory-boost');
  assert.equal(result.restocked, 1);
  assert.equal(result.notified, 1);
  assert.equal(result.variantChanges.length, 1);
  assert.deepEqual(requestedUrls, [productUrl]);
  assert.match(logs.join('\n'), /UX-11 衝擊龍神豪華組：前台可售 0 → 6 組/);
  assert.match(notifications[0], /UX-11 衝擊龍神豪華組/);
});

test('momo 店＋專區出現全新商品頁時即使已售罄仍通知並標記高速追蹤', async () => {
  const target = {
    id: 'momo-store-new-page',
    name: '墊腳石 TAKARA TOMY 專區',
    siteName: 'momo購物網',
    sourceType: 'momo-store-api',
    url: 'https://www.momoshop.com.tw/TP/TP0002451/main?curPage=1',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/TP/TP0002451/goodsDetail/TP00024510018190';
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: { initialized: true, seen: {} }
          }
        }
      }
    },
    async save() {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async (url) => {
      if (url === 'https://3pf.momo.com.tw/goods/app/shop/detail/query/v1') {
        return new Response(JSON.stringify(momoStoreDetailFixture({
          goodsCode: 'TP00024510018190',
          goodsName: 'BEYBLADE X BX-50 天堂日輪',
          variants: [{ goodsTypeAName: 'BX-50 天堂日輪', goodsTypeCode: '00001', goodsNum: '0', canTipStock: '0' }]
        })), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        resultCode: '200',
        maxPage: '1',
        rtnGoodsData: {
          goodsInfoList: [{
            goodsCode: 'TP00024510018190',
            goodsName: 'BEYBLADE X BX-50 天堂日輪',
            goodsUrl: productUrl,
            goodsStock: '0',
            onSaleDescription: '售完補貨中'
          }]
        }
      }), { status: 200 });
    },
    notify: async (text, options) => notifications.push({ text, options })
  });
  const result = await monitor.scan();
  assert.equal(result.discovered, 1);
  assert.equal(result.unavailableListings, 1);
  assert.equal(result.notified, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /首次掃描時已售罄/);
  assert.match(notifications[0].options.discordPreview, /發現新商品頁/);
  assert.match(notifications[0].options.discordPreview, /已啟動高速追蹤/);
});

test('momo 官方數字分類出現全新商品頁時即使瞬間售罄仍通知', async () => {
  const target = {
    id: 'momo-official-beyblade-limited',
    name: 'momo 戰鬥陀螺限量發售',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072',
    sourceType: 'momo-category',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/product/15477234';
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: { initialized: true, seen: {} }
          }
        }
      }
    },
    async save() {}
  };
  const categoryHtml = `
    <article>
      <a href="${productUrl}">
        <img alt="BEYBLADE X 戰鬥陀螺X BXG-04 銀牙烈虎S">
        <h3>BEYBLADE X 戰鬥陀螺X BXG-04 銀牙烈虎S</h3>
      </a>
      <span>可訂購時通知我</span>
    </article>
    <article>
      <a href="https://www.momoshop.com.tw/TP/TP9999999/goodsDetail/TP99999990000001">
        <h3>個人商家溢價 BEYBLADE X BXG-04</h3>
      </a>
      <span>NT$9,999</span>
    </article>
  `.padEnd(240, ' ');
  const productHtml = `
    <html><head>
      <meta property="og:title" content="BEYBLADE X 戰鬥陀螺X BXG-04 銀牙烈虎S - momo購物網">
    </head><body><h1>BEYBLADE X 戰鬥陀螺X BXG-04 銀牙烈虎S</h1><button>可訂購時通知我</button></body></html>
  `.padEnd(240, ' ');
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    fetcher: async (url) => new Response(url === target.url ? categoryHtml : productHtml, { status: 200 }),
    notify: async (text, options) => notifications.push({ text, options })
  });

  const result = await monitor.scan();
  assert.equal(result.checkedProducts, 1);
  assert.equal(result.discovered, 1);
  assert.equal(result.unavailableListings, 1);
  assert.equal(result.notified, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /首次掃描時已售罄/);
  assert.match(notifications[0].options.discordPreview, /BXG-04/);
  assert.equal(notifications[0].options.discordAudience, 'public');
});

test('momo 待售商品的預載庫存不會反覆觸發補貨通知', async () => {
  const target = {
    id: 'momo-official-beyblade-limited',
    name: 'momo 戰鬥陀螺限量發售',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072',
    sourceType: 'momo-category',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/product/15670779';
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                15670779: {
                  id: '15670779',
                  title: 'BEYBLADE X CX-18+UX-02',
                  url: productUrl,
                  available: true,
                  variants: []
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const categoryHtml = `
    <article>
      <a href="${productUrl}">
        <img alt="BEYBLADE X 戰鬥陀螺X CX-18+UX-02">
        <h3>BEYBLADE X 戰鬥陀螺X CX-18+UX-02</h3>
      </a>
      <span>預計開賣；庫存 72 組</span>
    </article>
  `.padEnd(240, ' ');
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    getPendingSaleReminder: (product) => product.id === '15670779'
      ? { saleStartAt: '2099-09-09T00:00:00.000Z' }
      : null,
    fetcher: async (url) => {
      if (url === target.url) return new Response(categoryHtml, { status: 200 });
      return new Response('temporary stock lookup failure', { status: 503 });
    },
    notify: async (text, options) => notifications.push({ text, options })
  });

  const first = await monitor.scan();
  const second = await monitor.scan();

  assert.equal(first.notified, 0);
  assert.equal(second.notified, 0);
  assert.equal(notifications.length, 0);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen['15670779'].available, false);
  assert.equal(state.data.commerce.shoppingSites.targets[target.id].seen['15670779'].status, 'pending_sale');
});

test('momo 分類首次發現新商品時會自動解析未來開賣時間並建立待售狀態', async () => {
  const target = {
    id: 'momo-official-beyblade-limited',
    name: 'momo 戰鬥陀螺限量發售',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072',
    sourceType: 'momo-category',
    enabled: true
  };
  const productUrl = 'https://www.momoshop.com.tw/product/19999999';
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: { initialized: true, seen: {} }
          }
        }
      }
    },
    async save() {}
  };
  const categoryHtml = `
    <article>
      <a href="${productUrl}">
        <img alt="BEYBLADE X 戰鬥陀螺 UX-99 測試新品">
        <h3>BEYBLADE X 戰鬥陀螺 UX-99 測試新品</h3>
      </a>
      <span>可訂購時通知我</span>
    </article>
  `.padEnd(240, ' ');
  const productHtml = String.raw`
    <html><head>
      <meta property="og:title" content="BEYBLADE X 戰鬥陀螺 UX-99 測試新品 - momo購物網">
      <meta property="og:image" content="https://i.example/ux99.webp">
    </head><body>
      \"goodsPaymentDescription\":\"2099/9/9 00:00 開賣\"
    </body></html>
  `.padEnd(240, ' ');
  const detected = [];
  const notifications = [];
  let detailReads = 0;
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    onPendingSaleDetected: async (product) => detected.push(product),
    fetcher: async (url) => {
      if (url === target.url) return new Response(categoryHtml, { status: 200 });
      if (url === productUrl) {
        detailReads += 1;
        return new Response(productHtml, { status: 200 });
      }
      if (String(url).includes('/api/moecapp/getRecommendGoods')) {
        return Response.json({ success: true, resultCode: '200', rtnData: { goodsInfoList: [] } });
      }
      return new Response('', { status: 404 });
    },
    notify: async (text, options) => notifications.push({ text, options })
  });

  const first = await monitor.scan();
  const second = await monitor.scan();
  const saved = state.data.commerce.shoppingSites.targets[target.id].seen['19999999'];

  assert.equal(detected.length, 1);
  assert.equal(detected[0].saleStartAt, '2099-09-08T16:00:00.000Z');
  assert.equal(detailReads, 1);
  assert.equal(first.notified, 0);
  assert.equal(second.notified, 0);
  assert.equal(notifications.length, 0);
  assert.equal(saved.available, false);
  assert.equal(saved.status, 'pending_sale');
  assert.equal(saved.saleStartAt, '2099-09-08T16:00:00.000Z');
});

test('指定 targetIds 時只掃描該購物專區，其他專區維持自己的排程', async () => {
  const targets = [
    { id: 'site-a', name: '網站 A', siteName: '網站 A', url: 'https://example.com/a', enabled: true },
    { id: 'site-b', name: '網站 B', siteName: '網站 B', url: 'https://example.com/b', enabled: true }
  ];
  const state = { data: {}, async save() {} };
  const requestedUrls = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => targets,
    fetcher: async (url) => {
      requestedUrls.push(url);
      return new Response('<html><body>目前沒有商品</body></html>'.padEnd(240, ' '), { status: 200 });
    },
    notify: async () => {}
  });
  const result = await monitor.scan({ targetIds: ['site-b'] });
  assert.equal(result.checkedTargets, 1);
  assert.deepEqual(requestedUrls, ['https://example.com/b']);
  assert.equal(state.data.commerce.shoppingSites.targets['site-a'], undefined);
  assert.equal(state.data.commerce.shoppingSites.targets['site-b'].initialized, true);
});
