// Optional, removable one-shot task. Normal monitoring never imports its policy.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { load } from 'cheerio';
import { request as playwrightRequest } from 'playwright';
import { parseFunboxProductData } from '../funbox.js';
import { parseFunboxCartHtml } from '../funbox-cart.js';
import { parseFunboxCheckoutContract, buildFunboxCodPayload, submitFunboxAtmCheckout, readFunboxAtmOrder } from '../funbox-api-checkout.js';
import { validateFunboxStore, selectFunboxSevenStore } from '../funbox-api-pickup.js';
import { clientScript } from './funbox-app-redemption-ui.js';

export const PRODUCTS = Object.freeze([
  { id: 'bbpr07730', name: '黃蜂要塞' }, { id: 'bbpr07733', name: '海怪扭擺' },
  { id: 'bbpr07736', name: '雄鹿戰角' }
]);
const ORIGIN = 'https://shop.funbox.com.tw';
const START = '2026-10-21T10:00:00+08:00';
const PREFIX = '/optional-tasks/funbox-app-redemption';
const ACTIVE = new Set(['adding', 'coupon_applying', 'submitting', 'unknown', 'cart_review']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const normalizedCode = s => String(s || '').trim().toLowerCase();
const codeHash = s => crypto.createHash('sha256').update(normalizedCode(s)).digest('hex');
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); };

export function validateRows(rows, existing = []) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 20) throw fail('input', '請填入 1～20 筆任務');
  const hashes = new Set(), ids = new Set();
  return rows.map(row => {
    if (!PRODUCTS.some(p => p.id === row.productId)) throw fail('input', '只允許明天的三種 APP 兌換商品');
    const old = existing.find(item => item.id === row.id);
    const code = String(row.code || old?.code || '').trim();
    if (!/^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){2}$/.test(code)) throw fail('input', '序號格式應為四碼－四碼－四碼');
    const hash = codeHash(code);
    if (hashes.has(hash)) throw fail('input', '同一序號不能重複排入；同產品不同序號可以');
    hashes.add(hash);
    const id = old?.id || crypto.randomUUID();
    if (ids.has(id)) throw fail('input', '任務識別重複'); ids.add(id);
    return { id, productId: row.productId, code, codeHash: hash, status: 'queued' };
  });
}

export function assertRedemptionCoupon(contract, code) {
  const p = contract.props.priceValidations || {};
  const codes = (contract.props.coupons || []).map(c => normalizedCode(c.code));
  if (codes.length !== 1 || codes[0] !== normalizedCode(code) || !(Number(p.coupon_discount) > 0)
    || Number(p.bonus_consumed || 0) !== 0 || Number(p.bonus_discount || 0) !== 0) {
    throw fail('price', '伺服器未確認此序號已套用且紅利為 0，未送單');
  }
}

export function exactCart(contract, product) {
  const rows = contract.props.lineItems.filter(item => item.type !== 'gift');
  if (rows.length !== 1 || rows[0].type !== 'normal' || String(rows[0].variant_id) !== String(product.variantId)
    || Number(rows[0].quantity) !== 1 || contract.props.lineItems.some(i => i.type === 'gift')) {
    throw fail('cart', '此車不是指定單品 ×1，未送單、未清車');
  }
}

// Server-rendered forms are preferred. React-only selectors are read through
// their official props and the storefront's checkout_no_conflict form protocol.
export function selectConflictForm(html, currentUrl, product) {
  const $ = load(html), matches = [];
  for (const form of $('form[action*="checkout_no_conflict"]').toArray()) {
    const node = $(form), text = node.text();
    if (!text.includes(product.title) && !node.find(`a[href="/products/${product.id}"]`).length) continue;
    const action = new URL(node.attr('action'), currentUrl);
    const fields = Object.fromEntries(node.find('input[name]').toArray().map(n => [$(n).attr('name'), $(n).attr('value') || '']));
    if (action.origin === ORIGIN && /^\/carts\/[a-z0-9]{32}\/checkout_no_conflict$/i.test(action.pathname) && fields.cart_hash && fields.authenticity_token) matches.push({ url: action.href, form: fields });
  }
  if (matches.length === 1) return matches[0];
  for (const node of $('[data-react-props]').toArray()) {
    let props; try { props = JSON.parse($(node).attr('data-react-props')); } catch { continue; }
    if (!props.cart?.token || !props.conflictCartsGroups) continue;
    const found = [];
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      for (const [hash, group] of Object.entries(value)) {
        if (Array.isArray(group) && Array.isArray(group[0]) && Array.isArray(group[1])) {
          const items = group[0];
          const variant = items[0]?.variant_id ?? String(items[0]?.id || '').match(/^(\d+)_normal_\d*$/)?.[1];
          if (items.length === 1 && String(variant) === String(product.variantId) && Number(items[0].quantity) === 1) found.push(hash);
        } else visit(group);
      }
    }
    visit(props.conflictCartsGroups);
    const csrf = $('meta[name="csrf-token"]').attr('content');
    if (found.length === 1 && csrf && /^[a-z0-9]{32}$/i.test(props.cart.token)) return { url: ORIGIN + '/carts/' + props.cart.token + '/checkout_no_conflict', form: { cart_hash: found[0], authenticity_token: csrf,
      ...(props.selectedTemperatureType?.type ? { selected_temperature: props.selectedTemperatureType.type } : {}) } };
  }
  throw fail('cart', '多購物車尚未找到唯一的指定商品車；保留現場，不猜選其他商品');
}

export class FunboxAppRedemption {
  constructor({ dataDir, state, credentials, multi, coordinator, applyRuntimeConfig = async () => {}, apiFactory = options => playwrightRequest.newContext(options), now = Date.now, log = () => {}, onProduct = null, waitFor = ms=>new Promise(resolve=>setTimeout(resolve,ms)) }) {
    Object.assign(this, { dataDir, state, credentials, multi, coordinator, applyRuntimeConfig, apiFactory, now, log, onProduct, waitFor });
    this.directory = path.join(dataDir, 'optional-tasks', 'funbox-app-redemption');
    this.data = { version: 1, enabled: false, startAt: START, jobs: [], events: [] };
    this.codes = []; this.timer = null; this.warmTimer = null; this.running = null; this.stopping = false; this.saveTail = Promise.resolve();
    this.csrf = crypto.randomBytes(24).toString('hex');
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try { this.data = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { this.key = await fs.readFile(path.join(this.directory, '.key')); } catch (e) { if (e.code !== 'ENOENT') throw e; this.key = crypto.randomBytes(32); await fs.writeFile(path.join(this.directory, '.key'), this.key, { mode: 0o600, flag: 'wx' }); }
    try {
      const box = JSON.parse(await fs.readFile(path.join(this.directory, 'queue.enc.json'), 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(box.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      this.codes = JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString());
    } catch (e) { if (e.code !== 'ENOENT') throw fail('storage', '特別任務序號檔無法解密，已停止載入'); }
    for (const job of this.data.jobs) if (ACTIVE.has(job.status)) {
      job.status = job.intent ? 'unknown' : 'cart_review';
      this.data.enabled = Boolean(this.data.continuousRetry)&&this.data.enabled;
    }
    if (this.isReserved('C')) await this.reservation(true);
    await this.save(); this.schedule(); return this;
  }
  async reservation(active) {
    const storage = this.state.data.commerce.autoPurchase;
    storage.externalAccountReservations ||= {};
    if (active) storage.externalAccountReservations.C = { taskKind: 'funbox_app_redemption', at: new Date(this.now()).toISOString(), reason: '方爸APP兌換／特別任務' };
    else delete storage.externalAccountReservations.C;
    await this.state.writeSnapshot();
  }
  isReserved(slot) { return slot === 'C' && (this.data.reserved || this.data.enabled || Boolean(this.running) || this.data.jobs.some(j => ACTIVE.has(j.status))); }
  status() {
    return { name: '方爸APP兌換', disabled: Boolean(this.disabled), enabled: this.data.enabled, reserved: this.isReserved('C'), running: Boolean(this.running), startAt: this.data.startAt,
      nextRetryAt: this.data.nextRetryAt, continuousRetry: Boolean(this.data.continuousRetry), accountSlot: 'C', exactTotal: 555, payment: 'seven_cod', protocolVerified: this.data.jobs.some(j => j.status === 'ordered'),
      jobs: this.data.jobs.map(({ id, productId, status, orderNumber, error, amount, steps = [] }) => ({ id, productId, productName: PRODUCTS.find(p => p.id === productId)?.name,
        status, orderNumber, error, amount, codeSaved: this.codes.some(c => c.id === id), steps })), events: this.data.events.slice(-80), csrf: this.csrf };
  }
  editableStatus() {
    const status = this.status();
    return { ...status, jobs: status.jobs.map(job => ({ ...job, code: this.codes.find(c => c.id === job.id)?.code || '' })) };
  }
  save() {
    const text = JSON.stringify(this.data, null, 2);
    this.saveTail = this.saveTail.catch(() => {}).then(async () => {
      const file = path.join(this.directory, 'state.json');
      await fs.writeFile(file + '.tmp', text, { mode: 0o600 }); await fs.rename(file + '.tmp', file);
    }); return this.saveTail;
  }
  async event(label, job, extra = {}) {
    const item = { at: new Date(this.now()).toISOString(), label, specialTask: true, ...(job ? { jobId: job.id, productName: PRODUCTS.find(p => p.id === job.productId)?.name } : {}), ...extra };
    this.data.events.push(item); this.data.events = this.data.events.slice(-500);
    if (job) { job.steps ||= []; job.steps.push(item); }
    this.log('【特別任務・C】' + (item.productName ? item.productName + '｜' : '') + label);
    await this.save(); return item;
  }
  async configure(body) {
    if (this.isReserved('C')) throw fail('busy', '先停止特別任務並核對未決交易，才能修改序號與排序');
    if (this.data.jobs.some(j => j.status === 'ordered')) throw fail('completed', '本次已有正式訂單，保留紀錄；請勿重建同一批序號');
    const rows = validateRows(body.rows, this.codes);
    const startAt = new Date(body.startAt || START);
    if (!Number.isFinite(startAt.getTime()) || startAt.getTime() < new Date(START).getTime()) throw fail('input', '啟動時間不得早於 10/21 10:00（台灣時間）');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(rows)), cipher.final()]);
    const file = path.join(this.directory, 'queue.enc.json');
    await fs.writeFile(file + '.tmp', JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    await fs.rename(file + '.tmp', file); this.codes = rows;
    this.data.jobs = rows.map(({ id, productId, codeHash }) => ({ id, productId, codeHash, status: 'queued', steps: [] }));
    this.data.startAt = startAt.toISOString(); await this.event('已儲存產品、加密序號與順序'); return this.status();
  }
  async arm(body) {
    if (this.disabled) throw fail('input', '此外掛已移除入口，請重新安裝後使用');
    if (body.confirmRealOrders !== true) throw fail('confirmation', '請確認啟用特別任務：帳號 C，單品 7-11 取貨付款，每單 555 元');
    if (!this.codes.length || !this.data.jobs.length) throw fail('input', '請先填寫並儲存序號');
    if (this.data.jobs.some(j => ACTIVE.has(j.status))) throw fail('hold', '有未決購物車／訂單，先唯讀查單');
    if (!this.data.jobs.some(j => j.status === 'queued') || this.data.jobs.some(j => !['queued','ordered','skipped'].includes(j.status))) throw fail('completed', '本批沒有可安全接續的待執行項目');
    const account = this.credentials.getFunboxAccount('C');
    if (!account.account || !account.password || account.enabled === false) throw fail('account', '帳號 C 尚未設定或啟用');
    const adapter = this.multi.adapters.C;
    if (!adapter || adapter.activePurchaseHold() || adapter.accountBrowser || adapter.cartActionUncertain || this.multi.accountPurchaseTails.has('C')) throw fail('busy', '帳號 C 正忙碌或有待核對訂單，未啟用');
    this.data.accountIdentity = this.multi.accountIdentity('C');
    this.data.enabled = true; this.data.reserved = true; this.stopping = false;
    await this.reservation(true);
    await this.event('啟用特別任務：C 專用，A／B 維持一般流程');
    await this.applyRuntimeConfig(); this.schedule(); return this.status();
  }
  async reschedule(body) {
    if(this.running || this.data.jobs.some(j=>ACTIVE.has(j.status)) || this.data.jobs.some(j=>j.status==='ordered'))throw fail('busy','目前有執行或已送單紀錄，不能變更時間');
    const at=Date.parse(body.startAt);
    if(!Number.isFinite(at)||at<Date.parse(START)||at<=this.now())throw fail('input','開始時間必須是開放之後的未來時間');
    this.data.startAt=new Date(at).toISOString();if(body.continuousRetry===true)this.data.continuousRetry=true;await this.event('已更新特別任務開始時間（保留原序號、順序與啟用狀態）');this.schedule();return this.status();
  }
  schedule() {
    clearTimeout(this.timer);
    clearTimeout(this.warmTimer);
    if (!this.data.enabled || this.stopping || this.running || !this.data.jobs.some(j => j.status === 'queued' || (this.data.continuousRetry && ACTIVE.has(j.status))) || (!this.data.continuousRetry && this.data.jobs.some(j => ACTIVE.has(j.status)))) return;
    const delay = Math.max(0, Math.max(Date.parse(this.data.startAt), Date.parse(this.data.nextRetryAt || '') || 0) - this.now());
    const warmDelay = Date.parse(this.data.startAt) - this.now() - 60000;
    if (warmDelay > 0) {
      this.warmTimer = setTimeout(() => { void this.preflight({ allowLogin: true }).catch(() => this.event('C 預熱檢查未完成，請查看登入狀態').catch(() => {})); }, Math.min(warmDelay, 2147483647));
      this.warmTimer.unref?.();
    }
    this.timer = setTimeout(() => { this.running = this.run().catch(async () => { this.data.enabled = Boolean(this.data.continuousRetry)&&!this.stopping;this.data.nextRetryAt=new Date(this.now()+60000).toISOString(); await this.event(this.data.enabled?'特別任務暫時失敗，60秒後自動重新核對':'特別任務停止：請查看逐筆狀態').catch(() => { this.data.enabled=false;this.log('【特別任務・C】紀錄保存失敗；停止此任務，保留帳號專用狀態'); }); }).finally(() => { this.running = null; this.schedule(); }); }, Math.min(delay, 2147483647));
    this.timer.unref?.();
  }
  async stop() {
    this.stopping = true; this.data.enabled = false; clearTimeout(this.timer); clearTimeout(this.warmTimer);
    await this.event(this.running ? '停止派新單；等待目前請求及查單完成' : '已停用特別任務');
    if (!this.running && !this.data.jobs.some(j => ACTIVE.has(j.status))) { this.data.reserved = false; await this.save(); await this.reservation(false); }
    await this.applyRuntimeConfig(); return this.status();
  }
  async withLock(work) {
    const previous = this.multi.accountPurchaseTails.get('C') || Promise.resolve();
    let release; const held = new Promise(resolve => { release = resolve; });
    this.multi.accountPurchaseTails.set('C', held);
    try { await previous.catch(() => {}); return await work(); }
    finally { release(); if (this.multi.accountPurchaseTails.get('C') === held) this.multi.accountPurchaseTails.delete('C'); }
  }
  async context() {
    const api = await this.apiFactory({ storageState: path.join(this.dataDir, 'auto-purchase', 'funbox-account-c-session.json'), timeout: 45000 });
    return api;
  }
  async checked(api, method, url, options = {}, job) {
    if (Date.parse(this.data.nextRetryAt || '') > this.now()) throw fail('cooldown', '網站冷卻時間內不再發送新請求');
    const started = this.now();
    const r = await api[method](url, { timeout: method === 'post' ? 45000 : 12000, ...options });
    const status = r.status();
    if ([429, 503].includes(status)) {
      const retry = r.headers()['retry-after'];
      const until = /^\d+$/.test(retry || '') ? this.now() + Number(retry) * 1000 : Date.parse(retry || '');
      this.data.nextRetryAt = new Date(Math.max(this.now() + 60000, until || 0)).toISOString();
      await this.event('網站限流／忙碌，遵守冷卻時間', job, { httpStatus: status, retryAt: this.data.nextRetryAt });
    }
    await this.event(method.toUpperCase() + ' ' + new URL(url, ORIGIN).pathname.replace(/[a-z0-9]{32}/ig, '<token>'), job, { httpStatus: status, durationMs: this.now() - started });
    return r;
  }
  async member(api, { allowLogin = false } = {}) {
    const r = await this.checked(api, 'get', ORIGIN + '/account', { timeout: 10000 });
    const html = await r.text(), $ = load(html); await r.dispose();
    if (!r.ok() || /\/account\/login/.test(r.url()) || !$('a[href*="/account/logout"]').length) {
      if (allowLogin && /\/account\/login/.test(r.url()) && typeof this.multi.adapters.C?._requestLogin === 'function') {
        await this.multi.adapters.C._requestLogin({ request: api, storageState: ({ indexedDB, ...options } = {}) => api.storageState(options) }, { persist: true });
        return this.member(api);
      }
      throw fail('login', '帳號 C 未確認登入；請使用原有登入按鈕');
    }
  }
  async cart(api, product, job) {
    const urlToRead = job?.cartUrl && /^https:\/\/shop\.funbox\.com\.tw\/carts\/[a-z0-9]{32}\/?$/i.test(job.cartUrl) ? job.cartUrl : ORIGIN + '/cart';
    let r = await this.checked(api, 'get', urlToRead, {timeout:15000}, job);
    if (!r.ok()) { await r.dispose(); throw fail('temporary', '購物車讀取暫時失敗'); }
    let html = await r.text(), url = r.url(); await r.dispose();
    if (/\/account\/index\/?$/.test(new URL(url).pathname) && load(html)('a[href*="/account/logout"]').length) return null;
    if (/\/cart_conflict\/?$/.test(new URL(url).pathname) || !load(html)('#checkout-v3').length) {
      const selected = selectConflictForm(html, url, product);
      r = await this.checked(api, 'post', selected.url, { form: selected.form }, job);
      html = await r.text(); url = r.url(); await r.dispose();
    }
    const contract = parseFunboxCheckoutContract(html, url); exactCart(contract, product);
    return { ...contract, snapshot: parseFunboxCartHtml(html, url) };
  }
  async preflight({ allowLogin = false } = {}) {
    if (this.running || this.multi.accountPurchaseTails.has('C') || this.multi.adapters.C?.accountBrowser) throw fail('busy', 'C 正在執行，暫不插入登入檢查');
    return this.withLock(async () => {
      const api = await this.context();
      try {
        await this.member(api, { allowLogin });
        const profile = this.credentials.getPickupProfile(), setup = this.credentials.getPickupSetup('funbox', 'C');
        if (!profile.fullName || !/^09\d{8}$/.test(profile.phone || '')) throw fail('pickup', '收件姓名／手機未完整設定');
        if (setup?.storeInfo) validateFunboxStore(setup.storeInfo, profile);
        await this.event('唯讀檢查完成：C 登入有效；門市' + (setup?.storeInfo ? '有已核對資料' : '送單前需官方選店') + '；沒有輸入序號或送單');
        return this.status();
      } finally { await api.dispose(); }
    });
  }
  async orders(api) {
    const r = await this.checked(api, 'get', ORIGIN + '/account/orders', { timeout: 12000 });
    const $ = load(await r.text()); await r.dispose();
    if (!r.ok() || !$('a[href*="/account/logout"]').length) throw fail('orders', '帳號訂單列表未確認，禁止送單');
    return new Set($('a[href]').toArray().map(n => $(n).attr('href')?.match(/^\/account\/orders\/([a-z0-9]{32})\/?$/i)?.[1]).filter(Boolean));
  }
  async publish(job, result) {
    const storage = this.state.data.commerce.autoPurchase;
    const key = 'funbox:special:' + job.id;
    const record = { ...(storage.records[key] || {}), ...result, platform: 'funbox', accountSlot: 'C', accountIdentity: this.data.accountIdentity,
      specialTask: true, taskKind: 'funbox_app_redemption', taskLabel: '方爸APP兌換／特別任務', taskId: 'funbox-special-' + job.id,
      product: job.product, quantity: 1, payment: 'seven_cod', steps: job.steps, startedAt: job.startedAt, completedAt: new Date(this.now()).toISOString() };
    storage.records[key] = record;
    storage.recent = [record, ...storage.recent.filter(r => r.taskId !== record.taskId)].slice(0, 100);
    job.status = result.status === 'ordered' ? 'ordered' : 'unknown';
    job.orderNumber = result.orderNumber; job.amount = result.amount;
    if (result.status === 'ordered') {
      const ledger = this.coordinator?._ledger(); ledger?.settle(record.taskId, record);
    }
    await this.state.writeSnapshot(); await this.save();
  }
  async redeem(api, job) {
    job.startedAt ||= new Date(this.now()).toISOString();
    const productUrl = ORIGIN + '/products/' + job.productId;
    const response = await this.checked(api, 'get', productUrl + '.json', {}, job);
    if (response.status() === 404) { await response.dispose(); throw fail('not_published', '商品尚未上架，等待下輪讀取'); }
    if (!response.ok()) { await response.dispose(); throw fail('temporary', '商品讀取暫時失敗'); }
    const raw = await response.json(); await response.dispose();
    const [product] = parseFunboxProductData([{ ...raw, url: productUrl }], productUrl);
    if (!product || !/APP兌換/.test(product.title) || !product.variantId) throw fail('product', '商品身份尚未確認');
    if(this.onProduct)void Promise.resolve(this.onProduct(product)).catch(()=>this.log('APP 上架通知未完成，請查看活動紀錄'));
    if (!(product.stock > 0)) {
      if(this.now()<Date.parse(START)+30000)throw fail('not_published','開放初期庫存尚未就緒，至少隔一秒重新核對');
      if(product.stock===null||product.stock===undefined)throw fail('temporary','庫存資料不完整，重新核對');
      throw fail('sold_out', '官方明確無庫存，略過本筆');
    }
    job.product = product;
    let contract = await this.cart(api, product, job);
    if (contract && !(this.data.continuousRetry && job.addAttempted)) throw fail('cart', 'C 購物車已有商品；不混車、不刪既有商品');
    if (this.stopping) throw fail('stopped', '已停止，未加車');
    if(!contract){
    if(this.data.continuousRetry&&job.addAttempted){job.emptyReads=(job.emptyReads||0)+1;if(job.emptyReads<3)throw fail('temporary','加車回應不明，先連續重讀空車，不重複加車');}
    job.status = 'adding'; await this.save();
    job.addAttempted=true;await this.save();
    let addUncertain = false;
    try {
      const add = await this.checked(api, 'post', ORIGIN + '/cart/add', { form: { id: product.variantId, quantity: '1', type: 'normal' }, headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } }, job);
      const ok = add.ok(); await add.dispose(); if (!ok) addUncertain = true;
    } catch { addUncertain = true; }
    contract = await this.cart(api, product, job);
    if (!contract) throw fail('cart', addUncertain ? '加車結果不明；保留 C，不重加' : '加車後未找到目標商品');
    }
    job.cartUrl = contract.cartUrl; job.variantId = product.variantId; await this.save();
    if (this.stopping) throw fail('cart', '已停止派單；本筆已加車，保留現場');
    const headers = { 'X-CSRF-Token': contract.csrfToken, 'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: contract.cartUrl, Accept: 'application/json' };
    const code = this.codes.find(c => c.id === job.id)?.code;
    if (!code) throw fail('code', '未找到加密序號');
    const search = await this.checked(api, 'post', contract.cartUrl + '/coupons', { data: { code: normalizedCode(code) }, headers }, job);
    const coupon = await search.json(); const searchOk = search.ok(); await search.dispose();
    if (!searchOk) throw fail('coupon', '序號查詢未完成，保留購物車供核對');
    if (coupon.err_msg || coupon.errMsg) {
      if(this.data.continuousRetry)throw fail('temporary','官方暫未接受序號；保留本筆商品，退避後重新確認');
      await this.removeOwned(api, contract, job); throw fail('invalid_code', '官方明確回覆序號不可用，已只移除本筆商品');
    }
    if (normalizedCode(coupon.code) !== normalizedCode(code)) throw fail('coupon', '序號查詢回覆不符，未送單');
    job.status = 'coupon_applying'; await this.save();
    try {
      const apply = await this.checked(api, 'post', contract.cartUrl + '/apply_coupon', { data: { codes: [normalizedCode(code)], manually: true,
        coupon_free_shipping: 'false', apply_maximun_bonus: false, bonus_used: 0, shipping_fee: 0, shipping: {}, cart_type: 'order' }, headers }, job);
      await apply.text(); await apply.dispose();
    } catch { await this.event('序號套用回應不明，只重讀本車，不重送套用請求', job); }
    contract = await this.cart(api,product,job);if(!contract)throw fail('coupon','套用後暫未讀到本車，重新核對');
    const resetBonus = async () => {
      const r = await this.checked(api, 'post', contract.cartUrl + '/apply_bonus', { form: { bonus_used: '0', cart_type: 'order', apply_maximun_bonus: 'false' }, headers }, job);
      const body = await r.json(), ok = r.ok(); await r.dispose(); if (!ok || body.bonus_used !== 0) throw fail('bonus', '官網未確認紅利 0 點');
    };
    await resetBonus();
    contract = await this.waitForCoupon(api,product,job,code);
    const optionResponse = await this.checked(api, 'get', contract.cartUrl + '/shipping_rates_and_payment_method_items', { params: { bonus_used: 0, cart_type: 'order' }, headers }, job);
    const choices = await optionResponse.json(), optionsOk = optionResponse.ok(); await optionResponse.dispose();
    if (!optionsOk) throw fail('payment', '付款選項未讀取完成');
    const profile = this.credentials.getPickupProfile(), setup = this.credentials.getPickupSetup('funbox', 'C');
    let store = contract.props.storeInfo || setup?.storeInfo;
    if (store) store = validateFunboxStore(store, profile);
    else store = await selectFunboxSevenStore({ api, contract, profile, onStep: step => this.event(step.label, job, { state: step.state }) });
    await resetBonus(); contract = await this.cart(api, product, job); assertRedemptionCoupon(contract, code); exactCart(contract, product);
    const account = this.credentials.getFunboxAccount('C').account.trim().toLowerCase();
    if (account.includes('@') && contract.props.cart.customer.email.toLowerCase() !== account) throw fail('identity', '官網會員與 C 帳號不符');
    const prepared = { ...buildFunboxCodPayload(contract, choices, profile, store, 555), contract, headers, payment: 'seven_cod' };
    if (prepared.total !== 555) throw fail('price', '7-11 取貨付款的訂單總額必須為 555 元，未送單');
    job.store = store; job.total = 555;
    await this.event('特別任務金額確認：序號已套用／總額 555／7-11 取貨付款／紅利 0', job);
    job.baseline = [...await this.orders(api)];
    if (this.stopping) throw fail('cart', '已停止，未送出訂單；本車保留');
    let result;
    result = await submitFunboxAtmCheckout({ api: { post: (url, options) => this.checked(api, 'post', url, options, job) }, prepared, maxAttempts: 1, onStep: step => this.event(step.label, job, { state: step.state, httpStatus: step.httpStatus }),
      beforeSubmit: async () => {
        if (this.stopping) throw fail('stopped', '已停止，未送單');
        job.status = 'submitting'; job.intent = { total: 555, quantity: 1, payment: 'seven_cod', codeHash: job.codeHash, at: new Date(this.now()).toISOString() };
        this.coordinator?._ledger().reserve('funbox-special-' + job.id, 'funbox', this.data.accountIdentity, [{ id: job.productId, quantity: 1 }], job.startedAt);
        await this.save();
        await this.publish(job, { status: 'processing', submitIntent: job.intent });
        job.status = 'submitting'; await this.save();
      } });
    job.resultUrl = result.status === 'order_created_pending_details' ? result.resultUrl : undefined; job.status = 'unknown'; await this.save();
    await this.publish(job, { ...result, status: 'submitted_unconfirmed' });
    await this.reconcileJob(api, job);
  }
  async removeOwned(api, contract, job) {
    if (job.intent) throw fail('hold', '已有送單意圖，禁止移除商品');
    const row = contract.snapshot.items[0];
    if (contract.snapshot.items.length !== 1 || row.variantId !== job.variantId || row.quantity !== 1) throw fail('cart', '商品移除核對不符');
    const r = await this.checked(api, 'post', contract.cartUrl + '/update_line_item', { data: { updates: { [row.itemKey]: 0 }, is_remote: false, apply_maximun_bonus: false, bonus_used: 0 },
      headers: { 'X-CSRF-Token': contract.csrfToken, 'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: contract.cartUrl } }, job);
    const ok = r.ok(); await r.dispose(); if (!ok || await this.cart(api, job.product, job)) throw fail('cart', '本筆商品移除尚未確認');
    job.cartUrl = null;
  }
  async waitForCoupon(api,product,job,code){
    let last;
    for(let attempt=0;attempt<(this.data.continuousRetry?6:1);attempt++){
      try{const c=await this.cart(api,product,job);if(!c)throw fail('coupon','套用後無法讀取本車');assertRedemptionCoupon(c,code);return c;}
      catch(error){last=error;if(error.code==='cooldown'||this.stopping)throw error;if(attempt<5&&this.data.continuousRetry){await this.event('等待官方優惠與價格重新計算；先重讀、不重送訂單',job);await this.waitFor(Math.min(1000*(attempt+1),3000));}}
    }throw last;
  }
  async reconcileJob(api, job) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let resultUrl = job.resultUrl;
        if (!resultUrl) {
          const current = await this.orders(api), fresh = [...current].filter(t => !job.baseline?.includes(t));
          if (fresh.length !== 1) throw fail('unknown', '尚無唯一新增訂單');
          resultUrl = ORIGIN + '/account/orders/' + fresh[0];
        }
        const receipt = await readFunboxAtmOrder({ api: { get: (url, options) => this.checked(api, 'get', url, options, job) }, resultUrl, expected: [{ product: job.product, quantity: 1 }], total: 555, payment: 'seven_cod', store: job.store, timeoutMs: 12000,
          onStep: step => this.event('特別任務：' + step.label, job, { state: step.state }) });
        const { html, ...safe } = receipt;
        await this.publish(job, { ...safe, status: 'ordered', specialTask: true });
        await this.event('特別任務訂單成立，已核對正式單號、商品、數量、門市與 555 元', job, { orderNumber: safe.orderNumber });
        return true;
      } catch { if (attempt === 0) await this.waitFor(1000); }
    }
    job.status = 'unknown'; this.data.enabled = Boolean(this.data.continuousRetry)&&!this.stopping;
    if(this.data.enabled)this.data.nextRetryAt=new Date(this.now()+2000).toISOString();
    await this.publish(job, { status: 'submitted_unconfirmed', detail: '特別任務送單不明，只查單、不重送、不清車' });
    return false;
  }
  async run() {
    if (this.now() < Date.parse(this.data.startAt) || !this.data.enabled || Date.parse(this.data.nextRetryAt || '') > this.now()) return;
    if (!this.data.continuousRetry && this.now() > Date.parse(this.data.startAt) + 30 * 60000) { this.data.enabled = false; await this.event('兌換執行時段已結束，未執行項目保留；C 保持專用至手動停用'); return; }
    return this.withLock(async () => {
      const api = await this.context();
      try {
        await this.member(api, { allowLogin: true });
        for (const job of this.data.jobs) {
          if (!this.data.enabled || this.stopping || (!this.data.continuousRetry&&ACTIVE.has(job.status))) break;
          if(this.data.continuousRetry&&job.status==='unknown'){if(!await this.reconcileJob(api,job))break;}
          if(this.data.continuousRetry&&['adding','coupon_applying','cart_review'].includes(job.status))job.status='queued';
          if (job.status !== 'queued') continue;
          if (this.multi.accountIdentity('C') !== this.data.accountIdentity) throw fail('identity', '帳號 C 已變更');
          try { await this.redeem(api, job); }
          catch (error) {
            job.error = error.code || error.purchaseStatus || 'unexpected';
            if (job.intent) { job.status = 'unknown'; this.data.enabled = Boolean(this.data.continuousRetry)&&!this.stopping;if(this.data.enabled)this.data.nextRetryAt=new Date(this.now()+2000).toISOString(); await this.publish(job, { status: 'submitted_unconfirmed', detail: '特別任務送單後未確認，保留帳號保護並自動查單' }); }
            else if (error.code==='sold_out'||(!this.data.continuousRetry&&error.code==='invalid_code')) job.status = 'skipped';
            else if(this.data.continuousRetry){job.status=job.addAttempted?'cart_review':'queued';job.retryCount=(job.retryCount||0)+1;const pause=error.code==='not_published'?1000:Math.min(1000*Math.pow(2,Math.min(job.retryCount-1,3)),8000);this.data.nextRetryAt=new Date(Math.max(this.now()+pause,Date.parse(this.data.nextRetryAt||'')||0)).toISOString();await this.event('本筆自動退避後重新核對：'+job.error,job);break;}
            else if (['not_published', 'temporary','cooldown'].includes(error.code) && !job.cartUrl && job.status === 'queued') {
              this.data.nextRetryAt = new Date(Math.max(this.now() + 1000, Date.parse(this.data.nextRetryAt || '') || 0)).toISOString();
              await this.event(error.message, job); break;
            } else { job.status = 'cart_review'; this.data.enabled = false; }
            await this.event('特別任務本筆停止：' + job.error, job);
          }
          await this.save();
          if (this.data.jobs.some(j => ACTIVE.has(j.status))) break;
        }
        if (this.data.jobs.every(j => ['ordered', 'skipped'].includes(j.status))) { this.data.enabled = false; await this.event('本批特別任務全部結束；C 保持專用，手動停用後才恢復一般派單'); }
      } finally { await api.dispose(); if (this.stopping && !this.data.jobs.some(j => ACTIVE.has(j.status))) { this.data.reserved = false; await this.save(); await this.reservation(false); } await this.applyRuntimeConfig(); }
    });
  }
  async reconcile() {
    if (this.running) throw fail('busy', '目前請求仍在執行，請稍後查單');
    return this.withLock(async () => { const api = await this.context(); try { await this.member(api); for (const job of this.data.jobs.filter(j => j.status === 'unknown')) await this.reconcileJob(api, job); return this.status(); } finally { await api.dispose(); await this.applyRuntimeConfig(); } });
  }
  async discardCart(body) {
    if (body.confirmRemoveOwnItem !== true) throw fail('confirmation', '請確認只移除本特別任務、尚未送單的商品');
    if (this.running) throw fail('busy', '請求仍在進行中，請先停用並等待');
    const job = this.data.jobs.find(j => j.id === body.id && j.status === 'cart_review');
    if (!job || job.intent || !job.product) throw fail('hold', '沒有可安全移除的未送單商品；未知訂單不能清車');
    return this.withLock(async () => { const api = await this.context(); try {
      await this.member(api); const contract = await this.cart(api, job.product, job);
      if (contract) await this.removeOwned(api, contract, job);
      job.status = 'skipped'; await this.event('使用者移除本特別任務商品，未送單；紀錄保留', job);
      return this.status();
    } finally { await api.dispose(); } });
  }
  async removeFeature(body) {
    if (body.confirmRemoveFeature !== true) throw fail('confirmation', '請確認移除特別任務入口；訂單與加密資料仍保留本機');
    if (this.isReserved('C')) throw fail('hold', '先停用任務並處理未決交易，才能移除入口');
    clearTimeout(this.timer); clearTimeout(this.warmTimer); this.disabled = true;
    await fs.writeFile(path.join(this.directory, 'disabled.flag'), 'disabled\n', { mode: 0o600 });
    await this.event('已移除特別任務入口；資料保留，不影響一般派單');
    return { ...this.status(), disabled: true };
  }
  async close() { this.stopping = true; clearTimeout(this.timer); clearTimeout(this.warmTimer); if (this.running) await this.running; await this.saveTail; }
  async handle(req, res) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (!pathname.startsWith(PREFIX)) return false;
    if (req.method === 'GET' && pathname === PREFIX + '/client.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(clientScript); return true; }
    if (req.method === 'GET' && pathname === PREFIX + '/status') { json(res, 200, this.status()); return true; }
    if (req.method !== 'POST') { json(res, 404, { error: '不存在的特別任務操作' }); return true; }
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || req.headers.origin !== 'http://' + req.headers.host || req.headers['x-task-csrf'] !== this.csrf) { json(res, 403, { error: '只接受本機控制台的特別任務操作' }); return true; }
    try {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 20000) throw fail('input', '資料過長'); }
      const body = JSON.parse(text || '{}');
      if (this.disabled) throw fail('input', '特別任務入口已移除');
      const action = pathname.slice(PREFIX.length + 1);
      const result = action === 'edit' ? this.editableStatus() : action === 'reschedule' ? await this.reschedule(body) : action === 'save' ? await this.configure(body) : action === 'arm' ? await this.arm(body) : action === 'stop' ? await this.stop() : action === 'preflight' ? await this.preflight() : action === 'reconcile' ? await this.reconcile() : action === 'discard-cart' ? await this.discardCart(body) : action === 'remove-feature' ? await this.removeFeature(body) : null;
      if (!result) throw fail('input', '不存在的特別任務操作'); json(res, 200, result);
    } catch (e) { json(res, 400, { error: ['input','busy','hold','completed','confirmation','account','price','cart','pickup','login','storage'].includes(e.code) ? e.message : '特別任務操作未完成；請查看本機狀態', code: e.code || 'failed' }); }
    return true;
  }
}
