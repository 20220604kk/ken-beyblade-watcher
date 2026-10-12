import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { load } from 'cheerio';
import vm from 'node:vm';
import { CATALOG_CATEGORIES, SHEET_CSV_URL, ProductSheetCatalog, parseCatalogCsv, catalogListPatch, catalogListState } from '../src/product-sheet-catalog.js';
import { catalogClient } from '../src/product-sheet-ui.js';
import { createDashboard } from '../src/dashboard.js';

const csv = '型號,品項,售價（NT$）,類型\r\nBX-35,隨機強化組 Vol.4,NT295,隨機強化組\r\nUX-01,蒼龍爆刃,NT395,入門組\r\nCX-05,隨機強化組 Vol.6,NT350,隨機強化組\r\nBX-11,發射器握把,NT150,握把\r\nCX-00-eva,福音戰士改造組,"NT1,395",套組（聯名）\r\nBX-10,極限對戰盤,NT850,戰鬥盤\r\nBX-53,全配套組,待查,套組\r\n';
const response = text => ({ ok: true, headers: new Headers(), text: async () => text });
const settings = () => ({ enabled: true, funbox: { enabled: true, buyKeywords: ['UX-01'], skipBuyKeywords: ['BX-35'], payment: 'seven_cod', accountModes: { A: 'batch' } }, eslite: { buyMode: 'all', buyKeywords: [], skipBuyKeywords: ['戰鬥盤'] } });

test('原表六類分類，配件／聯名／對戰盤優先於型號系列', () => {
  const items = parseCatalogCsv(csv);
  assert.deepEqual(items.slice(0, 6).map(x => x.category), CATALOG_CATEGORIES);
  assert.equal(items[4].model, 'CX-00-EVA'); assert.equal(items[4].price, 1395);
  assert.equal(items[6].price, null); assert.equal(items[6].priceText, '待查');
});
test('CSV 保留引號、逗號、換行與空價，不把未知價格當零', () => {
  const items = parseCatalogCsv('型號,品項,售價（NT$）,類型\nBX-35,"名字, \"\"引號\"\"\n第二行",,增強包\nUX-01,免費,NT0,入門組');
  assert.equal(items[0].name, '名字, "引號"\n第二行'); assert.equal(items[0].price, null);
  assert.equal(items[1].price, 0);
});
test('來源結構漂移、重複型號與不完整 CSV 拒絕覆蓋快取', () => {
  for (const text of ['<html>請登入</html>', csv + 'BX-35,重複,NT295,入門組', csv + 'BX-99,"broken', csv + 'DROP TABLE,假商品,NT1,入門組']) assert.throws(() => parseCatalogCsv(text));
});
test('穩定商品 ID 不隨資料列順序與價格變動', () => {
  const a = parseCatalogCsv(csv)[0];
  const b = parseCatalogCsv('型號,品項,售價（NT$）,類型\nUX-01,蒼龍爆刃,NT395,入門組\nBX-35,新名稱,NT350,隨機強化組')[1];
  assert.equal(a.id, b.id);
});
test('BXG 一般復刻款不臆測成聯名，聯名必須由品項／類型確認', () => {
  const items = parseCatalogCsv('型號,品項,售價（NT$）,類型\nBXG-01,烈焰飛鳳S,NT350,增強包\nBXG-29,復仇者聯盟,NT995,套組（聯名）');
  assert.deepEqual(items.map(x => x.category), ['BX','聯名']);
});
test('讀取固定公開來源、合併同時讀取，15 分鐘快取／強制更新 30 秒節流', async () => {
  let calls = 0, now = 0;
  const catalog = new ProductSheetCatalog({ now: () => now, fetchImpl: async (url, opts) => { assert.equal(url, SHEET_CSV_URL); assert.equal(opts.headers.Accept, 'text/csv'); calls++; return response(csv); } });
  await Promise.all([catalog.read(), catalog.read()]); assert.equal(calls, 1);
  now = 20_000; await catalog.read({ force: true }); assert.equal(calls, 1);
  now = 30_000; await catalog.read({ force: true }); assert.equal(calls, 2);
  now = 900_000; await catalog.read(); assert.equal(calls, 2);
  now = 930_000; await catalog.read(); assert.equal(calls, 3);
});
test('更新失敗保留上次價格與商品，明確標示舊資料', async () => {
  let now = 0, bad = false;
  const catalog = new ProductSheetCatalog({ now: () => now, fetchImpl: async () => response(bad ? '<html>blocked</html>' : csv) });
  const good = await catalog.read(); bad = true; now = 40_000;
  const failed = await catalog.read({ force: true });
  assert.deepEqual(failed.items, good.items); assert.equal(failed.updatedAt, good.updatedAt); assert.equal(failed.stale, true); assert.match(failed.error, /欄位已變更/);
});
test('名單動作只改指定平台與單一型號、不改付款開關或其他規則', () => {
  const before = settings(), item = parseCatalogCsv(csv)[0];
  const { config: after } = catalogListPatch(before, { platform: 'funbox', list: 'white', item });
  assert.deepEqual(after.eslite, before.eslite); assert.deepEqual(after.funbox.buyKeywords, ['UX-01','BX-35']); assert.deepEqual(after.funbox.skipBuyKeywords, []);
  assert.equal(after.funbox.payment, 'seven_cod'); assert.deepEqual(after.funbox.accountModes, before.funbox.accountModes); assert.equal(after.enabled, true);
  assert.deepEqual(before, settings());
  assert.deepEqual(catalogListPatch(after, { platform: 'funbox', list: 'white', item }).config, after);
});
test('廣泛黑名單保留並提示，白名單模式不擅自切換', () => {
  const item = parseCatalogCsv(csv)[5], before = settings();
  before.eslite.skipBuyKeywords = ['對戰盤'];
  const result = catalogListPatch(before, { platform: 'eslite', list: 'white', item });
  assert.match(result.warning, /對戰盤/); assert.equal(result.config.eslite.buyMode, 'all');
  assert.deepEqual(catalogListState(item, result.config.eslite).black, ['對戰盤']);
  assert.match(catalogListPatch(before, { platform: 'eslite', list: 'white', item: parseCatalogCsv(csv)[0] }).warning, /未自動切換/);
});
test('非法平台或名單種類不改設定', () => {
  for (const body of [{platform:'momo',list:'white'},{platform:'funbox',list:'execute'},{platform:'both',list:'black'}]) assert.throws(() => catalogListPatch(settings(), { ...body, item: parseCatalogCsv(csv)[0] }));
});
test('控制台底部表格與 API → 名單保存 → 再讀完整走通，來源 ID 防偽造', async () => {
  let config = settings(), saves = 0;
  const catalog = new ProductSheetCatalog({ fetchImpl: async () => response(csv) });
  const server = createDashboard({ port: 0, productCatalog: catalog, log: () => {}, getStatus: () => ({ autoPurchase: config }), onAddCatalogList: async body => { saves++; config = catalogListPatch(config, body).config; return {message:'saved'}; } });
  if (!server.listening) await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body, origin) => fetch(base + '/product-catalog/list', { method:'POST', headers:{'Content-Type':'application/json', ...(origin ? {Origin:origin} : {})}, body:JSON.stringify(body) });
  try {
    const html = await (await fetch(base)).text(), $ = load(html);
    assert.equal($('#tab-overview > section').last().attr('id'), 'product-catalog-card');
    assert.equal($('#catalog-category option').length, 7); assert.equal($('#catalog-platform option').length, 2);
    assert.match(catalogClient, /htmlview\?gid=104&single=true/);
    $('script:not([src])').each((_i, element) => new vm.Script($(element).html()));
    const first = await (await fetch(base + '/api/product-catalog')).json();
    assert.equal(first.items.length, 7); assert.equal('credentials' in first, false);
    const item = first.items[0]; assert.deepEqual(item.listStates.funbox.black, ['BX-35']);
    assert.equal((await post({id:item.id,platform:'funbox',list:'white',keyword:'HACK'})).status, 200);
    const second = await (await fetch(base + '/api/product-catalog')).json(); assert.deepEqual(second.items[0].listStates.funbox.white, ['BX-35']);
    assert.equal((await post({id:'fake',platform:'funbox',list:'white'})).status, 400);
    assert.equal((await post({id:item.id,platform:'both',list:'white'})).status, 400);
    assert.equal((await post({id:item.id,platform:'funbox',list:'black'},'https://untrusted.example')).status, 403);
    assert.equal(saves, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('UI 型號、名稱、名單文字均跳脫，篩選與價格格式正確', () => {
  const elements = Object.fromEntries(['catalog-rows','catalog-sheet-preview','catalog-platform','catalog-category','catalog-search','catalog-status'].map(id => [id, {value:'',addEventListener(){}}]));
  elements['catalog-platform'].value = 'funbox';
  const ctx = vm.createContext({ document:{ getElementById:id=>elements[id] }, esc:x=>String(x).replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;') });
  vm.runInContext(catalogClient, ctx);
  vm.runInContext('productCatalog='+JSON.stringify({items:[{...parseCatalogCsv(csv)[0],name:'<img onerror="bad">',listStates:{funbox:{black:['<script>']}}}],lists:{},sheetName:'終端品項及售價'})+';renderProductCatalog()',ctx);
  assert.doesNotMatch(elements['catalog-rows'].innerHTML, /<img|<script>/); assert.match(elements['catalog-rows'].innerHTML,/295/);
  elements['catalog-category'].value = 'CX'; vm.runInContext('renderProductCatalog()', ctx); assert.match(elements['catalog-rows'].innerHTML,/沒有符合/);
});
test('有未儲存設定時 UI 阻止名單寫入，不覆蓋使用者草稿', async () => {
  const status = {textContent:''}; let writes = 0;
  const ctx = vm.createContext({ document:{getElementById:id=>id==='catalog-platform'?{value:'funbox'}:{...status,addEventListener(){}}}, autoPurchaseDirtyPlatforms:new Set(['funbox']), api:()=>{writes++;} });
  const nodes = {}; ctx.document.getElementById = id => nodes[id] ||= {value:id==='catalog-platform'?'funbox':'',addEventListener(){},textContent:''};
  vm.runInContext(catalogClient, ctx); await vm.runInContext("addCatalogList('id','white')",ctx);
  assert.equal(writes, 0); assert.match(nodes['catalog-action-status'].textContent,/先儲存/);
});
