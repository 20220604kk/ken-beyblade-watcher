// Offline research against the existing monitor, not a proposed replacement.
// Synthetic timings illustrate dependencies only; there is no network/browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { AmazonJapanMonitor } from '../src/amazon-jp-monitor.js';
const products = ['BX-52','BX-53','BX-09'].map((code,index)=>({
  asin:'B0TEST000'+(index+1),code,title:'BEYBLADE X '+code+' Fixture',priceYen:1000,
  msrpYen:1000,available:true,sellerConfirmed:true,
  url:'https://www.amazon.co.jp/dp/B0TEST000'+(index+1) }));
const catalog = products.map(p=>({code:p.code,name:'Fixture',normalizedName:'FIXTURE',msrpYen:1000}));
function fixture({ failSearch=false, omitPrice=false }={}) {
  let clock=0; const verified=[],signals=[],notices=[];
  const storage={initialized:true,searchDiscoveryVersion:1,
    products:Object.fromEntries(products.map(p=>[p.asin,{...p,available:false}])),
    manualProducts:Object.fromEntries(products.map(p=>[p.asin,{...p}])),catalog:[],brandProducts:{},xSignals:{}};
  const monitor=new AmazonJapanMonitor({dataDir:'',state:{data:{commerce:{amazonJp:storage}},save:async()=>{}},
    getConfig:()=>({watchProducts:[],watchBatchSize:3,backgroundBatchSize:1,priceToleranceYen:1}),
    notify:async()=>{notices.push(clock);clock+=1000;return 'fixture-notification';},
    onAvailabilitySignal:async p=>signals.push({asin:p.asin,at:clock}),log:()=>{}});
  monitor.ensureSeedSignals=async()=>{};
  monitor.refreshCatalog=async()=>omitPrice?catalog.slice(1):catalog;
  monitor.refreshBrandProducts=async()=>({});
  monitor.loadPage=async()=>{
    if(failSearch)throw new Error('synthetic search failure');
    return '<div data-component-type="s-search-result" data-asin="B0OTH00001"><h2>Accessory</h2><span class="a-price"><span class="a-offscreen">￥100</span></span></div>';
  };
  monitor.verifyOffer=async p=>{clock+=1000;verified.push({asin:p.asin,at:clock});return {...p,available:true,sellerConfirmed:true};};
  return {monitor,storage,verified,signals,notices};
}
const immediate=fixture(); await immediate.monitor.scan();
assert.deepEqual(immediate.verified.map(x=>x.at),[1000,2000,3000]);
assert.deepEqual(immediate.signals.map(x=>x.at),[1000,2000,3000]);
assert.equal(immediate.signals[0].at-immediate.verified[0].at,0);
const blocked=fixture({failSearch:true}); await assert.rejects(blocked.monitor.scan(),/synthetic search failure/);
assert.equal(blocked.verified.length,0);
const missing=fixture({omitPrice:true}); await missing.monitor.scan();
assert.equal(missing.verified.length,2); assert.equal(missing.storage.lastDirectCheckedCount,3);
const report={offline:true,syntheticTimingNotLiveBenchmark:true,networkRequests:0,ordersSubmitted:0,
  immediatePublication:{verifiedAtVirtualMs:immediate.verified.map(x=>x.at),publishedAtVirtualMs:immediate.signals.map(x=>x.at),
    finding:'signals are handed off per product, before later reads and notifications'},
  searchFailure:{directProductReads:blocked.verified.length,finding:'ordinary direct checks depend on successful seller search'},
  missingPrice:{selectedCount:missing.storage.lastDirectCheckedCount,actualProductReads:missing.verified.length,
    finding:'selected counter includes items skipped before loading their product page'}};
const dir=path.resolve('data/records/amazon-priority-research');await fs.mkdir(dir,{recursive:true});
const file=path.join(dir,'offline-dependency-replay-2026-10-16.json');
await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,file}));
