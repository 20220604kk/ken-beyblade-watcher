import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { clearInvalidEsliteAuth, seedEsliteAuthOnce, prepareExpiredEsliteAuthBeforeNavigation, clearExpiredEsliteLocalAuthOnce } from '../src/eslite-auth-cleanup.js';

test('只清除誠品登入項目，不碰安全驗證 Cookie、其他網站或購物車儲存', async () => {
  const cleared = [], local = new Map([['auth._token.prd', 'expired'], ['cart', 'keep'], ['cf_clearance', 'keep']]);
  const state = { cookies: [
    { name: 'auth._token.prd', domain: '.eslite.com', path: '/', value: 'expired' },
    { name: 'auth._token.prd', domain: 'other.example', path: '/', value: 'keep' },
    { name: 'cf_clearance', domain: '.eslite.com', path: '/', value: 'keep' }
  ], origins: [{ origin: 'https://www.eslite.com', localStorage: [...local].map(([name, value]) => ({ name, value })) }] };
  const page = { url: () => 'https://www.eslite.com/login', evaluate: async (fn, names) =>
    vm.runInNewContext(`(${fn})(${JSON.stringify(names)})`, { location: { origin: 'https://www.eslite.com' }, localStorage: { removeItem: key => local.delete(key) } }) };
  const context = { storageState: async () => state, clearCookies: async filter => cleared.push(filter) };
  await assert.rejects(clearInvalidEsliteAuth({ page, context })); assert.equal(cleared.length, 0);
  const result = await clearInvalidEsliteAuth({ page, context, confirmedInvalid: true });
  assert.equal(result.cookies, 1); assert.equal(result.entries, 1);
  assert.deepEqual(cleared, [{ name: 'auth._token.prd', domain: '.eslite.com', path: '/' }]);
  assert.equal(local.get('cart'), 'keep'); assert.equal(local.get('cf_clearance'), 'keep'); assert.equal(local.has('auth._token.prd'), false);
  assert.equal(state.cookies[0].value, 'expired'); // Saved input is untouched until a new official login is verified.
});

test('不在誠品官網不清資料', async () => {
  await assert.rejects(clearInvalidEsliteAuth({ confirmedInvalid: true, page: { url: () => 'https://other.example/' },
    context: { storageState: async () => assert.fail('must not access') } }), /非誠品/);
});

const token = exp => 'Bearer e30.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.sig';

test('首次導航前只移除同作用域已確認過期的登入 Cookie，保留安全驗證與其他網站',async()=>{
  const events=[],cookies=[
    {name:'auth._token.prd',value:token(90),domain:'.eslite.com',path:'/'},
    {name:'auth._refresh_token.prd',value:'old-refresh',domain:'.eslite.com',path:'/'},
    {name:'auth.strategy',value:'prd',domain:'.eslite.com',path:'/'},
    {name:'cf_clearance',value:'security-keep',domain:'.eslite.com',path:'/'},
    {name:'cart',value:'cart-keep',domain:'.eslite.com',path:'/'},
    {name:'auth._token.prd',value:token(1),domain:'other.example',path:'/'},
    {name:'auth._refresh_token.prd',value:'different-scope-keep',domain:'.eslite.com',path:'/other'}];
  const state={cookies,origins:[]};let init;
  const context={storageState:async()=>state,clearCookies:async filter=>events.push(['clear',filter])};
  const page={url:()=> 'about:blank',addInitScript:async(fn,args)=>{events.push(['arm']);init={fn,args};}};
  const result=await prepareExpiredEsliteAuthBeforeNavigation({page,context,marker:'attempt-1',now:100000});
  events.push(['navigate']);
  assert.equal(result.cookies,3);assert.equal(result.localCleanupArmed,true);
  assert.deepEqual(events.map(item=>item[0]),['clear','clear','clear','arm','navigate']);
  assert.ok(events.filter(item=>item[0]==='clear').every(item=>item[1].domain==='.eslite.com'&&item[1].path==='/'&&!/cf_clearance|cart/.test(item[1].name)));
  assert.equal(init.fn,clearExpiredEsliteLocalAuthOnce);
  assert.equal(state.cookies.length,7,'不覆寫保存的舊 session 證據');
});

test('較新有效 Cookie 或儲存憑證存在時，不做首次導航前清理；401 仍交給既有核對流程',async()=>{
  for(const viaCookie of [true,false]){
    const fresh={name:'auth._token.prd',value:token(200),domain:'.eslite.com',path:'/'};
    const state={cookies:viaCookie?[fresh]:[],origins:viaCookie?[]:[{origin:'https://www.eslite.com',localStorage:[fresh]}]};
    const result=await prepareExpiredEsliteAuthBeforeNavigation({page:{url:()=> 'about:blank',addInitScript:()=>assert.fail('不能安裝清理')},context:{storageState:async()=>state,clearCookies:()=>assert.fail('不能清有效資料')},marker:'keep',now:100000});
    assert.equal(result.preservedValidToken,true);assert.equal(result.cookies,0);
  }
});

test('缺少／無法解析的 Token 不當作過期 Cookie；其他網站與沒有本次識別時拒絕操作',async()=>{
  const context={storageState:async()=>({cookies:[{name:'auth._token.prd',value:'unknown',domain:'.eslite.com'}]}),clearCookies:()=>assert.fail('未知不清')};
  const page={url:()=> 'about:blank',addInitScript:async()=>{}};
  assert.equal((await prepareExpiredEsliteAuthBeforeNavigation({page,context,marker:'unknown'})).cookies,0);
  await assert.rejects(prepareExpiredEsliteAuthBeforeNavigation({page,context}),/識別/);
  await assert.rejects(prepareExpiredEsliteAuthBeforeNavigation({page:{url:()=> 'https://other.example/'},context,marker:'x'}),/非誠品/);
});

test('初始腳本按當下真實 localStorage 判斷：只清過期、每頁一次，新登入和購物資料不受影響',()=>{
  const local=new Map([['auth._token.prd',token(90)],['auth._refresh_token.prd','old'],['cart','keep'],['cf_clearance','keep']]),session=new Map();
  const store=map=>({getItem:key=>map.has(key)?map.get(key):null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
  const env={location:{origin:'https://www.eslite.com'},localStorage:store(local),sessionStorage:store(session),atob,Date:{now:()=>100000}};
  const run=()=>vm.runInNewContext(`(${clearExpiredEsliteLocalAuthOnce})(${JSON.stringify({names:['auth._token.prd','auth._refresh_token.prd'],marker:'once'})})`,env);
  run();assert.equal(session.get('once'),'2');assert.equal(local.has('auth._token.prd'),false);assert.equal(local.get('cart'),'keep');assert.equal(local.get('cf_clearance'),'keep');
  local.set('auth._token.prd',token(200));run();assert.equal(local.get('auth._token.prd'),token(200));
  session.clear();run();assert.equal(local.get('auth._token.prd'),token(200),'即使保存檔舊，當前已登入的新 token 不清');
  session.clear();local.set('auth._token.prd','malformed');run();assert.equal(local.get('auth._token.prd'),'malformed');
  session.clear();env.location.origin='https://other.example';local.set('auth._token.prd',token(90));run();assert.equal(local.get('auth._token.prd'),token(90));assert.equal(session.size,0);
});

test('隔離 Chrome 的合成官網頁：第一個網站腳本看不到過期登入，安全 Cookie／購物資料保留；新 token 不清',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const expired=token(1),fresh=token(Math.floor(Date.now()/1000)+3600);
  for(const current of [expired,fresh]){
    const context=await browser.newContext({serviceWorkers:'block',storageState:{cookies:[{name:'auth._token.prd',value:current,domain:'.eslite.com',path:'/',httpOnly:false,secure:true,sameSite:'Lax',expires:-1},{name:'cf_clearance',value:'fixture-security-keep',domain:'.eslite.com',path:'/',secure:true,httpOnly:false,sameSite:'Lax',expires:-1}],origins:[{origin:'https://www.eslite.com',localStorage:[{name:'auth._token.prd',value:current},{name:'cart',value:'fixture-cart-keep'}]}]}});
    // All requests are fulfilled locally or aborted; no real Eslite/Google traffic.
    await context.route('**/*',async route=>{if(route.request().url()==='https://www.eslite.com/login')await route.fulfill({status:200,contentType:'text/html',body:'<body><script>document.body.dataset.initialToken=localStorage.getItem("auth._token.prd")||"empty";document.body.dataset.initialCookie=document.cookie;</script></body>'});else await route.abort();});
    const page=await context.newPage();
    await prepareExpiredEsliteAuthBeforeNavigation({page,context,marker:'fixture-once'});
    await page.goto('https://www.eslite.com/login');
    const observed=await page.evaluate(()=>({firstToken:document.body.dataset.initialToken,firstCookie:document.body.dataset.initialCookie,cart:localStorage.getItem('cart')}));
    assert.equal(observed.firstToken,current===expired?'empty':fresh);assert.equal(observed.cart,'fixture-cart-keep');
    assert.match(observed.firstCookie,/cf_clearance=fixture-security-keep/);
    if(current===expired)assert.doesNotMatch(observed.firstCookie,/auth\._token\.prd/);
    await context.close();
  }
});
test('瀏覽器匯入只做一次，官網登入後的新 token 與登出均不被舊資料覆蓋', () => {
  const local = new Map(), session = new Map();
  const store = map => ({ getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value) });
  const env = { location: { origin: 'https://www.eslite.com' }, localStorage: store(local), sessionStorage: store(session), atob,
    Date: { now: () => 100000 } };
  const args = { origin: env.location.origin, entries: [{ name: 'auth._token.prd', value: token(200) }], marker: 'once' };
  const seed = () => vm.runInNewContext(`(${seedEsliteAuthOnce})(${JSON.stringify(args)})`, env);
  seed(); assert.equal(local.get('auth._token.prd'), token(200));
  local.set('auth._token.prd', token(300)); seed(); assert.equal(local.get('auth._token.prd'), token(300));
  local.delete('auth._token.prd'); seed(); assert.equal(local.has('auth._token.prd'), false);
  session.clear(); local.set('auth._token.prd', token(400)); seed(); assert.equal(local.get('auth._token.prd'), token(400));
});
