import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';

const targetUrl = 'https://www.amazon.co.jp/dp/B0TEST0001';
function page(url=targetUrl) {
  return {closed:false,visits:0,fronts:0,url:()=>url,isClosed(){return this.closed;},
    async goto(value){url=value;this.visits++;},async bringToFront(){this.fronts++;}};
}
function context(pages=[page('about:blank')]) {
  const ctx = new EventEmitter();
  ctx.cookies=[];ctx.closeCount=0;
  ctx.pages=()=>pages.filter(p=>!p.isClosed());
  ctx.newPage=async()=>{const p=page('about:blank');pages.push(p);return p;};
  ctx.addCookies=async cookies=>{ctx.cookies.push(...cookies);};
  ctx.close=async()=>{ctx.closeCount++;ctx.emit('close');};
  return ctx;
}
const loggedIn = () => ({url:targetUrl,asin:'B0TEST0001',title:'Test CX-20',signedIn:true,loginRequired:false,
  pageIssue:'product_unreadable',buyNowAvailable:false,priceYen:null,
  diagnostic:{httpStatus:200,hasProductTitle:true,readiness:{state:'time_limit'}}});
async function fixture(t,slot='A') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ken-amazon-login-'));
  const settings={enabled:true,targetUrl,targetSuccessCount:3,mode:'hybrid'};
  const ctx=context();let launches=0,starts=0;
  const monitor=new AmazonJpProductOrderMonitor({slot,dataDir:dir,
    state:{data:{},save:async()=>{}},getConfig:()=>settings,orderHistory:{status:()=>({})},
    persistentContextLauncher:async()=>{launches++;return ctx;}});
  monitor.start=async()=>{starts++;};
  monitor.productSnapshot=async()=>loggedIn();
  monitor.storage().status='needs_verification';monitor.storage().lastError='舊人工驗證錯誤';
  t.after(async()=>{await monitor.close();await fs.rm(dir,{recursive:true,force:true});});
  return {monitor,ctx,settings,launches:()=>launches,starts:()=>starts};
}

for(const slot of ['A','B','C']) {
  test(`${slot}: 舊視窗已消失時，檢查直接重開原 profile 並確認已保存登入；缺貨不阻擋登入`,async t=>{
    const f=await fixture(t,slot),m=f.monitor;
    m.interactive=true;m.page=null;
    const retryAfter='2099-01-01T00:00:00.000Z';m.storage().backoffUntil=retryAfter;
    const result=await m.check();
    assert.equal(result.ok,true);assert.equal(f.launches(),1);assert.equal(f.starts(),1);
    assert.equal(m.interactive,false);assert.equal(m.storage().status,'ready');
    assert.equal(m.storage().lastError,'');assert.ok(m.storage().loginVerifiedAt);
    assert.equal(m.storage().backoffUntil,retryAfter,'login must not erase official rate cooldown');
    assert.equal(f.settings.enabled,true);assert.equal(f.settings.targetSuccessCount,3);
    assert.ok(f.ctx.cookies.every(c=>['i18n-prefs','lc-main'].includes(c.name)));
  });
}

test('原登入分頁關閉後，找回同帳號新商品分頁，不關閉重開或重新導航',async t=>{
  const f=await fixture(t),m=f.monitor,original=page();original.closed=true;
  const next=page();const ctx=context([original,next]);
  m.context=ctx;m.page=original;m.interactive=true;m.headless=false;
  m.productSnapshot=async observed=>{assert.equal(observed,next);return loggedIn();};
  assert.equal((await m.completeLogin()).ok,true);
  assert.equal(f.launches(),0);assert.equal(next.visits,0);assert.equal(f.starts(),1);
});

test('開啟按鈕也會找回同 profile 的新分頁，不中斷已完成的登入',async t=>{
  const f=await fixture(t),m=f.monitor,original=page();original.closed=true;
  const next=page();m.context=context([next]);m.page=original;m.interactive=true;m.headless=false;
  await m.openLogin();
  assert.equal(m.page,next);assert.equal(next.fronts,1);assert.equal(next.visits,0);assert.equal(f.launches(),0);
});

test('真實 close 事件清除視窗狀態並停止刷新，下一次檢查使用保存的登入恢復',async t=>{
  const f=await fixture(t),m=f.monitor;
  await m.contextFor(false);m.page=page();m.interactive=true;
  f.ctx.emit('close');
  assert.equal(m.interactive,false);assert.equal(m.context,null);assert.equal(m.stopped,true);
  assert.match(m.storage().lastError,/視窗已關閉/);
  assert.equal((await m.check()).ok,true);assert.equal(f.starts(),1);
});

test('舊 context 延遲 close 不得抹掉新 context；程式主動關窗不製造登入失敗',async t=>{
  const f=await fixture(t),m=f.monitor;
  const old=await m.contextFor(false),next=context(),nextPage=page();
  m.context=next;m.page=nextPage;m.interactive=true;
  old.emit('close');
  assert.equal(m.context,next);assert.equal(m.page,nextPage);assert.equal(m.interactive,true);
  m.storage().status='ready';m.storage().lastError='';await m.closeBrowser();
  assert.equal(m.interactive,false);assert.equal(m.storage().status,'ready');assert.equal(m.storage().lastError,'');
});

for(const [name,patch] of Object.entries({captcha:{pageIssue:'human_verification'},
  loggedOut:{pageIssue:'',signedIn:false,loginRequired:true},blank:{title:'',diagnostic:{httpStatus:200,hasProductTitle:false}},
  wrongProduct:{url:'https://www.amazon.co.jp/dp/B0TEST0002'},foreign:{url:'https://evil.invalid/dp/B0TEST0001'},
  serverError:{pageIssue:'http_error',diagnostic:{httpStatus:503,hasProductTitle:true}}})) {
  test(`登入恢復仍拒絕 ${name}，不重啟購買`,async t=>{
    const f=await fixture(t),m=f.monitor;
    m.interactive=true;m.page=page();m.productSnapshot=async()=>({...loggedIn(),...patch});
    const result=await m.completeLogin();
    assert.equal(result.ok,false);assert.equal(f.starts(),0);assert.equal(m.interactive,true);
    assert.equal(m.storage().status,'needs_verification');assert.equal(m.storage().loginVerifiedAt,undefined);
  });
}

test('隔離瀏覽器：舊登入 tab 關閉、新商品 tab 已登入但缺貨，檢查成功恢復', {timeout:15_000},async t=>{
  const f=await fixture(t),m=f.monitor;
  const browser=await chromium.launch({headless:true});
  try {
    const ctx=await browser.newContext();
    await ctx.route('**/*',route=>new URL(route.request().url()).href===targetUrl
      ? route.fulfill({contentType:'text/html; charset=utf-8',body:'<span id="nav-link-accountList-nav-line-1">Hello, Test</span><h1 id="productTitle">Test CX-20</h1><p>查看所有購買選項</p>'})
      :route.abort());
    const original=await ctx.newPage(),next=await ctx.newPage();await next.goto(targetUrl);await original.close();
    m.context=ctx;m.page=original;m.interactive=true;m.headless=false;
    m.productSnapshot=AmazonJpProductOrderMonitor.prototype.productSnapshot.bind(m);
    assert.equal((await m.check()).ok,true);
    assert.equal(m.storage().lastError,'');assert.equal(m.interactive,false);assert.equal(f.starts(),1);
  } finally {await browser.close();}
});
