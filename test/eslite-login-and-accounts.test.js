import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEsliteAccountSlot, esliteAccountSlots, esliteSlotLabel, esliteSlotIndex } from '../src/eslite-account-slots.js';
import { classifyEsliteLogin, readEsliteLoginState, eslitePromptActuallyRendered, summarizeEsliteAuthReply } from '../src/eslite-login-state.js';
import { LocalCredentialStore } from '../src/credential-store.js';
import { EslitePurchaseAdapter, MultiAccountEslitePurchaseAdapter, normalizeAutoPurchaseConfig } from '../src/auto-purchase.js';
import { createDashboard } from '../src/dashboard.js';
import vm from 'node:vm';

test('Eslite spreadsheet slots support D through Z and AA, with safe path labels', () => {
  for (let i = 0; i < 1000; i++) assert.equal(esliteSlotIndex(esliteSlotLabel(i)), i);
  assert.equal(esliteSlotLabel(3), 'D'); assert.equal(esliteSlotLabel(26), 'AA');
  assert.deepEqual(esliteAccountSlots(['AA', 'D', 'Z', 'D']), ['A', 'B', 'C', 'D', 'Z', 'AA']);
  for (const value of ['../D', '__proto__', 'D/../A', '<script>', '', 'a']) assert.equal(isEsliteAccountSlot(value), false);
});

test('busy, transient HTTP errors and help text do not pretend to be CAPTCHA', async () => {
  assert.equal(classifyEsliteLogin({ text: '登入遇到問題可使用簡訊驗證碼' }).status, 'unknown');
  assert.equal(classifyEsliteLogin({ text: '系統忙碌，請稍後再試' }).status, 'login_busy');
  for (const httpStatus of [403, 429, 500, 502, 503, 504]) assert.equal(classifyEsliteLogin({ httpStatus }).status, 'login_busy');
  assert.equal(classifyEsliteLogin({ text: '帳號或密碼錯誤' }).status, 'needs_setup');
  assert.equal(classifyEsliteLogin({ challengeVisible: true }).status, 'human_required');
  assert.equal(classifyEsliteLogin({ text: '請輸入驗證碼', verificationInputVisible: true }).status, 'human_required');
  assert.equal(classifyEsliteLogin({ text: 'Sorry, you have been blocked' }).status, 'human_required');
  assert.equal((await readEsliteLoginState({})).status, 'unknown');
  assert.equal((await readEsliteLoginState({ locator() { throw new Error('page closed'); } })).status, 'unknown');
});

test('登入 API 診斷只保存去識別端點、HTTP 與固定原因標籤，不保存回覆或帳密 Token',()=>{
  const raw={url:'https://athena.eslite.com/api/auth/login?token=private-query',method:'POST',httpStatus:403,
    body:{token:'private-token',account:'0912345678',password:'private-password',error:{message:'reCAPTCHA validation failed for 0912345678'},detail:'private-message'}};
  const result=summarizeEsliteAuthReply(raw);
  assert.deepEqual(result,{endpoint:'/api/auth/login',httpStatus:403,replyType:'json',reasonHint:'verification_message'});
  assert.doesNotMatch(JSON.stringify(result),/private|0912345678|password|token|reCAPTCHA/);
  for(const [message,expected]of [['帳號或密碼錯誤','credentials_message'],['account locked','account_status_message'],['系統忙碌','busy_message'],['unknown error','unknown']])assert.equal(summarizeEsliteAuthReply({...raw,body:{message}}).reasonHint,expected);
  for(const patch of [{url:'https://evil.example/auth/login'},{method:'GET'},{url:'https://athena.eslite.com/api/members/me'}])assert.equal(summarizeEsliteAuthReply({...raw,...patch}),null);
  assert.equal(summarizeEsliteAuthReply({...raw,body:null}).replyType,'unavailable');
  assert.equal(summarizeEsliteAuthReply({...raw,body:{errors:['帳號或密碼錯誤']}}).reasonHint,'credentials_message');
  assert.equal(summarizeEsliteAuthReply({...raw,body:{error_messages:['reCAPTCHA failed']}}).reasonHint,'verification_message');
  assert.equal(summarizeEsliteAuthReply({...raw,body:{data:{secret:['reCAPTCHA token']}}}).reasonHint,'unknown');
  assert.doesNotMatch(classifyEsliteLogin({text:'系統忙碌'}).message,/不是人工驗證/);
});

test('驗證服務連線失敗與普通忙碌分開記錄；不宣稱密碼錯誤或要求無限解圖',async()=>{
  const text='系統忙碌 無法連至 reCAPTCHA 服務。請檢查你的網際網路連線';
  const result=await readEsliteLoginState({locator:selector=>selector==='body'?{innerText:async()=>text}:{count:async()=>0,nth:()=>null}});
  assert.equal(result.status,'login_busy');assert.equal(result.signal,'verification_connection_error');
  assert.match(result.message,/驗證服務連線失敗/);assert.match(result.message,/尚未證實帳密錯誤/);
  assert.equal(classifyEsliteLogin({text:'Could not connect to the reCAPTCHA service'}).status,'login_busy');
  assert.equal(classifyEsliteLogin({text:'reCAPTCHA Privacy Policy'}).status,'unknown');
});

test('誠品目前載入 Enterprise；真正顯示的 Enterprise 挑戰同樣暫停，預載或透明框不算',async()=>{
  let rendered=true;
  const page={locator:selector=>selector==='body'?{innerText:async()=> '登入會員'}:{count:async()=>selector.includes('/recaptcha/enterprise/bframe')?1:0,nth:()=>({isVisible:async()=>true,evaluate:async()=>rendered})}};
  assert.equal((await readEsliteLoginState(page)).status,'human_required');
  rendered=false;assert.equal((await readEsliteLoginState(page)).status,'unknown');
});

test('visible verification only; hidden verification inputs are not manual blockers', async () => {
  let visible = false;
  const page = { locator(selector) { return selector === 'body' ? { innerText: async () => '簡訊驗證碼' }
    : { count: async () => selector.startsWith('input') ? 1 : 0, nth: () => ({ isVisible: async () => visible }) }; } };
  assert.equal((await readEsliteLoginState(page)).status, 'unknown');
  visible = true; assert.equal((await readEsliteLoginState(page)).status, 'human_required');
});

test('preloaded offscreen or transparent challenge frames are not visible prompts; genuine prompts remain blocked', async () => {
  const rect = { width: 300, height: 200, top: 50, left: 20, right: 320, bottom: 250 };
  const parent = { parentElement: null, style: { display: 'block', visibility: 'visible', opacity: '1' } };
  const element = { parentElement: parent, style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => rect,
    ownerDocument: { defaultView: { innerWidth: 1000, innerHeight: 800, getComputedStyle: node => node.style } } };
  let rendered = true;
  const page = { locator: selector => selector === 'body' ? { innerText: async () => '登入會員' }
    : { count: async () => selector.startsWith('iframe') ? 1 : 0,
      nth: () => ({ isVisible: async () => true, evaluate: async fn => { rendered = fn(element); return rendered; } }) } };
  assert.equal(eslitePromptActuallyRendered(element), true);
  assert.equal((await readEsliteLoginState(page)).status, 'human_required');
  parent.style.opacity = '0';
  assert.equal((await readEsliteLoginState(page)).status, 'unknown'); assert.equal(rendered, false);
  parent.style.opacity = '1'; rect.top = -1000; rect.bottom = -800;
  assert.equal((await readEsliteLoginState(page)).status, 'unknown');
  rect.top = 50; rect.bottom = 250;
  const result = await readEsliteLoginState(page);
  assert.equal(result.status, 'human_required'); assert.equal(result.signal, 'visible_challenge');
});

test('D and AA credentials, identity and checkout templates persist encrypted independently', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-n-accounts-'));
  try {
    const store = await new LocalCredentialStore(dir).load();
    for (const slot of ['A', 'B', 'C', 'D', 'AA']) {
      await store.setEsliteAccount(slot, { account: `test-${slot}@example.test`, password: `secret-${slot}`, enabled: slot !== 'AA' });
      await store.setEsliteMemberProfile(slot, { id: slot, name: '測試會員' });
      await store.setEsliteCheckoutTemplate(slot, { checkout: { member: slot } }, { paymentMode: 'virtual_atm_home' });
    }
    await assert.rejects(store.setEsliteAccount('E', { account: 'TEST-D@example.test', password: 'other' }), /重複/);
    await assert.rejects(store.setEsliteAccount('../D', { account: 'x', password: 'x' }), /格式/);
    await store.setFunboxAccount('D', { account: 'x', password: 'x' });
    assert.equal(store.getFunboxAccount('D').account, 'x');
    const raw = await fs.readFile(store.dataFile, 'utf8'); assert.doesNotMatch(raw, /test-D|secret-|測試會員/);
    const reloaded = await new LocalCredentialStore(dir).load();
    assert.deepEqual(reloaded.getEsliteAccounts().map(x => x.slot), ['A', 'B', 'C', 'D', 'AA']);
    assert.equal(reloaded.getEsliteAccount('D').password, 'secret-D');
    assert.equal(reloaded.getEsliteAccount('AA').enabled, false);
    assert.equal(reloaded.getEsliteCheckoutTemplate('D').checkout.member, 'D');
    assert.equal(reloaded.getEsliteMemberNames().AA, '測**員');
    await reloaded.clearEsliteAccount('D');
    assert.equal(reloaded.getEsliteAccounts().some(x => x.slot === 'D'), false);
    assert.equal(reloaded.getEsliteCheckoutTemplate('D'), null);
    assert.equal(reloaded.getEsliteAccount('A').password, 'secret-A');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('dynamic payments survive normalization; new accounts default ATM', () => {
  const config = normalizeAutoPurchaseConfig({ eslite: { payment: 'seven_cod', accountPayments: { D: 'virtual_atm_home', AA: 'seven_cod', '../D': 'seven_cod' } } });
  assert.equal(config.eslite.accountPayments.D, 'virtual_atm_home');
  assert.equal(config.eslite.accountPayments.AA, 'seven_cod');
  assert.equal(config.eslite.accountPayments['../D'], undefined);
});

test('adding accounts live gives independent sessions and no more than three concurrent orders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-n-adapter-'));
  let accounts = ['A', 'B', 'C'].map(slot => ({ slot, account: `mock-${slot}`, password: 'mock', enabled: true }));
  const multi = new MultiAccountEslitePurchaseAdapter({ dataDir: dir, apiOnly: true, getAccounts: () => accounts,
    getCheckoutTemplate: () => ({ checkout: {}, paymentMode: 'virtual_atm_home' }) });
  try {
    accounts.push(...['D', 'AA'].map(slot => ({ slot, account: `mock-${slot}`, password: 'mock', enabled: true })));
    assert.deepEqual(multi.queueSlots(), ['A', 'B', 'C', 'D', 'AA']);
    assert.equal(multi.maxConcurrency, 3);
    assert.equal(new Set(Object.values(multi.adapters).map(x => x.sessionFile)).size, 5);
    assert.equal(new Set(Object.values(multi.adapters).map(x => x.profileDirectory)).size, 5);
    assert.notEqual(multi.accountIdentity('A'), multi.accountIdentity('D'));
    multi.busySlots = new Set(['A', 'B', 'C']);
    assert.match(multi.queueBlockReason('D', { payment: 'virtual_atm_home' }), /線路/);
    multi._releaseAccount('A'); assert.equal(multi.queueBlockReason('D', { payment: 'virtual_atm_home' }), '');
    multi.busySlots.clear();
    multi.adapters.D.purchase = async () => ({ status: 'ordered', orderId: 'MOCK-ONLY' });
    const result = await multi.purchase({ id: 'mock' }, { accountSlot: 'D', payment: 'virtual_atm_home' });
    assert.equal(result.accountSlot, 'D'); assert.equal(multi.busySlots.size, 0);
    accounts = accounts.filter(x => x.slot !== 'D');
    assert.equal(multi.credentialsStatus().accounts.some(x => x.slot === 'D'), false);
    assert.equal(multi.runtimeStatus().accounts.some(x => x.slot === 'D'), false);
    assert.equal(multi.queueSlots().includes('D'), false);
  } finally { await multi.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('busy cooldown clears stale human flags, backs off, and retains account data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-login-busy-'));
  const logs = [];
  const adapter = new EslitePurchaseAdapter({ dataDir: dir, apiOnly: true, log: x => logs.push(x), getCredentials: () => ({ account: 'mock', password: 'mock' }) });
  try {
    await adapter.localSessionLoad;
    adapter.manualLoginRequired = true; adapter.accountPreparationState = 'human_required';
    adapter._deferBusyLogin(new Error('系統忙碌'));
    assert.equal(adapter.manualLoginRequired, false); assert.equal(adapter.accountPreparationState, 'retry_pending');
    assert.equal(adapter.loginState, 'unknown'); assert.equal(adapter.sessionRecoveryState, 'retry_pending');
    assert.ok(adapter.sessionRecoveryAfterMs - Date.now() > 59000);
    adapter._deferBusyLogin(new Error('系統忙碌'));
    assert.ok(adapter.sessionRecoveryAfterMs - Date.now() > 119000);
    assert.match(logs[1], /120 秒/); assert.doesNotMatch(logs.join('\n'), /authorization|cookie|password/i);
    adapter.manualLoginRequired = true; adapter.accountPreparationState = 'human_required';
    adapter._markLoginReady();
    assert.equal(adapter.manualLoginRequired, false); assert.equal(adapter.accountPreparationState, 'retry_pending');
    assert.equal(adapter.loginBusyAttempts, 0);
  } finally { await adapter.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('dashboard credential API saves a disabled fourth account and reloads it without orders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-account-api-'));
  const store = await new LocalCredentialStore(dir).load();
  const server = createDashboard({ port: 0, getStatus: () => ({ autoPurchase: {} }), log: () => {},
    onSaveAutoPurchaseCredentials: body => store.setEsliteAccount(body.accountSlot, body) });
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetch(origin + '/auto-purchase/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'eslite', accountSlot: 'D', account: 'mock-fourth@example.test', password: 'mock-password', enabled: false }) });
    assert.equal(result.status, 200);
    const reloaded = await new LocalCredentialStore(dir).load();
    assert.equal(reloaded.getEsliteAccount('D').account, 'mock-fourth@example.test');
    assert.equal(reloaded.getEsliteAccount('D').enabled, false);
    const html = await (await fetch(origin)).text();
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
    assert.ok(scripts.length > 0);
    for (const script of scripts) new vm.Script(script);
    assert.match(html, /＋ 新增帳號/);
    assert.doesNotMatch(await (await fetch(origin + '/api/status')).text(), /mock-password|mock-fourth/);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});
