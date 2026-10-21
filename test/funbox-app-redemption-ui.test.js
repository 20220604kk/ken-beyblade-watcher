import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { clientScript } from '../src/optional-tasks/funbox-app-redemption-ui.js';

// All HTTP is fulfilled locally with synthetic serials. No real account or store.
async function fixture(work) {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage(); page.setDefaultTimeout(5000);
    let state={csrf:'synthetic',enabled:false,reserved:false,running:false,startAt:'2026-10-21T02:00:00Z',events:[],jobs:[{id:'one',productId:'bbpr07730',status:'queued',codeSaved:true}]};
    let codes=['AAAA-BBBB-0001']; const calls=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<div class="funbox-purchase-panel"><table><tr id="funbox-sheet-account-C"><td id="funbox-sheet-api-C"></td><td id="funbox-sheet-actions-C"></td></tr></table></div>'});
      const action=url.pathname.split('/').at(-1); const body=request.method()==='POST'?request.postDataJSON():{}; calls.push({action,body});
      if(action==='save') {
        if(body.rows.some(r=>!/^\w{4}-\w{4}-\w{4}$/.test(r.code)))return route.fulfill({status:400,json:{error:'序號格式應為四碼－四碼－四碼'}});
        codes=body.rows.map(r=>r.code); state={...state,startAt:body.startAt,jobs:body.rows.map((r,i)=>({id:r.id||'row'+i,productId:r.productId,status:'queued',codeSaved:true}))};
      }
      if(action==='arm')state={...state,enabled:true,reserved:true};
      if(action==='edit')return route.fulfill({json:{...state,jobs:state.jobs.map((j,i)=>({...j,code:codes[i]}))}});
      return route.fulfill({json:state});
    });
    // Reproduce an environment in which browser-native confirmation is unusable.
    await page.addInitScript(()=>{window.confirm=()=>{throw new Error('native confirmation unavailable');};});
    await page.goto('http://127.0.0.1:3210/'); await page.addScriptTag({content:clientScript});
    await page.getByRole('button',{name:'特別',exact:true}).click();
    await work({page,calls,setState:value=>{state={...state,...value};}}); assert.deepEqual(errors,[]);
  }finally{await browser.close();}
}

test('特別任務介面：已保存序號明碼回填；未儲存修改點啟用會先保存，取消不啟用，最後確認才啟用',{timeout:25000},async()=>{
 await fixture(async({page,calls})=>{
  const code=page.getByRole('textbox',{name:'兌換序號',exact:true});
  assert.equal(await code.getAttribute('type'),'text'); assert.equal(await code.inputValue(),'AAAA-BBBB-0001');
  await code.fill('AAAA-BBBB-0002'); await page.locator('[data-time]').fill('2026-10-21T10:01');
  assert.equal(await page.locator('[data-arm]').isEnabled(),true);assert.match(await page.locator('[data-arm-reason]').textContent(),/先儲存/);
  await page.locator('[data-arm]').click(); await page.locator('[data-confirmation]').waitFor({state:'visible'});
  assert.equal(calls.filter(c=>c.action==='save').length,1);assert.equal(calls.find(c=>c.action==='save').body.startAt,'2026-10-21T10:01:00+08:00');
  assert.equal(calls.filter(c=>c.action==='arm').length,0);assert.match(await page.locator('[data-confirm-text]').textContent(),/10:01/);
  if(process.env.KEN_FUNBOX_SPECIAL_UI_SCREENSHOT)await page.screenshot({path:process.env.KEN_FUNBOX_SPECIAL_UI_SCREENSHOT,fullPage:true});
  await page.locator('[data-confirm-no]').click();assert.equal(calls.filter(c=>c.action==='arm').length,0);
  await page.locator('[data-close]').click();await page.getByRole('button',{name:'特別',exact:true}).click();
  assert.equal(await code.inputValue(),'AAAA-BBBB-0002');
  await page.locator('[data-arm]').click();await page.locator('[data-confirm-yes]').click();
  await page.waitForFunction(()=>document.querySelector('#funbox-sheet-account-C').classList.contains('funbox-special-reserved'));
  assert.deepEqual(calls.filter(c=>c.action==='arm').map(c=>c.body),[{confirmRealOrders:true}]);
 });
});

test('特別任務介面：無效序號顯示儲存錯誤，不出現確認、不呼叫啟用',{timeout:20000},async()=>{
 await fixture(async({page,calls})=>{
  await page.getByRole('textbox',{name:'兌換序號',exact:true}).fill('bad');await page.locator('[data-arm]').click();
  await page.locator('[data-error]').filter({hasText:'序號格式'}).waitFor();
  assert.equal(await page.locator('[data-confirmation]').isVisible(),false); assert.equal(calls.filter(c=>c.action==='arm').length,0);
 });
});
test('特別任務介面：10:00:05秒數經儲存與重新開啟仍保留',{timeout:20000},async()=>{
 await fixture(async({page,calls})=>{
  await page.locator('[data-time]').fill('2026-10-21T10:00:05');await page.locator('[data-save]').click();
  await page.waitForFunction(()=>document.querySelector('[data-arm-reason]')?.textContent.includes('已儲存，可啟用'));
  assert.equal(calls.find(c=>c.action==='save').body.startAt,'2026-10-21T10:00:05+08:00');
  await page.locator('[data-close]').click();await page.getByRole('button',{name:'特別',exact:true}).click();assert.equal(await page.locator('[data-time]').inputValue(),'2026-10-21T10:00:05');
 });
});

test('特別任務介面：開賣後顯示自動重試倒數與實際逾時端點、耗時，不誤顯示等待10點',{timeout:20000},async()=>{
 await fixture(async({page,setState})=>{
  setState({enabled:true,reserved:true,startAt:'2020-01-01T02:00:00Z',nextRetryAt:new Date(Date.now()+60000).toISOString(),
   events:[{at:new Date().toISOString(),label:'GET /cart 失敗',durationMs:5000,reason:'官方請求逾時',retryAt:new Date(Date.now()+60000).toISOString()}],
   jobs:[{id:'one',productId:'bbpr07730',status:'cart_review',codeSaved:true,error:'timeout',errorDetail:{reason:'官方請求逾時'}}]});
  await page.waitForFunction(()=>document.querySelector('#funbox-sheet-api-C').textContent.includes('秒後自動重試'));
  const logs=await page.locator('[data-logs]').textContent();assert.match(logs,/GET \/cart 失敗/);assert.match(logs,/5000ms/);assert.match(logs,/官方請求逾時/);assert.match(logs,/下次/);
  assert.match(await page.locator('.funbox-special-job small').textContent(),/官方請求逾時/);
  assert.doesNotMatch(await page.locator('#funbox-sheet-api-C').textContent(),/等待 10:00|待核對/);
 });
});
