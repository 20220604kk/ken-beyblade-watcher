import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isEsliteAccountSlot, esliteAccountSlots } from './eslite-account-slots.js';
import { pickupSetupMatches } from './pickup-setup.js';

const PLATFORMS = new Set(['funbox', 'eslite', 'momo', 'kingstone']);

export class LocalCredentialStore {
  constructor(dataDir) {
    this.directory = path.join(dataDir, 'private-purchase');
    this.keyFile = path.join(this.directory, '.credential-key');
    this.dataFile = path.join(this.directory, 'credentials.enc.json');
    this.key = null;
    this.data = {};
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      this.key = await fs.readFile(this.keyFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.key = crypto.randomBytes(32);
      await fs.writeFile(this.keyFile, this.key, { mode: 0o600 });
    }
    try {
      const envelope = JSON.parse(await fs.readFile(this.dataFile, 'utf8'));
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final()
      ]).toString('utf8');
      this.data = JSON.parse(plaintext);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`私人帳密檔無法解密：${error.message}`);
      this.data = {};
    }
    return this;
  }

  get(platform) {
    if (!PLATFORMS.has(platform)) return { account: '', password: '' };
    if (platform === 'funbox') {
      const value = this.getFunboxAccount('A');
      return { account: value.account, password: value.password };
    }
    if (platform === 'eslite') {
      const value = this.getEsliteAccount('A');
      return { account: value.account, password: value.password };
    }
    const value = this.data[platform] || {};
    return { account: String(value.account || ''), password: String(value.password || '') };
  }

  getFunboxAccount(slot = 'A') {
    const normalizedSlot = String(slot || 'A').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) return { slot: normalizedSlot, account: '', password: '', enabled: false };
    const legacy = normalizedSlot === 'A' ? this.data.funbox || {} : {};
    const value = this.data.funboxAccounts?.[normalizedSlot] || legacy;
    const account = String(value.account || '');
    const password = String(value.password || '');
    return {
      slot: normalizedSlot,
      account,
      password,
      enabled: value.enabled === undefined ? Boolean(account && password) : Boolean(value.enabled)
    };
  }

  getFunboxAccounts() {
    return esliteAccountSlots(Object.keys(this.data.funboxAccounts || {})).map((slot) => this.getFunboxAccount(slot));
  }

  getEsliteAccount(slot = 'A') {
    const normalizedSlot = String(slot || 'A').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) {
      return { slot: normalizedSlot, account: '', password: '', enabled: false };
    }
    const legacy = normalizedSlot === 'A' ? this.data.eslite || {} : {};
    const value = this.data.esliteAccounts?.[normalizedSlot] || legacy;
    const account = String(value.account || '');
    const password = String(value.password || '');
    return {
      slot: normalizedSlot,
      account,
      password,
      enabled: value.enabled === undefined ? Boolean(account && password) : Boolean(value.enabled)
    };
  }

  getEsliteAccounts() {
    return esliteAccountSlots(Object.keys(this.data.esliteAccounts || {})).map((slot) => this.getEsliteAccount(slot));
  }

  getEsliteMemberNames({ reveal = false } = {}) {
    return Object.fromEntries(this.getEsliteAccounts().map(({ slot }) => {
      // Subscriber is the account's recorded purchaser, not a possibly different recipient.
      const name = Array.from(String(this.data.esliteMemberProfiles?.[slot]?.name
        || this.data.esliteCheckoutTemplates?.[slot]?.checkout?.subscriber?.name || '').trim());
      const masked = name.length > 2 ? name[0] + '*'.repeat(name.length - 2) + name.at(-1) : name.length ? name[0] + '*' : '';
      return [slot, reveal ? name.join('') : masked];
    }));
  }

  getEsliteDisplayIdentities() {
    const names = this.getEsliteMemberNames({ reveal: true });
    return { accounts: this.getEsliteAccounts().map(({ slot, account }) => ({ slot, account, memberName: names[slot] || '' })) };
  }

  viewEsliteCredentials(slot) {
    const normalizedSlot = String(slot || '').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) throw new Error('帳號欄位格式不正確');
    const { account, password } = this.getEsliteAccount(normalizedSlot);
    return { slot: normalizedSlot, account, password, memberName: this.getEsliteMemberNames()[normalizedSlot] };
  }

  getEsliteCheckoutTemplate(slot = 'A') {
    const normalizedSlot = String(slot || 'A').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) return null;
    const value = this.data.esliteCheckoutTemplates?.[normalizedSlot];
    return value && typeof value === 'object' ? structuredClone(value) : null;
  }

  getPickupSetup(platform, slot) {
    const account = platform === 'eslite' ? this.getEsliteAccount(slot) : this.getFunboxAccount(slot);
    const identity = crypto.createHash('sha256').update(`${platform}:${account.account.trim().toLowerCase()}`).digest('hex');
    const setup = this.data.pickupSetups?.[platform]?.[slot];
    return setup?.identity === identity && pickupSetupMatches(setup, this.getPickupProfile()) ? structuredClone(setup) : null;
  }

  async setPickupSetup(platform, slot, setup, expectedAccount) {
    if (!['funbox', 'eslite'].includes(platform) || !isEsliteAccountSlot(slot)) throw new Error('門市帳號格式不正確');
    const account = platform === 'eslite' ? this.getEsliteAccount(slot) : this.getFunboxAccount(slot);
    if (!account.account || account.account !== expectedAccount || setup?.source !== 'official_order'
      || !pickupSetupMatches(setup, this.getPickupProfile())) throw new Error('帳號已變更或缺少官方門市訂單證據');
    const identity = crypto.createHash('sha256').update(`${platform}:${account.account.trim().toLowerCase()}`).digest('hex');
    this.data.pickupSetups ||= {}; this.data.pickupSetups[platform] ||= {};
    const previous = this.data.pickupSetups[platform][slot];
    this.data.pickupSetups[platform][slot] = { ...structuredClone(setup), identity };
    try { await this._save(); } catch (error) { this.data.pickupSetups[platform][slot] = previous; throw error; }
  }

  async setEsliteMemberProfile(slot, profile, { expectedCredentials } = {}) {
    const normalizedSlot = String(slot || '').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) throw new Error('誠品帳號欄位格式不正確');
    this._assertEsliteCredentials(normalizedSlot, expectedCredentials);
    if (!profile?.name || !(profile.id || profile.uuid)) throw new Error('官方會員姓名與身分資料不完整');
    this.data.esliteMemberProfiles ||= {};
    this.data.esliteMemberProfiles[normalizedSlot] = { id: String(profile.id || ''), uuid: String(profile.uuid || ''),
      name: String(profile.name), verifiedAt: new Date().toISOString() };
    await this._save();
  }

  _assertEsliteCredentials(slot, expected) {
    if (!expected) return;
    const current = this.getEsliteAccount(slot);
    if (current.account !== expected.account || current.password !== expected.password) {
      throw new Error('帳密已更新；忽略舊的資料辨識結果');
    }
  }

  async setEsliteCheckoutTemplate(slot, template, { paymentMode = '', expectedCredentials } = {}) {
    const normalizedSlot = String(slot || '').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) throw new Error('誠品帳號欄位格式不正確');
    this._assertEsliteCredentials(normalizedSlot, expectedCredentials);
    if (!template || typeof template !== 'object' || !template.checkout || typeof template.checkout !== 'object') {
      throw new Error('誠品 API 結帳範本格式不完整');
    }
    this.data.esliteCheckoutTemplates ||= {};
    this.data.esliteCheckoutTemplates[normalizedSlot] = {
      capturedAt: new Date().toISOString(),
      paymentMode: String(paymentMode || ''),
      ...(template.requestedPayment ? { requestedPayment: template.requestedPayment } : {}),
      ...(template.paymentFallback ? { paymentFallback: structuredClone(template.paymentFallback) } : {}),
      checkout: structuredClone(template.checkout)
    };
    await this._save();
    return { slot: normalizedSlot, capturedAt: this.data.esliteCheckoutTemplates[normalizedSlot].capturedAt };
  }

  getPickupProfile() {
    const value = this.data.pickupProfile || {};
    return {
      fullName: String(value.fullName || ''),
      phone: String(value.phone || ''),
      storeName: String(value.storeName || '')
    };
  }

  getDeliveryProfile() {
    const value = this.data.deliveryProfile || {};
    return {
      fullName: String(value.fullName || ''),
      phone: String(value.phone || ''),
      city: String(value.city || ''),
      district: String(value.district || ''),
      postalCode: String(value.postalCode || ''),
      address: String(value.address || '')
    };
  }

  async setDeliveryProfile({ fullName, phone, city, district, postalCode, address }) {
    const previous = this.getDeliveryProfile();
    const next = {
      fullName: String(fullName || previous.fullName).trim(),
      phone: String(phone || previous.phone).replace(/\D/g, ''),
      city: String(city || previous.city).trim(),
      district: String(district || previous.district).trim(),
      postalCode: String(postalCode || previous.postalCode).replace(/\D/g, ''),
      address: String(address || previous.address).trim()
    };
    if (
      !next.fullName
      || !/^09\d{8}$/.test(next.phone)
      || !next.city
      || !next.district
      || !/^\d{3,5}$/.test(next.postalCode)
      || !next.address
    ) {
      throw new Error('宅配姓名、手機、縣市、區域、郵遞區號或地址不完整');
    }
    this.data.deliveryProfile = next;
    await this._save();
    return { ...next };
  }

  async setPickupProfile({ fullName, phone, storeName }) {
    const previous = this.getPickupProfile();
    const next = {
      fullName: String(fullName || previous.fullName).trim(),
      phone: String(phone || previous.phone).replace(/\D/g, ''),
      storeName: String(storeName || previous.storeName).trim()
    };
    if (!next.fullName || !/^09\d{8}$/.test(next.phone) || !next.storeName) {
      throw new Error('取貨人姓名、手機或 7-11 門市資料不完整');
    }
    this.data.pickupProfile = next;
    await this._save();
    return { fullName: next.fullName, phone: next.phone, storeName: next.storeName };
  }

  async set(platform, { account, password }) {
    if (!PLATFORMS.has(platform)) throw new Error('不支援這個購物平台');
    if (platform === 'funbox') return this.setFunboxAccount('A', { account, password, enabled: true });
    if (platform === 'eslite') return this.setEsliteAccount('A', { account, password, enabled: true });
    const previous = this.get(platform);
    const next = {
      account: String(account || previous.account).trim(),
      password: String(password || previous.password)
    };
    if (!next.account || !next.password) throw new Error('帳號與密碼都必須填寫');
    this.data[platform] = next;
    await this._save();
    return { platform, account: next.account };
  }

  async setFunboxAccount(slot, { account, password, enabled = true }) {
    const normalizedSlot = String(slot || '').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) throw new Error('Funbox 帳號欄位格式不正確');
    const previous = this.getFunboxAccount(normalizedSlot);
    const next = {
      account: String(account || previous.account).trim(),
      password: String(password || previous.password),
      enabled: Boolean(enabled)
    };
    if (!next.account || !next.password) throw new Error(`Funbox 帳號 ${normalizedSlot} 的帳號與密碼都必須填寫`);
    if (this.getFunboxAccounts().some(item => item.slot !== normalizedSlot
      && item.account.trim().toLowerCase() === next.account.toLowerCase())) {
      throw new Error('這個 Funbox 帳號已存在於其他欄位，請勿重複新增');
    }
    this.data.funboxAccounts ||= {};
    this.data.funboxAccounts[normalizedSlot] = next;
    // A 欄位兼容過去單帳號版本；新程式只會從 funboxAccounts 讀取。
    if (normalizedSlot === 'A') this.data.funbox = { account: next.account, password: next.password };
    await this._save();
    return { platform: 'funbox', slot: normalizedSlot, account: next.account, enabled: next.enabled };
  }

  async clearFunboxAccount(slot) {
    const normalizedSlot = String(slot || '').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) throw new Error('Funbox 帳號欄位格式不正確');
    if (this.data.funboxAccounts) delete this.data.funboxAccounts[normalizedSlot];
    if (normalizedSlot === 'A') delete this.data.funbox;
    await this._save();
  }

  async setEsliteAccount(slot, { account, password, enabled = true }) {
    const normalizedSlot = String(slot || '').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) throw new Error('誠品帳號欄位格式不正確');
    const previous = this.getEsliteAccount(normalizedSlot);
    const next = {
      account: String(account || previous.account).trim(),
      password: String(password || previous.password),
      enabled: Boolean(enabled)
    };
    if (!next.account || !next.password) throw new Error(`誠品帳號 ${normalizedSlot} 的帳號與密碼都必須填寫`);
    if (this.getEsliteAccounts().some(item => item.slot !== normalizedSlot
      && item.account.trim().toLowerCase() === next.account.toLowerCase())) {
      throw new Error('這個誠品帳號已存在於其他欄位，請勿重複新增');
    }
    const credentialsChanged = next.account !== previous.account || next.password !== previous.password;
    this.data.esliteAccounts ||= {};
    this.data.esliteAccounts[normalizedSlot] = next;
    if (credentialsChanged && this.data.esliteCheckoutTemplates) {
      delete this.data.esliteCheckoutTemplates[normalizedSlot];
    }
    if (next.account !== previous.account && this.data.esliteMemberProfiles) delete this.data.esliteMemberProfiles[normalizedSlot];
    // A 欄位兼容過去單帳號版本，升級後不會要求使用者重新輸入帳密。
    if (normalizedSlot === 'A') this.data.eslite = { account: next.account, password: next.password };
    await this._save();
    return { platform: 'eslite', slot: normalizedSlot, account: next.account, enabled: next.enabled };
  }

  async clearEsliteAccount(slot) {
    const normalizedSlot = String(slot || '').toUpperCase();
    if (!isEsliteAccountSlot(normalizedSlot)) throw new Error('誠品帳號欄位格式不正確');
    if (this.data.esliteAccounts) delete this.data.esliteAccounts[normalizedSlot];
    if (this.data.esliteCheckoutTemplates) delete this.data.esliteCheckoutTemplates[normalizedSlot];
    if (this.data.esliteMemberProfiles) delete this.data.esliteMemberProfiles[normalizedSlot];
    if (normalizedSlot === 'A') delete this.data.eslite;
    await this._save();
  }

  async clear(platform) {
    if (!PLATFORMS.has(platform)) throw new Error('不支援這個購物平台');
    if (platform === 'funbox') {
      delete this.data.funbox;
      delete this.data.funboxAccounts;
      await this._save();
      return;
    }
    if (platform === 'eslite') {
      delete this.data.eslite;
      delete this.data.esliteAccounts;
      await this._save();
      return;
    }
    delete this.data[platform];
    await this._save();
  }

  async _save() {
    const save = async () => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(this.data), 'utf8'),
      cipher.final()
    ]);
    const envelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
    const temporary = `${this.dataFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    await fs.rename(temporary, this.dataFile);
    };
    // Three preparation jobs may complete together; never race one shared .tmp file.
    this.saveTail = (this.saveTail || Promise.resolve()).catch(() => {}).then(save);
    return this.saveTail;
  }
}
