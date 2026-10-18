import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function guard(config={}, env=process.env) {
  const walk=(v,p='')=>{for(const [k,x] of Object.entries(v||{})) {
    const q=p+'.'+k;
    if(/purchase|checkout|payment|login|cookie|webhook|credential|cart/i.test(k) && x!==false && x!==null && x!=='') throw Error('Forbidden cloud setting: '+q);
    if(x && typeof x==='object') walk(x,q);
  }}; walk(config);
  for(const [k,v] of Object.entries(env)) if(/(?:PURCHASE|CHECKOUT|BUY_ENABLED|PAYMENT|LOGIN|COOKIE|WEBHOOK|CART)/i.test(k)&&v&&!/^(false|0|off)$/i.test(v)) throw Error('Forbidden environment switch: '+k);
}
export function identity(e, windowMs=60000) {
  if(!['cloud','local'].includes(e.source)) throw Error('Invalid source');
  const site=String(e.site||'').trim().toLowerCase();
  const productId=String(e.productId||'').normalize('NFKC').trim();
  const t=Date.parse(e.observedAt);
  if(!site||!productId||!Number.isFinite(t)||typeof e.stockSignature!=='string'||!['string','number'].includes(typeof e.price)) throw Error('Invalid event');
  const signature=[site,productId,e.stockSignature,String(e.price).trim(),Math.floor(t/windowMs)];
  return {eventId:crypto.createHash('sha256').update(JSON.stringify(signature)).digest('hex'),site,productId};
}
export class Store {
  constructor(file){this.file=file;this.queue=Promise.resolve();this.data={version:1,events:[],stations:{},sink:[]};}
  async load(){try {this.data=JSON.parse(await fs.readFile(this.file,'utf8')); if(this.data.version!==1||!Array.isArray(this.data.events)||!this.data.stations||!Array.isArray(this.data.sink))throw Error('Invalid state');}catch(e){if(e.code!=='ENOENT')throw e;}return this;}
  transaction(fn){const op=this.queue.then(async()=>{const next=structuredClone(this.data);const result=fn(next);await fs.mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.'+process.pid+'.tmp';const f=await fs.open(tmp,'w',0o600);try{await f.writeFile(JSON.stringify(next,null,2));await f.sync();}finally{await f.close();}await fs.rename(tmp,this.file);this.data=next;return result;});this.queue=op.catch(()=>{});return op;}
  ingest(e){const key=identity(e);return this.transaction(d=>{let row=d.events.find(x=>x.eventId===key.eventId);const duplicate=!!row;if(!row){row={...key,stockSignature:e.stockSignature,price:e.price,window:Math.floor(Date.parse(e.observedAt)/60000),firstSeen:{},winner:e.source,title:String(e.title||e.productId).slice(0,300)};d.events.push(row);d.sink.push({eventId:key.eventId,kind:'dry-run',acceptedAt:new Date().toISOString()});}const prev=row.firstSeen[e.source];if(!prev||new Date(e.observedAt).toISOString()<prev)row.firstSeen[e.source]=new Date(e.observedAt).toISOString();row.winner=Object.entries(row.firstSeen).sort((a,b)=>a[1].localeCompare(b[1])||a[0].localeCompare(b[0]))[0][0];return {duplicate,event:row};});}
}
