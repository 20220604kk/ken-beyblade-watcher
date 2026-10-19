import assert from 'node:assert/strict';
import test from 'node:test';

import { ShoppingSiteMonitor } from '../src/shopping-sites.js';

test('可購規格會在 Discord 通知完成前立即交給購買工作器', async () => {
  const target = {
    id: 'mmtoy-immediate',
    name: 'MM小舖戰鬥陀螺專區',
    siteName: 'MM小舖',
    url: 'https://mmtoyshop.com/category/test',
    enabled: true
  };
  const events = [];
  let notificationOptions;
  let finishNotification;
  const notification = new Promise((resolve) => { finishNotification = resolve; });
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                '705870': {
                  id: '705870',
                  title: 'BEYBLADE X BX-09',
                  url: 'https://mmtoyshop.com/item/test-bx09',
                  available: false,
                  variants: [{ id: '2437634', name: '一般可購', stock: 0, available: false }]
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    notify: async (_text, options) => {
      notificationOptions = options;
      events.push('notification-started');
      await notification;
      events.push('notification-finished');
    },
    onPurchaseCandidate: async (candidate) => {
      events.push(`purchase:${candidate.variantId}`);
    }
  });
  monitor.loadMmToyCategoryProducts = async () => [{
    id: '705870',
    title: 'BEYBLADE X BX-09',
    url: 'https://mmtoyshop.com/item/test-bx09',
    available: true,
    variants: [{ id: '2437634', name: '一般可購', stock: 1, available: true }]
  }];

  const result = await Promise.race([
    monitor.scan(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('掃描被通知阻塞')), 250))
  ]);

  assert.equal(result.purchaseCandidatesDispatched, true);
  assert.equal(result.purchaseCandidates.length, 1);
  assert.equal(notificationOptions.discordAudience, 'mmtoy');
  assert.deepEqual(events, ['purchase:2437634', 'notification-started']);

  finishNotification();
  await monitor.close();
  assert.deepEqual(events, ['purchase:2437634', 'notification-started', 'notification-finished']);
});

test('購物工作拒絕或登入驗證失敗時公開補貨通知仍會送出', async () => {
  const target = {
    id: 'eslite-independent-lines',
    name: '誠品戰鬥陀螺搜尋',
    siteName: '誠品線上',
    url: 'https://www.eslite.com/Search?keyword=beyblade',
    sourceType: 'eslite-keywords',
    keywords: ['BEYBLADE X'],
    enabled: true
  };
  const events = [];
  const state = {
    data: {
      commerce: {
        shoppingSites: {
          targets: {
            [target.id]: {
              initialized: true,
              seen: {
                'eslite-ux14': {
                  id: 'eslite-ux14',
                  title: 'BEYBLADE X UX-14',
                  url: 'https://www.eslite.com/product/ux14',
                  available: false,
                  variants: []
                }
              }
            }
          }
        }
      }
    },
    async save() {}
  };
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    notify: async () => {
      events.push('public-notification');
      return 'discord-eslite-ux14';
    },
    onPurchaseCandidate: async () => {
      events.push('purchase-started');
      throw new Error('誠品仍停在登入／圖形驗證頁');
    },
    log: () => {}
  });
  monitor.loadEsliteKeywordProducts = async () => [{
    id: 'eslite-ux14',
    title: 'BEYBLADE X UX-14',
    url: 'https://www.eslite.com/product/ux14',
    available: true,
    variants: []
  }];

  const result = await Promise.race([
    monitor.scan(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('登入驗證失敗阻塞公開通知')), 250))
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.purchaseCandidates.length, 1);
  assert.equal(result.notified, 1);
  assert.deepEqual(events, ['purchase-started', 'public-notification']);
  await monitor.close();
});
