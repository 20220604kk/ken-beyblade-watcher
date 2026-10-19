import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { AmazonHttpCheckoutComparison } from '../scripts/amazon-http-checkout-comparison.mjs';

const make = () => new AmazonHttpCheckoutComparison({cookies:[],headers:{},baselineOrderIds:['000-0000000-0000000']});
test('HTTP comparison never submits twice',async()=>{
  const run=make(); run.submitted=true; run.verifyReview=()=>({totalYen:306});
  await assert.rejects(run.submitOnceAndConfirm(),/already attempted/);
});
test('HTTP comparison does not add without a private prior-order baseline',async()=>{
  const run=new AmazonHttpCheckoutComparison({cookies:[],headers:{}}); run.addForm={};
  await assert.rejects(run.addAndEnterCheckout(),/missing private order baseline/);
  assert.equal(run.addAttempted,false);
});
test('HTTP form excludes unchecked preferences and other submit buttons',()=>{
  const run=make(); const $=load('<form action="/cart/add-to-cart/x" method="post"><input name="asin" value="B00SIVY08Q"><input type="checkbox" name="setOrderingPrefs" value="1"><input type="submit" name="buy" value="1"><input type="submit" name="delete" value="1"></form>');
  const parsed=run.form({$ ,url:'https://www.amazon.co.jp/dp/B00SIVY08Q'},$('form'),'buy');
  assert.equal(parsed.fields.has('setOrderingPrefs'),false);
  assert.equal(parsed.fields.has('delete'),false);
  assert.equal(parsed.fields.get('buy'),'1');
});
test('HTTP form refuses an unexpected external origin',()=>{
  const run=make(); const $=load('<form action="https://example.org/buy" method="post"></form>');
  assert.throws(()=>run.form({$,url:'https://www.amazon.co.jp/dp/B00SIVY08Q'},$('form')),/origin/);
});
test('HTTP cookies stay within matching domains and paths',()=>{
  const run=make(); run.cookies=[{name:'allowed',value:'fake',domain:'.amazon.co.jp',path:'/'},{name:'other',value:'fake',domain:'example.org',path:'/'},{name:'wrongpath',value:'fake',domain:'.amazon.co.jp',path:'/ap/'}];
  assert.equal(run.cookieHeader(new URL('https://www.amazon.co.jp/checkout/entry/cart')),'allowed=fake');
});
