import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSevenSearchResult,sevenMapLaunch,validateFunboxStore} from '../src/funbox-api-pickup.js';
import {buildFunboxCodPayload,buildFunboxAtmPayload,submitFunboxAtmCheckout} from '../src/funbox-api-checkout.js';
import {EsliteRestockTasks} from '../src/eslite-restock-tasks.js';
const cartUrl='https://shop.funbox.com.tw/carts/'+'a'.repeat(32);
const profile={fullName:'測試人',phone:'0900000000',storeName:'新福街門市'};
const store={storeid:'253174',storename:'新福街門市',address:'桃園市測試路',outside:'0'};
test('official store search requires unique enabled exact name and no outside store',()=>{
 assert.equal(selectSevenSearchResult('新福街,253174,桃園市,enable,門市',profile.storeName).storeid,'253174');
 assert.throws(()=>selectSevenSearchResult('新福街,253174,桃園市,disable,門市',profile.storeName));
 assert.throws(()=>selectSevenSearchResult('新福街,253174,桃園市,enable,門市\n新福街,999999,台北市,enable,門市',profile.storeName));
 assert.throws(()=>validateFunboxStore({...store,outside:'1'},profile));
 assert.throws(()=>validateFunboxStore({...store,storename:'其他門市'},profile));
});
test('official map launch must return to this account cart',()=>{
 const props={mapInfos:{seven_map_info:{map_url:'https://emap.presco.com.tw/c2cemapm-u.ashx',url:'https://redirect.cyberbiz.co/seven_cvs_maps',tempvar:Buffer.from(JSON.stringify({redirect_url:cartUrl+'/redirect_seven'})).toString('base64')}}};
 assert.equal(sevenMapLaunch({cartUrl,props}).params.servicetype,1);
 assert.throws(()=>sevenMapLaunch({cartUrl:cartUrl.replace(/a/g,'b'),props}));
 assert.throws(()=>sevenMapLaunch({cartUrl,props:{mapInfos:{seven_map_info:{...props.mapInfos.seven_map_info,map_url:'https://evil.invalid'}}}}));
});
test('COD uses live official ids, zero bonus and correct store, not ATM shipping',()=>{
 const contract={props:{cart:{customer:{email:'test@example.invalid',mobile:'0900000000'}},priceValidations:{total_price_before_bonus_discount:150}}};
 const choices={payment_items:[{id:44,service:'seven_cod',is_cod:true,is_cvs:true,shipping_rate:'seven_cod',payment_rate:80,payment_charge:0}]};
 const result=buildFunboxCodPayload(contract,choices,profile,store,500);
 assert.equal(result.total,230);assert.equal(result.form.bonus_used,'0');assert.equal(result.form['shippable[type]'],'Payment');
 assert.equal(result.form['order[shipping_address_attributes][seven_store_id]'],'253174');
 assert.equal(result.form['config[save_cvs_customer_address]'],'true');
 assert.throws(()=>buildFunboxCodPayload(contract,choices,profile,store,200));
 assert.throws(()=>buildFunboxCodPayload(contract,{payment_items:[]},profile,store),e=>e.purchaseStatus==='payment_unavailable');
});
test('LINE Pay payload remains zero points, home delivery, and uses live compatible option',()=>{
 const contract={props:{cart:{customer:{email:'test@example.invalid',mobile:'0900000000'}},priceValidations:{total_price_before_bonus_discount:150}}};
 const choices={payment_items:[{id:5,service:'line_pay',cvs_payment:'no',label:'LINE Pay',payment_charge:0}],price_weight_shipping_rates:[{id:3,name:'一般宅配',shipping_class:'ShippingRule',deliverable_countries:'On shore of Taiwan',payment_names:['LINE Pay'],price:120}]};
 const p=buildFunboxAtmPayload(contract,choices,{fullName:'測試人',phone:'0900000000',city:'桃園市',district:'中壢區',postalCode:'320',address:'測試地址'},500,'line_pay');
 assert.equal(p.form.bonus_used,'0');assert.equal(p.form['order[payment_id]'],'5');assert.equal(p.total,270);
});
const response=(data,status=200)=>({status:()=>status,ok:()=>status===200,text:async()=>JSON.stringify(data),dispose:async()=>{}});
test('only explicit busy rejection permits bounded serial submission; never simultaneous',async()=>{
 let count=0,inFlight=0,maxFlight=0;const events=[];
 const api={post:async()=>{inFlight++;maxFlight=Math.max(maxFlight,inFlight);count++;inFlight--;return count<3?response({success:false,message:'系統忙碌'},422):response({success:true,url:'/orders/'+'b'.repeat(32)})}};
 const result=await submitFunboxAtmCheckout({api,prepared:{total:230,form:{bonus_used:'150'},contract:{cartUrl},headers:{},payment:'seven_cod'},beforeSubmit:async()=>events.push('intent')});
 assert.equal(result.status,'order_created_pending_details');assert.equal(count,3);assert.equal(maxFlight,1);assert.equal(events.length,1);
 count=0;await assert.rejects(submitFunboxAtmCheckout({api:{post:async()=>{count++;return response({success:false,message:'系統忙碌'},422)}},prepared:{total:230,form:{},contract:{cartUrl},headers:{}}}),e=>e.purchaseStatus==='checkout_busy');assert.equal(count,3);
});
test('each account product has bounded event attempts, a new stock epoch can start fresh',()=>{
 let now=100000;const tasks=new EsliteRestockTasks({now:()=>now,maxAttempts:3});
 const product={id:'p',url:'https://example.invalid/p',available:true,stock:10,freshObservationAt:new Date(now).toISOString()};
 tasks.observe(product,{activate:true});
 for(let i=0;i<3;i++){tasks.complete('p','p:A',{purchaseStatus:'checkout_busy'},'A');now+=25000;tasks.observe({...product,freshObservationAt:new Date(now).toISOString()});}
 assert.match(tasks.reason('p','p:A','A'),/上限/);assert.equal(tasks.reason('p','p:B','B'),'');
 tasks.observe({...product,available:false,freshObservationAt:new Date(now).toISOString()});now++;tasks.observe({...product,freshObservationAt:new Date(now).toISOString()});
 assert.equal(tasks.reason('p','p:A','A'),'');
});
