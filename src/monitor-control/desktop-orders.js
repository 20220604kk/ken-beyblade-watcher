// Desktop-only presentation of the original dashboard. No checkout, login,
// account, cart or setting action is performed by loading this view.
(() => {
  if (location.origin !== 'http://127.0.0.1:3210') return;
  function mount() {
    if (document.querySelector('#ken-desktop-orders')) return;
    const funbox = document.querySelector('.funbox-purchase-panel');
    const eslite = document.querySelector('#eslite-account-list')?.closest('section.card');
    const amazon = document.querySelector('#amazon-product-order-slots')?.closest('details.card,section.card');
    if (!funbox || !eslite || !amazon || typeof renderAutoPurchase !== 'function') return;
    const style = document.createElement('style');
    style.textContent = `
      html{background:#0f1727;color-scheme:dark}body{padding:6px 10px 16px;max-width:none;margin:0;background:#0f1727;font-family:"Microsoft JhengHei UI",sans-serif}
      body>:not(#ken-desktop-orders):not(script):not(style){display:none!important}
      #ken-desktop-orders{display:block!important}.desktop-orders-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 4px 10px;font-size:12px;color:#a4b6cc}.desktop-orders-head strong{font-size:14px;color:#e8f6f3}
      #ken-desktop-orders .desktop-platform{padding:14px 16px;margin:0 0 12px;border:1px solid #2a394d;border-radius:18px;background:#192538}
      #ken-desktop-orders .desktop-platform>summary{font-size:15px;cursor:pointer;min-height:26px;display:flex;align-items:center;justify-content:space-between;gap:10px;list-style:none}
      #ken-desktop-orders .desktop-platform>summary:after{content:'展開';color:#8cbed4;font-size:12px}#ken-desktop-orders .desktop-platform[open]>summary:after{content:'收合'}
      #ken-desktop-orders .desktop-platform>.card{padding:0;margin:0;border:0;background:transparent}
      #ken-desktop-orders .card-heading h2{font-size:15px}#ken-desktop-orders .compact-copy{font-size:12px;margin:6px 0}
      #ken-desktop-orders .eslite-sheet-scroll{border-radius:13px;max-height:440px}#ken-desktop-orders .eslite-sheet button{border-radius:8px}
      #ken-desktop-orders button,#ken-desktop-orders input,#ken-desktop-orders select{border-radius:10px}
      #ken-desktop-orders .eslite-account-table{min-width:0}#ken-desktop-orders .eslite-sheet .eslite-actions{flex-wrap:wrap}
      #ken-desktop-orders .desktop-subfold{margin-top:12px;border:1px solid #2d3e54;border-radius:13px;padding:10px 12px;background:#111d30}
      #ken-desktop-orders .desktop-subfold>summary{cursor:pointer;color:#a8c0da;font-size:12px;font-weight:700}
      #ken-desktop-orders .desktop-subfold[open]>summary{margin-bottom:10px}
      #ken-desktop-orders #funbox-account-list .compact{display:none}#ken-desktop-orders #funbox-account-list:has(>.compact:only-child){display:none}
      #ken-desktop-orders .amazon-live-log-toolbar{flex-wrap:wrap}#ken-desktop-orders .amazon-live-log-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      #ken-desktop-orders .amazon-order-sheet{min-width:850px}#ken-desktop-orders #amazon-product-order-slots{overflow:auto}
      #ken-desktop-orders #result:empty{display:none}#ken-desktop-orders #result{white-space:pre-wrap;font-size:12px;margin:6px 0;color:#95dfc5}
    `;
    document.head.append(style);
    const root = document.createElement('main');root.id='ken-desktop-orders';root.className='purchase-hub';
    const head = document.createElement('div');head.className='desktop-orders-head';
    const title = document.createElement('strong');title.textContent='自動下單集合表';head.append(title);
    const connection = document.querySelector('#dashboard-connection');if(connection)head.append(connection);
    root.append(head);
    const result = document.querySelector('#result');if(result)root.append(result);
    function remember(fold,id,initial=true) {
      const key='ken-desktop-orders-'+id,stored=localStorage.getItem(key);
      fold.open=stored===null?initial:stored==='1';
      fold.addEventListener('toggle',()=>localStorage.setItem(key,fold.open?'1':'0'));
    }
    function subfold(label,id) {
      const fold=document.createElement('details');fold.className='desktop-subfold';
      const summary=document.createElement('summary');summary.textContent=label;fold.append(summary);remember(fold,id,false);return fold;
    }
    function platform(source,label,id) {
      let fold=source;
      if(source.tagName!=='DETAILS') {fold=document.createElement('details');const summary=document.createElement('summary');summary.textContent=label;fold.append(summary,source);}
      else {const heading=fold.querySelector(':scope > summary h2');if(heading)heading.textContent=label;}
      fold.classList.add('desktop-platform');fold.dataset.desktopPlatform=id;remember(fold,id);root.append(fold);return fold;
    }
    function compactSettings(section,id) {
      const settings=subfold('下單設定／黑白名單與維護',id+'-settings');
      const history=subfold('搶購佇列／訂單紀錄與步驟 LOG',id+'-history');
      for(const child of [...section.children]) {
        if(child.matches('section.eslite-sheet[aria-label]')) history.append(child);
        else if(child.matches('form,.eslite-system-details,.purchase-dispatch-settings')) settings.append(child);
      }
      section.append(settings,history);
    }
    platform(funbox,'FUNBOX 自動下單','funbox');compactSettings(funbox,'funbox');
    platform(eslite,'誠品 自動下單','eslite');compactSettings(eslite,'eslite');
    platform(amazon,'日亞 自動下單 ABC','amazon');
    const live=root.querySelector('#amazon-product-order-live-logs');
    if(live){const logs=subfold('日亞 ABC 即時 LOG','amazon-log');logs.id='desktop-amazon-log';live.before(logs);logs.append(live);}
    document.body.append(root);
    // Replace only the page's refresh renderer. Its existing timer and every
    // original button keep using the same functions and first-party endpoints.
    let pending=null;
    refresh=async function desktopRefresh() {
      if(document.hidden)return;
      if(pending)return pending;
      pending=(async()=>{
        try {
          const response=await fetch('/api/status?view=shared&logs=0',{cache:'no-store',signal:AbortSignal.timeout(10000)});
          if(!response.ok)throw new Error('HTTP '+response.status);
          const state=await response.json();currentStatus={...(currentStatus||{}),...state};
          renderAutoPurchase(currentStatus);renderAmazonProductOrder(currentStatus);
          if(connection){connection.textContent='● 已連線 · '+new Date().toLocaleTimeString('zh-TW');connection.className='ok';}
        }catch(error){if(connection){connection.textContent='連線異常：'+error.message;connection.className='bad';}}
      })().finally(()=>{pending=null;});
      return pending;
    };
    // Keep links from navigating back to unrelated dashboard tabs.
    switchTab=function(){void refresh();};
    void refresh();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
