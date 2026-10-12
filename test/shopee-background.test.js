import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=(await readFile(new URL('../extensions/shopee-monitor/background.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
async function boot({enabled=true,token='fixture-only',alarm}={}) {
  const state={enabled,token}, calls={created:0,polls:0}, handlers={};
  const chrome={storage:{local:{get:async()=>({...state}),set:async v=>Object.assign(state,v)}},
    alarms:{get:async()=>alarm,create:async()=>{calls.created++;alarm={name:'shopee'};},onAlarm:{addListener:f=>handlers.alarm=f}},
    runtime:{onStartup:{addListener:f=>handlers.startup=f},onInstalled:{addListener:f=>handlers.installed=f},onMessage:{addListener:f=>handlers.message=f}}};
  vm.runInNewContext(source,{chrome,fetch:async()=>{calls.polls++;return {ok:true,json:async()=>({targets:[]})};},AbortSignal,Date,URL,setTimeout});
  await handlers.installed(); // Overlapping module start/install shares one restore.
  return {state,calls,handlers};
}
test('reload restores missing alarm using saved pairing and immediately polls once',async()=>{const r=await boot();assert.equal(r.calls.created,1);assert.equal(r.calls.polls,1);assert.equal(r.state.token,'fixture-only');});
test('existing alarm deadline is not reset during worker startup',async()=>{const r=await boot({alarm:{name:'shopee'}});assert.equal(r.calls.created,0);assert.equal(r.calls.polls,1);});
test('explicitly stopped connector stays stopped after reload',async()=>{const r=await boot({enabled:false});assert.equal(r.calls.created,0);assert.equal(r.calls.polls,0);});
test('unpaired connector never creates background scan work',async()=>{const r=await boot({token:''});assert.equal(r.calls.created,0);assert.equal(r.calls.polls,0);});
test('later browser startup reuses alarm and cannot create a duplicate schedule',async()=>{const r=await boot();await r.handlers.startup();assert.equal(r.calls.created,1);assert.equal(r.calls.polls,2);});
