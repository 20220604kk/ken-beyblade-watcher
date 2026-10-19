import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDashboard } from '../src/dashboard.js';
import { normalizeAutoPurchaseConfig } from '../src/auto-purchase.js';

test('ABC 開啟：實際按鈕連到對應視窗，桌面操作維持單行且不橫捲', {timeout:35_000}, async () => {
  const opened = [], mutations = [], errors = [];
  const fixture = {systemPause:{active:false},overview:{sources:[],orders:[],notifications:{}},performance:{},
    funbox:{enabled:false},shoppingSites:{enabled:false},
    autoPurchase:{...normalizeAutoPurchaseConfig({enabled:false}),queue:[],recent:[],credentials:{},runtime:{}},
    japanAuctions:{enabled:true,amazonJp:{enabled:false},amazonJpProductOrders:['A','B','C'].map(slot=>({
      slot,enabled:slot==='A',targetSuccessCount:1,maxShippingYen:500,status:slot==='A'?'waiting_poll':'needs_verification',
      ...(slot==='A'?{orderHistoryCheck:{status:'needs_login',scope:'order_history'}}:{}),
      targetUrl:'https://www.amazon.co.jp/dp/B0TEST0001',targetProduct:{asin:'B0TEST0001',title:'測試商品 CX-20',code:'CX-20'},
      purchaseSteps:[],orderHistory:{recent:[]}}))}};
  const server = createDashboard({port:0,getStatus:()=>fixture,log:()=>{},
    productCatalog:{read:async()=>({items:[],categories:[]})},
    onOpenAmazonJpProductOrderLogin:async body=>{opened.push(body.slot);return{message:body.slot+' 專用視窗已開啟'};},
    onSaveAmazonJpProductOrder:()=>assert.fail('不應儲存設定'),onScanAmazonJpProductOrder:()=>assert.fail('不應掃描或購買')});
  await once(server,'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{
      const request=route.request();
      if(new URL(request.url()).origin!==origin)return route.abort();
      if(request.method()!=='GET')mutations.push({url:new URL(request.url()).pathname,body:request.postDataJSON()});
      return route.continue();
    });
    await page.goto(origin);
    await page.locator('#tab-button-japan').click();
    await page.locator('details.card > summary').filter({hasText:'日亞自動下單'}).first().click();
    assert.match(await page.locator('#amazon-product-order-card-A .pill').innerText(),/等待補貨/);
    await page.locator('#amazon-product-order-card-A .amazon-product-disclosure > summary').click();
    assert.match(await page.locator('#amazon-product-order-detail-A .amazon-auxiliary-status').innerText(),/背景查單需登入（獨立狀態）/);
    for(const slot of ['A','B','C']){
      const button=page.getByRole('button',{name:`開啟任務 ${slot} 專用視窗`,exact:true});
      assert.equal(await button.innerText(),'開啟');
      await button.click();
      await page.waitForFunction(slot=>document.querySelector('#amazon-product-order-feedback')?.textContent===slot+'｜'+slot+' 專用視窗已開啟',slot);
    }
    assert.deepEqual(opened,['A','B','C']);
    assert.deepEqual(mutations,['A','B','C'].map(slot=>({url:'/japan/amazon-product-order/login/open',body:{slot}})));
    for(const width of [1280,1024,900,720]){
      await page.setViewportSize({width,height:1000});
      const layout=await page.locator('.amazon-order-actions').evaluateAll(rows=>rows.map(row=>{
        const bounds=row.getBoundingClientRect(),controls=[...row.children].map(c=>c.getBoundingClientRect());
        return {singleLine:controls.every(c=>Math.abs(c.top+c.height/2-controls[0].top-controls[0].height/2)<2),fits:controls.at(-1).right<=bounds.right+1};
      }));
      assert.ok(layout.every(row=>row.singleLine&&row.fits),JSON.stringify({width,layout}));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'no horizontal overflow at '+width);
    }
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
