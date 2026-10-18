import {readFile} from 'node:fs/promises';
const port=Number(process.env.CLOUD_PORT||3320);
if(!Number.isInteger(port)||port<1024||port>65535||port===3210)throw Error('Invalid cloud port');
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
for(const e of Array.isArray(input)?input:[input]){
 const r=await fetch(`http://127.0.0.1:${port}/api/cloud/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(e)});
 if(!r.ok)throw Error(await r.text());console.log(await r.text());
}
