import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runEdionPlan, sameEdionPage } from '../extensions/edion-monitor/runner.js';

const url = 'https://www.edion.com/item_list.html?keyword=beyblade+x';
function fixture(health = 'ready') {
  const calls = []; const saved = { enabled: true, bindings: { edion: { tabId: 1, url } } };
  let active = false;
  const chrome = { storage: { local: { get: async () => saved, set: async value => Object.assign(saved, value) } },
    tabs: { get: async () => ({ id: 1, url, active }), reload: async () => calls.push('reload'), create: async () => { calls.push('create'); return { id: 2, url }; } },
    scripting: { executeScript: async () => [{ result: { url, health, items: health === 'ready' ? [{ title: 'test' }] : [] } }] } };
  const reports = []; const request = async (endpoint, body) => {
    if (endpoint.endsWith('/check')) return { enabled: saved.enabled };
    reports.push(body); return { ok: true };
  };
  return { chrome, calls, saved, reports, request, pause: async () => {}, activate: () => { active = true; } };
}
test('擴充功能遭遇實際驗證時不重整、不點任何驗證控制', async () => {
  const f = fixture('verification_required');
  await runEdionPlan({ id: 'edion', url, scanId: 'scan', action: 'reload' }, f);
  assert.deepEqual(f.calls, []); assert.equal(f.reports[0].observation.health, 'verification_required');
});
test('observe 計畫只觀測；reload 計畫在背景才重整，前景操作不中斷', async () => {
  const f = fixture(); const plan = { id: 'edion', url, scanId: 'scan', action: 'observe' };
  await runEdionPlan(plan, f); assert.deepEqual(f.calls, []);
  await runEdionPlan({ ...plan, action: 'reload' }, f); assert.deepEqual(f.calls, ['reload']);
  f.activate(); await runEdionPlan({ ...plan, action: 'reload' }, f); assert.deepEqual(f.calls, ['reload']);
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
