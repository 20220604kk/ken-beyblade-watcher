import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import { collectEdionDom } from '../extensions/edion-monitor/collector.js';
import { runEdionPlan, sameEdionPage, fetchEdionHtml } from '../extensions/edion-monitor/runner.js';

const url = 'https://www.edion.com/item_list.html?keyword=beyblade+x';
function fixture(health = 'ready') {
  const calls = []; const saved = { enabled: true, bindings: { edion: { tabId: 1, url } } };
  let active = false;
  const chrome = { storage: { local: { get: async () => saved, set: async value => Object.assign(saved, value) } },
    tabs: { get: async () => ({ id: 1, url, active }), reload: async () => calls.push('reload'), create: async () => { calls.push('create'); return { id: 2, url }; } },
    scripting: { executeScript: async options => [{ result: options.func === fetchEdionHtml ?
      health === 'ready' ? { html: 'fixture-html', httpStatus: 200 } : { health, httpStatus: 403 }
      : { url, health, items: health === 'ready' ? [{ title: 'test' }] : [] } }] } };
  const reports = []; const request = async (endpoint, body) => {
    if (endpoint.endsWith('/check')) return { enabled: saved.enabled };
    reports.push(body); return { ok: true };
  };
  return { chrome, calls, saved, reports, request, pause: async () => {}, activate: () => { active = true; } };
}
test('擴充功能遭遇實際驗證時不重整、不點任何驗證控制', async () => {
  const f = fixture('verification_required');
  await runEdionPlan({ id: 'edion', url, scanId: 'scan', action: 'fetch' }, f);
  assert.deepEqual(f.calls, []); assert.equal(f.reports[0].observation.health, 'verification_required');
});
test('背景 GET 不重整、前景頁也不切換；舊 reload/observe 計畫不執行', async () => {
  const f = fixture(); const plan = { id: 'edion', url, scanId: 'scan', action: 'observe' };
  await runEdionPlan(plan, f); assert.deepEqual(f.calls, []);
  await runEdionPlan({ ...plan, action: 'reload' }, f); assert.deepEqual(f.calls, []);
  f.activate(); await runEdionPlan({ ...plan, action: 'fetch' }, f); assert.deepEqual(f.calls, []);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].observation.fetched, true);
  assert.equal(f.reports[0].observation.httpStatus, 200);
});
test('擴充功能或總開關停止時不開分頁、不重整、不回報商品', async () => {
  const f = fixture(); f.saved.enabled = false;
  await runEdionPlan({ id: 'edion', url, scanId: 'scan', action: 'reload' }, f);
  assert.deepEqual(f.calls, []); assert.equal(f.reports.length, 0);
});
test('網址驗證不接受外站、憑證或別的搜尋頁；參數排序可正常比較', () => {
  assert.equal(sameEdionPage(url, url), true);
  assert.equal(sameEdionPage('https://evil.test/item_list.html', url), false);
  assert.equal(sameEdionPage('https://user@www.edion.com/item_list.html?keyword=beyblade+x', url), false);
  assert.equal(sameEdionPage(url + '&page=2', url), false);
});
test('愛電王擴充沒有 cookies、webRequest 或 debugger 權限，也不觸碰蝦皮擴充', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../extensions/edion-monitor/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'scripting']);
  assert.equal(manifest.host_permissions.some(value => value.includes('shopee') || value.includes('<all_urls>')), false);
});

test('first-party GET accepts only same-origin listing, no navigation or security-header spoofing', async () => {
  let calls=0;
  const run=vm.runInNewContext('('+fetchEdionHtml.toString()+')',{URL,TextDecoder,Date,AbortSignal,location:{origin:'https://www.edion.com'},
    fetch:async (url,options)=>{calls++;assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.headers,undefined);
      return {ok:true,status:200,headers:new Headers({'content-type':'text/html;charset=utf-8'}),arrayBuffer:async()=>new TextEncoder().encode('x'.repeat(1000)).buffer};}});
  assert.equal((await run(url)).httpStatus,200);await run('https://evil.test/item_list.html');assert.equal(calls,1);
});

test('403/429 and transport timeouts produce restriction evidence, not extra fetches or challenge clicks', async () => {
  for(const status of [403,429,'timeout']){
    let calls=0;
    const run=vm.runInNewContext('('+fetchEdionHtml.toString()+')',{URL,TextDecoder,Date,AbortSignal,location:{origin:'https://www.edion.com'},
      fetch:async()=>{calls++;if(status==='timeout')throw new Error('timeout');return {ok:false,status,headers:new Headers({'retry-after':'7200'})};}});
    const result=await run(url);assert.equal(calls,1);assert.equal(result.health,status==='timeout'?'unreadable':'verification_required');
    assert.equal(result.html,undefined);if(status!== 'timeout')assert.equal(result.retryAfterSeconds,7200);
  }
});

function domParser() {
  return class {
    parseFromString(html) {
      const $=cheerio.load(html);
      const wrap=node=>node?.length?{get textContent(){return node.text();},get alt(){return node.attr('alt');},get src(){return node.attr('src');},
        closest:s=>wrap(node.closest(s)),matches:s=>node.is(s),getAttribute:n=>node.attr(n),querySelector:s=>wrap(node.find(s).first()),
        querySelectorAll:s=>node.find(s).toArray().map(el=>wrap($(el)))}:null;
      return {...wrap($.root()),title:$('title').text(),body:wrap($('body')),readyState:'complete'};
    }
  };
}
test('parsed HTML must match declared result count; unknown stock stays unknown; challenge and partial pages rejected',()=>{
  const run=vm.runInNewContext('('+collectEdionDom.toString()+')',{DOMParser:domParser(),URL,location:{href:url}});
  const card=(id,text)=>`<li><a href="/detail.html?p_cd=${id}">BEYBLADE X CX-13</a>￥2200 ${text}</li>`;
  const html=`<div class="resultArea">検索結果：2件中 1-2件 表示<ul>${card('123456','在庫数5台')}${card('123457','売り切れ')}</ul></div>`;
  const ready=run(html,url);assert.equal(ready.health,'ready');assert.equal(ready.items.length,2);assert.equal(ready.items[0].stock,5);assert.equal(ready.items[1].available,false);
  assert.equal(run(html.replace('1-2件','1-3件'),url).health,'unreadable');
  assert.equal(run('<title>Just a moment</title><script src="/cdn-cgi/challenge-platform/a.js"></script>',url).health,'verification_required');
  const unknown=run(`<div class="resultArea">検索結果：1件中 1-1件<ul>${card('123456','')}</ul></div>`,url);
  assert.equal(unknown.items[0].available,null);
});
