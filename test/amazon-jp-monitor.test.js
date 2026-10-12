import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AMAZON_JP_SELLER_ID,
  AmazonJapanMonitor,
  amazonJapanPageIssue,
  amazonJapanRetryDelayMs,
  amazonJapanNotification,
  amazonJapanTestNotification,
  canonicalAmazonJapanUrl,
  extractAmazonAsin,
  isAmazonPriceWithinMsrp,
  matchTakaraTomyCatalog,
  nextAmazonJapanAdaptiveInterval,
  parseAmazonOffer,
  parseAmazonSellerSearch,
  parseAmazonStoreAsins,
  parseTakaraTomyLineup,
  roundRobinRows
} from '../src/amazon-jp-monitor.js';

test('日亞新版 503 與空白 202 載入殼會被明確分類', () => {
  assert.equal(amazonJapanPageIssue({ status: 503, title: 'ご迷惑をおかけしています！', html: '<html></html>' }), 'rate_limited');
  assert.equal(amazonJapanPageIssue({ status: 200, title: 'ご迷惑をおかけしています！', html: '<html></html>' }), 'rate_limited');
  assert.equal(amazonJapanPageIssue({ status: 202, body: '', html: '<html></html>' }), 'loading_shell');
  assert.equal(amazonJapanPageIssue({ status: 200, title: 'Amazon.co.jp', body: '商品一覧', html: '<html></html>' }), '');
});

test('日亞商品不存在頁不再誤判為 429 或驗證頁', () => {
  assert.equal(amazonJapanPageIssue({
    status: 404,
    title: 'Amazon.co.jp: ページが見つかりません',
    body: '何かお探しですか 申し訳ございません'
  }), 'not_found');
  assert.equal(amazonJapanPageIssue({
    status: 200,
    title: 'ページが見つかりません',
    body: '何かお探しですか'
  }), 'not_found');
  assert.equal(amazonJapanPageIssue({ status: 503, title: 'アクセスが集中しています' }), 'rate_limited');
});

test('日亞連續失敗採 2、5、15、30、60 分鐘漸進退避', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(amazonJapanRetryDelayMs), [
    120_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000
  ]);
});

test('日亞線性浮動速度會在平時 15～20 秒巡航，阻擋後於 40～60 秒恢復', () => {
  const normal = [];
  let current = 20;
  for (let index = 0; index < 7; index += 1) {
    current = nextAmazonJapanAdaptiveInterval(current, 'success');
    normal.push(current);
  }
  assert.deepEqual(normal, [19, 18, 17, 16, 15, 20, 19]);
  assert.equal(nextAmazonJapanAdaptiveInterval(18, 'blocked'), 40);
  assert.equal(nextAmazonJapanAdaptiveInterval(40, 'blocked'), 45);
  assert.equal(nextAmazonJapanAdaptiveInterval(60, 'blocked'), 60);
  assert.equal(nextAmazonJapanAdaptiveInterval(60, 'success'), 55);
  assert.equal(nextAmazonJapanAdaptiveInterval(25, 'success'), 20);
});

test('配送地區第一次點擊逾時後會真正進入第二次嘗試', async () => {
  let gotoCount = 0;
  let triggerClicks = 0;
  let location = '台湾';
  const trigger = {
    waitFor: async () => {},
    click: async () => {
      triggerClicks += 1;
      if (triggerClicks === 1) throw new Error('locator.click: Timeout 10000ms exceeded');
    }
  };
  const page = {
    goto: async () => { gotoCount += 1; return { status: () => 200 }; },
    content: async () => '<html><body>Amazon.co.jp 商品頁</body></html>',
    title: async () => 'Amazon.co.jp',
    waitForTimeout: async () => {},
    locator: (selector) => {
      if (selector.includes('#nav-global-location-popover-link')) return { first: () => trigger };
      if (selector === 'body') return { innerText: async () => 'Amazon.co.jp 商品頁' };
      if (selector === '#glow-ingress-line2') return { innerText: async () => location };
      if (selector === '#GLUXZipUpdateInput_0' || selector === '#GLUXZipUpdateInput_1') {
        return { waitFor: async () => {}, fill: async () => {} };
      }
      if (selector === '#GLUXZipUpdate input[type="submit"]') {
        return { click: async () => { location = '100-0001'; } };
      }
      throw new Error(`unexpected selector: ${selector}`);
    }
  };
  const monitor = new AmazonJapanMonitor({
    dataDir: '',
    state: { data: {} },
    getConfig: () => ({ postalCode: '100-0001' }),
    notify: async () => '',
    log: () => {}
  });
  await monitor.ensureJapanLocation(page);
  assert.equal(monitor.locationReady, true);
  assert.equal(gotoCount, 2);
  assert.equal(triggerClicks, 2);
});

test('配送郵遞區號送出後會完成 Amazon 新增的「完了」確認步驟', async () => {
  let location = '台湾';
  let confirmationClicks = 0;
  const trigger = { waitFor: async () => {}, click: async () => {} };
  const confirmation = {
    waitFor: async () => {},
    click: async () => {
      confirmationClicks += 1;
      location = '千代田区千代田 100-0001';
    }
  };
  const page = {
    goto: async () => ({ status: () => 200 }),
    content: async () => '<html><body>Amazon.co.jp 商品頁</body></html>',
    title: async () => 'Amazon.co.jp',
    waitForTimeout: async () => {},
    locator: (selector) => {
      if (selector.includes('#nav-global-location-popover-link')) return { first: () => trigger };
      if (selector.includes('#GLUXConfirmClose')) return { first: () => confirmation };
      if (selector === 'body') return { innerText: async () => 'Amazon.co.jp 商品頁' };
      if (selector === '#glow-ingress-line2') return { innerText: async () => location };
      if (selector === '#GLUXZipUpdateInput_0' || selector === '#GLUXZipUpdateInput_1') {
        return { waitFor: async () => {}, fill: async () => {} };
      }
      if (selector === '#GLUXZipUpdate input[type="submit"]') return { click: async () => {} };
      throw new Error(`unexpected selector: ${selector}`);
    }
  };
  const monitor = new AmazonJapanMonitor({
    dataDir: '',
    state: { data: {} },
    getConfig: () => ({ postalCode: '100-0001' }),
    notify: async () => '',
    log: () => {}
  });
  await monitor.ensureJapanLocation(page);
  assert.equal(monitor.locationReady, true);
  assert.equal(confirmationClicks, 1);
});

test('TAKARA TOMY 官方頁可建立型號與日圓定價基線', () => {
  const products = parseTakaraTomyLineup(`
    <ul><li class="mix ux"><a href="ux21.html"><img alt="UX-21 ヘルズネザーデッキセット"><b>UX-21<span>ヘルズネザーデッキセット</span></b><i>¥4,500（税込）</i></a></li></ul>
  `);
  assert.deepEqual(products.map(({ code, name, msrpYen }) => ({ code, name, msrpYen })), [
    { code: 'UX-21', name: 'ヘルズネザーデッキセット', msrpYen: 4500 }
  ]);
  assert.match(products[0].officialUrl, /lineup\/ux21\.html/);
});

test('日亞品牌頁只擷取商品 ASIN 並轉成固定官方賣家網址', () => {
  const products = parseAmazonStoreAsins(`
    <a href="/dp/B0H861Y9Y3/ref=store"><img alt="UX-21 ヘルズネザー"></a>
    <a href="/stores/page/not-a-product">分類</a>
  `);
  assert.equal(products.length, 1);
  assert.equal(products[0].asin, 'B0H861Y9Y3');
  assert.equal(products[0].url, canonicalAmazonJapanUrl('B0H861Y9Y3'));
});

test('只解析日圓搜尋價，TWD 在比較官方定價前會被拒絕', () => {
  const yen = parseAmazonSellerSearch(`
    <div data-component-type="s-search-result" data-asin="B0H861Y9Y3"><h2>BEYBLADE X UX-21</h2><span class="a-price"><span class="a-offscreen">￥4,500</span></span></div>
  `);
  const twd = parseAmazonSellerSearch(`
    <div data-component-type="s-search-result" data-asin="B0H861Y9Y3"><h2>BEYBLADE X UX-21</h2><span class="a-price"><span class="a-offscreen">TWD 900</span></span></div>
  `);
  assert.equal(yen[0].priceYen, 4500);
  assert.equal(twd.length, 0);
});

test('日亞官方價容許一日圓尾差，但拒絕真正溢價', () => {
  assert.equal(isAmazonPriceWithinMsrp(2700, 2700), true);
  assert.equal(isAmazonPriceWithinMsrp(2701, 2700), true);
  assert.equal(isAmazonPriceWithinMsrp(2702, 2700), false);
  assert.equal(isAmazonPriceWithinMsrp(2710, 2700, 10), true);
});

test('已知 ASIN 以輪替批次直接核對，不會只掃第一批', () => {
  const first = roundRobinRows(['A', 'B', 'C', 'D'], 0, 2);
  const second = roundRobinRows(['A', 'B', 'C', 'D'], first.nextCursor, 2);
  assert.deepEqual(first.rows, ['A', 'B']);
  assert.deepEqual(second.rows, ['C', 'D']);
  assert.equal(second.nextCursor, 0);
});

test('X 速報完整商品網址可穩定抽出新日亞 ASIN', () => {
  const urls = [
    'https://www.amazon.co.jp/dp/B0HJ7CPXJ6?aod=1&m=AN1VRQENFRJN5&tag=bey_sokuhou-22',
    'https://www.amazon.co.jp/dp/B0HJ75X3PN?aod=1&m=AN1VRQENFRJN5&tag=bey_sokuhou-22',
    'https://www.amazon.co.jp/dp/B0HJ783F18?aod=1&m=AN1VRQENFRJN5&tag=bey_sokuhou-22'
  ];
  assert.deepEqual(urls.map(extractAmazonAsin), ['B0HJ7CPXJ6', 'B0HJ75X3PN', 'B0HJ783F18']);
});

test('官方定價收錄前的專線商品每輪直查，收錄後自動退出專線', async () => {
  let loaded = 0;
  let notified = 0;
  const storage = {};
  const monitor = new AmazonJapanMonitor({
    dataDir: '',
    state: { data: {} },
    getConfig: () => ({}),
    notify: async () => { notified += 1; },
    log: () => {}
  });
  monitor.loadPage = async () => {
    loaded += 1;
    return `
      <span id="productTitle">BEYBLADE X BX-52 ラスタードラグーン</span>
      <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">￥2,000</span></span></div>
      <div id="desktop_buybox"><script>{"merchantId":"${AMAZON_JP_SELLER_ID}"}</script><input id="add-to-cart-button"></div>
    `;
  };
  const products = [{
    asin: 'B0HJ783F18',
    code: 'BX-52',
    title: 'BEYBLADE X BX-52 ラスタードラグーン',
    manualMsrpYen: 2000,
    dedicatedUntilCatalog: true
  }];
  const manualPricing = [{
    code: 'BX-52',
    name: 'ラスタードラグーン',
    normalizedName: 'ラスタードラグーン',
    msrpYen: 2000,
    pricingSource: 'manual_pre_catalog'
  }];

  const beforeCatalog = await monitor.inspectDedicatedPreCatalogProducts(products, [], manualPricing, storage);
  assert.equal(beforeCatalog.pending.length, 1);
  assert.equal(beforeCatalog.successful, 1);
  assert.equal(beforeCatalog.observed.length, 1);
  assert.equal(loaded, 1);
  assert.equal(storage.preCatalogWatch.B0HJ783F18.sellerConfirmed, true);
  assert.equal(storage.preCatalogWatch.B0HJ783F18.buyButtonPresent, true);
  assert.equal(storage.preCatalogWatch.B0HJ783F18.msrpYen, 2000);
  assert.equal(storage.preCatalogWatch.B0HJ783F18.available, true);
  assert.equal(notified, 0);

  const officialCatalog = [{
    code: 'BX-52',
    name: 'ラスタードラグーン',
    normalizedName: 'ラスタードラグーン',
    msrpYen: 2000
  }];
  const afterCatalog = await monitor.inspectDedicatedPreCatalogProducts(
    products,
    officialCatalog,
    officialCatalog,
    storage
  );
  assert.equal(afterCatalog.pending.length, 0);
  assert.equal(loaded, 1);
  assert.deepEqual(storage.preCatalogWatch, {});
});

test('商品頁必須同時有 Amazon.co.jp 賣家 ID、購買按鈕與 Buy Box 日圓價格', () => {
  const valid = parseAmazonOffer(`
    <span id="productTitle">BEYBLADE X BX-40 ワインダーランチャーL</span>
    <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/high-resolution.jpg" src="https://m.media-amazon.com/images/I/small.jpg">
    <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">￥757</span></span></div>
    <div id="desktop_buybox"><script>{"merchantId":"${AMAZON_JP_SELLER_ID}"}</script><input id="add-to-cart-button"></div>
  `, 'B0DWSBHQWD');
  const dynamicImage = parseAmazonOffer(`
    <span id="productTitle">BEYBLADE X UX-20</span>
    <img id="landingImage" data-a-dynamic-image='{"https://m.media-amazon.com/images/I/355.jpg":[355,355],"https://m.media-amazon.com/images/I/679.jpg":[679,679]}'>
  `, 'B0H4PPV8MR');
  const unsafeImage = parseAmazonOffer(`
    <span id="productTitle">BEYBLADE X UX-01</span>
    <img id="landingImage" data-old-hires="https://example.com/untrusted.jpg">
  `, 'B0D6MZB1VF');
  const thirdParty = parseAmazonOffer(`
    <span id="productTitle">BEYBLADE X BX-34</span>
    <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">￥7,200</span></span></div>
    <div id="desktop_buybox"><script>{"merchantId":"THIRDPARTY"}</script><input id="add-to-cart-button"></div>
  `, 'B0D6MZB1VF');
  assert.equal(valid.available, true);
  assert.equal(valid.sellerConfirmed, true);
  assert.equal(valid.buyButtonPresent, true);
  assert.equal(valid.imageUrl, 'https://m.media-amazon.com/images/I/high-resolution.jpg');
  assert.equal(dynamicImage.imageUrl, 'https://m.media-amazon.com/images/I/679.jpg');
  assert.equal(unsafeImage.imageUrl, '');
  assert.equal(thirdParty.available, false);
  assert.equal(thirdParty.sellerConfirmed, false);
});

test('重複型號無法由名稱唯一對應時採取 fail-closed', () => {
  const catalog = [
    { code: 'BX-00', name: 'ペガサスブラスト', normalizedName: 'ペガサスブラスト', msrpYen: 1600 },
    { code: 'BX-00', name: 'コバルトドレイク', normalizedName: 'コバルトドレイク', msrpYen: 2000 }
  ];
  assert.equal(matchTakaraTomyCatalog({ code: 'BX-00', title: 'BEYBLADE X BX-00 ペガサスブラスト' }, catalog)?.msrpYen, 1600);
  assert.equal(matchTakaraTomyCatalog({ code: 'BX-00', title: 'BEYBLADE X BX-00 限定品' }, catalog), null);
});

test('X 只作交叉驗證標記，通知仍列出官方定價與 Amazon.co.jp 賣家', () => {
  assert.equal(extractAmazonAsin('https://www.amazon.co.jp/dp/B0D6MZB1VF?aod=1&tag=bey_sokuhou-22'), 'B0D6MZB1VF');
  const message = amazonJapanNotification({
    asin: 'B0H861Y9Y3', code: 'UX-21', title: 'UX-21 ヘルズネザー', priceYen: 4300, msrpYen: 4500,
    url: canonicalAmazonJapanUrl('B0H861Y9Y3'), imageUrl: 'https://m.media-amazon.com/images/I/ux21.jpg'
  }, { xConfirmed: true });
  const serialized = JSON.stringify(message);
  assert.match(serialized, /X @bey_sokuhou/);
  assert.match(serialized, /Amazon\.co\.jp/);
  assert.match(serialized, /約 NT\$/);
  assert.match(serialized, /4,500/);
  assert.equal(message.options.embeds[0].thumbnail.url, 'https://m.media-amazon.com/images/I/ux21.jpg');
  assert.doesNotMatch(serialized, /x\.com|twitter\.com/);
});

test('日亞原價測試可選 BX-52 與 BX-53，價格與 ASIN 各自正確且不假稱已驗證賣家', () => {
  for (const [asin, code, msrpYen] of [
    ['B0HJ783F18', 'BX-52', 2300],
    ['B0HJ75X3PN', 'BX-53', 7480]
  ]) {
    const notice = amazonJapanTestNotification({ choice: asin }, [{ asin, imageUrl: `https://m.media-amazon.com/images/I/${code}.jpg` }]);
    assert.equal(notice.product.asin, asin);
    assert.equal(notice.product.code, code);
    assert.equal(notice.product.msrpYen, msrpYen);
    assert.equal(notice.product.priceYen, msrpYen);
    assert.equal(notice.product.url, canonicalAmazonJapanUrl(asin));
    assert.equal(notice.options.embeds[0].url, canonicalAmazonJapanUrl(asin));
    assert.match(JSON.stringify(notice), /本機測試・不是真實補貨/);
    assert.match(JSON.stringify(notice), /前往 Amazon\.co\.jp 真實商品頁/);
    assert.match(JSON.stringify(notice), /測試情境；未即時核對/);
    assert.match(JSON.stringify(notice), /X @bey_sokuhou/);
    assert.doesNotMatch(JSON.stringify(notice), /賣家 ID 已核對/);
    assert.doesNotMatch(JSON.stringify(notice), /1999\.co\.jp/);
  }
});

test('日亞原價測試接受自訂商品網址與模擬價格，拒絕非日亞網址及高於測試定價', () => {
  const selection = {
    choice: 'custom', url: 'https://www.amazon.co.jp/dp/B0HJ783F18?tag=example-22',
    title: 'BEYBLADE X BX-52 ラスタードラグーン', code: 'BX-52',
    msrpYen: 2300, priceYen: 2200
  };
  const notice = amazonJapanTestNotification(selection);
  assert.equal(notice.product.priceYen, 2200);
  assert.equal(notice.product.url, canonicalAmazonJapanUrl('B0HJ783F18'));
  assert.match(JSON.stringify(notice), /日亞價格/);
  assert.match(JSON.stringify(notice), /官方定價.*自訂測試資料/);
  assert.throws(() => amazonJapanTestNotification({ ...selection, url: 'https://amazon.co.jp.example.com/dp/B0HJ783F18' }), /只接受有效/);
  assert.throws(() => amazonJapanTestNotification({ ...selection, priceYen: 2500 }), /不高於/);
  assert.throws(() => amazonJapanTestNotification({ ...selection, title: '' }), /商品名稱/);
});

test('X 交叉驗證清單沿用已知商品的獨立圖片與官方定價狀態', () => {
  const asin = 'B0HJ783F18';
  const storage = {
    initialized: true,
    products: {
      [asin]: {
        asin,
        code: 'BX-52',
        title: 'BEYBLADE X BX-52 ラスタードラグーン6-60LC',
        imageUrl: 'https://m.media-amazon.com/images/I/bx52.jpg'
      }
    },
    brandProducts: {},
    catalog: [{
      code: 'BX-52', name: 'ラスタードラグーン6-60LC',
      normalizedName: 'ラスタードラグーン660LC', msrpYen: 2300
    }],
    xSignals: {
      [asin]: {
        asin, source: 'bey_sokuhou', title: '',
        originalAmazonUrl: `https://www.amazon.co.jp/dp/${asin}`,
        affiliateConfirmed: true, recordedAt: '2026-09-14T16:02:24.022Z'
      }
    }
  };
  const monitor = new AmazonJapanMonitor({
    dataDir: '',
    state: { data: { commerce: { amazonJp: storage } }, save: async () => {} },
    getConfig: () => ({ watchProducts: [] }),
    notify: async () => {},
    log: () => {}
  });

  const signal = monitor.status().xSignals[0];
  assert.equal(signal.imageUrl, 'https://m.media-amazon.com/images/I/bx52.jpg');
  assert.equal(signal.title, 'BEYBLADE X BX-52 ラスタードラグーン6-60LC');
  assert.equal(signal.productUrl, canonicalAmazonJapanUrl(asin));
  assert.equal(signal.catalogConfirmed, true);
  assert.equal(signal.msrpYen, 2300);
  assert.equal(monitor.status().manualProducts[0].asin, asin);
  assert.equal(monitor.status().manualProductCount, 1);
});

test('手動日亞單品會永久寫入資料庫並可單筆刪除', async () => {
  const asin = 'B0HJ783F18';
  let saves = 0;
  const state = { data: {}, save: async () => { saves += 1; } };
  const monitor = new AmazonJapanMonitor({
    dataDir: '', state,
    getConfig: () => ({ watchProducts: [] }),
    notify: async () => {}, log: () => {}
  });
  monitor.loadPage = async () => `
    <span id="productTitle">BEYBLADE X BX-52 ラスタードラグーン6-60LC</span>
    <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/bx52.jpg">
  `;

  const added = await monitor.addManualProduct(`https://www.amazon.co.jp/dp/${asin}`);
  assert.equal(added.asin, asin);
  assert.equal(added.code, 'BX-52');
  assert.equal(added.imageUrl, 'https://m.media-amazon.com/images/I/bx52.jpg');
  assert.equal(state.data.commerce.amazonJp.manualProducts[asin].source, 'manual');
  assert.equal(monitor.status().manualProductCount, 1);

  const removed = await monitor.deleteManualProduct(asin);
  assert.equal(removed.asin, asin);
  assert.equal(monitor.status().manualProductCount, 0);
  assert.equal(saves, 2);
});

test('手動日亞單品支援 amzn.asia 短網址並保存解析後 ASIN', async () => {
  const asin = 'B0C52SMHWN';
  const state = { data: {}, save: async () => {} };
  const monitor = new AmazonJapanMonitor({
    dataDir: '', state,
    getConfig: () => ({ watchProducts: [] }),
    notify: async () => {}, log: () => {},
    fetcher: async () => ({ url: `https://www.amazon.co.jp/dp/${asin}` })
  });
  monitor.loadPage = async () => '<span id="productTitle">BEYBLADE X BX-09 ベイバトルパス</span>';

  const added = await monitor.addManualProduct('https://amzn.asia/d/0eQU9p9H');
  assert.equal(added.asin, asin);
  assert.equal(added.code, 'BX-09');
  assert.equal(added.originalAmazonUrl, `https://www.amazon.co.jp/dp/${asin}`);
});

test('手動日亞資料庫商品會加入直接監控輪替', async () => {
  const asin = 'B0HJ783F18';
  const storage = {
    initialized: true,
    searchDiscoveryVersion: 1,
    products: {},
    catalog: [],
    brandProducts: {},
    xSignals: {},
    manualProducts: {
      [asin]: {
        asin,
        code: 'BX-52',
        title: 'BEYBLADE X BX-52 ラスタードラグーン6-60LC',
        productUrl: canonicalAmazonJapanUrl(asin),
        source: 'manual',
        addedAt: '2026-09-16T00:00:00.000Z'
      }
    }
  };
  const monitor = new AmazonJapanMonitor({
    dataDir: '',
    state: { data: { commerce: { amazonJp: storage } }, save: async () => {} },
    getConfig: () => ({ watchProducts: [], watchBatchSize: 1, backgroundBatchSize: 1, priceToleranceYen: 1 }),
    notify: async () => {}, log: () => {}
  });
  monitor.ensureSeedSignals = async () => {};
  monitor.refreshCatalog = async () => [{
    code: 'BX-52', name: 'ラスタードラグーン6-60LC',
    normalizedName: 'ラスタードラグーン660LC', msrpYen: 2300
  }];
  monitor.refreshBrandProducts = async () => ({});
  monitor.loadPage = async () => `
    <div data-component-type="s-search-result" data-asin="B000000001">
      <h2>アクセサリー</h2><span class="a-price"><span class="a-offscreen">￥100</span></span>
    </div>`;
  const checked = [];
  monitor.verifyOffer = async (product) => {
    checked.push(product.asin);
    return { ...product, priceYen: 2300, available: false, sellerConfirmed: false };
  };

  await monitor.scan();
  assert.deepEqual(checked, [asin]);
  assert.equal(storage.lastDirectCheckedCount, 1);
});

test('日亞官方原價新品或補貨通知會並行送出同品項刷新提示', async () => {
  const asin = 'B0HJ783F18';
  const product = {
    asin, code: 'BX-52', title: 'BEYBLADE X BX-52 ラスタードラグーン',
    priceYen: 2300, msrpYen: 2300, available: true,
    sellerConfirmed: true, url: canonicalAmazonJapanUrl(asin)
  };
  const storage = {
    initialized: true,
    searchDiscoveryVersion: 1,
    products: { [asin]: { ...product, available: false } },
    catalog: [], brandProducts: {}, xSignals: {}
  };
  const state = { data: { commerce: { amazonJp: storage } }, save: async () => {} };
  const signals = [];
  const monitor = new AmazonJapanMonitor({
    dataDir: '', state,
    getConfig: () => ({ watchProducts: [], watchBatchSize: 1, backgroundBatchSize: 1, priceToleranceYen: 1 }),
    notify: async () => 'message-id', log: () => {},
    onAvailabilitySignal: async (candidate, signal) => { signals.push({ candidate, signal }); }
  });
  monitor.ensureSeedSignals = async () => {};
  monitor.refreshCatalog = async () => [{
    code: 'BX-52', name: 'ラスタードラグーン', normalizedName: 'ラスタードラグーン', msrpYen: 2300
  }];
  monitor.refreshBrandProducts = async () => ({});
  monitor.loadPage = async () => `
    <div data-component-type="s-search-result" data-asin="${asin}">
      <h2>BEYBLADE X BX-52 ラスタードラグーン</h2>
      <span class="a-price"><span class="a-offscreen">￥2,300</span></span>
    </div>`;
  monitor.verifyOffer = async () => product;

  const result = await monitor.scan();

  assert.equal(result.restocked, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].candidate.asin, asin);
  assert.deepEqual(signals[0].signal, { source: '日亞官方原價', kind: 'restock' });
});
