import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {shopeeHtml,shopeeClient} from '../src/shopee-ui.js';

test('Shopee panel uses native collapsed details with connection status in summary',()=>{
  const $=load(shopeeHtml),panel=$('#shopee-panel');
  assert.equal(panel.prop('tagName'),'DETAILS');
  assert.equal(panel.attr('open'),undefined);
  assert.equal(panel.children('summary').length,1);
  assert.equal(panel.children('summary').find('#shopee-connection').length,1);
  assert.equal(panel.find('#shopee-form').length,1);
  assert.equal(panel.find('#shopee-targets').length,1);
  assert.equal(panel.find('#shopee-logs').length,1);
});
test('collapsing only changes presentation: no toggle-triggered API or scan action',()=>{
  const $=load(shopeeHtml);
  assert.equal($('#shopee-panel').attr('ontoggle'),undefined);
  assert.doesNotMatch(shopeeClient,/shopee-panel.*(?:\.open|toggle|addEventListener)/);
});
