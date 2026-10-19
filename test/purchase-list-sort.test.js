import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { once } from 'node:events';
import { load } from 'cheerio';
import { sortPurchaseListText, purchaseListSortClient } from '../src/purchase-list-sort.js';
import { purchasePolicy } from '../src/purchase-rules.js';
import { createDashboard, validateDashboardClientScript } from '../src/dashboard.js';

test('型號依系列與自然數字排序，文字關鍵字在後，排序可重複執行', () => {
  const result = sortPurchaseListText('UX-18\r\nBX-52\nBX-10\n強化組\nUX-2\nCX-18\nBX-2\nBX-09\n隨機');
  assert.deepEqual(result.split('\n').slice(0, 7), ['BX-2', 'BX-09', 'BX-10', 'BX-52', 'CX-18', 'UX-2', 'UX-18']);
  assert.equal(sortPurchaseListText(result), result);
  assert.equal(sortPurchaseListText(' \n\r\n'), '');
});

test('不刪除重複詞、不改寫全形與破折號，不改名單購買資格或優先级', () => {
  const words = ['UX-03', 'ＢＸ－０９', 'BX–10', 'UX-03', '強化組', 'BX-35'];
  const after = sortPurchaseListText(words.join('\n')).split('\n');
  assert.deepEqual([...after].sort(), [...words].sort());
  for (const list of ['buyKeywords', 'skipBuyKeywords']) {
    const settings = { buyMode: 'whitelist', buyKeywords: words, priorityKeywords: ['BX-09', '強化組'] };
    if (list === 'skipBuyKeywords') settings.skipBuyKeywords = words;
    for (const platform of ['funbox', 'eslite']) {
      for (const title of ['BX-35 隨機強化組', 'UX-03 魔導神杖', 'CX-13 龍王閃擊']) {
        const before = purchasePolicy(platform, { title }, settings);
        const sorted = purchasePolicy(platform, { title }, { ...settings, [list]: after });
        assert.equal(sorted.eligible, before.eligible);
        assert.equal(sorted.priority, before.priority);
      }
    }
  }
});

test('四個排序按鈕只改自己的輸入框並標記待儲存，不呼叫 API', () => {
  for (const platform of ['funbox', 'eslite']) for (const list of ['black', 'white']) {
    const nodes = Object.fromEntries(['funbox', 'eslite'].flatMap(p => ['skip-buy-keywords', 'buy-keywords', 'priority-keywords'].map(s => [p + '-' + s, { value: s === 'priority-keywords' ? 'BX-09,強化組' : 'UX-13\nBX-52\nCX-18' }])));
    nodes['auto-purchase-' + platform + '-state'] = { textContent: '' };
    const before = structuredClone(nodes), dirty = [];
    const context = vm.createContext({ document: { getElementById: id => nodes[id] }, markAutoPurchaseDirty: p => dirty.push(p), api: () => assert.fail('排序不應送出請求') });
    vm.runInContext(purchaseListSortClient, context);
    vm.runInContext(`sortAutoPurchaseList('${platform}','${list}')`, context);
    const target = platform + (list === 'black' ? '-skip-buy-keywords' : '-buy-keywords');
    assert.equal(nodes[target].value, 'BX-52\nCX-18\nUX-13');
    for (const [id, node] of Object.entries(before)) if (id !== target && id !== 'auto-purchase-' + platform + '-state') assert.deepEqual(nodes[id], node);
    assert.deepEqual(dirty, [platform]);
    assert.match(nodes['auto-purchase-' + platform + '-state'].textContent, /請按.*儲存/);
    vm.runInContext(`sortAutoPurchaseList('${platform}','${list}')`, context);
    assert.deepEqual(dirty, [platform]);
    vm.runInContext("sortAutoPurchaseList('other','white');sortAutoPurchaseList('funbox','other')", context);
    assert.deepEqual(dirty, [platform]);
  }
});

test('完整控制台四個按鈕有可存取名稱且不提交表單，腳本語法正常', async () => {
  const server = createDashboard({ port: 0, readOnly: true, log: () => {}, getStatus: () => ({}) });
  if (!server.listening) await once(server, 'listening');
  try {
    const html = await (await fetch('http://127.0.0.1:' + server.address().port)).text();
    const $ = load(html);
    assert.equal($('button[onclick^="sortAutoPurchaseList"]').length, 4);
    $('button[onclick^="sortAutoPurchaseList"]').each((_, button) => {
      assert.equal($(button).attr('type'), 'button');
      assert.match($(button).attr('aria-label'), /名單排序/);
    });
    assert.equal(validateDashboardClientScript(html), true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
