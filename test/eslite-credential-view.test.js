import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboard } from '../src/dashboard.js';
import { LocalCredentialStore } from '../src/credential-store.js';

test('誠品姓名只取訂購人且遮罩；查看不更改儲存資料', () => {
  const store = new LocalCredentialStore('unused');
  store.data = { esliteAccounts: { B: { account: 'fake-account', password: 'fake-password', enabled: false } },
    esliteCheckoutTemplates: { A: { checkout: { subscriber: { name: '陳測宏' }, recipient: { name: '其他人' } } } } };
  const before = structuredClone(store.data);
  assert.deepEqual(store.getEsliteMemberNames(), { A: '陳*宏', B: '', C: '' });
  assert.deepEqual(store.viewEsliteCredentials('B'), { slot: 'B', account: 'fake-account', password: 'fake-password', memberName: '' });
  assert.deepEqual(store.data, before);
  assert.deepEqual(store.viewEsliteCredentials('D'), { slot: 'D', account: '', password: '', memberName: undefined });
  assert.throws(() => store.viewEsliteCredentials('../D'));
});

test('帳密查看只接受同源本機 POST + 自訂標頭，禁止快取且失敗不記錄秘密', async () => {
  const logs = []; let calls = 0;
  const server = createDashboard({ port: 0, getStatus: () => ({ autoPurchase: {} }), log: value => logs.push(value),
    onViewEsliteCredentials: slot => { calls++; if (slot === 'C') throw new Error('fake-secret'); return { slot, account: 'fake-account', password: 'fake-password' }; } });
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = origin + '/auto-purchase/eslite/credentials/view';
  const send = (headers = {}, slot = 'B') => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ slot }) });
  const headers = { Origin: origin, 'X-Local-Credential-View': '1' };
  try {
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await send()).status, 403);
    assert.equal((await send({ ...headers, Origin: 'https://external.example' })).status, 403);
    assert.equal((await send({ Origin: origin })).status, 403);
    assert.equal((await send(headers, '../D')).status, 400);
    assert.equal(calls, 0);
    const result = await send(headers);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).password, 'fake-password');
    assert.equal((await send(headers, 'D')).status, 200);
    const failed = await send(headers, 'C');
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /fake-secret/);
    assert.deepEqual(logs, []);
    assert.doesNotMatch(await (await fetch(origin + '/api/status')).text(), /fake-password|fake-account/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('唯讀預覽不能查看帳密', async () => {
  let calls = 0;
  const server = createDashboard({ port: 0, readOnly: true, log: () => {}, onViewEsliteCredentials: () => { calls++; } });
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetch(origin + '/auto-purchase/eslite/credentials/view', { method: 'POST',
      headers: { Origin: origin, 'X-Local-Credential-View': '1' } });
    assert.equal(result.status, 403); assert.equal(calls, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
