export const catalogHtml = `
    <section id="product-catalog-card" class="card">
      <div class="card-heading"><h2>商品黑白名單 · 終端售價</h2><button type="button" onclick="loadProductCatalog(true)">更新原表</button></div>
      <div class="catalog-controls">
        <label>名單平台 <select id="catalog-platform" onchange="renderProductCatalog()"><option value="funbox">FUNBOX</option><option value="eslite">購物網站</option></select></label>
        <label>分類 <select id="catalog-category" onchange="renderProductCatalog()"><option value="">全部</option>${['BX','UX','CX','配件','聯名','對戰盤'].map(x => `<option>${x}</option>`).join('')}</select></label>
        <label>搜尋 <input id="catalog-search" placeholder="型號／品項" oninput="renderProductCatalog()"></label>
        <a id="catalog-source-link" hidden target="_blank" rel="noopener noreferrer">開啟原表 ↗</a>
      </div>
      <p id="catalog-status" class="compact-copy" role="status">讀取終端售價中…</p>
      <p id="catalog-action-status" class="notice" role="status"></p>
      <div class="catalog-table-wrap"><table class="catalog-table"><thead><tr><th>分類</th><th>型號</th><th>品項</th><th>售價 NT$</th><th>名單狀態</th><th>操作</th></tr></thead><tbody id="catalog-rows"></tbody></table></div>
      <details id="catalog-sheet-preview"><summary>查看嵌入原始試算表</summary><div id="catalog-embed"></div></details>
    </section>`;

export const catalogCss = `
.catalog-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.catalog-controls label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:#aab9d1}.catalog-controls select,.catalog-controls input{margin:0;min-height:36px;width:155px}.catalog-controls input{width:220px}.catalog-controls a{font-size:13px;padding:10px 0}.catalog-table-wrap{max-height:540px;overflow:auto;border:1px solid #293754;border-radius:8px}.catalog-table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}.catalog-table th{position:sticky;top:0;background:#1d293b;color:#b9d2ed;text-align:left;z-index:1;padding:12px}.catalog-table td{padding:10px 12px;border-top:1px solid #293754;vertical-align:middle}.catalog-table th,.catalog-table td{border-right:1px solid #293754}.catalog-table th:last-child,.catalog-table td:last-child{border-right:0}.catalog-table th:nth-child(4),.catalog-table td:nth-child(4){text-align:right;white-space:nowrap}.catalog-table td:nth-child(2){white-space:nowrap;font-weight:600}.catalog-actions{display:flex;gap:6px;white-space:nowrap}.catalog-actions button{padding:7px 9px;font-size:12px}.catalog-actions .catalog-white{background:#205f4c}.catalog-actions .catalog-black{background:#58313e}.catalog-table .catalog-list{font-size:12px;max-width:180px;overflow-wrap:anywhere}#catalog-sheet-preview{margin-top:16px}#catalog-sheet-preview summary{font-size:13px;cursor:pointer}#catalog-embed iframe{margin-top:12px;width:100%;height:540px;border:1px solid #293754;border-radius:8px;background:#fff}@media(max-width:760px){.catalog-table{min-width:850px}.catalog-controls input{width:180px}}
`;

export const catalogClient = `
let productCatalog=null,productCatalogLoading=false,productCatalogSaving=false;
async function loadProductCatalog(force=false){
  if(productCatalogLoading)return;
  productCatalogLoading=true;
  const state=document.getElementById('catalog-status');state.textContent='讀取原表中…';
  try{
    const response=await fetch('/api/product-catalog'+(force?'?refresh=1':''),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'讀取失敗');productCatalog=data;renderProductCatalog();
  }catch(error){state.textContent='無法更新：'+error.message+(productCatalog?'；保留上次資料。':'');}
  finally{productCatalogLoading=false;}
}
function renderProductCatalog(){
  if(!productCatalog)return;
  const sourceLink=document.getElementById('catalog-source-link');
  sourceLink.hidden=!productCatalog.sourceUrl;if(productCatalog.sourceUrl)sourceLink.href=productCatalog.sourceUrl;
  document.getElementById('catalog-sheet-preview').hidden=!productCatalog.embedUrl;
  const platform=document.getElementById('catalog-platform').value,category=document.getElementById('catalog-category').value;
  const search=document.getElementById('catalog-search').value.trim().toUpperCase();
  const items=productCatalog.items.filter(x=>(!category||x.category===category)&&(!search||(x.model+' '+x.name).toUpperCase().includes(search)));
  const settings=productCatalog.lists?.[platform]||{};
  const note=platform==='eslite'&&settings.mode!=='whitelist'?'｜目前黑名單以外皆可買；白名單不限制範圍。':'';
  document.getElementById('catalog-status').textContent=items.length+' / '+productCatalog.items.length+' 品項｜'+productCatalog.sheetName+'｜'+(productCatalog.updatedAt?'更新 '+new Date(productCatalog.updatedAt).toLocaleString('zh-TW'):'尚未讀取')+note+(productCatalog.error?'｜'+productCatalog.error+(productCatalog.items.length?'（舊資料）':''):'');
  document.getElementById('catalog-rows').innerHTML=items.length?items.map(x=>{
    const s=x.listStates?.[platform]||{},black=s.black||[],white=s.white||[];
    const label=black.length?'黑名單：'+black.join('、'):white.length?'白名單：'+white.join('、'):'未加入';
    return '<tr><td>'+esc(x.category)+'</td><td>'+esc(x.model)+'</td><td>'+esc(x.name)+'</td><td>'+(x.price===null?esc(x.priceText||'待查'):Number(x.price).toLocaleString('zh-TW'))+'</td><td class="catalog-list">'+esc(label)+'</td><td><div class="catalog-actions"><button class="catalog-black" type="button" data-catalog-id="'+x.id+'" data-list="black"'+(productCatalogSaving?' disabled':'')+'>加入黑名單</button><button class="catalog-white" type="button" data-catalog-id="'+x.id+'" data-list="white"'+(productCatalogSaving?' disabled':'')+'>加入白名單</button></div></td></tr>';
  }).join(''):'<tr><td colspan="6">'+(productCatalog.error?'原表暫時無法讀取':'沒有符合的品項')+'</td></tr>';
}
async function addCatalogList(id,list){
  const status=document.getElementById('catalog-action-status'),platform=document.getElementById('catalog-platform').value;
  if(productCatalogSaving)return;
  if(autoPurchaseDirtyPlatforms.size){status.textContent='請先儲存 FUNBOX／購物網站尚未儲存的設定，再加入名單。';return;}
  productCatalogSaving=true;renderProductCatalog();status.textContent='儲存名單中…';
  try{const saved=await api('/product-catalog/list',{id,list,platform});status.textContent=saved.message;await loadProductCatalog();await refresh();}
  catch(error){status.textContent='未變更名單：'+error.message;}
  finally{productCatalogSaving=false;renderProductCatalog();}
}
document.getElementById('catalog-rows').addEventListener('click',event=>{const button=event.target.closest('button[data-catalog-id]');if(button)void addCatalogList(button.dataset.catalogId,button.dataset.list);});
document.getElementById('catalog-sheet-preview').addEventListener('toggle',event=>{
  if(event.target.open&&productCatalog?.embedUrl&&!document.querySelector('#catalog-embed iframe')){
    const frame=document.createElement('iframe');frame.title='終端品項及售價原表';frame.loading='lazy';frame.referrerPolicy='no-referrer';frame.src=productCatalog.embedUrl;document.getElementById('catalog-embed').append(frame);
  }
});
`;
