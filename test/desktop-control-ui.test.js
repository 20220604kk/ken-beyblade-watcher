import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDashboard } from '../src/dashboard.js';
import { normalizeAutoPurchaseConfig } from '../src/auto-purchase.js';

test('桌面原介面投影：三平台實際表格、原操作、可收合 LOG；載入與刷新不送出任何操作', {timeout:35_000}, async () => {
  const script=await fs.readFile(new URL('../src/monitor-control/desktop-orders.js',import.meta.url),'utf8');
  const slots={funbox:['A','B','C'],eslite:['A','B','C','D','E']};
  const accounts=platform=>slots[platform].map(slot=>({slot,account:`test-${slot}`,displayAccount:`測試${slot}`,ready:true,enabled:true}));
  const fixture={systemPause:{active:false},overview:{sources:[],orders:[],notifications:{}},performance:{},funbox:{enabled:true},shoppingSites:{enabled:true},
    autoPurchase:{...normalizeAutoPurchaseConfig({enabled:false}),queue:[],recent:[],credentials:Object.fromEntries(Object.keys(slots).map(p=>[p,{accounts:accounts(p)}])),runtime:Object.fromEntries(Object.keys(slots).map(p=>[p,{accounts:accounts(p).map(a=>({...a,loginState:'ready',apiReady:true}))}]))},
    japanAuctions:{enabled:true,amazonJp:{enabled:true},amazonJpProductOrders:['A','B','C'].map(slot=>({slot,enabled:false,targetSuccessCount:1,maxShippingYen:500,targetUrl:'https://www.amazon.co.jp/dp/B000000001',purchaseSteps:[],history:[]}))}};
  const server=createDashboard({port:0,readOnly:true,getStatus:()=>fixture,log:()=>{},productCatalog:{read:async()=>({items:[],categories:[]})}});
  await once(server,'listening');
  const fixtureOrigin=`http://127.0.0.1:${server.address().port}`;
  const host=await fs.readFile(new URL('../src/monitor-control/OrdersView.cs',import.meta.url),'utf8');
  const hostUrl=host.match(/DashboardUrl="([^"]+)"/)[1];
  assert.equal(hostUrl,'http://127.0.0.1:3210/');
  // Exercise the real dashboard router. The old test falsely served HTML for
  // every URL and therefore hid the desktop host's query-string 404.
  assert.equal((await fetch(fixtureOrigin+'/?desktop=orders')).status,404);
  assert.equal((await fetch(fixtureOrigin+new URL(hostUrl).pathname)).status,200);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1080,height:1200}});
    page.setDefaultTimeout(7000);
    const mutations=[],errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());requests.push(url.pathname);
      if(request.method()!=='GET'){mutations.push(url.pathname);return route.fulfill({status:403,contentType:'application/json',body:'{"error":"fixture prohibits mutations"}'});}
      const actual=await fetch(fixtureOrigin+url.pathname+url.search);
      return route.fulfill({status:actual.status,contentType:actual.headers.get('content-type')||'application/json',body:await actual.text()});
    });
    await page.addInitScript(()=>localStorage.setItem('beyblade-monitor-tab','overview'));
    await page.addInitScript({content:script});
    await page.goto(hostUrl);
    await page.waitForSelector('#amazon-product-order-card-C');
    assert.equal(await page.locator('#ken-desktop-orders [data-desktop-platform]').count(),3);
    assert.match(await page.locator('[data-desktop-platform="funbox"] > summary').textContent(),/FUNBOX/);
    assert.equal(await page.locator('#funbox-sheet-account-A').isVisible(),true);
    assert.equal(await page.locator('#eslite-sheet-account-E').isVisible(),true);
    assert.equal(await page.locator('#desktop-amazon-log').getAttribute('open'),null);
    await page.locator('#desktop-amazon-log > summary').click();
    assert.equal(await page.locator('#amazon-product-order-live-logs').isVisible(),true);
    await page.evaluate(()=>refresh());
    assert.equal(await page.locator('#desktop-amazon-log').getAttribute('open'),'');
    await page.locator('#desktop-amazon-log > summary').click();
    assert.equal(await page.locator('#amazon-product-order-live-logs').isVisible(),false);
    assert.match(await page.locator('#eslite-sheet-settings-A').getAttribute('onclick'),/toggleEsliteAccountCard/);
    await page.locator('#eslite-sheet-settings-A').click();
    assert.equal(await page.locator('#eslite-account-A-card .eslite-account-body').isVisible(),true);
    assert.deepEqual(mutations,[]);
    assert.deepEqual(errors,[]);
    assert.ok(requests.includes('/api/status'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    if(process.env.KEN_CONTROL_UI_SCREENSHOT)await page.screenshot({path:process.env.KEN_CONTROL_UI_SCREENSHOT,fullPage:true});
  }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
