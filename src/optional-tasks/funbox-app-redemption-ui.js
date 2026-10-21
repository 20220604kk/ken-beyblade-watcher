// Runs inside the existing dashboard and the desktop WebView of that dashboard.
export function redemptionClient() {
  const prefix = '/optional-tasks/funbox-app-redemption';
  let latest, dialog, chooser, dirty = false, actionBusy = false, pendingConfirmation;
  const savedCodes = new Map(), originalRows = new Map();
  const labels = { queued: '等待執行', adding: '加車中', coupon_applying: '套用序號', submitting: '送單中', unknown: '結果不明・帳號保護中', cart_review: '購物車待核對', ordered: '特別任務・訂單成立', skipped: '已略過', cancelled: '已結束' };
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
  const style = document.createElement('style');
  style.textContent = '.funbox-special-reserved{outline:2px solid #fb7185;outline-offset:-2px;background:#3c1726!important}.funbox-special-reserved td,.funbox-special-reserved td strong{color:#ff8e9f!important}.funbox-special-badge{color:#ff8e9f;font-weight:700}.funbox-special-modal{color:#edf2f7;background:#141c30;border:1px solid #774052;border-radius:14px;max-width:800px;width:calc(100% - 28px);max-height:90vh;padding:20px;overflow:auto}.funbox-special-modal::backdrop{background:#000a}.funbox-special-modal h2{font-size:20px;margin-top:0}.funbox-special-modal p{line-height:1.6}.funbox-special-jobs{display:grid;gap:10px;margin:14px 0}.funbox-special-job{display:grid;grid-template-columns:26px minmax(120px,1fr) minmax(150px,1.2fr) auto;gap:6px;align-items:center;padding:10px;background:#0d1425;border:1px solid #35415e;border-radius:10px}.funbox-special-job input,.funbox-special-job select{min-width:0;width:100%}.funbox-special-job button{padding:7px}.funbox-special-actions{display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;margin:12px 0;padding-bottom:4px}.funbox-special-actions button{flex:0 0 auto;white-space:nowrap;min-width:54px;padding:8px 12px;border-radius:9px}.funbox-special-chooser select{min-width:180px}.funbox-special-chooser .funbox-special-actions{justify-content:flex-end}.funbox-special-modal pre{white-space:pre-wrap;font-size:12px;background:#0d1425;padding:10px;border-radius:8px;max-height:230px;overflow:auto}.funbox-special-job small{grid-column:2/-1;color:#b8c5dc}.funbox-special-modal input[type=datetime-local]{color-scheme:dark}@media(max-width:550px){.funbox-special-job{grid-template-columns:22px 1fr auto}.funbox-special-job input{grid-column:2/3}.funbox-special-job .special-move{grid-column:3;grid-row:1/3}}';
  style.textContent += '.funbox-special-actions button{background:#284e88;color:#edf4ff;border:1px solid #3c65a0;font-size:14px;font-weight:600}.funbox-special-actions button:hover{background:#35619f}.funbox-special-actions button:disabled{opacity:.45;cursor:not-allowed}.funbox-special-actions button.danger{background:#8e3043;border-color:#ae4258}.funbox-special-job input,.funbox-special-job select,.funbox-special-chooser select,.funbox-special-modal input[type=datetime-local]{background:#101c30;color:#edf4ff;border:1px solid #354b6e;border-radius:7px;padding:8px}';
  document.head.append(style);
  style.textContent += '.funbox-special-confirm{border:1px solid #fb7185;border-radius:10px;background:#3c1726;padding:14px;margin:12px 0}.funbox-special-confirm p{white-space:pre-line;margin-top:0}.funbox-special-confirm button{margin-right:10px}.funbox-special-job input{font-family:monospace;font-size:15px}';
  async function api(action, body) {
    const response = await fetch(prefix + '/' + action, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-Task-CSRF': latest.csrf } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作未完成'); latest = data;
    if (action === 'edit') { savedCodes.clear(); for (const job of data.jobs) savedCodes.set(job.id, job.code || ''); }
    if (data.disabled) { dialog?.close(); document.querySelector('[data-funbox-special]')?.remove(); } return data;
  }
  function row(job = {}) {
    const node = el('div', '', 'funbox-special-job'); node.dataset.id = job.id || '';
    node.append(el('b', ''));
    const select = el('select'); select.setAttribute('aria-label', '兌換產品');
    for (const [value, label] of [['bbpr07730', '黃蜂要塞'], ['bbpr07733', '海怪扭擺'], ['bbpr07736', '雄鹿戰角']]) { const option = el('option', label); option.value = value; select.append(option); }
    select.value = job.productId || 'bbpr07730'; node.append(select);
    const code = el('input'); code.type = 'text'; code.autocomplete = 'off'; code.spellcheck = false; code.placeholder = 'XXXX-XXXX-XXXX'; code.value = savedCodes.get(job.id) || ''; code.setAttribute('aria-label', '兌換序號'); node.append(code);
    const moves = el('div', '', 'special-move');
    for (const [text, move] of [['↑', -1], ['↓', 1], ['×', 0]]) { const button = el('button', text); button.type = 'button'; button.setAttribute('aria-label', move === -1 ? '上移任務' : move === 1 ? '下移任務' : '移除任務'); button.onclick = () => { if (move < 0 && node.previousElementSibling) node.previousElementSibling.before(node); else if (move > 0 && node.nextElementSibling) node.nextElementSibling.after(node); else if (!move) node.remove(); dirty = true; renumber(); paint(); }; moves.append(button); }
    node.append(moves); node.append(el('small', (labels[job.status] || '待儲存') + (job.orderNumber ? ' · ' + job.orderNumber + ' · NT$' + job.amount : '') + (job.error ? ' · ' + (job.errorDetail?.reason || job.error) : '')));
    node.oninput = () => { dirty = true; paint(); }; return node;
  }
  function renumber() { [...dialog.querySelectorAll('.funbox-special-job')].forEach((node, i) => { node.querySelector('b').textContent = String(i + 1); }); }
  function paint() {
    if (!latest) return;
    const slot = latest.accountSlot || 'C';
    for (const [key, saved] of originalRows) if (!latest.reserved || key !== slot) {
      document.getElementById('funbox-sheet-account-'+key)?.classList.remove('funbox-special-reserved');
      for (const [id,value] of saved.cells) { const node=document.getElementById(id); if(node){node.textContent=value.text;node.className=value.className;} }
      for (const [button,disabled] of saved.buttons) if(button.isConnected)button.disabled=disabled;
      originalRows.delete(key);
    }
    const accountRow=document.getElementById('funbox-sheet-account-'+slot);
    if(latest.reserved && accountRow){
      if(!originalRows.has(slot))originalRows.set(slot,{cells:['api','payment','pending'].map(key=>{const id='funbox-sheet-'+key+'-'+slot,node=document.getElementById(id);return [id,{text:node?.textContent||'',className:node?.className||''}];}),buttons:[...accountRow.querySelectorAll('button')].map(b=>[b,b.disabled])});
      accountRow.classList.add('funbox-special-reserved');
      for(const button of accountRow.querySelectorAll('button'))button.disabled=true;
      const status=document.getElementById('funbox-sheet-api-'+slot), seconds=Math.max(0,Math.ceil((Date.parse(latest.nextRetryAt||'')-Date.now())/1000))||0;
      if(status){status.textContent='特別任務 · '+(latest.running?'執行中':latest.jobs.some(j=>j.status==='unknown')?'自動查單／不重送':latest.enabled?(Date.parse(latest.startAt)>Date.now()?'等待預定時間':seconds?seconds+'秒後自動重試':'準備接續執行'):latest.assigned?'已指定／未啟用':'本批結束／帳號專用');status.className='funbox-special-badge';}
      const payment=document.getElementById('funbox-sheet-payment-'+slot);if(payment)payment.textContent='7-11 貨到付款';
      const pending=document.getElementById('funbox-sheet-pending-'+slot);if(pending)pending.textContent=String(latest.jobs.filter(j=>!['ordered','skipped','cancelled'].includes(j.status)).length);
    }
    if (!dialog?.open) return;
    dialog.querySelector('[data-state]').textContent = latest.reserved ? '帳號 '+slot+' 本次專用；其他帳號維持原流程' : latest.finishedAt ? '本次已結束，帳號已恢復一般任務' : '尚未啟用；目前不會送單';
    dialog.querySelector('[data-logs]').textContent = latest.events.slice(-60).map(e => new Date(e.at).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + ' ' + e.label + (e.httpStatus ? ' · HTTP ' + e.httpStatus : '') + (Number.isFinite(e.durationMs) ? ' · ' + e.durationMs + 'ms' : '') + (e.reason ? ' · ' + e.reason : '') + (e.retryAt ? ' · 下次 ' + new Date(e.retryAt).toLocaleTimeString('zh-TW', { timeZone:'Asia/Taipei',hour12:false }) : '')).join('\n') || '尚無執行紀錄';
    for (const button of dialog.querySelectorAll('[data-edit]')) button.disabled = (latest.enabled || latest.running || (latest.reserved && !latest.assigned) || latest.jobs.some(j=>['adding','coupon_applying','submitting','unknown','cart_review'].includes(j.status))) || actionBusy || Boolean(pendingConfirmation);
    for (const node of dialog.querySelectorAll('.funbox-special-job')) for (const input of node.querySelectorAll('input,select,button')) input.disabled = (latest.enabled || latest.running || (latest.reserved && !latest.assigned) || latest.jobs.some(j=>['adding','coupon_applying','submitting','unknown','cart_review'].includes(j.status))) || actionBusy || Boolean(pendingConfirmation);
    for (const node of dialog.querySelectorAll('.funbox-special-job')) { const job = latest.jobs.find(j => j.id === node.dataset.id); if (job) node.querySelector('small').textContent = '特別任務 · ' + (labels[job.status] || job.status) + (job.orderNumber ? ' · '+job.orderNumber+' · NT$'+job.amount : '') + (job.error ? ' · '+(job.errorDetail?.reason || job.error) : ''); }
    let cleanup = dialog.querySelector('[data-cleanup]');
    const review = latest.jobs.find(j => j.status === 'cart_review');
    if (review && !cleanup) { cleanup = el('button', '清車'); cleanup.dataset.cleanup='1'; cleanup.type='button'; cleanup.onclick=()=>askConfirmation('只移除本特別任務、尚未送單的指定商品？未知訂單禁止移除。','discard-cart',{id:latest.jobs.find(j=>j.status==='cart_review')?.id,confirmRemoveOwnItem:true});dialog.querySelector('.funbox-special-actions').append(cleanup); }
    if (cleanup) cleanup.hidden = !review;
    const resumeBlocked = latest.enabled || latest.running || latest.jobs.some(j => ['adding','coupon_applying','submitting','unknown','cart_review'].includes(j.status));
    const hasRows = dirty ? Boolean(dialog.querySelector('.funbox-special-job')) : latest.jobs.some(j => j.status === 'queued');
    const reason = actionBusy ? '正在處理，請稍候' : latest.enabled ? '特別任務已啟用，等待預定時間' : latest.running ? '帳號正在執行，請等候完成' : resumeBlocked ? '有購物車或未決交易待核對，請先處理' : !hasRows ? '請先新增至少一組產品與序號' : pendingConfirmation ? '請在下方確認或取消' : dirty ? '有未儲存修改；按啟用會先儲存，再請你確認' : '已儲存，可啟用；到預定時間才開始執行';
    dialog.querySelector('[data-arm]').disabled = resumeBlocked || !hasRows || actionBusy || Boolean(pendingConfirmation);
    dialog.querySelector('[data-arm-reason]').textContent = reason;
    dialog.querySelector('[data-arm]').textContent = latest.enabled ? '執行' : '啟用';
    dialog.querySelector('[data-stop]').disabled = (!latest.reserved && !latest.assigned) || actionBusy;
  }
  async function action(name, body = {}) {
    if (actionBusy) return false; if (pendingConfirmation) cancelConfirmation(); actionBusy = true; paint();
    try { await api(name, body); dialog.querySelector('[data-error]').textContent = ''; if (name === 'save') { await api('edit', {}); dirty = false; fill(); } if(name==='finish'){dirty=false;savedCodes.clear();dialog.close();paint();if(typeof window.refresh==='function')void window.refresh();} return true; }
    catch (e) { dialog.querySelector('[data-error]').textContent = e.message; return false; }
    finally { actionBusy = false; paint(); }
  }
  function saveBody() { const time=dialog.querySelector('[data-time]').value; return { startAt: time + (time.length===16?':00':'') + '+08:00', rows: [...dialog.querySelectorAll('.funbox-special-job')].map(node => ({ id: node.dataset.id || undefined, productId: node.querySelector('select').value, code: node.querySelector('input').value })) }; }
  function cancelConfirmation() { pendingConfirmation = undefined; dialog.querySelector('[data-confirmation]').hidden = true; paint(); }
  function askConfirmation(text, name, body) {
    if (actionBusy) return;
    pendingConfirmation = { name, body }; dialog.querySelector('[data-confirm-text]').textContent = text;
    dialog.querySelector('[data-confirmation]').hidden = false; paint(); dialog.querySelector('[data-confirm-yes]').focus();
  }
  function fill() { const list = dialog.querySelector('[data-jobs]'); list.replaceChildren(...latest.jobs.map(row)); if (!latest.jobs.length) list.append(row()); renumber(); }
  async function open() {
    await api('edit', {});
    if (!dialog) {
      dialog = el('dialog', '', 'funbox-special-modal'); dialog.setAttribute('aria-label', '方爸APP兌換');
      dialog.innerHTML = '<h2>方爸APP兌換 <span class="funbox-special-badge">特別任務</span></h2><p data-state></p><p>依下列順序單品結帳，每組序號各一張訂單。固定 7-11 取貨付款、紅利 0，每張必須 NT$555。結果不明即停止後續派單，只查單。</p><label>開始時間（台灣時間） <input data-time data-edit type="datetime-local" value="2026-10-21T10:00"></label><div class="funbox-special-jobs" data-jobs></div><div class="funbox-special-actions"><button data-add data-edit type="button">新增</button><button data-save data-edit type="button">儲存</button><button data-preflight type="button">檢查</button><button data-arm type="button">啟用</button><button data-query type="button">查單</button><button data-stop class="danger" type="button">結束</button><button data-close type="button">關閉</button></div><p data-error role="status" class="funbox-special-badge"></p><details><summary>特別任務紀錄</summary><pre data-logs></pre></details>';
      const hint = el('p'); hint.dataset.armReason = ''; hint.setAttribute('role','status'); dialog.querySelector('[data-jobs]').before(hint);
      const confirmation = el('section','','funbox-special-confirm'); confirmation.dataset.confirmation=''; confirmation.hidden=true;
      confirmation.setAttribute('aria-label','確認特別任務操作'); confirmation.innerHTML='<p data-confirm-text></p><button data-confirm-yes type="button">確認</button><button data-confirm-no type="button">取消</button>';
      dialog.querySelector('[data-error]').before(confirmation);
      dialog.querySelector('[data-confirm-yes]').onclick = () => { const selected = pendingConfirmation; cancelConfirmation(); if(selected)void action(selected.name,selected.body); };
      dialog.querySelector('[data-confirm-no]').onclick = cancelConfirmation;
      dialog.querySelector('[data-time]').oninput = () => { dirty=true; paint(); };
      dialog.querySelector('[data-time]').step='1';
      dialog.querySelector('[data-add]').onclick = () => { dialog.querySelector('[data-jobs]').append(row()); dirty = true; renumber(); paint(); };
      dialog.querySelector('[data-save]').onclick = () => action('save', saveBody());
      dialog.querySelector('[data-arm]').onclick = async () => {
        if(dirty && !await action('save',saveBody())) return;
        askConfirmation('啟用特別任務？\n帳號 '+latest.accountSlot+' 專用；依排序逐筆建立真實訂單。\n共 '+latest.jobs.filter(j=>j.status==='queued').length+' 張；每張單品 ×1／7-11 取貨付款／NT$555／紅利 0。\n開始時間：'+dialog.querySelector('[data-time]').value.replace('T',' ')+'（台灣時間）。\n其他帳號維持一般商品流程。','arm',{confirmRealOrders:true});
      };
      dialog.querySelector('[data-stop]').onclick = () => action('finish');
      dialog.querySelector('[data-preflight]').onclick = () => action('preflight');
      dialog.querySelector('[data-query]').onclick = () => action('reconcile');
      dialog.querySelector('[data-close]').onclick = () => { cancelConfirmation(); dialog.close(); };
      dialog.oncancel = () => cancelConfirmation();
      (document.querySelector('.funbox-purchase-panel') || document.body).append(dialog);
    }
    if (!dirty) { fill(); dialog.querySelector('[data-time]').value = new Date(Date.parse(latest.startAt) + 8*3600000).toISOString().slice(0,19); } dialog.showModal(); paint();
  }
  async function chooseAccount() {
    await api('status');
    if(latest.reserved || latest.enabled || latest.running){await open();return;}
    if(!chooser){
      chooser=el('dialog','','funbox-special-modal funbox-special-chooser');chooser.setAttribute('aria-label','指定特別任務帳號');
      chooser.innerHTML='<h2>特別任務</h2><p>選擇本次專用帳號。指定後仍需設定任務並啟用，才會下單。</p><label>帳號 <select data-account aria-label="特別任務帳號"></select></label><p data-choice-error role="status"></p><div class="funbox-special-actions"><button data-assign type="button">指定</button><button data-cancel type="button">關閉</button></div>';
      chooser.querySelector('[data-cancel]').onclick=()=>chooser.close();
      chooser.querySelector('[data-assign]').onclick=async()=>{
        const button=chooser.querySelector('[data-assign]');button.disabled=true;
        try{await api('assign',{accountSlot:chooser.querySelector('[data-account]').value});dirty=false;savedCodes.clear();chooser.close();await open();}
        catch(error){chooser.querySelector('[data-choice-error]').textContent=error.message;}finally{button.disabled=false;paint();}
      };
      document.body.append(chooser);
    }
    const select=chooser.querySelector('[data-account]');select.replaceChildren();
    const accounts=latest.accounts||[{slot:latest.accountSlot||'C',ready:true}];
    for(const account of accounts){if(!account.ready)continue;const option=el('option','帳號 '+account.slot);option.value=account.slot;select.append(option);}
    chooser.querySelector('[data-assign]').disabled=!select.options.length;chooser.querySelector('[data-choice-error]').textContent='';chooser.showModal();
  }
  function mount() {
    if (latest?.disabled) return;
    const toolbar=document.getElementById('funbox-purchase-readiness-button')?.parentElement;
    if(toolbar && !toolbar.querySelector('[data-funbox-special]')){const button=el('button','特別');button.type='button';button.className='secondary small';button.dataset.funboxSpecial='1';button.onclick=()=>chooseAccount().catch(()=>{});const hint=toolbar.querySelector('small');if(hint)toolbar.insertBefore(button,hint);else toolbar.append(button);}
    paint();
  }
  async function refresh() { if (actionBusy) return; try { await api('status'); mount(); } catch {} }
  if (typeof window.renderFunboxTables === 'function') { const original = window.renderFunboxTables; window.renderFunboxTables = function(...args) { const result = original.apply(this,args); paint(); return result; }; }
  void refresh(); setInterval(refresh, 2000);
}
export const clientScript = '(' + redemptionClient.toString() + ')();';
