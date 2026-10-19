import test from 'node:test';
import assert from 'node:assert/strict';
import {safePurchaseStep} from '../src/purchase-diagnostics.js';
import {purchaseEsliteViaApi} from '../src/auto-purchase.js';
import {esliteSheetStepsHtml} from '../src/eslite-purchase-ui.js';

const response=(body,status=200)=>({status:()=>status,ok:()=>status>=200&&status<300,json:async()=>body,dispose:async()=>{}});

test('同階段開始／完成使用同編號，重試不變成下一步，UI使用結構化編號',()=>{
  const start=safePurchaseStep({label:'購物車清空中',state:'start'});
  const end=safePurchaseStep({label:'購物車已清空並核對',state:'success'});
  assert.equal(start.displayLabel,'01｜購物車 清空中 0/1');
  assert.equal(end.displayLabel,'01｜購物車 完成 1/1');
  assert.equal(safePurchaseStep(end).displayLabel,end.displayLabel);
  const assigned=safePurchaseStep({label:'核對派單任務',state:'start',taskNumber:1});
  assert.equal(assigned.displayLabel,'02｜核對派單任務 本次取得任務 01 0/1');
  const html=esliteSheetStepsHtml({steps:[start,end,assigned]});
  assert.ok(html.includes(start.displayLabel));assert.ok(html.includes(end.displayLabel));
  assert.equal(safePurchaseStep({label:'官方明確拒單，準備有限重試',state:'retry'}).stepNumber,11);
});

for(const scenario of [{name:'順暢',lag:0,latency:250,busy:0},{name:'慢10秒',lag:10000,latency:250,busy:0},{name:'壅塞',lag:0,latency:1800,busy:2}]){
  test(`隔離 ${scenario.name}：ABCD送單、不清車、紅利0、明確拒單才重試`,async()=>{
    for(const slot of ['A','B','C','D']){
      let clock=scenario.lag,submits=0,added=false;const events=[],steps=[];
      const api={
        async get(){clock+=scenario.latency;events.push('cart-read');return response({cart:{cart_items:added?[{product_guid:'p',qty:1}]:[]}});},
        async delete(){assert.fail('購買流程不得清車');},
        async post(url,options){clock+=scenario.latency;events.push(url);if(url==='/api/v2/cart/items'){added=true;return response({product_guid:'p',response_quantity:1});}
          assert.equal(options.data.checkout.discount_point,0);submits++;if(submits<=scenario.busy)return response({success:false,error:'系統忙碌，請稍後再試'},422);return response({order_id:'MOCK-'+slot});}
      };
      const result=await purchaseEsliteViaApi({product:{id:'p',title:'隔離商品',stock:1},settings:{action:'checkout',accountSlot:slot,strictSingleProductOrder:true,payment:['A','C'].includes(slot)?'seven_cod':'virtual_atm_home'},
        checkoutTemplate:{checkout:{discount_point:150}},apiContext:api,prevalidated:true,now:()=>clock,onStep:s=>steps.push(s)});
      assert.equal(result.status,'ordered');assert.equal(submits,scenario.busy+1);
      assert.equal(events.includes('cart-delete'),false);
      assert.equal(steps[0].label,'核對派單任務');assert.equal(events[0],'/api/v2/cart/items');
      assert.ok(steps.some(s=>s.stepNumber===2&&s.progressCurrent===1));
    }
  });
}

test('不清車，殘留商品由送單前核對擋下，不送單',async()=>{
  let posts=0,deletes=0;
  await assert.rejects(purchaseEsliteViaApi({product:{id:'p'},settings:{action:'checkout'},checkoutTemplate:{checkout:{}},prevalidated:true,
    apiContext:{get:async()=>response({cart:{cart_items:[{product_guid:'old',qty:1}]}}),delete:async()=>deletes++,post:async()=>{posts++;return response({product_guid:'p',response_quantity:1});}}}));
  assert.equal(posts,1);assert.equal(deletes,0);
});

test('送單逾時只送一次，不能因重試機制重送',async()=>{
  let posts=0;const steps=[];
  const result=await purchaseEsliteViaApi({product:{id:'p'},settings:{action:'checkout'},checkoutTemplate:{checkout:{}},prevalidated:true,onStep:s=>steps.push(s),
    apiContext:{get:async()=>response({cart:{cart_items:[{product_guid:'p',qty:1}]}}),post:async url=>{if(url.includes('/cart/'))return response({product_guid:'p',response_quantity:1});posts++;throw Error('Timeout 15000ms exceeded');}}});
  assert.equal(result.status,'submitted_unconfirmed');assert.equal(posts,1);assert.equal(steps.at(-1).progressCurrent,0);
});
