import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SaleReminderMonitor, saleReminderListedNotification, saleReminderNotification
} from '../src/sale-reminders.js';

const reminder = {
  id: 'momo-bx35',
  name: 'momo Funbox BX-35',
  siteName: 'momo購物網',
  url: 'https://www.momoshop.com.tw/product/15462753',
  saleStartAt: '2026-07-25T03:00:00.000Z',
  enabled: true
};

test('開賣倒數通知使用購物網站、開賣時間與剩餘分鐘', () => {
  const message = saleReminderNotification(reminder, 60, new Date('2026-07-25T02:00:00.000Z'));
  assert.match(message.text, /購物網站：momo購物網/);
  assert.match(message.text, /7\/25 11:00 開賣/);
  assert.match(message.text, /現在時間 10:00，距離開賣 60 分鐘/);
  assert.match(message.options.discordPreview, /距離開賣 60 分鐘/);
});

test('加入提醒時會產生一次清楚的 Discord 商品通知', () => {
  const message = saleReminderListedNotification({
    ...reminder,
    imageUrl: 'https://example.com/bx35.jpg',
    price: 'NT$295'
  }, new Date('2026-07-23T03:00:00.000Z'));
  assert.match(message.text, /momo購物網 商品開賣情報/);
  assert.match(message.text, /7\/25 11:00 開賣/);
  assert.match(message.options.discordPreview, /商品開賣/);
  assert.equal(message.options.embeds[0].thumbnail.url, 'https://example.com/bx35.jpg');
  assert.match(message.options.embeds[0].footer.text, /60／30／10/);
});

test('開賣前 60、30、10 分鐘各通知一次，重複檢查不重送', async () => {
  let now = new Date('2026-07-25T02:00:05.000Z');
  const state = { data: {}, async save() {} };
  const notifications = [];
  const monitor = new SaleReminderMonitor({
    state,
    getReminders: () => [reminder],
    now: () => now,
    notify: async (text) => notifications.push(text)
  });
  assert.equal((await monitor.check()).notified, 1);
  assert.equal((await monitor.check()).notified, 0);
  now = new Date('2026-07-25T02:30:05.000Z');
  assert.equal((await monitor.check()).notified, 1);
  now = new Date('2026-07-25T02:50:05.000Z');
  assert.equal((await monitor.check()).notified, 1);
  assert.equal(notifications.length, 3);
  assert.match(notifications[0], /60 分鐘/);
  assert.match(notifications[1], /30 分鐘/);
  assert.match(notifications[2], /10 分鐘/);
});

test('程式較晚啟動時只補送最近的一個提醒，不連續洗版', async () => {
  const state = { data: {}, async save() {} };
  const notifications = [];
  const monitor = new SaleReminderMonitor({
    state,
    getReminders: () => [reminder],
    now: () => new Date('2026-07-25T02:35:00.000Z'),
    notify: async (text) => notifications.push(text)
  });
  const result = await monitor.check();
  assert.equal(result.notified, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /25 分鐘/);
  assert.deepEqual(state.data.commerce.saleReminders[reminder.id].handledMinutes, [60, 30]);
});
