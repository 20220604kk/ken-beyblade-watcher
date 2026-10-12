import path from 'node:path';
import { request } from 'playwright';
import { verifyEsliteApiSession } from './auto-purchase.js';
import { resolveEsliteCheckoutSelection } from './eslite-account-setup.js';
import { validateFunboxDeliveryProfile } from './funbox-checkout.js';
import { isEsliteAccountSlot } from './eslite-account-slots.js';

// Explicit, low-frequency, GET-only checks. Never logs in, clears a cart or submits.
export class PurchaseReadinessCheck {
  constructor({ dataDir, credentialStore, getConfig, isBusy = () => false, now = Date.now,
    verifyEslite = verifyEsliteApiSession, requestFactory = request }) {
    Object.assign(this, { dataDir, credentialStore, getConfig, isBusy, now, verifyEslite, requestFactory });
    this.cache = new Map(); this.pending = new Map();
  }
  async check(platform) {
    if (!['funbox', 'eslite'].includes(platform)) throw new Error('只支援 FUNBOX／誠品');
    if (this.isBusy(platform)) return { deferred: true, message: '目前正在搶購或登入驗證，稍後再檢查。', checks: [] };
    const cached = this.cache.get(platform);
    if (cached && this.now() - cached.at < 60000) return { ...cached.result, cached: true };
    if (this.pending.has(platform)) return this.pending.get(platform);
    const job = this._check(platform).then(result => { this.cache.set(platform, { at: this.now(), result }); return result; });
    this.pending.set(platform, job);
    try { return await job; } finally { this.pending.delete(platform); }
  }
  async _check(platform) {
    const store = this.credentialStore, config = this.getConfig()[platform] || {};
    const accounts = (platform === 'funbox' ? store.getFunboxAccounts() : store.getEsliteAccounts())
      .filter(account => isEsliteAccountSlot(account.slot) && account.enabled !== false && account.account && account.password);
    const checks = [];
    for (const account of accounts) {
      if (this.isBusy(platform)) return { deferred: true, checks, message: '已開始搶購，停止後續檢查，避免占用下單線路。' };
      const slot = account.slot, payment = config.accountPayments?.[slot] || config.payment || 'virtual_atm_home';
      const sessionFile = path.join(this.dataDir, 'auto-purchase', slot === 'A' ? `${platform}-session.json` : `${platform}-account-${slot.toLowerCase()}-session.json`);
      let session = 'unknown', httpStatus = null;
      if (platform === 'eslite') {
        const result = await this.verifyEslite(sessionFile, { timeoutMs: 4000, expectedAccount: account.account });
        session = result.ok ? 'valid' : result.loggedIn === false ? 'needs_login' : 'unknown'; httpStatus = result.status || null;
      } else {
        let api;
        try {
          api = await this.requestFactory.newContext({ storageState: sessionFile, timeout: 4000 });
          const response = await api.get('https://shop.funbox.com.tw/account', { timeout: 4000 });
          try {
            httpStatus = response.status(); const html = await response.text();
            session = [401, 403].includes(httpStatus) || /\/account\/login/i.test(response.url()) ? 'needs_login'
              : response.ok() && /href=["'][^"']*\/account\/logout/i.test(html) ? 'valid' : 'unknown';
          } finally { await response.dispose?.(); }
        } catch { session = 'unknown'; } finally { await api?.dispose?.(); }
      }
      let setup = 'complete', actualPayment = payment;
      try {
        if (platform === 'eslite') {
          const selection = resolveEsliteCheckoutSelection({ template: store.getEsliteCheckoutTemplate(slot), payment,
            deliveryProfile: store.getDeliveryProfile(), pickupUnavailable: !store.getPickupSetup(platform, slot) });
          if (!selection.checkoutTemplate?.checkout) throw new Error('範本缺少');
          actualPayment = selection.payment;
          if (selection.paymentFallback) setup = 'atm_fallback';
          if (actualPayment === 'virtual_atm_home') validateFunboxDeliveryProfile(store.getDeliveryProfile());
        } else if (payment === 'seven_cod') {
          if (!store.getPickupSetup(platform, slot)) throw new Error('門市缺少');
        } else validateFunboxDeliveryProfile(store.getDeliveryProfile());
      } catch { setup = 'incomplete'; }
      checks.push({ slot, session, httpStatus, setup, requestedPayment: payment, actualPayment,
        quoteVerified: false, checkedAt: new Date(this.now()).toISOString(),
        next: session === 'needs_login' ? '完成官方登入後再檢查' : session === 'unknown' ? '稍後再查，不重複登入'
          : setup === 'incomplete' ? '補齊結帳／收件資料' : '登入通過；正式付款與金額送單前再核對' });
    }
    return { platform, checkedAt: new Date(this.now()).toISOString(), checks,
      message: `登入通過 ${checks.filter(row => row.session === 'valid').length}/${checks.length}；只查登入與本地資料，未清車、未加車、未送單。` };
  }
}

export function purchaseReadinessRowsHtml(result) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const sessions = { valid: '登入通過', needs_login: '需官方登入', unknown: '暫未確認' };
  const setups = { complete: '資料已保存', atm_fallback: '使用 ATM 備援', incomplete: '資料不完整' };
  return '<p class="compact-copy">' + escape(result.message) + '</p>' + (result.checks?.length ?
    '<div class="eslite-sheet-scroll"><table class="eslite-account-table"><thead><tr><th>帳號</th><th>官方登入</th><th>結帳資料</th><th>下一步</th></tr></thead><tbody>' + result.checks.map(row =>
      '<tr><td>' + escape(row.slot) + '</td><td>' + escape(sessions[row.session]) + '</td><td>' + escape(setups[row.setup]) + '</td><td>' + escape(row.next) + '</td></tr>').join('') + '</tbody></table></div>' : '');
}

export async function checkPurchaseReadiness(platform) {
  const output = document.getElementById(platform + '-purchase-readiness');
  if (!output) return;
  if (autoPurchaseDirtyPlatforms.has(platform)) { output.textContent = '請先儲存本平台設定，再檢查。'; return; }
  const button = document.getElementById(platform + '-purchase-readiness-button');
  button.disabled = true; output.textContent = '逐帳號唯讀檢查中；不登入、不清車、不送單…';
  try { output.innerHTML = purchaseReadinessRowsHtml(await api('/auto-purchase/readiness', { platform })); }
  catch { output.textContent = '檢查暫時失敗，請稍後再試；沒有送單。'; }
  finally { button.disabled = false; }
}
export const purchaseReadinessClient = `${purchaseReadinessRowsHtml.toString()}\n${checkPurchaseReadiness.toString()}`;
