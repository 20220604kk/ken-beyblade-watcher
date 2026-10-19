import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSenSenCollectionData } from '../src/shopping-sites.js';

test('森森文具只保留正式陀螺並解析規格庫存', () => {
  const products = parseSenSenCollectionData([
    {
      url: '/products/ux-20', photo: '/media/ux20.png', title: 'BEYBLADE X UX-20 榮耀武神 LF', price: 595,
      variants: [{ id: 1, option1: '1盒', inventory_quantity: 8 }]
    },
    {
      url: '/products/storage', title: '戰鬥陀螺收納箱 BX-50 專用', price: 999,
      variants: [{ id: 2, inventory_quantity: 6 }]
    },
    {
      url: '/products/launcher', title: 'BEYBLADE X BX-47 左迴旋風發射器', price: 250,
      variants: [{ id: 3, inventory_quantity: 5 }]
    },
    {
      url: '/products/bx-50', title: '戰鬥陀螺X BX-50 隨機強化組', price: 350,
      variants: [{ id: 4, option1: '1盒', inventory_quantity: -2 }]
    }
  ], 'https://www.sen-sen.com.tw/collections/test');

  assert.equal(products.length, 3);
  assert.equal(products[0].title.includes('UX-20'), true);
  assert.equal(products[0].variants[0].stock, 8);
  assert.equal(products[0].available, true);
  assert.equal(products[1].title.includes('BX-47'), true);
  assert.equal(products[1].variants[0].stock, 5);
  assert.equal(products[1].available, true);
  assert.equal(products[2].title.includes('BX-50'), true);
  assert.equal(products[2].variants[0].stock, 0);
  assert.equal(products[2].available, false);
});
