import assert from 'node:assert/strict';
import test from 'node:test';
import iconv from 'iconv-lite';
import {
  approximateTwdFromYen, classifyJapanAuctionUrl, formatJapanPriceWithApproxTwd,
  isBeybladeXProduct, JapanAuctionMonitor, japanAuctionNotification, japanAuctionTestNotification,
  japanAuctionFailureDelayMs, japanProductExclusionReason, parse1999Products, parseEdionProducts,
  parseRakutenBooksProducts, parseRakutenProducts, parseRakutenSearchProducts,
  parseTaiyoMarketProducts
} from '../src/japan-auctions.js';

test('日本購物只接受 BEYBLADE X 世代並可用黑名單排除周邊', () => {
  assert.equal(isBeybladeXProduct('BEYBLADE X UX-21 ヘルズネザーデッキセット'), true);
  assert.equal(isBeybladeXProduct('タカラトミー BX-50 ランダムブースター'), true);
  assert.equal(isBeybladeXProduct('メタルファイト ベイブレード BBC-05 ファントムオリオン'), false);
  assert.equal(
    japanProductExclusionReason('ベイブレードX BEYBLADE X BX-43 ギアケース', ['ギアケース']),
    '命中黑名單關鍵字「ギアケース」'
  );
  assert.equal(
    japanProductExclusionReason('メタルファイト ベイブレード BBC-05 ファントムオリオン', ['ギアケース']),
    '非 BEYBLADE X 世代'
  );
  assert.equal(
    japanProductExclusionReason('BEYBLADE X BX-57 3on3デッキケース ブラックVer.', ['デッキケース']),
    '命中黑名單關鍵字「デッキケース」'
  );
  assert.equal(
    japanProductExclusionReason('BEYBLADE X BX-57 战斗盒', ['战斗盒']),
    '命中黑名單關鍵字「战斗盒」'
  );
});

test('手動掃描與排程同時命中相同日本網站只執行一輪，其他網站不互相等待', async () => {
  const monitor = new JapanAuctionMonitor({ dataDir: '', state: { data: {} }, getTargets: () => [], log: () => {} });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  monitor.performScanTarget = async (target) => {
    calls.push(target.id);
    if (target.id === 'a') await gate;
    return { targetId: target.id };
  };
  const first = monitor.scanTarget({ id: 'a' });
  const duplicate = monitor.scanTarget({ id: 'a' });
  assert.equal(first, duplicate);
  assert.deepEqual(await monitor.scanTarget({ id: 'b' }), { targetId: 'b' });
  assert.deepEqual(calls, ['a', 'b']);
  release();
  await Promise.all([first, duplicate]);
  await monitor.scanTarget({ id: 'a' });
  assert.deepEqual(calls, ['a', 'b', 'a']);
});

test('日本網站失敗後會解除單站掃描鎖，下一輪可正常重試', async () => {
  const monitor = new JapanAuctionMonitor({ dataDir: '', state: { data: {} }, getTargets: () => [], log: () => {} });
  monitor.performScanTarget = async () => { throw new Error('timeout'); };
  await assert.rejects(monitor.scanTarget({ id: 'a' }), /timeout/);
  monitor.performScanTarget = async () => ({ checkedProducts: 1 });
  assert.equal((await monitor.scanTarget({ id: 'a' })).checkedProducts, 1);
});

test('日本拍賣新品或補貨通知會同步送出同品項即時刷新提示', async () => {
  const target = { id: 'rakuten-books', siteName: '樂天 Books', sourceType: 'rakuten-books', url: 'https://books.rakuten.co.jp/search?sitem=BEYBLADE+X&g=006' };
  const productUrl = 'https://books.rakuten.co.jp/rb/18719874/';
  const signals = [];
  const state = { data: { commerce: { japanAuctions: { targets: {
    [target.id]: { initialized: true, products: { '/rb/18719874': { id: '/rb/18719874', title: 'BEYBLADE X BX-52', url: productUrl, available: false } } }
  } } } }, save: async () => {} };
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state, getTargets: () => [target], notify: async () => 'message-id', log: () => {},
    onAvailabilitySignal: async (product, signal) => { signals.push({ product, signal }); }
  });
  monitor.load = async () => `
    <div class="rbcomp__item-list__item"><span class="rbcomp__category">おもちゃ</span>
      <h3><a href="${productUrl}"><span class="rbcomp__item-list__item__title">BEYBLADE X BX-52</span></a></h3>
      <span class="rbcomp__item-list__item__price"><em>2,300円</em></span>
      <p class="rbcomp__item-list__item__stock"><em>在庫あり</em></p>
    </div>`;

  const result = await monitor.scanTarget(target);

  assert.equal(result.restocked, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].product.title, 'BEYBLADE X BX-52');
  assert.deepEqual(signals[0].signal, { source: '樂天 Books', kind: 'restock' });
});

test('一般日本網站同型號 24 小時內跨網站只通知一次且不重複觸發日亞提示', async () => {
  const cx13 = '<li><a href="/detail.html?p_cd=00085029323">タカラトミー CX-13 スターター BEYBLADE X</a><p>￥2,200(税込)</p><p>在庫数97台</p></li>';
  const targets = [
    { id: 'edion-a', name: '愛電王 A', siteName: 'EDION', sourceType: 'edion', url: 'https://www.edion.com/item_list.html?keyword=beyblade+x' },
    { id: 'edion-b', name: '愛電王 B', siteName: 'EDION', sourceType: 'edion', url: 'https://www.edion.com/item_list.html?keyword=beyblade+x&page=2' }
  ];
  const old = { id: '00085029323', title: 'CX-13', url: 'https://www.edion.com/detail.html?p_cd=00085029323', available: false };
  const state = { data: { commerce: { japanAuctions: {
    targets: Object.fromEntries(targets.map((target) => [target.id, { initialized: true, products: { [old.id]: old } }])),
    recentNotifications: {}, recentNotificationsSeededAt: new Date().toISOString()
  } } }, save: async () => {} };
  const notifications = [];
  const signals = [];
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state, getTargets: () => targets, notify: async (...args) => { notifications.push(args); }, log: () => {},
    onAvailabilitySignal: async (...args) => { signals.push(args); }
  });
  monitor.load = async () => `<ul>${cx13}</ul>`;

  const first = await monitor.scanTarget(targets[0]);
  const second = await monitor.scanTarget(targets[1]);

  assert.equal(first.notified, 1);
  assert.equal(second.notified, 0);
  assert.equal(second.suppressed, 1);
  assert.equal(notifications.length, 1);
  assert.equal(signals.length, 1);
});

test('日本網站商品短暫漏一輪不會立刻翻成售罄再製造假補貨', async () => {
  const target = { id: 'edion-missing', name: '愛電王', siteName: 'EDION', sourceType: 'edion', url: 'https://www.edion.com/item_list.html?keyword=beyblade+x' };
  const missing = { id: '00085029323', title: 'タカラトミー CX-13 スターター BEYBLADE X', url: 'https://www.edion.com/detail.html?p_cd=00085029323', available: true };
  const keeper = { id: '00075806576', title: 'タカラトミー BEYBLADE X BX-10', url: 'https://www.edion.com/detail.html?p_cd=00075806576', available: true };
  const state = { data: { commerce: { japanAuctions: {
    targets: { [target.id]: { initialized: true, products: { [missing.id]: missing, [keeper.id]: keeper } } },
    recentNotifications: {}, recentNotificationsSeededAt: new Date().toISOString()
  } } }, save: async () => {} };
  const monitor = new JapanAuctionMonitor({ dataDir: '', state, getTargets: () => [target], notify: async () => {}, log: () => {} });
  monitor.load = async () => '<ul><li><a href="/detail.html?p_cd=00075806576">タカラトミー BEYBLADE X BX-10</a><p>￥2,750(税込)</p><p>在庫数466台</p></li></ul>';

  await monitor.scanTarget(target);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products[missing.id].available, true);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products[missing.id].missingRounds, 1);
  await monitor.scanTarget(target);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products[missing.id].available, false);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products[missing.id].missingRounds, 2);
});

test('日本網站整頁解析為 0 件時保留既有基線並回報錯誤', async () => {
  const target = { id: 'edion-zero', name: '愛電王', siteName: 'EDION', sourceType: 'edion', url: 'https://www.edion.com/item_list.html?keyword=beyblade+x' };
  const existing = { id: '00086148887', title: 'タカラトミー UX-20 BEYBLADE X', url: 'https://www.edion.com/detail.html?p_cd=00086148887', available: true, missingRounds: 0 };
  const state = { data: { commerce: { japanAuctions: { targets: {
    [target.id]: { initialized: true, products: { [existing.id]: existing }, lastProductCount: 1, lastRawProductCount: 1, lastScanAt: '2026-09-29T14:58:38.000Z' }
  } } } }, save: async () => {} };
  const monitor = new JapanAuctionMonitor({ dataDir: '', state, getTargets: () => [target], notify: async () => {}, log: () => {} });
  monitor.load = async () => `<html><body><main>${'空白'.repeat(600)}</main></body></html>`;

  await assert.rejects(() => monitor.scanTarget(target), /沒有讀到任何商品.*保留既有基線/);

  const saved = state.data.commerce.japanAuctions.targets[target.id];
  assert.deepEqual(saved.products, { [existing.id]: existing });
  assert.equal(saved.lastProductCount, 1);
  assert.equal(saved.lastRawProductCount, 1);
  assert.equal(saved.lastScanAt, '2026-09-29T14:58:38.000Z');
  assert.match(saved.lastError, /保留既有基線/);
  assert.ok(saved.lastAttemptAt);
});

test('EDION 從舊版 0 件污染狀態恢復時只通知全新商品，不製造大量假補貨', async () => {
  const target = { id: 'edion-recovery', name: '愛電王', siteName: 'EDION', sourceType: 'edion', url: 'https://www.edion.com/item_list.html?keyword=beyblade+x' };
  const knownId = '00086148887';
  const state = { data: { commerce: { japanAuctions: {
    targets: { [target.id]: { initialized: true, products: {
      [knownId]: { id: knownId, title: 'タカラトミー UX-20 BEYBLADE X', url: `https://www.edion.com/detail.html?p_cd=${knownId}`, available: false, missingRounds: 19348 }
    }, lastProductCount: 0, lastRawProductCount: 0 } },
    recentNotifications: {}, recentNotificationsSeededAt: new Date().toISOString()
  } } }, save: async () => {} };
  const notifications = [];
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state, getTargets: () => [target], notify: async (...args) => notifications.push(args), log: () => {}
  });
  monitor.load = async () => `<ul>
    <li><a href="/detail.html?p_cd=${knownId}">タカラトミー UX-20 BEYBLADE X</a><p>￥2,700</p><p>在庫数3台</p></li>
    <li><a href="/detail.html?p_cd=00099999999">タカラトミー BX-99 BEYBLADE X</a><p>￥3,000</p><p>在庫数5台</p></li>
  </ul>`;

  const result = await monitor.scanTarget(target);

  assert.equal(result.restocked, 0);
  assert.equal(result.discovered, 1);
  assert.equal(result.notified, 1);
  assert.equal(notifications.length, 1);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products[knownId].available, true);
  assert.ok(state.data.commerce.japanAuctions.targets[target.id].recoveredFromEmptyResultAt);
});

test('EDION 連續失敗會逐步降速，其他日本網站維持原間隔', () => {
  assert.equal(japanAuctionFailureDelayMs('edion', 1, 20), 60_000);
  assert.equal(japanAuctionFailureDelayMs('edion', 2, 20), 80_000);
  assert.equal(japanAuctionFailureDelayMs('edion', 20, 20), 15 * 60_000);
  assert.equal(japanAuctionFailureDelayMs('1999', 20, 20), 20_000);
});

test('日本價格以固定估算匯率顯示約折合台幣', () => {
  assert.equal(approximateTwdFromYen('¥4,000'), 880);
  assert.equal(formatJapanPriceWithApproxTwd('¥4,000'), '¥4,000（約 NT$880）');
  assert.equal(approximateTwdFromYen('價格未定'), null);
});

test('1999 日本國內版解析器擷取商品、日圓價格與穩定商品編號', () => {
  const products = parse1999Products(`
    <article class="c-card"><img src="/img/ux15.jpg"><div class="c-card__info">
      <a class="c-card__info-links" href="/10999999"></a>
      <div class="c-card__title">ベイブレードX UX-15 シャークスケイルデッキセット</div>
      <div class="c-card__maker">2026年9月</div>
      <div class="c-card__price-element"><span>4,200</span>円</div>
    </div></article>
  `, 'https://www.1999.co.jp/list/2613/7/1?soldout=0');
  assert.equal(products.length, 1);
  assert.equal(products[0].id, '10999999');
  assert.equal(products[0].title, 'ベイブレードX UX-15 シャークスケイルデッキセット');
  assert.equal(products[0].price, '¥4,200');
  assert.equal(products[0].url, 'https://www.1999.co.jp/10999999');
  assert.equal(products[0].available, true);
});

test('1999 從英文版切到日本國內版時沿用商品基線，不誤報全數新品', async () => {
  const target = { id: 'japan-1999-beyblade', name: '1999 日本國內版', siteName: '1999.co.jp', sourceType: '1999', url: 'https://www.1999.co.jp/list/2613/7/1?soldout=0' };
  const notifications = [];
  const state = { data: { commerce: { japanAuctions: {
    targets: { [target.id]: { initialized: true, products: {
      '/eng/10999999': { id: '/eng/10999999', title: 'BEYBLADE X UX-15', url: 'https://www.1999.co.jp/eng/10999999', price: '¥4,200', available: true }
    } } },
    recentNotifications: {}, recentNotificationsSeededAt: new Date().toISOString()
  } } }, save: async () => {} };
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state, getTargets: () => [target], notify: async (...args) => notifications.push(args), log: () => {}
  });
  monitor.load = async () => `<article class="c-card"><div class="c-card__info">
    <a class="c-card__info-links" href="/10999999"></a>
    <div class="c-card__title">ベイブレードX UX-15</div>
    <div class="c-card__price-element">4,200円</div>
  </div></article>`;

  const result = await monitor.scanTarget(target);

  assert.equal(result.discovered, 0);
  assert.equal(result.notified, 0);
  assert.equal(notifications.length, 0);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products['10999999'].available, true);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products['10999999'].url, 'https://www.1999.co.jp/10999999');
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products['/eng/10999999'], undefined);
});

test('樂天解析器只把沒有售罄遮罩的商品視為可購', () => {
  const products = parseRakutenProducts(`
    <div id="risFil">
      <a href="/yousay-do-pointup/ux15/"><div class="categoryWindowImg"><img src="//img.example/ux15.jpg"></div></a>
      <div><a class="category_itemnamelink" href="/yousay-do-pointup/ux15/">UX-15 Shark Scale</a><span class="category_itemprice">4,200円</span></div>
      <a href="/yousay-do-pointup/bx35/"><div class="categoryWindowImg"><div class="soldout_category_window"></div></div></a>
      <div><a class="category_itemnamelink" href="/yousay-do-pointup/bx35/">BX-35 Vol.04</a><span class="category_itemprice">295円</span></div>
    </div>
  `);
  assert.equal(products.length, 2);
  assert.equal(products[0].available, true);
  assert.equal(products[0].imageUrl, 'https://img.example/ux15.jpg');
  assert.equal(products[1].available, false);
});

test('樂天店舖搜尋解析器只收指定 sid 的商品並擷取價格圖片', () => {
  const products = parseRakutenSearchProducts(`
    <article class="searchresultitem" data-card-type="item" data-track-itemid="210240/1001" data-shop-id="210240" data-track-price="3980">
      <a href="https://item.rakuten.co.jp/yousay-do/ux15/"><img src="https://img.example/ux15.jpg"></a>
      <h2><a href="https://item.rakuten.co.jp/yousay-do/ux15/">BEYBLADE X UX-15</a></h2>
    </article>
    <article class="searchresultitem" data-card-type="item" data-track-itemid="999999/1002" data-shop-id="999999" data-track-price="100">
      <h2><a href="https://item.rakuten.co.jp/advertiser/not-target/">推薦廣告</a></h2>
    </article>
  `, 'https://search.rakuten.co.jp/search/mall/beyblade/?sid=210240');
  assert.equal(products.length, 1);
  assert.equal(products[0].title, 'BEYBLADE X UX-15');
  assert.equal(products[0].price, '¥3,980');
  assert.equal(products[0].imageUrl, 'https://img.example/ux15.jpg');
  assert.equal(products[0].available, true);
});

test('樂天 Books 解析器讀取玩具、價格圖片與明確庫存狀態', () => {
  const products = parseRakutenBooksProducts(`
    <div class="rbcomp__item-list__item">
      <span class="rbcomp__category">おもちゃ</span>
      <h3><a href="https://books.rakuten.co.jp/rb/18766356/?l-id=search-c-item-text-01"><span class="rbcomp__item-list__item__title">BEYBLADE X CX-19</span></a></h3>
      <span class="rbcomp__item-list__item__price"><em>1,600円</em></span>
      <p class="rbcomp__item-list__item__stock"><em>ご注文できない商品</em></p>
      <img src="https://tshop.r10s.jp/book/cabinet/cx19.jpg?downsize=130:*">
    </div>
    <div class="rbcomp__item-list__item">
      <span class="rbcomp__category">グッズ</span>
      <h3><a href="/rb/18719874/"><span class="rbcomp__item-list__item__title">BEYBLADE X UX-21</span></a></h3>
      <span class="rbcomp__item-list__item__price"><em>4,500円</em></span>
      <p class="rbcomp__item-list__item__stock"><em>在庫あり</em></p>
    </div>
    <div class="rbcomp__item-list__item">
      <span class="rbcomp__category">本</span>
      <h3><a href="/rb/18802618/"><span class="rbcomp__item-list__item__title">BEYBLADE X（10）</span></a></h3>
      <p class="rbcomp__item-list__item__stock"><em>在庫あり</em></p>
    </div>
  `, 'https://books.rakuten.co.jp/search?sitem=BEYBLADE+X&g=006');
  assert.equal(products.length, 2);
  assert.equal(products[0].id, '/rb/18766356');
  assert.equal(products[0].url, 'https://books.rakuten.co.jp/rb/18766356/');
  assert.equal(products[0].price, '¥1,600');
  assert.equal(products[0].available, false);
  assert.match(products[0].imageUrl, /cx19\.jpg/);
  assert.equal(products[1].available, true);
  assert.match(products[1].detail, /在庫あり/);
});

test('樂天 Books 監控優先走 HTTP 並關閉既有常駐頁面', async () => {
  const target = {
    id: 'rakuten-books-fast', name: '樂天 Books', sourceType: 'rakuten-books',
    url: 'https://books.rakuten.co.jp/search?sitem=BEYBLADE+X&g=006'
  };
  let pageClosed = 0;
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state: { data: {}, save: async () => {} }, getTargets: () => [target],
    notify: async () => {}, log: () => {},
    fetcher: async () => ({
      ok: true,
      text: async () => `${' '.repeat(1000)}<div class="rbcomp__item-list__item"><span class="rbcomp__category">おもちゃ</span><h3><a href="/rb/fast/"><span class="rbcomp__item-list__item__title">BEYBLADE X BX-52</span></a></h3><span class="rbcomp__item-list__item__price"><em>2,300円</em></span><p class="rbcomp__item-list__item__stock"><em>在庫あり</em></p></div>`
    })
  });
  monitor.pages.set(target.id, { close: async () => { pageClosed += 1; } });

  const html = await monitor.load(target);

  assert.match(html, /BX-52/);
  assert.equal(pageClosed, 1);
  assert.equal(monitor.pages.has(target.id), false);
});

test('日拍 HTTP 快速路徑驗證失敗時保留瀏覽器備援', async () => {
  const target = {
    id: 'rakuten-books-fallback', name: '樂天 Books', sourceType: 'rakuten-books',
    url: 'https://books.rakuten.co.jp/search?sitem=BEYBLADE+X&g=006'
  };
  const logs = [];
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state: { data: {}, save: async () => {} }, getTargets: () => [target],
    notify: async () => {}, log: (message) => logs.push(message),
    fetcher: async () => ({ ok: true, text: async () => '<html>Just a moment</html>' })
  });
  monitor.pageFor = async () => ({
    goto: async () => {}, waitForSelector: async () => {}, content: async () => `${' '.repeat(1000)}<main>browser fallback</main>`,
    locator: () => ({ innerText: async () => 'browser fallback' }), title: async () => '樂天 Books'
  });

  const html = await monitor.load(target);

  assert.match(html, /browser fallback/);
  assert.match(logs[0], /改用瀏覽器備援/);
});

test('EDION 瀏覽器遇到請稍候驗證頁時立即拒絕且不等待商品選擇器', async () => {
  const target = { id: 'edion-challenge', name: '愛電王', siteName: 'EDION', sourceType: 'edion', url: 'https://www.edion.com/item_list.html?keyword=beyblade+x' };
  let selectorWaited = false;
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state: { data: {}, save: async () => {} }, getTargets: () => [target], notify: async () => {}, log: () => {}
  });
  monitor.pageFor = async () => ({
    goto: async () => {},
    title: async () => '請稍候...',
    locator: () => ({ innerText: async () => '' }),
    waitForSelector: async () => { selectorWaited = true; },
    content: async () => '<html><body></body></html>'
  });

  await assert.rejects(() => monitor.load(target), (error) => error.code === 'verification_required' && /流量驗證頁.*保留 0 件既有基線/.test(error.message));
  assert.equal(selectorWaited, false);
});

test('EDION 驗證頁標題不明確時仍能由 Cloudflare 標記辨識', async () => {
  const target = { id: 'edion-markup-challenge', name: '愛電王', siteName: 'EDION', sourceType: 'edion', url: 'https://www.edion.com/item_list.html?keyword=beyblade+x' };
  const monitor = new JapanAuctionMonitor({
    dataDir: '',
    state: { data: { commerce: { japanAuctions: { targets: { [target.id]: { products: Object.fromEntries(Array.from({ length: 43 }, (_, index) => [String(index), {}])) } } } } }, save: async () => {} },
    getTargets: () => [target], notify: async () => {}, log: () => {}
  });
  monitor.pageFor = async () => ({
    goto: async () => {},
    title: async () => 'エディオンネットショップ',
    locator: () => ({ innerText: async () => '' }),
    waitForSelector: async () => { throw new Error('selector timeout'); },
    content: async () => '<html><body><iframe src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></iframe></body></html>'
  });

  await assert.rejects(() => monitor.load(target), (error) => error.code === 'verification_required' && /EDION 回傳 Cloudflare.*保留 43 件/.test(error.message));
});

test('1999 驗證頁沒有明顯標題時也立即辨識，保留基線並降速，不等待商品元素', async () => {
  const target = { id: '1999-blocked', name: '1999', siteName: '1999.co.jp', sourceType: '1999', url: 'https://www.1999.co.jp/list/2613/7/1?soldout=0' };
  const product = { id: '10999999', title: 'BEYBLADE X UX-15', url: 'https://www.1999.co.jp/10999999', available: true };
  const state = { data: { commerce: { japanAuctions: { targets: {
    [target.id]: { initialized: true, products: { [product.id]: product }, lastScanAt: '2026-10-07T00:00:00Z' }
  } } } }, save: async () => {} };
  let waited = false;
  let closed = false;
  let notified = false;
  const monitor = new JapanAuctionMonitor({ dataDir: '', state, getTargets: () => [target], log: () => {}, notify: async () => { notified = true; } });
  const page = {
    goto: async () => ({ status: () => 403 }), title: async () => 'Hobby Search',
    locator: () => ({ innerText: async () => 'Security check' }),
    content: async () => '<html><script>window._cf_chl_opt = {};</script></html>',
    waitForSelector: async () => { waited = true; }, close: async () => { closed = true; }
  };
  monitor.pages.set(target.id, page);
  monitor.pageFor = async () => page;
  await assert.rejects(() => monitor.scanTarget(target), { code: 'verification_required' });
  assert.equal(waited, false);
  assert.equal(closed, true);
  assert.equal(notified, false);
  const saved = monitor.status(target);
  assert.deepEqual(saved.products[product.id], product);
  assert.equal(saved.lastScanAt, '2026-10-07T00:00:00Z');
  assert.equal(saved.lastErrorCode, 'verification_required');
  assert.equal(japanAuctionFailureDelayMs('1999', 1, 20, { verificationRequired: true }), 60_000);
  assert.equal(japanAuctionFailureDelayMs('1999', 20, 20, { verificationRequired: true }), 900_000);
});

test('1999 HTTP 錯誤不等待元素，也不把錯誤頁當作商品清單', async () => {
  const target = { id: '1999-http', sourceType: '1999' };
  const monitor = new JapanAuctionMonitor({ dataDir: '', state: { data: {} }, getTargets: () => [target], log: () => {} });
  monitor.pageFor = async () => ({ goto: async () => ({ status: () => 503 }), title: async () => 'Service unavailable',
    locator: () => ({ innerText: async () => 'unavailable' }), content: async () => '<html>unavailable</html>' });
  await assert.rejects(() => monitor.load(target), /HTTP 503.*保留既有基線/);
});

test('1999 正常清單含被動安全腳本不誤判驗證，等待 attached 而不是 visible', async () => {
  const target = { id: '1999-ok', sourceType: '1999', url: 'https://www.1999.co.jp/list/2613/7/1?soldout=0' };
  const monitor = new JapanAuctionMonitor({ dataDir: '', state: { data: {} }, getTargets: () => [target], log: () => {} });
  const html = `${' '.repeat(1000)}<div class="c-card__info"><a class="c-card__info-links" href="/10999999"><div class="c-card__title">BEYBLADE X UX-15</div></a></div><script src="/cdn-cgi/challenge-platform/passive.js"></script>`;
  monitor.pageFor = async () => ({ goto: async () => ({ status: () => 200 }), title: async () => 'Hobby Search',
    locator: () => ({ innerText: async () => 'BEYBLADE X UX-15' }), content: async () => html,
    waitForSelector: async (selector, options) => { assert.equal(selector, 'div.c-card__info'); assert.equal(options.state, 'attached'); } });
  assert.equal(await monitor.load(target), html);
});

test('EDION 解析器擷取商品編號、圖片、價格、庫存與售罄狀態', () => {
  const products = parseEdionProducts(`
    <ul>
      <li>
        <p><a href="/detail.html?p_cd=00080924159&_keyword=beyblade+x"><img src="//image.example/bx43.jpg" alt="タカラトミー BX-43 ギアケース"></a></p>
        <p><a href="/detail.html?p_cd=00080924159&_keyword=beyblade+x">タカラトミー BX-43 ギアケース</a></p>
        <p>￥4,000(税込)</p><p>在庫数83台</p>
      </li>
      <li><p><a href="/detail.html?p_cd=00082678944&_keyword=beyblade+x">UX-15 シャークスケイル</a></p><p>売り切れ</p><p>￥4,200(税込)</p><p>在庫数0台</p></li>
    </ul>
  `);
  assert.equal(products.length, 2);
  assert.equal(products[0].id, '00080924159');
  assert.equal(products[0].price, '¥4,000');
  assert.equal(products[0].imageUrl, 'https://image.example/bx43.jpg');
  assert.equal(products[0].available, true);
  assert.match(products[0].url, /p_cd=00080924159/);
  assert.match(products[0].detail, /83/);
  assert.equal(products[1].available, false);
});

test('Taiyo Market 只解析第一頁前 48 項並辨識價格與品切れ', () => {
  const cards = Array.from({ length: 50 }, (_, index) => {
    const number = String(index + 1).padStart(12, '0');
    const soldOut = index === 1;
    return `<li><div class="innerBox"><div class="imgWrap"><a href="/shop/shopdetail.html?brandcode=${number}&search=beyblade&sort=price_desc"><img src="https://makeshop-multi-images.akamaized.net/taiyomarket/itemimages/${number}.jpg" alt="BEYBLADE X BX-${String(index + 1).padStart(2, '0')}"></a></div><div class="detail"><a class="name" href="/shop/shopdetail.html?brandcode=${number}&search=beyblade&sort=price_desc">BEYBLADE X BX-${String(index + 1).padStart(2, '0')}</a><p class="price">${(index + 1).toLocaleString('en-US')}円</p><div class="else"><ul><li></li><li></li><li>490481000000${index}</li></ul></div><div class="btnWrap">${soldOut ? '<p class="soldout">品切れ</p>' : `<a href="basket.html?brandcode=${number}&amount=1">カートに入れる</a>`}</div></div></div></li>`;
  }).join('');
  const products = parseTaiyoMarketProducts(`<ul>${cards}</ul>`);

  assert.equal(products.length, 48);
  assert.equal(products[0].id, '000000000001');
  assert.equal(products[0].price, '¥1');
  assert.equal(products[0].available, true);
  assert.equal(products[1].available, false);
  assert.equal(products.some((product) => product.id === '000000000049'), false);
  assert.equal(products[0].url, 'https://taiyo-market.com/shop/shopdetail.html?brandcode=000000000001');
  assert.match(products[0].detail, /JAN/);
});

test('Taiyo Market 不足 48 項時拒絕覆蓋既有基線', async () => {
  const target = { id: 'taiyo', sourceType: 'taiyo', url: 'https://taiyo-market.com/shop/shopbrand.html?page=1&search=beyblade&sort=price_desc' };
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state: { data: {}, save: async () => {} }, getTargets: () => [target], notify: async () => {}, log: () => {}
  });
  monitor.load = async () => '<li><div class="detail"><a class="name" href="/shop/shopdetail.html?brandcode=1">BEYBLADE X BX-01</a><p class="price">1,000円</p><div class="btnWrap"><p class="soldout">品切れ</p></div></div></li>';

  await assert.rejects(() => monitor.inspectTarget(target), /應有 48 項.*只讀到 1 項/);
});

test('Taiyo Market HTTP 快速路徑依 Content-Type 用 EUC-JP 解碼', async () => {
  const target = { id: 'taiyo-euc-jp', name: 'Taiyo', siteName: 'Taiyo Market', sourceType: 'taiyo', url: 'https://taiyo-market.com/shop/shopbrand.html?page=1&search=beyblade&sort=price_desc' };
  const cards = Array.from({ length: 48 }, (_, index) => {
    const id = String(index + 1).padStart(12, '0');
    const title = index === 0 ? 'BEYBLADE X BX-57 3on3デッキケース ブラックVer.' : `BEYBLADE X BX-${index + 1}`;
    return `<li><div class="imgWrap"><img src="/${id}.jpg"></div><div class="detail"><a class="name" href="/shop/shopdetail.html?brandcode=${id}">${title}</a><p class="price">1,100円</p><div class="else"><ul><li></li><li></li><li>4904810000000</li></ul></div><div class="btnWrap"><a href="basket.html?brandcode=${id}">カートに入れる</a></div></div></li>`;
  }).join('');
  const encoded = iconv.encode(`<html><meta charset="EUC-JP"><ul>${cards}</ul></html>`, 'euc-jp');
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state: { data: {}, save: async () => {} }, getTargets: () => [target], notify: async () => {}, log: () => {},
    fetcher: async () => ({
      ok: true,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html; charset=EUC-JP' : null },
      arrayBuffer: async () => encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
    })
  });

  const html = await monitor.load(target);

  assert.match(html, /3on3デッキケース/);
  assert.doesNotMatch(html, /\uFFFD/);
});

test('Taiyo Market 黑名單商品不會留在可購基線造成假補貨', async () => {
  const target = { id: 'taiyo-excluded-baseline', name: 'Taiyo', siteName: 'Taiyo Market', sourceType: 'taiyo', url: 'https://taiyo-market.com/shop/shopbrand.html?page=1&search=beyblade&sort=price_desc' };
  const excludedId = '000000000001';
  const cards = Array.from({ length: 48 }, (_, index) => {
    const id = String(index + 1).padStart(12, '0');
    const title = index === 0 ? 'BEYBLADE X BX-57 3on3デッキケース ブラックVer.' : `BEYBLADE X BX-${index + 1}`;
    return `<li><div class="imgWrap"><img src="/${id}.jpg"></div><div class="detail"><a class="name" href="/shop/shopdetail.html?brandcode=${id}">${title}</a><p class="price">1,100円</p><div class="else"><ul><li></li><li></li><li>4904810000000</li></ul></div><div class="btnWrap"><a href="basket.html?brandcode=${id}">カートに入れる</a></div></div></li>`;
  }).join('');
  const previousProducts = Object.fromEntries(Array.from({ length: 48 }, (_, index) => {
    const id = String(index + 1).padStart(12, '0');
    return [id, {
      id,
      title: index === 0 ? '��BX-57 3on3��' : `BEYBLADE X BX-${index + 1}`,
      available: true
    }];
  }));
  const state = { data: { commerce: { japanAuctions: { targets: {
    [target.id]: { initialized: true, products: previousProducts }
  } } } }, save: async () => {} };
  const notifications = [];
  const monitor = new JapanAuctionMonitor({
    dataDir: '', state, getTargets: () => [target], getExcludeKeywords: () => ['デッキケース'],
    notify: async (...args) => notifications.push(args), log: () => {}
  });
  monitor.load = async () => `<ul>${cards}</ul>`;

  const result = await monitor.scanTarget(target);

  assert.equal(result.excluded, 1);
  assert.equal(result.restocked, 0);
  assert.equal(notifications.length, 0);
  assert.equal(state.data.commerce.japanAuctions.targets[target.id].products[excludedId], undefined);
  assert.match(state.data.commerce.japanAuctions.targets[target.id].excluded[excludedId].reason, /デッキケース/);
});

test('日本網站網址會自動辨識既有解析器，不支援的網域會拒絕', () => {
  assert.equal(classifyJapanAuctionUrl('https://www.1999.co.jp/list/2613/7/1?soldout=0').sourceType, '1999');
  assert.equal(classifyJapanAuctionUrl('https://www.1999.co.jp/eng/search?searchkey=Beyblade+x').sourceType, '1999');
  assert.equal(classifyJapanAuctionUrl('https://item.rakuten.co.jp/shop/c/0000000424/').sourceType, 'rakuten');
  assert.equal(classifyJapanAuctionUrl('https://search.rakuten.co.jp/search/mall/beyblade/?sid=210240').sourceType, 'rakuten-search');
  assert.throws(() => classifyJapanAuctionUrl('https://search.rakuten.co.jp/search/mall/beyblade/'), /必須包含店舖 sid/);
  const rakutenBooks = classifyJapanAuctionUrl('https://books.rakuten.co.jp/search?sitem=BEYBLADE+X&g=006&h=100');
  assert.equal(rakutenBooks.sourceType, 'rakuten-books');
  assert.equal(new URL(rakutenBooks.url).searchParams.get('h'), '100');
  assert.throws(() => classifyJapanAuctionUrl('https://books.rakuten.co.jp/search?g=006'), /必須包含搜尋關鍵字/);
  assert.equal(classifyJapanAuctionUrl('https://www.edion.com/item_list.html?keyword=beyblade+x').sourceType, 'edion');
  const taiyo = classifyJapanAuctionUrl('https://taiyo-market.com/shop/shopbrand.html?page=2&search=beyblade&sort=name');
  assert.equal(taiyo.sourceType, 'taiyo');
  assert.equal(new URL(taiyo.url).searchParams.get('page'), '1');
  assert.equal(new URL(taiyo.url).searchParams.get('sort'), 'price_desc');
  assert.throws(() => classifyJapanAuctionUrl('https://taiyo-market.com/shop/shopbrand.html?page=1&search=tomica'), /search=beyblade/);
  assert.throws(() => classifyJapanAuctionUrl('https://www.biccamera.com/bc/category/?q=bayblade'), /目前可自動辨識/);
  assert.throws(() => classifyJapanAuctionUrl('https://example.com/products'), /目前可自動辨識/);
});

test('日本拍賣通知可直接點商品頁並使用日拍分流', () => {
  const message = japanAuctionNotification({ title: 'UX-15', price: '¥4,200', url: 'https://example.jp/ux15' }, { siteName: '1999.co.jp', sourceType: '1999' });
  assert.equal(message.options.discordAudience, 'japan');
  assert.equal(message.options.embeds[0].url, 'https://example.jp/ux15');
  assert.match(message.options.embeds[0].description, /UX-15/);
  assert.match(message.options.discordPreview, /1999\.co\.jp/);
});

test('日本拍賣測試通知固定模擬 1999 UX-15 且不會被誤認為真實補貨', () => {
  const message = japanAuctionTestNotification();
  assert.equal(message.options.discordAudience, 'japan');
  assert.equal(message.product.url, 'https://www.1999.co.jp/11172934');
  assert.match(message.text, /測試通知/);
  assert.match(message.options.discordPreview, /UX-15/);
  assert.match(message.options.embeds[0].title, /測試/);
  assert.match(message.options.embeds[0].description, /4,200円/);
  assert.match(message.options.embeds[0].description, /約 NT\$920/);
  assert.match(message.options.embeds[0].footer.text, /不是真實補貨/);
});
