import {load} from 'cheerio';
import {readAndReleaseResponse} from './api-response.js';
import {FunboxCartError} from './funbox-cart.js';

const SHOP='https://shop.funbox.com.tw', MAP='https://emap.unipcsc.com.tw', CALLBACK='https://redirect.cyberbiz.co/seven_cvs_maps';
const fail=message=>{throw new FunboxCartError(message,'precheckout_unavailable');};
const normalized=value=>String(value||'').replace(/\s/g,'').replace(/門市$/,'');
const inputs=($,selector)=>Object.fromEntries($(selector).find('input[name]').toArray().map(n=>[$(n).attr('name'),$(n).attr('value')||'']));
export function validateFunboxStore(store,profile={}){
 if(!/^\d{6}$/.test(String(store?.storeid||''))||normalized(store?.storename)!==normalized(profile.storeName)||!store?.address||store.outside==='1')fail('7-11 門市識別、名稱或本島地址不符，未送單');
 return {...store,storeid:String(store.storeid)};
}
export function selectSevenSearchResult(text,name){
 const matches=String(text).trim().split(/\r?\n/).map(line=>line.split(',')).filter(s=>normalized(s[0])===normalized(name));
 if(matches.length!==1||matches[0][3]!=='enable'||matches[0][4]!=='門市'||!/^\d{6}$/.test(matches[0][1]))fail('指定 7-11 門市不唯一或官方不提供取件服務');
 return {storeid:matches[0][1],storename:matches[0][0]+'門市',address:matches[0][2]};
}
export function sevenMapLaunch(contract){
 const info=contract.props.mapInfos?.seven_map_info;if(!info)fail('官方缺少 7-11 選店跳轉資料');
 const {map_url,...params}=info;
 if(map_url!=='https://emap.presco.com.tw/c2cemapm-u.ashx'||params.url!==CALLBACK)fail('7-11 選店來源不符合已驗證的官方流程');
 let redirect;try{redirect=JSON.parse(Buffer.from(params.tempvar,'base64').toString()).redirect_url;}catch{fail('選店返回資料格式變更');}
 if(redirect!==contract.cartUrl+'/redirect_seven')fail('選店返回購物車與本帳號不符');
 return {url:map_url,params:{...params,servicetype:1}};
}
// Normal official e-map protocol via HTTP. No browser clicks, CAPTCHA bypass, or order creation.
export async function selectFunboxSevenStore({api,contract,profile,onStep=()=>{}}){
 await onStep({label:'開始官方 7-11 選店流程',state:'start',reason:`本帳號尚無可直接使用的指定門市資料；查詢 ${profile.storeName}，取得官方回傳，不自行猜測店號`});
 const get=async(url,options={})=>{
  const r=await api.get(url,{timeout:10000,maxRedirects:0,...options});const html=await readAndReleaseResponse(r);
  if(!r.ok())fail('7-11 官方查詢回應失敗');return html;
 };
 const post=async(url,form,referer)=>{
  const r=await api.post(url,{form,headers:{Origin:new URL(url).origin,Referer:referer},timeout:10000,maxRedirects:0});
  const html=await readAndReleaseResponse(r);if(!r.ok()||/訊息:M0001/.test(html))fail('7-11 官方選店暫時忙碌，未送單');return html;
 };
 const launch=sevenMapLaunch(contract);
 const gateway=load(await get(launch.url,{params:launch.params}));
 if(gateway('form').length!==1||gateway('form').attr('action')!==MAP+'/mobilemap/default.aspx')fail('7-11 選店入口格式變更');
 const html=await post(MAP+'/mobilemap/default.aspx',inputs(gateway,'form'),launch.url),top=load(html);
 const assignment=name=>html.match(new RegExp('var '+name+'\\s*=\\s*"([^"\\n]*)"'))?.[1];
 const category=assignment('storecategory'),eshopid=assignment('eshopid'),eshopparid=assignment('eshopparid');
 if(!category||!eshopid||!eshopparid||!top('#logID').attr('value'))fail('7-11 官方地圖工作階段不完整');
 await onStep({label:'官方電子地圖連線已建立',state:'success',reason:'已取得這台購物車專用的選店工作階段；下一步依門市名稱搜尋'});
 await get(MAP+'/mobilemap/Name/Default.aspx');
 const search=await post(MAP+'/mobilemap/Name/Data.aspx',{searchKey:normalized(profile.storeName),cate:category,eshopid,eshopparid,multiple_type:''},MAP+'/mobilemap/Name/Default.aspx');
 const selected=selectSevenSearchResult(search,profile.storeName);
 await onStep({label:'已找到指定取貨門市',reason:`7-11 官方查詢：${selected.storename}／店號 ${selected.storeid}；門市可接收包裹，下一步官方確認與回傳`,state:'success'});
 const mapped=await post(MAP+'/mobilemap/map.aspx',{...inputs(top,'form'),source:'Name',storeid:selected.storeid,eshopid,eshopparid,storecategory:category,remarkmsg:'undefined',showicon:'undefined'},MAP+'/mobilemap/default.aspx');
 const mapTop=load(mapped),mapPath=mapped.match(/mainFrame"\).src="([^"]+)"/)?.[1];
 if(!mapPath?.startsWith('Map/Default.aspx?')||mapTop('#backUrl').attr('value')!==CALLBACK)fail('7-11 門市確認頁格式變更');
 const detail=await get(MAP+'/mobilemap/'+mapPath);
 const storeid=detail.match(/var SelectSeven="([^"]+)"/)?.[1],multipleCode=detail.match(/var Multiple_type_code="([^"]+)"/)?.[1];
 if(storeid!==selected.storeid||!multipleCode)fail('7-11 地圖回傳不同的門市');
 await onStep({label:'門市確認頁已核對',state:'success',reason:`官方確認頁店號 ${storeid} 與搜尋結果一致；下一步確認門市可受理此配送服務`});
 const logID=mapTop('#logID').attr('value');
 const notify=await post(MAP+'/mobilemap/Info/NotifyUser.aspx',{storeid,multiple_type:'',multiple_type_code:multipleCode,logID},MAP+'/mobilemap/'+mapPath);
 if(!notify.includes('function OK()'))fail('7-11 門市提醒頁格式變更');
 const info=load(await get(MAP+'/mobilemap/Info/Default.aspx',{params:{StoreId:storeid,cate:category,multiple_type:'',logID}}));
 if(info('#txtCloseStore,#tr_Multiple_check').length)fail('此門市需要額外人工確認，未自動同意');
 const fields=Object.fromEntries(Object.entries({storeid:'hiddenstoreid',storename:'hiddenstorename',storeaddress:'hiddenstoreaddress',outside:'hiddenOutside',ship:'hiddenShip'}).map(([key,id])=>[key,info('#'+id).attr('value')||'']));
 validateFunboxStore({...fields,address:fields.storeaddress},profile);
 if(fields.storeid!==storeid)fail('7-11 最後確認門市不同');
 if(info('#hiddenMltiple_type_code').attr('value')==='A')await post(MAP+'/mobilemap/Info/ReCalculateStock.aspx',{mode:'recalculatestock',storeid,cate:category,EshopParid:eshopparid,Eshopid:eshopid},MAP+'/mobilemap/Info/Default.aspx');
 await onStep({label:'門市配送條件已確認',state:'success',reason:'官方未要求停業／特殊條件的人工確認；必要的包裹容量確認已完成，下一步回傳 FUNBOX'});
 const callback=await api.post(CALLBACK,{form:{...fields,TempVar:mapTop('#backTempvar').attr('value')},timeout:10000,maxRedirects:0});
 await readAndReleaseResponse(callback);let returned;
 try{returned=new URL(callback.headers().location);}catch{fail('7-11 返回官方商城的跳轉無法確認');}
 if(callback.status()!==302||returned.origin!==SHOP||returned.pathname!==new URL(contract.cartUrl).pathname+'/redirect_seven')fail('7-11 返回路徑不符合本帳號購物車');
 const redirected=await api.get(returned.href,{timeout:10000,maxRedirects:0});await readAndReleaseResponse(redirected);
 const next=new URL(redirected.headers().location||'',SHOP);
 if(redirected.status()!==302||next.origin!==SHOP||next.pathname!==new URL(contract.cartUrl).pathname+'/redirect_cvs')fail('FUNBOX 未接收官方門市回傳');
 const restored=load(await get(next.href));let props;
 try{props=JSON.parse(restored('#checkout-v3').attr('data-react-props'));}catch{fail('FUNBOX 回存門市資料無法解析');}
 if(props.cart?.token!==contract.props.cart.token)fail('回存門市購物車識別不符');
 const store=validateFunboxStore(props.storeInfo,profile);
 if(store.storeid!==storeid)fail('FUNBOX 回存門市不同');
 await onStep({label:'門市已回傳本帳號購物車',reason:`FUNBOX 官方回傳 ${store.storename}／${store.storeid}；尚未建立訂單，下一步核對取貨付款與金額`,state:'success'});
 return store;
}
