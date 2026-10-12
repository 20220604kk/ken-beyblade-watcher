import assert from 'node:assert/strict';
import test from 'node:test';

import {
  notificationEmbed, notificationPreview, shoppingProductLabel
} from '../src/shopping-sites.js';

const target = {
  name: 'MM小舖戰鬥陀螺專區',
  siteName: 'MM小舖',
  url: 'https://mmtoyshop.com/category/test',
  sourceType: 'mmtoy-category'
};
const product = {
  title: '【M.M小舖】『預購』 9月 TAKARA TOMY 戰鬥陀螺 UX-16 時鐘幻象 隨機強化組 對戰 復古 熱血',
  url: 'https://mmtoyshop.com/item/ux16',
  price: 'NT$350',
  imageUrl: 'https://mmtoyshop.com/ux16.jpg'
};
const variant = { name: '預購-1個(不可搭其他預購) #不補', stock: 1 };

test('MM小舖手機摘要以陀螺名稱開頭並保持兩行', () => {
  assert.equal(shoppingProductLabel(product), 'UX-16 時鐘幻象');
  assert.equal(
    notificationPreview(target, product, variant, 'restock'),
    '🔔 M.M小舖｜UX-16 時鐘幻象\n補貨｜NT$350｜可售 1 組'
  );
});

test('MM小舖 Discord 卡片簡化欄位且商品名稱可點擊', () => {
  const embed = notificationEmbed(target, product, variant, 'restock');
  assert.equal(embed.author.name, '陀螺通知監控儀表・購物網站');
  assert.equal(embed.author.url, product.url);
  assert.equal(embed.url, product.url);
  assert.match(embed.title, /UX-16 時鐘幻象/);
  assert.match(embed.description, /\*\*陀螺：\*\* \[UX-16 時鐘幻象\]\(https:\/\/mmtoyshop\.com\/item\/ux16\)/);
  assert.match(embed.description, /\*\*商品：\*\*/);
  assert.match(embed.description, /\*\*補貨款式：\*\*/);
  assert.match(embed.description, /\*\*前台可售：\*\* 1 組/);
  assert.doesNotMatch(embed.description, /監控專區/);
});
