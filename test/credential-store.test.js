import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalCredentialStore } from '../src/credential-store.js';

test('私人購買帳密以加密檔保存並可重新載入', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-credentials-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await store.set('funbox', { account: 'player@example.com', password: 'secret-123' });
    const raw = await fs.readFile(path.join(directory, 'private-purchase', 'credentials.enc.json'), 'utf8');
    assert.doesNotMatch(raw, /player@example\.com|secret-123/);

    const reloaded = await new LocalCredentialStore(directory).load();
    assert.deepEqual(reloaded.get('funbox'), {
      account: 'player@example.com', password: 'secret-123'
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('密碼留空時沿用同一平台已儲存的一組密碼', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-credentials-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await store.set('momo', { account: 'old-account', password: 'old-password' });
    await store.set('momo', { account: 'new-account', password: '' });
    assert.deepEqual(store.get('momo'), { account: 'new-account', password: 'old-password' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Funbox 最多三組帳密會分槽加密保存，舊單帳號自動成為帳號 A', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-accounts-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await store.set('funbox', { account: '0958000000', password: 'password-a' });
    await store.setFunboxAccount('B', { account: '0913000000', password: 'password-b', enabled: true });
    await store.setFunboxAccount('C', { account: '0922000000', password: 'password-c', enabled: false });
    const raw = await fs.readFile(path.join(directory, 'private-purchase', 'credentials.enc.json'), 'utf8');
    assert.doesNotMatch(raw, /0958000000|0913000000|0922000000|password-[abc]/);

    const reloaded = await new LocalCredentialStore(directory).load();
    assert.deepEqual(reloaded.getFunboxAccounts().map(({ slot, account, enabled }) => ({ slot, account, enabled })), [
      { slot: 'A', account: '0958000000', enabled: true },
      { slot: 'B', account: '0913000000', enabled: true },
      { slot: 'C', account: '0922000000', enabled: false }
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('誠品 A B C 帳密分槽加密保存，舊單帳號保留為 A', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-accounts-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await store.set('eslite', { account: 'account-a@example.com', password: 'password-a' });
    await store.setEsliteAccount('B', { account: 'account-b@example.com', password: 'password-b', enabled: true });
    const raw = await fs.readFile(path.join(directory, 'private-purchase', 'credentials.enc.json'), 'utf8');
    assert.doesNotMatch(raw, /account-[ab]@example\.com|password-[ab]/);
    const reloaded = await new LocalCredentialStore(directory).load();
    assert.deepEqual(reloaded.getEsliteAccounts().map(({ slot, account, enabled }) => ({ slot, account, enabled })), [
      { slot: 'A', account: 'account-a@example.com', enabled: true },
      { slot: 'B', account: 'account-b@example.com', enabled: true },
      { slot: 'C', account: '', enabled: false }
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('取貨資料以加密檔保存並可重新載入', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-pickup-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await store.setPickupProfile({
      fullName: '測試取貨人', phone: '0912345678', storeName: '測試門市'
    });
    const raw = await fs.readFile(
      path.join(directory, 'private-purchase', 'credentials.enc.json'), 'utf8'
    );
    assert.doesNotMatch(raw, /測試取貨人|0912345678|測試門市/);

    const reloaded = await new LocalCredentialStore(directory).load();
    assert.deepEqual(reloaded.getPickupProfile(), {
      fullName: '測試取貨人', phone: '0912345678', storeName: '測試門市'
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('宅配資料以加密檔保存並可重新載入', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-delivery-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await store.setDeliveryProfile({
      fullName: '測試收件人', phone: '0912345678', city: '桃園市', district: '中壢區',
      postalCode: '320', address: '測試路1號'
    });
    const raw = await fs.readFile(
      path.join(directory, 'private-purchase', 'credentials.enc.json'), 'utf8'
    );
    assert.doesNotMatch(raw, /測試收件人|0912345678|測試路1號/);

    const reloaded = await new LocalCredentialStore(directory).load();
    assert.deepEqual(reloaded.getDeliveryProfile(), {
      fullName: '測試收件人', phone: '0912345678', city: '桃園市', district: '中壢區',
      postalCode: '320', address: '測試路1號'
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
