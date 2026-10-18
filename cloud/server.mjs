import http from 'node:http';
import {readFile,mkdir,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {guard,Store} from './core.mjs';
import {sources,scan} from './sources.mjs';
export async function createCloud({file,fixture=false,once=false,env=process.env}={}) {
 guard({autoPurchase:false,checkout:false,payment:false,login:false,cookies:false},env);
 const store=await new Store(file||path.resolve('data/cloud/state.json')).load();
 // One writer per state file. A crashed instance leaves a lock requiring explicit recovery.
 await mkdir(path.dirname(store.file),{recursive:true});const lock=await open(store.file+'.lock','wx');await lock.writeFile(String(process.pid));
 let stopped=false;const timers=[];
 const status=()=>({mode:'monitoring-only',purchaseEnabled:false,notificationSink:'dry-run',fixture,uptimeSeconds:Math.floor(process.uptime()),stations:store.data.stations,eventCount:store.data.events.length,dryRunCount:store.data.sink.length});
 async function run(s){const started=Date.now();const metrics={httpStatus:null,parsedCount:0};let patch;try{const rows=await scan(s,fetch,metrics);for(const p of rows)await store.ingest({source:'cloud',site:s.id,productId:String(p.id||p.asin||p.url),stockSignature:String(p.available??p.status??'unknown'),price:p.price??p.priceYen??'',title:p.title,observedAt:new Date().toISOString()});patch={state:'ok',error:null,lastSuccess:new Date().toISOString(),hits:rows.length,latest:rows.slice(0,3).map(p=>p.title)};}catch(e){patch={state:'degraded',error:e.message+(e.cause?.message?' ('+e.cause.message+')':''),hits:0};}await store.transaction(d=>{const prev=d.stations[s.id]||{};d.stations[s.id]={...prev,...patch,...metrics,url:s.url,dataKind:'real',lastScan:new Date().toISOString(),latencyMs:Date.now()-started,successes:(prev.successes||0)+(patch.state==='ok'?1:0),failures:(prev.failures||0)+(patch.state==='ok'?0:1)};});if(!stopped&&!once)timers.push(setTimeout(()=>run(s),60000));}
 const server=http.createServer(async(req,res)=>{const json=(code,v)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(v));};try{
 if(req.method==='GET'&&req.url==='/health')return json(200,{ok:true,mode:'monitoring-only',sourcesHealthy:Object.values(store.data.stations).filter(x=>x.state==='ok').length});
 if(req.method==='GET'&&req.url==='/api/cloud/status')return json(200,status());
 if(req.method==='GET'&&req.url==='/api/cloud/events')return json(200,store.data.events.slice(-200).reverse());
 if(req.method==='POST'&&req.url==='/api/cloud/events') {if(req.headers['content-type']!=='application/json')return json(415,{error:'JSON required'});let body='';for await(const c of req){body+=c;if(body.length>16384)return json(413,{error:'Too large'});}const e=JSON.parse(body);return json(200,await store.ingest(e));}
 if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"});return res.end(await readFile(new URL('./dashboard.html',import.meta.url)));}
 json(404,{error:'Unavailable in monitoring-only runtime'});
 }catch(e){json(400,{error:e.message});}});
 if(!fixture)for(const s of sources)run(s).catch(e=>console.error('state failure',e.message));
 return {server,store,status,async close(){stopped=true;timers.forEach(clearTimeout);await new Promise(resolve=>server.close(resolve));await store.queue;await lock.close();await unlink(store.file+'.lock');}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const app=await createCloud({file:process.env.CLOUD_STATE_FILE,fixture:process.env.CLOUD_FIXTURE==='1',once:process.env.CLOUD_SCAN_ONCE==='1'});
 const port=Number(process.env.CLOUD_PORT||3320);if(port===3210)throw Error('Port 3210 prohibited');
 app.server.listen(port,'127.0.0.1',()=>console.log('Cloud monitoring-only listening on port '+port));
 for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>app.close().then(()=>process.exit(0)));
}
