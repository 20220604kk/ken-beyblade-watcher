import { isArchivedFacebookRequest, withoutFacebookStatus } from './facebook-retired.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import { shopeeHtml, shopeeCss, shopeeClient } from './shopee-ui.js';
import { overviewHtml, overviewCss, overviewClient } from './dashboard-overview.js';
import { dashboardStatusForView } from './dashboard-status.js';
import { esliteTableCss, esliteAccountTableHtml, esliteOrderTablesHtml, esliteTableClient } from './eslite-purchase-ui.js';
import { funboxTableCss, funboxAccountTableHtml, funboxOrderTablesHtml, funboxTableClient } from './funbox-purchase-ui.js';
import { purchaseLogExportClient } from './purchase-log-export.js';
import { purchaseListSortClient } from './purchase-list-sort.js';
import { purchaseReadinessClient } from './purchase-readiness.js';
import { isEsliteAccountSlot, esliteSlotClient } from './eslite-account-slots.js';
import { ProductSheetCatalog, catalogListState } from './product-sheet-catalog.js';
import { safePurchaseText } from './purchase-diagnostics.js';
import { funboxScanStatus } from './funbox-scan-status.js';

const pageHtml = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0b1020">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="陀螺監控">
  <title>陀螺監控儀表</title>
  <style>
    ${shopeeCss}
    .purchase-list-sort-actions{display:flex;justify-content:flex-end;margin-top:8px}.purchase-list-sort-actions button{white-space:nowrap}
    .purchase-dispatch-settings{margin:10px 0;font-size:12px}.purchase-dispatch-settings summary{cursor:pointer;color:#9eabc3}.purchase-dispatch-settings .field{margin:10px 0}.purchase-dispatch-settings input[type=number]{width:80px;padding:7px}.purchase-dispatch-settings small{display:block}
    :root{font-family:system-ui,"Microsoft JhengHei",sans-serif;color:#edf2f7;background:#080d19;color-scheme:dark}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{max-width:1280px;margin:0 auto;padding:24px 20px 64px;background:radial-gradient(circle at 50% -120px,#1b315d 0,transparent 420px);min-height:100vh}.card{background:#141c30;border:1px solid #293754;border-radius:14px;padding:18px;margin:12px 0;box-shadow:0 10px 30px #0003}
    h1{margin:0;font-size:30px;letter-spacing:.02em}h2{font-size:19px;margin:0 0 14px}.muted{color:#9eabc3}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.pill{display:inline-flex;align-items:center;background:#222d48;border-radius:999px;padding:7px 12px;font-size:14px}.hero{display:flex;align-items:center;gap:15px;margin-bottom:4px}.brand-mark{display:grid;place-items:center;width:50px;height:50px;border-radius:15px;background:linear-gradient(145deg,#438aff,#2658c9);box-shadow:0 10px 28px #2459c955;font-size:26px}.eyebrow{color:#78aefc;font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero-copy{margin-top:6px;color:#aebad0}.page-title{display:flex;gap:14px;align-items:flex-start;margin:22px 0 14px}.page-icon{display:grid;place-items:center;width:44px;height:44px;flex:0 0 44px;border-radius:13px;background:#203252;font-size:22px}.page-title h2{font-size:24px;margin:0 0 4px}.page-title p{margin:0;color:#9eabc3}.section-kicker{margin:22px 2px 8px;color:#78aefc;font-size:13px;font-weight:800;letter-spacing:.08em}.status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:14px 0}.status-tile{padding:16px;border:1px solid #2d3b5a;border-radius:14px;background:#0d1527}.status-tile strong{display:block;margin-bottom:8px}.status-tile .muted{font-size:14px;line-height:1.5}
    button{border:0;border-radius:10px;padding:11px 16px;background:#3c82f6;color:white;font-weight:700;cursor:pointer}button.secondary{background:#31405e}button.danger{background:#9b3341}button.good{background:#16855b}button.small{padding:7px 11px;font-size:13px}button:disabled{opacity:.5;cursor:not-allowed}
    input,select,textarea{border:1px solid #35415e;border-radius:9px;padding:10px 12px;background:#0d1425;color:#edf2f7;min-width:180px}textarea{display:block;width:100%;min-height:82px;resize:vertical;font:inherit;line-height:1.5}input[type=url]{flex:1;min-width:290px}input[type=number]{width:120px;min-width:0}.field{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.field label{display:flex;gap:7px;align-items:center}.field input[type=checkbox]{min-width:0;width:18px;height:18px}.profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.profile-grid input{width:100%}@media(max-width:720px){.profile-grid{grid-template-columns:1fr}}
    .amazon-jp-test-panel{margin:14px 0;padding:15px;border:1px solid #354c70;border-radius:13px;background:#101a2e}.amazon-jp-test-panel>strong{display:block;margin-bottom:5px}.amazon-jp-test-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.amazon-jp-test-choice{display:flex;gap:8px;align-items:flex-start;padding:11px;border:1px solid #35415e;border-radius:10px;background:#0d1425;cursor:pointer}.amazon-jp-test-choice:has(input:checked){border-color:#438aff;background:#192d50}.amazon-jp-test-choice input{min-width:0;margin:3px 0 0}.amazon-jp-test-choice span{min-width:0;line-height:1.45}.amazon-jp-test-choice small{display:block;color:#9eabc3}.amazon-jp-test-custom{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:12px 0}.amazon-jp-test-custom[hidden]{display:none}.amazon-jp-test-custom label{display:grid;gap:5px;font-size:13px;color:#b9c9e3}.amazon-jp-test-custom input{width:100%;min-width:0}.amazon-jp-test-custom .wide{grid-column:1/-1}@media(max-width:720px){.amazon-jp-test-options,.amazon-jp-test-custom{grid-template-columns:1fr}.amazon-jp-test-custom .wide{grid-column:auto}}
    .page-item{padding:14px 0;border-top:1px solid #29334f}.page-item:first-child{border-top:0}.page-info{min-width:0}.page-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.page-controls input{flex:1;min-width:230px}.page-url{display:block;margin-top:7px;font-size:13px;color:#78aefc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:820px}.mode{font-size:12px;color:#9eabc3}.page-group{margin-top:14px;border:1px solid #2d3b5a;border-radius:14px;padding:0 15px;background:#10182b}.page-group-title{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 0 10px}.page-group-title strong{font-size:15px}.page-group-title span{font-size:13px;color:#9eabc3}.page-group.paused{background:#0c1220;border-color:#242d41}.page-group.paused .page-item{opacity:.66}.page-group.paused .page-item:focus-within,.page-group.paused .page-item:hover{opacity:1}.page-group.paused .page-url{color:#78859c}.page-empty{padding:13px 0;color:#8491a8}.page-state{font-size:12px;font-weight:800}.page-state.live{color:#5ee09b}.page-state.sleep{color:#a0abc0}
    pre{white-space:pre-wrap;word-break:break-word;background:#0a0f1d;padding:14px;border-radius:10px;max-height:360px;overflow:auto;color:#cbd5e1}.ok{color:#5ee09b}.bad{color:#ff8f8f}.notice{min-height:24px;margin:12px 0 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.purchase-stack{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}@media(max-width:720px){.grid{grid-template-columns:1fr}.page-url{max-width:72vw}}
    .check-item{display:grid;grid-template-columns:76px 190px 1fr;gap:10px;padding:10px 0;border-top:1px solid #29334f}.check-item:first-child{border-top:0}.check-status{font-weight:800}.check-status.pass{color:#5ee09b}.check-status.warn{color:#ffd166}.check-status.fail{color:#ff8f8f}@media(max-width:720px){.check-item{grid-template-columns:70px 1fr}.check-detail{grid-column:1/-1}}
    .card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.card-heading h2{margin:0}.collapse-button{padding:7px 11px;min-width:76px}.keyword-list{display:flex;flex-wrap:wrap;gap:8px;min-height:38px;margin:12px 0}.keyword-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid #3a4868;background:#222d48;border-radius:999px;padding:6px 8px 6px 12px}.keyword-chip button{border-radius:999px;padding:2px 7px;background:#703344;font-size:14px}.keyword-card h2{margin-bottom:6px}
    .profile-secret{display:flex;gap:8px}.profile-secret input{min-width:0;flex:1}.profile-secret button{white-space:nowrap;padding:9px 12px}.form-frame{width:100%;height:760px;border:1px solid #35415e;border-radius:12px;background:white}.form-preview-image{display:block;width:100%;max-height:900px;object-fit:contain;object-position:top;border:1px solid #35415e;border-radius:12px;background:white;margin-top:12px}.preview-details{margin-top:14px}.preview-details summary{cursor:pointer;color:#78aefc}.preview-url{color:#78aefc;word-break:break-all}
    .latest-form-name{display:flex;align-items:center;gap:10px;margin:15px 0 4px;padding:13px 15px;border:1px solid #315080;border-radius:12px;background:#101d34}.latest-form-name span{color:#9eabc3;font-size:13px;white-space:nowrap}.latest-form-name strong{font-size:17px;color:#edf5ff;word-break:break-word}
    .tab-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:24px 0 8px;padding:7px;background:#0e1628cc;backdrop-filter:blur(14px);border:1px solid #293754;border-radius:17px;position:sticky;top:10px;z-index:10;box-shadow:0 12px 34px #0009}.tab-button{display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;color:#aeb9ce;font-size:15px;min-height:48px}.tab-button.active{background:#3c82f6;color:white;box-shadow:0 7px 20px #2466db55}.tab-panel[hidden]{display:none}.product-list{display:grid;gap:10px}.product-row{display:grid;grid-template-columns:1fr auto;gap:8px 14px;padding:13px 0;border-top:1px solid #29334f}.product-row:first-child{border-top:0}.product-row a{color:#78aefc;text-decoration:none}.product-main{display:flex;gap:12px;align-items:center;min-width:0}.product-thumb{width:58px;height:58px;flex:0 0 58px;object-fit:cover;border-radius:10px;background:#0d1425;border:1px solid #35415e}.product-meta{font-size:13px;color:#9eabc3}.data-checks{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.data-check{padding:7px 10px;border-radius:9px;background:#102a24;color:#7ce7b2;font-size:13px;font-weight:700}.shopping-target{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 16px;padding:15px 0;border-top:1px solid #29334f}.shopping-target:first-child{border-top:0}.shopping-target>div:first-child{min-width:0}.shopping-target.paused{opacity:.62}.shopping-target .page-url{width:100%;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shopping-site-name{color:#78aefc;font-size:13px;font-weight:800}.shopping-target-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:0 0 auto}.shopping-name-edit{display:flex;align-items:center;gap:8px;margin:5px 0}.shopping-name-edit input{min-width:0;width:min(420px,100%);font-weight:700;padding:8px 10px}.shopping-schedule-editor{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:10px}.shopping-schedule-editor select,.shopping-schedule-editor input{width:auto;min-width:112px;padding:7px 9px}.shopping-schedule-editor input:disabled{opacity:.45}.schedule-badge{font-size:12px;color:#b8c8e5}.sale-reminder-form{display:grid;grid-template-columns:minmax(170px,1fr) minmax(230px,1.5fr) minmax(190px,.8fr) auto;gap:10px}.sale-reminder-list{margin-top:16px}.sale-reminder-time{font-size:16px;font-weight:800;color:#ffd166}.notification-demo{overflow:hidden;border:1px solid #34435f;border-radius:16px;background:#20232b;box-shadow:0 12px 28px #0004}.notification-demo-head{padding:11px 16px;background:#2b3039;color:#cbd5e1;font-size:13px;font-weight:800}.notification-demo-body{padding:17px 18px;line-height:1.7;color:#f4f6f8}.notification-demo-body strong{color:#fff}.notification-demo-link{color:#69a7ff;font-weight:800}.notification-demo-note{margin-top:12px;color:#8f9db5;font-size:13px}.demo-badge{font-size:12px;color:#91a1bc;font-weight:600}@media(max-width:820px){.sale-reminder-form{grid-template-columns:1fr 1fr}.sale-reminder-form button{grid-column:1/-1}}@media(max-width:620px){.tab-bar{gap:4px;padding:5px}.tab-button{min-height:54px;padding:7px 4px;gap:3px;flex-direction:column;font-size:11px}.product-row,.shopping-target{grid-template-columns:minmax(0,1fr)}.shopping-target-actions{justify-content:flex-start}.status-grid,.sale-reminder-form{grid-template-columns:1fr}}
    .test-flow{border-color:#d5a93e;background:linear-gradient(145deg,#1b2237,#151c30)}.test-flow-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.test-flow-head h2{font-size:21px}.button-link{display:inline-flex;align-items:center;justify-content:center;border-radius:10px;padding:11px 16px;background:#3c82f6;color:#fff!important;font-weight:700;text-decoration:none}.button-link.gold{background:#d6a62f;color:#17130a!important}.test-success{padding:13px 15px;background:#0d1425;border-radius:11px;border-left:4px solid #35415e}.test-success.ok{border-left-color:#5ee09b;color:#dffbed}.advanced-box{margin-top:16px}.advanced-box summary{cursor:pointer;color:#9eabc3;padding:8px 0}.fold>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;font-weight:800;font-size:18px;list-style:none}.fold>summary::-webkit-details-marker{display:none}.fold>summary:after{content:"展開";font-size:13px;font-weight:600;color:#78aefc}.fold[open]>summary{padding-bottom:16px;border-bottom:1px solid #29334f;margin-bottom:16px}.fold[open]>summary:after{content:"收合"}.compact-copy{margin:8px 0 16px;color:#9eabc3}@media(max-width:720px){.test-flow-head{display:block}}
    .setting-toggle{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;margin-top:16px;padding:14px;border:1px solid #35415e;border-radius:12px;background:#0d1425;cursor:pointer}.setting-toggle input{width:20px;height:20px;min-width:0;margin-top:2px}.setting-toggle strong,.setting-toggle small{display:block}.setting-toggle small{margin-top:5px;color:#9eabc3;line-height:1.5}.channel-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.channel-choice{display:block;padding:16px;border:1px solid #35415e;border-radius:14px;background:#0d1425}.channel-choice strong,.channel-choice small{display:block}.channel-choice select{width:100%;margin:10px 0 8px}.channel-choice small{color:#9eabc3;line-height:1.5}.primary-actions{padding:18px;border:1px solid #315080;border-radius:15px;background:linear-gradient(135deg,#172945,#121b30)}@media(max-width:720px){body{padding:20px 14px 48px}.hero{align-items:flex-start}.brand-mark{width:44px;height:44px;flex-basis:44px}.channel-grid{grid-template-columns:1fr}.card{padding:18px}.page-title h2{font-size:22px}}
    .discord-route-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:16px 0}.discord-route{padding:18px;border:1px solid #35415e;border-radius:16px;background:#0d1425}.discord-route.public{border-color:#315b8d;background:linear-gradient(145deg,#10233d,#0d1729)}.discord-route.private{border-color:#74518f;background:linear-gradient(145deg,#241b36,#111629)}.discord-route.mmtoy{border-color:#8b5a73;background:linear-gradient(145deg,#321d2a,#141521)}.route-heading{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.route-heading h3{margin:0 0 5px;font-size:18px}.route-heading p{margin:0;color:#9eabc3;font-size:13px}.route-items{display:grid;gap:7px;margin:15px 0}.route-item{display:flex;align-items:center;gap:8px;color:#dbe6f5;font-size:14px}.route-item:before{content:"✓";display:grid;place-items:center;width:20px;height:20px;border-radius:999px;background:#1f7658;color:#fff;font-size:12px;font-weight:900}.route-note{padding:11px 12px;border-radius:10px;background:#080e1b;color:#aebad0;font-size:13px;line-height:1.5}.route-note strong{color:#fff}.discussion-route{display:flex;gap:12px;align-items:flex-start;margin:14px 0;padding:15px;border:1px dashed #425273;border-radius:13px;background:#10182b}.discussion-route span{font-size:22px}.discussion-route strong,.discussion-route small{display:block}.discussion-route small{margin-top:4px;color:#9eabc3;line-height:1.5}@media(max-width:980px){.discord-route-grid{grid-template-columns:1fr}} 
    .notification-test{margin-top:16px;padding:16px;border:1px solid #35415e;border-radius:14px;background:#0d1425}.notification-test-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.notification-progress{flex:1;min-width:180px;height:11px;overflow:hidden;border:1px solid #35415e;border-radius:999px;background:#080d19}.notification-progress-bar{width:0;height:100%;border-radius:999px;background:#438aff;transition:width .25s ease,background .2s ease}.notification-progress-bar.running{background:linear-gradient(90deg,#377ff0,#71b7ff,#377ff0);background-size:200% 100%;animation:notification-progress 1.1s linear infinite}.notification-progress-bar.success{background:#32c780}.notification-progress-bar.fail{background:#ef6675}.notification-test-status{display:grid;gap:6px;margin-top:12px;line-height:1.5}.notification-test-link{width:max-content;max-width:100%;color:#86b7ff;font-weight:800;text-decoration:none}.notification-test-detail{font-size:13px;color:#9eabc3;word-break:break-word}.simulation-lab{border-color:#4c5f86;background:linear-gradient(145deg,#151f36,#11182a)}.simulation-controls{display:grid;grid-template-columns:minmax(190px,1fr) minmax(220px,1fr) auto;gap:10px;margin-top:15px}.simulation-controls label{display:grid;gap:7px;color:#b8c5db;font-size:13px;font-weight:800}.simulation-controls select{width:100%}.simulation-controls button{align-self:end;white-space:nowrap}.simulation-custom{margin-top:14px;padding:0 14px 14px;border:1px solid #3a4969;border-radius:13px;background:#0d1425}.simulation-custom>summary{padding:13px 0;color:#8dbbff;font-weight:800;cursor:pointer}.simulation-custom-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px}.simulation-custom-grid label{display:grid;gap:6px;color:#b8c5db;font-size:13px;font-weight:800}.simulation-custom-grid .wide{grid-column:1/-1}.simulation-custom-grid input{width:100%}.simulation-custom-note{margin:10px 0 0;color:#90a0ba;font-size:12px;line-height:1.55}.simulation-warning{margin:12px 0 0;color:#f1c56e;font-size:13px;line-height:1.5}@keyframes notification-progress{from{background-position:200% 0}to{background-position:0 0}}@media(max-width:720px){.simulation-controls,.simulation-custom-grid{grid-template-columns:1fr}.simulation-controls button{width:100%}.simulation-custom-grid .wide{grid-column:auto}}
    .hotspot-picker{margin:14px 0;padding:16px;border:1px solid #35415e;border-radius:14px;background:#0d1425}.hotspot-picker-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.hotspot-picker-head strong,.hotspot-picker-head small{display:block}.hotspot-picker-head small{margin-top:4px;color:#9eabc3}.hotspot-page-list{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:310px;overflow:auto;padding-right:4px}.hotspot-page-choice{display:flex!important;align-items:flex-start!important;gap:10px!important;padding:12px;border:1px solid #2f3d5b;border-radius:11px;background:#131d33;cursor:pointer;transition:border-color .15s,background .15s}.hotspot-page-choice:has(input:checked){border-color:#438aff;background:#172c50}.hotspot-page-choice input{width:19px!important;height:19px!important;min-width:19px!important;margin-top:1px}.hotspot-page-choice strong{display:block;font-size:14px}.hotspot-page-choice small{display:block;margin-top:3px;color:#8796b1;font-size:12px}.selection-count{white-space:nowrap}.selection-count.ok{background:#153b31;color:#74e5af}@media(max-width:720px){.hotspot-page-list{grid-template-columns:1fr}.hotspot-picker-head{align-items:flex-start}}
    .sale-reminder-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 0 4px}.sale-reminder-toolbar .compact-copy{margin:0}.sale-reminder-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px}.sale-reminder-card{min-width:0;overflow:hidden;border:1px solid #8c4725;border-radius:18px;background:linear-gradient(160deg,#17161a,#0f1118 68%);box-shadow:0 15px 34px #0006,0 0 0 1px #ff742818;transition:transform .16s ease,border-color .16s ease}.sale-reminder-card:hover{transform:translateY(-2px);border-color:#d66a30}.sale-reminder-card.paused{opacity:.58;filter:saturate(.65)}.sale-reminder-product{display:block;color:inherit;text-decoration:none}.sale-reminder-media{position:relative;display:grid;place-items:center;aspect-ratio:16/9;overflow:hidden;background:#f7f7f8}.sale-reminder-media img{width:100%;height:100%;object-fit:contain}.sale-reminder-placeholder{display:grid;place-items:center;width:100%;height:100%;background:radial-gradient(circle at 50% 40%,#2a3141,#11151e 70%);font-size:58px}.sale-reminder-platform{position:absolute;top:12px;left:12px;padding:7px 10px;border-radius:8px;background:#1b1e26e8;color:#f6f7f9;font-size:12px;font-weight:900;letter-spacing:.06em;box-shadow:0 5px 16px #0006}.sale-reminder-content{padding:17px 18px 14px}.sale-reminder-title{min-height:52px;margin:0;color:#f1f2f6;font-size:18px;line-height:1.42;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.sale-reminder-sale-time{display:flex;align-items:center;gap:7px;margin:13px 0 15px;color:#f0a33b;font-size:16px;font-weight:900}.sale-reminder-facts{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}.sale-reminder-price{color:#ffd05c;font-size:24px;font-weight:900}.sale-reminder-stock{color:#aeb5c3;font-size:16px;font-weight:800}.sale-reminder-stock.live{color:#54dfa0}.sale-reminder-stock.sold{color:#a7afbd}.sale-reminder-meta{margin-top:11px;color:#7f899c;font-size:12px}.sale-reminder-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-top:1px solid #2b2d35;background:#0d0f15}.sale-reminder-actions{display:flex;gap:7px;align-items:center}.sale-reminder-actions button{padding:7px 10px;font-size:12px}.sale-reminder-countdown{color:#53dda0;font-size:12px;font-weight:900}.sale-reminder-countdown.started{color:#f0a33b}.sale-reminder-list>.muted{grid-column:1/-1}.sale-reminder-refresh{white-space:nowrap}@media(max-width:720px){.sale-reminder-toolbar{align-items:flex-start;flex-direction:column}.sale-reminder-list{grid-template-columns:1fr}.sale-reminder-title{min-height:0}.sale-reminder-media{aspect-ratio:4/3}}
    .sale-reminder-product{display:grid;grid-template-columns:132px minmax(0,1fr)}.sale-reminder-media{aspect-ratio:auto;min-height:158px}.sale-reminder-platform{top:8px;left:8px;padding:5px 7px;font-size:10px}.sale-reminder-placeholder{font-size:42px}.sale-reminder-content{padding:15px}.sale-reminder-title{font-size:16px;min-height:45px}.sale-reminder-sale-time{font-size:14px;margin:10px 0 12px}.sale-reminder-price{font-size:20px}.sale-reminder-stock{font-size:13px}.reminder-url-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;margin:14px 0 9px}.reminder-url-row input{width:100%;min-width:0}.reminder-details-row{display:grid;grid-template-columns:minmax(180px,1.4fr) minmax(190px,.8fr) auto;gap:9px}.reminder-details-row input{width:100%;min-width:0}.reminder-inspect-state{display:flex;align-items:center;gap:10px;min-height:28px;margin:3px 0 10px;color:#9eabc3;font-size:13px}.reminder-inspect-state.ok{color:#5ee09b}.reminder-inspect-state.bad{color:#ff9b9b}.reminder-inspect-dot{width:9px;height:9px;border-radius:999px;background:#52617d}.reminder-inspect-state.loading .reminder-inspect-dot{background:#438aff;box-shadow:0 0 0 5px #438aff22;animation:notification-progress 1.1s linear infinite}.reminder-inspect-state.ok .reminder-inspect-dot{background:#35cf89}.reminder-inspect-state.bad .reminder-inspect-dot{background:#ef6675}.sale-reminder-view-switch{display:flex;gap:4px;padding:4px;border:1px solid #35415e;border-radius:10px;background:#0d1425}.sale-reminder-view-switch button{padding:6px 10px;background:transparent;color:#aeb9ce;font-size:12px}.sale-reminder-view-switch button.active{background:#365f9f;color:#fff}.sale-reminder-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sale-reminder-list.list-view{display:block}.sale-reminder-list.list-view .sale-reminder-card{display:grid;grid-template-columns:minmax(0,1fr) auto;margin-top:10px;border-color:#33415f;border-radius:12px;background:#111a2c;box-shadow:none}.sale-reminder-list.list-view .sale-reminder-card:hover{transform:none;border-color:#5273a7}.sale-reminder-list.list-view .sale-reminder-product{grid-template-columns:76px minmax(0,1fr)}.sale-reminder-list.list-view .sale-reminder-media{min-height:96px;margin:10px;border-radius:8px}.sale-reminder-list.list-view .sale-reminder-platform{display:none}.sale-reminder-list.list-view .sale-reminder-content{padding:12px 10px}.sale-reminder-list.list-view .sale-reminder-title{min-height:0;-webkit-line-clamp:1}.sale-reminder-list.list-view .sale-reminder-sale-time{margin:5px 0 7px}.sale-reminder-list.list-view .sale-reminder-meta{display:none}.sale-reminder-list.list-view .sale-reminder-footer{min-width:170px;border-top:0;border-left:1px solid #2b3650;flex-direction:column;align-items:flex-end;justify-content:center}.sale-reminder-list.list-view .sale-reminder-facts{justify-content:flex-start}.sale-reminder-list.list-view .sale-reminder-price{font-size:17px}.sale-reminder-list.list-view .sale-reminder-stock{font-size:12px}@media(max-width:720px){.sale-reminder-product{grid-template-columns:96px minmax(0,1fr)}.sale-reminder-media{min-height:132px;aspect-ratio:auto}.reminder-url-row,.reminder-details-row{grid-template-columns:1fr}.reminder-url-row button,.reminder-details-row button{width:100%}.sale-reminder-list.list-view .sale-reminder-card{grid-template-columns:1fr}.sale-reminder-list.list-view .sale-reminder-footer{min-width:0;border-left:0;border-top:1px solid #2b3650;flex-direction:row;align-items:center}.sale-reminder-toolbar{gap:10px}.sale-reminder-tools{width:100%;justify-content:space-between}}
    .shopping-target{display:block;padding:14px 0}.shopping-target-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}.shopping-target-title{margin:3px 0 8px;font-size:16px;line-height:1.4}.shopping-target-facts{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.shopping-target-fact{padding:5px 8px;border-radius:8px;background:#18233a;color:#aebad0;font-size:12px}.shopping-target-link{white-space:nowrap;color:#80b5ff;font-size:13px;font-weight:800;text-decoration:none}.shopping-target-manage{margin-top:12px;border-top:1px solid #28334b}.shopping-target-manage>summary{padding:11px 0 0;color:#8fa5c8;font-size:13px;font-weight:800;cursor:pointer;list-style:none}.shopping-target-manage>summary::-webkit-details-marker{display:none}.shopping-target-manage>summary:after{content:"設定暱稱、時段與啟停";margin-left:8px;color:#667895;font-weight:500}.shopping-target-manage[open]>summary{color:#78aefc}.shopping-target-manage-body{display:grid;gap:11px;margin-top:12px;padding:14px;border-radius:12px;background:#0b1324}.shopping-target-manage .page-url{margin:0}.shopping-target-actions{justify-content:flex-start}.shopping-hub-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.purchase-hub>.purchase-stack{margin-top:6px}.purchase-hub .purchase-stack>.card{margin:12px 0;box-shadow:none;background:#10182b}.system-detail{display:grid;gap:5px;margin-top:9px;padding-top:9px;border-top:1px solid #27334d;color:#8fa0bd;font-size:12px;line-height:1.45}.system-primary{color:#dce7f7!important;font-weight:700}.status-tile.shopping-tile{border-color:#31517e;background:linear-gradient(145deg,#10233d,#0d1729)}.status-tile.purchase-tile{border-color:#62477b;background:linear-gradient(145deg,#211932,#101629)}@media(max-width:620px){.shopping-target-head{grid-template-columns:1fr}.shopping-target-link{width:max-content}.shopping-target-manage:open{margin-bottom:4px}.shopping-name-edit{align-items:stretch;flex-direction:column}.shopping-name-edit input{width:100%}.shopping-schedule-editor{align-items:stretch;flex-direction:column}.shopping-schedule-editor select,.shopping-schedule-editor input{width:100%}.shopping-schedule-editor span{padding:2px 0}}
    .funbox-account-list{display:grid;gap:10px;margin-top:14px}.funbox-account{padding:13px;border:1px solid #2a3854;border-radius:12px;background:#0b1324}.funbox-account-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.funbox-account-title{font-weight:900;color:#e5edfb}.funbox-account-status{font-size:12px;color:#9fb0cc}.funbox-account .field{margin:0}.funbox-account input[type="text"],.funbox-account input[type="password"]{min-width:180px;flex:1}.funbox-account-meta{margin:9px 0 0;color:#8fa0bd;font-size:12px;line-height:1.5}.funbox-payment-strategy{display:grid;grid-template-columns:auto minmax(260px,420px);align-items:center;gap:10px;margin-top:11px}.funbox-payment-strategy>strong{color:#aebad0;font-size:13px}.funbox-payment-options{display:grid;grid-template-columns:1fr 1fr;gap:7px}.funbox-payment-choice{position:relative;display:block}.funbox-payment-choice input{position:absolute;opacity:0;pointer-events:none}.funbox-payment-choice span{display:block;padding:9px 11px;border:1px solid #35415e;border-radius:9px;background:#101a2e;color:#aebad0;font-size:13px;font-weight:800;text-align:center;cursor:pointer}.funbox-payment-choice:has(input:checked) span{border-color:#438aff;background:#1c3970;color:#fff;box-shadow:0 0 0 2px #438aff22}.eslite-account-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:13px 0 10px;padding:11px 12px;border:1px solid #2b3d5d;border-radius:11px;background:#0b1426}.eslite-account-toolbar-copy{display:grid;gap:3px}.eslite-account-toolbar-copy strong{color:#dce8fa}.eslite-account-toolbar-copy small{color:#8fa0bd}.eslite-account-card[hidden]{display:none}.eslite-account-card.compact{padding-bottom:10px}.eslite-account-card.compact .eslite-account-body{display:none}.eslite-account-card.compact .funbox-account-head{margin-bottom:0}.eslite-account-head-actions{display:flex;align-items:center;gap:8px}.eslite-heartbeat-summary{margin-top:11px;padding:10px 12px;border-radius:10px;background:#101d33;color:#9db0cf;font-size:12px;line-height:1.55}.eslite-heartbeat-summary.ok{color:#76e4a5;background:#102b28}.eslite-heartbeat-summary.bad{color:#ff9d9d;background:#2a1822}.funbox-rule-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.funbox-rule-box{display:block;width:100%;padding:14px;border:1px solid #31415e;border-radius:13px;background:#0b1324}.funbox-rule-box.black{border-color:#694253}.funbox-rule-box.white{border-color:#315d52}.funbox-rule-box strong,.funbox-rule-box small{display:block}.funbox-rule-box small{min-height:38px;margin:5px 0 10px;color:#91a1bc;line-height:1.45}.funbox-rule-box textarea{min-height:178px}.funbox-rule-summary{margin-top:10px;color:#9eabc3;font-size:13px}@media(max-width:720px){.funbox-account .field{align-items:stretch;flex-direction:column}.funbox-account .field input,.funbox-account .field button{width:100%}.funbox-account-head{align-items:flex-start;flex-direction:column}.eslite-account-toolbar{align-items:stretch;flex-direction:column}.eslite-account-head-actions{width:100%;justify-content:space-between}.funbox-payment-strategy{grid-template-columns:1fr}.funbox-payment-options{grid-template-columns:1fr}.funbox-rule-grid{grid-template-columns:1fr}.funbox-rule-box small{min-height:0}}
    .purchase-console{overflow:hidden;border:1px solid #2b3954;border-radius:12px;background:#0b1322}.funbox-account-list,.funbox-account-grid{display:grid;gap:0;margin-top:12px;overflow:hidden;border:1px solid #2b3954;border-radius:12px;background:#0b1322}.funbox-account-list .funbox-account,.funbox-account-grid .funbox-account{margin:0;padding:0;border:0;border-bottom:1px solid #27344d;border-radius:0;background:transparent}.funbox-account-list .funbox-account:last-child,.funbox-account-grid .funbox-account:last-child{border-bottom:0}.purchase-account-row .funbox-account-head{margin:0;padding:10px 12px;background:#111b2e}.purchase-account-row .funbox-account-title{font-size:14px}.purchase-account-row .pill{padding:5px 9px;font-size:12px}.purchase-account-row .funbox-account-body,.purchase-account-row .eslite-account-body{padding:10px 12px;border-top:1px solid #233049}.purchase-account-row.compact .funbox-account-body,.purchase-account-row.compact .eslite-account-body{display:none}.purchase-account-row .field{display:grid;grid-template-columns:auto minmax(150px,1fr) minmax(150px,1fr) repeat(4,auto);gap:7px}.purchase-account-row .field input{width:100%;min-width:0;padding:8px 10px}.purchase-account-row .field button{padding:8px 10px;font-size:12px;white-space:nowrap}.purchase-account-row .funbox-payment-strategy{grid-template-columns:auto minmax(250px,430px);margin-top:8px}.purchase-account-row .funbox-payment-options{display:flex;gap:7px}.purchase-account-row .funbox-payment-choice span{padding:7px 9px;font-size:12px}.purchase-account-row .funbox-account-meta{margin:0;padding:8px 12px;color:#8391aa;background:#0a111f;border-top:1px solid #1e2a40;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.purchase-account-row:not(.compact) .funbox-account-meta{white-space:normal}.purchase-table-head{display:grid;grid-template-columns:100px minmax(150px,.8fr) minmax(150px,1fr) minmax(190px,1.5fr);gap:10px;padding:8px 12px;color:#7787a2;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border:1px solid #293754;border-bottom:0;border-radius:11px 11px 0 0;background:#0b1220}.purchase-task-list{display:grid;gap:0;overflow:hidden;border:1px solid #293754;border-radius:0 0 11px 11px;background:#0b1220}.purchase-task-row{padding:0!important;margin:0!important;border:0!important;border-bottom:1px solid #293754!important;border-radius:0!important;background:#10192b!important;box-shadow:none!important}.purchase-task-row:last-child{border-bottom:0!important}.purchase-task-summary{display:grid;grid-template-columns:100px minmax(150px,.8fr) minmax(150px,1fr) minmax(190px,1.5fr);gap:10px;align-items:center;padding:10px 12px}.purchase-task-cell{min-width:0}.purchase-task-cell strong,.purchase-task-cell small{display:block}.purchase-task-cell strong{font-size:13px}.purchase-task-cell small{margin-top:3px;color:#8290a8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.purchase-task-editor{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;gap:8px;align-items:center;padding:9px 12px;border-top:1px solid #25324b;background:#0d1627}.purchase-task-editor .field{margin:0}.purchase-task-editor input[type=url]{min-width:180px;padding:8px 10px}.purchase-task-editor select,.purchase-task-editor input[type=number]{padding:8px 9px}.purchase-task-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.purchase-task-actions button{padding:7px 9px;font-size:12px}.purchase-task-message{margin:0;padding:0 12px}.purchase-task-message:not(:empty){padding-top:8px;padding-bottom:8px}.purchase-task-log{border-top:1px solid #25324b}.purchase-task-log>summary{padding:9px 12px!important;font-size:12px!important;color:#8fa3c5}.purchase-task-log[open]>summary{margin:0!important;border-bottom:1px solid #25324b!important}.purchase-task-log pre{margin:0;border-radius:0;max-height:220px;font-size:12px}.purchase-log-list .product-row{padding:9px 12px}.purchase-log-list .product-row strong{font-size:13px}.purchase-hub>.purchase-stack{gap:10px}.purchase-hub>.purchase-stack>.card{padding:14px;margin:0}.purchase-hub .card-heading h2{font-size:16px}.purchase-hub .compact-copy{margin:5px 0 10px;font-size:13px}.purchase-hub .eslite-account-toolbar{margin:9px 0}.purchase-hub .eslite-heartbeat-summary{margin-top:8px}@media(max-width:900px){.purchase-account-row .field{grid-template-columns:auto 1fr 1fr}.purchase-account-row .field button{grid-row:auto}.purchase-table-head{display:none}.purchase-task-list{border-radius:11px}.purchase-task-summary{grid-template-columns:1fr 1fr}.purchase-task-editor{grid-template-columns:1fr}.purchase-task-actions{justify-content:flex-start}}@media(max-width:620px){.purchase-task-summary{grid-template-columns:1fr}.purchase-task-cell{display:grid;grid-template-columns:92px 1fr;gap:8px}.purchase-task-cell:before{content:attr(data-label);color:#7485a1;font-size:11px;font-weight:800}.purchase-account-row .field{display:flex}.purchase-account-row .funbox-account-meta{white-space:normal}.purchase-account-row .funbox-payment-strategy{grid-template-columns:1fr}.purchase-account-row .funbox-payment-options{display:grid}}
    .tab-bar{grid-template-columns:repeat(5,1fr)}.japan-target-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.japan-target-card{min-width:0;padding:16px;border:1px solid #31415f;border-radius:15px;background:#101a2e}.japan-target-card h3{margin:4px 0 8px;overflow-wrap:anywhere}.japan-target-card .page-url{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.japan-target-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}@media(max-width:720px){.tab-bar{display:flex;overflow-x:auto;scrollbar-width:thin}.tab-button{flex:0 0 108px;white-space:nowrap}.japan-target-grid{grid-template-columns:1fr}}
    .inline-create{margin-top:12px;border-top:1px solid #293754}.inline-create>summary{padding:12px 2px 4px;color:#78aefc;font-size:13px;font-weight:800;cursor:pointer;list-style:none}.inline-create>summary::-webkit-details-marker{display:none}.inline-create>summary:after{content:"展開";float:right;color:#7385a4;font-weight:600}.inline-create[open]>summary:after{content:"收合"}.inline-create form{padding-top:9px}.inline-create .compact-copy{margin:8px 0 0}.section-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.section-tools .compact-copy{margin:0;flex:1}.compact-status-card .primary-actions{padding:12px}.compact-status-card .row{gap:7px}.compact-status-card .pill{padding:5px 9px;font-size:12px}.compact-status-card .muted{margin:9px 0}.compact-status-card .notice:empty{display:none}
    .eslite-monitor-status{display:grid;gap:10px;margin:12px 0;padding:13px;border:1px solid #2c3b58;border-radius:12px;background:#0b1425}.eslite-exhibition-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.eslite-exhibition-title{display:flex;align-items:center;gap:9px;min-width:0}.eslite-exhibition-title strong{color:#e2ebfa}.eslite-exhibition-title a{color:#7eb4ff;font-size:12px;font-weight:800;text-decoration:none}.eslite-exhibition-meta{margin:0;color:#8fa0bd;font-size:12px;line-height:1.55}.eslite-baseline-details{border-top:1px solid #25334d}.eslite-baseline-details>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 1px 1px;color:#dce7f7;font-size:13px;font-weight:900;cursor:pointer;list-style:none}.eslite-baseline-details>summary::-webkit-details-marker{display:none}.eslite-baseline-details>summary:after{content:"展開";margin-left:auto;color:#7f91ae;font-size:12px}.eslite-baseline-details[open]>summary:after{content:"收合"}.eslite-baseline-list{display:grid;gap:0;margin-top:10px;overflow:hidden;border:1px solid #283650;border-radius:10px}.eslite-baseline-item{padding:10px 12px;border-bottom:1px solid #25324a;background:#0e1829}.eslite-baseline-item:last-child{border-bottom:0}.eslite-baseline-item a{display:block;overflow:hidden;color:#dbe8fa;font-size:13px;font-weight:800;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.eslite-baseline-item-meta{margin-top:4px;color:#8292ab;font-size:11px}@media(max-width:620px){.eslite-exhibition-head{display:grid;align-items:flex-start}}
    .tab-panel .card{scroll-margin-top:92px}
    ${overviewCss}
    /* Long heartbeat text must not push account actions beyond the clipped grid. */
    #eslite-account-list{grid-template-columns:minmax(0,1fr);min-width:0;width:100%}
    #eslite-account-list .eslite-account-card{min-width:0;max-width:100%}
    #eslite-account-list .funbox-account-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;min-width:0}
    #eslite-account-list .funbox-account-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #eslite-account-list .eslite-account-head-actions{width:auto;flex-shrink:0;justify-content:flex-end;white-space:nowrap}
    #eslite-account-list .eslite-account-head-actions button{flex:none;min-width:68px;padding:7px 9px}
    #eslite-account-list .pill{min-width:72px;text-align:center;white-space:nowrap;flex:none}
    #eslite-account-list .funbox-account-meta{min-width:0;max-width:100%;overflow-wrap:anywhere}
    #eslite-account-list .field{grid-template-columns:auto minmax(0,1fr) minmax(0,1fr) auto auto}
    #auto-purchase-eslite-summary{flex:none;white-space:nowrap}
    @media(max-width:620px){#eslite-account-list .funbox-account-head{grid-template-columns:minmax(0,1fr);gap:8px}#eslite-account-list .eslite-account-head-actions{justify-content:flex-start;gap:6px;flex-wrap:wrap}}
.purchase-rules-fold{margin-top:12px;border:1px solid #293754;border-radius:10px;background:#0b1425}.purchase-rules-fold>summary{padding:10px 12px;display:flex;justify-content:space-between;gap:12px;cursor:pointer;font-size:13px;font-weight:700}.purchase-rules-fold[open]>summary{border-bottom:1px solid #293754}.purchase-rules-fold>div,.purchase-rules-fold>p{margin:10px 12px}.purchase-rules-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px}.purchase-rules-toolbar select{padding:7px 9px;font-size:12px}.purchase-rule-editors{gap:10px}.purchase-rule-editors .funbox-rule-box{padding:10px;margin:0}.purchase-rule-editors textarea{height:140px;min-height:100px;max-height:260px;resize:vertical;font-size:13px;line-height:1.6}.purchase-rule-editors small{min-height:32px;font-size:11px}.purchase-help{font-size:12px;color:#8fa3c5;margin-bottom:12px}.purchase-help summary{cursor:pointer}.purchase-hub .purchase-stack .card{padding:14px}.purchase-rules-fold .muted{font-size:11px;font-weight:400}@media(max-width:680px){.purchase-rule-editors{grid-template-columns:1fr}.purchase-rules-fold>summary{flex-wrap:wrap}}
.purchase-results-scroll{overflow-x:auto}.purchase-results-table{width:100%;min-width:850px;border-collapse:collapse;font-size:12px}.purchase-results-table th,.purchase-results-table td{padding:9px 10px;text-align:left;border-bottom:1px solid #26334b;vertical-align:top}.purchase-results-table th{color:#8d9db7;background:#0a1425;white-space:nowrap}.purchase-results-table td:nth-child(3){min-width:200px;max-width:320px}.purchase-results-table small{display:block;margin-top:5px;font-size:11px;overflow-wrap:anywhere}.purchase-results-table .pill{font-size:11px;padding:4px 7px;white-space:nowrap}
${esliteTableCss}
${funboxTableCss}
.amazon-order-console{overflow:hidden;border:1px solid #29364d;border-radius:12px;background:#0d1625}.amazon-order-sheet{width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px}.amazon-order-sheet caption,.amazon-visually-hidden{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.amazon-task-col{width:48px}.amazon-state-col{width:105px}.amazon-progress-col{width:86px}.amazon-count-col{width:76px}.amazon-shipping-col{width:98px}.amazon-actions-col{width:222px}.amazon-order-sheet th,.amazon-order-sheet td{border:0;border-bottom:1px solid #233149;text-align:left;padding:11px 10px;vertical-align:middle;min-width:0}.amazon-order-sheet thead th{font-size:11px;letter-spacing:.04em;font-weight:500;color:#8395b0;background:#101c2d;padding-top:10px;padding-bottom:10px;white-space:nowrap}.amazon-order-sheet thead .muted{font-weight:400;font-size:10px;color:#677a97}.amazon-order-main{height:58px;transition:background .15s}.amazon-order-main:hover{background:#142238}.amazon-slot{display:inline-grid;place-items:center;width:25px;height:25px;border-radius:7px;background:#1a2d48;color:#9ec9ff;font-weight:700}.amazon-product-cell{overflow:hidden}.amazon-product-disclosure{padding:0!important;margin:0!important;border:0!important;background:none!important}.amazon-product-disclosure>summary{display:flex;align-items:center;gap:7px;cursor:pointer;padding:0!important;list-style:none;font-size:12px!important;min-width:0}.amazon-product-disclosure>summary::-webkit-details-marker{display:none}.amazon-product-disclosure>summary:before{content:'›';flex:0 0 10px;color:#7698c3;transition:transform .15s}.amazon-product-disclosure[open]>summary:before{transform:rotate(90deg)}.amazon-product-line{display:flex;align-items:center;gap:8px;min-width:0}.amazon-product-code{flex:none;color:#8bb9f5;font-size:11px;font-weight:600}.amazon-product-line strong{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:500;color:#e3ebf7;min-width:0}.amazon-order-sheet .pill{display:inline-block;max-width:100%;box-sizing:border-box;font-size:11px;padding:4px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.amazon-numeric{font-variant-numeric:tabular-nums;white-space:nowrap;color:#dbe9fa}.amazon-order-sheet input[type=number]{width:100%;min-width:0;box-sizing:border-box;padding:5px 7px;margin:0;border:1px solid #2a3b56;border-radius:6px;background:#0b1423;font-size:12px;font-variant-numeric:tabular-nums}.amazon-order-sheet input[type=number]:hover{border-color:#46648b}.amazon-order-actions{display:flex;align-items:center;gap:6px;white-space:nowrap}.amazon-order-actions label{display:flex;align-items:center;flex:0 0 auto;gap:4px;margin:0;min-width:0;font-size:11px;color:#b9c8dd}.amazon-order-actions input[type=checkbox]{width:13px;min-width:0;height:13px;margin:0;accent-color:#6fa9fa}.amazon-order-actions button{flex:0 0 auto;min-width:0;padding:5px 8px;border:1px solid #344966;border-radius:6px;background:#1a2a40;color:#c8dcf5;font-size:11px;font-weight:500;line-height:18px}.amazon-order-actions button:hover{background:#294263;border-color:#5c82b2}.amazon-order-detail-row[hidden]{display:none}.amazon-order-detail-row td{padding:0;background:#0a1321}.amazon-order-drawer{padding:12px 16px 14px;border-left:2px solid #3c6598;margin:0 10px 10px}.amazon-detail-meta{color:#8da2bf;font-size:11px;margin-bottom:9px}.amazon-url-field{display:flex;align-items:center;gap:10px;font-size:11px;color:#8da2bf}.amazon-url-field input[type=url]{flex:1;min-width:0;width:100%;box-sizing:border-box;padding:7px 9px;font-size:11px;border-radius:6px}.amazon-step-stream{margin:10px 0 0;padding:10px 12px;max-height:180px;font-size:11px;background:#08101c;border:0;border-radius:6px}.amazon-order-help{padding:9px 12px;font-size:11px;margin:0;color:#7489a7!important;line-height:1.5}.amazon-order-feedback{font-size:12px;color:#a5c9f8;padding:8px 12px;margin:0;border-top:1px solid #26364e}.amazon-order-feedback:empty{display:none}@media(max-width:950px){.amazon-task-col{width:40px}.amazon-state-col{width:90px}.amazon-progress-col{width:75px}.amazon-count-col{width:65px}.amazon-shipping-col{width:85px}.amazon-actions-col{width:207px}.amazon-order-sheet th,.amazon-order-sheet td{padding-left:7px;padding-right:7px}.amazon-order-sheet thead .muted{display:none}.amazon-product-code{display:none}}@media(max-width:700px){.amazon-order-sheet colgroup,.amazon-order-sheet thead{display:none}.amazon-order-sheet tbody{display:block}.amazon-order-main{display:grid;height:auto;grid-template-columns:32px minmax(0,1fr) 90px;align-items:center}.amazon-order-main>th,.amazon-order-main>td{border:0}.amazon-order-main>td:nth-child(4){grid-column:1/2;font-size:10px;padding-left:8px}.amazon-order-main>td:nth-child(5),.amazon-order-main>td:nth-child(6){display:block}.amazon-order-main>td:nth-child(5):before{content:'目標次數';font-size:10px;color:#8395b0}.amazon-order-main>td:nth-child(6):before{content:'運費上限 ¥';font-size:10px;color:#8395b0}.amazon-order-main>td:last-child{grid-column:2/4;justify-self:end}.amazon-order-sheet{display:block}.amazon-order-detail-row:not([hidden]){display:table;width:100%}.amazon-order-detail-row td{display:block}.amazon-product-line strong{font-size:11px}.amazon-url-field{display:block}.amazon-url-field input{margin-top:6px}}
.amazon-live-logs{margin:12px 0 16px;border:1px solid #29364d;border-radius:10px;background:#0a1321;overflow:hidden}.amazon-live-log-toolbar{display:flex;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid #233149;font-size:12px}.amazon-live-log-toolbar strong{color:#c6d9f3}.amazon-live-log-toolbar span{color:#7087a8;font-size:11px}.amazon-live-log-toolbar button{margin-left:auto;padding:4px 11px;font-size:11px;background:#192a41;border:1px solid #344966;border-radius:6px}.amazon-live-log-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.amazon-live-log-column{min-width:0;border-right:1px solid #233149}.amazon-live-log-column:last-child{border:0}.amazon-live-log-column header{display:flex;justify-content:space-between;align-items:center;padding:8px 11px;font-size:11px;color:#8198b9}.amazon-live-log-column header strong{color:#9ec9ff}.amazon-live-log-column pre{margin:0;padding:0 11px 10px;max-height:150px;min-height:58px;background:transparent;border:0;border-radius:0;font-size:10px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:800px){.amazon-live-log-grid{grid-template-columns:1fr}.amazon-live-log-column{border-right:0;border-bottom:1px solid #233149}.amazon-live-log-toolbar span{font-size:10px}.amazon-live-log-column pre{max-height:110px;min-height:35px}}
.amazon-evidence-links>div{padding:8px 0;border-bottom:1px solid #29364d;font-size:12px;line-height:1.9}.amazon-evidence-links strong{margin-right:10px}.amazon-evidence-links a{margin-right:8px;color:#87b9ff}
</style>
</head>
<body>
  <header class="hero">
    <div class="brand-mark" aria-hidden="true">🌀</div>
    <div>
      <div class="eyebrow">Beyblade Monitor</div>
      <h1>陀螺監控儀表</h1>
      <div class="hero-copy">掃描優先 · 即時通知 · 自動下單</div>
    </div>
  </header>

  <nav class="tab-bar" role="tablist" aria-label="主要功能">
    <button id="tab-button-overview" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="tab-overview" onclick="switchTab('overview')"><span aria-hidden="true">◉</span> 總覽</button>
    <button id="tab-button-funbox" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="tab-funbox" onclick="switchTab('funbox')"><span aria-hidden="true">🛒</span> Funbox 官網</button>
    <button id="tab-button-shopping" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="tab-shopping" onclick="switchTab('shopping')"><span aria-hidden="true">🏬</span> 購物網站</button>
    <button id="tab-button-japan" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="tab-japan" onclick="switchTab('japan')"><span aria-hidden="true">🇯🇵</span> 日本拍賣</button>
    <button id="tab-button-shared" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="tab-shared" onclick="switchTab('shared')"><span aria-hidden="true">⚙️</span> 系統設定</button>
  </nav>
  ${overviewHtml}

  <p id="result" class="notice muted" role="status"></p>

  <main id="tab-funbox" class="tab-panel" role="tabpanel" aria-labelledby="tab-button-funbox" hidden>
    <div class="page-title"><div class="page-icon" aria-hidden="true">🛒</div><div><h2>Funbox 官網監控</h2><p>追蹤戰鬥陀螺新品、前台可售數量與庫存下降，通知內可直接前往商品頁。</p></div></div>

    <section class="card">
      <div class="card-heading"><h2>官網監控</h2></div>
      <div class="row" id="funbox-summary"></div>
      <p id="funbox-last"></p>
      <p id="funbox-error" class="bad"></p>
      <div class="primary-actions">
        <div class="row">
          <button id="funbox-monitor-button" onclick="toggleFunboxMonitoring()">讀取中</button>
          <button class="secondary" onclick="action('/scan-funbox')">立即檢查官網</button>
          <a class="button-link" href="https://shop.funbox.com.tw/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA" target="_blank" rel="noopener noreferrer">前往 Funbox 陀螺專區</a>
        </div>
      </div>
      <p id="funbox-result" class="notice muted"></p>
    </section>

    <div class="section-kicker">私人搶購助手</div>
    <section class="card funbox-purchase-panel">
      <div class="card-heading"><div><h2>🔐 Funbox 多帳號同步下單</h2><p class="compact-copy">單品／合單各帳號自選｜獨立佇列｜優先關鍵字 → 其餘隨機｜最多三路並行</p></div><span id="auto-purchase-funbox-summary" class="pill">已關閉</span></div>
      <div class="field"><button type="button" class="secondary small" onclick="addFunboxAccountCard()">＋新增帳號</button><button id="funbox-purchase-readiness-button" type="button" class="secondary small" onclick="checkPurchaseReadiness('funbox')">補貨前檢查</button><button id="funbox-clear-all-carts" type="button" class="secondary small" title="清空 FUNBOX 所有已設定帳號；忙碌、瀏覽器使用中與訂單待核對的帳號會跳過" onclick="purchaseAccountAction(this,'funbox',null,'clear-all-carts')">一鍵全清</button><small class="muted">可新增 D～N；只有已啟用帳號會接任務。</small></div>
      <div id="funbox-purchase-readiness" aria-live="polite"></div>
      ${funboxAccountTableHtml}
      <div id="funbox-account-list" class="funbox-account-list">
        <form id="funbox-account-A-card" class="funbox-account purchase-account-row compact" onsubmit="saveFunboxAccount(event,'A')"><div class="funbox-account-head"><span id="funbox-account-A-title" class="funbox-account-title">帳號 A｜尚未設定</span><div class="eslite-account-head-actions"><span id="funbox-account-A-status" class="pill">未設定</span><button type="button" class="secondary small" onclick="toggleFunboxAccountCard('A')">設定</button></div></div><div class="funbox-account-body"><div class="field"><label><input id="funbox-account-A-enabled" type="checkbox" checked> 使用</label><input id="funbox-account-A-account" type="text" autocomplete="username" placeholder="帳號／手機（不更改可留空）"><input id="funbox-account-A-password" type="password" autocomplete="current-password" placeholder="密碼（不更改可留空）"><button type="submit">儲存</button><button type="button" class="secondary" onclick="testAutoPurchaseLogin('funbox','A')">登入</button><button type="button" class="secondary" onclick="completeAutoPurchaseLogin('funbox','A')">檢查</button><button type="button" class="danger" onclick="clearFunboxAccount('A')">清除</button></div><div class="funbox-payment-strategy"><strong>購買策略</strong><div class="funbox-payment-options"><label class="funbox-payment-choice"><input type="radio" name="funbox-account-A-payment" value="seven_cod" onchange="markAutoPurchaseDirty('funbox')"><span>超商貨付</span></label><label class="funbox-payment-choice"><input type="radio" name="funbox-account-A-payment" value="virtual_atm_home" onchange="markAutoPurchaseDirty('funbox')"><span>宅配虛擬 ATM</span></label></div></div></div><p id="funbox-account-A-meta" class="funbox-account-meta">登入狀態尚未驗證。</p></form>
        <form id="funbox-account-B-card" class="funbox-account purchase-account-row compact" onsubmit="saveFunboxAccount(event,'B')"><div class="funbox-account-head"><span id="funbox-account-B-title" class="funbox-account-title">帳號 B｜尚未設定</span><div class="eslite-account-head-actions"><span id="funbox-account-B-status" class="pill">未設定</span><button type="button" class="secondary small" onclick="toggleFunboxAccountCard('B')">設定</button></div></div><div class="funbox-account-body"><div class="field"><label><input id="funbox-account-B-enabled" type="checkbox" checked> 使用</label><input id="funbox-account-B-account" type="text" autocomplete="username" placeholder="帳號／手機（不更改可留空）"><input id="funbox-account-B-password" type="password" autocomplete="current-password" placeholder="密碼（不更改可留空）"><button type="submit">儲存</button><button type="button" class="secondary" onclick="testAutoPurchaseLogin('funbox','B')">登入</button><button type="button" class="secondary" onclick="completeAutoPurchaseLogin('funbox','B')">檢查</button><button type="button" class="danger" onclick="clearFunboxAccount('B')">清除</button></div><div class="funbox-payment-strategy"><strong>購買策略</strong><div class="funbox-payment-options"><label class="funbox-payment-choice"><input type="radio" name="funbox-account-B-payment" value="seven_cod" onchange="markAutoPurchaseDirty('funbox')"><span>超商貨付</span></label><label class="funbox-payment-choice"><input type="radio" name="funbox-account-B-payment" value="virtual_atm_home" onchange="markAutoPurchaseDirty('funbox')"><span>宅配虛擬 ATM</span></label></div></div></div><p id="funbox-account-B-meta" class="funbox-account-meta">登入狀態尚未驗證。</p></form>
        <form id="funbox-account-C-card" class="funbox-account purchase-account-row compact" onsubmit="saveFunboxAccount(event,'C')"><div class="funbox-account-head"><span id="funbox-account-C-title" class="funbox-account-title">帳號 C｜尚未設定</span><div class="eslite-account-head-actions"><span id="funbox-account-C-status" class="pill">未設定</span><button type="button" class="secondary small" onclick="toggleFunboxAccountCard('C')">設定</button></div></div><div class="funbox-account-body"><div class="field"><label><input id="funbox-account-C-enabled" type="checkbox" checked> 使用</label><input id="funbox-account-C-account" type="text" autocomplete="username" placeholder="帳號／手機（不更改可留空）"><input id="funbox-account-C-password" type="password" autocomplete="current-password" placeholder="密碼（不更改可留空）"><button type="submit">儲存</button><button type="button" class="secondary" onclick="testAutoPurchaseLogin('funbox','C')">登入</button><button type="button" class="secondary" onclick="completeAutoPurchaseLogin('funbox','C')">檢查</button><button type="button" class="danger" onclick="clearFunboxAccount('C')">清除</button></div><div class="funbox-payment-strategy"><strong>購買策略</strong><div class="funbox-payment-options"><label class="funbox-payment-choice"><input type="radio" name="funbox-account-C-payment" value="seven_cod" onchange="markAutoPurchaseDirty('funbox')"><span>超商貨付</span></label><label class="funbox-payment-choice"><input type="radio" name="funbox-account-C-payment" value="virtual_atm_home" onchange="markAutoPurchaseDirty('funbox')"><span>宅配虛擬 ATM</span></label></div></div></div><p id="funbox-account-C-meta" class="funbox-account-meta">登入狀態尚未驗證。</p></form>
      </div>
      <form onsubmit="saveAutoPurchasePlatform(event,'funbox')" style="margin-top:12px">
        <details class="purchase-rules-fold"><summary>FUNBOX 黑白名單 <span id="funbox-purchase-rule-summary" class="muted">讀取中…</span></summary>
        <div class="purchase-rules-toolbar"><span>只有白名單商品會購買；黑名單優先。</span><button type="button" class="secondary small" onclick="syncAutoPurchaseLists('eslite','funbox')">從購物網站合併黑白名單</button></div>
        <div class="funbox-rule-grid purchase-rule-editors">
          <div class="funbox-rule-box black"><label for="funbox-skip-buy-keywords"><strong>⛔ 只通知、不購買（黑名單）</strong></label><small>商品名稱命中任一行就跳過自動下單；即使也在白名單，仍以黑名單為準。</small><textarea id="funbox-skip-buy-keywords" oninput="markAutoPurchaseDirty('funbox')" placeholder="每行一個關鍵字"></textarea><div class="purchase-list-sort-actions"><button type="button" class="secondary small" aria-label="FUNBOX 黑名單排序" onclick="sortAutoPurchaseList('funbox','black')">排序</button></div></div>
          <div class="funbox-rule-box white"><label for="funbox-buy-keywords"><strong>✅ 自動下單目標（白名單）</strong></label><small>只有命中才購買；黑名單優先。排序另外使用優先關鍵字。</small><textarea id="funbox-buy-keywords" oninput="markAutoPurchaseDirty('funbox')" placeholder="每行一個關鍵字"></textarea><div class="purchase-list-sort-actions"><button type="button" class="secondary small" aria-label="FUNBOX 白名單排序" onclick="sortAutoPurchaseList('funbox','white')">排序</button></div></div>
        </div>
        </details>
        <div class="field eslite-priority-controls"><label for="funbox-priority-keywords">任務優先關鍵字（逗號分隔）</label><input id="funbox-priority-keywords" placeholder="例：BX-09,強化組" oninput="markAutoPurchaseDirty('funbox')"></div>
        <div class="field"><label><input id="auto-purchase-funbox-enabled" type="checkbox" onchange="markAutoPurchaseDirty('funbox')"> 啟用 Funbox 自動下單</label><input id="auto-purchase-funbox-quantity" type="hidden" value="1"><small class="muted">一般商品 ×1；隨機強化組沿用 ×3 策略。結果不明即保護帳號。</small><button type="submit">儲存自動下單設定</button></div>
      </form>
      <p id="auto-purchase-funbox-credentials" class="muted">帳密與背景登入狀態讀取中…</p><p id="auto-purchase-funbox-state" class="notice muted"></p>
      ${funboxOrderTablesHtml}
    </section>

    <div class="section-kicker">正式監控設定</div>
    <section class="card">
      <h2>掃描時間、速度與庫存提醒</h2>
      <form onsubmit="saveFunboxSettings(event)">
        <div class="field">
          <label>每日 <input id="funbox-active-start" type="time" oninput="funboxSettingsDirty=true" required></label>
          <span>到</span>
          <input id="funbox-active-end" type="time" oninput="funboxSettingsDirty=true" required>
        </div>
        <div class="field">
          <label>平時掃描間隔 <input id="funbox-interval" type="number" min="2" max="3600" step="1" oninput="funboxSettingsDirty=true" required></label>
          <span>秒</span>
          <button type="submit">儲存設定</button>
        </div>
        <label class="setting-toggle">
          <input id="funbox-stock-change-notifications" type="checkbox" onchange="funboxSettingsDirty=true">
          <span><strong>庫存門檻通知</strong><small>新品通知後自動改為每 5 秒強抓；只在跨過 100、50、20、10、售罄或補貨時通知，不會每 5 秒洗版。</small></span>
        </label>
      </form>
      <p class="compact-copy">依設定週期掃描；發現新品後自動加速追蹤。</p>
      <details class="advanced-box"><summary>已建立基線的商品</summary><p class="muted">用來辨識下一次出現的新品，不會重複通知舊商品。</p><div id="funbox-products" class="product-list"></div></details>
      <details class="advanced-box"><summary>已掃描但排除的 APP 兌換商品</summary><p class="muted">只供稽核，證明監控有讀到；不會推播，也不會交給自動下單。</p><div id="funbox-excluded-products" class="product-list"></div></details>
    </section>

    <div class="section-kicker">安全測試</div>
    <details class="card fold test-flow">
      <summary>模擬商品上架與推播 <span class="pill" style="color:#ffd166">測試專區</span></summary>
      <div class="compact-copy">不會在真實官網下單；用來驗證「上架 → 掃描 → 通知 → 測試結帳」完整流程。</div>
      <div class="row" id="funbox-sandbox-summary"></div>
      <p id="funbox-sandbox-last" class="muted"></p>
      <div class="row">
        <button id="funbox-sandbox-monitor-button" onclick="toggleFunboxSandboxMonitoring()">讀取中</button>
        <a class="button-link gold" href="/funbox-sandbox/control" target="_blank" rel="noopener noreferrer">開啟測試上架頁面</a>
        <button class="secondary" onclick="action('/scan-funbox-sandbox')">立即掃描測試頁</button>
        <button class="secondary" onclick="action('/test-funbox-product-notification')">測試正式商品資料推播</button>
      </div>
      <p id="test-flow-state" class="test-success">等待你啟動測試監控。</p>
      <div id="funbox-sandbox-products" class="product-list" style="margin-top:16px"></div>
      <details class="advanced-box"><summary>測試工具</summary><div class="row"><button class="secondary" onclick="resetFunboxSandboxMonitor()">重設測試基線</button><a class="page-url" href="/funbox-sandbox/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA" target="_blank" rel="noopener noreferrer">查看測試商店</a></div></details>
    </details>

    <details class="card fold notification-demo-card">
      <summary>通知示範 <span class="demo-badge">唯讀預覽，不會真的推播</span></summary>
      <div class="notification-demo"><div class="notification-demo-head">陀螺通知監控儀表・Funbox 官網</div><div class="notification-demo-body"><strong>🚨 Funbox 戰鬥陀螺上新！</strong><br>品名：BEYBLADE X UX-15 起始組<br>價格：NT$699<br>目前庫存：100 組<br>狀態：新品上架<br>購買：<span class="notification-demo-link">立即前往商品頁</span><br>--------------------------------------------------</div></div>
      <p class="notification-demo-note">庫存下降時會改成庫存提醒，並顯示目前可售數量與即將售罄提示。</p>
    </details>

    <details class="card fold">
      <summary>Funbox 官網執行紀錄</summary><p id="funbox-log-status" role="status">讀取掃描狀態…</p><p class="muted">每輪開始與完成都顯示；沒有新品或庫存變化也保留。帳號登入錯誤不代表商品掃描停止。</p><pre id="funbox-logs">讀取中…</pre>
    </details>
  </main>

  <main id="tab-shopping" class="tab-panel" role="tabpanel" aria-labelledby="tab-button-shopping" hidden>
    <div class="page-title"><div class="page-icon" aria-hidden="true">🏬</div><div><h2>購物網站監控</h2><p>監看 momo、誠品等指定專區；同時辨識新商品與既有商品內的款式補貨。</p></div></div>

    <section class="card compact-status-card">
      <div class="card-heading"><h2>購物專區監控</h2><span id="shopping-state" class="pill">讀取中…</span></div>
      <div class="row" id="shopping-summary"></div>
      <p id="shopping-last" class="muted">尚未完成掃描。</p>
      <p id="shopping-error" class="bad"></p>
      <div class="primary-actions"><div class="row">
        <button id="shopping-monitor-button" onclick="toggleShoppingMonitoring()">讀取中</button>
        <button class="secondary" onclick="action('/scan-shopping')">立即掃描全部專區</button>
      </div></div>
      <p id="shopping-result" class="notice muted"></p>
    </section>

    <details class="card fold" open>
      <summary><span>監控名單（<span id="shopping-active-count">0</span> 個運作中｜<span id="shopping-paused-count">0</span> 個暫停）</span></summary>
      <p class="compact-copy">集中管理所有購物專區；個別專區可暫停、改名或設定自己的監控時間。</p>
      <div id="shopping-target-list"></div>
      <details class="inline-create"><summary>＋ 新增監控專區</summary><form onsubmit="addShoppingTarget(event)"><div class="field"><input id="shopping-target-name" placeholder="專區名稱，例如：墊腳石戰鬥陀螺" maxlength="80" required><input id="shopping-target-url" type="url" placeholder="貼上分類頁、活動頁或商品頁網址" required><button type="submit">加入監控</button></div></form><p class="compact-copy">平台會自動辨識；新增後預設沿用共用時段，也可在名單中個別調整。</p></details>
    </details>

    <details class="card fold">
      <summary>誠品關鍵字監控</summary>
      <p class="compact-copy">策展頁與搜尋頁並行；任一來源先發現商品，就立即呼叫該商品的 purchase_status API 分辨新品／補貨。同一商品只驗證、推播一次，歷史基線不會逐筆輪詢。</p>
      <form onsubmit="saveEsliteKeywords(event)">
        <div class="field">
          <input id="eslite-shopping-keywords" placeholder="例如：BEYBLADE X、戰鬥陀螺" maxlength="180" oninput="esliteKeywordsDirty=true" required>
          <button type="submit">儲存搜尋範圍</button>
        </div>
      </form>
      <div class="data-checks"><span class="data-check">① 策展預警</span><span class="data-check">② 搜尋並行</span><span class="data-check">③ 命中才查單品 API</span><span class="data-check">持久基線去重</span></div>
      <div class="eslite-monitor-status">
        <div class="eslite-exhibition-head">
          <div class="eslite-exhibition-title"><strong>202608 策展頁</strong><a id="eslite-exhibition-link" href="https://www.eslite.com/exhibitions/CU202608-00061" target="_blank" rel="noopener noreferrer">開啟策展頁</a></div>
          <span id="eslite-exhibition-state" class="pill">讀取中…</span>
        </div>
        <p id="eslite-exhibition-meta" class="eslite-exhibition-meta">正在讀取策展頁狀態。</p>
        <details class="eslite-baseline-details">
          <summary><span>已記錄商品（<span id="eslite-baseline-count">0</span> 件）</span></summary>
          <div id="eslite-baseline-list" class="eslite-baseline-list"><p class="muted" style="padding:10px 12px">讀取中…</p></div>
        </details>
      </div>
      <p id="eslite-keyword-state" class="notice muted" style="white-space:pre-line">讀取中…</p>
      <details class="advanced-box">
        <summary>手動補登漏網商品</summary>
        <p class="compact-copy">只有策展頁與搜尋頁都沒有收進來的商品才需要手動補登。補登只會加入上方基線，不代表持續逐筆刷新或目前可購。</p>
        <form class="field" onsubmit="addEsliteProduct(event)">
          <input id="eslite-product-url" type="url" placeholder="貼上 https://www.eslite.com/product/..." required>
          <button id="eslite-product-add" type="submit">補登商品</button>
        </form>
        <p id="eslite-product-state" class="notice muted"></p>
        <div id="eslite-product-list" class="product-list"></div>
      </details>
    </details>

    ${shopeeHtml}

    <details class="card fold">
      <summary><span>開賣倒數提醒（<span id="sale-reminder-count">0</span> 個等待中）</span></summary>
      <p class="compact-copy">加入後會立即送出一次 Discord 商品通知，再於開賣前 60、30、10 分鐘提醒；開賣後自動移除。</p>
      <div class="sale-reminder-toolbar">
        <p class="compact-copy">提醒依開賣時間排列，只讀取一次商品名稱、圖片與時間，不會持續掃描商品或庫存。</p>
        <div class="sale-reminder-tools">
          <div class="sale-reminder-view-switch" role="group" aria-label="提醒顯示方式">
            <button id="sale-reminder-view-cards" type="button" onclick="setSaleReminderView('cards')">卡片</button>
            <button id="sale-reminder-view-list" type="button" onclick="setSaleReminderView('list')">條列</button>
          </div>
        </div>
      </div>
      <form onsubmit="addSaleReminder(event)">
        <div class="reminder-url-row">
          <input id="sale-reminder-url" type="url" placeholder="貼上 momo 商品網址，會自動抓取名稱、圖片與開賣時間" onpaste="setTimeout(inspectSaleReminderUrl,0)" onchange="inspectSaleReminderUrl()" required>
          <button id="sale-reminder-inspect-button" class="secondary" type="button" onclick="inspectSaleReminderUrl()">自動辨識商品</button>
        </div>
        <div id="sale-reminder-inspect-state" class="reminder-inspect-state"><span class="reminder-inspect-dot"></span><span>貼上網址後會自動辨識；仍可手動修改結果。</span></div>
        <div class="reminder-details-row">
          <input id="sale-reminder-name" placeholder="商品名稱會自動帶入" maxlength="80" required>
          <input id="sale-reminder-time" type="datetime-local" aria-label="開賣日期與時間" required>
          <button type="submit">新增提醒</button>
        </div>
      </form>
      <div id="sale-reminder-list" class="sale-reminder-list"></div>
    </details>

    <details class="card fold">
      <summary>共用掃描時間、速度與庫存提醒</summary>
      <form onsubmit="saveShoppingSettings(event)">
        <p class="compact-copy">未另外設定的購物專區，都會沿用這組共用時段。</p>
        <div class="field"><span>共用時段</span><input id="shopping-active-start" type="time" oninput="shoppingDirty=true" required><span>到</span><input id="shopping-active-end" type="time" oninput="shoppingDirty=true" required></div>
        <div class="field" style="margin-top:12px"><label>平時每 <input id="shopping-interval" type="number" min="10" max="3600" step="1" oninput="shoppingDirty=true" required> 秒檢查一次</label><button type="submit">儲存設定</button></div>
        <label class="setting-toggle"><input id="shopping-stock-change-notifications" type="checkbox" onchange="shoppingDirty=true"><span><strong>既有商品補貨與庫存提醒</strong><small>可讀到數量時，會在跨過 100、50、20、10、售罄或補貨時通知；只讀到有貨／缺貨時，則通知補貨與售罄。</small></span></label>
        <label class="funbox-rule-box black" style="margin-top:14px"><strong>⛔ 黑名單關鍵字</strong><small>商品名稱或規格名稱命中任一行時，仍記錄為已掃描，但不推播、不交給自動下單。每行一個關鍵字。</small><textarea id="shopping-exclude-keywords" oninput="shoppingDirty=true" placeholder="例如：&#10;戰鬥盒&#10;收納包"></textarea></label>
      </form>
      <p class="compact-copy">平時依上方秒數完整檢查所有專區；一旦抓到補貨，會自動改為每 3 秒直讀已知 momo 款式 5 分鐘，期間仍會定時執行完整專區掃描。</p>
      <p class="compact-copy">momo 的複數款式商品會逐一讀取款式名稱與前台可售數量；同一商品頁內只有其中一款補貨，也能獨立辨識。</p>
    </details>

    <details class="card fold purchase-hub">
<summary><span>誠品自動下單</span><span id="auto-purchase-header-summary" class="pill">讀取中…</span></summary>
      <div class="purchase-stack">
      <section class="card">
        <div class="card-heading"><div><h2>誠品帳號｜單品／合單</h2></div><span id="auto-purchase-eslite-summary" class="pill">已關閉</span></div>
        <div class="eslite-account-toolbar"><div class="eslite-account-toolbar-copy"><strong id="eslite-account-count">帳號管理</strong><small>可持續新增；下單最多三路並行，其餘排隊。未設定帳號不啟動瀏覽器。</small></div><div class="eslite-toolbar-actions"><button id="eslite-clear-all-carts" type="button" class="secondary small" title="清空誠品所有已設定帳號；忙碌、瀏覽器使用中與訂單待核對的帳號會跳過" onclick="purchaseAccountAction(this,'eslite',null,'clear-all-carts')">一鍵全清</button><button id="eslite-purchase-readiness-button" type="button" class="secondary small" onclick="checkPurchaseReadiness('eslite')">補貨前檢查</button><button id="eslite-add-account" type="button" class="secondary" onclick="addEsliteAccountCard()">＋ 新增帳號</button></div></div>
        <div id="eslite-purchase-readiness" aria-live="polite"></div>
        ${esliteAccountTableHtml}
        <details class="eslite-system-details"><summary>普通 Chrome 登入自動同步</summary><p>連接器：extensions/eslite-session-sync；只同步選定帳號，不自動解驗證。</p><button type="button" onclick="pairEsliteBrowser()">取得同步配對碼</button> <input id="eslite-sync-pair-code" type="password" readonly autocomplete="off" aria-label="誠品同步配對碼"><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('eslite-sync-pair-code').value)">複製配對碼</button></details>
        <div class="funbox-account-grid" id="eslite-account-list">
          <form id="eslite-account-A-card" class="funbox-account eslite-account-card" data-slot="A" onsubmit="saveEsliteAccount(event,'A')"><div class="funbox-account-head"><span id="eslite-account-A-title" class="funbox-account-title">帳號 A｜尚未設定</span><div class="eslite-account-head-actions"><span id="eslite-account-A-status" class="pill">未設定</span><button type="button" class="secondary small eslite-login-action" onclick="testAutoPurchaseLogin('eslite','A')">開啟登入</button><button type="button" class="secondary small eslite-check-action" onclick="completeAutoPurchaseLogin('eslite','A')">檢查登入</button><button type="button" class="secondary small" onclick="toggleEsliteAccountCard('A')">設定</button></div></div><div class="eslite-account-body"><div class="field"><label><input id="eslite-account-A-enabled" type="checkbox" checked> 使用</label><input id="eslite-account-A-account" autocomplete="username" placeholder="誠品帳號（不更改可留空）"><input id="eslite-account-A-password" type="password" autocomplete="current-password" placeholder="密碼（不更改可留空）"><button type="submit">儲存</button><button type="button" class="danger" onclick="clearEsliteAccount('A')">清除</button></div><div class="funbox-payment-options"><label class="funbox-payment-choice"><input type="radio" name="eslite-account-A-payment" value="seven_cod" onchange="markAutoPurchaseDirty('eslite')"><span>7-11 貨到付款</span></label><label class="funbox-payment-choice"><input type="radio" name="eslite-account-A-payment" value="virtual_atm_home" onchange="markAutoPurchaseDirty('eslite')"><span>宅配轉帳／ATM</span></label></div></div><p id="eslite-account-A-meta" class="funbox-account-meta">登入狀態尚未驗證。</p></form>
          <form id="eslite-account-B-card" class="funbox-account eslite-account-card" data-slot="B" onsubmit="saveEsliteAccount(event,'B')" hidden><div class="funbox-account-head"><span id="eslite-account-B-title" class="funbox-account-title">帳號 B｜尚未設定</span><div class="eslite-account-head-actions"><span id="eslite-account-B-status" class="pill">未設定</span><button type="button" class="secondary small eslite-login-action" onclick="testAutoPurchaseLogin('eslite','B')">開啟登入</button><button type="button" class="secondary small eslite-check-action" onclick="completeAutoPurchaseLogin('eslite','B')">檢查登入</button><button type="button" class="secondary small" onclick="toggleEsliteAccountCard('B')">設定</button></div></div><div class="eslite-account-body"><div class="field"><label><input id="eslite-account-B-enabled" type="checkbox" checked> 使用</label><input id="eslite-account-B-account" autocomplete="username" placeholder="誠品帳號（可留空）"><input id="eslite-account-B-password" type="password" autocomplete="current-password" placeholder="密碼（可留空）"><button type="submit">儲存</button><button type="button" class="danger" onclick="clearEsliteAccount('B')">清除</button></div><div class="funbox-payment-options"><label class="funbox-payment-choice"><input type="radio" name="eslite-account-B-payment" value="seven_cod" onchange="markAutoPurchaseDirty('eslite')"><span>7-11 貨到付款</span></label><label class="funbox-payment-choice"><input type="radio" name="eslite-account-B-payment" value="virtual_atm_home" onchange="markAutoPurchaseDirty('eslite')"><span>宅配轉帳／ATM</span></label></div></div><p id="eslite-account-B-meta" class="funbox-account-meta">登入狀態尚未驗證。</p></form>
          <form id="eslite-account-C-card" class="funbox-account eslite-account-card" data-slot="C" onsubmit="saveEsliteAccount(event,'C')" hidden><div class="funbox-account-head"><span id="eslite-account-C-title" class="funbox-account-title">帳號 C｜尚未設定</span><div class="eslite-account-head-actions"><span id="eslite-account-C-status" class="pill">未設定</span><button type="button" class="secondary small eslite-login-action" onclick="testAutoPurchaseLogin('eslite','C')">開啟登入</button><button type="button" class="secondary small eslite-check-action" onclick="completeAutoPurchaseLogin('eslite','C')">檢查登入</button><button type="button" class="secondary small" onclick="toggleEsliteAccountCard('C')">設定</button></div></div><div class="eslite-account-body"><div class="field"><label><input id="eslite-account-C-enabled" type="checkbox" checked> 使用</label><input id="eslite-account-C-account" autocomplete="username" placeholder="誠品帳號（可留空）"><input id="eslite-account-C-password" type="password" autocomplete="current-password" placeholder="密碼（可留空）"><button type="submit">儲存</button><button type="button" class="danger" onclick="clearEsliteAccount('C')">清除</button></div><div class="funbox-payment-options"><label class="funbox-payment-choice"><input type="radio" name="eslite-account-C-payment" value="seven_cod" onchange="markAutoPurchaseDirty('eslite')"><span>7-11 貨到付款</span></label><label class="funbox-payment-choice"><input type="radio" name="eslite-account-C-payment" value="virtual_atm_home" onchange="markAutoPurchaseDirty('eslite')"><span>宅配轉帳／ATM</span></label></div></div><p id="eslite-account-C-meta" class="funbox-account-meta">登入狀態尚未驗證。</p></form>
        </div>
        <form onsubmit="saveAutoPurchasePlatform(event,'eslite')" style="margin-top:12px">
          <div class="field eslite-purchase-controls"><label><input id="auto-purchase-eslite-enabled" type="checkbox" onchange="markAutoPurchaseDirty('eslite')"> 啟用自動下單</label><label>每款 <input id="auto-purchase-eslite-quantity" type="number" min="1" max="3" value="1" oninput="markAutoPurchaseDirty('eslite')"> 件</label><button type="submit">儲存設定</button></div>
          <div class="field eslite-priority-controls"><label for="eslite-priority-keywords">任務優先關鍵字（逗號分隔）</label><input id="eslite-priority-keywords" type="text" oninput="markAutoPurchaseDirty('eslite')" placeholder="例：BX-09,強化組" aria-describedby="eslite-priority-help"></div>
          <p id="eslite-priority-help" class="compact-copy">左側優先；同組依偵測順序，其餘各帳號隨機。仍先排除黑名單與已購品。</p>
          <details class="purchase-rules-fold"><summary>購物網站黑白名單 <span id="eslite-purchase-rule-summary" class="muted">讀取中…</span></summary>
            <div class="purchase-rules-toolbar"><label>購買範圍 <select id="eslite-buy-mode" onchange="markAutoPurchaseDirty('eslite');updateEsliteRuleMode()"><option value="all">黑名單以外皆可購買</option><option value="whitelist">只購買白名單</option></select></label><button type="button" class="secondary small" onclick="syncAutoPurchaseLists('funbox','eslite')">從 FUNBOX 合併黑白名單</button></div>
            <p id="eslite-rule-mode-help" class="compact-copy"></p>
            <div class="funbox-rule-grid purchase-rule-editors">
              <div class="funbox-rule-box black"><label for="eslite-skip-buy-keywords"><strong>不購買（黑名單）</strong></label><small>優先排除。仍可監控推播，不占下單線。</small><textarea id="eslite-skip-buy-keywords" oninput="markAutoPurchaseDirty('eslite')" placeholder="每行一個名稱或型號"></textarea><div class="purchase-list-sort-actions"><button type="button" class="secondary small" aria-label="購物網站黑名單排序" onclick="sortAutoPurchaseList('eslite','black')">排序</button></div></div>
              <div class="funbox-rule-box white"><label for="eslite-buy-keywords"><strong>允許購買（白名單）</strong></label><small>僅在白名單模式生效；派單順序另依優先關鍵字。</small><textarea id="eslite-buy-keywords" oninput="markAutoPurchaseDirty('eslite')" placeholder="每行一個名稱或型號；白名單模式且空白時全部不買"></textarea><div class="purchase-list-sort-actions"><button type="button" class="secondary small" aria-label="購物網站白名單排序" onclick="sortAutoPurchaseList('eslite','white')">排序</button></div></div>
            </div>
          </details>
        </form>
        <p id="auto-purchase-eslite-state" class="notice muted"></p>
        ${esliteOrderTablesHtml}
        <details class="eslite-system-details"><summary>登入與系統維護</summary><p class="compact-copy">憑證到期自動按官方登入；忙碌就關閉本次視窗，60／120／240 秒逐步等待後再試，最長 15 分鐘。人工驗證保留視窗；各帳號獨立，結果不明先查單。</p><p id="auto-purchase-eslite-credentials" class="muted">帳密狀態讀取中…</p><div id="eslite-heartbeat-summary" class="eslite-heartbeat-summary">登入心跳狀態讀取中…</div><div class="field"><p id="auto-purchase-maintenance" class="compact-copy">每日購物車保養狀態讀取中…</p><button type="button" class="secondary" onclick="runCartMaintenance()">檢查登入並清空舊購物車</button></div></details>
      </section>
      </div>
    </details>
    <details class="card fold"><summary><span>私人下單紀錄</span><span id="auto-purchase-summary" class="pill">已關閉</span></summary><p class="compact-copy">購物失敗只會記錄在這裡與私人 Discord；不會中斷監控，也不會出現在公開頻道。</p><div id="auto-purchase-recent" class="muted purchase-console purchase-log-list">尚無紀錄。</div></details>

    <details class="card fold notification-demo-card">
      <summary>通知示範 <span class="demo-badge">唯讀預覽，不會真的推播</span></summary>
      <div class="notification-demo"><div class="notification-demo-head">陀螺通知監控儀表・購物網站</div><div class="notification-demo-body"><strong>🔔 規格補貨｜UX-14 天蠍長矛</strong><br>購物網站：momo購物網<br>監控專區：墊腳石 TAKARA TOMY 專區<br>商品：BEYBLADE X 戰鬥陀螺 CX／BX／UX 系列<br>補貨款式：UX-14 天蠍長矛<br>前台可售：18 組<br>購買：<span class="notification-demo-link">立即前往商品頁</span><br>--------------------------------------------------</div></div>
      <div class="notification-demo" style="margin-top:14px"><div class="notification-demo-head">陀螺通知監控儀表・開賣倒數</div><div class="notification-demo-body"><strong>⏰ 距離開賣 60 分鐘｜momo Funbox BX-35</strong><br>購物網站：momo購物網<br>商品：momo Funbox BX-35<br>開賣時間：7/25 11:00<br>現在時間：10:00<br>剩餘時間：60 分鐘<br>商品頁：<span class="notification-demo-link">立即前往</span><br>--------------------------------------------------</div></div>
      <p class="notification-demo-note">自訂暱稱會顯示在「監控專區」；購物網站名稱仍會另外保留，方便判斷來源。</p>
    </details>

    <details class="card fold">
      <summary>購物網站執行紀錄（依網站分類）</summary><pre id="shopping-logs">讀取中…</pre>
    </details>
  </main>

  <main id="tab-japan" class="tab-panel" role="tabpanel" aria-labelledby="tab-button-japan" hidden>
    <div class="page-title"><div class="page-icon" aria-hidden="true">🇯🇵</div><div><h2>日本拍賣</h2><p>每個日本網站各自獨立掃描；其中一站變慢，不會卡住其他日本或台灣購物網站。</p></div></div>

    <section class="card compact-status-card">
      <div class="card-heading"><h2>日本網站監控</h2><span id="japan-state" class="pill">讀取中…</span></div>
      <div id="japan-summary" class="row"></div>
      <p id="japan-last" class="muted">尚未完成掃描。</p><p id="japan-error" class="bad"></p>
      <div class="primary-actions"><div class="row"><button id="japan-monitor-button" onclick="toggleJapanMonitoring()">讀取中</button><button class="secondary" onclick="action('/scan-japan')">立即掃描全部</button></div></div>
      <p id="japan-result" class="notice muted"></p>
    </section>

    <details class="card fold" open><summary>一般日本網站監控名單</summary><p class="compact-copy">1999、樂天、EDION 等網站集中在此管理；第一次成功掃描只建立安全基線，後續新品或恢復販售才通知。</p><div id="japan-target-list" class="japan-target-grid"></div></details>

    <section class="card">
      <div class="card-heading"><h2>Amazon.co.jp 自營 AOD 監控</h2><span id="amazon-jp-state" class="pill">讀取中…</span></div>
      <p class="compact-copy">搜尋持續擴充商品庫，已知商品獨立輪查全新自營 AOD。</p>
      <form onsubmit="saveAmazonJpSettings(event)">
        <div class="field">
          <label><input id="amazon-jp-enabled" type="checkbox" onchange="amazonJpDirty=true"> 啟用獨立日亞監控</label>
          <span class="pill">新品搜尋 15～20 秒｜全庫連續輪查｜限流依 Retry-After 降速</span>
          <label>日本郵遞區號 <input id="amazon-jp-postal-code" inputmode="numeric" pattern="[0-9]{3}-?[0-9]{4}" value="100-0001" oninput="amazonJpDirty=true"></label>
          <button type="submit">儲存</button>
          <button type="button" class="secondary" onclick="scanAmazonJp()">立即檢查</button>
        </div>
      </form>
      <p id="amazon-jp-summary" class="muted">讀取中…</p>
      <p id="amazon-jp-error" class="bad"></p>
      <details class="advanced-box"><summary>自動商品庫 · 全庫輪查</summary>
        <p class="compact-copy">自動收錄搜尋與既有商品；搜尋價不代表自營可購。每筆顯示最近 AOD 驗證時間，失敗時保留上次結果。</p>
        <div id="amazon-jp-inventory-products" class="product-list"></div>
      </details>
      <details class="advanced-box"><summary>突襲練習 · 日亞測試推播</summary>
      <form class="amazon-jp-test-panel" onsubmit="testAmazonJpNotification(event)">
        <strong>測試自營報價通知</strong>
        <span class="muted">選擇品項後推送到日本拍賣 Discord，點通知會開啟真實 Amazon.co.jp 商品頁；這只是通知格式測試，不會查價或下單。</span>
        <div class="amazon-jp-test-options" role="radiogroup" aria-label="測試品項">
          <label class="amazon-jp-test-choice"><input type="radio" name="amazon-jp-test-choice" value="B0HJ783F18" checked onchange="toggleAmazonJpTestFields()"><span>BX-52<small>ラスタードラグーン6-60LC｜¥2,300</small></span></label>
          <label class="amazon-jp-test-choice"><input type="radio" name="amazon-jp-test-choice" value="B0HJ75X3PN" onchange="toggleAmazonJpTestFields()"><span>BX-53<small>オールインワンセット｜¥7,480</small></span></label>
          <label class="amazon-jp-test-choice"><input type="radio" name="amazon-jp-test-choice" value="custom" onchange="toggleAmazonJpTestFields()"><span>自訂日亞網址<small>填入你想測試的商品</small></span></label>
        </div>
        <div id="amazon-jp-test-custom" class="amazon-jp-test-custom" hidden>
          <label class="wide">Amazon.co.jp 商品網址<input id="amazon-jp-test-url" type="url" placeholder="https://www.amazon.co.jp/dp/ASIN" autocomplete="off"></label>
          <label class="wide">商品名稱<input id="amazon-jp-test-title" type="text" maxlength="180" placeholder="填入測試通知要顯示的名稱"></label>
          <label>型號<input id="amazon-jp-test-code" type="text" maxlength="12" placeholder="例如 BX-52"></label>
          <label>測試參考報價（JPY）<input id="amazon-jp-test-msrp" type="number" min="1" max="1000000" step="1" placeholder="例如 2300"></label>
          <label>模擬日亞價格（JPY，可留空）<input id="amazon-jp-test-price" type="number" min="1" max="1000000" step="1" placeholder="留空＝測試使用定價"></label>
          <p class="muted wide" style="margin:0">自訂商品若已在日亞資料庫，名稱、型號與定價可留空；未收錄者請自行填入。</p>
        </div>
        <button type="submit" class="secondary">推送所選測試通知</button>
        <p id="amazon-jp-test-result" class="notice muted" role="status" aria-live="polite"></p>
      </form>
      </details>
      <details class="advanced-box"><summary>單品資料庫 · 新增與刪除</summary>
      <p class="compact-copy">貼入日亞商品網址，加入資料庫與直接追蹤。</p>
      <form class="field" onsubmit="addAmazonJpProduct(event)">
        <input id="amazon-jp-product-url" type="url" placeholder="貼上 amazon.co.jp／amzn.to／amzn.asia 商品連結" required>
        <button id="amazon-jp-product-add" type="submit">加入資料庫</button>
      </form>
      <div id="amazon-jp-signals" class="product-list"></div>
      </details>
    </section>

    <section class="card">
      <div class="card-heading"><div><h2>日亞自動下單</h2><p class="compact-copy">A／B／C 各自追蹤一個商品，獨立啟動與檢查，不互相等待。</p></div><span class="pill">3 組任務</span></div>
      <p class="compact-copy">ABC 即時 LOG 顯示於上方；點品名可編輯網址。</p>
      <div id="amazon-product-order-live-logs" class="amazon-live-logs"><div class="amazon-live-log-toolbar"><strong>即時 LOG</strong><span>僅本次執行保留 · 最新在上</span><button id="amazon-product-order-clear-log" type="button" class="secondary" title="清空 ABC LOG 與刷新次數，不清下單紀錄" onclick="clearAmazonProductOrderLogs()">清空</button></div><div id="amazon-live-log-content" class="amazon-live-log-grid"></div></div>
      <div id="amazon-product-order-slots" class="amazon-order-console"></div>
      <details class="fold"><summary>API＋插件雙路競速</summary>
        <p class="compact-copy">兩路獨立刷新、各最多送一張；先成功會停止尚未送單的一路，已送出的重複單請自行取消。插件未連線時只有 API 執行。</p>
        <div id="amazon-race-status" class="compact-copy"></div>
        <p class="compact-copy">首次安裝：Chrome 擴充功能 → 開發人員模式 → 載入未封裝項目，選擇專案內 <code>extensions/amazon-race</code>。每個 Chrome 個人資料只連接一組任務，須確認是正確 Amazon 帳號。</p>
        <label>配對任務 <select id="amazon-race-pair-slot"><option>A</option><option>B</option><option>C</option></select></label>
        <button type="button" class="secondary" onclick="pairAmazonRace()">產生插件配對碼</button>
        <input id="amazon-race-token" aria-label="插件配對碼" readonly hidden style="width:100%;margin-top:8px" onclick="this.select()">
        <p id="amazon-race-feedback" class="compact-copy" role="status"></p>
      </details>
      <details class="fold"><summary>永久訂單時間紀錄（重設不刪除）</summary>
        <p class="compact-copy">每次符合條件並進入購買流程就保存一筆，包含失敗與结果待確認。最新在上，顯示最近 20 筆；完整 JSON 保留在下方資料夾。一般缺貨輪詢不建檔。送出時間是請求／動作開始，並非網站收單時間。</p>
        <p id="amazon-product-history-path" class="muted"></p><p id="amazon-product-history-error" class="bad"></p>
        <div id="amazon-product-order-evidence-links" class="amazon-evidence-links"></div>
        <pre id="amazon-product-order-history">尚無永久紀錄（啟用本功能前的耗時無法回補）</pre>
      </details>
    </section>

    <details class="card fold"><summary>掃描時間、速度與黑名單</summary><form onsubmit="saveJapanSettings(event)"><div class="field"><span>監控時段</span><input id="japan-active-start" type="time" required><span>到</span><input id="japan-active-end" type="time" required></div><div class="field" style="margin-top:12px"><label>平時每 <input id="japan-interval" type="number" min="20" max="3600" step="1" required> 秒檢查一次</label><button type="submit">儲存設定</button></div><label class="funbox-rule-box black" style="margin-top:14px"><strong>⛔ 日本購物共用黑名單</strong><small>適用於 1999、日本樂天市場／Books、EDION 與 Amazon.co.jp。商品名稱命中任一行時仍保留掃描紀錄，但不推播。每行一個關鍵字。</small><textarea id="japan-exclude-keywords" oninput="japanDirty=true" placeholder="例如：&#10;ギアケース&#10;Gear Case&#10;デッキケース"></textarea></label></form><p class="compact-copy">開始與結束相同代表 24 小時。一般日本網站維持固定週期，不會因單次變化連續追索；同型號 24 小時內跨網站只推播一次。Amazon.co.jp 使用獨立排程，不受此規則影響。所有一般日本網站另有 BEYBLADE X 世代硬性篩選，舊世代不會進入通知基線。</p></details>

    <details class="card fold notification-demo-card"><summary>通知測試與示範 <span class="demo-badge">測試工具</span></summary><div class="section-tools"><p class="compact-copy">需要時才使用，不影響正式掃描。</p><button class="secondary small" onclick="testJapanNotification()">測試 1999 UX-15 通知</button></div><div class="notification-demo"><div class="notification-demo-head">日拍追蹤</div><div class="notification-demo-body"><strong>🇯🇵 1999.co.jp｜新商品可購買</strong><br>商品：BEYBLADE X UX-15<br>價格：¥4,200（約 NT$920）<br>狀態：新商品可購買<br>購買：<span class="notification-demo-link">立即前往商品頁</span><br>--------------------------------------------------</div></div><p class="notification-demo-note">台幣採固定估算 ¥1 ≈ NT$0.22，四捨五入至十元；僅供快速判讀，不影響價格與庫存判斷。</p></details>
    <details class="card fold"><summary>日本拍賣執行紀錄</summary><pre id="japan-logs">讀取中…</pre></details>
  </main>

  <main id="tab-shared" class="tab-panel" role="tabpanel" aria-labelledby="tab-button-shared" hidden>
    <div class="page-title"><div class="page-icon" aria-hidden="true">⚙️</div><div><h2>系統設定</h2><p>統一管理通知、系統健康狀態與玩家備忘錄。</p></div></div>

    <section class="card">
      <h2>當前運作</h2>
      <div class="status-grid">
        <div class="status-tile"><strong>🛒 Funbox 官網</strong><div id="shared-funbox-status" class="muted">讀取中…</div></div>
        <div class="status-tile shopping-tile"><strong>🏬 購物網站</strong><div id="shared-shopping-status" class="muted system-primary">讀取中…</div><div class="system-detail"><span id="shared-shopping-schedule-status">排程讀取中…</span><span id="shared-shopping-speed-status">速度讀取中…</span><span id="shared-shopping-reminder-status">提醒讀取中…</span></div></div>
        <div class="status-tile shopping-tile"><strong>🇯🇵 日本拍賣</strong><div id="shared-japan-status" class="muted system-primary">讀取中…</div></div>
        <div class="status-tile"><strong>🔔 通知服務</strong><div id="shared-notification-status" class="muted">讀取中…</div></div>
        <div class="status-tile purchase-tile"><strong>🔐 私人自動購買</strong><div id="shared-auto-purchase-status" class="muted system-primary">讀取中…</div><div class="system-detail"><span id="shared-auto-purchase-platforms">平台讀取中…</span><span id="shared-auto-purchase-queue">工作器讀取中…</span></div></div>
      </div>
    </section>

    <section class="card">
      <div class="card-heading"><h2>Discord 通知分流</h2><span id="notification-availability" class="muted">讀取中…</span></div>
      <p class="compact-copy">公開頻道收補貨情報；私人頻道收訂單與付款資訊。日拍使用獨立頻道。</p>
      <div class="discord-route-grid">
        <section class="discord-route public">
          <div class="route-heading"><div><h3>📢 公開情報頻道</h3><p>玩家只讀，不能發言</p></div><span id="discord-public-status" class="pill">讀取中…</span></div>
          <div class="route-items">
            <div class="route-item">Funbox 官網新品與庫存變化</div>
            <div class="route-item">購物網站新品與既有款式補貨</div>
            <div class="route-item">可直接點擊的原文與商品網址</div>
          </div>
          <div class="route-note"><strong>不會出現：</strong>訂單資料、送出結果、失敗原因或個人資料。</div>
        </section>
        <section class="discord-route private">
          <div class="route-heading"><div><h3>🔒 私人管理頻道</h3><p>只有你能查看</p></div><span id="discord-private-status" class="pill">讀取中…</span></div>
          <div class="route-items">
            <div class="route-item">各帳號訂單成立與下單結果</div>
            <div class="route-item">訂單失敗原因與人工確認提醒</div>
            <div class="route-item">ATM 付款資訊與繳款期限</div>
          </div>
          <div class="route-note"><strong>隱私原則：</strong>私人操作通知絕不退回公開頻道。</div>
        </section>
        <section class="discord-route mmtoy">
          <div class="route-heading"><div><h3>🐶 M.M小舖獨立通知</h3><p>公開頻道，只收 M.M 補貨情報</p></div><span id="discord-mmtoy-status" class="pill">讀取中…</span></div>
          <div class="route-items">
            <div class="route-item">新品、補貨與恢復可購</div>
            <div class="route-item">可售庫存與恢復販售變化</div>
            <div class="route-item">不含自動下單與測試紀錄</div>
          </div>
          <div class="route-note"><strong>玩家可自行選擇：</strong>只開啟一般販售情報、只開啟 M.M 小舖，或兩者都開啟。</div>
          <div class="route-note"><strong>完全分流：</strong>不再混入一般購物情報或私人管理頻道。</div>
        </section>
      </div>
      <form onsubmit="saveNotificationSettings(event)">
        <div class="channel-grid">
          <label class="channel-choice"><strong>🛒 公開｜Funbox 官網</strong>
            <select id="funbox-notification-mode" onchange="notificationDirty=true">
              <option value="discord">只傳 Discord</option><option value="line">只傳 LINE</option><option value="both">Discord + LINE 都傳</option><option value="auto">自動選擇可用平台</option>
            </select>
            <small>新品、庫存變化與沙盒測試送到公開情報頻道。</small>
          </label>
          <label class="channel-choice"><strong>🏬 公開｜購物網站</strong>
            <select id="shopping-notification-mode" onchange="notificationDirty=true">
              <option value="discord">只傳 Discord</option><option value="line">只傳 LINE</option><option value="both">Discord + LINE 都傳</option><option value="auto">自動選擇可用平台</option>
            </select>
            <small>通知會同時標示購物網站名稱、監控專區、商品與補貨款式。</small>
          </label>
        </div>
        <div class="row" style="margin-top:14px"><button type="submit">儲存通知設定</button></div>
        <div class="notification-test">
          <div class="notification-test-actions">
            <button id="test-discord-public-button" type="button" class="secondary" onclick="testNotification('discord-public')">測試公開 Discord</button>
            <button id="test-discord-private-button" type="button" class="secondary" onclick="testNotification('discord-private')">測試私人 Discord</button>
            <button id="test-line-button" type="button" class="secondary" onclick="testNotification('line')">測試 LINE</button>
            <div class="notification-progress" role="progressbar" aria-label="通知測試進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div id="notification-test-progress-bar" class="notification-progress-bar"></div>
            </div>
            <span id="notification-test-progress-text" class="muted">等待測試</span>
          </div>
          <div class="notification-test-status">
            <strong id="test-notification-state">尚未傳送測試通知。</strong>
            <div id="test-notification-detail" class="notification-test-detail">完成後會顯示實際 Bot、頻道與平台回覆編號。</div>
            <a id="test-notification-link" class="notification-test-link" target="_blank" rel="noopener noreferrer" hidden>直接開啟 Discord 訊息 ↗</a>
          </div>
        </div>
      </form>
      <p id="notification-state" class="notice muted"></p>
      <p id="shared-result" class="notice muted"></p>
    </section>

    <section class="card">
      <div class="card-heading"><div><h2>系統健康檢查</h2><div class="muted">檢查控制服務、監控設定與通知連線。</div></div><button class="secondary" onclick="runSelfCheck()">立即檢查全部功能</button></div>
    </section>

    <section class="card" id="self-check-card" hidden>
      <div class="card-heading">
        <h2>功能自檢結果</h2>
        <button id="self-check-toggle" class="secondary collapse-button" type="button" onclick="toggleSelfCheck()" aria-expanded="false">展開</button>
      </div>
      <p id="self-check-summary"></p>
      <div id="self-check-body" hidden><div id="self-check-list"></div></div>
    </section>

    <details class="card fold notification-demo-card">
      <summary>通知示範 <span class="demo-badge">唯讀預覽，不會真的推播</span></summary>
      <div class="notification-demo"><div class="notification-demo-head">陀螺通知監控儀表・系統狀態</div><div class="notification-demo-body"><strong>🟢 今日監控開始</strong><br>Funbox 官網：09:00～19:00<br>購物網站：09:00～22:00<br>通知服務：Discord + LINE<br>--------------------------------------------------</div></div>
      <p class="notification-demo-note">此區只示範排版；不提供修改，真正設定仍由上方通知分流控制。</p>
    </details>

    <details class="card fold">
      <summary>玩家備忘錄 <span class="muted">只存在這台電腦</span></summary>
      <p class="compact-copy">記下開賣時間、店家或抽選結果，不會傳到 Discord 或 LINE。</p>
      <form onsubmit="saveMemo(event)">
        <textarea id="memo" maxlength="5000" placeholder="例如：A19 7/20 14:00 開放表單；Funbox 官網 18:00 開賣 UX-15" oninput="memoDirty=true;document.querySelector('#memo-state').textContent='尚未儲存'"></textarea>
        <div class="row" style="margin-top:10px"><button type="submit">儲存備忘錄</button><span id="memo-state" class="muted"></span></div>
      </form>
    </details>

    <section class="card simulation-lab">
      <div class="card-heading"><div><h2>🧪 真實樣式推播測試</h2><p class="compact-copy">模擬補貨訊息，確認手機摘要、商品名稱、排版與頻道分流。</p></div><span class="pill">訊息會標示為測試</span></div>
      <div class="simulation-controls">
        <label>模擬通知種類
          <select id="simulation-notification-type" onchange="toggleFunboxSimulationFields()">
            <option value="funbox">Funbox 官網上架</option>
            <option value="mmtoy">M.M小舖規格補貨</option>
            <option value="shopping">一般購物網站補貨</option>
            <option value="shopee">蝦皮 FUNBOX 旗艦館補貨（UX-21）</option>
          </select>
        </label>
        <label>推送位置
          <select id="simulation-notification-audience">
            <option value="private">私人管理頻道（建議先測）</option>
            <option value="public">公開頻道（M.M 會自動送到獨立頻道）</option>
          </select>
        </label>
        <button id="simulation-notification-button" type="button" onclick="testSimulatedNotification()">傳送模擬補貨</button>
      </div>
      <details id="simulation-funbox-custom" class="simulation-custom" open>
        <summary>Funbox 朋友互動內容</summary>
        <div class="simulation-custom-grid">
          <label class="wide">通知顯示品名
            <input id="simulation-funbox-title" maxlength="120" value="BEYBLADE X 戰鬥陀螺 UX-16 時鐘幻象">
          </label>
          <label>顯示價格
            <input id="simulation-funbox-price" maxlength="32" value="NT$350">
          </label>
          <label>顯示庫存
            <input id="simulation-funbox-stock" type="number" min="0" max="99999" value="50">
          </label>
          <label class="wide">點擊後前往網址
            <input id="simulation-funbox-target-url" type="url" value="https://www.youtube.com/watch?v=dMTy6C4UiQ4" placeholder="YouTube、圖片頁或其他 http/https 網址">
          </label>
          <label class="wide">通知圖片網址（選填）
            <input id="simulation-funbox-image-url" type="url" placeholder="https://...jpg、png、gif 或 Discord 圖片網址">
          </label>
        </div>
        <p class="simulation-custom-note">商品標題與「立即前往商品頁」都會開啟你填的網址；圖片只改通知縮圖。通知仍固定標示 🧪 測試，不會加入基線或啟動下單。</p>
      </details>
      <p class="simulation-warning">公開測試會真的出現在玩家可見頻道；M.M 小舖會送往「mm小舖獨立通知」，其他類型送往一般公開情報。</p>
      <div class="notification-test">
        <div class="notification-test-actions">
          <div id="simulation-notification-progress" class="notification-progress" role="progressbar" aria-label="模擬推播進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="simulation-notification-progress-bar" class="notification-progress-bar"></div></div>
          <span id="simulation-notification-progress-text" class="muted">等待測試</span>
        </div>
        <div class="notification-test-status">
          <strong id="simulation-notification-state">尚未傳送模擬通知。</strong>
          <div id="simulation-notification-detail" class="notification-test-detail">送出成功後會顯示 Discord 實際頻道與訊息編號。</div>
          <a id="simulation-notification-link" class="notification-test-link" target="_blank" rel="noopener noreferrer" hidden>直接開啟 Discord 訊息 ↗</a>
        </div>
      </div>
    </section>
  </main>

<script>
${funboxScanStatus.toString()}
${shopeeClient}
let currentStatus=null;
let memoDirty=false;
let settingsDirty=false;
let hotspotDirty=false;
let profileDirty=false;
let profileSlot=1;
let aiDirty=false;
let notificationDirty=false;
let funboxSettingsDirty=false;
let shoppingDirty=false;
let japanDirty=false;
let amazonJpDirty=false;
const amazonProductOrderDirty={A:false,B:false,C:false};
let esliteKeywordsDirty=false;
const autoPurchaseDirtyPlatforms=new Set();
function markAutoPurchaseDirty(platform){autoPurchaseDirtyPlatforms.add(platform);}
let selfCheckExpanded=false;
let profileLoaded=false;
let previewUrl='';
let previewExpanded=false;
const tabs=['overview','funbox','shopping','japan','shared'];
const savedTab=localStorage.getItem('beyblade-monitor-tab');
let activeTab=tabs.includes(savedTab)?savedTab:'overview';
const savedSaleReminderView=localStorage.getItem('beyblade-sale-reminder-view');
let saleReminderView=savedSaleReminderView==='list'?'list':'cards';
const openShoppingTargetManagers=new Set();
const esliteVisibleSlots=new Set(['A']);
${esliteSlotClient}
const esliteExpandedSlots=new Set();
let esliteDisplayIdentities = {}, esliteIdentitiesReadAt = 0;
async function refreshEsliteDisplayIdentities(){
  if(Date.now()-esliteIdentitiesReadAt<60000)return;
  esliteIdentitiesReadAt=Date.now();
  try{const response=await fetch('/auto-purchase/eslite/display-identities',{method:'POST',headers:{'Content-Type':'application/json','x-local-identity-view':'1'},body:'{}'});
    if(response.ok){const data=await response.json();esliteDisplayIdentities=Object.fromEntries(data.accounts.map(item=>[item.slot,item]));}
  }catch{esliteIdentitiesReadAt=0;}
}
async function pairEsliteBrowser(){
  const response=await fetch('/eslite-browser/pair',{method:'POST',headers:{'Content-Type':'application/json','x-local-session-import':'1'},body:'{}'});
  const result=await response.json();if(!response.ok){document.querySelector('#shopping-result').textContent=result.error;return;}
  document.getElementById('eslite-sync-pair-code').value=result.token;
  document.querySelector('#shopping-result').textContent='配對碼已產生；貼入誠品連接器並選擇目前前端帳號。重新配對會讓舊配對碼失效。';
}
const funboxExpandedSlots=new Set();
const funboxVisibleSlots=new Set(['A','B','C']);
function toggleFunboxAccountCard(slot,force){const card=document.querySelector('#funbox-account-'+slot+'-card');if(!card)return;const expand=force===undefined?card.classList.contains('compact'):Boolean(force);card.classList.toggle('compact',!expand);if(expand)funboxExpandedSlots.add(slot);else funboxExpandedSlots.delete(slot);document.querySelector('#funbox-sheet-settings-'+slot)?.setAttribute('aria-expanded',String(expand));}
function currentFunboxSlots(){return esliteAccountSlots([...(currentStatus?.autoPurchase?.credentials?.funbox?.accounts||[]).map(item=>item.slot),...funboxVisibleSlots]);}
function ensureFunboxAccountUi(slot){
  if(!isEsliteAccountSlot(slot))return;
  if(!document.querySelector('#funbox-sheet-account-'+slot))document.querySelector('.funbox-account-table tbody').insertAdjacentHTML('beforeend',funboxAccountRowHtml(slot));
  if(document.querySelector('#funbox-account-'+slot+'-card'))return;
  const card=document.querySelector('#funbox-account-A-card').cloneNode(true);
  for(const el of [card,...card.querySelectorAll('*')])for(const name of ['id','name','onsubmit','onclick']){const value=el.getAttribute(name);if(value)el.setAttribute(name,value.replaceAll('funbox-account-A','funbox-account-'+slot).replaceAll("'A'","'"+slot+"'"));}
  for(const input of card.querySelectorAll('input')){if(input.type==='password'||input.autocomplete==='username')input.value='';if(input.type==='radio')input.checked=input.value==='virtual_atm_home';if(input.type==='checkbox')input.checked=true;}
  for(const select of card.querySelectorAll('select[id$="-mode"]'))select.value='single';
  card.classList.add('compact');document.querySelector('#funbox-account-list').append(card);
}
function addFunboxAccountCard(){const used=new Set(currentFunboxSlots());let index=0;while(used.has(esliteSlotLabel(index)))index++;const slot=esliteSlotLabel(index);funboxVisibleSlots.add(slot);ensureFunboxAccountUi(slot);toggleFunboxAccountCard(slot,true);renderAutoPurchase(currentStatus||{});document.querySelector('#funbox-account-'+slot+'-card').scrollIntoView({behavior:'smooth',block:'center'});}
function toggleEsliteAccountCard(slot,force){const card=document.querySelector('#eslite-account-'+slot+'-card');if(!card)return;const expand=force===undefined?card.classList.contains('compact'):Boolean(force);card.classList.toggle('compact',!expand);if(expand)esliteExpandedSlots.add(slot);else esliteExpandedSlots.delete(slot);const button=document.querySelector('#eslite-sheet-settings-'+slot);if(button)button.setAttribute('aria-expanded',String(expand));}
let credentialViewTimer=null;
let credentialViewGeneration=0;
function hideEsliteCredentials(){credentialViewGeneration++;clearTimeout(credentialViewTimer);document.querySelector('#eslite-credential-view')?.remove();}
async function viewEsliteCredentials(slot){
  hideEsliteCredentials();const generation=credentialViewGeneration;
  try{
    const response=await fetch('/auto-purchase/eslite/credentials/view',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Credential-View':'1'},cache:'no-store',body:JSON.stringify({slot})});
    if(!response.ok)throw new Error('無法查看已存帳密');
    const saved=await response.json();if(generation!==credentialViewGeneration||document.hidden)return;
    const dialog=document.createElement('dialog');dialog.id='eslite-credential-view';dialog.style.cssText='max-width:520px;width:90%;background:#141c30;color:#edf2f7;border:1px solid #35415e;border-radius:14px;padding:22px';
    const heading=document.createElement('h2');heading.textContent='誠品帳號 '+slot+'｜'+(saved.memberName||'姓名未記錄');dialog.append(heading);
    for(const [label,key]of [['帳號','account'],['密碼','password']]){const row=document.createElement('label');row.style.cssText='display:block;margin:12px 0';row.append(label+' ');const input=document.createElement('input');input.readOnly=true;input.autocomplete='off';input.setAttribute('aria-label','已存'+label);input.value=saved[key]||'';input.style.width='100%';row.append(input);dialog.append(row);}
    const note=document.createElement('p');note.textContent=saved.account&&saved.password?'本機查看；60 秒後自動關閉，不會更改帳密或登入狀態。':'此欄位沒有完整帳密紀錄。';dialog.append(note);
    const close=document.createElement('button');close.type='button';close.textContent='關閉';close.onclick=hideEsliteCredentials;dialog.append(close);dialog.addEventListener('cancel',hideEsliteCredentials);document.body.append(dialog);dialog.showModal();credentialViewTimer=setTimeout(hideEsliteCredentials,60000);
  }catch(error){document.querySelector('#auto-purchase-eslite-state').textContent='無法查看已存帳密，請重新整理後再試。';}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)hideEsliteCredentials();});
function ensureEsliteAccountUi(slot){
  if(!isEsliteAccountSlot(slot))return;
  if(!document.querySelector('#eslite-sheet-account-'+slot))document.querySelector('#eslite-sheet-account-A').parentElement.insertAdjacentHTML('beforeend',esliteAccountRowHtml(slot));
  if(document.querySelector('#eslite-account-'+slot+'-card'))return;
  const card=document.querySelector('#eslite-account-A-card').cloneNode(true);
  card.dataset.slot=slot;
  for(const el of card.querySelectorAll('.eslite-credential-view-action,[id^="eslite-release-hold-"],[id^="eslite-query-orders-"]'))el.remove();
  for(const el of [card,...card.querySelectorAll('*')])for(const name of ['id','name','onsubmit','onclick','aria-controls']){
    const value=el.getAttribute(name);if(value)el.setAttribute(name,value.replaceAll('eslite-account-A','eslite-account-'+slot).replaceAll("'A'","'"+slot+"'"));
  }
  for(const input of card.querySelectorAll('input')){
    if(input.type==='password'||input.autocomplete==='username')input.value='';
    if(input.type==='radio')input.checked=input.value==='virtual_atm_home';
    if(input.type==='checkbox')input.checked=true;
  }
  card.hidden=false;card.classList.add('compact');document.querySelector('#eslite-account-list').append(card);
  for(const select of card.querySelectorAll('select[id$="-mode"]'))select.value='single';
}
function currentEsliteSlots(){return esliteAccountSlots([...(currentStatus?.autoPurchase?.credentials?.eslite?.accounts||[]).map(item=>item.slot),...esliteVisibleSlots]);}
function addEsliteAccountCard(){let index=0;while(esliteVisibleSlots.has(esliteSlotLabel(index)))index++;const next=esliteSlotLabel(index);if(!isEsliteAccountSlot(next))return;esliteVisibleSlots.add(next);ensureEsliteAccountUi(next);const card=document.querySelector('#eslite-account-'+next+'-card');card.hidden=false;toggleEsliteAccountCard(next,true);renderAutoPurchase(currentStatus||{});card.scrollIntoView({behavior:'smooth',block:'center'});}
function rememberShoppingTargetManager(index,open){if(open)openShoppingTargetManagers.add(index);else openShoppingTargetManagers.delete(index);}
let saleReminderInspection=null;
let esliteExhibitionProbe=null;
let esliteExhibitionProbePromise=null;
const dashboardDateFormat=new Intl.DateTimeFormat('zh-TW',{dateStyle:'short',timeStyle:'medium'});
const fmt=d=>d&&Number.isFinite(new Date(d).getTime())?dashboardDateFormat.format(new Date(d)):'尚未完成';
let refreshPromise=null;
let refreshAgain=false;
${overviewClient}
${esliteTableClient}
${purchaseLogExportClient}
${purchaseListSortClient}
${purchaseReadinessClient}
${funboxTableClient}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,body){const options={method:'POST',headers:{'Content-Type':'application/json'}};if(body!==undefined)options.body=JSON.stringify(body);const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失敗');return data;}
function switchTab(name){activeTab=tabs.includes(name)?name:'overview';localStorage.setItem('beyblade-monitor-tab',activeTab);tabs.forEach(tab=>{const selected=tab===activeTab;document.querySelector('#tab-'+tab).hidden=!selected;const button=document.querySelector('#tab-button-'+tab);button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));});window.scrollTo({top:0,behavior:'instant'});void refresh();if(activeTab==='overview')void loadProductCatalog();if(activeTab==='fb')void refreshFormPreview();if(activeTab==='shopping')void refreshEsliteExhibitionProbe();}
function setSaleReminderView(view,persist=true){saleReminderView=view==='list'?'list':'cards';if(persist)localStorage.setItem('beyblade-sale-reminder-view',saleReminderView);const list=document.querySelector('#sale-reminder-list');if(list)list.classList.toggle('list-view',saleReminderView==='list');const cardButton=document.querySelector('#sale-reminder-view-cards');const listButton=document.querySelector('#sale-reminder-view-list');if(cardButton)cardButton.classList.toggle('active',saleReminderView==='cards');if(listButton)listButton.classList.toggle('active',saleReminderView==='list');}
function browserLabel(mode){if(mode==='background')return 'Facebook 背景執行';if(mode==='visible-login')return 'Facebook 登入視窗';return 'Facebook 尚未啟動';}
function toggleSelfCheck(force){selfCheckExpanded=force===undefined?!selfCheckExpanded:Boolean(force);const body=document.querySelector('#self-check-body');const button=document.querySelector('#self-check-toggle');body.hidden=!selfCheckExpanded;button.textContent=selfCheckExpanded?'收合':'展開';button.setAttribute('aria-expanded',String(selfCheckExpanded));}
function renderSelfCheck(result){const card=document.querySelector('#self-check-card');if(!result){card.hidden=true;return;}card.hidden=false;const labels={pass:'通過',warn:'警告',fail:'失敗'};document.querySelector('#self-check-summary').textContent='完成：'+fmt(result.completedAt)+'｜'+(result.overall==='pass'?'全部通過':result.overall==='warn'?'有警告項目':'有失敗項目');document.querySelector('#self-check-list').innerHTML=result.checks.map(check=>'<div class="check-item"><span class="check-status '+check.status+'">'+labels[check.status]+'</span><strong>'+esc(check.name)+'</strong><span class="check-detail muted">'+esc(check.detail)+'</span></div>').join('');toggleSelfCheck(selfCheckExpanded);}
function renderKeywords(productKeywords,salesKeywords){const render=(id,type,keywords)=>{document.querySelector('#'+id+'-keyword-count').textContent=keywords.length;document.querySelector('#'+id+'-keyword-list').innerHTML=keywords.map((keyword,index)=>'<span class="keyword-chip"><span>'+esc(keyword)+'</span><button type="button" title="移除 '+esc(keyword)+'" aria-label="移除 '+esc(keyword)+'" onclick="deleteKeyword(&quot;'+type+'&quot;,'+index+')">×</button></span>').join('');};render('product','productKeywords',productKeywords);render('sales','salesKeywords',salesKeywords);}
function renderPages(pages,hotspot={}){
  const list=document.querySelector('#page-list');
  const hotspotUrls=new Set(hotspot.pageUrls||[]);
  const indexed=pages.map((page,index)=>({page,index}));
  const active=indexed.filter(item=>item.page.enabled!==false);
  const paused=indexed.filter(item=>item.page.enabled===false);
  document.querySelector('#page-count').textContent=active.length;
  document.querySelector('#paused-page-count').textContent=paused.length;
  if(!pages.length){list.innerHTML='<p class="muted">尚未加入任何粉絲專頁。</p>';return;}
  const renderItem=({page,index},isPaused)=>{
    const modeLabel=!isPaused&&hotspotUrls.has(page.url)?'<span class="pill">熱點時段切換加速</span>':'';
    return '<div class="page-item"><div class="page-controls"><input id="nickname-'+index+'" value="'+esc(page.name)+'" aria-label="粉專暱稱"><button class="small" onclick="renamePage('+index+')">儲存暱稱</button><button class="secondary small" onclick="detectPageName('+index+')">自動抓取名稱</button><button class="'+(isPaused?'good':'secondary')+' small" onclick="setPageEnabled('+index+','+(isPaused?'true':'false')+')">'+(isPaused?'恢復監控':'暫停掃描')+'</button><button class="danger small" onclick="deletePage('+index+')">刪除</button><span class="page-state '+(isPaused?'sleep':'live')+'">'+(isPaused?'暫停中':'監控中')+'</span>'+modeLabel+'<span class="mode">'+(page.nameMode==='manual'?'手動暱稱':'自動名稱')+'</span></div><a class="page-url" href="'+esc(page.url)+'" target="_blank" rel="noopener noreferrer">'+esc(page.url)+'</a></div>';
  };
  list.innerHTML='<section class="page-group"><div class="page-group-title"><strong>🟢 FB 主監控名單</strong><span>平時使用常態模式；指定粉專在熱點時段自動切換加速，不會重複掃描</span></div>'+(active.length?active.map(item=>renderItem(item,false)).join(''):'<div class="page-empty">目前沒有運作中的粉專。</div>')+'</section><section class="page-group paused"><div class="page-group-title"><strong>⏸ 暫停區</strong><span>保留網址與暱稱，不會進行掃描</span></div>'+(paused.length?paused.map(item=>renderItem(item,true)).join(''):'<div class="page-empty">暫停區目前是空的。</div>')+'</section>';
}
function updateHotspotSelectionCount(){const checked=Array.from(document.querySelectorAll('#hotspot-page-list input:checked'));const badge=document.querySelector('#hotspot-page-count');badge.textContent=checked.length?'已選 '+checked.length+' 個':'尚未選擇';badge.className='pill selection-count '+(checked.length?'ok':'');return checked;}
function syncHotspotPageSelection(checkbox){const select=document.querySelector('#hotspot-page');const option=Array.from(select.options).find(item=>item.value===checkbox.value);if(option)option.selected=checkbox.checked;hotspotDirty=true;const checked=updateHotspotSelectionCount();document.querySelector('#hotspot-targets').textContent=checked.length?'準備儲存：'+checked.map(item=>item.dataset.name).join('、'):'請至少選擇一個熱點粉專。';}
function renderHotspot(s){
  const h=s.hotspot;
  const activePages=s.pages.filter(page=>page.enabled!==false);
  const select=document.querySelector('#hotspot-page');
  if(!hotspotDirty){
    const selectedUrls=new Set(h.pageUrls||[h.pageUrl]);
    select.innerHTML=activePages.map(page=>'<option value="'+esc(page.url)+'">'+esc(page.name)+'</option>').join('');
    Array.from(select.options).forEach(option=>option.selected=selectedUrls.has(option.value));
    document.querySelector('#hotspot-page-list').innerHTML=activePages.length?activePages.map(page=>'<label class="hotspot-page-choice"><input type="checkbox" value="'+esc(page.url)+'" data-name="'+esc(page.name)+'" onchange="syncHotspotPageSelection(this)" '+(selectedUrls.has(page.url)?'checked':'')+'><span><strong>'+esc(page.name)+'</strong><small>'+esc(page.url.replace(/^https?:\\/\\/(www\\.)?facebook\\.com\\//i,''))+'</small></span></label>').join(''):'<p class="muted">目前沒有運作中的粉專；請先從暫停區恢復監控。</p>';
    document.querySelector('#hotspot-start').value=h.activeHours.start;
    document.querySelector('#hotspot-end').value=h.activeHours.end;
    document.querySelector('#hotspot-interval').value=h.intervalSeconds;
    document.querySelector('#hotspot-burst-enabled').checked=h.burstModeEnabled;
    document.querySelector('#hotspot-burst-start').value=h.burstHours.start;
    document.querySelector('#hotspot-burst-end').value=h.burstHours.end;
    document.querySelector('#hotspot-burst-interval').value=h.burstIntervalSeconds;
    document.querySelector('#hotspot-autofill').checked=h.autoFillEnabled;
    document.querySelector('#hotspot-autosubmit').checked=h.autoSubmitEnabled;
    [1,2,3].forEach(slot=>document.querySelector('#hotspot-participant-'+slot).checked=(h.participantSlots||[1]).includes(slot));
  }
  updateHotspotSelectionCount();
  const names=(h.pageNames||[]).join('、')||'尚未選擇';
  document.querySelector('#hotspot-targets').textContent=(h.pageNames||[]).length+' 個粉專會在熱點時段由常態切換為加速：'+names;
  const live=Boolean(h.modeActive);
  const state=document.querySelector('#hotspot-state');
  state.textContent=!h.enabled?'熱點模式已關閉':!s.monitoringEnabled?'主監控關閉，熱點同步停止':!(h.pageNames||[]).length?'等待選擇粉專':!h.withinActiveHours?'常態模式中，等待熱點時段':'熱點加速中（'+h.effectiveIntervalSeconds+' 秒）';
  state.className='pill '+(live?'ok':'');
  const x=s.lastHotspotScan;
  const relevantNames=x&&x.relevantPages&&x.relevantPages.length?'｜命中 '+x.relevantPages.map(page=>page.name+' '+page.count+' 篇').join('、'):'';
  document.querySelector('#hotspot-last').textContent=(x?'上次熱點加速：'+fmt(x.completedAt)+'｜檢查 '+x.checked+' 篇｜重要情報 '+(x.relevant||0)+' 篇'+relevantNames+'｜通知 '+x.notified+' 則':'尚未完成熱點加速掃描')+(h.nextScanAt?'｜下次：'+fmt(h.nextScanAt):'')+(s.nextFormPrewarmAt?'｜填表預熱：'+fmt(s.nextFormPrewarmAt):'');
  const multi=s.lastMultiFill;
  document.querySelector('#multi-fill-last').textContent=multi?'三組結果 '+fmt(multi.completedAt)+'｜'+multi.results.map(item=>'第'+item.slot+'組 '+(item.submitted?'已送出':item.status)+(item.durationMs?' '+item.durationMs+'ms':'')).join('｜'):'尚無三組填表結果。';
  const a=s.autoFill;
  const selected=(a.profiles||[]).find(item=>item.slot===profileSlot);
  document.querySelector('#autofill-state').textContent='第 '+profileSlot+' 組：'+(selected&&selected.ready?'姓名與電話已設定':'尚未設定必要資料')+'｜本次參加 '+(a.participantSlots||[1]).join('、')+(a.lastResult&&profileSlot===1?'｜上次預填 '+a.lastResult.filled.length+' 欄、待確認 '+a.lastResult.uncertain.length+' 題':'');
  document.querySelector('#fill-profile-hint').textContent=selected&&selected.ready?(selected.fullName+'｜'+selected.phone):'尚未設定姓名與電話';
}
function aiProviderChanged(){const provider=document.querySelector('#ai-provider').value;const model=document.querySelector('#ai-model');if(!model.value||/^deepseek-|^gpt-/.test(model.value))model.value=provider==='deepseek'?'deepseek-v4-flash':'gpt-5.6-luna';}
function renderAI(s){const a=s.autoFill.ai;if(!aiDirty){document.querySelector('#ai-enabled').checked=a.enabled;document.querySelector('#ai-provider').value=a.provider||'deepseek';document.querySelector('#ai-model').value=a.model||'';}const last=a.lastCall;document.querySelector('#ai-state').textContent=(a.enabled?(a.configured?'AI 已啟用並有 Key':'AI 已啟用，但尚未設定 Key'):'AI 已停用')+'｜'+(a.provider==='deepseek'?'DeepSeek':'OpenAI')+' '+a.model+(a.keyHint?'｜Key '+a.keyHint:'')+(last?'｜上次 '+(last.ok?'成功 '+last.latencyMs+' ms':'失敗：'+last.error):'');}
async function refreshSavedProfile(force=false){if(profileDirty&&!force)return;try{const p=await fetch('/api/autofill-profile?slot='+profileSlot,{cache:'no-store'}).then(r=>r.json());document.querySelector('#fill-name').value=p.fullName||'';document.querySelector('#fill-phone').value=p.phone||'';document.querySelector('#fill-email').value=p.email||'';document.querySelector('#fill-id').value=p.nationalId||'';document.querySelector('#fill-birth').value=p.birthDate||'';document.querySelector('#fill-address').value=p.address||'';document.querySelector('#fill-profile-slot').value=String(profileSlot);profileLoaded=true;}catch(error){document.querySelector('#autofill-state').textContent='讀取本機資料失敗：'+error.message;}}
async function switchAutoFillProfile(){if(profileDirty&&!confirm('目前資料尚未儲存，仍要切換嗎？')){document.querySelector('#fill-profile-slot').value=String(profileSlot);return;}profileSlot=Number(document.querySelector('#fill-profile-slot').value);profileDirty=false;profileLoaded=false;await refreshSavedProfile(true);if(currentStatus)renderHotspot(currentStatus);}
function toggleSavedId(){const input=document.querySelector('#fill-id');const button=document.querySelector('#fill-id-toggle');input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'顯示':'隱藏';}
function embeddedFormUrl(url){try{const value=new URL(url);if(value.hostname==='docs.google.com'&&value.pathname.includes('/forms/'))value.searchParams.set('embedded','true');return value.toString();}catch{return url;}}
function reloadFormFrame(){const frame=document.querySelector('#form-preview-frame');if(previewUrl)frame.src=embeddedFormUrl(previewUrl)+(previewUrl.includes('?')?'&':'?')+'_reload='+Date.now();}
function setFormPreviewExpanded(expanded){previewExpanded=Boolean(expanded);const body=document.querySelector('#form-preview-body');const button=document.querySelector('#form-preview-toggle');body.hidden=!previewExpanded;button.textContent=previewExpanded?'收合':'展開';button.setAttribute('aria-expanded',String(previewExpanded));}
function toggleFormPreview(){setFormPreviewExpanded(!previewExpanded);}
async function refreshFormPreview(){try{const meta=await fetch('/api/form-preview',{cache:'no-store'}).then(r=>r.json());const card=document.querySelector('#form-preview-card');if(!meta.available){card.hidden=true;return;}card.hidden=false;document.querySelector('#form-preview-title').textContent=meta.title||'未辨識表單名稱';const state=document.querySelector('#form-preview-state');state.textContent=meta.submitted?'已送出':meta.submissionAttempted?'送出未確認':meta.status==='open'?'已開啟':'狀態：'+meta.status;state.className='pill '+(meta.submitted?'ok':meta.submissionAttempted?'bad':'');const aiReview=meta.aiReview;const aiText=aiReview?(aiReview.approved?'｜AI 複核通過':aiReview.used?'｜AI 複核未通過':'｜AI 複核略過'):'';document.querySelector('#form-preview-meta').textContent='更新：'+fmt(meta.at)+'｜已填 '+meta.filledCount+' 欄｜待確認 '+meta.uncertainCount+' 題'+aiText+(meta.durationMs?'｜處理 '+meta.durationMs+' ms':'');const url=meta.url||meta.requestedUrl||'';const executionKey=String(meta.executionId||url||meta.at||'');const seenKey=localStorage.getItem('beyblade-last-form-preview');if(executionKey&&executionKey!==seenKey){localStorage.setItem('beyblade-last-form-preview',executionKey);setFormPreviewExpanded(true);card.scrollIntoView({behavior:'smooth',block:'start'});}const link=document.querySelector('#form-preview-link');link.href=url;link.textContent=url?'在新分頁開啟：'+url:'尚無表單網址';if(url&&url!==previewUrl){previewUrl=url;document.querySelector('#form-preview-frame').src=embeddedFormUrl(url);}document.querySelector('#form-preview-image').src='/form-preview.png?v='+encodeURIComponent(meta.at||Date.now());const errors=[...(meta.validationErrors||[]),...(meta.dangerousSelections||[]),...(meta.fixedFormatErrors||[]),...(aiReview&&!aiReview.approved?(aiReview.issues||[]):[])];document.querySelector('#form-preview-errors').textContent=errors.join('｜');}catch(error){document.querySelector('#form-preview-errors').textContent='讀取表單預覽失敗：'+error.message;}}
function renderRegularState(s){const state=document.querySelector('#regular-state');if(!state)return;const cooling=Date.parse(s.facebookCooldownUntil||'')>Date.now();const live=s.monitoringEnabled&&s.withinActiveHours&&!cooling;state.textContent=!s.monitoringEnabled?'主監控已停止':cooling?'Facebook 冷卻中':!s.withinActiveHours?'主監控休息時段':s.scanning?'常態模式掃描中':'FB 主監控執行中';state.className='pill '+(live?'ok':'');}
function renderFunbox(s){document.querySelector('#funbox-log-status').textContent=funboxScanStatus(s);const f=s.funbox||{};const n=s.notifications||{};if(!funboxSettingsDirty){document.querySelector('#funbox-active-start').value=f.activeHours&&f.activeHours.start||'09:00';document.querySelector('#funbox-active-end').value=f.activeHours&&f.activeHours.end||'22:00';document.querySelector('#funbox-interval').value=f.intervalSeconds||30;document.querySelector('#funbox-stock-change-notifications').checked=Boolean(f.stockChangeNotificationsEnabled);}const activity=!f.enabled?'官網監控已停止':!f.withinActiveHours?'等待掃描時段':f.scanning?'正在檢查官網':f.boostActive?'新品高速追蹤中':'官網監控中';const speed=f.effectiveIntervalSeconds||f.intervalSeconds||30;document.querySelector('#funbox-summary').innerHTML='<span class="pill '+(f.enabled&&f.withinActiveHours?'ok':'bad')+'">'+activity+'</span><span class="pill">'+(f.activeHours?f.activeHours.start+'～'+f.activeHours.end:'未設定時段')+'</span><span class="pill '+(f.boostActive?'ok':'')+'">目前每 '+speed+' 秒</span><span class="pill '+(f.stockChangeNotificationsEnabled?'ok':'')+'">門檻通知 '+(f.stockChangeNotificationsEnabled?'已開啟':'已關閉')+'</span><span class="pill">正式基線 '+(f.seenCount||0)+' 件</span><span class="pill">APP 排除 '+(f.excludedCount||0)+' 件</span><span class="pill '+(n.funboxReady?'ok':'bad')+'">'+(n.funboxLabel||'通知')+' '+(n.funboxReady?'已設定':'未設定')+'</span>';const x=f.lastScan;document.querySelector('#funbox-last').textContent=(x?'上次完成：'+fmt(x.completedAt)+'｜目前 '+x.checked+' 件｜排除 '+(x.skipped||0)+' 件｜新發現 '+(x.discovered||0)+' 件｜庫存變動 '+(x.stockChanged||0)+' 件｜通知 '+(x.notified||0)+' 則':'尚未完成官網掃描。')+(f.boostActive?'｜5 秒強抓中，追蹤 '+(f.boostProductCount||0)+' 件新品至 '+fmt(f.boostUntil):f.nextScanAt?'｜下次：'+fmt(f.nextScanAt):'');document.querySelector('#funbox-error').textContent=x&&x.errors&&x.errors.length?x.errors.join('｜'):'';const button=document.querySelector('#funbox-monitor-button');button.textContent=f.enabled?'停止官網監控':'啟動官網監控';button.className=f.enabled?'danger':'good';const products=f.recentProducts||[];document.querySelector('#funbox-products').innerHTML=products.length?products.map(product=>'<div class="product-row"><div class="product-main">'+(product.imageUrl?'<img class="product-thumb" src="'+esc(product.imageUrl)+'" alt="">':'')+'<div><a href="'+esc(product.url)+'" target="_blank" rel="noopener noreferrer"><strong>'+esc(product.title)+'</strong></a><div class="product-meta">'+(product.price?esc(product.price)+'｜':'')+(product.stock===null||product.stock===undefined?'庫存未提供':'前台可售 '+product.stock)+'</div></div></div><div class="product-meta">'+fmt(product.firstSeenAt)+'</div></div>').join(''):'<p class="muted">目前正式基線為 0 件；正在等待一般販售商品。</p>';const excluded=f.recentExcludedProducts||[];document.querySelector('#funbox-excluded-products').innerHTML=excluded.length?excluded.map(product=>'<div class="product-row"><div><a href="'+esc(product.url)+'" target="_blank" rel="noopener noreferrer"><strong>'+esc(product.title)+'</strong></a><div class="product-meta">'+esc(product.reason||'APP 兌換商品排除')+'</div></div><div class="product-meta">最後掃描 '+fmt(product.lastSeenAt)+'</div></div>').join(''):'<p class="muted">目前沒有已排除商品。</p>';}
function renderShopping(s){
  renderShopee(s);
  const shop=s.shoppingSites||{};
  const n=s.notifications||{};
  if(!shoppingDirty){
    document.querySelector('#shopping-active-start').value=shop.activeHours&&shop.activeHours.start||'09:00';
    document.querySelector('#shopping-active-end').value=shop.activeHours&&shop.activeHours.end||'22:00';
    document.querySelector('#shopping-interval').value=shop.intervalSeconds||60;
    document.querySelector('#shopping-stock-change-notifications').checked=Boolean(shop.stockChangeNotificationsEnabled);
    if(document.activeElement!==document.querySelector('#shopping-exclude-keywords'))document.querySelector('#shopping-exclude-keywords').value=(shop.excludeKeywords||[]).join('\\n');
  }
  const state=document.querySelector('#shopping-state');
  const activity=!shop.enabled?'目前停止':!shop.withinActiveHours?'等待掃描時段':shop.scanning?(shop.boostActive?'高速讀取庫存中':'正在逐一檢查專區'):shop.boostActive?'補貨高速追蹤中':'已排程';
  state.textContent=activity;
  state.className='pill '+(shop.enabled&&shop.withinActiveHours?'ok':'');
  const targets=shop.targets||[];
  const esliteKeywordTarget=targets.find(target=>target.sourceType==='eslite-keywords');
  if(!esliteKeywordsDirty&&document.activeElement!==document.querySelector('#eslite-shopping-keywords'))document.querySelector('#eslite-shopping-keywords').value=(esliteKeywordTarget&&esliteKeywordTarget.keywords||[]).join('、');
  if(esliteKeywordTarget){
    const routes=esliteKeywordTarget.esliteRoutes||{};
    const routeLabel=route=>!route?'等待下一輪':route.status==='disabled'?'未啟用':route.status==='healthy'?'正常':route.status==='checking'?'掃描中':route.status==='cooldown'?'限流冷卻'+(route.retryAt?'，'+fmt(route.retryAt)+'再查':''):route.status==='blocked'?'暫時降速':'讀取異常';
    const pages=esliteKeywordTarget.discoveryPages||[];
    const latestPage=pages.find(page=>String(page.url||'').includes('CU202608-00061'))||pages[0]||{};
    const exhibitionState=document.querySelector('#eslite-exhibition-state');
    const probe=esliteExhibitionProbe;
    const exhibitionOpen=probe?.status==='live';
    const exhibitionIs404=probe?.status==='404';
    const exhibitionEmpty=probe?.status==='empty';
    const exhibitionFailed=probe?.status==='error';
    exhibitionState.textContent=exhibitionOpen?'已開放（讀到商品）':exhibitionIs404?'404（策展未開放）':exhibitionEmpty?'未開放（沒有商品）':exhibitionFailed?'讀取失敗':'正在確認';
    exhibitionState.className='pill '+(exhibitionOpen?'ok':exhibitionIs404||exhibitionEmpty||exhibitionFailed?'bad':'');
    const exhibitionLink=document.querySelector('#eslite-exhibition-link');
    exhibitionLink.href=probe?.url||latestPage.url||'https://www.eslite.com/exhibitions/CU202608-00061';
    document.querySelector('#eslite-exhibition-meta').textContent=
      (exhibitionOpen?'已讀到策展商品，符合預警條件。':exhibitionIs404?'目前導向 404／活動已結束頁，尚未符合預警條件。':exhibitionEmpty?'頁面可連線，但沒有讀到策展商品，尚未符合預警條件。':exhibitionFailed?'目前無法確認策展內容；搜尋監控仍會繼續。':'正在直接確認策展頁是否已有商品。')
      +(probe?'｜讀到商品 '+(probe.productCount||0)+' 件｜本次確認 '+fmt(probe.checkedAt):'');
    const baselineProducts=(esliteKeywordTarget.baselineProducts||[]).slice().sort((a,b)=>Date.parse(b.firstSeenAt||0)-Date.parse(a.firstSeenAt||0));
    document.querySelector('#eslite-baseline-count').textContent=baselineProducts.length;
    document.querySelector('#eslite-baseline-list').innerHTML=baselineProducts.length?baselineProducts.map(item=>{
      return '<div class="eslite-baseline-item"><a href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.title||('誠品商品 '+item.id))+'</a><div class="eslite-baseline-item-meta">商品編號 '+esc(item.id)+'｜首次記錄 '+fmt(item.firstSeenAt)+'</div></div>';
    }).join(''):'<p class="muted" style="padding:10px 12px">目前沒有已記錄商品。</p>';
    document.querySelector('#eslite-keyword-state').textContent=
      '搜尋監控：'+routeLabel(routes.search)+'，本輪找到 '+(routes.search&&routes.search.productCount||0)+' 件。\\n'
      +'單品確認：發現商品時才查，本輪完成 '+(routes.product&&routes.product.verifiedCount||0)+'／'+(routes.product&&routes.product.requestedCount||0)+' 件。\\n'
      +'目前搜尋：'+(esliteKeywordTarget.keywords||[]).join('、');
  }else{
    document.querySelector('#eslite-exhibition-state').textContent='尚未設定';
    document.querySelector('#eslite-exhibition-state').className='pill bad';
    document.querySelector('#eslite-exhibition-meta').textContent='尚未建立誠品關鍵字監控來源。';
    document.querySelector('#eslite-baseline-count').textContent='0';
    document.querySelector('#eslite-baseline-list').innerHTML='<p class="muted" style="padding:10px 12px">目前沒有已記錄商品。</p>';
    document.querySelector('#eslite-keyword-state').textContent='尚未建立誠品關鍵字監控來源。';
  }
  const esliteProducts=shop.esliteManualProducts||[];
  document.querySelector('#eslite-product-list').innerHTML=esliteProducts.length?esliteProducts.map(item=>'<div class="product-row"><div class="product-main">'+(item.imageUrl?'<img class="product-thumb" src="'+esc(item.imageUrl)+'" alt="">':'')+'<div><a href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer"><strong>'+esc(item.title||('誠品商品 '+item.id))+'</strong></a><div class="product-meta">商品編號 '+esc(item.id)+'｜手動補登基線，不代表目前可購</div></div></div><div class="japan-target-actions"><span class="pill">補登 '+fmt(item.addedAt)+'</span><button class="danger small" data-product-id="'+esc(item.id)+'" onclick="deleteEsliteProduct(this.dataset.productId)">刪除</button></div></div>').join(''):'<p class="muted">目前沒有手動補登商品。</p>';
  const activeTargets=targets.map((target,index)=>({target,index})).filter(item=>item.target.enabled!==false);
  const pausedTargets=targets.map((target,index)=>({target,index})).filter(item=>item.target.enabled===false);
  document.querySelector('#shopping-active-count').textContent=activeTargets.length;
  document.querySelector('#shopping-paused-count').textContent=pausedTargets.length;
  const customScheduleCount=targets.filter(target=>target.enabled!==false&&target.scheduleGroup==='custom').length;
  const onlineTargetCount=activeTargets.filter(item=>item.target.withinActiveHours).length;
  document.querySelector('#shopping-summary').innerHTML='<span class="pill '+(shop.enabled?'ok':'bad')+'">'+activeTargets.length+' 個監控｜'+pausedTargets.length+' 個暫停</span><span class="pill '+(onlineTargetCount?'ok':'')+'">現在運作 '+onlineTargetCount+' 個</span><span class="pill '+(shop.boostActive?'ok':'')+'">'+(shop.boostActive?'變化熱點 3 秒':'平時 '+(shop.intervalSeconds||60)+' 秒')+'</span><span class="pill">黑名單 '+(shop.excludeKeywords||[]).length+' 個</span><span class="pill '+(n.shoppingReady?'ok':'bad')+'">'+(n.shoppingReady?'Discord 通知正常':'通知尚未設定')+'</span>';
  const x=shop.lastScan;
  document.querySelector('#shopping-last').textContent=(x?'上次 '+fmt(x.completedAt)+'｜掃描 '+(x.checkedTargets||0)+' 個專區、'+(x.checkedProducts||0)+' 件商品｜排除 '+(x.excluded||0)+'｜新品 '+(x.discovered||0)+'｜補貨 '+(x.restocked||0)+'｜庫存變動 '+(x.stockChanged||0)+'｜通知 '+(x.notified||0)+'｜耗時 '+((x.durationMs||0)/1000).toFixed(1)+' 秒':'尚未完成購物網站掃描。')+(shop.boostActive?'｜變化熱點追蹤中':shop.nextScanAt?'｜下次 '+fmt(shop.nextScanAt):'');
  const currentErrors=(x&&x.errors||[]).filter(error=>!String(error).startsWith('BEYBLADE X 精選策展：'));
  document.querySelector('#shopping-error').textContent=currentErrors.join('｜');
  const button=document.querySelector('#shopping-monitor-button');
  button.textContent=shop.enabled?'停止購物網站監控':'啟動購物網站監控';
  button.className=shop.enabled?'danger':'good';
  const targetState=(target)=>target.enabled===false?'暫停中':!shop.enabled?'等待總開關':!target.withinActiveHours?'等待自己的時段':target.scanning?'掃描中':target.boostActive?'獨立熱點（'+target.effectiveIntervalSeconds+' 秒）':'常態（'+target.effectiveIntervalSeconds+' 秒）';
  const renderTarget=({target,index},paused)=>{
    const custom=target.scheduleGroup==='custom';
    const hours=target.activeHours||shop.activeHours||{start:'09:00',end:'22:00'};
    const scheduleText=custom?(hours.start===hours.end?'24 小時':'自訂 '+hours.start+'～'+hours.end):'共用 '+hours.start+'～'+hours.end;
    const stateText=targetState(target);
    const stateLive=!paused&&shop.enabled&&target.withinActiveHours;
    const baselineText=target.initialized?(target.productCount||0)+' 件商品｜排除 '+(target.excludedCount||0)+' 件｜上次 '+fmt(target.lastScanAt):'等待第一次掃描';
    return '<div class="shopping-target '+(paused?'paused':'')+'">'
      +'<div class="shopping-target-head"><div><div class="shopping-site-name">'+esc(target.siteName||'購物網站')+'</div><div class="shopping-target-title"><strong>'+esc(target.name)+'</strong></div><div class="shopping-target-facts"><span class="page-state '+(stateLive?'live':'sleep')+'">● '+esc(stateText)+'</span><span class="shopping-target-fact">⏱ '+esc(scheduleText)+'</span><span class="shopping-target-fact">'+esc(baselineText)+'</span>'+(target.lastError?'<span class="shopping-target-fact bad">需要檢查</span>':'')+'</div></div><a class="shopping-target-link" href="'+esc(target.url)+'" target="_blank" rel="noopener noreferrer">開啟專區 ↗</a></div>'
      +'<details class="shopping-target-manage" '+(openShoppingTargetManagers.has(index)?'open':'')+' ontoggle="rememberShoppingTargetManager('+index+',this.open)"><summary>管理設定</summary><div class="shopping-target-manage-body">'
      +'<div class="shopping-name-edit"><input id="shopping-nickname-'+index+'" value="'+esc(target.name)+'" maxlength="80" aria-label="'+esc(target.siteName||'購物網站')+' 專區暱稱"><button class="secondary small" onclick="renameShoppingTarget('+index+')">儲存暱稱</button></div>'
      +'<a class="page-url" title="'+esc(target.url)+'" href="'+esc(target.url)+'" target="_blank" rel="noopener noreferrer">'+esc(target.url)+'</a>'
      +'<div class="shopping-schedule-editor"><select id="shopping-schedule-mode-'+index+'" onchange="toggleShoppingScheduleInputs('+index+')"><option value="default" '+(!custom?'selected':'')+'>沿用共用時段</option><option value="custom" '+(custom?'selected':'')+'>使用自己的時段</option></select><input id="shopping-schedule-start-'+index+'" type="time" value="'+esc(hours.start)+'" '+(!custom?'disabled':'')+' aria-label="自訂開始時間"><span>到</span><input id="shopping-schedule-end-'+index+'" type="time" value="'+esc(hours.end)+'" '+(!custom?'disabled':'')+' aria-label="自訂結束時間"><button class="secondary small" onclick="saveShoppingTargetSchedule('+index+')">儲存時段</button></div>'
      +(target.lastError?'<div class="bad">最近錯誤：'+esc(target.lastError)+'</div>':'')
      +'<div class="shopping-target-actions"><button class="'+(paused?'good':'secondary')+' small" onclick="setShoppingTargetEnabled('+index+','+(paused?'true':'false')+')">'+(paused?'恢復監控':'暫停掃描')+'</button><button class="danger small" onclick="deleteShoppingTarget('+index+')">刪除專區</button></div>'
      +'</div></details></div>';
  };
  const editingShoppingField=String(document.activeElement&&document.activeElement.id||'').startsWith('shopping-nickname-')||String(document.activeElement&&document.activeElement.id||'').startsWith('shopping-schedule-');
  if(!editingShoppingField)document.querySelector('#shopping-target-list').innerHTML=targets.length?'<section class="page-group"><div class="page-group-title"><strong>🟢 掃描名單</strong><span>'+activeTargets.length+' 個專區｜各自排程、同步監控</span></div>'+(activeTargets.length?activeTargets.map(item=>renderTarget(item,false)).join(''):'<div class="page-empty">目前沒有運作中的購物專區。</div>')+'</section><section class="page-group paused"><div class="page-group-title"><strong>⏸ 暫停區</strong><span>'+pausedTargets.length+' 個專區</span></div>'+(pausedTargets.length?pausedTargets.map(item=>renderTarget(item,true)).join(''):'<div class="page-empty">暫停區目前是空的。</div>')+'</section>':'<p class="muted">尚未加入購物專區。</p>';
  const reminders=shop.saleReminders||[];
  const now=Date.now();
  const orderedReminders=reminders
    .map((reminder,index)=>({reminder,index,start:Date.parse(reminder.saleStartAt)}))
    .filter(item=>Number.isFinite(item.start)&&item.start>now)
    .sort((left,right)=>left.start-right.start);
  document.querySelector('#sale-reminder-count').textContent=orderedReminders.length;
  const reminderTime=(value)=>{const date=new Date(value);if(!Number.isFinite(date.getTime()))return '時間未設定';const pad=number=>String(number).padStart(2,'0');return pad(date.getMonth()+1)+'/'+pad(date.getDate())+' '+pad(date.getHours())+':'+pad(date.getMinutes());};
  const countdownText=(remaining)=>{if(remaining<=0)return '已開賣';const days=Math.floor(remaining/1440);const hours=Math.floor((remaining%1440)/60);const minutes=remaining%60;if(days)return '倒數 '+days+' 天 '+hours+' 小時';if(hours)return '倒數 '+hours+' 小時 '+minutes+' 分';return '倒數 '+minutes+' 分鐘';};
  const platformLabel=(name)=>/momo/i.test(name)?'MOMO購物':/facebook/i.test(name)?'FACEBOOK':name||'購物網站';
  const renderReminder=(reminder,index)=>{
    const start=Date.parse(reminder.saleStartAt);
    const remaining=Math.max(0,Math.ceil((start-now)/60000));
    const paused=reminder.enabled===false;
    const isSocial=/facebook\.com/i.test(reminder.url||'');
    const image=reminder.imageUrl?'<img src="'+esc(reminder.imageUrl)+'" alt="'+esc(reminder.name)+'" loading="lazy">':'<div class="sale-reminder-placeholder" aria-hidden="true">🌀</div>';
    const price=reminder.price?esc(reminder.price):isSocial?'活動提醒':'價格待公布';
    const hasStock=reminder.stock!==null&&reminder.stock!==undefined&&reminder.stock!==''&&Number.isFinite(Number(reminder.stock));
    const stock=hasStock?'（可能）庫存 '+Number(reminder.stock).toLocaleString('zh-TW'):'（可能）庫存待確認';
    return '<article class="sale-reminder-card '+(paused?'paused':'')+'">'
      +'<a class="sale-reminder-product" href="'+esc(reminder.url)+'" target="_blank" rel="noopener noreferrer">'
      +'<div class="sale-reminder-media">'+image+'<span class="sale-reminder-platform">'+esc(platformLabel(reminder.siteName))+'</span></div>'
      +'<div class="sale-reminder-content"><h3 class="sale-reminder-title">'+esc(reminder.name)+'</h3>'
      +'<div class="sale-reminder-sale-time">◷ '+reminderTime(reminder.saleStartAt)+' 開賣</div>'
      +'<div class="sale-reminder-facts"><span class="sale-reminder-price">'+price+'</span><span class="sale-reminder-stock '+(Number.isFinite(Number(reminder.stock))?'live':'')+'">'+stock+'</span></div>'
      +'<div class="sale-reminder-meta">加入時通知一次｜倒數 60／30／10 分鐘提醒</div></div></a>'
      +'<footer class="sale-reminder-footer"><span class="sale-reminder-countdown">'+(paused?'提醒已暫停':countdownText(remaining))+'</span>'
      +'<div class="sale-reminder-actions"><button class="secondary" onclick="refreshSaleReminder('+index+')">重新抓取</button><button class="'+(paused?'good':'secondary')+'" onclick="setSaleReminderEnabled('+index+','+(paused?'true':'false')+')">'+(paused?'恢復':'暫停')+'</button><button class="danger" onclick="deleteSaleReminder('+index+')">刪除</button></div></footer></article>';
  };
  document.querySelector('#sale-reminder-list').innerHTML=orderedReminders.length?orderedReminders.map(item=>renderReminder(item.reminder,item.index)).join(''):'<p class="muted">尚未設定開賣倒數提醒。</p>';
  setSaleReminderView(saleReminderView,false);
}
function renderNotifications(s){const n=s.notifications||{},a=n.availability||{};if(!notificationDirty){document.querySelector('#funbox-notification-mode').value=n.funbox||'auto';document.querySelector('#shopping-notification-mode').value=n.shopping||'auto';}document.querySelector('#notification-availability').textContent='公開 Discord '+(a.discordPublic?'已連接':'未連接')+'｜私人 Discord '+(a.discordPrivate?'已連接':'未連接')+'｜LINE '+(a.line?'已連接':'未連接');for(const [id,ready] of [['public',a.discordPublic],['private',a.discordPrivate],['mmtoy',a.discordMmtoy]]){const el=document.querySelector('#discord-'+id+'-status');el.textContent=ready?'已連接':'未連接';el.className='pill '+(ready?'ok':'bad');}document.querySelector('#notification-state').textContent='Funbox：'+(n.funboxLabel||'未設定')+'｜購物網站：'+(n.shoppingLabel||'未設定');}
function ensureDispatchControls(platform,slots){
  for(const slot of slots){
    const card=document.querySelector('#'+platform+'-account-'+slot+'-card');
    if(!card||document.querySelector('#'+platform+'-account-'+slot+'-mode'))continue;
    const field=document.createElement('div');field.className='field';
    field.innerHTML='<label>下單模式 <select id="'+platform+'-account-'+slot+'-mode" onchange="markAutoPurchaseDirty(&quot;'+platform+'&quot;)"><option value="single">單品｜一款一單</option><option value="batch">合單｜多款一單</option></select></label>';
    const body=card.querySelector('.funbox-account-body,.eslite-account-body')||card;body.append(field);
  }
  const anchor=document.querySelector('#auto-purchase-'+platform+'-enabled');
  if(!anchor||document.querySelector('#'+platform+'-batch-controls'))return;
  const box=document.createElement('details');box.id=platform+'-batch-controls';box.className='purchase-dispatch-settings';
  const change=' oninput="markAutoPurchaseDirty(&quot;'+platform+'&quot;)"';
  box.innerHTML='<summary>合單上限與配送規則</summary><div class="field"><label>合單最多 <input id="'+platform+'-batch-items" type="number" min="1" max="20" value="5"'+change+'> 款</label>'
    +'<label>集貨等待 <input id="'+platform+'-batch-collect" type="number" min="0" max="2000" value="500"'+change+'> ms</label>'
    +'<label>加車期限 <input id="'+platform+'-batch-build" type="number" min="1" max="20" value="8"'+change+'> 秒</label>'
    +'<label>每單含運上限 NT$ <input id="'+platform+'-batch-total" type="number" min="100" max="100000" value="1500"'+change+'></label>'
    +'<label><input id="'+platform+'-batch-partial" type="checkbox" checked'+change+'> 缺款時先買其他款</label>'
    +'<label>不可超商貨付關鍵字 <input id="'+platform+'-cod-blocked" placeholder="例：戰鬥盤"'+change+'></label>'
    +'</div><small class="muted">'+(platform==='funbox'?'一般款每日 1／午夜重置：人工假設；隨機強化組每日合計 3。':'已購品項永久排除。')+' 同帳號依序加車；送單不明先查單。</small>';
  anchor.closest('.field').after(box);
}
function renderAutoPurchase(s){
  const a=s.autoPurchase||{};
  const platforms={funbox:a.funbox||{},eslite:a.eslite||{}};
  const credentials=a.credentials||{};
  for(const slot of (credentials.funbox?.accounts||[]).map(item=>item.slot)){if(isEsliteAccountSlot(slot)){funboxVisibleSlots.add(slot);ensureFunboxAccountUi(slot);}}
  for(const slot of currentFunboxSlots())ensureFunboxAccountUi(slot);
  for(const slot of (credentials.eslite?.accounts||[]).map(item=>item.slot)){if(isEsliteAccountSlot(slot)){esliteVisibleSlots.add(slot);ensureEsliteAccountUi(slot);}}
  const keys=['funbox','eslite'];
  for(const platform of keys){
    const slots=platform==='eslite'?currentEsliteSlots():currentFunboxSlots();
    for(const slot of slots)if(platform==='eslite')ensureEsliteAccountUi(slot);
    ensureDispatchControls(platform,slots);
    if(autoPurchaseDirtyPlatforms.has(platform))continue;
    const item=platforms[platform];
    for(const slot of slots)document.querySelector('#'+platform+'-account-'+slot+'-mode').value=item.accountModes?.[slot]||'single';
    for(const [suffix,value] of Object.entries({items:item.batchMaxItems??5,collect:item.batchCollectMs??500,build:(item.batchBuildMs??8000)/1000,total:item.batchMaxTotal??1500}))document.querySelector('#'+platform+'-batch-'+suffix).value=value;
    document.querySelector('#'+platform+'-batch-partial').checked=item.batchAllowPartial!==false;
    document.querySelector('#'+platform+'-cod-blocked').value=(item.sevenCodBlockedKeywords||[]).join(',');
    document.querySelector('#auto-purchase-'+platform+'-enabled').checked=Boolean(item.enabled);
    document.querySelector('#auto-purchase-'+platform+'-quantity').value=item.quantity||1;
    for(const slot of platform==='eslite'?currentEsliteSlots():currentFunboxSlots()){
      const value=(item.accountPayments||{})[slot]||(!['A','B','C'].includes(slot)?'virtual_atm_home':item.payment||'seven_cod');
      const radio=document.querySelector('input[name="'+platform+'-account-'+slot+'-payment"][value="'+value+'"]');if(radio)radio.checked=true;
    }
    document.querySelector('#'+platform+'-skip-buy-keywords').value=(item.skipBuyKeywords||[]).join('\\n');
    document.querySelector('#'+platform+'-buy-keywords').value=(item.buyKeywords||[]).join('\\n');
    if(platform==='eslite'){document.querySelector('#eslite-buy-mode').value=item.buyMode||'all';document.querySelector('#eslite-priority-keywords').value=(item.priorityKeywords||[]).join(',');}
    if(platform==='funbox')document.querySelector('#funbox-priority-keywords').value=(item.priorityKeywords||[]).join(',');
  }
  document.querySelector('#funbox-purchase-rule-summary').textContent='黑 '+(platforms.funbox.skipBuyKeywords||[]).length+'／白 '+(platforms.funbox.buyKeywords||[]).length;
  document.querySelector('#eslite-purchase-rule-summary').textContent='黑 '+(platforms.eslite.skipBuyKeywords||[]).length+'／白 '+(platforms.eslite.buyKeywords||[]).length+'・'+(platforms.eslite.buyMode==='whitelist'?'只買白名單':'黑名單以外皆可');
  updateEsliteRuleMode();
  const displayNames={funbox:'FUNBOX',eslite:'誠品'};
  const enabledNames=keys.filter(key=>platforms[key].enabled).map(key=>displayNames[key]);
  for(const platform of keys){
    const badge=document.querySelector('#auto-purchase-'+platform+'-summary');
    badge.textContent=!a.enabled?'總開關已關閉':platforms[platform].enabled?'自動下單已啟用':'已關閉';
    badge.className='pill '+(a.enabled&&platforms[platform].enabled?'ok':'');
    const credential=credentials[platform]||{};
    document.querySelector('#auto-purchase-'+platform+'-credentials').textContent=credential.ready?'帳密已加密儲存'+(credential.account?'（'+credential.account+'）':''):'尚未儲存帳密';
  }
  const funboxCredential=credentials.funbox||{};
  const funboxRuntime=a.runtime&&a.runtime.funbox||{};
  const funboxRuntimeAccounts=funboxRuntime.accounts||[];
  const loginLabels={ready:'登入正常',checking:'驗證中',warming:'預熱中',needs_login:'需要登入',unknown:'稍後重試',error:'登入異常',idle:'等待驗證'};
  for(const slot of currentFunboxSlots()){
    const account=(funboxCredential.accounts||[]).find(item=>item.slot===slot)||{};
    const runtimeAccount=funboxRuntimeAccounts.find(item=>item.slot===slot)||{};
    const card=document.querySelector('#funbox-account-'+slot+'-card');
    renderPickupSetupControls('funbox',slot,runtimeAccount);
    if(card){card.classList.add('purchase-account-row');card.classList.toggle('compact',!funboxExpandedSlots.has(slot));}
    const title=document.querySelector('#funbox-account-'+slot+'-title');
    const badge=document.querySelector('#funbox-account-'+slot+'-status');
    const meta=document.querySelector('#funbox-account-'+slot+'-meta');
    const enabled=document.querySelector('#funbox-account-'+slot+'-enabled');
    if(document.activeElement!==enabled)enabled.checked=account.enabled!==false;
    title.textContent='帳號 '+slot+'｜'+(account.displayAccount||'尚未設定');
    const state=!account.ready?'not_configured':account.enabled===false?'disabled':runtimeAccount.loginState||account.loginState||'idle';
    badge.textContent=state==='not_configured'?'未設定':state==='disabled'?'已停用':loginLabels[state]||'等待驗證';
    badge.className='pill '+(state==='ready'?'ok':state==='error'?'bad':'');
    const verified=runtimeAccount.lastVerifiedAt||account.lastVerifiedAt;
    const next=runtimeAccount.nextVerifyAt||account.nextVerifyAt;
    const error=runtimeAccount.lastError||account.lastError;
    const paymentLabel=(platforms.funbox.accountPayments||{})[slot]==='virtual_atm_home'?'宅配虛擬 ATM':'超商貨付';
    meta.textContent=(!account.ready?'尚未儲存這組帳密。':(verified?'上次驗證：'+fmt(verified):'尚未完成背景登入驗證')+(next?'｜下次：'+fmt(next):'')+(error?'｜'+error:''))+'｜策略：'+paymentLabel;
  }
  document.querySelector('#auto-purchase-funbox-credentials').textContent='已啟用 '+((funboxCredential.accounts||[]).filter(item=>item.ready&&item.enabled!==false).length)+' 組｜獨立購物車｜黑名單優先、白名單命中才買。';
  const esliteCredential=credentials.eslite||{};
  const esliteRuntime=a.runtime&&a.runtime.eslite||{};
  const esliteRuntimeAccounts=esliteRuntime.accounts||[];
  for(const slot of currentEsliteSlots()){
    const account=(esliteCredential.accounts||[]).find(item=>item.slot===slot)||{};
    const runtimeAccount=esliteRuntimeAccounts.find(item=>item.slot===slot)||{};
    if(account.ready)esliteVisibleSlots.add(slot);
    const card=document.querySelector('#eslite-account-'+slot+'-card');
    if(card){card.classList.add('purchase-account-row');card.hidden=!esliteVisibleSlots.has(slot);card.classList.toggle('compact',!esliteExpandedSlots.has(slot));}
    const title=document.querySelector('#eslite-account-'+slot+'-title');
    const badge=document.querySelector('#eslite-account-'+slot+'-status');
    const meta=document.querySelector('#eslite-account-'+slot+'-meta');
    const enabled=document.querySelector('#eslite-account-'+slot+'-enabled');
    if(document.activeElement!==enabled)enabled.checked=account.enabled!==false;
    title.textContent='帳號 '+slot+'｜'+(account.account||account.displayAccount||'尚未設定');
    const memberName=(a.esliteMemberNames||{})[slot];
    title.textContent+='｜'+(memberName||'姓名待辨識');
    let viewButton=card.querySelector('.eslite-credential-view-action');
    if(!viewButton){viewButton=document.createElement('button');viewButton.type='button';viewButton.className='secondary small eslite-credential-view-action';viewButton.textContent='查看已存帳密';viewButton.onclick=()=>viewEsliteCredentials(slot);card.querySelector('.eslite-account-body').prepend(viewButton);}
    viewButton.disabled=!account.ready;
    const state=!account.ready?'not_configured':account.enabled===false?'disabled':runtimeAccount.loginState||account.loginState||'idle';
    badge.textContent=state==='not_configured'?'未設定':state==='disabled'?'已停用':loginLabels[state]||'等待驗證';
    badge.className='pill '+(state==='ready'?'ok':['error','needs_login'].includes(state)?'bad':'');
    renderPickupSetupControls('eslite',slot,runtimeAccount);
    const paymentLabel=((platforms.eslite.accountPayments||{})[slot]||'virtual_atm_home')==='virtual_atm_home'?'宅配轉帳／ATM':'7-11 貨到付款';
    const verified=runtimeAccount.lastVerifiedAt||account.lastVerifiedAt;
    const next=runtimeAccount.nextVerifyAt||account.nextVerifyAt;
    const heartbeat=runtimeAccount.heartbeatEnabled
      ? (runtimeAccount.heartbeatMode==='accelerated'?'心跳加速中（90 秒）':'心跳運作中（10 分鐘）')
      :'心跳休眠';
    const apiState=esliteAccountReadiness(a,account,runtimeAccount).text;
    const recovery=runtimeAccount.sessionRecoveryState==='recovering'?'｜背景登入恢復中':runtimeAccount.manualLoginRequired?'｜需人工驗證':runtimeAccount.sessionRecoveryState==='retry_pending'?'｜稍後自動再查':runtimeAccount.sessionRecoveryState==='needs_attention'?'｜登入恢復需處理':'';
    const expiry=runtimeAccount.tokenExpiresAt?'｜憑證到期：'+fmt(runtimeAccount.tokenExpiresAt):'';
    const hold=runtimeAccount.purchaseHold?'｜結果不明保護中，請核對官方訂單':'';
    let releaseButton=document.querySelector('#eslite-release-hold-'+slot);
    if(!releaseButton){releaseButton=document.createElement('button');releaseButton.id='eslite-release-hold-'+slot;releaseButton.type='button';releaseButton.className='secondary small';releaseButton.textContent='已核對未成立，解除保護';releaseButton.onclick=()=>resolveEsliteHold(slot);meta.after(releaseButton);}
    releaseButton.hidden=!runtimeAccount.purchaseHold;
    let queryButton=document.querySelector('#eslite-query-orders-'+slot);
    if(!queryButton){queryButton=document.createElement('button');queryButton.id='eslite-query-orders-'+slot;queryButton.type='button';queryButton.className='secondary small';queryButton.textContent='官方查單／同步已購';queryButton.onclick=()=>queryEsliteOrders(slot);meta.after(queryButton);}
    queryButton.disabled=!account.ready||runtimeAccount.busy||Boolean(queryButton.dataset.running);
    const fullIdentity=esliteDisplayIdentities[slot];
    renderEsliteAccountSheet(fullIdentity?{...a,esliteMemberNames:{...a.esliteMemberNames,[slot]:fullIdentity.memberName}}:a,slot,fullIdentity?{...account,account:fullIdentity.account}:account,runtimeAccount,esliteVisibleSlots.has(slot));
    document.querySelector('#eslite-sheet-settings-'+slot).setAttribute('aria-expanded',String(esliteExpandedSlots.has(slot)));
    const verifyError=runtimeAccount.accountPreparationError||runtimeAccount.lastVerifyError||runtimeAccount.lastHeartbeatResult||'';
    meta.textContent=(!account.ready?'尚未儲存這組帳密。':apiState+recovery+hold+expiry+'｜'+heartbeat+(verified?'｜上次確認：'+fmt(verified):'')+(next?'｜下次：'+fmt(next):'')+(verifyError&&verifyError!=='尚未檢查'?'｜'+verifyError:''))+'｜策略：'+paymentLabel;
  }
  const esliteReadyCount=(esliteCredential.accounts||[]).filter(item=>item.ready&&item.enabled!==false).length;
  document.querySelector('#eslite-account-count').textContent=esliteReadyCount+' 組已設定｜'+esliteVisibleSlots.size+' 組顯示';
  const addEsliteButton=document.querySelector('#eslite-add-account');if(addEsliteButton){addEsliteButton.disabled=false;addEsliteButton.textContent='＋ 新增帳號';}
  const esliteApiReadyCount=esliteRuntimeAccounts.filter(item=>item.apiReady===true).length;
  const esliteBadge=document.querySelector('#auto-purchase-eslite-summary');
  if(a.enabled&&platforms.eslite.enabled){
    esliteBadge.textContent=esliteApiReadyCount?'快線就緒 '+esliteApiReadyCount+'／'+esliteReadyCount:esliteRuntimeAccounts.some(item=>item.purchaseHold)?'訂單待核對':esliteRuntimeAccounts.some(item=>item.loginState==='needs_login')?'需要登入':esliteRuntimeAccounts.some(item=>item.heartbeatEnabled)?'API 待命檢查中':'時段外休眠';
    esliteBadge.className='pill '+(esliteApiReadyCount?'ok':'bad');
  }
  document.querySelector('#auto-purchase-eslite-credentials').textContent='已啟用 '+esliteReadyCount+' 組帳號｜API 快線就緒 '+esliteApiReadyCount+' 組｜單品／合單各帳號自選，最多三路並行。';
  const heartbeatAccounts=esliteRuntimeAccounts.filter(item=>item.heartbeatEnabled);
  const loginReadyAccounts=esliteRuntimeAccounts.filter(item=>item.loginState==='ready');
  const heartbeatSummary=document.querySelector('#eslite-heartbeat-summary');
  const esliteHeartbeatAccelerated=heartbeatAccounts.some(item=>item.heartbeatMode==='accelerated');
  heartbeatSummary.textContent=!a.enabled||!platforms.eslite.enabled?'誠品自動下單未啟用，登入心跳休眠。啟用後只在誠品監控時段內運作。':!heartbeatAccounts.length?'目前不在誠品監控時段，或購物網站監控已停止；本地憑證保留，不在場外持續登入。':'API 待命檢查：'+heartbeatAccounts.map(item=>'帳號 '+item.slot).join('、')+'｜'+(esliteHeartbeatAccelerated?'偵測到變化，暫時每 90 秒檢查':'平常每 10 分鐘檢查')+'｜有效憑證只查 API，失效才背景登入；不反覆清空已確認空車｜快線就緒 '+esliteApiReadyCount+' 組。';
  heartbeatSummary.className='eslite-heartbeat-summary '+(heartbeatAccounts.length&&loginReadyAccounts.length===heartbeatAccounts.length?'ok':heartbeatAccounts.some(item=>item.loginState==='needs_login'||item.loginState==='error')?'bad':'');
  const summary=document.querySelector('#auto-purchase-summary');
  summary.textContent=!a.enabled?'全部關閉':a.processing?'處理訂單中':'待命中';
  summary.className='pill '+(a.enabled?'ok':'');
  const headerSummary=document.querySelector('#auto-purchase-header-summary');
  headerSummary.textContent=!a.enabled?'總開關已關閉':!platforms.eslite.enabled?'已關閉':esliteRuntimeAccounts.some(item=>item.busy)?'誠品下單中':esliteApiReadyCount?'快線就緒 '+esliteApiReadyCount+'／'+esliteReadyCount:'誠品已啟用';
  headerSummary.className='pill '+(a.enabled&&platforms.eslite.enabled?'ok':'');
  document.querySelector('#shared-auto-purchase-status').textContent=!a.enabled?'全部關閉':a.processing?'正在處理訂單':'自動購買待命中';
  document.querySelector('#shared-auto-purchase-platforms').textContent='已開啟：'+(enabledNames.length?enabledNames.join('、'):'無');
  document.querySelector('#shared-auto-purchase-queue').textContent='購買工作器：'+(a.processing?'處理中':'待命')+'｜排隊 '+(a.queued||0)+' 件';
  const maintenance=a.maintenance||{};
  const maintenanceTimes=(maintenance.times||[]).join('、')||'未排程';
  const maintenanceLast=maintenance.lastRun&&maintenance.lastRun.completedAt;
  document.querySelector('#auto-purchase-maintenance').textContent='購物車自動保養：每天 '+maintenanceTimes+'｜購買中會自動延後，絕不清空進行中的訂單'+(maintenanceLast?'｜上次：'+fmt(maintenanceLast):'｜尚未執行');
  renderEsliteTables(a);
  renderFunboxTables(a);
  const labels={ordered:'訂單成立',success:'訂單成立',payment_failed:'訂單成立／付款失敗','3ds_pending':'等待 3DS 驗證',checkout_limited:'CYBERBIZ 限購攔截',stock_out:'結帳時售完',carted:'停在購物車',cart:'停在購物車',failed:'失敗',processing:'處理中'};
  const names={funbox:'Funbox 官網',eslite:'誠品線上',momo:'momo購物網',kingstone:'墊腳石購物網'};
  const openedSteps=new Set(Array.from(document.querySelectorAll('#auto-purchase-recent details[open]')).map(el=>el.dataset.task));
  const recent=[...(a.inProgress||[]),...(a.recent||[])].filter(item=>item.platform!=='mmtoy');
  document.querySelector('#auto-purchase-recent').innerHTML=recent.length?'<div class="purchase-results-scroll"><table class="purchase-results-table"><thead><tr><th>時間</th><th>平台／帳號</th><th>商品</th><th>結果</th><th>訂單編號</th><th>付款</th><th>耗時</th></tr></thead><tbody>'+recent.map(item=>{
    const title=(item.product&&item.product.title)||'未命名商品';
    const uncertain=item.status==='submitted_unconfirmed';
    const ok=['ordered','success'].includes(item.status);
    const orderId=item.orderId||item.orderNumber||'—';
    const link=String(item.resultUrl||'').startsWith('https://')?'<a href="'+esc(item.resultUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(orderId)+'</a>':esc(orderId);
    const steps=item.steps||item.timings?.steps||[];
    const states={start:'進行中',success:'完成',retry:'補查／重試',failed:'停止',unknown:'待核對',info:'紀錄'};
    const task=item.taskId||item.startedAt||'';
    const progress=item.platform==='eslite'?'<details data-task="'+esc(task)+'"'+(openedSteps.has(task)?' open':'')+'><summary>流程 '+steps.length+' 筆'+(steps.length?'｜'+esc(steps[steps.length-1].label):'｜舊紀錄，未記錄詳細步驟')+'</summary><ol>'+steps.map(step=>'<li>'+esc(fmt(step.at))+'｜+'+(Number(step.elapsedMs||0)/1000).toFixed(3)+' 秒｜'+esc(step.label)+'｜'+esc(states[step.state]||step.state||'')+(step.attempt?'｜第 '+Number(step.attempt)+' 次':'')+(step.httpStatus?'｜HTTP '+Number(step.httpStatus):'')+(step.reason?'｜'+esc(step.reason):'')+'</li>').join('')+'</ol></details>':'';
    return '<tr><td>'+fmt(item.completedAt||item.startedAt)+'</td><td>'+esc(names[item.platform]||item.platform)+(item.accountSlot?'／'+esc(item.accountSlot):'')+'</td><td>'+esc(title)+(item.error?'<small class="bad">'+esc(item.error)+'</small>':'')+'</td><td><span class="pill '+(ok?'ok':'bad')+'">'+esc(uncertain?'待核對／未確認成立':labels[item.status]||item.status)+'</span></td><td>'+link+'</td><td>'+esc(item.payment==='virtual_atm_home'?'宅配 ATM':item.payment==='seven_cod'?'超商貨付':'—')+'</td><td>'+(Number.isFinite(item.durationMs)?(item.durationMs/1000).toFixed(2)+' 秒':'—')+'</td></tr>'+(progress?'<tr><td colspan="7">'+progress+'</td></tr>':'');
  }).join('')+'</tbody></table></div>':'尚無紀錄。';
}
function renderSharedStatus(s){const n=s.notifications||{},f=s.funbox||{},shop=s.shoppingSites||{};document.querySelector('#shared-funbox-status').textContent=(!f.enabled?'目前停止':!f.withinActiveHours?'等待掃描時段':f.boostActive?'新品高速追蹤中':'監控中')+'｜'+(f.activeHours?f.activeHours.start+'～'+f.activeHours.end:'未設定時段')+'｜目前每 '+(f.effectiveIntervalSeconds||f.intervalSeconds||30)+' 秒｜正式基線 '+(f.seenCount||0)+'｜APP排除 '+(f.excludedCount||0)+'｜門檻提醒'+(f.stockChangeNotificationsEnabled?'開啟':'關閉');const activeShopping=(shop.targets||[]).filter(target=>target.enabled!==false);const pausedShopping=(shop.targets||[]).filter(target=>target.enabled===false);const onlineShopping=activeShopping.filter(target=>target.withinActiveHours);const customShopping=activeShopping.filter(target=>target.scheduleGroup==='custom').length;const reminderCount=(shop.saleReminders||[]).filter(reminder=>reminder.enabled!==false&&Date.parse(reminder.saleStartAt)>Date.now()).length;document.querySelector('#shared-shopping-status').textContent=!shop.enabled?'監控已停止':shop.scanning?'正在掃描':shop.boostActive?'變化熱點追蹤中':'監控正常運作';document.querySelector('#shared-shopping-schedule-status').textContent='專區：'+activeShopping.length+' 個監控｜'+pausedShopping.length+' 個暫停｜現在運作 '+onlineShopping.length+' 個';document.querySelector('#shared-shopping-speed-status').textContent='排程：共用 '+(shop.activeHours?shop.activeHours.start+'～'+shop.activeHours.end:'未設定')+'｜自訂時段 '+customShopping+' 個｜平時 '+(shop.intervalSeconds||60)+' 秒／變化 3 秒';document.querySelector('#shared-shopping-reminder-status').textContent='提醒：庫存'+(shop.stockChangeNotificationsEnabled?'開啟':'關閉')+'｜開賣倒數 '+reminderCount+' 個｜Discord '+(n.shoppingReady?'正常':'未設定');document.querySelector('#shared-notification-status').textContent='Funbox：'+(n.funboxLabel||'未設定')+'｜購物網站：'+(n.shoppingLabel||'未設定');}
function renderFunboxSandbox(s){const f=s.funboxSandbox||{};const activity=!f.enabled?'測試監控未開啟':f.scanning?'正在掃描':'測試監控已開啟';document.querySelector('#funbox-sandbox-summary').innerHTML='<span class="pill '+(f.enabled?'ok':'bad')+'">'+activity+'</span><span class="pill">每 '+(f.intervalSeconds||5)+' 秒</span><span class="pill">已上架 '+(f.publishedCount||0)+' 件</span><span class="pill">已通知 '+(f.seenCount||0)+' 件</span>';const x=f.lastScan;document.querySelector('#funbox-sandbox-last').textContent=(x?'上次掃描：'+fmt(x.completedAt)+'｜找到 '+x.checked+' 件｜新商品 '+(x.discovered||0)+' 件｜送出通知 '+(x.notified||0)+' 則':'尚未執行測試掃描。')+(f.nextScanAt?'｜下次：'+fmt(f.nextScanAt):'');const button=document.querySelector('#funbox-sandbox-monitor-button');button.textContent=f.enabled?'停止測試監控':'啟動測試監控';button.className=f.enabled?'danger':'good';const flow=document.querySelector('#test-flow-state');if(f.publishedCount>0&&f.seenCount>=f.publishedCount){flow.textContent='✓ 掃描成功，Discord 通知已送出。';flow.className='test-success ok';}else if(f.enabled&&f.publishedCount>0){flow.textContent='已發現上架商品，正在送出 Discord 通知…';flow.className='test-success';}else if(f.enabled){flow.textContent='測試監控已開啟。現在請打開上架頁面並模擬上架。';flow.className='test-success ok';}else{flow.textContent='等待你啟動測試監控。';flow.className='test-success';}const products=f.products||[];document.querySelector('#funbox-sandbox-products').innerHTML=products.map(product=>'<div class="product-row"><div><strong>'+esc(product.title)+'</strong><div class="product-meta">'+esc(product.sku)+'｜NT$'+Number(product.price||0).toLocaleString('zh-TW')+'｜庫存 '+product.stock+'</div></div><span class="pill '+(product.published?'ok':'')+'">'+(product.published?'已模擬上架':'未上架')+'</span></div>').join('');}
function renderChannelLogs(s){if(!s)return;renderRegularState(s);if(!memoDirty)document.querySelector('#memo').value=s.note||'';document.querySelector('#regular-logs').textContent=(s.regularLogs||[]).join('\\n')||'尚無常態模式紀錄';document.querySelector('#hotspot-logs').textContent=(s.hotspotLogs||[]).join('\\n')||'尚無熱點加速紀錄';document.querySelector('#funbox-logs').textContent=(s.funboxLogs||[]).join('\\n')||'尚無官網監控紀錄';const grouped=s.shoppingSiteLogs||{};const preferred=['FUNBOX官網','蝦皮-FUNBOX','誠品線上','momo購物網','墊腳石','童無忌','森森文具','MM小舖-已停用','其他購物網站'];const keys=Object.keys(grouped).sort((a,b)=>{const ai=preferred.indexOf(a),bi=preferred.indexOf(b);return(ai<0?999:ai)-(bi<0?999:bi)||a.localeCompare(b,'zh-TW');});document.querySelector('#shopping-logs').textContent=keys.length?keys.map(key=>'【'+key+'】\\n'+(grouped[key]||[]).join('\\n')).join('\\n\\n'):((s.shoppingLogs||[]).join('\\n')||'尚無購物網站監控紀錄');}
function renderJapan(s){const j=s.japanAuctions||{};if(!japanDirty){document.querySelector('#japan-active-start').value=j.activeHours&&j.activeHours.start||'00:00';document.querySelector('#japan-active-end').value=j.activeHours&&j.activeHours.end||'00:00';document.querySelector('#japan-interval').value=j.intervalSeconds||30;const blacklist=document.querySelector('#japan-exclude-keywords');if(document.activeElement!==blacklist)blacklist.value=(j.excludeKeywords||[]).join('\\n');}const targets=j.targets||[];const active=targets.filter(t=>t.enabled!==false);const state=document.querySelector('#japan-state');state.textContent=!j.enabled?'目前停止':!j.withinActiveHours?'等待掃描時段':j.scanning?'正在讀取日本網站':'監控已排程';state.className='pill '+(j.enabled&&j.withinActiveHours?'ok':'');document.querySelector('#japan-summary').innerHTML='<span class="pill '+(j.enabled?'ok':'bad')+'">'+active.length+' 個網站運作</span><span class="pill">平時 '+(j.intervalSeconds||30)+' 秒</span><span class="pill">黑名單 '+(j.excludeKeywords||[]).length+' 個</span><span class="pill '+(j.notificationReady?'ok':'bad')+'">日拍 Discord '+(j.notificationReady?'已連接':'未設定')+'</span>';const x=j.lastScan;const targetName=x&&(x.siteName||targets.find(target=>target.id===x.targetId)?.siteName);document.querySelector('#japan-last').textContent=x?'最近完成：'+(targetName||'日本網站')+'｜'+fmt(x.completedAt)+'｜'+(x.checkedProducts||0)+' 件｜排除 '+(x.excluded||0)+'｜新品 '+(x.discovered||0)+'｜補貨 '+(x.restocked||0)+'｜通知 '+(x.notified||0):'尚未完成日本網站掃描。';document.querySelector('#japan-error').textContent=(x&&x.errors||[]).join('｜');const button=document.querySelector('#japan-monitor-button');button.textContent=j.enabled?'停止日本拍賣監控':'啟動日本拍賣監控';button.className=j.enabled?'danger':'good';document.querySelector('#japan-target-list').innerHTML=targets.map((target,index)=>{const baseline=target.baselineProductCount??target.productCount??0;const cadence=target.scanning?'掃描中':target.backoffUntil?'讀取失敗，降速至 '+fmt(target.backoffUntil):target.boostActive?'熱點 '+target.effectiveIntervalSeconds+' 秒':'常態 '+target.effectiveIntervalSeconds+' 秒';return '<section class="japan-target-card '+(target.enabled===false?'paused':'')+'"><div class="shopping-site-name">'+esc(target.siteName)+'</div><h3>'+esc(target.name)+'</h3><a class="page-url" href="'+esc(target.url)+'" target="_blank" rel="noopener noreferrer">'+esc(target.url)+'</a><div class="shopping-target-facts"><span class="shopping-target-fact">'+cadence+'</span><span class="shopping-target-fact">'+(target.initialized?baseline+' 件保留基線｜本輪讀取 '+(target.lastRawProductCount||0)+' 件｜排除 '+(target.excludedCount||0):'等待建立基線')+'</span><span class="shopping-target-fact">解析器：'+esc(target.sourceType)+'</span>'+(target.failureCount?'<span class="shopping-target-fact bad">連續失敗 '+target.failureCount+' 次</span>':'')+'</div>'+(target.lastError?'<p class="bad">最近錯誤：'+esc(target.lastError)+'</p>':'')+'<div class="japan-target-actions"><button class="'+(target.enabled===false?'good':'secondary')+' small" onclick="setJapanTargetEnabled('+index+','+(target.enabled===false)+')">'+(target.enabled===false?'恢復監控':'暫停監控')+'</button><button class="danger small" onclick="deleteJapanTarget('+index+')">刪除</button><a class="shopping-target-link" href="'+esc(target.url)+'" target="_blank" rel="noopener noreferrer">開啟網站 ↗</a></div></section>'}).join('');const shared=document.querySelector('#shared-japan-status');if(shared)shared.textContent=!j.enabled?'監控已停止':j.scanning?'正在掃描':active.length+' 個網站獨立運作｜平時 '+(j.intervalSeconds||30)+' 秒｜Discord '+(j.notificationReady?'正常':'未設定');}
function renderAmazonJp(s){
  const a=s.japanAuctions&&s.japanAuctions.amazonJp||{},v=a.inventory||{};
  if(!amazonJpDirty){document.querySelector('#amazon-jp-enabled').checked=a.enabled!==false;document.querySelector('#amazon-jp-postal-code').value=a.postalCode||'100-0001';}
  const error=[a.lastError,a.lastBackgroundError,a.lastSearchWarning].filter(Boolean).join('｜'),state=document.querySelector('#amazon-jp-state');
  state.textContent=a.enabled===false?'目前停止':a.backoffUntil||v.backoffUntil?'限流降速中':a.continuousInventory?'全庫持續輪查中':'監控中';
  state.className='pill '+(error?'bad':a.enabled!==false?'ok':'');
  const parts=['新品搜尋 '+(a.effectiveIntervalSeconds||20)+' 秒','商品庫 '+(v.trackedCount||0)+' 件','AOD 逐筆連續輪查'];
  if(v.currentCycle)parts.push('本輪 '+v.currentCycle.checked+'/'+v.currentCycle.total+' 件');
  if(v.lastCycle)parts.push('上輪實查 '+v.lastCycle.checked+' 件／'+(v.lastCycle.durationMs/1000).toFixed(1)+' 秒');
  if(v.neverVerified)parts.push('待首次驗證 '+v.neverVerified+' 件');
  if(v.failedCount)parts.push('最近失敗 '+v.failedCount+' 件');
  if(v.restrictedCount)parts.push('最近受限 '+v.restrictedCount+' 件');
  if(v.deferredCount)parts.push('個別暫緩 '+v.deferredCount+' 件');
  if(v.delegatedCount)parts.push('單品分擔 '+v.delegatedCount+' 件');
  if(v.oldestOfferAgeSeconds!==null&&v.oldestOfferAgeSeconds!==undefined)parts.push('最舊驗證 '+v.oldestOfferAgeSeconds+' 秒前');
  parts.push('累計通知 '+(a.notificationSentCount||0)+' 則');
  if(a.lastScanAt)parts.push('搜尋最近 '+fmt(a.lastScanAt));
  if(a.backoffUntil||v.backoffUntil)parts.push('降速至 '+fmt(a.backoffUntil||v.backoffUntil));else if(a.nextScanAt)parts.push('下次搜尋 '+fmt(a.nextScanAt));
  document.querySelector('#amazon-jp-summary').textContent=parts.join('｜');
  document.querySelector('#amazon-jp-error').textContent=error;
  const inventoryNode=document.querySelector('#amazon-jp-inventory-products');
  inventoryNode.innerHTML=(a.inventoryProducts||[]).map(item=>{
    const failed=item.attempt&&item.attempt.status==='failed',restricted=item.attempt&&item.attempt.status==='restricted';
    const status=restricted?'限流暫緩（保留前值）':failed?'讀取失敗（保留前值）':item.available===true?'最近可購':item.available===false?'最近無合格報價':'待 AOD 驗證';
    const price=item.priceYen?'｜¥'+Number(item.priceYen).toLocaleString('en-US'):'';
    return '<div class="product-row"><div class="product-main"><div><a href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer"><strong>'+esc(item.code)+'｜'+esc(item.title)+'</strong></a><div class="product-meta">ASIN '+esc(item.asin)+'｜'+status+price+'</div><div class="product-meta">最近驗證 '+(item.lastOfferCheckedAt?fmt(item.lastOfferCheckedAt):'尚未')+(failed?'｜'+esc(item.attempt.errorCode)+'｜HTTP '+Number(item.attempt.httpStatus||0):'')+(item.attempt&&item.attempt.retryAt?'｜重試 '+fmt(item.attempt.retryAt):'')+(item.delegated?'｜單品分擔':'')+'</div></div></div></div>';
  }).join('')||'<p class="muted">等待收錄商品…</p>';
  document.querySelector('#amazon-jp-signals').innerHTML=(a.manualProducts||[]).map(item=>'<div class="product-row"><div class="product-main">'+(item.imageUrl?'<img class="product-thumb" src="'+esc(item.imageUrl)+'" alt="">':'')+'<div><a href="'+esc(item.productUrl||item.originalAmazonUrl)+'" target="_blank" rel="noopener noreferrer"><strong>'+(item.code?esc(item.code)+'｜':'')+esc(item.title||('ASIN '+item.asin))+'</strong></a><div class="product-meta">ASIN '+esc(item.asin)+'｜'+'AOD 自營核對｜不對照 TT 定價'+'</div><div class="product-meta">'+(item.source==='x_signal'?'來源 X 速報｜':'手動新增｜')+'已存入日亞單品資料庫｜仍需 Amazon.co.jp 賣家驗證</div></div></div><div class="japan-target-actions"><span class="pill">'+fmt(item.addedAt||item.updatedAt)+'</span><button class="danger small" data-asin="'+esc(item.asin)+'" onclick="deleteAmazonJpProduct(this.dataset.asin)">刪除</button></div></div>').join('');
}
function renderAmazonProductOrderLegacy(s){
  const a=s.japanAuctions&&s.japanAuctions.amazonJpProductOrder||{};
  const scanner=s.japanAuctions&&s.japanAuctions.amazonJp||{};
  if(!amazonProductOrderDirty){
    document.querySelector('#amazon-product-order-enabled').checked=Boolean(a.enabled);
    document.querySelector('#amazon-product-order-mode').value=a.mode==='hybrid'?'hybrid':'scan_signal';
    document.querySelector('#amazon-product-order-target-count').value=a.targetSuccessCount||1;
    document.querySelector('#amazon-product-order-url').value=a.targetUrl||'';
  }
  const labels={idle:'尚未啟用',ready:'登入已確認',waiting_signal:'等待日亞掃描命中',waiting_poll:'五秒雙線待命',queued:'已命中，準備驗證',purchase_limited:'帳號已達限購，降速等待',ordering:'正在結帳',needs_review:'送單狀態待人工確認',needs_login:'需要完成登入',completed:'本輪任務完成'};
  const state=document.querySelector('#amazon-product-order-state');
  const cooling=a.backoffUntil&&Date.parse(a.backoffUntil)>Date.now();
  state.textContent=a.running?(a.phase==='ordering'?'正在結帳（停止刷新）':a.phase==='inspecting'?'只讀檢查中（不下單）':a.mode==='hybrid'?'五秒巡檢中（尚未下單）':'補貨訊號驗證中'):a.interactive?'等待完成登入檢查':!a.enabled?'目前停止':cooling?'降速等待中':labels[a.status]||'目前停止';
  state.className='pill '+(a.enabled&&!a.lastError?'ok':a.lastError?'bad':'');
  const x=a.lastSnapshot||{};
  const reasons={qualified:'條件符合',product_mismatch:'商品與任務目標不符',purchase_limited:'帳號已達限購',seller_not_amazon:'未確認自營報價',above_msrp:'高於官方定價',non_jpy_price:'頁面不是日圓價格',price_missing:'未讀到價格',msrp_not_found:'尚無官方定價',not_purchasable:'目前無可用購買按鈕，等待補貨',page_not_found:'商品頁不存在或暫時不可讀',product_unreadable:'商品頁未完整載入',login_required:'需重新登入',rate_limited:'遇到流量限制或驗證頁'};
  const parts=[a.mode==='hybrid'?'每 5 秒掃描＋補貨訊號雙線':'補貨訊號觸發・不定時刷新','本輪成功 '+(a.completedCount||0)+'／'+(a.targetSuccessCount||1),'商品頁驗證 '+(a.refreshCount||0)+' 次'];
  if(a.nextAttemptAt)parts.push('下次檢查 '+fmt(a.nextAttemptAt));
  if(cooling)parts.push('降速至 '+fmt(a.backoffUntil));
  if(a.enabled&&scanner.enabled===false)parts.push(a.mode==='hybrid'?'日亞原價掃描已停止，目前只有五秒單線':'日亞原價掃描已停止，無法收到觸發');
  if(x.asin)parts.push('ASIN '+x.asin);
  if(x.title)parts.push(x.title);
  if(x.priceYen)parts.push('¥'+Number(x.priceYen).toLocaleString('ja-JP'));
  if(x.msrpYen)parts.push('定價 ¥'+Number(x.msrpYen).toLocaleString('ja-JP'));
  if(x.evaluation)parts.push(reasons[x.evaluation]||x.evaluation);
  if(a.lastSignalMatchedAt)parts.push('上次同 ASIN 命中 '+fmt(a.lastSignalMatchedAt));
  if(a.lastSignalF5LatencyMs!==undefined)parts.push('命中至商品頁啟動 '+a.lastSignalF5LatencyMs+'ms');
  if(a.lastCheckedAt)parts.push('最近驗證 '+fmt(a.lastCheckedAt));
  document.querySelector('#amazon-product-order-summary').textContent=parts.join('｜');
  document.querySelector('#amazon-product-order-error').textContent=a.lastError||'';
  const stepLabels={refresh_start:'開始刷新商品頁',product_evaluated:'商品條件檢查完成',buy_now_click:'點擊立即購買',add_cart_click:'點擊加入購物車',proceed_checkout:'前往結帳',checkout_inspect:'檢查結帳頁面',checkout_continue:'繼續結帳',submit_order:'送出訂單',submit_result:'確認送單結果',failure:'執行失敗'};
  const resultLabels={...reasons,ordered:'訂單成立',submitted_unconfirmed:'已送出，訂單結果待確認'};
  const steps=(a.stepLog||[]).slice(-20).reverse();
  document.querySelector('#amazon-product-order-steps').textContent=steps.length?steps.map(step=>{
    const result=step.result||step.status;
    return fmt(step.at)+'｜本輪經過 '+(step.elapsedMs||0)+' 毫秒｜'+(stepLabels[step.name]||step.name)+(step.step?'（第 '+step.step+' 步）':'')+(result?'｜'+(resultLabels[result]||result):'')+(step.error?'｜'+step.error:'');
  }).join('\\n'):'尚無紀錄';
  const history=a.orderHistory||{};
  document.querySelector('#amazon-product-history-path').textContent=(history.directory||'')+'｜共 '+(history.total||0)+' 筆';
  document.querySelector('#amazon-product-history-error').textContent=history.error||'';
  const historyLabels={ordered:'訂單成立',failed:'購買失敗',submitted_unconfirmed:'送單結果待確認',in_progress:'購買進行中',interrupted:'流程中斷，請核對訂單'};
  const ms=value=>value===null||value===undefined?'未記錄':(value/1000).toFixed(3)+' 秒';
  document.querySelector('#amazon-product-order-history').textContent=(history.recent||[]).slice(0,20).map(record=>{
    const t=record.timings||{};
    return [
      fmt(record.startedAt)+'｜'+(historyLabels[record.status]||record.status)+'｜'+(record.product?.code||record.product?.asin||'商品')+'｜'+(record.trigger==='poll'?'五秒輪詢':record.trigger==='scan_signal'?'補貨訊號':'其他觸發'),
      record.product?.title||'',
      '訂單編號：'+(record.orderId||'未取得')+'｜刷新至確認成立：'+ms(t.refreshToConfirmedMs),
      '訊號至刷新：'+ms(t.signalToRefreshMs)+'｜刷新至條件符合：'+ms(t.refreshToQualifiedMs),
      '符合至購買動作：'+ms(t.qualifiedToPurchaseMs)+'｜購買至送單動作：'+ms(t.purchaseToSubmitMs),
      '送單至確認成立：'+ms(t.submitToConfirmedMs)+'｜確認至 DC 送出：'+ms(t.confirmedToNotificationMs),
      record.error?'原因：'+record.error:'',
      record.notification?.status==='failed'?'DC 發送失敗：'+(record.notification.error||'未知錯誤'):'',
      ...(record.steps||[]).slice().reverse().map(step=>fmt(step.at)+'｜+'+(step.elapsedMs||0)+' 毫秒｜'+(stepLabels[step.name]||step.name)+(step.step?'（第 '+step.step+' 步）':'')+(step.result||step.status?'｜'+(resultLabels[step.result||step.status]||step.result||step.status):'')+(step.error?'｜'+step.error:'')),
      '紀錄檔：'+record.id+'.json'
    ].filter(Boolean).join('\\n');
  }).join('\\n\\n')||'尚無永久紀錄（啟用本功能前的耗時無法回補）';
}
function markAmazonProductOrderDirty(slot){amazonProductOrderDirty[slot]=true;}
async function pairAmazonRace(){const output=document.querySelector('#amazon-race-feedback');try{const r=await api('/amazon-race/pair',{slot:document.querySelector('#amazon-race-pair-slot').value});const input=document.querySelector('#amazon-race-token');input.value=r.token;input.hidden=false;output.textContent='將此碼貼到插件，選任務 '+r.slot+' 並確認登入帳號；配對碼不會寫入日誌。';}catch(error){output.textContent=error.message;}}
function toggleAmazonOrderDetails(control,slot){const row=document.querySelector('#amazon-product-order-detail-'+slot);if(row)row.hidden=!control.open;localStorage.setItem('beyblade-amazon-step-log-'+slot,control.open?'1':'0');}
function renderAmazonProductOrder(s){
  const orders=s.japanAuctions?.amazonJpProductOrders||[];
  const raceLabels={idle:'尚未執行',preparing:'結帳中',granted:'已授權送單',unknown:'待核對',ordered:'訂單成立',failed:'失敗',cancelled:'已取消'};
  const raceStatus=document.querySelector('#amazon-race-status');
  if(raceStatus)raceStatus.textContent=orders.map(a=>a.slot+'｜API：'+(a.race?.waveId?(raceLabels[a.race?.routes?.api?.state]||'原流程'):a.enabled?'原 API 運作中':'已停止')+'｜插件：'+(a.race?.connected?(raceLabels[a.race?.routes?.frontend?.state]||'已連線'):'尚未連線')+(a.race?.frontend?.error?'｜'+a.race.frontend.error:'')).join('　');
  const scanner=s.japanAuctions?.amazonJp||{};
  const container=document.querySelector('#amazon-product-order-slots');
  const logs=document.querySelector('#amazon-live-log-content');
  if(logs){const markup=['A','B','C'].map(slot=>{const a=orders.find(item=>item.slot===slot)||{};const rows=[...(a.purchaseSteps||[]).slice().reverse().map(step=>({...step,route:'API'})),...(a.race?.frontend?.steps||[]).slice().reverse().map(step=>({...step,route:'插件'}))];const text=rows.sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0)).slice(0,60).map(step=>step.step+'｜'+(step.at?new Date(step.at).toLocaleTimeString('zh-TW',{hour12:false})+'｜':'')+(a.race?.connected||a.race?.waveId?step.route+'｜':'')+step.page+'｜'+step.action+(step.orderId?' '+step.orderId:'')+'｜'+step.status).join('\\n');return'<section class="amazon-live-log-column"><header><strong>'+slot+'</strong><span>API '+Number(a.refreshCount||0)+(a.race?.connected?' · 插件 '+Number(a.race.frontend?.refreshCount||0):'')+' 次</span></header><pre id="amazon-live-log-'+slot+'">'+esc(text||'尚無 LOG')+'</pre></section>';}).join('');if(logs.amazonMarkup!==markup){logs.innerHTML=markup;logs.amazonMarkup=markup;}}
  const labels={idle:'尚未啟動',ready:'已就緒',waiting_signal:'等待補貨訊號',waiting_poll:'等待補貨',queued:'準備下單',ordering:'正在結帳',needs_review:'交易待核對',needs_login:'需要登入',needs_verification:'需要人工驗證',completed:'本輪完成',purchase_limited:'帳號限購'};
  const reasons={qualified:'符合購買條件',not_purchasable:'目前不可購',seller_not_amazon:'非日亞自營',above_msrp:'高於定價',login_required:'需要登入',verification_required:'需要人工驗證',purchase_limited:'帳號限購',price_missing:'價格待確認',product_unreadable:'頁面未完整載入'};
  if(!['A','B','C'].some(slot=>amazonProductOrderDirty[slot])){
    const tableMarkup='<table class="amazon-order-sheet"><caption>日亞自動下單任務</caption><colgroup><col class="amazon-task-col"><col><col class="amazon-state-col"><col class="amazon-progress-col"><col class="amazon-count-col"><col class="amazon-shipping-col"><col class="amazon-actions-col"></colgroup><thead><tr><th scope="col">任務</th><th scope="col">商品 <span class="muted">· 點品名編輯網址</span></th><th scope="col">狀態</th><th scope="col">成功／目標</th><th scope="col">目標次數</th><th scope="col">運費上限 ¥</th><th scope="col">操作</th></tr></thead>'+['A','B','C'].map(slot=>{
      const a=orders.find(item=>item.slot===slot)||{slot};
      const targetAsin=String(a.targetUrl||'').match(new RegExp('(?:dp|gp/product)/([A-Z0-9]{10})','i'))?.[1]?.toUpperCase()||'';
      const x=a.lastSnapshot?.asin===targetAsin?a.lastSnapshot:{};
      const product=a.targetProduct?.asin===targetAsin?a.targetProduct:{};
      const title=product.title||x.title||(scanner.manualProducts||[]).find(item=>item.asin===targetAsin)?.title||'品名待辨識，按「檢查」更新';
      const code=product.code||x.code||title.match(/(?:BX|UX|CX)[- ]?[0-9]+/i)?.[0]||'';
      const shortTitle=title.replace(/^タカラトミー[（(]TAKARA TOMY[）)]\\s*/i,'').replace(/^BEYBLADE X\\s*/i,'');
      const cooling=Date.parse(a.backoffUntil||'')>Date.now();
      const legacyHold=a.status==='needs_review'&&['adding','cart_ready','buy_now'].includes(a.apiTransactionStatus);
      const state=!a.enabled?(a.running?'停止中・等待本輪收尾':a.status==='needs_review'?'已停・交易待核對':'已停止'):a.running?(a.phase==='ordering'?'正在結帳':a.phase==='maintenance'?'待機整理':'檢查中'):a.interactive?'等待登入完成':legacyHold?'尚未送單，待核對':cooling?'降速等待':labels[a.status]||'待命';
      const decision=x.evaluation==='not_purchasable'&&x.diagnostic?.decision==='retail_contract_incomplete'?'自營加車欄位不完整，非判定售罄':reasons[x.evaluation]||x.evaluation;
      const cadence=a.mode==='hybrid'?(a.pollIntervalSeconds||5)+' 秒＋補貨訊號':'補貨訊號';
      const auxiliary=[a.checkoutStockWait?.active?(a.checkoutStockWait.suspended?'保留紅字頁・未執行刷新':'紅字頁等回流・250ms 循序重查'):null,({needs_login:'結帳需登入核對・商品監控持續',needs_verification:'結帳待人工驗證・商品監控持續'})[a.checkoutAccessIssue?.status],({needs_login:'背景查單需登入（獨立狀態）',needs_verification:'背景查單待驗證（獨立狀態）',unavailable:'背景查單暫不可用（獨立狀態）'})[a.orderHistoryCheck?.status],({needs_login:'待機清車需登入（獨立狀態）',needs_verification:'待機清車待驗證（獨立狀態）'})[a.idleCartMaintenance?.status]].filter(Boolean).join('｜');
      const open=localStorage.getItem('beyblade-amazon-step-log-'+slot)==='1';
      const changed=' oninput="markAmazonProductOrderDirty(&quot;'+slot+'&quot;)" onchange="saveAmazonProductOrderFields(&quot;'+slot+'&quot;)"';
      return '<tbody id="amazon-product-order-card-'+slot+'"><tr class="amazon-order-main"><th scope="row"><span class="amazon-slot">'+slot+'</span></th><td class="amazon-product-cell"><details class="amazon-product-disclosure" '+(open?'open':'')+' ontoggle="toggleAmazonOrderDetails(this,&quot;'+slot+'&quot;)"><summary title="'+esc(title)+'"><span class="amazon-product-line">'+(code?'<span class="amazon-product-code">'+esc(code)+'</span>':'')+'<strong id="amazon-product-order-'+slot+'-title">'+esc(shortTitle)+'</strong></span></summary></details></td>'
        +'<td><span title="'+esc(a.lastError||decision||'尚未檢查')+'" class="pill '+(a.lastError?'bad':a.enabled?'ok':'')+'">'+esc(!a.enabled&&!a.running&&!a.interactive&&!legacyHold?'已停止':state)+'</span></td>'
        +'<td class="amazon-numeric">'+Number(a.completedCount||0)+' <span class="muted">/ '+Number(a.targetSuccessCount||1)+'</span></td><td><input aria-label="任務 '+slot+' 成功次數" id="amazon-product-order-'+slot+'-target-count" type="number" min="1" max="99" value="'+(a.targetSuccessCount||1)+'"'+changed+'></td><td><input aria-label="任務 '+slot+' 運費上限" id="amazon-product-order-'+slot+'-max-shipping" type="number" min="0" max="10000" value="'+Number(a.maxShippingYen??500)+'"'+changed+'></td>'
        +'<td><div class="amazon-order-actions"><label><input id="amazon-product-order-'+slot+'-enabled" type="checkbox" '+(a.enabled?'checked':'')+' onchange="toggleAmazonProductOrder(this,&quot;'+slot+'&quot;)"> 啟動</label><button type="button" class="secondary" aria-label="開啟任務 '+slot+' 專用視窗" title="開啟此任務的專用登入／驗證視窗，不送單" onclick="openAmazonProductOrder(&quot;'+slot+'&quot;)">開啟</button><button type="button" class="secondary" onclick="checkAmazonProductOrder(&quot;'+slot+'&quot;)">檢查</button><button type="button" class="secondary" onclick="resetAmazonProductOrderProgress(&quot;'+slot+'&quot;)">重設</button></div><span class="amazon-visually-hidden" id="amazon-product-order-'+slot+'-result" role="status">'+esc(typeof amazonProductOrderMessages==='undefined'?'':amazonProductOrderMessages[slot]||'')+'</span></td></tr>'
        +'<tr id="amazon-product-order-detail-'+slot+'" class="amazon-order-detail-row" '+(open?'':'hidden')+'><td colspan="7"><div class="amazon-order-drawer"><div class="amazon-detail-meta">'+esc(targetAsin||'尚未設定商品')+' · '+esc((a.checkoutTransport==='browser'?'網頁':'API')+'｜'+cadence)+' · 檢查 '+Number(a.refreshCount||0)+' 次'+(Number.isFinite(x.diagnostic?.quoteMs)?' · 報價 '+x.diagnostic.quoteMs+'ms':'')+' · '+esc(decision||'尚未檢查')+'</div><label class="amazon-url-field">商品網址<input aria-label="任務 '+slot+' 商品網址" id="amazon-product-order-'+slot+'-url" type="url" value="'+esc(a.targetUrl||'')+'" placeholder="貼上日亞商品網址" required'+changed+'></label>'+(auxiliary?'<p class="muted amazon-auxiliary-status">'+esc(auxiliary)+'</p>':'')+(a.lastError?'<p class="bad">'+esc(a.lastError)+'</p>':'')+'</div></td></tr></tbody>';
    }).join('')+'</table><p id="amazon-product-order-feedback" class="amazon-order-feedback" role="status">'+esc((typeof amazonLiveLogMessage==='undefined'?'':amazonLiveLogMessage)||(typeof amazonProductOrderMessages==='undefined'?'':Object.entries(amazonProductOrderMessages).filter(([,value])=>value).map(([slot,value])=>slot+'｜'+value).join('　')))+'</p><p class="muted amazon-order-help">修改設定會儲存並停止該任務，勾選啟動才開始。檢查不送單；重設只歸零進度，保留購物車及訂單。</p>';
    if(container.amazonMarkup!==tableMarkup){container.innerHTML=tableMarkup;container.amazonMarkup=tableMarkup;}
  }
  const history=orders.find(item=>item.orderHistory)?.orderHistory||{};
  document.querySelector('#amazon-product-history-path').textContent=(history.directory||'')+'｜共 '+(history.total||0)+' 筆';
  document.querySelector('#amazon-product-history-error').textContent=history.error||'';
  const evidenceLinks=document.querySelector('#amazon-product-order-evidence-links');
  if(evidenceLinks)evidenceLinks.innerHTML=(history.recent||[]).filter(record=>record.evidence?.length).map(record=>'<div><strong>'+esc('任務 '+record.slot+' · '+(record.product?.code||record.product?.asin||'商品'))+'</strong> '+record.evidence.map(item=>{const base='/amazon-product-order/evidence/'+encodeURIComponent(record.id)+'/'+encodeURIComponent(item.id);const label={entry:'02 入口',response:'02 官方回應',failure:'02 失敗'}[item.kind]||'02 快照';return item.status==='saved'?'<a href="'+base+'.png" target="_blank" rel="noopener noreferrer">'+esc(label)+'</a> <a href="'+base+'.json" target="_blank" rel="noopener noreferrer">原因／HTTP</a>':esc(label+'：'+(item.status==='failed'?'截圖未完成 '+(item.captureError||''):'保存中'));}).join(' · ')+'</div>').join('');
  document.querySelector('#amazon-product-order-history').textContent=(history.recent||[]).slice(0,20).map(record=>['任務 '+(record.slot||'A')+'｜'+(record.route==='frontend'?'插件｜':record.route==='api'?'API｜':'')+(record.product?.title||record.product?.asin||'商品')+'｜'+({ordered:'訂單成立',failed:'失敗',submitted_unconfirmed:'待核對',interrupted:'中斷待核對',in_progress:'進行中'}[record.status]||record.status),...(record.steps||[]).filter(step=>step.page).map(step=>step.step+'｜'+(step.at?new Date(step.at).toLocaleTimeString('zh-TW',{hour12:false})+'｜':'')+step.page+'｜'+step.action+(step.orderId?' '+step.orderId:'')+'｜'+step.status)].join('\\n')).join('\\n\\n')||'尚無永久紀錄';
}
function renderFacebookStatus(s){
    const activity=s.monitoringEnabled?(s.withinActiveHours?'FB 主監控已啟動':'主監控休息時段'):'FB 主監控已停止';
    document.querySelector('#summary').innerHTML='<span class="pill '+(s.monitoringEnabled?'ok':'bad')+'">'+activity+'</span><span class="pill">'+(s.scanning?'掃描中':'待命中')+'</span><span class="pill">常態模式 '+s.activeHours.start+'～'+s.activeHours.end+'</span><span class="pill">每 '+s.interval+' 分鐘</span><span class="pill">'+s.pageCount+' 個監控中</span>'+(s.pausedPageCount?'<span class="pill">'+s.pausedPageCount+' 個暫停</span>':'')+'<span class="pill '+(s.notificationReady?'ok':'bad')+'">'+(s.notificationChannel||'通知')+' '+(s.notificationReady?'已設定':'未設定')+'</span><span class="pill">'+browserLabel(s.browserMode)+'</span>';
    const x=s.lastScan;
    const relevantNames=x&&x.relevantPages&&x.relevantPages.length?'｜命中粉專：'+x.relevantPages.map(page=>page.name+'（'+page.count+' 篇）').join('、'):'';
    let lastText=x?'上次完成：'+fmt(x.completedAt)+'｜檢查 '+x.checked+' 篇｜重要情報 '+x.relevant+' 篇'+relevantNames+'｜通知 '+x.notified+' 則':'尚未完成常態掃描。';
    if(s.nextScanAt)lastText+='｜下次：'+fmt(s.nextScanAt);
    document.querySelector('#last').textContent=lastText;
    document.querySelector('#error').textContent=s.lastError&&String(s.lastError).startsWith('Funbox 官網：')?'':s.lastError||'';
    if(s.logs)document.querySelector('#logs').textContent=s.logs.join('\\n')||'尚無紀錄';
    const monitorButton=document.querySelector('#monitor-button');
    monitorButton.textContent=s.monitoringEnabled?'停止 FB 主監控':'啟動 FB 主監控';
    monitorButton.className=s.monitoringEnabled?'danger':'good';
    if(!settingsDirty){document.querySelector('#interval-input').value=s.interval;document.querySelector('#active-start').value=s.activeHours.start;document.querySelector('#active-end').value=s.activeHours.end;}
    renderPages(s.pages,s.hotspot);renderHotspot(s);renderAI(s);renderKeywords(s.productKeywords,s.salesKeywords);renderRegularState(s);
}
function logsVisible(){return [...document.querySelectorAll('#tab-'+activeTab+' pre')].some(el=>el.getClientRects().length>0);}
function renderJapanHealth(s){
  const j=s.japanAuctions||{};
  const targets=j.targets||[];
  const needsVerification=target=>target.lastErrorCode==='verification_required'||/Cloudflare|流量驗證|人機驗證/.test(target.lastError||'');
  const blocked=targets.filter(target=>target.enabled!==false&&needsVerification(target));
  if(j.enabled&&j.withinActiveHours&&blocked.length){
    const state=document.querySelector('#japan-state');
    state.textContent=blocked.length+' 個網站受驗證阻擋，其餘獨立監控';
    state.className='pill bad';
  }
  document.querySelectorAll('#japan-target-list .japan-target-card').forEach((card,index)=>{
    const target=targets[index];
    if(!target)return;
    const facts=card.querySelectorAll('.shopping-target-fact');
    if(facts[0]&&target.enabled===false)facts[0].textContent='已暫停，不掃描';
    else if(facts[0]&&needsVerification(target))facts[0].textContent=(target.sourceType==='edion'?'受限・背景等待':'需人工驗證')+(target.nextScanAt?'｜降速重試 '+fmt(target.nextScanAt):'');
    if(facts[1])facts[1].textContent=needsVerification(target)
      ? (target.baselineProductCount||0)+' 件保留基線（舊資料）｜本輪被驗證阻擋，無法確認庫存'
      : facts[1].textContent.replace('本輪讀取','上次成功讀取');
    if(target.sourceType==='rakuten-item'&&target.singleProduct&&facts[1]){
      const item=target.singleProduct;
      facts[1].textContent=(target.lastError?'上次成功資料（本輪未確認）｜':'')+(item.available===true?'可購買':item.available===false?'售罄／不可購買':'狀態未確認')+'｜'+(item.price||'價格未確認')+'｜庫存 '+item.stock;
    }
    const checked=document.createElement('p');
    checked.className='compact-copy japan-target-health-details';
    checked.textContent=(needsVerification(target)?'上次完成紀錄：':'最近成功：')+fmt(target.lastScanAt)+'｜最近嘗試：'+fmt(target.lastAttemptAt);
    card.insertBefore(checked,card.querySelector('.japan-target-actions'));
  });
}
function renderEdionBrowser(s){
  if(!document.querySelector('#edion-browser-state')){
    const panel=document.createElement('details');panel.className='card fold';panel.open=true;
    panel.innerHTML='<summary>愛電王・普通 Chrome 連接器 <span id="edion-browser-state" class="pill">待連接</span></summary>'
      +'<p class="compact-copy">背景 GET 官方商品 HTML，不重整或切換你的網頁。受限自動等待 15／30／60 分鐘重查，不跳視窗、不要求你按確認。Cookie 不離開 Chrome；受限期間可能漏掉補貨。</p>'
      +'<p class="compact-copy">一次性安裝：Chrome 輸入 chrome://extensions → 開發人員模式 → 載入未封裝項目 → 選擇下方資料夾。</p><code id="edion-browser-directory"></code>'
      +'<p class="compact-copy">專案已改名為 beyblade-watcher；若擴充功能不見或出現載入錯誤，請重新載入下方新路徑，勿再選 facebook-beyblade-watcher。這不會解除官網的人機驗證。</p>'
      +'<button class="secondary small" type="button" onclick="copyEdionDirectory()">複製連接器資料夾路徑</button>'
      +'<div class="row" style="margin-top:12px"><button class="secondary small" onclick="pairEdionBrowser()">產生／複製配對碼</button></div>'
      +'<p class="compact-copy">既有連接器需更新至 1.1.0。完成一次配對後保持 Chrome 開啟即可；只有本次新讀取的完整商品資料才更新庫存。</p>'
      +'<p id="edion-browser-message" class="notice muted"></p><input id="edion-browser-token" type="password" readonly hidden aria-label="愛電王本機配對碼">';
    document.querySelector('#tab-japan .page-title').after(panel);
  }
  const j=s.japanAuctions||{};const bridge=j.edionBrowser||{};
  const bridgeState=document.querySelector('#edion-browser-state');
  bridgeState.textContent=!bridge.enabled?'隨監控暫停':bridge.connected?bridge.protocol===2?'背景連接正常':'等待連接器更新':'等待 Chrome 背景連接';
  bridgeState.className='pill '+(bridge.connected?'ok':'');
  document.querySelector('#edion-browser-directory').textContent=bridge.extensionDirectory||'';
  document.querySelectorAll('#japan-target-list .japan-target-card').forEach((card,index)=>{
    const target=(j.targets||[])[index];if(!target?.chromeBridge)return;
    const health=target.chromeBridge;const facts=card.querySelectorAll('.shopping-target-fact');
    const labels={paused:'隨監控暫停',disconnected:'待背景連接',waiting:'等待新版背景連接器',ready:'背景資料讀取正常',auto_wait:'受限／讀取未完成・自動等待',stale:'資料未更新',verification_required:'受限・背景等待',unreadable:'讀取未完成・自動重查'};
    if(facts[0])facts[0].textContent=(labels[health.state]||'等待背景讀取')+'｜下次 '+fmt(health.nextReloadAt);
    if(facts[1]&&health.state!=='ready')facts[1].textContent=(target.baselineProductCount||0)+' 件舊基線｜當前庫存未確認';
    const checked=card.querySelector('.japan-target-health-details');
    if(checked)checked.textContent='最新資料：'+fmt(health.lastDataAt)+'｜最近背景嘗試：'+fmt(health.lastFetchAttemptAt);
  });
}
async function copyEdionDirectory(){
  const directory=document.querySelector('#edion-browser-directory').textContent,message=document.querySelector('#edion-browser-message');
  try{await navigator.clipboard.writeText(directory);message.textContent='資料夾路徑已複製；請到 Chrome 擴充功能頁載入未封裝項目。';}
  catch{message.textContent='請手動複製上方資料夾路徑。';}
}
async function pairEdionBrowser(){
  const message=document.querySelector('#edion-browser-message');
  try{
    const result=await api('/edion-browser/pair',{});
    const input=document.querySelector('#edion-browser-token');input.value=result.token;
    try{await navigator.clipboard.writeText(result.token);message.textContent='配對碼已複製；請貼到 Chrome 愛電王連接器。重新產生會撤銷舊配對。';input.hidden=true;}
    catch{input.hidden=false;input.type='text';input.select();message.textContent='無法自動複製，請複製下方本機配對碼；不要分享給他人。';}
  }catch(error){message.textContent=error.message;}
}
function renderActiveStatus(s){
  if(activeTab==='overview')renderOverview(s);
  else if(activeTab==='fb')renderFacebookStatus(s);
  else if(activeTab==='funbox'){renderFunbox(s);renderFunboxSandbox(s);renderAutoPurchase(s);}
  else if(activeTab==='shopping'){renderShopping(s);renderAutoPurchase(s);}
  else if(activeTab==='japan'){renderJapan(s);renderJapanHealth(s);renderEdionBrowser(s);renderAmazonJp(s);renderAmazonProductOrder(s);}
  else if(activeTab==='shared'){renderNotifications(s);renderSharedStatus(s);renderAutoPurchase(s);renderSelfCheck(s.lastSelfCheck);if(!memoDirty)document.querySelector('#memo').value=s.note||'';document.querySelector('#shared-japan-status').textContent=s.japanAuctions?.enabled?'監控已啟用':'已暫停';}
  if(logsVisible()){
    const ids={logs:'logs',regularLogs:'regular-logs',hotspotLogs:'hotspot-logs',funboxLogs:'funbox-logs',japanLogs:'japan-logs'};
    for(const [key,id] of Object.entries(ids)){const el=document.getElementById(id);if(s[key]&&el?.getClientRects().length)el.textContent=s[key].join('\\n')||'尚無紀錄';}
    if(activeTab==='shopping'){const grouped=s.shoppingSiteLogs||{};document.querySelector('#shopping-logs').textContent=Object.entries(grouped).filter(([key])=>key!=='FUNBOX官網'&&key!=='MM小舖-已停用').map(([key,lines])=>'【'+key+'】\\n'+lines.join('\\n')).join('\\n\\n')||'尚無紀錄';}
  }
}
async function refresh(){
  if(document.hidden)return;
  if(refreshPromise){refreshAgain=true;return refreshPromise;}
  const view=activeTab;
  refreshPromise=(async()=>{
    try{
      const response=await fetch('/api/status?view='+view+'&logs='+(logsVisible()?'1':'0'),{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const s=await response.json();
      if(view!==activeTab){refreshAgain=true;return;}
      currentStatus={...(currentStatus||{}),...s};
      if(view==='shopping')await refreshEsliteDisplayIdentities();
      renderActiveStatus(currentStatus);
      void refreshPurchaseOrderStatuses(view==='funbox'?'funbox':view==='shopping'?'eslite':'',false);
      const connection=document.querySelector('#dashboard-connection');connection.textContent='● 控制台已連線 · '+new Date().toLocaleTimeString('zh-TW');connection.className='ok';
      if(activeTab==='fb'&&!profileLoaded)await refreshSavedProfile();
    }catch(error){const connection=document.querySelector('#dashboard-connection');connection.textContent='控制台連線異常：'+error.message;connection.className='bad';}
  })().finally(()=>{refreshPromise=null;if(refreshAgain){refreshAgain=false;void refresh();}});
  return refreshPromise;
}
const purchaseStatusChecks={};
async function refreshPurchaseOrderStatuses(platform,force=false){
  if(!['funbox','eslite'].includes(platform)||document.hidden)return;
  const entry=purchaseStatusChecks[platform]||(purchaseStatusChecks[platform]={at:0,pending:false});
  if(entry.pending||!force&&Date.now()-entry.at<60000)return;
  const purchase=currentStatus?.autoPurchase;
  if(!force&&(!purchase||purchase.processing||purchase.queued))return;
  entry.at=Date.now();entry.pending=true;
  try{
    const response=await fetch('/auto-purchase/order-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform,force}),signal:AbortSignal.timeout(30000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'查單失敗');
    if(force){const node=document.querySelector(platform==='funbox'?'#funbox-result':'#shopping-result');if(node)node.textContent=result.message;}
    if(result.checked||result.failed)await refresh();
  }catch(error){if(force){const node=document.querySelector(platform==='funbox'?'#funbox-result':'#shopping-result');if(node)node.textContent=error.message;}}
  finally{entry.pending=false;}
}
async function refreshEsliteExhibitionProbe(){
  if(esliteExhibitionProbePromise)return esliteExhibitionProbePromise;
  const state=document.querySelector('#eslite-exhibition-state');
  if(state){state.textContent='正在確認';state.className='pill';}
  esliteExhibitionProbePromise=(async()=>{
    try{
      const response=await fetch('/api/eslite-exhibition-status',{cache:'no-store',signal:AbortSignal.timeout(20000)});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
      esliteExhibitionProbe=data;
    }catch(error){
      esliteExhibitionProbe={status:'error',checkedAt:new Date().toISOString(),error:error.message};
    }
    if(activeTab==='shopping'&&currentStatus)renderShopping(currentStatus);
    return esliteExhibitionProbe;
  })().finally(()=>{esliteExhibitionProbePromise=null;});
  return esliteExhibitionProbePromise;
}
async function run(label,fn){const resultId=activeTab==='funbox'?'#funbox-result':activeTab==='shopping'?'#shopping-result':activeTab==='japan'?'#japan-result':activeTab==='shared'?'#shared-result':'#result';const result=document.querySelector(resultId);result.textContent=label;let data=null;try{data=await fn();result.textContent=data.message||'完成';}catch(error){result.textContent=error.message;}await refresh();return data;}
async function action(path){await run('執行中…',()=>api(path));}
function setNotificationTestProgress(percent,text,status=''){const progress=document.querySelector('.notification-progress');const bar=document.querySelector('#notification-test-progress-bar');progress.setAttribute('aria-valuenow',String(percent));bar.style.width=percent+'%';bar.className='notification-progress-bar '+status;document.querySelector('#notification-test-progress-text').textContent=text;}
async function testNotification(channel){const state=document.querySelector('#test-notification-state');const detail=document.querySelector('#test-notification-detail');const link=document.querySelector('#test-notification-link');const buttons=['#test-discord-public-button','#test-discord-private-button','#test-line-button'].map(id=>document.querySelector(id));buttons.forEach(button=>button.disabled=true);link.hidden=true;link.removeAttribute('href');const platform=channel==='line'?'LINE':channel==='discord-private'?'私人 Discord':'公開 Discord';state.textContent='正在準備 '+platform+' 測試通知…';detail.textContent='等待 '+platform+' 平台回覆。';setNotificationTestProgress(18,'準備中','running');await new Promise(resolve=>setTimeout(resolve,180));setNotificationTestProgress(52,'傳送中','running');try{const data=await api('/test-notification',{channel});setNotificationTestProgress(100,'平台已接受','success');state.textContent='✅ '+data.message;const destination=data.destination||{};if(channel!=='line'){detail.textContent='Webhook：'+(destination.name||'未命名')+'｜用途：'+(destination.audience==='private'?'私人管理':'公開情報')+'｜伺服器 ID：'+(destination.guildId||'未知')+'｜頻道 ID：'+(destination.channelId||'未知')+'｜訊息 ID：'+(data.messageId||'未回傳');if(data.messageUrl){link.href=data.messageUrl;link.hidden=false;}}else{detail.textContent='Bot：'+(destination.displayName||'未命名')+(destination.basicId?'（'+destination.basicId+'）':'')+'｜LINE Request ID：'+(data.messageId||'未回傳')+'。若手機仍未收到，請確認已將這個 Bot 加為好友。';}}catch(error){setNotificationTestProgress(100,'傳送失敗','fail');state.textContent='❌ '+platform+' 測試失敗';detail.textContent=error.message;}finally{buttons.forEach(button=>button.disabled=false);}}
function setSimulationNotificationProgress(percent,text,status=''){const progress=document.querySelector('#simulation-notification-progress');const bar=document.querySelector('#simulation-notification-progress-bar');progress.setAttribute('aria-valuenow',String(percent));bar.style.width=percent+'%';bar.className='notification-progress-bar '+status;document.querySelector('#simulation-notification-progress-text').textContent=text;}
function toggleFunboxSimulationFields(){const type=document.querySelector('#simulation-notification-type').value;document.querySelector('#simulation-funbox-custom').hidden=type!=='funbox';}
async function testSimulatedNotification(){const type=document.querySelector('#simulation-notification-type').value;const audience=document.querySelector('#simulation-notification-audience').value;const button=document.querySelector('#simulation-notification-button');const state=document.querySelector('#simulation-notification-state');const detail=document.querySelector('#simulation-notification-detail');const link=document.querySelector('#simulation-notification-link');const body={type,audience};if(type==='funbox')body.funbox={title:document.querySelector('#simulation-funbox-title').value,price:document.querySelector('#simulation-funbox-price').value,stock:document.querySelector('#simulation-funbox-stock').value,targetUrl:document.querySelector('#simulation-funbox-target-url').value,imageUrl:document.querySelector('#simulation-funbox-image-url').value};button.disabled=true;link.hidden=true;link.removeAttribute('href');state.textContent='正在建立模擬補貨通知…';detail.textContent='等待 Discord 平台回覆。';setSimulationNotificationProgress(20,'準備真實樣式','running');await new Promise(resolve=>setTimeout(resolve,160));setSimulationNotificationProgress(55,'推送中','running');try{const data=await api('/test-simulated-notification',body);setSimulationNotificationProgress(100,'Discord 已接受','success');state.textContent='✅ '+data.message;const destination=data.destination||{};const route=data.routedAudience==='private'?'私人管理':data.routedAudience==='mmtoy'?'M.M小舖獨立公開':'一般公開情報';detail.textContent='實際分流：'+route+'｜Webhook：'+(destination.name||'未命名')+'｜頻道 ID：'+(destination.channelId||'未知')+'｜訊息 ID：'+(data.messageId||'未回傳');if(data.messageUrl){link.href=data.messageUrl;link.hidden=false;}}catch(error){setSimulationNotificationProgress(100,'傳送失敗','fail');state.textContent='❌ 模擬通知失敗';detail.textContent=error.message;}finally{button.disabled=false;}}
async function runSelfCheck(){selfCheckExpanded=true;await action('/self-check');toggleSelfCheck(true);}
async function toggleMonitoring(){const path=currentStatus&&currentStatus.monitoringEnabled?'/monitor/stop':'/monitor/start';await run('更新監控狀態…',()=>api(path));}
async function toggleFunboxMonitoring(){const enabled=currentStatus&&currentStatus.funbox&&currentStatus.funbox.enabled;await run('更新官網監控狀態…',()=>api(enabled?'/funbox/stop':'/funbox/start'));}
async function toggleShoppingMonitoring(){const enabled=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.enabled;await run('更新購物網站監控狀態…',()=>api(enabled?'/shopping/stop':'/shopping/start'));}
async function toggleJapanMonitoring(){const enabled=currentStatus&&currentStatus.japanAuctions&&currentStatus.japanAuctions.enabled;await run('更新日本拍賣監控狀態…',()=>api(enabled?'/japan/stop':'/japan/start'));}
async function setJapanTargetEnabled(index,enabled){const target=currentStatus&&currentStatus.japanAuctions&&currentStatus.japanAuctions.targets[index];if(!target)return;await run(enabled?'恢復日本網站監控…':'暫停日本網站…',()=>api('/japan/targets/enabled',{id:target.id,enabled}));}
async function deleteJapanTarget(index){const target=currentStatus&&currentStatus.japanAuctions&&currentStatus.japanAuctions.targets[index];if(!target||!confirm('確定刪除「'+target.siteName+'｜'+target.name+'」？'))return;await run('刪除日本網站…',()=>api('/japan/targets/delete',{id:target.id}));}
async function testJapanNotification(){await run('正在傳送 1999 UX-15 測試通知…',()=>api('/test-japan-notification'));}
async function saveAmazonJpSettings(event){event.preventDefault();const saved=await run('正在儲存日亞自營 AOD 設定…',()=>api('/japan/amazon/settings',{enabled:document.querySelector('#amazon-jp-enabled').checked,postalCode:document.querySelector('#amazon-jp-postal-code').value}));if(saved){amazonJpDirty=false;await refresh();}}
async function scanAmazonJp(){await run('正在核對 TAKARA TOMY 定價、日亞品牌頁與 Amazon.co.jp 賣家…',()=>api('/japan/amazon/scan'));}
function toggleAmazonJpTestFields(){document.querySelector('#amazon-jp-test-custom').hidden=document.querySelector('input[name="amazon-jp-test-choice"]:checked')?.value!=='custom';}
async function testAmazonJpNotification(event){event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');const result=document.querySelector('#amazon-jp-test-result');const choice=document.querySelector('input[name="amazon-jp-test-choice"]:checked')?.value;const body={choice};if(choice==='custom'){body.url=document.querySelector('#amazon-jp-test-url').value.trim();body.title=document.querySelector('#amazon-jp-test-title').value.trim();body.code=document.querySelector('#amazon-jp-test-code').value.trim();body.msrpYen=document.querySelector('#amazon-jp-test-msrp').value;body.priceYen=document.querySelector('#amazon-jp-test-price').value;}button.disabled=true;result.className='notice muted';result.textContent='正在推送測試通知…';try{const sent=await api('/japan/amazon/test',body);result.className='notice ok';result.textContent=sent.message||'測試通知已送出。';}catch(error){result.className='notice bad';result.textContent=error.message;}finally{button.disabled=false;}}
function amazonProductOrderSettings(slot){const saved=(currentStatus?.japanAuctions?.amazonJpProductOrders||[]).find(item=>item.slot===slot)||{};return{slot,enabled:document.querySelector('#amazon-product-order-'+slot+'-enabled').checked,mode:document.querySelector('#amazon-product-order-'+slot+'-mode')?.value||saved.mode||'hybrid',targetSuccessCount:Number(document.querySelector('#amazon-product-order-'+slot+'-target-count').value),targetUrl:document.querySelector('#amazon-product-order-'+slot+'-url').value,maxShippingYen:Number(document.querySelector('#amazon-product-order-'+slot+'-max-shipping').value),fastLane:saved.fastLane??true};}
const amazonProductOrderBusy={},amazonProductOrderMessages={};
let amazonLiveLogClearing=false,amazonLiveLogMessage='';
async function clearAmazonProductOrderLogs(){if(amazonLiveLogClearing)return;amazonLiveLogClearing=true;const button=document.querySelector('#amazon-product-order-clear-log');button.disabled=true;try{const result=await api('/japan/amazon-product-order/clear-log',{});amazonLiveLogMessage=result.message;await refresh();document.querySelector('#amazon-product-order-feedback').textContent=amazonLiveLogMessage;}catch(error){amazonLiveLogMessage=error.message;document.querySelector('#amazon-product-order-feedback').textContent=amazonLiveLogMessage;}finally{amazonLiveLogClearing=false;document.querySelector('#amazon-product-order-clear-log').disabled=false;}}
async function amazonProductOrderAction(slot,work){
  if(amazonProductOrderBusy[slot])return;
  amazonLiveLogMessage='';
  const wasDirty=Boolean(amazonProductOrderDirty[slot]);
  amazonProductOrderBusy[slot]=true;amazonProductOrderDirty[slot]=true;
  document.querySelector('#amazon-product-order-card-'+slot).querySelectorAll('button,input').forEach(el=>el.disabled=true);
  document.querySelector('#amazon-product-order-'+slot+'-result').textContent='處理中…';
  const feedback=document.querySelector('#amazon-product-order-feedback');if(feedback)feedback.textContent=slot+'｜處理中…';
  let success=false,message;
  try{message=(await work()).message||'完成';success=true;amazonProductOrderDirty[slot]=false;await refresh();}
  catch(error){message=error.message;}
  finally{
    amazonProductOrderMessages[slot]=message;amazonProductOrderBusy[slot]=false;amazonProductOrderDirty[slot]=success?false:wasDirty;
    document.querySelector('#amazon-product-order-card-'+slot).querySelectorAll('button,input').forEach(el=>el.disabled=false);
    document.querySelector('#amazon-product-order-'+slot+'-result').textContent=message;
    const feedback=document.querySelector('#amazon-product-order-feedback');if(feedback)feedback.textContent=slot+'｜'+message;
  }
}
async function toggleAmazonProductOrder(control,slot){
  const payload=control.checked?amazonProductOrderSettings(slot):{slot,enabled:false,stopOnly:true},previous=!control.checked;
  await amazonProductOrderAction(slot,async()=>{try{return await api('/japan/amazon-product-order/settings',payload);}catch(error){control.checked=previous;throw error;}});
}
async function saveAmazonProductOrderFields(slot){
  const card=document.querySelector('#amazon-product-order-card-'+slot);
  for(const input of card.querySelectorAll('input'))if(!input.reportValidity())return;
  const payload={...amazonProductOrderSettings(slot),enabled:false};
  await amazonProductOrderAction(slot,async()=>{await api('/japan/amazon-product-order/settings',payload);return{message:'設定已儲存；勾選「啟動」開始。'};});
}
async function openAmazonProductOrder(slot){
  if(amazonProductOrderDirty[slot]){document.querySelector('#amazon-product-order-'+slot+'-result').textContent='欄位尚未儲存成功，請先修正設定；本次未開啟視窗。';return;}
  await amazonProductOrderAction(slot,()=>api('/japan/amazon-product-order/login/open',{slot}));
}
async function checkAmazonProductOrder(slot){
  if(amazonProductOrderDirty[slot]){document.querySelector('#amazon-product-order-'+slot+'-result').textContent='欄位尚未儲存成功，請先修正設定；本次未檢查或送單。';return;}
  await amazonProductOrderAction(slot,()=>api('/japan/amazon-product-order/scan',{slot,check:true}));
}
async function resetAmazonProductOrderProgress(slot){
  const payload={...amazonProductOrderSettings(slot),enabled:false,resetProgress:true};
  await amazonProductOrderAction(slot,()=>api('/japan/amazon-product-order/settings',payload));
}
async function addAmazonJpProduct(event){event.preventDefault();const input=document.querySelector('#amazon-jp-product-url');const button=document.querySelector('#amazon-jp-product-add');button.disabled=true;try{const saved=await run('正在加入日亞單品資料庫…',()=>api('/japan/amazon/products',{url:input.value}));if(saved)input.value='';}finally{button.disabled=false;}}
async function deleteAmazonJpProduct(asin){if(!confirm('確定從日亞單品資料庫刪除 ASIN '+asin+'？刪除後會停止此商品的專屬直接監控。'))return;await run('正在刪除日亞單品…',()=>api('/japan/amazon/products/delete',{asin}));}
async function toggleFunboxSandboxMonitoring(){const enabled=currentStatus&&currentStatus.funboxSandbox&&currentStatus.funboxSandbox.enabled;await run('更新沙盒監控狀態…',()=>api(enabled?'/funbox-sandbox/stop':'/funbox-sandbox/start'));}
async function resetFunboxSandboxMonitor(){if(!confirm('確定清除沙盒監控的商品基線嗎？這不會影響正式官網或 FB 紀錄。'))return;await run('重設沙盒基線…',()=>api('/funbox-sandbox/reset-monitor'));}
async function saveNotificationSettings(event){event.preventDefault();const state=document.querySelector('#notification-state');state.textContent='儲存中…';try{const saved=await api('/notifications',{funbox:document.querySelector('#funbox-notification-mode').value,shopping:document.querySelector('#shopping-notification-mode').value});notificationDirty=false;state.textContent=saved.message;await refresh();}catch(error){state.textContent=error.message;}}
function parseFunboxPurchaseKeywords(value){return [...new Set(String(value||'').split(/\\r?\\n|,|，|、/).map(item=>item.trim()).filter(Boolean))];}
function funboxAccountPaymentsPayload(){return Object.fromEntries(currentFunboxSlots().map(slot=>{const selected=document.querySelector('input[name="funbox-account-'+slot+'-payment"]:checked');return[slot,selected?selected.value:'virtual_atm_home'];}));}
function esliteAccountPaymentsPayload(){return Object.fromEntries(currentEsliteSlots().map(slot=>{const selected=document.querySelector('input[name="eslite-account-'+slot+'-payment"]:checked');return[slot,selected?selected.value:'virtual_atm_home'];}));}
function renderPickupSetupControls(platform,slot,runtime){
  const card=document.getElementById(platform+'-account-'+slot+'-card');if(!card)return;
  let panel=card.querySelector('.pickup-setup-controls');
  if(!panel){panel=document.createElement('div');panel.className='pickup-setup-controls';panel.innerHTML='<p class="muted">預設宅配 ATM；貨到付款須先完成官方選店與真實訂單，再核對記錄。</p><div class="field"><input aria-label="門市正式訂單" placeholder="'+(platform==='funbox'?'FUNBOX 訂單詳細頁連結':'誠品正式訂單編號')+'"><button type="button">核對門市訂單</button><span class="pickup-setup-state"></span></div>';panel.querySelector('button').onclick=()=>verifyPickupSetup(platform,slot);card.querySelector('.funbox-payment-options').parentElement.append(panel);}
  const cod=card.querySelector('input[value="seven_cod"]');cod.disabled=runtime.pickupSetupReady===false;cod.title=cod.disabled?'請先完成官方 7-11 貨到付款真實訂單，並核對門市訂單':'';
  if(!panel.dataset.checking)panel.querySelector('.pickup-setup-state').textContent=runtime.pickupSetupReady?'貨到門市已記錄':'貨到門市尚未設定';
}
async function verifyPickupSetup(platform,slot){
  const panel=document.getElementById(platform+'-account-'+slot+'-card').querySelector('.pickup-setup-controls');const input=panel.querySelector('input'),button=panel.querySelector('button'),state=panel.querySelector('.pickup-setup-state');
  if(!input.value.trim()){state.textContent='請先填入官方真實訂單資料';return;}
  panel.dataset.checking='true';button.disabled=true;state.textContent='正在唯讀核對官方訂單…';
  try{const result=await api('/auto-purchase/pickup-setup',{platform,accountSlot:slot,orderReference:input.value.trim()});input.value='';state.textContent=result.message;await refresh();}
  catch(error){state.textContent=error.message;}
  finally{button.disabled=false;delete panel.dataset.checking;}
}
function autoPurchaseSettingsPayload(platform){
  if(!['funbox','eslite'].includes(platform))throw new Error('此平台購買器已封存');
  const payload={platform};
  payload[platform+'Enabled']=document.querySelector('#auto-purchase-'+platform+'-enabled').checked;
  payload[platform+'Quantity']=Number(document.querySelector('#auto-purchase-'+platform+'-quantity').value);
  payload[platform+'AccountPayments']=platform==='funbox'?funboxAccountPaymentsPayload():esliteAccountPaymentsPayload();
  const slots=platform==='funbox'?currentFunboxSlots():currentEsliteSlots();
  payload[platform+'AccountModes']=Object.fromEntries(slots.map(slot=>[slot,document.querySelector('#'+platform+'-account-'+slot+'-mode')?.value||'single']));
  for(const [suffix,field,factor] of [['BatchMaxItems','items',1],['BatchCollectMs','collect',1],['BatchBuildMs','build',1000],['BatchMaxTotal','total',1]])payload[platform+suffix]=Number(document.querySelector('#'+platform+'-batch-'+field).value)*factor;
  payload[platform+'BatchAllowPartial']=document.querySelector('#'+platform+'-batch-partial').checked;
  payload[platform+'SevenCodBlockedKeywords']=parseFunboxPurchaseKeywords(document.querySelector('#'+platform+'-cod-blocked').value);
  payload[platform+'SkipBuyKeywords']=parseFunboxPurchaseKeywords(document.querySelector('#'+platform+'-skip-buy-keywords').value);
  payload[platform+'BuyKeywords']=parseFunboxPurchaseKeywords(document.querySelector('#'+platform+'-buy-keywords').value);
  if(platform==='eslite'){payload.esliteBuyMode=document.querySelector('#eslite-buy-mode').value;payload.eslitePriorityKeywords=parseFunboxPurchaseKeywords(document.querySelector('#eslite-priority-keywords').value);}
  if(platform==='funbox')payload.funboxPriorityKeywords=parseFunboxPurchaseKeywords(document.querySelector('#funbox-priority-keywords').value);
  return payload;
}
function updateEsliteRuleMode(){const mode=document.querySelector('#eslite-buy-mode').value;document.querySelector('#eslite-rule-mode-help').textContent=mode==='whitelist'?'只購買白名單命中商品；名單空白時全部不買。黑名單永遠優先。':'白名單目前不生效，黑名單以外皆可嘗試購買。';}
async function syncAutoPurchaseLists(from,to){
  const state=document.querySelector('#auto-purchase-'+to+'-state');
  if(autoPurchaseDirtyPlatforms.size){state.textContent='請先儲存兩邊尚未儲存的設定，再同步名單。';return;}
  const names={funbox:'FUNBOX',eslite:'購物網站'};
  if(!confirm('將 '+names[from]+' 已儲存的黑白名單合併至 '+names[to]+'？保留目的地項目及排序；不改購買模式、付款、數量或啟用狀態。'))return;
  try{const saved=await api('/auto-purchase/sync-lists',{from,to,list:'both'});state.textContent=saved.message;await refresh();}catch(error){state.textContent=error.message;}
}
async function saveAutoPurchasePlatform(event,platform){event.preventDefault();const state=document.querySelector('#auto-purchase-'+platform+'-state');state.textContent='儲存中…';try{const saved=await api('/auto-purchase/settings',autoPurchaseSettingsPayload(platform));autoPurchaseDirtyPlatforms.delete(platform);state.textContent=saved.message;await refresh();}catch(error){state.textContent=error.message;}}
async function saveFunboxAccount(event,slot){event.preventDefault();const state=document.querySelector('#auto-purchase-funbox-state');const account=document.querySelector('#funbox-account-'+slot+'-account');const password=document.querySelector('#funbox-account-'+slot+'-password');const enabled=document.querySelector('#funbox-account-'+slot+'-enabled');state.textContent='正在儲存 Funbox 帳號 '+slot+' 與購買策略…';try{const credentials=await api('/auto-purchase/credentials',{platform:'funbox',accountSlot:slot,account:account.value,password:password.value,enabled:enabled.checked});const settings=await api('/auto-purchase/settings',autoPurchaseSettingsPayload('funbox'));account.value='';password.value='';autoPurchaseDirtyPlatforms.delete('funbox');toggleFunboxAccountCard(slot,false);state.textContent=credentials.message+'；'+settings.message;await refresh();}catch(error){state.textContent=error.message;}}
async function clearFunboxAccount(slot){const state=document.querySelector('#auto-purchase-funbox-state');state.textContent='正在清除 Funbox 帳號 '+slot+'…';try{const saved=await api('/auto-purchase/credentials',{platform:'funbox',accountSlot:slot,clear:true});if(!['A','B','C'].includes(slot)){funboxVisibleSlots.delete(slot);funboxExpandedSlots.delete(slot);document.querySelector('#funbox-account-'+slot+'-card')?.remove();document.querySelector('#funbox-sheet-account-'+slot)?.remove();}state.textContent=saved.message;await refresh();}catch(error){state.textContent=error.message;}}
async function saveEsliteAccount(event,slot){event.preventDefault();const state=document.querySelector('#auto-purchase-eslite-state');const account=document.querySelector('#eslite-account-'+slot+'-account');const password=document.querySelector('#eslite-account-'+slot+'-password');const enabled=document.querySelector('#eslite-account-'+slot+'-enabled');state.textContent='正在儲存誠品帳號 '+slot+'…';try{await api('/auto-purchase/settings',autoPurchaseSettingsPayload('eslite'));const credentials=await api('/auto-purchase/credentials',{platform:'eslite',accountSlot:slot,account:account.value,password:password.value,enabled:enabled.checked});account.value='';password.value='';autoPurchaseDirtyPlatforms.delete('eslite');esliteVisibleSlots.add(slot);toggleEsliteAccountCard(slot,false);state.textContent=credentials.message;await refresh();}catch(error){state.textContent=error.message;}}
async function clearEsliteAccount(slot){const state=document.querySelector('#auto-purchase-eslite-state');if(!confirm('確定清除誠品帳號 '+slot+' 的加密帳密與啟用狀態？'))return;state.textContent='正在清除誠品帳號 '+slot+'…';try{const saved=await api('/auto-purchase/credentials',{platform:'eslite',accountSlot:slot,clear:true});if(slot!=='A'){esliteVisibleSlots.delete(slot);esliteExpandedSlots.delete(slot);}if(!['A','B','C'].includes(slot)){document.querySelector('#eslite-account-'+slot+'-card')?.remove();document.querySelector('#eslite-sheet-account-'+slot)?.remove();}state.textContent=saved.message;await refresh();}catch(error){state.textContent=error.message;}}
async function testAutoPurchaseLogin(platform,accountSlot,manualOnly=false){const state=document.querySelector('#auto-purchase-'+platform+'-state');const name=platform==='funbox'?'Funbox 帳號 '+(accountSlot||'A'):'誠品帳號 '+(accountSlot||'A');state.textContent=manualOnly?'正在開啟專用手動登入視窗；不自動按登入…':platform==='eslite'?'正在確認會員 API；確定失效才自動登入…':'正在開啟 '+name+' 登入驗證視窗…';try{const result=await api('/auto-purchase/test-login',{platform,accountSlot,manualOnly});state.textContent=name+'｜'+result.message;await refresh();}catch(error){state.textContent=name+'｜登入測試失敗：'+error.message;}}
async function completeAutoPurchaseLogin(platform,accountSlot){const state=document.querySelector('#auto-purchase-'+platform+'-state');const name=platform==='funbox'?'Funbox 帳號 '+(accountSlot||'A'):'誠品帳號 '+(accountSlot||'A');state.textContent='正在檢查 '+name+' 登入狀態…';try{const result=await api('/auto-purchase/complete-login',{platform,accountSlot});state.textContent=result.message;await refresh();}catch(error){state.textContent='登入檢查：'+error.message;}}
async function purchaseAccountAction(control,platform,accountSlot,action){if(control.dataset.running||control.getAttribute('aria-disabled')==='true')return;const state=document.querySelector('#auto-purchase-'+platform+'-state');control.dataset.running='1';control.disabled=true;control.setAttribute('aria-busy','true');const prefix=accountSlot?accountSlot+'｜':'';state.textContent=prefix+(action==='clear-all-carts'?'所有已設定帳號購物車清空中…':'正在載入此帳號瀏覽器…');try{const result=await api('/auto-purchase/account-action',{platform,accountSlot,action});state.textContent=result.message;await refresh();}catch(error){state.textContent=prefix+error.message;}finally{delete control.dataset.running;control.disabled=false;control.removeAttribute('aria-busy');}}
async function runCartMaintenance(){const state=document.querySelector('#auto-purchase-maintenance');state.textContent='正在檢查各平台登入狀態並清空舊購物車…';try{const result=await api('/auto-purchase/maintenance',{});state.textContent=result.message;await refresh();}catch(error){state.textContent='購物車保養失敗：'+error.message;}}
async function resolveEsliteHold(slot,taskId){const pending=esliteSheetRecords(currentStatus?.autoPurchase||{}).rows.map(row=>row.item).filter(item=>item.accountSlot===slot&&item.status==='submitted_unconfirmed'&&item.taskId&&(!taskId||item.taskId===taskId));if(!pending.length){setEsliteQueryFeedback(slot,'這筆任務已更新，請重新整理後確認。');return;}const titles=pending.map(item=>item.product?.title||item.product?.id||item.taskId).join('、');if(!confirm('帳號 '+slot+'：'+titles+'。請確認你已在官方會員訂單核對，這 '+pending.length+' 筆確實沒有成立。確認後標記人工未成立並釋放這些任務的額度；不清車、不重送。是否確認？'))return;setEsliteQueryFeedback(slot,'正在保存人工確認結果…');try{const result=await api('/auto-purchase/eslite/resolve-hold',{accountSlot:slot,taskIds:pending.map(item=>item.taskId),confirmedNoOrder:true});setEsliteQueryFeedback(slot,result.message);await refresh();}catch(error){setEsliteQueryFeedback(slot,'確認未完成：'+error.message);}}
async function resolveFunboxHold(slot){if(!confirm('請先到 FUNBOX 官方會員訂單核對。只有確認帳號 '+slot+' 沒有成立這筆訂單，才能解除保護。已確認未成立嗎？'))return;await run('解除 FUNBOX 帳號保護…',()=>api('/auto-purchase/funbox/resolve-hold',{accountSlot:slot,confirmedNoOrder:true}));}
function setEsliteQueryFeedback(slot,text){const inline=document.querySelector('#eslite-query-result-'+slot);if(inline)inline.textContent=text;const state=document.querySelector('#auto-purchase-eslite-state');if(state)state.textContent=text;}
async function queryEsliteOrders(slot){const button=document.querySelector('#eslite-query-orders-'+slot);if(button?.dataset.running)return;if(button){button.dataset.running='1';button.disabled=true;button.textContent='查詢中';}setEsliteQueryFeedback(slot,'正在查詢帳號 '+slot+' 的官方訂單；不清車、不送單…');try{const result=await api('/auto-purchase/eslite/resolve-hold',{accountSlot:slot,action:'query'});setEsliteQueryFeedback(slot,result.message);await refresh();}catch(error){setEsliteQueryFeedback(slot,'查單失敗：'+error.message);}finally{if(button){delete button.dataset.running;button.disabled=false;button.textContent='查單';}}}
async function saveFunboxSettings(event){event.preventDefault();const saved=await run('儲存官網設定…',()=>api('/funbox/settings',{activeStart:document.querySelector('#funbox-active-start').value,activeEnd:document.querySelector('#funbox-active-end').value,intervalSeconds:Number(document.querySelector('#funbox-interval').value),stockChangeNotificationsEnabled:document.querySelector('#funbox-stock-change-notifications').checked}));if(saved){funboxSettingsDirty=false;await refresh();}}
async function saveShoppingSettings(event){event.preventDefault();const saved=await run('儲存購物網站設定…',()=>api('/shopping/settings',{activeStart:document.querySelector('#shopping-active-start').value,activeEnd:document.querySelector('#shopping-active-end').value,intervalSeconds:Number(document.querySelector('#shopping-interval').value),stockChangeNotificationsEnabled:document.querySelector('#shopping-stock-change-notifications').checked,excludeKeywords:document.querySelector('#shopping-exclude-keywords').value}));if(saved){shoppingDirty=false;await refresh();}}
async function saveJapanSettings(event){event.preventDefault();const saved=await run('儲存日本拍賣設定…',()=>api('/japan/settings',{activeStart:document.querySelector('#japan-active-start').value,activeEnd:document.querySelector('#japan-active-end').value,intervalSeconds:Number(document.querySelector('#japan-interval').value),excludeKeywords:document.querySelector('#japan-exclude-keywords').value}));if(saved){japanDirty=false;await refresh();}}
async function saveEsliteKeywords(event){event.preventDefault();const state=document.querySelector('#eslite-keyword-state');state.textContent='正在儲存誠品搜尋範圍…';try{const saved=await api('/shopping/eslite-keywords',{keywords:document.querySelector('#eslite-shopping-keywords').value});esliteKeywordsDirty=false;state.textContent=saved.message;await refresh();}catch(error){state.textContent='儲存失敗：'+error.message;}}
async function addEsliteProduct(event){event.preventDefault();const input=document.querySelector('#eslite-product-url');const state=document.querySelector('#eslite-product-state');state.textContent='正在加入誠品單品資料庫…';try{const saved=await api('/shopping/eslite-products',{url:input.value});input.value='';state.textContent=saved.message;await refresh();}catch(error){state.textContent='加入失敗：'+error.message;}}
async function deleteEsliteProduct(id){if(!confirm('確定從誠品單品資料庫移除商品 '+id+'？'))return;const state=document.querySelector('#eslite-product-state');state.textContent='正在刪除誠品單品…';try{const saved=await api('/shopping/eslite-products/delete',{id});state.textContent=saved.message;await refresh();}catch(error){state.textContent='刪除失敗：'+error.message;}}
async function addShoppingTarget(event){event.preventDefault();const name=document.querySelector('#shopping-target-name').value;const url=document.querySelector('#shopping-target-url').value;const saved=await run('加入購物專區…',()=>api('/shopping/targets',{name,url}));if(saved){document.querySelector('#shopping-target-name').value='';document.querySelector('#shopping-target-url').value='';}}
async function setShoppingTargetEnabled(index,enabled){const target=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.targets[index];if(!target)return;await run(enabled?'恢復購物專區監控…':'暫停購物專區…',()=>api('/shopping/targets/enabled',{id:target.id,enabled}));}
async function renameShoppingTarget(index){const target=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.targets[index];if(!target)return;const name=document.querySelector('#shopping-nickname-'+index).value;await run('儲存購物專區暱稱…',()=>api('/shopping/targets/rename',{id:target.id,name}));}
function toggleShoppingScheduleInputs(index){const custom=document.querySelector('#shopping-schedule-mode-'+index).value==='custom';document.querySelector('#shopping-schedule-start-'+index).disabled=!custom;document.querySelector('#shopping-schedule-end-'+index).disabled=!custom;}
async function saveShoppingTargetSchedule(index){const target=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.targets[index];if(!target)return;const mode=document.querySelector('#shopping-schedule-mode-'+index).value;const start=document.querySelector('#shopping-schedule-start-'+index).value;const end=document.querySelector('#shopping-schedule-end-'+index).value;await run('儲存專區監控時段…',()=>api('/shopping/targets/schedule',{id:target.id,mode,start,end}));}
async function deleteShoppingTarget(index){const target=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.targets[index];if(!target||!confirm('確定刪除「'+target.siteName+'｜'+target.name+'」？'))return;await run('刪除購物專區…',()=>api('/shopping/targets/delete',{id:target.id}));}
function reminderDateTimeInput(value){const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);return local.toISOString().slice(0,16);}
function setReminderInspectState(type,text){const state=document.querySelector('#sale-reminder-inspect-state');state.className='reminder-inspect-state '+(type||'');state.querySelector('span:last-child').textContent=text;}
async function inspectSaleReminderUrl(){const input=document.querySelector('#sale-reminder-url');const button=document.querySelector('#sale-reminder-inspect-button');const url=input.value.trim();if(!url)return;saleReminderInspection=null;button.disabled=true;setReminderInspectState('loading','正在讀取商品名稱、圖片、價格、可能庫存與開賣時間…');try{const data=await api('/shopping/reminders/inspect',{url});saleReminderInspection=data;input.value=data.url;document.querySelector('#sale-reminder-name').value=data.name||'';if(data.saleStartAt)document.querySelector('#sale-reminder-time').value=reminderDateTimeInput(data.saleStartAt);const time=data.saleStartAt?'開賣 '+new Date(data.saleStartAt).toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'請手動設定開賣時間';const hasStock=data.stock!==null&&data.stock!==undefined&&data.stock!==''&&Number.isFinite(Number(data.stock));const stock=hasStock?'（可能）庫存 '+Number(data.stock).toLocaleString('zh-TW'):'（可能）庫存待確認';setReminderInspectState('ok','已辨識：'+(data.name||'商品')+'｜'+(data.price||'價格待公布')+'｜'+stock+'｜'+time+'｜加入後不會持續掃描商品。');}catch(error){setReminderInspectState('bad','自動辨識失敗：'+error.message+'；仍可手動輸入名稱與時間。');}finally{button.disabled=false;}}
async function addSaleReminder(event){event.preventDefault();const name=document.querySelector('#sale-reminder-name').value;const url=document.querySelector('#sale-reminder-url').value;const saleStartAt=document.querySelector('#sale-reminder-time').value;const metadata=saleReminderInspection&&saleReminderInspection.url===url?saleReminderInspection:{};const saved=await run('新增提醒並傳送 Discord 通知…',()=>api('/shopping/reminders',{name,url,saleStartAt,imageUrl:metadata.imageUrl||'',price:metadata.price||'',stock:metadata.stock??null}));if(saved){saleReminderInspection=null;document.querySelector('#sale-reminder-name').value='';document.querySelector('#sale-reminder-url').value='';document.querySelector('#sale-reminder-time').value='';setReminderInspectState('','貼上網址後會自動辨識；仍可手動修改結果。');}}
async function setSaleReminderEnabled(index,enabled){const reminder=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.saleReminders[index];if(!reminder)return;await run(enabled?'恢復開賣提醒…':'暫停開賣提醒…',()=>api('/shopping/reminders/enabled',{id:reminder.id,enabled}));}
async function refreshSaleReminder(index){const reminder=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.saleReminders[index];if(!reminder)return;await run('重新抓取商品圖片、價格與可能庫存…',()=>api('/shopping/reminders/refresh',{id:reminder.id}));}
async function deleteSaleReminder(index){const reminder=currentStatus&&currentStatus.shoppingSites&&currentStatus.shoppingSites.saleReminders[index];if(!reminder||!confirm('確定刪除「'+reminder.name+'」開賣提醒？'))return;await run('刪除開賣提醒…',()=>api('/shopping/reminders/delete',{id:reminder.id}));}
async function saveMemo(event){event.preventDefault();const state=document.querySelector('#memo-state');state.textContent='儲存中…';try{const saved=await api('/memo',{note:document.querySelector('#memo').value});memoDirty=false;state.textContent=saved.message;await refresh();renderChannelLogs(currentStatus);}catch(error){state.textContent=error.message;}}
async function openAdditionalGoogleLogin(slot){const state=document.querySelector('#google-login-state');state.textContent='正在開啟第 '+slot+' 組登入視窗…';try{const data=await api('/google-login/additional',{slot});state.textContent=data.message;}catch(error){state.textContent=error.message;}}
async function saveSettings(event){event.preventDefault();const value=Number(document.querySelector('#interval-input').value);const activeStart=document.querySelector('#active-start').value;const activeEnd=document.querySelector('#active-end').value;const saved=await run('儲存掃描設定…',()=>api('/settings',{scanIntervalMinutes:value,activeStart,activeEnd}));if(saved){settingsDirty=false;await refresh();}}
function hotspotPayload(enabled){const select=document.querySelector('#hotspot-page');const pageUrls=Array.from(select.selectedOptions).map(option=>option.value);return{enabled,pageUrl:pageUrls[0]||'',pageUrls,activeStart:document.querySelector('#hotspot-start').value,activeEnd:document.querySelector('#hotspot-end').value,intervalSeconds:Number(document.querySelector('#hotspot-interval').value),burstModeEnabled:document.querySelector('#hotspot-burst-enabled').checked,burstStart:document.querySelector('#hotspot-burst-start').value,burstEnd:document.querySelector('#hotspot-burst-end').value,burstIntervalSeconds:Number(document.querySelector('#hotspot-burst-interval').value),autoFillEnabled:document.querySelector('#hotspot-autofill').checked,autoSubmitEnabled:document.querySelector('#hotspot-autosubmit').checked,participantSlots:[1,2,3].filter(slot=>document.querySelector('#hotspot-participant-'+slot).checked)};}
async function submitHotspot(enabled,label){const body=hotspotPayload(enabled);if(enabled&&!body.pageUrls.length){document.querySelector('#result').textContent='啟動熱點前，請先選擇至少一個粉專。';document.querySelector('#hotspot-page-list').scrollIntoView({behavior:'smooth',block:'center'});return;}const saved=await run(label,()=>api('/hotspot',body));if(saved){hotspotDirty=false;await refresh();}}
async function saveHotspot(event){event.preventDefault();await submitHotspot(Boolean(currentStatus&&currentStatus.hotspot&&currentStatus.hotspot.enabled),'儲存熱點設定…');}
async function setHotspotEnabled(enabled){await submitHotspot(enabled,enabled?'啟動熱點模式…':'關閉熱點模式…');}
async function saveAutoFillProfile(event){event.preventDefault();const body={slot:profileSlot,fullName:document.querySelector('#fill-name').value,phone:document.querySelector('#fill-phone').value,email:document.querySelector('#fill-email').value,nationalId:document.querySelector('#fill-id').value,birthDate:document.querySelector('#fill-birth').value,address:document.querySelector('#fill-address').value};const saved=await run('將第 '+profileSlot+' 組填表資料儲存在本機…',()=>api('/autofill-profile',body));if(saved){profileDirty=false;await refreshSavedProfile(true);await refresh();}}
async function saveAISettings(event){event.preventDefault();const body={enabled:document.querySelector('#ai-enabled').checked,provider:document.querySelector('#ai-provider').value,model:document.querySelector('#ai-model').value,apiKey:document.querySelector('#ai-key').value};const saved=await run('將 AI 設定儲存在本機…',()=>api('/form-ai-settings',body));if(saved){aiDirty=false;document.querySelector('#ai-key').value='';await refresh();}}
async function addPage(event){event.preventDefault();const name=document.querySelector('#page-name').value;const url=document.querySelector('#page-url').value;await run('新增粉絲專頁…',async()=>{const data=await api('/pages',{name,url});document.querySelector('#page-name').value='';document.querySelector('#page-url').value='';return data;});}
async function setPageEnabled(index,enabled){const page=currentStatus.pages[index];if(!page)return;await run(enabled?'恢復粉專監控…':'移至暫停區…',()=>api('/pages/enabled',{url:page.url,enabled}));}
async function deletePage(index){const page=currentStatus.pages[index];if(!page||!confirm('確定刪除「'+page.name+'」？'))return;await run('刪除粉絲專頁…',()=>api('/pages/delete',{url:page.url}));}
async function renamePage(index){const page=currentStatus.pages[index];if(!page)return;const name=document.querySelector('#nickname-'+index).value;await run('儲存暱稱…',()=>api('/pages/rename',{url:page.url,name}));}
async function detectPageName(index){const page=currentStatus.pages[index];if(!page)return;await run('正在從 Facebook 抓取名稱…',()=>api('/pages/detect-name',{url:page.url}));}
async function saveKeywordLists(productKeywords,salesKeywords){return run('儲存命中詞庫…',()=>api('/keywords',{productKeywords,salesKeywords}));}
async function saveCurrentKeywordLists(){const state=document.querySelector('#keyword-save-state');state.textContent='儲存中…';const saved=await saveKeywordLists([...currentStatus.productKeywords],[...currentStatus.salesKeywords]);state.textContent=saved?saved.message:'儲存失敗';}
async function addKeyword(event,type){event.preventDefault();const input=document.querySelector(type==='productKeywords'?'#product-keyword-input':'#sales-keyword-input');const keyword=input.value.trim();if(!keyword)return;const productKeywords=[...currentStatus.productKeywords];const salesKeywords=[...currentStatus.salesKeywords];(type==='productKeywords'?productKeywords:salesKeywords).push(keyword);const saved=await saveKeywordLists(productKeywords,salesKeywords);if(saved)input.value='';}
async function deleteKeyword(type,index){const productKeywords=[...currentStatus.productKeywords];const salesKeywords=[...currentStatus.salesKeywords];const list=type==='productKeywords'?productKeywords:salesKeywords;const keyword=list[index];if(keyword===undefined||!confirm('確定移除命中詞「'+keyword+'」？'))return;list.splice(index,1);await saveKeywordLists(productKeywords,salesKeywords);}
organizeDashboard();switchTab(activeTab);
setInterval(()=>{if(!document.hidden)void refresh();},4000);
setInterval(()=>{if(!document.hidden)tickEsliteTokenCountdowns();},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refresh();if(activeTab==='fb')void refreshFormPreview();}});
</script></body></html>`;

export function validateDashboardClientScript(html = pageHtml) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('找不到控制頁前端腳本。');
  new Function(match[1]);
  return true;
}

validateDashboardClientScript();

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 65536) throw new Error('要求內容過大');
  }
  return body ? JSON.parse(body) : {};
}

export function createDashboard({
  optionalTask = null,
  onProbeEslitePayments = async () => { throw new Error('付款契約探測尚未設定'); },
  onCheckPurchaseReadiness = async () => { throw new Error('補貨前檢查尚未設定'); },
  productCatalog = new ProductSheetCatalog(),
  onAddCatalogList = async () => { throw new Error('名單處理器尚未設定'); },
  onRefreshOrderStatuses = async () => ({ checked: 0, message: '查單更新尚未設定' }),
  onResolveFunboxHold = async () => { throw new Error('FUNBOX 解除保護處理器尚未設定'); },
  onVerifyPickupSetup = async () => { throw new Error('門市訂單核對尚未設定'); },
  onPrepareEsliteAccount = async () => { throw new Error('尚未設定帳號自動辨識'); },
  onPurchaseAccountAction = async () => { throw new Error('帳號工具尚未設定'); },
  readOnly = false,
  onViewEsliteCredentials = () => { throw new Error('帳密查看尚未設定'); },
  onImportEsliteBrowserSession = async () => { throw new Error('普通 Chrome 同步尚未設定'); },
  onEsliteDisplayIdentities = () => ({ accounts: [] }),
  shopee,
  edionBrowser,
  esliteBrowser,
  amazonRace,
  onSaveAmazonJpProductOrder, onOpenAmazonJpProductOrderLogin,
  onCompleteAmazonJpProductOrderLogin, onScanAmazonJpProductOrder,
  onClearAmazonJpProductOrderLogs = async () => { throw new Error('即時 LOG 清空尚未設定'); },
  onReadAmazonJpOrderEvidence = async () => { throw new Error('快照尚未設定'); },
  port, funboxSandbox, formPreviewImageFile, formPreviewMetaFile, getStatus, onScan, onHotspotScan, onFunboxScan, onFunboxSandboxScan, onShoppingScan, onProbeEsliteExhibition = async () => ({ status: 'error', productCount: 0, checkedAt: new Date().toISOString(), error: '尚未設定策展檢查器' }), onJapanScan, onTestJapanNotification, onAmazonJpScan, onTestAmazonJpNotification, onTestFunboxProductNotification, onTestFunboxPurchaseNotification, onTestSimulatedNotification, onSaveFunboxSettings, onSaveShoppingSettings, onSaveJapanSettings, onSaveAmazonJpSettings, onAddAmazonJpProduct, onDeleteAmazonJpProduct, onSaveEsliteKeywords, onAddEsliteProduct, onDeleteEsliteProduct, onSaveNotificationSettings, onSaveAutoPurchaseSettings, onSyncAutoPurchaseLists = async () => { throw new Error('尚未設定名單同步處理器'); }, onSaveAutoPurchaseCredentials, onTestAutoPurchaseLogin, onCompleteAutoPurchaseLogin, onRunAutoPurchaseMaintenance, onResolveEsliteHold = async () => { throw new Error('解除保護處理器尚未設定'); }, onManualFunboxPurchase, onManualFunboxAssignments, onManualEslitePreflight, onSelfCheck, onTestNotification, onTestPostNotification, onTestLatestSogoPost, onStart, onStop, onStartFunbox, onStopFunbox, onStartShopping, onStopShopping, onStartJapan, onStopJapan, onStartFunboxSandbox, onStopFunboxSandbox, onResetFunboxSandboxMonitor,
  onOpenFacebookLogin, onOpenGoogleLogin, onOpenAdditionalGoogleLogin, onTestAutoFill, onTestMultiAutoFill, onPrewarmForm, onSaveAutoFillProfile, onGetAutoFillProfile, onSaveAISettings, onTestFormAI, onSaveNote, onSaveHotspot, onSaveSettings, onSaveKeywords, onAddPage, onRenamePage,
  onDetectPageName, onSetPageEnabled, onDeletePage, onAddShoppingTarget, onRenameShoppingTarget, onSetShoppingTargetEnabled, onSetShoppingTargetSchedule, onDeleteShoppingTarget, onSetJapanTargetEnabled, onDeleteJapanTarget,
  onInspectSaleReminder, onAddSaleReminder, onRefreshSaleReminder, onSetSaleReminderEnabled, onDeleteSaleReminder, onPauseSystem, onResumeSystem, log
}) {
  const server = http.createServer(async (request, response) => {
    try {
      if(request.method === 'GET' && request.url.startsWith('/amazon-product-order/evidence/')){
        const parts=new URL(request.url,'http://127.0.0.1').pathname.split('/');
        const recordId=decodeURIComponent(parts[3]||''),fileName=decodeURIComponent(parts[4]||'');
        if(parts.length!==5 || !/^\d{13}-[a-f0-9-]{36}$/.test(recordId) || !/^02-\d{2}-(entry|response|failure)\.(png|html|json)$/.test(fileName))return json(response,400,{error:'快照路徑不符'});
        try{
          const body=await onReadAmazonJpOrderEvidence(recordId,fileName);
          response.writeHead(200,{'Content-Type':fileName.endsWith('.png')?'image/png':fileName.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"});response.end(body);return;
        }catch(error){if(error.code==='ENOENT')return json(response,404,{error:'快照尚未產生或不存在'});throw error;}
      }
      if (isArchivedFacebookRequest(request.url)) return json(response, 410, { error: 'Facebook 已封存：1010FB暫存', code: 'facebook_archived' });
      if (readOnly && request.method !== 'GET') return json(response, 403, { error: '預覽模式不會更改監控或推送通知' });
      if (optionalTask && await optionalTask.handle(request, response)) return;
      if (request.method === 'GET' && (request.url === '/api/product-catalog' || request.url === '/api/product-catalog?refresh=1')) {
        const catalog = await productCatalog.read({ force: request.url.endsWith('?refresh=1') });
        const settings = getStatus().autoPurchase || {};
        return json(response, 200, { ...catalog,
          lists: Object.fromEntries(['funbox','eslite'].map(p => [p, { mode: settings[p]?.buyMode || 'whitelist' }])),
          items: catalog.items.map(item => ({ ...item, listStates: Object.fromEntries(['funbox','eslite'].map(p => [p, catalogListState(item, settings[p])])) })) });
      }
      if (request.method === 'POST' && request.url === '/product-catalog/list') {
        const origin = request.headers.origin;
        if (origin && origin !== 'http://' + request.headers.host) return json(response, 403, { error: '只接受本機控制台操作' });
        const body = await readJson(request);
        const item = productCatalog.find(body.id);
        if (!item || !['funbox','eslite'].includes(body.platform) || !['black','white'].includes(body.list)) return json(response, 400, { error: '商品或名單平台無效，請更新原表後再試' });
        return json(response, 200, await onAddCatalogList({ platform: body.platform, list: body.list, item }));
      }
      if (shopee && await shopee.handle(request, response)) return;
      if (edionBrowser && await edionBrowser.handle(request, response)) return;
      if (esliteBrowser && await esliteBrowser.handle(request, response)) return;
      if (amazonRace && await amazonRace.handle(request, response)) return;
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(optionalTask ? pageHtml.replace('</body>', '<script src="/optional-tasks/funbox-app-redemption/client.js"></script></body>') : pageHtml);
        return;
      }
      if (request.url.startsWith('/funbox-sandbox') && await funboxSandbox.handle(request, response)) return;
      if (request.method === 'GET' && request.url === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url.startsWith('/api/autofill-profile')) {
        const requestUrl = new URL(request.url, 'http://127.0.0.1');
        return json(response, 200, onGetAutoFillProfile(requestUrl.searchParams.get('slot') || 1));
      }
      if (request.method === 'GET' && request.url === '/api/form-preview') {
        try {
          return json(response, 200, JSON.parse(await fs.readFile(formPreviewMetaFile, 'utf8')));
        } catch (error) {
          if (error.code === 'ENOENT') return json(response, 200, { available: false });
          throw error;
        }
      }
      if (request.method === 'GET' && request.url.startsWith('/form-preview.png')) {
        try {
          const image = await fs.readFile(formPreviewImageFile);
          response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'no-store' });
          response.end(image);
        } catch (error) {
          if (error.code === 'ENOENT') {
            response.writeHead(404, { 'Cache-Control': 'no-store' });
            response.end();
            return;
          }
          throw error;
        }
        return;
      }
      if (request.method === 'GET' && request.url === '/autofill-test-form') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><meta charset="utf-8"><title>安全預填測試</title><style>body{font:18px system-ui;max-width:650px;margin:40px auto}div[role=listitem]{margin:18px 0}input{display:block;width:100%;padding:10px}</style><h1>動態表單代理測試（不會送出）</h1><div role="listitem">姓名 *<input aria-label="真實姓名" required></div><div role="listitem">手機號碼 *<input aria-label="手機號碼" required></div><div role="listitem">出生年月日 *<input aria-label="出生年月日" required></div><div role="listitem">身分證後四碼 *<input aria-label="身分證後四碼" required></div><div role="listitem">現在時間 *<input aria-label="現在時間" required></div><div role="listitem">手機號碼末數4碼 *<input aria-label="手機號碼末數4碼" required></div><div role="listitem">Email（選填）<input type="email" aria-label="Email"></div><div role="listitem">無法從個資推斷的商品偏好 *<input aria-label="商品偏好" required></div><button type="button">送出</button>');
        return;
      }
      if (request.method === 'GET' && (request.url === '/api/status' || request.url.startsWith('/api/status?'))) {
        const query = new URL(request.url, 'http://127.0.0.1').searchParams;
        return json(response, 200, dashboardStatusForView(withoutFacebookStatus(getStatus()), query.get('view'), { logs: query.get('logs') === '1' }));
      }
      if (request.method === 'GET' && request.url === '/api/eslite-exhibition-status') {
        return json(response, 200, await onProbeEsliteExhibition());
      }
      if (request.method === 'POST' && request.url === '/scan') {
        const result = await onScan();
        return json(response, 200, { message: result.skipped ? '已有掃描正在進行' : `掃描完成：新通知 ${result.notified} 則` });
      }
      if (request.method === 'POST' && request.url === '/scan-hotspot') {
        const result = await onHotspotScan();
        return json(response, 200, { message: result.skipped ? '熱點掃描正在進行' : `熱點測試完成：讀取 ${result.checked} 篇，新通知 ${result.notified} 則` });
      }
      if (request.method === 'POST' && request.url === '/scan-funbox') {
        const result = await onFunboxScan();
        return json(response, 200, {
          message: result.skipped
            ? 'Funbox 官網正在掃描'
            : `Funbox 檢查完成：目前 ${result.checked} 件，新發現 ${result.discovered} 件，通知 ${result.notified} 則`
        });
      }
      if (request.method === 'POST' && request.url === '/scan-funbox-sandbox') {
        const result = await onFunboxSandboxScan();
        return json(response, 200, {
          message: result.skipped
            ? 'Funbox 沙盒正在掃描'
            : `沙盒檢查完成：目前 ${result.checked} 件，新發現 ${result.discovered} 件，通知 ${result.notified} 則`
        });
      }
      if (request.method === 'POST' && request.url === '/scan-shopping') {
        const result = await onShoppingScan();
        return json(response, 200, {
          message: result.skipped
            ? '購物網站正在掃描'
            : `購物網站檢查完成：${result.checkedTargets} 個專區、${result.checkedProducts} 件商品、可購新品 ${result.discovered} 件、缺貨頁略過 ${result.ignoredUnavailable || 0} 件、補貨 ${result.restocked} 款、通知 ${result.notified} 則`
        });
      }
      if (request.method === 'POST' && request.url === '/scan-japan') {
        const result = await onJapanScan();
        return json(response, 200, { message: `日本網站檢查完成：${result.checkedTargets} 站、${result.checkedProducts} 件商品、新品 ${result.discovered}、補貨 ${result.restocked}、通知 ${result.notified}` });
      }
      if (request.method === 'POST' && request.url === '/test-japan-notification') {
        return json(response, 200, await onTestJapanNotification());
      }
      if (request.method === 'POST' && request.url === '/japan/amazon/scan') {
        const result = await onAmazonJpScan();
        return json(response, 200, {
          message: result.skipped
            ? '日亞監控正在掃描'
            : `日亞搜尋完成：商品庫 ${result.registryCount ?? result.knownCount ?? 0} 件、搜尋候選 ${result.candidateCount || 0} 件、本輪 AOD ${result.directCheckedCount || 0} 件；已知商品由全庫輪查持續檢查`
        });
      }
      if (request.method === 'POST' && request.url === '/japan/amazon/test') return json(response, 200, await onTestAmazonJpNotification(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon-product-order/settings') return json(response, 200, await onSaveAmazonJpProductOrder(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon-product-order/login/open') return json(response, 200, await onOpenAmazonJpProductOrderLogin(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon-product-order/login/complete') return json(response, 200, await onCompleteAmazonJpProductOrderLogin(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon-product-order/scan') return json(response, 200, await onScanAmazonJpProductOrder(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon-product-order/clear-log') return json(response, 200, await onClearAmazonJpProductOrderLogs());
      if (request.method === 'POST' && request.url === '/test-funbox-product-notification') {
        return json(response, 200, await onTestFunboxProductNotification());
      }
      if (request.method === 'POST' && request.url === '/test-funbox-purchase-notification') {
        return json(response, 200, await onTestFunboxPurchaseNotification());
      }
      if (request.method === 'POST' && request.url === '/test-simulated-notification') {
        return json(response, 200, await onTestSimulatedNotification(await readJson(request)));
      }
      if (request.method === 'POST' && request.url === '/self-check') return json(response, 200, await onSelfCheck());
      if (request.method === 'POST' && ['/test-notification', '/test-line'].includes(request.url)) {
        const body = await readJson(request);
        const requestedChannel = request.url === '/test-line' ? 'line' : body.channel;
        const result = await onTestNotification(requestedChannel);
        return json(response, 200, result);
      }
      if (request.method === 'POST' && request.url === '/test-post-notification') {
        await onTestPostNotification();
        return json(response, 200, { message: '模擬貼文通知已送出；訊息已標示為測試，不是真實販售。' });
      }
      if (request.method === 'POST' && request.url === '/test-latest-sogo-post') return json(response, 200, await onTestLatestSogoPost());
      if (request.method === 'POST' && request.url === '/monitor/start') return json(response, 200, await onStart());
      if (request.method === 'POST' && request.url === '/monitor/stop') return json(response, 200, await onStop());
      if (request.method === 'POST' && request.url === '/system/pause') return json(response, 200, await onPauseSystem());
      if (request.method === 'POST' && request.url === '/system/resume') return json(response, 200, await onResumeSystem());
      if (request.method === 'POST' && request.url === '/funbox/start') return json(response, 200, await onStartFunbox());
      if (request.method === 'POST' && request.url === '/funbox/stop') return json(response, 200, await onStopFunbox());
      if (request.method === 'POST' && request.url === '/shopping/start') return json(response, 200, await onStartShopping());
      if (request.method === 'POST' && request.url === '/shopping/stop') return json(response, 200, await onStopShopping());
      if (request.method === 'POST' && request.url === '/japan/start') return json(response, 200, await onStartJapan());
      if (request.method === 'POST' && request.url === '/japan/stop') return json(response, 200, await onStopJapan());
      if (request.method === 'POST' && request.url === '/funbox-sandbox/start') return json(response, 200, await onStartFunboxSandbox());
      if (request.method === 'POST' && request.url === '/funbox-sandbox/stop') return json(response, 200, await onStopFunboxSandbox());
      if (request.method === 'POST' && request.url === '/funbox-sandbox/reset-monitor') return json(response, 200, await onResetFunboxSandboxMonitor());
      if (request.method === 'POST' && request.url === '/funbox/settings') return json(response, 200, await onSaveFunboxSettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/settings') return json(response, 200, await onSaveShoppingSettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/settings') return json(response, 200, await onSaveJapanSettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon/settings') return json(response, 200, await onSaveAmazonJpSettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon/products') return json(response, 200, await onAddAmazonJpProduct(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/amazon/products/delete') return json(response, 200, await onDeleteAmazonJpProduct(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/targets/enabled') return json(response, 200, await onSetJapanTargetEnabled(await readJson(request)));
      if (request.method === 'POST' && request.url === '/japan/targets/delete') return json(response, 200, await onDeleteJapanTarget(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/eslite-keywords') return json(response, 200, await onSaveEsliteKeywords(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/eslite-products') return json(response, 200, await onAddEsliteProduct(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/eslite-products/delete') return json(response, 200, await onDeleteEsliteProduct(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/targets') return json(response, 200, await onAddShoppingTarget(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/targets/rename') return json(response, 200, await onRenameShoppingTarget(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/targets/enabled') return json(response, 200, await onSetShoppingTargetEnabled(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/targets/schedule') return json(response, 200, await onSetShoppingTargetSchedule(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/targets/delete') return json(response, 200, await onDeleteShoppingTarget(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/reminders/inspect') return json(response, 200, await onInspectSaleReminder(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/reminders') return json(response, 200, await onAddSaleReminder(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/reminders/refresh') return json(response, 200, await onRefreshSaleReminder(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/reminders/enabled') return json(response, 200, await onSetSaleReminderEnabled(await readJson(request)));
      if (request.method === 'POST' && request.url === '/shopping/reminders/delete') return json(response, 200, await onDeleteSaleReminder(await readJson(request)));
      if (request.method === 'POST' && request.url === '/notifications') return json(response, 200, await onSaveNotificationSettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/settings') return json(response, 200, await onSaveAutoPurchaseSettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/sync-lists') return json(response, 200, await onSyncAutoPurchaseLists(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/eslite/credentials/view') {
        const host = request.headers.host;
        const allowedHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
        if (!allowedHosts.includes(host) || request.headers.origin !== `http://${host}` || request.headers['x-local-credential-view'] !== '1') {
          return json(response, 403, { error: '僅可由本機控制台查看' });
        }
        try {
          const { slot } = await readJson(request);
          if (!isEsliteAccountSlot(slot)) return json(response, 400, { error: '帳號欄位格式不正確' });
          return json(response, 200, await onViewEsliteCredentials(slot));
        } catch {
          return json(response, 500, { error: '無法查看已存帳密' });
        }
      }
      if (request.method === 'POST' && request.url === '/auto-purchase/eslite/display-identities') {
        const host = request.headers.host;
        if (![ `127.0.0.1:${server.address().port}`, `localhost:${server.address().port}` ].includes(host)
          || request.headers.origin !== `http://${host}` || request.headers['x-local-identity-view'] !== '1') return json(response, 403, { error: '僅可由本機控制台查看帳號身分' });
        return json(response, 200, await onEsliteDisplayIdentities());
      }
      if (request.method === 'POST' && request.url === '/auto-purchase/eslite/browser-session') {
        const host = request.headers.host;
        if (![ `127.0.0.1:${server.address().port}`, `localhost:${server.address().port}` ].includes(host)
          || request.headers.origin !== `http://${host}` || request.headers['x-local-session-import'] !== '1') {
          return json(response, 403, { error: '只接受本機登入同步，不接受外部網頁' });
        }
        try {
          const body = await readJson(request);
          if (!isEsliteAccountSlot(body.accountSlot)) return json(response, 400, { error: '帳號欄位格式不正確' });
          return json(response, 200, await onImportEsliteBrowserSession(body));
        } catch (error) {
          // No body, cookie value, token or transport request headers in errors.
          return json(response, 400, { error: safePurchaseText(error).replace(/https?:\/\/\S+/g, '[網址略去]') });
        }
      }
      if (request.method === 'POST' && request.url === '/auto-purchase/credentials') return json(response, 200, await onSaveAutoPurchaseCredentials(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/eslite/prepare') return json(response, 200, await onPrepareEsliteAccount(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/eslite/payment-probe') return json(response, 200, await onProbeEslitePayments(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/readiness') return json(response, 200, await onCheckPurchaseReadiness(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/test-login') return json(response, 200, await onTestAutoPurchaseLogin(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/account-action') {
        const host = request.headers.host;
        if (!/^127\.0\.0\.1:\d+$/.test(host || '') && !/^localhost:\d+$/.test(host || '')) return json(response, 403, { error: '只接受本機控制台操作' });
        if (request.headers.origin !== `http://${host}`) return json(response, 403, { error: '只接受本機控制台操作' });
        const body = await readJson(request);
        if (!['open-browser', 'clear-all-carts'].includes(body.action)) return json(response, 400, { error: '只提供點帳號開啟瀏覽器或一鍵全清' });
        return json(response, 200, await onPurchaseAccountAction(body));
      }
      if (request.method === 'POST' && request.url === '/auto-purchase/complete-login') return json(response, 200, await onCompleteAutoPurchaseLogin(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/maintenance') return json(response, 200, await onRunAutoPurchaseMaintenance());
      if (request.method === 'POST' && request.url === '/auto-purchase/eslite/resolve-hold') return json(response, 200, await onResolveEsliteHold(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/order-status') {
        const body = await readJson(request);
        return json(response, 200, await onRefreshOrderStatuses({ platform: body.platform, force: body.force === true }));
      }
      if (request.method === 'POST' && request.url === '/auto-purchase/funbox/resolve-hold') return json(response, 200, await onResolveFunboxHold(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/pickup-setup') return json(response, 200, await onVerifyPickupSetup(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/manual-funbox') return json(response, 200, await onManualFunboxPurchase(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/manual-funbox-assignments') return json(response, 200, await onManualFunboxAssignments(await readJson(request)));
      if (request.method === 'POST' && request.url === '/auto-purchase/manual-eslite-preflight') return json(response, 200, await onManualEslitePreflight(await readJson(request)));
      if (request.method === 'POST' && request.url === '/facebook-login') return json(response, 200, await onOpenFacebookLogin());
      if (request.method === 'POST' && request.url === '/google-login') return json(response, 200, await onOpenGoogleLogin());
      if (request.method === 'POST' && request.url === '/google-login/additional') return json(response, 200, await onOpenAdditionalGoogleLogin(await readJson(request)));
      if (request.method === 'POST' && request.url === '/test-autofill') return json(response, 200, await onTestAutoFill());
      if (request.method === 'POST' && request.url === '/test-multi-autofill') return json(response, 200, await onTestMultiAutoFill(await readJson(request)));
      if (request.method === 'POST' && request.url === '/prewarm-form') return json(response, 200, await onPrewarmForm());
      if (request.method === 'POST' && request.url === '/autofill-profile') return json(response, 200, await onSaveAutoFillProfile(await readJson(request)));
      if (request.method === 'POST' && request.url === '/form-ai-settings') return json(response, 200, await onSaveAISettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/test-form-ai') return json(response, 200, await onTestFormAI());
      if (request.method === 'POST' && request.url === '/memo') return json(response, 200, await onSaveNote(await readJson(request)));
      if (request.method === 'POST' && request.url === '/hotspot') return json(response, 200, await onSaveHotspot(await readJson(request)));
      if (request.method === 'POST' && request.url === '/settings') return json(response, 200, await onSaveSettings(await readJson(request)));
      if (request.method === 'POST' && request.url === '/keywords') return json(response, 200, await onSaveKeywords(await readJson(request)));
      if (request.method === 'POST' && request.url === '/pages') return json(response, 200, await onAddPage(await readJson(request)));
      if (request.method === 'POST' && request.url === '/pages/rename') return json(response, 200, await onRenamePage(await readJson(request)));
      if (request.method === 'POST' && request.url === '/pages/detect-name') return json(response, 200, await onDetectPageName(await readJson(request)));
      if (request.method === 'POST' && request.url === '/pages/enabled') return json(response, 200, await onSetPageEnabled(await readJson(request)));
      if (request.method === 'POST' && request.url === '/pages/delete') return json(response, 200, await onDeletePage(await readJson(request)));
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      log(`操作失敗：${error.message}`);
      json(response, 500, { error: error.message });
    }
  });
  if (amazonRace) amazonRace.attach(server);
  server.listen(port, '127.0.0.1');
  return server;
}
