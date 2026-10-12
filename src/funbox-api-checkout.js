import { load } from 'cheerio';
import { readAndReleaseResponse } from './api-response.js';
import { readFunboxCart, reconcileFunboxCart, FunboxCartError } from './funbox-cart.js';
import { validateFunboxDeliveryProfile } from './funbox-checkout.js';
import { safePurchaseStep, purchaseErrorSummary } from './purchase-diagnostics.js';
import {selectFunboxSevenStore,validateFunboxStore} from './funbox-api-pickup.js';
import { purchaseRequestBudget } from './purchase-deadline.js';

const ORIGIN = 'https://shop.funbox.com.tw';
const PRIVATE_ORDER = /^\/(?:account\/)?orders\/[a-z0-9]{32}\/?$/i;
const error = (message, status = 'needs_setup') => new FunboxCartError(message, status);
export function officialFunboxUrl(value, base = ORIGIN) {
  const url = new URL(value, base);
  if (url.origin !== ORIGIN || url.username || url.password) throw error('FUNBOX 回傳非官方位址，已停止');
  return url.href;
}

export function parseFunboxCheckoutContract(html, cartUrl) {
  const url = new URL(officialFunboxUrl(cartUrl));
  if (!/^\/carts\/[a-z0-9]{32}\/?$/i.test(url.pathname)) throw error('FUNBOX 購物車識別無效');
  const dom = load(html), node = dom('#checkout-v3[data-react-props]');
  if (node.length !== 1) throw error('FUNBOX 官方結帳資料格式變更');
  let props;
  try { props = JSON.parse(node.attr('data-react-props')); } catch { throw error('FUNBOX 結帳 JSON 無法解析'); }
  if (props.cart?.token !== url.pathname.split('/')[2] || !props.csrfToken || !Array.isArray(props.lineItems)
    || !props.cart?.customer || !Array.isArray(props.paymentItems)) throw error('FUNBOX 結帳資料不完整');
  const customer = props.cart.customer;
  if (!customer.email || !customer.mobile) throw error('FUNBOX 會員缺少結帳聯絡資料');
  if (props.isEticket || props.isForeignToTaiwanShop || props.isMultiCurrencyCheckout || props.shouldSyncExternalBonusPoints
    || props.requiresShipping !== true) throw error('FUNBOX 商品需要特殊結帳流程，API 不猜測送單');
  if ((props.shop?.cart_extra_inputs || []).some(field => field.required)) throw error('FUNBOX 有尚未支援的必填額外欄位');
  return { props, cartUrl: url.href.replace(/\/$/, ''), csrfToken: props.csrfToken };
}

export function buildFunboxAtmPayload(contract, choices, profile, maxTotal = Infinity, service = 'cyberbizpay_atm') {
  validateFunboxDeliveryProfile(profile);
  if (/金門|連江|澎湖/.test(profile.city)) throw error('離島宅配 API 尚未驗證，未送单');
  const payment = choices.payment_items?.find(p => p.service === service && p.cvs_payment === 'no');
  const shipping = choices.price_weight_shipping_rates?.find(s => s.name === '一般宅配'
    && s.shipping_class === 'ShippingRule' && s.deliverable_countries === 'On shore of Taiwan');
  if (!payment?.id || !shipping?.id || !shipping.payment_names?.includes(payment.label)) throw error('本車沒有相容的宅配付款選項','payment_unavailable');
  const price = contract.props.priceValidations;
  const subtotal = Number(price?.total_price_before_bonus_discount);
  const fee = Number(shipping.price), charge = Number(payment.payment_charge);
  const total = subtotal + fee + charge;
  if (!Number.isFinite(subtotal) || subtotal <= 0 || !Number.isFinite(fee) || fee < 0 || !Number.isFinite(charge)
    || charge < 0 || !Number.isFinite(total) || total > maxTotal) throw error('FUNBOX 結帳金額無法確認或超過授權上限');
  if (Number(price.third_party_discount || 0) || Number(price.tax || 0)) throw error('FUNBOX 額外折扣／稅務尚未支援，未送單');
  const customer = contract.props.cart.customer;
  const form = {
    cart_type: 'order', bonus_used: '0', 'shippable[type]': 'PriceBasedShippingRate',
    'shippable[id]': String(shipping.id), 'order[shipping_rate]': String(shipping.id),
    'order[payment_id]': String(payment.id), 'order[email]': String(customer.email),
    'order[mobile]': String(customer.mobile), 'order[note]': '',
    'order[einvoice_attributes][invoice_type]': 'default',
    total_price_frontend: String(total), 'config[save_cvs_customer_address]': 'false'
  };
  for (const prefix of ['billing', 'shipping']) {
    for (const [field, key] of Object.entries({ name:'fullName', phone:'phone', city:'city', district:'district', zip:'postalCode', address1:'address' })) {
      form[`order[${prefix}_address_attributes][${field}]`] = String(profile[key]);
    }
  }
  if (contract.props.hasSaveRecipientAddressPlugin) Object.assign(form, {
    is_home_delivery: 'true', shipping_address_option: 'new_shipping', billing_address_option: 'new_billing',
    'config[save_customer_address]': 'false'
  });
  return { form, total, subtotal, shippingFee: fee, paymentId: payment.id, shippingId: shipping.id };
}

export function buildFunboxCodPayload(contract,choices,profile,store,maxTotal=Infinity){
  validateFunboxStore(store,profile);
  if(!profile.fullName||!/^09\d{8}$/.test(profile.phone||''))throw error('7-11 收件姓名或手機不完整');
  const payment=choices.payment_items?.find(p=>p.service==='seven_cod'&&p.is_cod&&p.is_cvs&&p.shipping_rate==='seven_cod');
  if(!payment?.id)throw error('本車沒有 7-11 取貨付款選項','payment_unavailable');
  const subtotal=Number(contract.props.priceValidations?.total_price_before_bonus_discount);
  const fee=payment.vip_free_shipping||payment.coupon_free_shipping?0:Number(payment.payment_rate);
  const total=subtotal+fee+Number(payment.payment_charge);
  if(!Number.isFinite(total)||subtotal<=0||fee<0||Number(payment.payment_charge)<0||total>maxTotal)throw error('7-11 結帳金額不明或超過授權上限');
  if(Number(contract.props.priceValidations?.third_party_discount||0)||Number(contract.props.priceValidations?.tax||0))throw error('7-11 特殊折扣／稅務未支援');
  const customer=contract.props.cart.customer;
  const form={cart_type:'order',bonus_used:'0','shippable[type]':'Payment','shippable[id]':String(payment.id),
    'order[shipping_rate]':'seven_cod','order[payment_id]':String(payment.id),'order[email]':customer.email,'order[mobile]':customer.mobile,
    'order[note]':'','order[einvoice_attributes][invoice_type]':'default',total_price_frontend:String(total),
    'config[save_cvs_customer_address]':'true','order[shipping_address_attributes][seven_store_id]':store.storeid,
    'order[shipping_address_attributes][store_name]':store.storename};
  for(const prefix of ['shipping','billing'])Object.assign(form,{
    [`order[${prefix}_address_attributes][name]`]:profile.fullName,[`order[${prefix}_address_attributes][phone]`]:profile.phone,
    [`order[${prefix}_address_attributes][address1]`]:store.address});
  return {form,total,subtotal,shippingFee:fee,paymentId:payment.id,shippingId:'seven_cod',store};
}

export function parseFunboxOrderReceipt(html, url) {
  const dom = load(html);
  dom('script,style').remove();
  const text = dom('body').text().replace(/\s+/g, ' ').trim();
  const fields = Object.fromEntries(dom('.item_title').toArray().map(node => [dom(node).text().trim(), dom(node).next('.item_content').text().trim()]));
  // The cancellation modal and payment status are not the order lifecycle.
  const actions = dom('.order_info .order_action .text').toArray().map(node => dom(node).text().trim());
  const orderStatusLabel = actions.find(value => /^(?:已取消|訂單取消|已完成|訂單完成)$/.test(value))
    || fields['訂單狀態'] || fields['配送狀態'] || '';
  const orderStatus = /^(?:已取消|訂單取消)$/.test(orderStatusLabel) ? 'canceled'
    : /^(?:已完成|訂單完成)$/.test(orderStatusLabel) ? 'completed'
    : /^(?:已出貨|配送中)$/.test(orderStatusLabel) ? 'shipped'
    : /^(?:未出貨|備貨中|待出貨|訂單成立|處理中)$/.test(orderStatusLabel) ? 'ordered' : '';
  const orderNumber = dom('.order_name .value').first().text().trim()
    || text.match(/(?:訂單編號|訂單號碼|訂單序號)\s*[:：]?\s*([A-Z0-9-]{6,})/i)?.[1] || '';
  const bankCode = text.match(/(?:銀行代碼|轉帳銀行代號|銀行代號)\s*[:：]?\s*(\d{3})/)?.[1]
    || text.match(/轉帳銀行\s*[:：]\s*[^()（）]{1,40}[(（](\d{3})[)）]/)?.[1] || '';
  const bankAccount = text.match(/(?:虛擬帳號|轉帳帳號|繳款帳號|匯款帳號|銀行帳號)\s*[:：]?\s*(\d{10,20})/)?.[1]
    || (/您選擇的付款方式為\s*[:：]\s*虛擬ATM/i.test(text) ? text.match(/(?:^|\s)帳號\s*[:：]\s*(\d{10,20})/)?.[1] : '') || '';
  const paymentDeadline = text.match(/請於\s*(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*前完成轉帳/)?.[1]
    || text.match(/(?:付款|繳費|匯款)(?:期限|截止時間)\s*[:：]?\s*(\d{4}[-/]\d{2}[-/]\d{2}[^\s]{0,12}(?:\s+\d{2}:\d{2})?)/)?.[1] || '';
  const amountText = dom('.order_total_price').first().text();
  const amount = Number(amountText.replace(/[^\d.]/g, '')) || null;
  const products = dom('.order_line_items .table_row').toArray().map(node => {
    const row = dom(node), link = row.find('.line_item_title a[href*="/products/"]');
    return {url:link.length ? officialFunboxUrl(link.attr('href')) : '',title:link.text().replace(/\s+/g,' ').trim().replace(/\s+-\s*$/,''),
      quantity:Number(row.find('.line_item_price_quantity').text().match(/[x×]\s*(\d+)/)?.[1]) || null};
  });
  return { orderNumber, orderStatus, orderStatusLabel, paymentLabel: fields['付款方式'] || '', paymentStatus: fields['付款狀態'] || '',
    shippingLabel:fields['配送方式']||'',amount, bankCode, bankAccount, paymentDeadline, products, resultUrl: url };
}

// All calls are HTTP; only explicit busy rejections permit bounded serial retries.
export async function prepareFunboxAtmCheckout({ api, expected, deliveryProfile, pickupProfile, pickupSetup,
  payment='virtual_atm_home',allowLinepayFallback=false,maxTotal = Infinity, onStep = () => {} }) {
  await onStep({label:'讀取並核對本次購物車',state:'start',reason:'確認商品與數量，避免把其他商品混入本次訂單'});
  const initial = await readFunboxCart({ request: api });
  const result = reconcileFunboxCart(initial, expected);
  if (result.missing.length) throw error('FUNBOX API 核對缺少目標商品', 'cart_conflict');
  await onStep({label:'購物車商品核對完成',state:'success',reason:expected.map(i=>`${i.product.title} ×${i.quantity}`).join('、')+'；下一步讀取官方結帳資料'});
  await onStep({label:'讀取官方結帳資料',state:'start',reason:'讀取本帳號、這台購物車的最新配送、付款與金額資料；不使用其他帳號的資料'});
  const response = await api.get(initial.cartUrl, { timeout: 8000 });
  const html = await readAndReleaseResponse(response);
  if (response.status() !== 200 || response.url() !== initial.cartUrl) throw error('FUNBOX 結帳頁資料未能讀取', 'precheckout_unavailable');
  let contract = parseFunboxCheckoutContract(html, initial.cartUrl);
  if (contract.props.isNeedUpdateStocks) {
    if (contract.props.updateStocksOptions) throw error('官方自訂庫存同步流程尚未驗證，未送單');
    const stock = await api.post(ORIGIN + '/update_stocks/' + contract.props.cart.token, {
      headers:{'X-CSRF-Token':contract.csrfToken,'X-Requested-With':'XMLHttpRequest',Accept:'application/json'},timeout:8000});
    await readAndReleaseResponse(stock);
    if (!stock.ok()) throw error('FUNBOX 官方庫存同步失敗，未送單','precheckout_unavailable');
    const refreshed = await api.get(initial.cartUrl,{timeout:8000});
    const freshHtml = await readAndReleaseResponse(refreshed);
    if (!refreshed.ok() || refreshed.url() !== initial.cartUrl) throw error('同步後結帳資料未能讀取','precheckout_unavailable');
    contract = parseFunboxCheckoutContract(freshHtml,initial.cartUrl);
    await onStep({label:'官方庫存已同步',reason:'官方要求重新同步庫存；已完成並重新讀取結帳資料，下一步核對商品與數量',state:'success',httpStatus:stock.status()});
  }
  const rows = contract.props.lineItems.filter(i => i.type !== 'gift');
  if (rows.length !== expected.length || rows.some(row => !expected.some(item => String(row.variant_id) === String(item.product.variantId)
    && Number(row.quantity) === item.quantity))) throw error('FUNBOX 最新購物車與任務不符', 'cart_conflict');
  await onStep({label:'官方結帳資料核對完成',state:'success',reason:'結帳資料屬於本次購物車；品項與數量一致，下一步強制取消紅利折抵',httpStatus:response.status()});
  const headers = { 'X-CSRF-Token': contract.csrfToken, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', Origin: ORIGIN, Referer: contract.cartUrl };
  const reset = await api.post(contract.cartUrl + '/apply_bonus', { form: { bonus_used:'0', cart_type:'order' }, headers, timeout: 8000 });
  let bonus; try { bonus = JSON.parse(await readAndReleaseResponse(reset)); } catch { throw error('FUNBOX 紅利設定回應不明', 'precheckout_unavailable'); }
  if (!reset.ok() || bonus.bonus_used !== 0) throw error('FUNBOX 無法取消自動紅利折抵', 'precheckout_unavailable');
  await onStep({ label:'紅利折抵已歸零',reason:'官方已確認使用 0 點；下一步讀取可用配送與付款方式', state:'success', httpStatus:reset.status() });
  const options = await api.get(contract.cartUrl + '/shipping_rates_and_payment_method_items', {
    params: { bonus_used:0, cart_type:'order' }, headers, timeout:8000 });
  let choices; try { choices = JSON.parse(await readAndReleaseResponse(options)); } catch { throw error('FUNBOX 配送付款回應格式變更'); }
  if (!options.ok()) throw error('FUNBOX 無法讀取配送付款選項', 'precheckout_unavailable');
  await onStep({label:'可用配送與付款方式已取得',state:'success',reason:`已讀取官方即時選項；下一步選擇${payment==='seven_cod'?'7-11 取貨付款':'一般宅配 ATM'}，不是僅憑付款選項存在就判定訂單成功`,httpStatus:options.status()});
  let payload,actualPayment=payment;
  try{
    if(payment==='seven_cod'){
      if(!choices.payment_items?.some(p=>p.service==='seven_cod'&&p.is_cod))throw error('本車不提供 7-11 取貨付款','payment_unavailable');
      let store=contract.props.storeInfo;
      if(store)try{store=validateFunboxStore(store,pickupProfile);}catch{store=null;}
      if(!store&&pickupSetup?.storeInfo)store=validateFunboxStore(pickupSetup.storeInfo,pickupProfile);
      if(!store)store=await selectFunboxSevenStore({api,contract,profile:pickupProfile,onStep});
      else await onStep({label:'使用已記錄的取貨門市',state:'success',reason:`${store.storename}／店號 ${store.storeid}；與指定門市一致，跳過電子地圖查詢`});
      payload=buildFunboxCodPayload(contract,choices,pickupProfile,store,maxTotal);
    }else if(payment==='virtual_atm_home')payload=buildFunboxAtmPayload(contract,choices,deliveryProfile,maxTotal);
    else throw error('API 付款策略不支援');
  }catch(cause){
    if(!allowLinepayFallback||cause.purchaseStatus!=='payment_unavailable')throw cause;
    payload=buildFunboxAtmPayload(contract,choices,deliveryProfile,maxTotal,'line_pay');actualPayment='line_pay_home';
    await onStep({label:'改用最後補救：一般宅配 LINE Pay',reason:'官方未提供指定 ATM／取貨付款選項；尚未送單，改用相容的 LINE Pay，仍使用 0 點紅利；若成立只代表待付款，不會自動付款',state:'info'});
  }
  // A store round-trip can trigger site defaults. Reset again before any final POST.
  if(payment==='seven_cod'&&payload.store){
    const second=await api.post(contract.cartUrl+'/apply_bonus',{form:{bonus_used:'0',cart_type:'order'},headers,timeout:8000});
    let data;try{data=JSON.parse(await readAndReleaseResponse(second));}catch{throw error('選店後紅利回應不明','precheckout_unavailable');}
    if(!second.ok()||data.bonus_used!==0)throw error('選店後紅利未歸零，未送單','precheckout_unavailable');
    await onStep({label:'選店後再次確認紅利 0 點',state:'success',reason:'門市回傳後已再向官方設定並核對 0 點，避免網站重新套用紅利；下一步確認送單金額',httpStatus:second.status()});
  }
  await onStep({ label:'結帳方案與金額已確認',reason:`${actualPayment==='seven_cod'?'7-11 取貨付款／'+payload.store.storename:actualPayment==='line_pay_home'?'一般宅配／LINE Pay（待付款）':'一般宅配／ATM'}；商品 NT$${payload.subtotal}＋運費 NT$${payload.shippingFee}，總額 NT$${payload.total}；紅利 0 點`,state:'success', httpStatus:options.status() });
  return { ...payload, contract, headers,payment:actualPayment,requestedPayment:payment };
}

export async function submitFunboxAtmCheckout({ api, prepared, beforeSubmit = async () => {}, onStep = () => {}, now = Date.now,maxAttempts=3 }) {
  // Hook must persist the intent before POST. An unknown response is never resent.
  await beforeSubmit({ total: prepared.total, payment:prepared.payment||'virtual_atm_home' });
  const limit=Math.max(1,Math.min(3,Number(maxAttempts)||3)),deadline=now()+20000;
  let response, body;
  for(let attempt=1;attempt<=limit;attempt++){
  await onStep({label:'向官方送出訂單',attempt,state:'start',reason:`第 ${attempt}/${limit} 次；同帳號只送一個請求，等待官方回覆`});
  try {
    response = await api.post(prepared.contract.cartUrl + '/', {
      form: { ...prepared.form,bonus_used:'0', t:String(now()) }, headers:prepared.headers, maxRedirects:0, timeout:Math.max(1,Math.min(15000,deadline-now()))
    });
    const text = await readAndReleaseResponse(response);
    try { body = JSON.parse(text); } catch { body = null; }
  } catch (cause) {
    if (cause.purchaseStatus === 'deadline_exceeded' && cause.requestNotDispatched) throw cause;
    await onStep({label:'送單連線中斷，尚不能判定成敗',state:'unknown',attempt,reason:purchaseErrorSummary(cause)+'；請求可能已被接收，下一步只查訂單，不重送、不清車'});
    return { status:'submitted_unconfirmed', purchaseStatus:'submitted_unconfirmed', transport:'http_api',
      detail:'送單回應不明，禁止重送或清車，請查正式訂單', error:purchaseErrorSummary(cause) };
  }
  await onStep({ label:'收到官方送單回覆',reason:body?.success===true?'官方回覆接受，下一步到本帳號訂單列表核對正式單號':'尚未確認成立，正在判讀拒單或不明回覆', state:'info', httpStatus:response.status(),attempt });
  if (body?.success === false && !body.order_token && !body.orderToken && !body.url && !body.job_id && !body.jobId) {
    const busy=response.status()!==429&&/系統忙碌|系統繁忙|system.*busy|try again/i.test(JSON.stringify(body));
    if(busy&&attempt<limit&&deadline-now()>1500){
      await onStep({label:'官方明確拒單，準備有限重試',state:'retry',attempt,reason:`官方明確回覆本次未被接受；等待 ${250*attempt} 毫秒後重送本車，不重複加車`});
      await new Promise(resolve=>setTimeout(resolve,250*attempt));continue;
    }
    throw error(`FUNBOX 明確拒單，已嘗試 ${attempt}/${limit} 次；結束本任務，讓佇列處理下一商品`, response.status() === 429 ? 'rate_limited' : busy?'checkout_busy':'checkout_rejected');
  }
  const unknown = () => ({ status:'submitted_unconfirmed', purchaseStatus:'submitted_unconfirmed', transport:'http_api',
    detail:'FUNBOX 未提供可確認的訂單結果；禁止重送或清車，需查單' });
  if (!response.ok() || body?.success !== true || body.job_id || body.jobId || !body.url) return unknown();
  let resultUrl;
  try { resultUrl = officialFunboxUrl(body.url); } catch { return unknown(); }
  if (!PRIVATE_ORDER.test(new URL(resultUrl).pathname)) return { ...unknown(), resultUrl };
  return { status:'order_created_pending_details', resultUrl, transport:'http_api' };
  }
}

export async function readFunboxAtmOrder({ api, resultUrl, expected, total,payment='virtual_atm_home',store,timeoutMs=10000,onStep = () => {} }) {
  const url = new URL(officialFunboxUrl(resultUrl));
  if (!PRIVATE_ORDER.test(url.pathname)) throw error('FUNBOX 訂單位址格式未確認');
  const token = url.pathname.split('/').filter(Boolean).at(-1);
  // Verify ownership against the authenticated official order list.
  const list = await api.get(ORIGIN + '/account/orders', { timeout:timeoutMs });
  const listDom = load(await readAndReleaseResponse(list));
  const owned = listDom(`a[href="/account/orders/${token}"]`).length > 0;
  if (!list.ok() || !owned) throw error('新訂單尚未在本帳號官方列表確認', 'submitted_unconfirmed');
  await onStep({label:'新訂單已出現在本帳號列表',state:'success',reason:'已核對訂單歸屬，下一步讀取明細核對單號、商品、數量與金額',httpStatus:list.status()});
  const detailUrl = ORIGIN + '/account/orders/' + token;
  const response = await api.get(detailUrl, { timeout:timeoutMs });
  const html = await readAndReleaseResponse(response);
  if (!response.ok()) throw error('新訂單明細尚未能讀取', 'submitted_unconfirmed');
  const receipt = parseFunboxOrderReceipt(html, detailUrl);
  const paymentMatches=payment==='seven_cod'?/7-11.*(?:貨到付款|取貨付款)/i.test(receipt.paymentLabel):payment==='line_pay_home'?/LINE\s*Pay/i.test(receipt.paymentLabel):/ATM/i.test(receipt.paymentLabel);
  if (!receipt.orderNumber || !paymentMatches || /取消|失敗/.test(receipt.paymentStatus)
    || receipt.amount !== total) throw error('FUNBOX 訂單編號／付款／金額尚未核對一致', 'submitted_unconfirmed');
  if (receipt.products.length !== expected.length || !expected.every(item => receipt.products.some(row =>
    new URL(row.url).pathname === new URL(officialFunboxUrl(item.product.url)).pathname && row.quantity === item.quantity
    && row.title === item.product.title.replace(/\s+/g,' ').trim()))) throw error('FUNBOX 官方訂單品項／數量尚未核對一致', 'submitted_unconfirmed');
  if(payment==='seven_cod'&&(!receipt.shippingLabel.includes(store?.storeid)||!receipt.shippingLabel.includes(store?.storename)))throw error('正式訂單門市編號／名稱尚未確認','submitted_unconfirmed');
  await onStep({ label:'正式訂單已成立並核對完成',reason:`單號 ${receipt.orderNumber}；商品與數量一致；總額 NT$${receipt.amount}；${receipt.paymentLabel}${payment==='seven_cod'?'／'+store.storename:payment==='line_pay_home'?'，尚未完成付款':''}`,state:'success', httpStatus:response.status() });
  if(payment==='virtual_atm_home')try {
  const completion = await api.get(ORIGIN + '/orders/' + token, {timeout:10000});
  const paymentHtml = await readAndReleaseResponse(completion);
  if (completion.ok() && completion.url() === ORIGIN + '/orders/' + token) {
    const payment = parseFunboxOrderReceipt(paymentHtml, completion.url());
    if (payment.bankCode && payment.bankAccount && payment.paymentDeadline) {
      Object.assign(receipt, {bankCode:payment.bankCode,bankAccount:payment.bankAccount,paymentDeadline:payment.paymentDeadline,paymentUrl:completion.url()});
      await onStep({label:'ATM 轉帳資料已取得',reason:`銀行代碼 ${payment.bankCode}；轉帳帳號已記錄於訂單付款欄；期限 ${payment.paymentDeadline}；未執行匯款`,state:'success',httpStatus:completion.status()});
    }else{
      await onStep({label:'訂單成立，ATM 轉帳資料尚未齊全',state:'info',reason:'正式單號已確認，但銀行／轉帳帳號／期限尚未全部取得；不重複送單，保留訂單連結供查詢'});
    }
  }
  } catch (cause) {
    await onStep({label:'ATM 資訊待唯讀查詢',state:'info',reason:purchaseErrorSummary(cause)});
  }
  return { ...receipt, html };
}

export async function purchaseFunboxViaApi({ api, reconcileApi = api, expected, deliveryProfile,pickupProfile,pickupSetup, settings = {}, beforeSubmit, now = Date.now }) {
  const started = now(), steps = [];
  const emit = async step => { const safe = safePurchaseStep({ ...step, at:new Date(now()).toISOString(), elapsedMs:now()-started });
    steps.push(safe); await settings.onStep?.(safe); };
  try {
    const prepared = await prepareFunboxAtmCheckout({ api, expected, deliveryProfile,pickupProfile,pickupSetup,
      payment:settings.payment||'virtual_atm_home',allowLinepayFallback:settings.allowLinepayFallback!==false,maxTotal:settings.maxTotal ?? Infinity, onStep:emit });
    if (settings.verifyOnly) return { status:'checkout_ready', total:prepared.total, transport:'http_api', quantity:expected.reduce((s,i)=>s+i.quantity,0),
      payment:prepared.payment,store:prepared.store,detail:'純 HTTP 結帳資料已核對，紅利 0，未送單', durationMs:now()-started, timings:{ steps } };
    const baseline=await api.get(ORIGIN+'/account/orders',{timeout:5000});
    const baselineDom=load(await readAndReleaseResponse(baseline));
    if(!baseline.ok()||!baselineDom('a[href*="/account/logout"]').length)throw error('送單前無法建立本帳號查單基準，未送單','precheckout_unavailable');
    const tokens=$=>new Set($('a[href]').toArray().map(n=>$(n).attr('href')?.match(/^\/account\/orders\/([a-z0-9]{32})\/?$/i)?.[1]).filter(Boolean));
    const prior=tokens(baselineDom);
    await emit({label:'送單前查單基準已建立',state:'success',reason:'已記錄本帳號原有訂單；若送單回應逾時，將比對新增訂單，避免誤認舊單或重複下單'});
    const sent = await submitFunboxAtmCheckout({ api, prepared, beforeSubmit, onStep:emit, now,maxAttempts:settings.checkoutMaxAttempts });
    // After a POST, reserve a separate bounded GET-only reconciliation window.
    const readApi = purchaseRequestBudget(reconcileApi, { deadlineMs: 8000, now }).request;
    let receipt;
    for(let query=1;query<=2;query++){
      try{
        let url=sent.status==='order_created_pending_details'?sent.resultUrl:'';
        if(!url){
          await emit({label:'送單結果不明，唯讀查詢正式訂單',state:'unknown',attempt:query,reason:`第 ${query}/2 次查單；不重送、不切換 LINE Pay、不清空購物車`});
          const recent=await readApi.get(ORIGIN+'/account/orders',{timeout:4000});const dom=load(await readAndReleaseResponse(recent));
          if(!recent.ok())throw error('官方查單暫時失敗','submitted_unconfirmed');
          const fresh=[...tokens(dom)].filter(t=>!prior.has(t));
          if(fresh.length!==1)throw error('尚無唯一可確認的新訂單','submitted_unconfirmed');
          url=ORIGIN+'/account/orders/'+fresh[0];
        }
        receipt=await readFunboxAtmOrder({api:readApi,resultUrl:url,expected,total:prepared.total,payment:prepared.payment,store:prepared.store,timeoutMs:4000,onStep:emit});break;
      }catch(cause){
        await emit({label:'正式訂單暫未核對完成',state:'unknown',attempt:query,reason:purchaseErrorSummary(cause)});
        if(query===2)return {...sent,status:'submitted_unconfirmed',detail:'已完成 2 次唯讀查單仍不明；只保護此帳號，其他帳號與任務繼續',durationMs:now()-started,timings:{steps}};
        await new Promise(resolve=>setTimeout(resolve,400));
      }
    }
    const { html, ...safeReceipt } = receipt;
    return { ...safeReceipt, status:'ordered',payment:prepared.payment,store:prepared.store,transport:'http_api', quantity:expected.reduce((s,i)=>s+i.quantity,0),
      atmInfoReady:Boolean(receipt.bankCode && receipt.bankAccount && receipt.paymentDeadline),
      detail:prepared.payment==='line_pay_home'?'LINE Pay 待付款訂單已確認，尚未付款':'FUNBOX 純 HTTP 訂單已由本帳號官方明細確認', durationMs:now()-started, timings:{steps} };
  } catch (cause) {
    await emit({label:'本商品任務停止，未確認訂單成立',state:'failed',reason:purchaseErrorSummary(cause)+'；不記為購買成功，交由派單佇列決定下一步'});
    cause.timings = {steps}; cause.durationMs = now()-started; throw cause;
  }
}
