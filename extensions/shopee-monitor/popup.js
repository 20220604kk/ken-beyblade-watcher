import {normalizePairingToken,validatePairingToken} from './pairing.js';
const status = document.querySelector('#status');
document.querySelector('#token').oninput=()=>{document.querySelector('#token-count').textContent='已貼上 '+normalizePairingToken(document.querySelector('#token').value).length+' / 64 字元（不顯示內容）';};
async function render(){const s=await chrome.storage.local.get(['enabled','lastPollAt','lastError']);status.textContent=(s.enabled?'連接已開啟':'已停止')+'｜最近本機連線：'+(s.lastPollAt?new Date(s.lastPollAt).toLocaleTimeString():'尚無')+(s.lastError?'｜'+s.lastError:'');}
document.querySelector('#connect').onclick=async()=>{const b=document.querySelector('#connect');b.disabled=true;status.textContent='正在連接…';try{const token=validatePairingToken(document.querySelector('#token').value);const r=await chrome.runtime.sendMessage({type:'connect',token});if(r.error)throw new Error(r.error);document.querySelector('#token').value='';document.querySelector('#token-count').textContent='配對碼已清除';await render();}catch(e){status.textContent=e.message;}finally{b.disabled=false;}};
document.querySelector('#stop').onclick=async()=>{await chrome.runtime.sendMessage({type:'disconnect'});await render();};
void render();
