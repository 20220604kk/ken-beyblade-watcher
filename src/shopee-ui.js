export const shopeeHtml = `
<details class="card fold" id="shopee-panel">
  <summary style="flex-wrap:wrap"><span>🟠 蝦皮獨立監控</span><span id="shopee-connection" class="pill">尚未連接 Chrome</span></summary>
  <p class="compact-copy">沿用你平常 Chrome 的登入環境。僅通知、不自動下單；已知商品用唯讀直查，賣場頁低頻探索，遇到驗證會自動退避，不影響其他通路。</p>
  <div id="shopee-targets"></div>
  <details style="margin-top:16px" open><summary>新增／編輯蝦皮網址</summary>
    <form id="shopee-form" onsubmit="saveShopee(event)" oninput="shopeeDirty=true" style="margin-top:14px">
      <input id="shopee-id" type="hidden">
      <div class="shopee-grid">
        <label>監控名稱<input id="shopee-name" maxlength="70" required placeholder="例如 FUNBOX旗艦館・蝦皮"></label>
        <label>掃描間隔（秒）<input id="shopee-interval" type="number" min="30" max="3600" step="1" value="60" required></label>
        <label class="shopee-wide">蝦皮店內搜尋／商品網址<input id="shopee-url" type="url" required placeholder="https://shopee.tw/mall/search?keyword=beyblade&shop=285705541"></label>
        <label>每日開始（台灣時間）<input id="shopee-start" type="time" value="09:00" required></label>
        <label>每日結束（相同代表全天）<input id="shopee-end" type="time" value="22:00" required></label>
        <label class="shopee-wide">商品篩選關鍵字<textarea id="shopee-keywords" rows="2" required placeholder="beyblade，戰鬥陀螺"></textarea><small class="muted">最多 6 組，以換行、逗號或頓號分隔；任一組符合就保留。不增加搜尋請求；搜尋詞仍以網址為準。</small></label>
        <label>通知位置<select id="shopee-audience"><option value="private">私人管理頻道（試運行）</option><option value="public">公開陀螺販售情報</option><option value="mmtoy">MM小舖獨立通知</option><option value="shadow">只記錄、不推播</option></select></label>
        <div class="field"><label><input id="shopee-enabled" type="checkbox">啟用這個網址</label></div>
      </div>
      <div class="field" style="margin:14px 0"><label><input id="shopee-discovery" type="checkbox" checked>通知首次發現（可購狀態待確認）</label><label><input id="shopee-restock" type="checkbox" checked>通知已確認補貨</label></div>
      <div class="row"><button type="submit">儲存蝦皮設定</button><button type="button" class="secondary" onclick="newShopee()">清空，新增另一筆</button></div>
    </form>
  </details>
  <p class="compact-copy">每個網址使用獨立背景分頁。Chrome 必須保持開啟；約每 30 秒處理到期任務。FUNBOX 已知商品依你設定的間隔直查；整個賣場約每 10 分鐘探索一次新商品。驗證／限流會由 2 分鐘起自動退避，不改寫庫存基線，也不會以搜尋未出現判定售罄。</p>
  <details style="margin-top:16px"><summary>Chrome 連接與安裝</summary>
    <p class="compact-copy">本機擴充功能未安裝前，僅能儲存設定。擴充功能只讀取設定網址的商品與登入狀態，不讀取密碼或 Cookie。安裝需要你確認網站權限。</p>
    <p id="shopee-extension-path" class="shopee-path"></p>
    <p class="compact-copy">Chrome → 擴充功能 → 管理擴充功能 → 開發人員模式 → 載入未封裝項目，選擇上方資料夾。安裝後開啟擴充功能，貼上配對碼。</p>
    <button type="button" class="secondary" onclick="pairShopee()">產生／更換本機配對碼</button>
    <input id="shopee-pair-code" readonly type="password" autocomplete="off" aria-label="蝦皮本機配對碼" style="width:100%;margin-top:10px" placeholder="尚未產生；產生後請使用下方複製按鈕">
    <div class="row" style="margin-top:10px"><button id="shopee-copy-code" type="button" class="secondary" onclick="copyShopeePairCode()" disabled>複製配對碼</button><button type="button" class="secondary" onclick="toggleShopeePairCode(this)">顯示配對碼</button></div>
    <p id="shopee-pair-hint" class="compact-copy" role="status">配對碼是 64 字元，不是蝦皮簡訊驗證碼。不要複製畫面上的圓點。</p>
  </details>
  <p id="shopee-notice" class="notice" role="status"></p>
  <details><summary>蝦皮掃描與通知紀錄</summary><pre id="shopee-logs">尚無紀錄</pre><pre id="shopee-delivery">尚無通知</pre></details>
</details>`;
export const shopeeCss = `.shopee-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.shopee-grid label{display:grid;gap:8px;font-size:14px}.shopee-grid input,.shopee-grid select,.shopee-grid textarea{width:100%;min-width:0;font:inherit}.shopee-wide{grid-column:1/-1}.shopee-path{overflow-wrap:anywhere;font-size:14px}.shopee-target{padding:16px 0;border-bottom:1px solid #35415e}.shopee-target p{line-height:1.6;overflow-wrap:anywhere;font-size:14px}.shopee-target a{color:#78aefc;overflow-wrap:anywhere}@media(max-width:640px){.shopee-grid{grid-template-columns:minmax(0,1fr)}#shopee-panel .card-heading{align-items:flex-start;flex-wrap:wrap}}`;
export const shopeeClient = String.raw`
let shopeeDirty=false, shopeeLoaded=false;
function newShopee(){document.querySelector('#shopee-form').reset();document.querySelector('#shopee-id').value='';shopeeDirty=false;}
function editShopee(id){const t=(currentStatus.shopee?.targets||[]).find(t=>t.id===id);if(!t)return;if(shopeeDirty&&!confirm('放棄未儲存的蝦皮變更？'))return;for(const [key,value] of Object.entries({id:t.id,name:t.name,url:t.url,interval:t.intervalSeconds,start:t.activeStart,end:t.activeEnd,keywords:t.keywords.join('，'),audience:t.audience}))document.querySelector('#shopee-'+key).value=value;document.querySelector('#shopee-enabled').checked=t.enabled;document.querySelector('#shopee-discovery').checked=t.notifyDiscovery;document.querySelector('#shopee-restock').checked=t.notifyRestock;shopeeDirty=false;}
function renderShopee(s){const x=s.shopee||{};document.querySelector('#shopee-connection').textContent=x.connected?'Chrome 已連接':x.paired?'Chrome 未連接／心跳過期':'尚未配對 Chrome';document.querySelector('#shopee-connection').className='pill '+(x.connected?'ok':'');document.querySelector('#shopee-extension-path').textContent=x.extensionDirectory||'';
 const login={'logged-in':'已登入','logged-out':'未登入',unknown:'尚未驗證／資料過期'};
 const health={ready:'資料可讀（部分頁面）',blocked:'驗證／流量受阻，已自動退避','rate-limited':'請求過多，已自動退避','auth-required':'需要登入','parse-error':'資料不完整，已保留基線','read-error':'讀取失敗，已自動重試'};
 document.querySelector('#shopee-targets').innerHTML=(x.targets||[]).map(t=>'<div class="shopee-target"><strong>'+esc(t.name)+'</strong><p>登入：'+login[t.loginState]+'｜'+(!t.enabled?'已停用':!x.parentEnabled?'購物網站總開關已關閉':t.halted?'已暫停，待人工檢查':!x.connected?'等待 Chrome 連接':!t.withinHours?'等待時段':t.nextAllowedAt&&Date.parse(t.nextAllowedAt)>Date.now()?'自動退避至 '+fmt(t.nextAllowedAt):t.fresh?'已排程':'等待新資料')+'</p><p>'+esc(health[t.health]||'尚未收到真實掃描')+'｜最近：'+fmt(t.checkedAt)+'｜讀取 '+(t.readCount||0)+' 件／符合 '+(t.matchedCount||0)+' 件｜'+(t.transport==='pdp-api'?'唯讀商品直查':'頁面探索')+'</p><p>'+esc(t.activeStart+'～'+t.activeEnd)+'｜商品直查每 '+t.intervalSeconds+' 秒｜賣場探索約 10 分鐘｜'+esc(t.keywords.join('、'))+'</p><p><a href="'+esc(t.url)+'" target="_blank" rel="noopener noreferrer">'+esc(t.url)+'</a></p><div class="row"><button type="button" class="secondary" data-shopee-edit="'+esc(t.id)+'">編輯</button><button type="button" class="secondary" data-shopee-resume="'+esc(t.id)+'">立即重新排程</button><button type="button" class="danger" data-shopee-delete="'+esc(t.id)+'">刪除</button></div></div>').join('')||'<p class="muted">尚未設定蝦皮網址</p>';
 document.querySelectorAll('[data-shopee-edit]').forEach(b=>b.onclick=()=>editShopee(b.dataset.shopeeEdit));document.querySelectorAll('[data-shopee-resume]').forEach(b=>b.onclick=()=>shopeeAction('/shopee/resume',{id:b.dataset.shopeeResume}));document.querySelectorAll('[data-shopee-delete]').forEach(b=>b.onclick=()=>{if(confirm('刪除此蝦皮監控？'))shopeeAction('/shopee/settings',{action:'delete',id:b.dataset.shopeeDelete});});
 document.querySelector('#shopee-logs').textContent=(x.logs||[]).map(l=>fmt(l.at)+' '+l.message).join('\n')||'尚無掃描紀錄';document.querySelector('#shopee-delivery').textContent=(x.delivery||[]).map(e=>e.status+'｜'+e.title+(e.error?'｜'+e.error:'')).join('\n')||'尚無通知紀錄';if(!shopeeLoaded&&x.targets?.length){editShopee(x.targets[0].id);shopeeLoaded=true;}}
async function shopeeAction(url,body){try{const r=await api(url,body);document.querySelector('#shopee-notice').textContent=r.message||'已完成';await refresh();return r;}catch(e){document.querySelector('#shopee-notice').textContent=e.message;}}
async function saveShopee(e){e.preventDefault();const v=id=>document.querySelector('#shopee-'+id).value;const audience=v('audience');if(['public','mmtoy'].includes(audience)&&!confirm('啟用後，真實蝦皮事件將推送到選定的公開頻道。確認此設定？'))return;const r=await shopeeAction('/shopee/settings',{id:v('id')||undefined,name:v('name'),url:v('url'),intervalSeconds:Number(v('interval')),activeStart:v('start'),activeEnd:v('end'),keywords:v('keywords'),audience,enabled:document.querySelector('#shopee-enabled').checked,notifyDiscovery:document.querySelector('#shopee-discovery').checked,notifyRestock:document.querySelector('#shopee-restock').checked});if(r){shopeeDirty=false;if(r.id)document.querySelector('#shopee-id').value=r.id;}}
async function pairShopee(){if(!confirm('產生新配對碼會撤銷原本的 Chrome 連接，確定嗎？'))return;const r=await shopeeAction('/shopee/pair',{});if(r&&/^[a-f0-9]{64}$/.test(r.token||'')){document.querySelector('#shopee-pair-code').value=r.token;document.querySelector('#shopee-copy-code').disabled=false;document.querySelector('#shopee-pair-hint').textContent='已產生完整 64 字元配對碼，請按「複製配對碼」。';}}
async function copyShopeePairCode(){const input=document.querySelector('#shopee-pair-code'),hint=document.querySelector('#shopee-pair-hint');if(!/^[a-f0-9]{64}$/.test(input.value)){hint.textContent='請先產生新的配對碼。';return;}try{await navigator.clipboard.writeText(input.value);hint.textContent='已複製完整 64 字元。請到 Chrome 連接器貼上。';}catch{hint.textContent='瀏覽器未允許複製；請按「顯示配對碼」，點選欄位後 Ctrl+A、Ctrl+C 複製。';}}
function toggleShopeePairCode(button){const input=document.querySelector('#shopee-pair-code');input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'顯示配對碼':'隱藏配對碼';}
`;
