import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFunboxCheckoutContract, buildFunboxAtmPayload, submitFunboxAtmCheckout, parseFunboxOrderReceipt, officialFunboxUrl } from '../src/funbox-api-checkout.js';
const token = 'a'.repeat(32), cartUrl = 'https://shop.funbox.com.tw/carts/' + token;
const props = {csrfToken:'test-csrf',cart:{token,customer:{email:'test@example.invalid',mobile:'0900000000'}},lineItems:[],paymentItems:[],requiresShipping:true,
  shop:{cart_extra_inputs:[]},priceValidations:{total_price_before_bonus_discount:150}};
const html = p => `<div id="checkout-v3" data-react-props='${JSON.stringify(p)}'></div>`;
const profile = {fullName:'測試',phone:'0900000000',city:'桃園市',district:'中壢區',postalCode:'320',address:'測試地址'};
const choices = {payment_items:[{id:1,service:'cyberbizpay_atm',cvs_payment:'no',label:'虛擬ATM',payment_charge:0}],
  price_weight_shipping_rates:[{id:2,name:'一般宅配',shipping_class:'ShippingRule',deliverable_countries:'On shore of Taiwan',price:120,payment_names:['虛擬ATM']}]};
test('ATM payload uses current official payment and shipping choices; max price enforced',()=>{
  const contract=parseFunboxCheckoutContract(html(props),cartUrl);
  const p=buildFunboxAtmPayload(contract,choices,profile,500);
  assert.equal(p.total,270);assert.equal(p.form['order[payment_id]'],'1');assert.equal(p.form.bonus_used,'0');
  assert.equal(p.form['order[shipping_address_attributes][address1]'],profile.address);
  assert.throws(()=>buildFunboxAtmPayload(contract,choices,profile,200));
  assert.throws(()=>buildFunboxAtmPayload(contract,{...choices,payment_items:[]},profile));
});
test('ATM contract rejects changed cart identity, mandatory fields and special flows',()=>{
  assert.throws(()=>parseFunboxCheckoutContract(html({...props,cart:{...props.cart,token:'b'.repeat(32)}}),cartUrl));
  assert.throws(()=>parseFunboxCheckoutContract(html({...props,isEticket:true}),cartUrl));
  assert.ok(parseFunboxCheckoutContract(html({...props,useRedirectFlow:true}),cartUrl)); // store-selector setting, not an ATM restriction
  assert.throws(()=>parseFunboxCheckoutContract(html({...props,shop:{cart_extra_inputs:[{required:true}]}}),cartUrl));
  assert.throws(()=>officialFunboxUrl('https://evil.invalid/orders/'+token));
});
const response=(data,status=200)=>({status:()=>status,ok:()=>status===200,text:async()=>JSON.stringify(data),dispose:async()=>{}});
test('API sends only once, persists intent first, and treats timeout as unknown',async()=>{
  const events=[];let count=0;
  const result=await submitFunboxAtmCheckout({api:{post:async()=>{events.push('post');count++;throw new Error('Timeout 15000ms exceeded')}},
    prepared:{form:{},contract:{cartUrl},headers:{},total:270},beforeSubmit:async()=>events.push('intent')});
  assert.deepEqual(events,['intent','post']);assert.equal(count,1);assert.equal(result.status,'submitted_unconfirmed');
  assert.equal(result.error.includes('Call log'),false);
});
test('failed durable intent never submits; unrecognised and external redirects never count as success',async()=>{
  let count=0;const prepared={form:{},contract:{cartUrl},headers:{},total:270};
  const api={post:async()=>{count++;return response({success:true,url:'https://evil.invalid/pay'})}};
  await assert.rejects(submitFunboxAtmCheckout({api,prepared,beforeSubmit:async()=>{throw new Error('disk full')}}));
  assert.equal(count,0);
  assert.equal((await submitFunboxAtmCheckout({api,prepared})).status,'submitted_unconfirmed');
  assert.equal(count,1);
});
test('structured rejection is distinguished from accepted or ambiguous orders',async()=>{
  const prepared={form:{},contract:{cartUrl},headers:{},total:270};
  await assert.rejects(submitFunboxAtmCheckout({api:{post:async()=>response({success:false},422)},prepared}),e=>e.purchaseStatus==='checkout_rejected');
  const sent=await submitFunboxAtmCheckout({api:{post:async()=>response({success:true,url:'/orders/'+token})},prepared});
  assert.equal(sent.status,'order_created_pending_details');
  const queued=await submitFunboxAtmCheckout({api:{post:async()=>response({success:true,job_id:'x',url:'/orders/'+token})},prepared});
  assert.equal(queued.status,'submitted_unconfirmed');
});
test('order receipt requires actual number and independently records ATM fields',()=>{
  const result=parseFunboxOrderReceipt('<body><div class="order_name"><span class="value">BD-TEST001</span></div><div class="order_total_price">NT$270</div><div class="item_title">付款方式</div><div class="item_content">虛擬ATM</div><p>銀行代碼：013 轉帳帳號：12345678901234 請於 2026-10-11 12:00 前完成轉帳</p></body>','https://shop.funbox.com.tw/account/orders/'+token);
  assert.equal(result.orderNumber,'BD-TEST001');assert.equal(result.amount,270);assert.equal(result.bankCode,'013');
  assert.equal(result.bankAccount,'12345678901234');assert.equal(result.paymentDeadline,'2026-10-11 12:00');
});
