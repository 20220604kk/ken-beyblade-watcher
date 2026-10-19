import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_BASE = 'https://beyblade.takaratomy.co.jp/beyblade-x/lineup/_image/';

export const FUNBOX_SANDBOX_PRODUCTS = [
  {
    id: '990001',
    slug: 'ux-15-shark-scale-test',
    sku: 'UX-15-TEST',
    title: 'BEYBLADE X UX-15 鯊擊鱗 5-60UF 起始組',
    price: 699,
    stock: 12,
    imageUrl: `${IMAGE_BASE}BXG00_list.png`,
    description: '本機沙盒模擬商品。包含戰鬥陀螺、發射器與測試用包裝內容。',
    published: false
  },
  {
    id: '990002',
    slug: 'bx-00-anniversary-test',
    sku: 'BX-00-TEST',
    title: 'BEYBLADE X BX-00 25週年紀念組',
    price: 1299,
    stock: 6,
    imageUrl: `${IMAGE_BASE}BXG00_01_list.png`,
    description: '本機沙盒模擬限定商品，用來測試新品上架通知與結帳流程。',
    published: false
  },
  {
    id: '990003',
    slug: 'cx-01-starter-test',
    sku: 'CX-01-TEST',
    title: 'BEYBLADE X CX-01 攻擊型入門組',
    price: 499,
    stock: 20,
    imageUrl: `${IMAGE_BASE}BXG00_02_list.png`,
    description: '本機沙盒模擬入門組，並非 Funbox 正式販售商品。',
    published: false
  }
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(value) {
  return `NT$${Number(value || 0).toLocaleString('zh-TW')}`;
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function html(response, body, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow'
  });
  response.end(body);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 131072) throw new Error('要求內容過大');
  }
  return body ? JSON.parse(body) : {};
}

function commonStyles() {
  return `
    :root{font-family:Arial,"Microsoft JhengHei",sans-serif;color:#424242;background:#fff;--red:#d71920;--ink:#333;--line:#e5e5e5;--soft:#f6f6f6}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:#424242}a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}
    .sandbox-ribbon{position:sticky;top:0;z-index:1000;background:#171717;color:#fff;text-align:center;padding:8px 16px;font-size:13px;letter-spacing:.08em}
    .sandbox-ribbon strong{color:#ffd24a}.topbar{position:absolute;top:33px;left:0;right:0;z-index:3;background:transparent;font-size:11px;color:#777;pointer-events:none}
    .topbar-inner,.header-inner,.nav-inner,.container{width:min(1110px,calc(100% - 32px));margin:0 auto}
    .topbar-inner{height:26px;display:flex;justify-content:flex-end;align-items:center;gap:22px}.topbar-inner a{pointer-events:auto}
    .main-header{height:77px;background:#fff}.header-inner{height:100%;display:grid;grid-template-columns:150px 1fr auto;align-items:center;gap:24px;padding-top:8px}
    .funbox-logo{display:inline-flex;align-items:flex-end;font-weight:900;letter-spacing:-.06em;font-size:30px;color:#d71920;line-height:1}
    .funbox-logo span{color:#333;font-size:15px;letter-spacing:.02em;margin:0 0 2px 5px;font-weight:700}.search-area{display:grid;grid-template-columns:145px 145px 1fr 44px;height:42px;border:1px solid #ddd}
    .search-area select,.search-area input{border:0;border-right:1px solid #e5e5e5;padding:0 12px;background:#fff;color:#666;min-width:0}.search-area input{border-right:0}
    .search-area button{border:0;background:#f8be37;color:#fff;font-size:19px;cursor:pointer}.header-actions{display:flex;align-items:center;gap:18px;color:#555;padding-top:18px}.header-icon{display:grid;place-items:center;min-width:40px;text-align:center;font-size:10px}.header-icon b{display:block;font-size:20px;line-height:1.2}.cart-count{display:inline-grid;place-items:center;min-width:18px;height:18px;border-radius:9px;background:#d71920;color:#fff;font-size:11px;margin-left:3px}
    .main-nav{background:#3159ad;color:#fff;box-shadow:0 2px 4px #0002}.nav-inner{height:51px;display:flex;align-items:center;gap:29px;font-size:15px;font-weight:700}.nav-inner a:hover{color:#ffd34c}.nav-home{font-size:25px;line-height:1}
    .breadcrumb{height:64px;display:flex;align-items:center;gap:9px;color:#888;font-size:13px}.breadcrumb span{color:#bbb}
    .page-title{font-size:20px;font-weight:500;margin:6px 0 22px;color:#424242}.muted{color:#888}.red{color:#d71920}
    .site-footer{margin-top:80px;background:rgba(237,235,235,.72);padding:46px 0 20px}.footer-grid{display:grid;grid-template-columns:2fr repeat(3,1fr);gap:54px}.footer-grid h3{font-size:15px;margin:0 0 16px}.footer-grid p,.footer-grid a{display:block;font-size:12px;line-height:1.8;color:#777}.copyright{text-align:center;border-top:1px solid #d6d6d6;margin-top:34px;padding-top:18px;font-size:11px;color:#888}
    .btn{border:1px solid #333;background:#333;color:#fff;min-height:44px;padding:0 24px;cursor:pointer;font-weight:700}.btn:hover{background:#d71920;border-color:#d71920}.btn-outline{background:#fff;color:#333}.btn-red{background:#d71920;border-color:#d71920}.btn:disabled{opacity:.45;cursor:not-allowed}
    .test-note{border:1px solid #efc35a;background:#fff9e8;padding:14px 16px;font-size:13px;color:#6b531b;margin:0 0 24px}.toast{position:fixed;right:24px;top:58px;z-index:1200;background:#222;color:#fff;padding:14px 20px;box-shadow:0 8px 30px #0004;display:none}.toast.show{display:block}
    @media(max-width:800px){.topbar{display:none}.header-inner{grid-template-columns:1fr auto;padding-top:0}.header-actions{padding-top:0}.search-area{display:none}.nav-inner{gap:18px;overflow:auto}.footer-grid{grid-template-columns:1fr 1fr}.main-header{height:76px}}
  `;
}

function header(cartCount = 0) {
  return `
    <div class="sandbox-ribbon">🧪 <strong>FUNBOX 本機測試沙盒</strong>　不連接正式網站、不會成立真實訂單</div>
    <div class="topbar"><div class="topbar-inner"><span>會員權益</span><span>集點說明</span><a href="/funbox-sandbox/control">測試上架控制台</a></div></div>
    <header class="main-header"><div class="header-inner">
      <a class="funbox-logo" href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA" aria-label="Funbox 測試商店首頁">funbox<span>Toys</span></a>
      <div class="search-area" aria-label="搜尋列"><select aria-label="選擇角色"><option>選擇角色</option><option>戰鬥陀螺</option></select><select aria-label="選擇類別"><option>選擇類別</option><option>對戰競技</option></select><input aria-label="搜尋商品" placeholder="輸入關鍵字"><button type="button" aria-label="進階搜尋">⌕</button></div>
      <div class="header-actions"><a class="header-icon" href="/funbox-sandbox/control"><b>⚙</b>控制台</a><a class="header-icon" href="/funbox-sandbox/cart"><b>🛒<span class="cart-count">${cartCount}</span></b>購物車</a></div>
    </div></header>
    <nav class="main-nav"><div class="nav-inner">
      <a class="nav-home" href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA" aria-label="首頁">⌂</a><a href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">所有角色</a><a href="#">所有類別</a><a href="#">TAKARATOMY 旗艦館</a><a href="#">樂高館</a><a href="#">商品列表</a><a href="#">本月精選</a><a href="#">最新消息</a>
    </div></nav>`;
}

function footer() {
  return `<footer class="site-footer"><div class="container"><div class="footer-grid">
    <div><h3>關於我們</h3><p>這是戰鬥陀螺監控 APP 的本機測試網站，用來安全模擬 Funbox 商品上架與結帳。</p><p>所有商品、庫存與訂單皆為測試資料。</p></div>
    <div><h3>Shopping</h3><a href="#">新手上路</a><a href="#">購物 FAQ</a><a href="#">聯絡客服</a></div>
    <div><h3>About</h3><a href="#">關於我們</a><a href="#">門市資訊</a><a href="#">隱私政策</a></div>
    <div><h3>Test Link</h3><a href="/funbox-sandbox/control">模擬上架控制台</a><a href="/">返回監控 APP</a></div>
  </div><div class="copyright">LOCAL TEST ONLY · Funbox 版面參考用途 · 不會送出真實交易</div></div></footer>`;
}

function layout({ title, body, cartCount = 0, extraStyles = '', script = '' }) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}｜Funbox 本機測試</title><style>${commonStyles()}${extraStyles}</style></head><body>${header(cartCount)}${body}${footer()}<div id="toast" class="toast" role="status"></div>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function collectionPage(products, cartCount) {
  const cards = products.map((product) => `
    <article class="product" data-testid="product-card-${product.id}">
      <a class="productClick product-image" href="/funbox-sandbox/products/${encodeURIComponent(product.slug)}" data-id="${escapeHtml(product.id)}" data-name="${escapeHtml(product.title)}" data-price="${money(product.price)}" data-stock="${product.stock}">
        <span class="new-tag">新品</span><img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}">
      </a>
      <div class="product_title"><a href="/funbox-sandbox/products/${encodeURIComponent(product.slug)}">${escapeHtml(product.title)}</a></div>
      <div class="product_price">${money(product.price)}</div>
      <div class="product_btn"><a class="card-cart" href="/funbox-sandbox/products/${encodeURIComponent(product.slug)}">加入購物車</a></div>
    </article>`).join('');
  const empty = `<div class="empty-products"><div class="empty-icon">◌</div><h2>目前沒有上架商品</h2><p>請到測試上架控制台選擇商品並按「模擬上架」。</p><a class="btn" href="/funbox-sandbox/control">前往上架控制台</a></div>`;
  const body = `<main class="container"><div class="breadcrumb"><a href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">首頁</a><span>›</span><b>戰鬥陀螺</b></div>
    <div class="test-note">操作順序：先在控制台啟動沙盒監控，再模擬上架商品；APP 會把這個集合頁當成測試官網掃描。</div>
    <div class="catalog-layout"><aside><h3>所有角色</h3><a class="active">戰鬥陀螺</a><a>TOMICA</a><a>多美火車</a><a>LEGO 樂高</a><a>機器戰士</a><a>寶可夢</a><h3>所有類別</h3><a>對戰・競技</a><a>收藏・景品</a></aside>
      <section class="catalog"><div class="catalog-heading"><div><h1 class="page-title">戰鬥陀螺</h1><span>共 ${products.length} 件商品</span></div><select aria-label="商品排序"><option>依上架時間</option><option>依價格</option><option>依銷售量</option></select></div>
      ${products.length ? `<div class="product-grid">${cards}</div>` : empty}</section></div></main>`;
  return layout({
    title: '戰鬥陀螺',
    cartCount,
    body,
    extraStyles: `
      .catalog-layout{display:grid;grid-template-columns:250px 1fr;gap:44px}.catalog-layout aside{border-right:1px solid var(--line);padding-right:30px}.catalog-layout aside h3{font-size:14px;border-bottom:1px solid #ddd;padding:0 0 12px;margin:0 0 8px}.catalog-layout aside h3:not(:first-child){margin-top:32px}.catalog-layout aside a{display:block;padding:9px 8px;font-size:13px;color:#777}.catalog-layout aside a.active,.catalog-layout aside a:hover{color:#d71920}
      .catalog-heading{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #ddd;padding-bottom:18px;margin-bottom:24px}.catalog-heading .page-title{margin:0 0 8px}.catalog-heading span{font-size:12px;color:#888}.catalog-heading select{border:1px solid #ddd;padding:9px 12px;color:#666;background:#fff}
      .product-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:34px 24px}.product{min-width:0;position:relative}.product-image{display:block;position:relative;aspect-ratio:1;background:#fff;overflow:hidden;border:1px solid #f0f0f0}.product-image img{width:100%;height:100%;object-fit:contain;transition:transform .25s}.product-image:hover img{transform:scale(1.035)}.new-tag{position:absolute;top:10px;left:10px;background:#d71920;color:#fff;padding:5px 8px;font-size:11px;z-index:2}.product_title{font-size:14px;line-height:1.55;margin-top:14px;min-height:44px}.product_title a:hover{color:#d71920}.product_price{margin:9px 0;font-weight:700;color:#333}.card-cart{display:block;text-align:center;border:1px solid #ddd;padding:10px;font-size:13px;background:#fff}.card-cart:hover{background:#333;color:#fff;border-color:#333}
      .empty-products{text-align:center;padding:74px 20px;background:#fafafa;border:1px solid #eee}.empty-icon{font-size:58px;color:#bbb}.empty-products h2{font-size:18px;font-weight:500}.empty-products p{color:#888;margin-bottom:28px}.empty-products .btn{display:inline-grid;place-items:center}
      @media(max-width:800px){.catalog-layout{grid-template-columns:1fr}.catalog-layout aside{display:none}.product-grid{grid-template-columns:repeat(2,1fr)}}`
  });
}

function productPage(product, cartCount) {
  const body = `<main class="container"><div class="breadcrumb"><a href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">首頁</a><span>›</span><a>戰鬥陀螺</a><span>›</span><b>${escapeHtml(product.title)}</b></div>
    <div class="test-note">此頁為本機測試商品頁。點擊「加入購物車」後，右上角會出現仿正式站的購物車提示。</div>
    <section class="product-detail">
      <div class="gallery"><img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}"><div class="thumbs"><button aria-label="商品圖片 1"><img src="${escapeHtml(product.imageUrl)}" alt=""></button></div></div>
      <div class="product-info"><span class="detail-new">新品</span><h1>${escapeHtml(product.title)}</h1><div class="detail-price">${money(product.price)}</div><div class="points">可獲得紅利 0 點　<span>點數說明</span></div>
        <dl><div><dt>商品編號:</dt><dd>${escapeHtml(product.sku)}</dd></div><div><dt>線上庫存:</dt><dd class="stock">尚有庫存（沙盒 ${product.stock} 件）</dd></div></dl>
        <div class="ship-note">付款後，從備貨到寄出商品為 2-5 個工作天。（本頁僅為模擬）</div>
        <form id="add-form"><label for="quantity">數量：</label><div class="buy-row"><input id="quantity" data-testid="quantity" name="quantity" type="number" min="1" max="${product.stock}" value="1"><button class="btn btn-red" type="submit" data-testid="add-to-cart">加入購物車</button></div></form>
      </div>
    </section>
    <section class="product-tabs"><div class="tab-labels"><b>商品介紹</b><span>規格說明</span></div><div class="description"><h2>商品介紹</h2><p>${escapeHtml(product.description)}</p><p class="red">※ 測試商品，不代表正式販售資訊。</p><img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)} 商品介紹圖"></div></section>
  </main>
  <aside id="cart-drawer" class="cart-drawer" aria-hidden="true"><button class="drawer-close" type="button" aria-label="關閉" onclick="closeDrawer()">×</button><h2>已加入購物車</h2><div class="drawer-product"><img src="${escapeHtml(product.imageUrl)}" alt=""><div><b>${escapeHtml(product.title)}</b><p>${money(product.price)}</p></div></div><a class="btn btn-red checkout-link" data-testid="drawer-checkout" href="/funbox-sandbox/cart">立即結帳</a><button class="btn btn-outline continue" type="button" onclick="closeDrawer()">繼續購物</button></aside><div id="drawer-mask" class="drawer-mask" onclick="closeDrawer()"></div>`;
  const script = `
    const form=document.querySelector('#add-form');
    const drawer=document.querySelector('#cart-drawer');
    const mask=document.querySelector('#drawer-mask');
    function closeDrawer(){drawer.classList.remove('open');mask.classList.remove('open');drawer.setAttribute('aria-hidden','true')}
    form.addEventListener('submit',async(event)=>{
      event.preventDefault();
      const quantity=Number(document.querySelector('#quantity').value||1);
      const response=await fetch('/funbox-sandbox/api/cart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:'${product.id}',quantity})});
      const result=await response.json();
      if(!response.ok){alert(result.error||'加入購物車失敗');return}
      document.querySelectorAll('.cart-count').forEach((element)=>element.textContent=String(result.cartCount));
      drawer.classList.add('open');mask.classList.add('open');drawer.setAttribute('aria-hidden','false');
    });`;
  return layout({
    title: product.title,
    cartCount,
    body,
    script,
    extraStyles: `
      .product-detail{display:grid;grid-template-columns:1fr 1fr;gap:50px;min-height:560px}.gallery>img{width:100%;aspect-ratio:1;object-fit:contain;border:1px solid #eee}.thumbs{margin-top:14px}.thumbs button{width:76px;height:76px;background:#fff;border:2px solid #333}.thumbs img{width:100%;height:100%;object-fit:contain}.product-info{padding:30px 0}.detail-new{display:inline-block;background:#d71920;color:#fff;padding:5px 9px;font-size:11px}.product-info h1{font-weight:500;font-size:24px;line-height:1.45;margin:15px 0}.detail-price{font-size:25px;font-weight:700;margin:20px 0}.points{background:#f7f7f7;padding:12px;color:#777;font-size:13px}.points span{color:#d71920}.product-info dl{border-top:1px solid #eee;border-bottom:1px solid #eee;margin:22px 0;padding:10px 0}.product-info dl div{display:flex;padding:8px 0;font-size:13px}.product-info dt{width:90px;color:#888}.product-info dd{margin:0}.stock{color:#d71920}.ship-note{font-size:12px;color:#777;margin:18px 0 24px}.product-info label{font-size:14px}.buy-row{display:grid;grid-template-columns:90px 1fr;gap:10px;margin-top:10px}.buy-row input{border:1px solid #ccc;text-align:center}.product-tabs{margin-top:54px;border-top:1px solid #ddd}.tab-labels{height:58px;display:flex;gap:38px;align-items:center;border-bottom:1px solid #ddd}.tab-labels b{height:58px;display:grid;place-items:center;border-bottom:3px solid #333}.description{text-align:center;padding:42px 20px}.description h2{font-size:18px}.description p{line-height:1.8}.description img{display:block;max-width:650px;width:100%;height:420px;object-fit:contain;margin:28px auto}
      .drawer-mask{position:fixed;inset:0;background:#0007;z-index:1090;opacity:0;pointer-events:none;transition:.2s}.drawer-mask.open{opacity:1;pointer-events:auto}.cart-drawer{position:fixed;z-index:1100;right:0;top:0;width:min(430px,92vw);height:100vh;background:#fff;padding:38px;transform:translateX(105%);transition:.25s;box-shadow:-15px 0 40px #0003}.cart-drawer.open{transform:none}.drawer-close{position:absolute;right:18px;top:16px;border:0;background:none;font-size:28px}.cart-drawer h2{font-weight:500;border-bottom:1px solid #ddd;padding-bottom:18px}.drawer-product{display:grid;grid-template-columns:90px 1fr;gap:15px;margin:25px 0}.drawer-product img{width:90px;height:90px;object-fit:contain;border:1px solid #eee}.drawer-product b{font-size:14px;line-height:1.5}.checkout-link,.continue{width:100%;display:grid;place-items:center;margin-top:10px}.continue{background:#fff}
      @media(max-width:800px){.product-detail{grid-template-columns:1fr}.description img{height:300px}}`
  });
}

function cartPage(items, products, cartCount) {
  const rows = items.map((item) => {
    const product = products.find((entry) => entry.id === item.productId);
    if (!product) return '';
    return `<div class="cart-row"><img src="${escapeHtml(product.imageUrl)}" alt=""><div class="cart-product"><a href="/funbox-sandbox/products/${encodeURIComponent(product.slug)}">${escapeHtml(product.title)}</a><span>${escapeHtml(product.sku)}</span></div><div>${money(product.price)}</div><div><input aria-label="${escapeHtml(product.title)} 數量" type="number" min="1" max="${product.stock}" value="${item.quantity}" data-product="${product.id}"></div><strong>${money(product.price * item.quantity)}</strong><button class="remove" data-remove="${product.id}" aria-label="移除 ${escapeHtml(product.title)}">×</button></div>`;
  }).join('');
  const subtotal = items.reduce((sum, item) => {
    const product = products.find((entry) => entry.id === item.productId);
    return sum + (product ? product.price * item.quantity : 0);
  }, 0);
  const empty = `<div class="cart-empty"><h2>購物車是空的</h2><a class="btn" href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">繼續選購</a></div>`;
  const body = `<main class="container"><div class="breadcrumb"><a href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">首頁</a><span>›</span><b>購物車</b></div><h1 class="page-title">購物車</h1><div class="test-note">本頁的數量與金額全部是本機測試資料。</div>
    ${items.length ? `<div class="cart-head"><span>商品</span><span>單價</span><span>數量</span><span>小計</span></div>${rows}<div class="cart-actions"><a href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">‹ 繼續購物</a><div class="cart-total"><div><span>商品小計</span><b>${money(subtotal)}</b></div><div><span>運費</span><b>${subtotal >= 799 ? '免運' : money(120)}</b></div><div class="grand"><span>總計</span><strong>${money(subtotal + (subtotal >= 799 ? 0 : 120))}</strong></div><a class="btn btn-red" data-testid="cart-checkout" href="/funbox-sandbox/checkout">立即結帳</a></div></div>` : empty}</main>`;
  const script = `
    document.querySelectorAll('input[data-product]').forEach((input)=>input.addEventListener('change',async()=>{await fetch('/funbox-sandbox/api/cart/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:input.dataset.product,quantity:Number(input.value)})});location.reload()}));
    document.querySelectorAll('[data-remove]').forEach((button)=>button.addEventListener('click',async()=>{await fetch('/funbox-sandbox/api/cart/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:button.dataset.remove,quantity:0})});location.reload()}));`;
  return layout({
    title: '購物車',
    cartCount,
    body,
    script,
    extraStyles: `
      .cart-head{display:grid;grid-template-columns:1fr 120px 120px 140px;padding:14px 58px 14px 130px;background:#f6f6f6;font-size:13px}.cart-row{display:grid;grid-template-columns:92px 1fr 120px 120px 120px 24px;gap:18px;align-items:center;border-bottom:1px solid #e5e5e5;padding:22px 8px}.cart-row>img{width:90px;height:90px;object-fit:contain;border:1px solid #eee}.cart-product a{font-size:14px;line-height:1.5}.cart-product span{display:block;color:#999;font-size:12px;margin-top:8px}.cart-row input{width:72px;padding:9px;border:1px solid #ccc;text-align:center}.remove{border:0;background:none;font-size:22px;color:#999;cursor:pointer}.cart-actions{display:flex;justify-content:space-between;align-items:flex-start;margin-top:32px}.cart-actions>a{font-size:13px;color:#777}.cart-total{width:360px}.cart-total>div{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #eee;font-size:14px}.cart-total .grand{font-size:18px}.cart-total .grand strong{color:#d71920;font-size:22px}.cart-total .btn{display:grid;place-items:center;margin-top:18px}.cart-empty{text-align:center;padding:70px;background:#fafafa}.cart-empty .btn{display:inline-grid;place-items:center;margin-top:20px}
      @media(max-width:800px){.cart-head{display:none}.cart-row{grid-template-columns:80px 1fr auto}.cart-row>div:nth-of-type(2),.cart-row>strong{display:none}.cart-actions{display:block}.cart-total{width:100%;margin-top:30px}}`
  });
}

function checkoutPage(items, products, cartCount) {
  const details = items.map((item) => {
    const product = products.find((entry) => entry.id === item.productId);
    return product ? `<div class="summary-item"><img src="${escapeHtml(product.imageUrl)}" alt=""><div><b>${escapeHtml(product.title)}</b><span>數量 ${item.quantity}</span></div><strong>${money(product.price * item.quantity)}</strong></div>` : '';
  }).join('');
  const subtotal = items.reduce((sum, item) => {
    const product = products.find((entry) => entry.id === item.productId);
    return sum + (product ? product.price * item.quantity : 0);
  }, 0);
  const shipping = subtotal >= 799 ? 0 : 120;
  const body = `<main class="checkout-wrap"><div class="checkout-brand"><a class="funbox-logo" href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">funbox<span>Toys</span></a><b>安全結帳（本機測試）</b></div>
    <ol class="steps"><li class="done">1 購物車</li><li class="active">2 填寫資料與付款</li><li>3 完成訂單</li></ol>
    <div class="test-note"><strong>請勿填真實個資。</strong> 建議使用：測試王／0900000000／test@example.com／台北市測試路 1 號。</div>
    <form id="checkout-form" class="checkout-grid">
      <div>
        <section class="checkout-card"><h2>配送方式</h2><label class="choice"><input type="radio" name="delivery" value="home" checked><span><b>宅配到府</b><small>台灣本島測試配送</small></span><strong>${shipping ? money(shipping) : '免運'}</strong></label></section>
        <section class="checkout-card"><h2>付款方式</h2><label class="choice"><input data-testid="payment-cod" type="radio" name="payment" value="cod" checked><span><b>貨到付款</b><small>沙盒唯一可用的測試付款方式</small></span></label><label class="choice disabled"><input type="radio" name="payment" value="credit" disabled><span><b>信用卡</b><small>測試環境停用</small></span></label></section>
        <section class="checkout-card"><h2>收件人資料</h2><div class="form-grid"><label>姓名 *<input data-testid="recipient-name" name="name" autocomplete="off" required placeholder="測試王"></label><label>手機號碼 *<input data-testid="recipient-phone" name="phone" autocomplete="off" required pattern="09[0-9]{8}" placeholder="0900000000"></label><label class="wide">Email *<input data-testid="recipient-email" name="email" type="email" autocomplete="off" required placeholder="test@example.com"></label><label class="wide">收件地址 *<input data-testid="recipient-address" name="address" autocomplete="off" required placeholder="台北市測試路 1 號"></label><label class="wide">訂單備註<textarea name="note" rows="3" placeholder="僅供本機測試"></textarea></label></div></section>
      </div>
      <aside class="order-summary"><h2>訂單摘要</h2>${details}<div class="summary-line"><span>商品小計</span><b>${money(subtotal)}</b></div><div class="summary-line"><span>運費</span><b>${shipping ? money(shipping) : '免運'}</b></div><div class="summary-total"><span>訂單總計</span><strong>${money(subtotal + shipping)}</strong></div><label class="terms"><input data-testid="terms" name="terms" type="checkbox" required> 我已了解這是本機模擬訂單，不會出貨或收款。</label><button class="btn btn-red submit-order" data-testid="submit-order" type="submit">送出測試訂單</button><p id="checkout-error" class="checkout-error"></p></aside>
    </form></main>`;
  const script = `
    document.querySelector('#checkout-form').addEventListener('submit',async(event)=>{
      event.preventDefault();
      const form=new FormData(event.currentTarget);
      const payload=Object.fromEntries(form.entries());
      const button=document.querySelector('[data-testid="submit-order"]');
      const error=document.querySelector('#checkout-error');
      button.disabled=true;button.textContent='送出中…';error.textContent='';
      const response=await fetch('/funbox-sandbox/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json();
      if(!response.ok){error.textContent=result.error||'送出失敗';button.disabled=false;button.textContent='送出測試訂單';return}
      location.href='/funbox-sandbox/orders/'+encodeURIComponent(result.orderId);
    });`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安全結帳｜Funbox 本機測試</title><style>${commonStyles()}
    body{background:#f5f5f5}.checkout-wrap{width:min(1100px,calc(100% - 32px));margin:0 auto 70px}.checkout-brand{height:96px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ddd}.checkout-brand>b{font-size:13px;color:#777}.steps{list-style:none;display:grid;grid-template-columns:repeat(3,1fr);padding:0;margin:28px 0}.steps li{text-align:center;border-bottom:3px solid #ccc;padding:0 0 13px;color:#999;font-size:13px}.steps li.done,.steps li.active{border-color:#d71920;color:#d71920}.checkout-grid{display:grid;grid-template-columns:1fr 390px;gap:28px;align-items:start}.checkout-card,.order-summary{background:#fff;border:1px solid #e1e1e1;padding:24px;margin-bottom:20px}.checkout-card h2,.order-summary h2{font-size:18px;font-weight:500;margin:0 0 20px}.choice{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;border:1px solid #ddd;padding:15px;margin-top:10px}.choice:has(input:checked){border-color:#d71920;background:#fffafa}.choice span{display:grid;gap:4px}.choice small{color:#888}.choice.disabled{opacity:.5}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.form-grid label{font-size:13px;color:#666}.form-grid .wide{grid-column:1/-1}.form-grid input,.form-grid textarea{display:block;width:100%;border:1px solid #ccc;padding:12px;margin-top:7px;background:#fff}.summary-item{display:grid;grid-template-columns:65px 1fr auto;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #eee}.summary-item img{width:65px;height:65px;object-fit:contain;border:1px solid #eee}.summary-item b{display:block;font-size:12px;line-height:1.4}.summary-item span{display:block;font-size:11px;color:#888;margin-top:5px}.summary-item strong{font-size:12px}.summary-line,.summary-total{display:flex;justify-content:space-between;padding:13px 0;border-bottom:1px solid #eee;font-size:13px}.summary-total{font-size:17px}.summary-total strong{color:#d71920;font-size:21px}.terms{display:flex;gap:9px;margin:18px 0;font-size:12px;line-height:1.5}.submit-order{width:100%}.checkout-error{color:#d71920;font-size:13px}.sandbox-ribbon{position:static}
    @media(max-width:850px){.checkout-grid{grid-template-columns:1fr}.order-summary{order:-1}.form-grid{grid-template-columns:1fr}.form-grid .wide{grid-column:auto}}</style></head><body><div class="sandbox-ribbon">🧪 <strong>FUNBOX 本機測試結帳</strong>　不連接金流、不會成立真實訂單</div>${body}<script>${script}</script></body></html>`;
}

function orderPage(order, products) {
  const itemNames = order.items.map((item) => {
    const product = products.find((entry) => entry.id === item.productId);
    return product ? `<li>${escapeHtml(product.title)} × ${item.quantity}</li>` : '';
  }).join('');
  return layout({
    title: '測試訂單完成',
    cartCount: 0,
    body: `<main class="container"><div class="success-box"><div class="success-icon">✓</div><p class="test-order">本機測試訂單</p><h1>訂單模擬送出完成</h1><p>訂單編號：<strong>${escapeHtml(order.id)}</strong></p><p>付款方式：貨到付款（測試）</p><ul>${itemNames}</ul><div class="success-actions"><a class="btn" href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">返回測試商店</a><a class="btn btn-outline" href="/funbox-sandbox/control">返回上架控制台</a></div><p class="muted">資料只保存在這台電腦，不會傳送給 Funbox、物流或金流服務。</p></div></main>`,
    extraStyles: `.success-box{max-width:700px;margin:80px auto;text-align:center;border:1px solid #ddd;padding:58px;background:#fff;box-shadow:0 10px 35px #0001}.success-icon{width:72px;height:72px;border-radius:50%;display:grid;place-items:center;margin:0 auto 20px;background:#278d5c;color:#fff;font-size:38px}.test-order{color:#d71920;font-weight:700;letter-spacing:.1em}.success-box h1{font-size:25px;font-weight:500}.success-box ul{text-align:left;max-width:480px;margin:25px auto;background:#f7f7f7;padding:18px 38px;line-height:1.8}.success-actions{display:flex;justify-content:center;gap:10px;margin:28px 0}.success-actions .btn{display:grid;place-items:center}`
  });
}

function controlPage(products, orders, cartCount) {
  const rows = products.map((product) => `<article class="control-product" data-testid="control-product-${product.id}"><img src="${escapeHtml(product.imageUrl)}" alt=""><div><span class="status ${product.published ? 'on' : ''}">${product.published ? '已上架' : '未上架'}</span><h2>${escapeHtml(product.title)}</h2><p>${escapeHtml(product.sku)}　${money(product.price)}</p></div><form class="stock-form" data-id="${product.id}"><label>測試庫存<input name="stock" type="number" min="0" max="99999" step="1" value="${product.stock}" required></label><button type="submit">更新庫存</button></form><button class="publish ${product.published ? 'unpublish' : ''}" data-action="${product.published ? 'unpublish' : 'publish'}" data-id="${product.id}">${product.published ? '模擬下架' : '模擬上架'}</button></article>`).join('');
  const body = `<main class="container"><div class="breadcrumb"><a href="/">監控 APP</a><span>›</span><b>Funbox 沙盒控制台</b></div><div class="control-hero"><div><p>FUNBOX SANDBOX</p><h1>模擬商品上架控制台</h1><span>這裡的操作只改變本機測試頁，正式官網完全不受影響。</span></div><div class="control-links"><a class="btn" target="_blank" href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA">開啟測試商店</a><a class="btn btn-outline" href="/">返回監控 APP</a></div></div>
    <div class="workflow"><b>建議測試順序</b><span>① 全部下架並重設</span><span>② 在 APP 啟動沙盒監控</span><span>③ 按下模擬上架</span><span>④ 等待通知後點商品結帳</span></div>
    <section class="control-card"><div class="control-heading"><div><h2>測試商品</h2><p>APP 掃描到新的商品 ID 時會送出標示為「沙盒測試」的通知。</p></div><button id="reset-all" class="reset">全部下架並重設</button></div><div id="control-products">${rows}</div></section>
    <section class="control-card"><h2>本機測試資料</h2><p>目前購物車 ${cartCount} 件；已建立 ${orders.length} 筆測試訂單。</p><div id="action-result" role="status"></div></section></main>`;
  const script = `
    const result=document.querySelector('#action-result');
    async function act(url){
      result.textContent='處理中…';
      const response=await fetch(url,{method:'POST'});
      const body=await response.json();
      if(!response.ok){result.textContent=body.error||'操作失敗';return}
      result.textContent=body.message||'完成';
      location.reload();
    }
    document.querySelectorAll('[data-action]').forEach((button)=>button.addEventListener('click',()=>act('/funbox-sandbox/api/products/'+button.dataset.id+'/'+button.dataset.action)));
    document.querySelectorAll('.stock-form').forEach((form)=>form.addEventListener('submit',async(event)=>{
      event.preventDefault();
      result.textContent='更新庫存中…';
      const response=await fetch('/funbox-sandbox/api/products/'+form.dataset.id+'/stock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stock:Number(form.elements.stock.value)})});
      const body=await response.json();
      if(!response.ok){result.textContent=body.error||'庫存更新失敗';return}
      result.textContent=body.message||'庫存已更新';
      location.reload();
    }));
    document.querySelector('#reset-all').addEventListener('click',()=>{if(confirm('確定要將測試商品全部下架，並清空購物車與測試訂單嗎？'))act('/funbox-sandbox/api/reset')});`;
  return layout({
    title: '模擬上架控制台',
    cartCount,
    body,
    script,
    extraStyles: `
      body{background:#f5f5f5}.control-hero{background:#fff;border-left:6px solid #d71920;padding:30px;display:flex;justify-content:space-between;gap:24px;align-items:center}.control-hero p{margin:0;color:#d71920;font-size:12px;font-weight:800;letter-spacing:.18em}.control-hero h1{font-size:26px;margin:8px 0}.control-hero span{color:#777}.control-links{display:flex;gap:9px}.control-links .btn{display:grid;place-items:center;white-space:nowrap}.workflow{display:flex;gap:18px;flex-wrap:wrap;background:#222;color:#fff;padding:16px 20px;margin:18px 0;font-size:13px}.workflow b{color:#ffd24a}.control-card{background:#fff;border:1px solid #ddd;padding:25px;margin:18px 0}.control-heading{display:flex;justify-content:space-between;align-items:center}.control-heading h2,.control-card>h2{margin:0 0 7px;font-size:18px}.control-heading p,.control-card>p{margin:0;color:#888;font-size:13px}.reset{border:1px solid #d71920;background:#fff;color:#d71920;padding:10px 15px;font-weight:700}.control-product{display:grid;grid-template-columns:90px 1fr 145px 120px;gap:20px;align-items:center;border-top:1px solid #eee;padding:20px 0}.control-product:first-child{margin-top:18px}.control-product img{width:90px;height:90px;object-fit:contain;border:1px solid #eee}.control-product h2{font-size:15px;margin:7px 0}.control-product p{font-size:12px;color:#888}.status{display:inline-block;background:#ddd;color:#666;padding:3px 7px;font-size:11px}.status.on{background:#dff6e9;color:#187347}.stock-form{display:grid;gap:7px}.stock-form label{font-size:12px;color:#666}.stock-form input{display:block;width:100%;margin-top:5px;border:1px solid #ccc;padding:8px}.stock-form button{border:1px solid #3159ad;background:#fff;color:#3159ad;padding:8px;font-weight:700}.publish{border:0;background:#d71920;color:#fff;padding:11px;font-weight:700}.publish.unpublish{background:#555}#action-result{margin-top:15px;color:#d71920;font-weight:700}
      @media(max-width:860px){.control-hero{display:block}.control-links{margin-top:20px}.control-product{grid-template-columns:70px 1fr}.control-product img{width:70px;height:70px}.stock-form,.control-product>.publish{grid-column:1/-1}.workflow{display:grid}}`
  });
}

export class FunboxSandbox {
  constructor({ dataDir, port, onReset = null }) {
    this.file = path.join(dataDir, 'funbox-sandbox.json');
    this.port = port;
    this.onReset = onReset;
    this.data = {
      products: FUNBOX_SANDBOX_PRODUCTS.map((product) => ({ ...product })),
      cart: [],
      orders: []
    };
    this.saveQueue = Promise.resolve();
  }

  get collectionUrl() {
    return `http://127.0.0.1:${this.port}/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA`;
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const savedProducts = new Map((saved.products || []).map((product) => [String(product.id), product]));
      this.data.products = FUNBOX_SANDBOX_PRODUCTS.map((product) => ({
        ...product,
        ...(savedProducts.get(product.id) || {})
      }));
      this.data.cart = Array.isArray(saved.cart) ? saved.cart : [];
      this.data.orders = Array.isArray(saved.orders) ? saved.orders.slice(-50) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.save();
  }

  async save() {
    this.saveQueue = this.saveQueue.then(async () => {
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, this.file);
    });
    return this.saveQueue;
  }

  status() {
    return {
      collectionUrl: this.collectionUrl,
      publishedCount: this.data.products.filter((product) => product.published).length,
      cartCount: this.cartCount(),
      orderCount: this.data.orders.length,
      products: this.data.products.map(({ id, title, sku, price, stock, published }) => ({
        id, title, sku, price, stock, published
      }))
    };
  }

  cartCount() {
    return this.data.cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  }

  async handle(request, response) {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${this.port}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (request.method === 'GET' && pathname === '/funbox-sandbox') {
      response.writeHead(302, { Location: '/funbox-sandbox/control' });
      response.end();
      return true;
    }
    if (request.method === 'GET' && pathname === '/funbox-sandbox/control') {
      html(response, controlPage(this.data.products, this.data.orders, this.cartCount()));
      return true;
    }
    if (request.method === 'GET' && pathname === '/funbox-sandbox/api/state') {
      json(response, 200, this.status());
      return true;
    }
    if (request.method === 'GET' && pathname === '/funbox-sandbox/collections/戰鬥陀螺') {
      html(response, collectionPage(this.data.products.filter((product) => product.published), this.cartCount()));
      return true;
    }
    const productMatch = pathname.match(/^\/funbox-sandbox\/products\/([^/]+)$/);
    if (request.method === 'GET' && productMatch) {
      const product = this.data.products.find((entry) => entry.slug === productMatch[1]);
      if (!product || !product.published) {
        html(response, layout({ title: '找不到商品', cartCount: this.cartCount(), body: '<main class="container"><div class="cart-empty"><h1>商品目前未上架</h1><a class="btn" href="/funbox-sandbox/control">返回控制台</a></div></main>' }), 404);
        return true;
      }
      html(response, productPage(product, this.cartCount()));
      return true;
    }
    if (request.method === 'GET' && pathname === '/funbox-sandbox/cart') {
      html(response, cartPage(this.data.cart, this.data.products, this.cartCount()));
      return true;
    }
    if (request.method === 'GET' && pathname === '/funbox-sandbox/checkout') {
      if (!this.data.cart.length) {
        response.writeHead(302, { Location: '/funbox-sandbox/cart' });
        response.end();
        return true;
      }
      html(response, checkoutPage(this.data.cart, this.data.products, this.cartCount()));
      return true;
    }
    const orderMatch = pathname.match(/^\/funbox-sandbox\/orders\/([^/]+)$/);
    if (request.method === 'GET' && orderMatch) {
      const order = this.data.orders.find((entry) => entry.id === orderMatch[1]);
      if (!order) {
        html(response, layout({ title: '找不到訂單', body: '<main class="container"><h1>找不到這筆測試訂單</h1></main>' }), 404);
        return true;
      }
      html(response, orderPage(order, this.data.products));
      return true;
    }
    const publishMatch = pathname.match(/^\/funbox-sandbox\/api\/products\/([^/]+)\/(publish|unpublish)$/);
    if (request.method === 'POST' && publishMatch) {
      const product = this.data.products.find((entry) => entry.id === publishMatch[1]);
      if (!product) return json(response, 404, { error: '找不到測試商品' }) || true;
      product.published = publishMatch[2] === 'publish';
      product.updatedAt = new Date().toISOString();
      await this.save();
      json(response, 200, {
        message: `${product.title} 已${product.published ? '模擬上架' : '模擬下架'}。`,
        product: { id: product.id, published: product.published }
      });
      return true;
    }
    const stockMatch = pathname.match(/^\/funbox-sandbox\/api\/products\/([^/]+)\/stock$/);
    if (request.method === 'POST' && stockMatch) {
      const product = this.data.products.find((entry) => entry.id === stockMatch[1]);
      if (!product) {
        json(response, 404, { error: '找不到測試商品' });
        return true;
      }
      const body = await readJson(request);
      const stock = Number(body.stock);
      if (!Number.isInteger(stock) || stock < 0 || stock > 99999) {
        json(response, 400, { error: '庫存必須是 0～99999 的整數' });
        return true;
      }
      product.stock = stock;
      product.updatedAt = new Date().toISOString();
      this.data.cart = this.data.cart
        .map((item) => item.productId === product.id ? { ...item, quantity: Math.min(stock, item.quantity) } : item)
        .filter((item) => item.quantity > 0);
      await this.save();
      json(response, 200, {
        message: `${product.sku} 測試庫存已更新為 ${stock}。`,
        product: { id: product.id, stock }
      });
      return true;
    }
    if (request.method === 'POST' && pathname === '/funbox-sandbox/api/reset') {
      this.data.products.forEach((product) => {
        const original = FUNBOX_SANDBOX_PRODUCTS.find((entry) => entry.id === product.id);
        product.published = false;
        product.stock = original?.stock ?? product.stock;
        product.updatedAt = new Date().toISOString();
      });
      this.data.cart = [];
      this.data.orders = [];
      if (this.onReset) await this.onReset();
      await this.save();
      json(response, 200, { message: '沙盒商品已全部下架，購物車與測試訂單已清空。' });
      return true;
    }
    if (request.method === 'POST' && pathname === '/funbox-sandbox/api/cart') {
      const body = await readJson(request);
      const product = this.data.products.find((entry) => entry.id === String(body.productId));
      const quantity = Math.max(1, Math.floor(Number(body.quantity) || 1));
      if (!product || !product.published) {
        json(response, 400, { error: '商品目前未上架' });
        return true;
      }
      if (quantity > product.stock) {
        json(response, 400, { error: `測試庫存只剩 ${product.stock} 件` });
        return true;
      }
      const existing = this.data.cart.find((item) => item.productId === product.id);
      if (existing) existing.quantity = Math.min(product.stock, existing.quantity + quantity);
      else this.data.cart.push({ productId: product.id, quantity });
      await this.save();
      json(response, 200, { message: '已加入購物車', cartCount: this.cartCount() });
      return true;
    }
    if (request.method === 'POST' && pathname === '/funbox-sandbox/api/cart/update') {
      const body = await readJson(request);
      const productId = String(body.productId);
      const product = this.data.products.find((entry) => entry.id === productId);
      const quantity = Math.floor(Number(body.quantity) || 0);
      if (!product) {
        json(response, 404, { error: '找不到測試商品' });
        return true;
      }
      if (quantity <= 0) this.data.cart = this.data.cart.filter((item) => item.productId !== productId);
      else {
        const item = this.data.cart.find((entry) => entry.productId === productId);
        if (item) item.quantity = Math.min(product.stock, quantity);
      }
      await this.save();
      json(response, 200, { message: '購物車已更新', cartCount: this.cartCount() });
      return true;
    }
    if (request.method === 'POST' && pathname === '/funbox-sandbox/api/orders') {
      const body = await readJson(request);
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      const email = String(body.email || '').trim();
      const address = String(body.address || '').trim();
      if (!this.data.cart.length) {
        json(response, 400, { error: '購物車是空的' });
        return true;
      }
      if (!name || !/^09\d{8}$/.test(phone) || !email.includes('@') || !address) {
        json(response, 400, { error: '請完整填寫測試收件資料' });
        return true;
      }
      if (body.payment !== 'cod') {
        json(response, 400, { error: '沙盒只允許貨到付款測試' });
        return true;
      }
      if (!body.terms) {
        json(response, 400, { error: '請勾選本機模擬訂單說明' });
        return true;
      }
      const order = {
        id: `TEST-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
        createdAt: new Date().toISOString(),
        payment: 'cod',
        customer: { name, phone, email, address, note: String(body.note || '').trim() },
        items: this.data.cart.map((item) => ({ ...item }))
      };
      this.data.orders.push(order);
      this.data.orders = this.data.orders.slice(-50);
      this.data.cart = [];
      await this.save();
      json(response, 200, { message: '測試訂單已建立', orderId: order.id });
      return true;
    }
    return false;
  }
}
