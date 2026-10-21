import test from 'node:test';
import assert from 'node:assert/strict';
import {FunboxEventDay,FUNBOX_EVENT_PRODUCTS,isFunboxEventDay,funboxEventDelay} from '../src/funbox-event-day.js';
import {FunboxMonitor} from '../src/funbox.js';
const at=time=>Date.parse('2026-10-21T'+time+'+08:00');
test('FUNBOX活動：只限台灣10/21，平常1秒，普通錯誤2秒，限流優先',()=>{
 assert.equal(isFunboxEventDay(at('09:30:00')),true);assert.equal(isFunboxEventDay(at('09:30:00')+86400000),false);
 assert.equal(funboxEventDelay(at('09:30:00')),1000);assert.equal(funboxEventDelay(at('09:30:00'),{failed:true}),2000);assert.equal(funboxEventDelay(at('09:30:00'),{failed:true,retryAfterMs:120000}),120000);
 assert.equal(funboxEventDelay(at('09:30:00')+86400000,{normalMs:3000}),3000);
});
test('FUNBOX活動：0930與0950各一則包含四個連結，重啟／重入不重複',async()=>{
 const state={data:{},writeSnapshot:async()=>{}},messages=[];let now=at('09:29:59');const options={state,now:()=>now,notify:async(text,options)=>{messages.push({text,options});return 'synthetic';}};
 const day=new FunboxEventDay(options);await day.tick();assert.equal(messages.length,0);
 now=at('09:30:00');await Promise.all([day.tick(),day.tick()]);assert.equal(messages.length,1);for(const p of FUNBOX_EVENT_PRODUCTS)assert.ok(messages[0].options.embeds[0].description.includes(p.url));
 await new FunboxEventDay(options).tick();assert.equal(messages.length,1);now=at('09:50:00');await day.tick();assert.equal(messages.length,2);
});
test('FUNBOX活動：各APP上架只推一次，庫存變動不推，通知不明不盲重送',async()=>{
 const state={data:{},writeSnapshot:async()=>{}},sent=[];let now=at('09:59:59');const day=new FunboxEventDay({state,now:()=>now,notify:async text=>{sent.push(text);if(text.includes('雄鹿'))throw new Error('synthetic timeout');}});
 const product={id:'bbpr07730',title:'【APP兌換】黃蜂'};await day.observe(product);assert.equal(sent.length,0);now=at('10:00:00');
 await Promise.all([day.observe(product),day.observe({...product,stock:50})]);await day.observe({...product,stock:0});assert.equal(sent.length,1);
 await day.observe({id:'bbpr07736',title:'【APP兌換】雄鹿'});await day.observe({id:'bbpr07736',title:'【APP兌換】雄鹿'});assert.equal(sent.length,2);assert.equal(day.status().notifications['listed-bbpr07736'].status,'unknown');
});
test('FUNBOX活動：原始APP商品仍排除一般購買，只有新鮮掃描傳通知觀察器',async()=>{
 const observed=[],candidates=[],state={data:{},save:async()=>{}};
 const monitor=new FunboxMonitor({state,sources:[{id:'only',url:'https://shop.funbox.com.tw/products.json'}],onExcludedProduct:p=>observed.push(p.id),onPurchaseCandidate:p=>candidates.push(p),fetcher:async()=>({ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify([{id:1,title:'【APP兌換】黃蜂',url:'/products/bbpr07730',price:999999,variants:[{id:10,inventory_quantity:500,inventory_policy:'deny'}]}])})});
 await monitor.scan();assert.deepEqual(observed,['bbpr07730']);assert.deepEqual(candidates,[]);assert.equal(Object.keys(state.data.commerce.funbox.seen).length,0);
});
test('FUNBOX活動：429後不呼叫資料源，並保留較長Retry-After',async()=>{
 let calls=0;const monitor=new FunboxMonitor({state:{data:{}},fetcher:async()=>{calls++;return{ok:false,status:429,headers:new Headers({'Retry-After':'120'})};}});
 const source={id:'test',url:'https://shop.funbox.com.tw/products.json'};const first=await monitor.fetchSource(source);assert.ok(first.retryAfterMs>=119000);await monitor.fetchSource(source);assert.equal(calls,1);
});
test('FUNBOX活動：搜尋依外層一秒排程讀取，不被完成時間快取變成隔輪才讀',async()=>{
 let calls=0;const monitor=new FunboxMonitor({state:{data:{}},sourceIntervalMs:()=>0,fetcher:async()=>{calls++;return{ok:true,status:200,headers:new Headers(),text:async()=>'[]'};}});
 const source={id:'search',url:'https://shop.funbox.com.tw/search/search.json',intervalMs:3000};await monitor.fetchSource(source);await monitor.fetchSource(source);assert.equal(calls,2);
});
