import { catalogHtml, catalogCss, catalogClient } from './product-sheet-ui.js';

export const overviewHtml = `
  <div class="connection-strip"><span id="dashboard-connection" role="status">正在連線…</span><span>關閉控制台不會停止監控</span></div>
  <main id="tab-overview" class="tab-panel" role="tabpanel" aria-labelledby="tab-button-overview" hidden>
    <div class="page-title"><div><div class="eyebrow">LIVE OVERVIEW</div><h2>監控總覽</h2><p>看掃描、看異常，再進入需要調整的網站。</p></div><span id="overview-updated" class="muted"></span></div>
    <section id="system-pause-card" class="card system-pause-card"><div><strong id="system-pause-title">需要玩遊戲時</strong><p id="system-pause-copy">一鍵停止所有掃描、登入心跳、自動下單與背景瀏覽器；控制頁仍會保留，之後可恢復原本設定。</p></div><button id="system-pause-button" class="danger" type="button" onclick="toggleSystemPause()">停止全部功能</button></section>
    <div id="overview-metrics" class="overview-metrics"></div>
    <section class="card overview-alerts" id="overview-alert-card" hidden><div class="card-heading"><h2>需要留意</h2><span id="overview-alert-count" class="pill"></span></div><div id="overview-alerts"></div></section>
    <section class="card"><div class="card-heading"><h2>掃描來源</h2><label class="overview-filter"><input id="overview-show-paused" type="checkbox" onchange="renderOverview(currentStatus)"> 顯示暫停來源</label></div><div class="overview-table-wrap"><table class="overview-table"><thead><tr><th>來源</th><th>狀態</th><th>掃描週期</th><th>最近完成</th><th>品項／專頁</th></tr></thead><tbody id="overview-sources"></tbody></table></div></section>
    <div class="overview-bottom"><section class="card"><h2>自動下單</h2><p class="compact-copy">命中購買條件後執行，各帳號與任務獨立。</p><div id="overview-orders" class="overview-orders"></div></section><section class="card"><h2>執行效能</h2><div id="overview-performance"></div><p class="compact-copy">這裡顯示主程式用量；完整 APP 負載另包含背景瀏覽器。</p></section></div>
    ${catalogHtml}
  </main>`;

export const overviewCss = `
${catalogCss}
body{max-width:1240px;padding-top:24px;background:#0b1020}.hero{margin-bottom:20px}.hero-copy{font-size:14px}.brand-mark{box-shadow:none}.tab-bar{box-shadow:none;backdrop-filter:none;grid-template-columns:repeat(5,minmax(0,1fr));position:sticky;top:8px;z-index:10;background:#121c30}.card{box-shadow:none;border-radius:14px;padding:20px;margin:14px 0}.page-title{justify-content:space-between;align-items:center}.page-title h2{font-size:25px}.page-title p{font-size:14px;margin-top:6px}.card h2{font-size:17px}.fold>summary{font-size:16px;min-height:24px}.fold>summary h2{margin:0}.fold>summary .pill{font-size:12px;margin-left:auto}.fold>summary>div{flex:1}.fold>summary .compact-copy{display:none}.compact-copy{font-size:13px;line-height:1.65;margin:8px 0 14px}.section-kicker{display:none}.tab-panel[hidden]{display:none!important}.connection-strip{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:#9eabc3;padding:10px 2px}.connection-strip .bad{color:#ff999e}.overview-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.overview-metric{padding:19px;background:#141c30;border:1px solid #293754;border-radius:12px}.overview-metric strong{display:block;font-size:29px;line-height:1.3;margin:6px 0;color:#edf2f7}.overview-metric span,.overview-metric small{font-size:12px;color:#aab9d1}.overview-metric .ok{color:#65dbad}.overview-metric .bad{color:#ffab82}.overview-alerts{border-color:#735039;background:#231c23}.overview-alert{padding:11px 0;border-bottom:1px solid #584338}.overview-alert:last-child{border-bottom:0}.overview-alert strong{display:block;font-size:14px}.overview-alert p{margin:5px 0;color:#dec6b9;font-size:13px;overflow-wrap:anywhere}.overview-link{background:none;border:0;color:#84b9ff;padding:2px 0;text-align:left;line-height:1.6;font-size:14px}.overview-link:hover{text-decoration:underline}.overview-table{width:100%;border-collapse:collapse;font-size:13px}.overview-table th{text-align:left;color:#9eabc3;font-size:12px;font-weight:500;padding:15px 10px}.overview-table td{padding:13px 10px;border-top:1px solid #28344d}.overview-table td:first-child{width:43%}.overview-table th:nth-child(n+2),.overview-table td:nth-child(n+2){white-space:nowrap}.overview-table .pill{font-size:12px;padding:4px 9px}.overview-filter{display:flex;align-items:center;gap:7px;font-size:12px;color:#aab9d1}.overview-filter input{width:15px;min-width:0;margin:0}.overview-bottom{display:grid;grid-template-columns:1fr 1fr;gap:14px}.overview-orders{display:flex;flex-wrap:wrap;gap:8px}.overview-orders button{font-size:12px;padding:8px 11px;background:#21314c}.perf-line{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid #26334a;font-size:13px;color:#bac7da}.perf-line strong{color:#edf2f7;font-variant-numeric:tabular-nums}.overview-table-wrap{overflow-x:auto}.quick-nav{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 18px}.quick-nav button{background:#1c2a43;color:#bcd6fa;font-size:12px;padding:8px 12px}.notice:empty,.bad:empty{display:none}.product-row{padding:12px 0}.japan-target-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.notification-demo-card{opacity:.9}.discord-route-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.discord-route.mmtoy{display:none}.product-thumb{content-visibility:auto}.fold:not([open]){padding-top:17px;padding-bottom:17px}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid #84b9ff;outline-offset:4px}@media(max-width:760px){body{padding:16px 12px 40px}.hero h1{font-size:25px}.tab-bar{display:flex;overflow-x:auto;gap:4px;border-radius:12px}.tab-button{flex:0 0 auto;padding:11px 13px;font-size:13px}.overview-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.overview-metric{padding:14px}.overview-metric strong{font-size:25px}.overview-bottom,.japan-target-grid{grid-template-columns:1fr}.overview-table td,.overview-table th{padding:11px 7px}.overview-table{min-width:580px}.connection-strip{font-size:11px}.card{padding:16px}.page-title #overview-updated{display:none}.discord-route-grid{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important;animation:none!important}}
.page-title{justify-content:flex-start}#tab-overview>.page-title{justify-content:space-between}.tab-panel:not(.show-paused) .page-group.paused,.tab-panel:not(.show-paused) .japan-target-card.paused{display:none}.quick-nav button[aria-pressed="true"]{background:#305185;color:#fff}.system-pause-card{display:flex;align-items:center;justify-content:space-between;gap:18px;border-color:#5c3b46;background:#1c1722}.system-pause-card strong{display:block;font-size:16px;color:#f3f6fb}.system-pause-card p{margin:7px 0 0;color:#b6bfd0;font-size:13px;line-height:1.6}.system-pause-card button{min-width:154px;white-space:nowrap}.system-pause-card.paused{border-color:#6c5731;background:#201d17}.system-pause-card.paused button{background:#2d805c}@media(max-width:620px){.system-pause-card{align-items:stretch;flex-direction:column}.system-pause-card button{width:100%}}
`;

export const overviewClient = `
${catalogClient}
function setHtmlIfChanged(id,html){const el=document.getElementById(id);if(el&&el._lastHtml!==html){el.innerHTML=html;el._lastHtml=html;}}
function renderOverview(s){
  if(!s?.overview)return;
  const o=s.overview,sources=o.sources||[],live=sources.filter(x=>!['paused','scheduled'].includes(x.state));
  const alerts=sources.filter(x=>['error','stale'].includes(x.state));
  const orderAlerts=(o.orders||[]).filter(x=>x.enabled&&x.error);
  const orders=(o.orders||[]).filter(x=>x.enabled);
  const channels=Object.values(o.notifications||{}).filter(Boolean).length;
  setHtmlIfChanged('overview-metrics',[
    ['監控中',live.length,'來源獨立排程',''],['待查看',alerts.length+orderAlerts.length,'讀取異常／資料過久',alerts.length+orderAlerts.length?'bad':'ok'],
    ['Discord 設定',channels+' / 3','公開・日拍・私人',''],['下單待命',orders.length,'排隊 '+(o.queued||0)+' 件','']
  ].map(x=>'<div class="overview-metric"><span>'+x[0]+'</span><strong class="'+x[3]+'">'+x[1]+'</strong><small>'+x[2]+'</small></div>').join(''));
  document.querySelector('#overview-alert-card').hidden=!alerts.length&&!orderAlerts.length;
  document.querySelector('#overview-alert-count').textContent=alerts.length+orderAlerts.length+' 項';
  setHtmlIfChanged('overview-alerts',[...alerts.map(x=>({name:x.name,tab:x.tab,error:x.error||'最近一次成功掃描較久，請查看執行紀錄。'})),...orderAlerts.map(x=>({name:x.label,tab:x.tab,error:x.error}))].map(x=>'<div class="overview-alert"><strong>'+esc(x.name)+'</strong><p>'+esc(x.error)+'</p><button class="overview-link" onclick="switchTab(&quot;'+x.tab+'&quot;)">查看來源 →</button></div>').join(''));
  const labels={paused:'已暫停',scheduled:'等待時段',scanning:'掃描中',ready:'運作中',error:'讀取異常',stale:'資料待更新',starting:'等待首次掃描'};
  const showPaused=document.querySelector('#overview-show-paused').checked;
  setHtmlIfChanged('overview-sources',sources.filter(x=>showPaused||x.state!=='paused').map(x=>'<tr><td><button class="overview-link" onclick="switchTab(&quot;'+x.tab+'&quot;)">'+esc(x.name)+'</button></td><td><span class="pill '+(['ready','scanning'].includes(x.state)?'ok':['error','stale'].includes(x.state)?'bad':'')+'">'+labels[x.state]+'</span></td><td>'+(x.seconds>=60&&x.seconds%60===0?x.seconds/60+' 分':x.seconds+' 秒')+'</td><td>'+esc(x.lastAt?new Date(x.lastAt).toLocaleTimeString('zh-TW'):'尚無紀錄')+'</td><td>'+(x.count??'—')+'</td></tr>').join(''));
  setHtmlIfChanged('overview-orders',orders.length?orders.map(x=>'<button onclick="switchTab(&quot;'+x.tab+'&quot;)">'+esc(x.label)+' · '+esc(x.state)+'</button>').join(''):'<span class="muted">目前沒有啟用的自動下單任務。</span>');
  const p=s.performance||{};
  setHtmlIfChanged('overview-performance',[
    ['主程式 CPU',p.nodeCpuPercent==null?'等待量測':p.nodeCpuPercent+'%'],['主程式記憶體',p.nodeRssMB==null?'等待量測':p.nodeRssMB+' MB'],
    ['排程延遲 p95',p.eventLoopP95Ms==null?'等待量測':p.eventLoopP95Ms+' ms'],['推播耗時 p95',p.notifications?.p95Ms==null?'等待實際推播':p.notifications.p95Ms+' ms'],['已省略資源請求',p.resources?(p.resources.blockedAssets+p.resources.blockedTelemetry).toLocaleString()+' 次':'等待量測']
  ].map(x=>'<div class="perf-line"><span>'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join(''));
  document.querySelector('#overview-updated').textContent='更新 '+new Date().toLocaleTimeString('zh-TW');
  const systemPause=s.systemPause||{},pauseCard=document.querySelector('#system-pause-card'),pauseButton=document.querySelector('#system-pause-button');
  pauseCard.classList.toggle('paused',Boolean(systemPause.active));
  document.querySelector('#system-pause-title').textContent=systemPause.active?'全部功能已停止':'需要玩遊戲時';
  document.querySelector('#system-pause-copy').textContent=systemPause.active?'掃描、登入心跳、自動下單與背景瀏覽器均已停止；控制頁仍保持可用。':'一鍵停止所有掃描、登入心跳、自動下單與背景瀏覽器；控制頁仍會保留，之後可恢復原本設定。';
  pauseButton.textContent=systemPause.active?'恢復先前功能':'停止全部功能';
  pauseButton.className=systemPause.active?'good':'danger';
}
async function toggleSystemPause(){
  const active=Boolean(currentStatus?.systemPause?.active);
  if(!active&&!window.confirm('確定停止全部功能？所有掃描、登入心跳、自動下單與背景瀏覽器都會停止；控制頁會保留。'))return;
  await run(active?'正在恢復先前功能…':'正在停止全部功能…',()=>api(active?'/system/resume':'/system/pause'));
}
function organizeDashboard(){
  const foldSection=(selector,label)=>{
    const marker=document.querySelector(selector),section=marker?.closest('section.card');if(!section)return;
    const fold=document.createElement('details');fold.className=section.className+' fold';fold.id=section.id;
    const summary=document.createElement('summary');const heading=section.querySelector(':scope > .card-heading')||section.querySelector(':scope > h2');
    const copy=heading?.querySelector('.compact-copy');
    if(heading){summary.append(heading);const title=heading.matches('h2')?heading:heading.querySelector('h2');if(title)title.textContent=label;}else summary.textContent=label;
    fold.append(summary);if(copy)fold.append(copy);while(section.firstChild)fold.append(section.firstChild);section.replaceWith(fold);
  };
  foldSection('#auto-purchase-funbox-summary','自動下單 · 帳號、佇列與訂單');
  foldSection('#funbox-interval','掃描設定與商品基線');
  foldSection('#amazon-product-order-slots','自動下單 · 三組商品頁雙線');
  foldSection('#shared-funbox-status','各平台詳細狀態');
  for(const [tab,items] of Object.entries({
    funbox:[['帳號與下單','#auto-purchase-funbox-summary'],['掃描設定','#funbox-interval'],['執行紀錄','#funbox-logs']],
    shopping:[['監控名單','#shopping-target-list'],['誠品專線','#eslite-product-url'],['自動下單','#auto-purchase-header-summary'],['執行紀錄','#shopping-logs']],
    japan:[['一般網站','#japan-target-list'],['日亞監控','#amazon-jp-state'],['自動下單','#amazon-product-order-slots'],['執行紀錄','#japan-logs']]
  })){
    const nav=document.createElement('div');nav.className='quick-nav';
    for(const [title,selector] of items){const button=document.createElement('button');button.type='button';button.textContent=title;button.onclick=()=>{const target=document.querySelector(selector);if(!target)return;let parent=target;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}target.scrollIntoView({block:'center',behavior:'smooth'});void refresh();};nav.append(button);}
    if(['shopping','japan'].includes(tab)){const button=document.createElement('button');button.type='button';button.textContent='顯示暫停來源';button.setAttribute('aria-pressed','false');button.onclick=()=>{const shown=document.querySelector('#tab-'+tab).classList.toggle('show-paused');button.setAttribute('aria-pressed',String(shown));button.textContent=shown?'隱藏暫停來源':'顯示暫停來源';};nav.append(button);}
    document.querySelector('#tab-'+tab+' > .page-title').after(nav);
  }
  // Remember disclosure state without touching monitoring switches or settings.
  document.querySelectorAll('.tab-panel details.card').forEach((el,index)=>{
    const tab=el.closest('.tab-panel')?.id||'dashboard';const anchor=el.id||el.querySelector('[id]')?.id||('section-'+index);const key='beyblade-ui-fold-v3-'+tab+'-'+anchor;const saved=localStorage.getItem(key);if(saved!==null)el.open=saved==='1';
    el.addEventListener('toggle',()=>{localStorage.setItem(key,el.open?'1':'0');if(el.open&&!document.hidden)void refresh();});
  });
}
`;
