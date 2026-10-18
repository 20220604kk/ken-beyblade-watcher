import {parseFunboxResponse,FUNBOX_BEYBLADE_URL} from '../src/funbox.js';
import {parseEsliteSearchData,parseShoppingPage} from '../src/shopping-sites.js';
import {parseJapanAuctionPage,JAPAN_1999_BEYBLADE_LIST_URL} from '../src/japan-auctions.js';
import {parseAmazonSellerSearch,AMAZON_JP_SEARCH_URL,amazonJapanPageIssue} from '../src/amazon-jp-monitor.js';
export const sources=[
{id:'funbox',url:FUNBOX_BEYBLADE_URL,parse:(s,u)=>parseFunboxResponse(s,u)},
{id:'eslite',url:'https://holmes.eslite.com/v1/search?q=beyblade&sort=desc&final_price=0,&exp=c&page_no=1&page_size=20&facet=false',parse:(s)=>parseEsliteSearchData(JSON.parse(s))},
{id:'shopping',url:'https://www.momoshop.com.tw/search/searchShop.jsp?keyword=BEYBLADE',parse:parseShoppingPage},
{id:'japan',url:JAPAN_1999_BEYBLADE_LIST_URL,parse:(s,u)=>parseJapanAuctionPage(s,{url:u,sourceType:'1999'})},
{id:'amazon',url:AMAZON_JP_SEARCH_URL,parse:(s,u)=>{const issue=amazonJapanPageIssue({html:s,body:s});if(issue)throw Error(JSON.stringify(issue));return parseAmazonSellerSearch(s,u);}}
];
// Fixed public search destinations only. No credentials, cookie jar, browser sessions,
// arbitrary URLs, cart, login or purchase operations are exposed by this runtime.
export async function scan(source,fetcher=fetch,metrics={}){
 const r=await fetcher(source.url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(12000),headers:{accept:'text/html,application/json'}});
 metrics.httpStatus=r.status;metrics.contentType=r.headers.get('content-type');
 if(!r.ok)throw Error('HTTP '+r.status);
 const bytes=await r.arrayBuffer();if(bytes.byteLength>8000000)throw Error('Response too large');
 const charset=/charset=([\w-]+)/i.exec(metrics.contentType||'')?.[1]||'utf-8';
 metrics.charset=charset;const text=new TextDecoder(charset).decode(bytes);
 if(/captcha|robot check|just a moment|attention required|access denied/i.test(text))throw Error('Blocked or verification page; no browser bypass');
 const rows=source.parse(text,source.url);if(!Array.isArray(rows))throw Error('Invalid parser result');
 metrics.parsedCount=rows.length;metrics.emptyResult=rows.length===0;
 return rows;
}
