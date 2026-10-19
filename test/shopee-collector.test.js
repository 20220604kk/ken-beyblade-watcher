import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {collectShopeeDom,collectShopeePdp} from '../extensions/shopee-monitor/collector.js';
function element({display='block',rects=1,visibility='visible',children=[],text='',aria='',href=''}={}) {return {style:{display,visibility},children,innerText:text,href,getClientRects:()=>Array(rects).fill({}),getAttribute:name=>name==='aria-label'?aria:null,closest:()=>null};}
function collect(links,body='',pathname='/mall/search'){
 const document={readyState:'complete',body:{innerText:body},querySelectorAll:selector=>selector==='a[aria-label^="View product:"]'?links:[]};
 return vm.runInNewContext(`(${collectShopeeDom.toString()})(plan)`,{document,location:{href:'https://shopee.tw'+pathname,pathname,origin:'https://shopee.tw'},URL,getComputedStyle:e=>e.style,plan:{kind:'search',shopId:'285705541'}});
}
const card=(options={})=>element({display:'contents',rects:0,children:[element({display:'flex'})],aria:'View product: BEYBLADE X UX-21 惡魔冥界改造組',href:'https://shopee.tw/product/285705541/50417252581',text:'BEYBLADE X UX-21 惡魔冥界改造組',...options});
test('real Shopee display:contents anchor is read through its visible flex child',()=>{const r=collect([card()]);assert.equal(r.items.length,1);assert.equal(r.rendered,true);assert.equal(r.items[0].availability,'unknown');assert.equal(r.diagnostics.cardLinkCount,1);assert.equal(r.diagnostics.visibleCardCount,1);});
test('genuinely hidden cards remain ignored',()=>{assert.equal(collect([card({display:'none'})]).items.length,0);assert.equal(collect([card({visibility:'hidden'})]).items.length,0);assert.equal(collect([card({children:[]})]).items.length,0);});
test('same product deduplicated; other stores excluded',()=>{const r=collect([card(),card(),card({href:'https://shopee.tw/product/999/1'})]);assert.equal(r.items.length,1);});
test('captcha takes priority over stale cards',()=>{const r=collect([card()],'安全性驗證','/verify/captcha');assert.equal(r.rendered,false);assert.equal(r.items.length,0);assert.equal(r.accessText,'安全性驗證');});
async function pdp(payload,{status=200}={}) {
 const original={fetch:globalThis.fetch,document:globalThis.document,location:globalThis.location};
 globalThis.document={body:{innerText:''}};globalThis.location={href:'https://shopee.tw/verify/traffic/error'};
 globalThis.fetch=async()=>({ok:status>=200&&status<300,status,json:async()=>payload});
 try{return await collectShopeePdp({url:'https://shopee.tw/mall/search?keyword=beyblade&shop=285705541',shopId:'285705541',probeProducts:[{shopId:'285705541',itemId:'50417252581'}]});}
 finally{globalThis.fetch=original.fetch;globalThis.document=original.document;globalThis.location=original.location;}
}
test('read-only PDP probe maps canonical identity and available stock',async()=>{const r=await pdp({error:null,data:{item:{item_id:50417252581,shop_id:285705541,title:'BEYBLADE X UX-21',item_status:'normal',status:1,is_unavailable:false,has_model_with_available_shopee_stock:true,stock:2,models:[]}}});assert.equal(r.rendered,true);assert.equal(r.transport,'pdp-api');assert.equal(r.items[0].availability,'available');assert.equal(r.items[0].quantity,2);assert.equal(r.items[0].productUrl,'https://shopee.tw/product/285705541/50417252581');});
test('PDP unavailable is explicit; API errors never become fake stock zero',async()=>{const unavailable=await pdp({error:null,data:{item:{item_id:50417252581,shop_id:285705541,title:'BEYBLADE X UX-21',item_status:'normal',status:8,is_unavailable:false,has_model_with_available_shopee_stock:false,models:[{status:1}]}}});assert.equal(unavailable.items[0].availability,'unavailable');const failed=await pdp({error:90309999,data:null});assert.equal(failed.rendered,false);assert.deepEqual(failed.items,[]);assert.equal(failed.diagnostics.apiFailureCount,1);});
