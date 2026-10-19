import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseFunboxProducts } from '../src/funbox.js';
import { FunboxSandbox } from '../src/funbox-sandbox.js';

async function withSandbox(callback) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'funbox-sandbox-'));
  let resets = 0;
  const sandbox = new FunboxSandbox({
    dataDir,
    port: 0,
    onReset: async () => { resets += 1; }
  });
  await sandbox.load();
  const server = http.createServer(async (request, response) => {
    if (!await sandbox.handle(request, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  sandbox.port = server.address().port;
  const baseUrl = `http://127.0.0.1:${sandbox.port}`;
  try {
    await callback({ sandbox, baseUrl, getResetCount: () => resets });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test('沙盒集合頁可從空清單模擬上架，並沿用正式 Funbox 解析器', async () => {
  await withSandbox(async ({ sandbox, baseUrl }) => {
    const collectionUrl = `${baseUrl}/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA`;
    assert.equal(parseFunboxProducts(await (await fetch(collectionUrl)).text(), collectionUrl).length, 0);

    const publish = await fetch(`${baseUrl}/funbox-sandbox/api/products/990001/publish`, { method: 'POST' });
    assert.equal(publish.status, 200);

    const products = parseFunboxProducts(await (await fetch(collectionUrl)).text(), collectionUrl);
    assert.equal(products.length, 1);
    assert.equal(products[0].id, 'ux-15-shark-scale-test');
    assert.match(products[0].title, /UX-15/);
    assert.equal(products[0].url, `${baseUrl}/funbox-sandbox/products/ux-15-shark-scale-test`);
    assert.equal(sandbox.status().publishedCount, 1);
  });
});

test('沙盒可完成加入購物車、貨到付款與建立本機測試訂單', async () => {
  await withSandbox(async ({ sandbox, baseUrl }) => {
    await fetch(`${baseUrl}/funbox-sandbox/api/products/990001/publish`, { method: 'POST' });
    const add = await fetch(`${baseUrl}/funbox-sandbox/api/cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: '990001', quantity: 2 })
    });
    assert.equal(add.status, 200);
    assert.equal((await add.json()).cartCount, 2);

    const order = await fetch(`${baseUrl}/funbox-sandbox/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '測試王',
        phone: '0900000000',
        email: 'test@example.com',
        address: '台北市測試路 1 號',
        payment: 'cod',
        terms: 'on'
      })
    });
    assert.equal(order.status, 200);
    assert.match((await order.json()).orderId, /^TEST-/);
    assert.equal(sandbox.status().cartCount, 0);
    assert.equal(sandbox.status().orderCount, 1);
  });
});

test('沙盒控制台可模擬庫存 100→50→20→10', async () => {
  await withSandbox(async ({ sandbox, baseUrl }) => {
    await fetch(`${baseUrl}/funbox-sandbox/api/products/990001/publish`, { method: 'POST' });
    const collectionUrl = `${baseUrl}/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA`;

    for (const stock of [100, 50, 20, 10]) {
      const response = await fetch(`${baseUrl}/funbox-sandbox/api/products/990001/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock })
      });
      assert.equal(response.status, 200);
      const products = parseFunboxProducts(await (await fetch(collectionUrl)).text(), collectionUrl);
      assert.equal(products[0].stock, stock);
      assert.equal(sandbox.status().products.find((product) => product.id === '990001').stock, stock);
    }
  });
});

test('全部重設會下架商品、清除測試資料並通知監控端重設基線', async () => {
  await withSandbox(async ({ sandbox, baseUrl, getResetCount }) => {
    await fetch(`${baseUrl}/funbox-sandbox/api/products/990002/publish`, { method: 'POST' });
    const reset = await fetch(`${baseUrl}/funbox-sandbox/api/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal(sandbox.status().publishedCount, 0);
    assert.equal(getResetCount(), 1);
  });
});
