// Authorized read-only ten-minute observation, NOT a stress/load generator.
// One request at a time, >=5s start spacing, <=120 requests, no purchases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';
import { AmazonHttpCheckoutComparison } from './amazon-http-checkout-comparison.mjs';

const recordRoot = path.resolve('data/records/amazon-http-tests');
const sessionFile = path.resolve(process.argv[2] || '');
if (path.dirname(sessionFile) !== recordRoot || path.basename(sessionFile) !== 'rate-session.tmp.json') throw new Error('Unexpected private session file');
let input;
try { input = JSON.parse(await fs.readFile(sessionFile,'utf8')); }
finally { await fs.unlink(sessionFile); }
const endpoint = new URL(input.url);
if (endpoint.origin !== 'https://www.amazon.co.jp' || !endpoint.pathname.startsWith('/gp/product/ajax/aodAjaxMain/')
  || endpoint.searchParams.get('asin') !== 'B00SIVY08Q') throw new Error('Only the observed read-only test-product AOD endpoint is allowed');
const client = new AmazonHttpCheckoutComparison(input);
input = null;
const durationMs=600000, intervalMs=5000, maximumRequests=120;
const clockStart=performance.now(), wallStart=new Date();
const localStamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(wallStart);
const basename='rate-observation-'+localStamp.replace(/[ :]/g,'-');
const outputBase=path.join(recordRoot,basename);
const rows=[], statuses={};
let stopReason=null, nextAt=clockStart, lastProgressAt=clockStart, consecutiveTransportErrors=0;
let interrupt=false, currentAbort;
process.on('SIGINT',()=>{interrupt=true;currentAbort?.abort();});
process.on('SIGTERM',()=>{interrupt=true;currentAbort?.abort();});
const summary=()=>({startedAt:wallStart.toISOString(),localStartedAt:localStamp,timeZone:'Asia/Taipei',
  elapsedSeconds:Math.round((performance.now()-clockStart)/1000),attempts:rows.length,statuses,
  validResponses:rows.filter(r=>r.validOfferResponse).length,stopReason});
console.log(JSON.stringify({event:'started',...summary(),durationSeconds:600,intervalSeconds:5,maxRequests:120,readonly:true}));
try {
  while(performance.now()-clockStart<durationMs && rows.length<maximumRequests && !interrupt) {
    while(performance.now()<nextAt && !interrupt) await delay(Math.min(1000,nextAt-performance.now()));
    if(interrupt || performance.now()-clockStart>=durationMs) break;
    const start=performance.now();
    const timestamp=new Date();
    const row={number:rows.length+1,timestamp:timestamp.toISOString(),
      time:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(timestamp),
      elapsedSeconds:Math.round((start-clockStart)/1000),method:'GET',path:endpoint.pathname};
    const headers={Cookie:client.cookieHeader(endpoint),Accept:'*/*'};
    for(const name of ['User-Agent','Accept-Language']) {
      const value=client.input.headers?.[name]||client.input.headers?.[name.toLowerCase()];
      if(value) headers[name]=value;
    }
    currentAbort=new AbortController();
    try {
      const response=await fetch(endpoint,{method:'GET',headers,redirect:'manual',signal:AbortSignal.any([currentAbort.signal,AbortSignal.timeout(15000)])});
      row.status=response.status;row.headersMs=Math.round(performance.now()-start);
      row.retryAfter=response.headers.get('retry-after');
      row.cacheAge=response.headers.get('age');row.cacheResult=response.headers.get('x-cache');
      client.updateCookies(response,endpoint);
      const html=await response.text(); row.bodyMs=Math.round(performance.now()-start);
      const $=load(html);
      row.offerCount=$('#aod-offer').length;
      row.validOfferResponse=response.status===200&&Boolean($('#aod-asin-title-text,#aod-filter-offer-count-string,#aod-offer').length);
      row.verificationRequired=Boolean($('form[action*="validateCaptcha"],input[name="amzn-captcha-verify"]').length)
        || /Robot Check|Enter the characters you see|画像に表示されている文字/i.test($('title,h1,h2').text());
      row.totalMs=Math.round(performance.now()-start);
      statuses[row.status]=(statuses[row.status]||0)+1;
      consecutiveTransportErrors=0;
      if(row.status===429) stopReason='explicit_rate_limit_429';
      else if(row.status===503) stopReason='service_unavailable_503_limit_not_proven';
      else if(row.verificationRequired) stopReason='human_verification_required';
      else if(row.retryAfter) stopReason='server_requested_wait';
      else if(row.status!==200) stopReason='http_'+row.status+'_not_a_proven_rate_limit';
      else if(!row.validOfferResponse) stopReason='unexpected_200_response';
    } catch(error) {
      row.errorName=error.name;row.totalMs=Math.round(performance.now()-start);
      consecutiveTransportErrors+=1;
      if(interrupt) stopReason='user_interrupted';
      else if(consecutiveTransportErrors>=3) stopReason='three_consecutive_transport_errors';
    } finally { headers.Cookie='';currentAbort=null; }
    rows.push(row);
    // Generated evidence contains no cookie/header values, bodies or tokens.
    await fs.writeFile(outputBase+'.json',JSON.stringify({...summary(),durationSeconds:600,intervalSeconds:5,rows},null,2));
    if(stopReason) break;
    const now=performance.now();
    if(now-lastProgressAt>=60000) {console.log(JSON.stringify({event:'progress',...summary()}));lastProgressAt=now;}
    // Never issue catch-up bursts if a response took longer than the interval.
    nextAt=start+intervalMs;
    if(nextAt<now) nextAt=now+intervalMs;
  }
  if(!stopReason && !interrupt) {
    while(performance.now()-clockStart<durationMs) await delay(Math.min(1000,durationMs-(performance.now()-clockStart)));
    stopReason='completed_ten_minutes';
  } else if(interrupt) stopReason='user_interrupted';
} finally {
  const times=rows.filter(r=>r.validOfferResponse).map(r=>r.totalMs).sort((a,b)=>a-b);
  const percentile=p=>times.length?times[Math.max(0,Math.ceil(times.length*p)-1)]:null;
  const result={...summary(),endedAt:new Date().toISOString(),durationSeconds:600,intervalSeconds:5,
    concurrency:1,maximumRequests:120,asin:'B00SIVY08Q',readonly:true,cartMutated:false,orderSubmitted:false,
    latencyMs:{min:times[0]??null,p50:percentile(.5),p95:percentile(.95),max:times.at(-1)??null},
    sessionFileDeleted:true,rows};
  await fs.writeFile(outputBase+'.json',JSON.stringify(result,null,2));
  await fs.writeFile(outputBase+'.txt','時間｜次數｜HTTP｜耗時｜結果\n'+rows.map(r=>`${r.time}｜${r.number}｜${r.status??r.errorName}｜${r.totalMs}ms｜${r.verificationRequired?'要求驗證':r.validOfferResponse?'報價正常':'異常'}`).join('\n')+'\n');
  client.input=null;client.cookies=[];
  console.log(JSON.stringify({event:'finished',...result,rows:undefined,jsonFile:outputBase+'.json',txtFile:outputBase+'.txt'}));
}
