import assert from 'node:assert/strict';
import test from 'node:test';

import { FunboxMonitor } from '../src/funbox.js';

test('Funbox 上架後先派送購買工作，Discord 通知不阻塞掃描', async () => {
  const state = { data: {}, async save() {} };
  const payloads = [
    [],
    [{
      id: 9009,
      url: '/products/bx-09',
      title: 'BEYBLADE X BX-09',
      price: 495,
      variants: [{ id: 99, inventory_quantity: 1, inventory_policy: 'deny' }]
    }]
  ];
  const events = [];
  let finishNotification;
  const notification = new Promise((resolve) => { finishNotification = resolve; });
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payloads.shift()),
    notify: async () => {
      events.push('notification-started');
      await notification;
      events.push('notification-finished');
      return 'discord-bx09';
    },
    onPurchaseCandidate: (candidate) => {
      events.push(`purchase:${candidate.id}`);
    }
  });

  await monitor.scan();
  const result = await Promise.race([
    monitor.scan(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('通知阻塞 Funbox 掃描')), 250))
  ]);

  assert.equal(result.purchaseCandidatesDispatched, true);
  assert.equal(result.purchaseCandidates.length, 1);
  assert.deepEqual(events, ['purchase:bx-09', 'notification-started']);

  finishNotification();
  await monitor.close();
  assert.deepEqual(events, ['purchase:bx-09', 'notification-started', 'notification-finished']);
});

test('Funbox 購買工作卡住時公開通知與掃描仍會繼續', async () => {
  const state = { data: {}, async save() {} };
  const payloads = [
    [],
    [{
      id: 9010,
      url: '/products/ux-10',
      title: 'BEYBLADE X UX-10',
      price: 1250,
      variants: [{ id: 100, inventory_quantity: 1, inventory_policy: 'deny' }]
    }]
  ];
  const events = [];
  let finishPurchase;
  const pendingPurchase = new Promise((resolve) => { finishPurchase = resolve; });
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payloads.shift()),
    notify: async () => {
      events.push('public-notification');
      return 'discord-ux10';
    },
    onPurchaseCandidate: () => {
      events.push('purchase-started');
      return pendingPurchase;
    }
  });

  await monitor.scan();
  const result = await Promise.race([
    monitor.scan(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('購買工作阻塞公開通知或掃描')), 250))
  ]);

  assert.equal(result.purchaseCandidates.length, 1);
  assert.equal(result.notified, 1);
  assert.deepEqual(events, ['purchase-started', 'public-notification']);
  finishPurchase();
  await monitor.close();
});

test('Funbox 健康 API 回應立即同步快照，最後合併不偽造新觀測', async () => {
  const state = { data: {}, async save() {} };
  const snapshots = [];
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json([{
      id: 9011,
      url: '/products/cx-13',
      title: 'BEYBLADE X CX-13',
      price: 495,
      variants: [{ id: 101, inventory_quantity: 0, inventory_policy: 'deny' }]
    }]),
    notify: async () => '',
    onInventorySnapshot: (products, observedAt) => snapshots.push({ products, observedAt })
  });

  const before = Date.now();
  await monitor.scan();

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].products[0].id, 'cx-13');
  assert.equal(snapshots[0].products[0].available, false);
  assert.equal(snapshots[0].products[0].stock, 0);
  assert.ok(snapshots[0].observedAt >= before);
  assert.equal(snapshots[1].products[0].observedAtMs, snapshots[0].products[0].observedAtMs);
  assert.equal(snapshots[1].products[0].stock, 0);
  assert.equal(snapshots[1].products[0].available, false);
  await monitor.close();
});
