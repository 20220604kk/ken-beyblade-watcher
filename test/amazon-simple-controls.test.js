import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';
import { createDashboard } from '../src/dashboard.js';

for (const slot of ['A', 'B', 'C']) {
  test(`${slot} 檢查統一路由：只讀、登入、查單、查車；不要求購買`, async t => {
    const monitor = new AmazonJpProductOrderMonitor({ slot, dataDir: '.', state: { data: {}, save: async () => {} },
      getConfig: () => ({ enabled: false, targetUrl: 'https://www.amazon.co.jp/dp/B0TEST0001' }),
      orderHistory: { status: () => ({}) } });
    t.after(() => monitor.close());
    const called = [];
    monitor.scanOnce = async options => { assert.equal(options.purchase, false); called.push('read'); return {}; };
    monitor.openLogin = async () => called.push('login');
    monitor.completeLogin = async () => called.push('verify');
    monitor.reconcileApiOrder = async () => called.push('orders');
    monitor.confirmApiCartReviewed = async () => called.push('cart');
    await monitor.check();
    monitor.storage().status = 'needs_login'; await monitor.check();
    monitor.interactive = true; await monitor.check(); monitor.interactive = false;
    monitor.storage().status = 'needs_review';
    monitor.storage().apiTransaction = { phase: 'submitted' }; await monitor.check();
    monitor.storage().apiTransaction = { phase: 'adding' }; await monitor.check();
    assert.deepEqual(called, ['read','verify','verify','orders','cart']);
    monitor.running = true;
    await assert.rejects(monitor.check(), /正在檢查或結帳/);
    monitor.running = false;
  });
}

async function controls() {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function amazonProductOrderSettings(slot)'), source.indexOf('async function addAmazonJpProduct('));
  const fields = new Map(), requests = [];
  const sandbox = { amazonProductOrderDirty: {}, currentStatus: { japanAuctions: { amazonJpProductOrders:
    [{slot:'A',mode:'hybrid',fastLane:true},{slot:'B',mode:'scan_signal'},{slot:'C',mode:'hybrid'}] } },
    refresh: async () => {}, api: async (route,body) => { requests.push({route,body}); return {message:'已完成'}; },
    document: { querySelector: key => fields.get(key) } };
  for (const slot of ['A','B','C']) {
    for (const [field,value] of [['enabled',true],['url','https://www.amazon.co.jp/dp/B0TEST0001'],['target-count','1'],['max-shipping','500']]) {
      fields.set(`#amazon-product-order-${slot}-${field}`, { checked: value===true, value, reportValidity: () => true });
    }
    fields.set(`#amazon-product-order-${slot}-result`, {});
    fields.set(`#amazon-product-order-card-${slot}`, { querySelectorAll: () => [...fields.entries()].filter(([key]) => key.includes(`-${slot}-`) && !key.endsWith('result')).map(([,field]) => field) });
  }
  vm.createContext(sandbox);
  fields.set('#amazon-product-order-clear-log',{});
  fields.set('#amazon-product-order-feedback',{});
  vm.runInContext(code+';this.actions={toggleAmazonProductOrder,saveAmazonProductOrderFields,openAmazonProductOrder,checkAmazonProductOrder,resetAmazonProductOrderProgress,clearAmazonProductOrderLogs};', sandbox);
  return { sandbox, fields, requests, ...sandbox.actions };
}

test('ABC 啟動勾選直接送設定；欄位自存及重設一律先停止，保留原線路模式', async () => {
  const c = await controls();
  for (const slot of ['A','B','C']) {
    const checkbox=c.fields.get(`#amazon-product-order-${slot}-enabled`);
    await c.toggleAmazonProductOrder(checkbox,slot);
    assert.equal(c.requests.at(-1).body.enabled,true);
    assert.equal(c.requests.at(-1).body.fastLane,true);
    assert.equal(c.requests.at(-1).body.mode,slot==='B'?'scan_signal':'hybrid');
    checkbox.checked=false;
    await c.toggleAmazonProductOrder(checkbox,slot);
    assert.deepEqual(JSON.parse(JSON.stringify(c.requests.at(-1).body)),{slot,enabled:false,stopOnly:true});
    await c.saveAmazonProductOrderFields(slot);
    assert.equal(c.requests.at(-1).body.enabled,false);
    await c.resetAmazonProductOrderProgress(slot);
    assert.equal(c.requests.at(-1).body.resetProgress,true);
    assert.equal(c.requests.at(-1).body.enabled,false);
    assert.equal(c.fields.get(`#amazon-product-order-${slot}-result`).textContent,'已完成');
  }
});

test('檢查不混入設定或送單；失敗可再次檢查，不永久鎖死控制；未存欄位拒絕檢查', async () => {
  const c=await controls();
  let fail=true;
  c.sandbox.api=async (route,body)=>{ c.requests.push({route,body}); if(fail)throw new Error('請先核對交易');return{message:'確認完成'}; };
  await c.checkAmazonProductOrder('A');
  assert.match(c.fields.get('#amazon-product-order-A-result').textContent,/請先核對交易/);
  assert.equal(c.sandbox.amazonProductOrderDirty.A,false);
  fail=false;await c.checkAmazonProductOrder('A');
  assert.equal(c.fields.get('#amazon-product-order-A-result').textContent,'確認完成');
  assert.ok(c.requests.every(r=>r.route.endsWith('/scan')&&r.body.check===true&&!r.body.purchase));
  c.sandbox.amazonProductOrderDirty.B=true;
  const count=c.requests.length;await c.checkAmazonProductOrder('B');
  assert.equal(c.requests.length,count);
});

test('啟動遭伺服器拒絕時恢復勾選；不把未啟動顯示成啟動成功', async () => {
  const c=await controls();const checkbox=c.fields.get('#amazon-product-order-A-enabled');
  c.sandbox.api=async()=>{throw new Error('任務忙碌');};
  await c.toggleAmazonProductOrder(checkbox,'A');
  assert.equal(checkbox.checked,false);
  assert.equal(checkbox.disabled,false);
  assert.match(c.fields.get('#amazon-product-order-A-result').textContent,/任務忙碌/);
});

test('清空只送 LOG 專用端點，保留未儲存設定並防止連點；錯誤可重試',async()=>{
  const c=await controls();c.sandbox.amazonProductOrderDirty.A=true;
  let resolve,fail=false;
  c.sandbox.api=async(route,body)=>{c.requests.push({route,body});if(fail)throw new Error('暫時失敗');return new Promise(done=>resolve=done);};
  const first=c.clearAmazonProductOrderLogs();await c.clearAmazonProductOrderLogs();
  assert.equal(c.requests.length,1);assert.ok(c.requests[0].route.endsWith('/clear-log'));
  resolve({message:'已清空'});await first;
  assert.equal(c.sandbox.amazonProductOrderDirty.A,true);
  assert.equal(c.fields.get('#amazon-product-order-clear-log').disabled,false);
  assert.equal(c.fields.get('#amazon-product-order-feedback').textContent,'已清空');
  fail=true;await c.clearAmazonProductOrderLogs();
  assert.equal(c.fields.get('#amazon-product-order-clear-log').disabled,false);
  assert.match(c.fields.get('#amazon-product-order-feedback').textContent,/暫時失敗/);
});

test('ABC 開啟只呼叫各自視窗端點；不儲存設定、不檢查或送單', async () => {
  const c = await controls();
  for (const slot of ['A','B','C']) {
    await c.openAmazonProductOrder(slot);
    assert.equal(c.requests.at(-1).route, '/japan/amazon-product-order/login/open');
    assert.equal(JSON.stringify(c.requests.at(-1).body), JSON.stringify({slot}));
    assert.equal(c.fields.get(`#amazon-product-order-${slot}-enabled`).checked, true);
  }
  c.sandbox.amazonProductOrderDirty.A = true;
  await c.openAmazonProductOrder('A');
  assert.equal(c.requests.length, 3);
  assert.match(c.fields.get('#amazon-product-order-A-result').textContent, /尚未儲存/);
});

test('開啟防止重複請求，忙碌錯誤後可重試', async () => {
  const c = await controls();
  let finish;
  c.sandbox.api = (route, body) => {
    c.requests.push({route,body});
    return new Promise(resolve => { finish = resolve; });
  };
  const first = c.openAmazonProductOrder('A');
  await c.openAmazonProductOrder('A');
  assert.equal(c.requests.length, 1);
  finish({message:'視窗已開啟'});
  await first;
  c.sandbox.api = async () => { throw new Error('正在結帳，暫不開啟'); };
  await c.openAmazonProductOrder('A');
  assert.match(c.fields.get('#amazon-product-order-A-result').textContent, /正在結帳/);
  assert.equal(c.fields.get('#amazon-product-order-A-enabled').disabled, false);
  c.sandbox.api = async () => ({message:'重試已開啟'});
  await c.openAmazonProductOrder('A');
  assert.equal(c.fields.get('#amazon-product-order-A-result').textContent, '重試已開啟');
});

for (const slot of ['A','B','C']) {
  test(`${slot} 專用視窗首次開啟暫停刷新；再次開啟沿用原頁，不中斷驗證`, async t => {
    const config = {enabled:true,targetUrl:'https://www.amazon.co.jp/dp/B0TEST0001'};
    const monitor = new AmazonJpProductOrderMonitor({slot,dataDir:'.',state:{data:{},save:async()=>{}},
      getConfig:()=>config,orderHistory:{status:()=>({})}});
    t.after(()=>monitor.close());
    const calls = [];
    const page = {isClosed:()=>false,goto:async url=>calls.push(['goto',url]),bringToFront:async()=>calls.push(['front'])};
    monitor.closeBrowser = async () => calls.push(['close']);
    monitor.pageFor = async headless => { assert.equal(headless,false); return monitor.page = page; };
    await monitor.openLogin();
    assert.equal(monitor.interactive,true);
    assert.equal(monitor.stopped,true);
    assert.equal(config.enabled,true);
    assert.deepEqual(calls.map(c=>c[0]),['close','goto']);
    assert.match((await monitor.openLogin()).message,/沒有重新載入/);
    assert.deepEqual(calls.map(c=>c[0]),['close','goto','front']);
    monitor.running = true;
    await assert.rejects(monitor.openLogin(),/正在檢查或結帳/);
    monitor.running = false;
  });
}

test('專用視窗 HTTP 路由正確轉送 ABC，不混入設定／掃描／送單', async t => {
  const slots = [];
  const server = createDashboard({port:0,getStatus:()=>({}),log:()=>{},
    onOpenAmazonJpProductOrderLogin: async body => { slots.push(body.slot); return {message:body.slot+' 專用視窗已開啟'}; },
    onSaveAmazonJpProductOrder:()=>assert.fail('不可改設定'),onScanAmazonJpProductOrder:()=>assert.fail('不可掃描／送單')});
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const slot of ['A','B','C']) {
    const response = await fetch(base+'/japan/amazon-product-order/login/open',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot})});
    assert.equal(response.status,200);
    assert.equal((await response.json()).message,slot+' 專用視窗已開啟');
  }
  assert.deepEqual(slots,['A','B','C']);
  const html = await (await fetch(base)).text();
  assert.match(html,/onclick="openAmazonProductOrder/);
  assert.match(html,/開啟此任務的專用登入／驗證視窗，不送單/);
});
