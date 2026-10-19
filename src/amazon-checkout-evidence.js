import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { chromium } from 'playwright';

export const evidenceRecordId = /^\d{13}-[a-f0-9-]{36}$/;
export const evidenceFileName = /^02-\d{2}-(?:entry|response|failure)\.(?:png|html|json)$/;
const escape = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function evidenceEndpoint(value) {
  try {
    const u = new URL(value);
    return u.pathname.replace(/(\/checkout\/p\/)[^/]+/g, '$1[flow]').replace(/(?:\d{3}-\d{7}-\d{7})/g, '[order]');
  } catch { return ''; }
}

export function checkoutEvidenceHtml(html, metadata) {
  const $ = load(String(html || '').slice(0, 3_000_000));
  $('script,noscript,iframe,object,embed,base,link,meta,input[type=hidden],input[type=password]').remove();
  $('*').each((_, node) => {
    const e = $(node);
    for (const key of Object.keys(node.attribs || {})) {
      if (/^on|^data-|token|nonce|integrity|action|formaction|href|src|srcset/i.test(key)) e.removeAttr(key);
    }
    if (e.is('input,textarea,select')) { e.removeAttr('value'); if (!e.is('input')) e.empty(); }
  });
  const banner = `<aside style="padding:16px;background:#13243d;color:white;font:16px sans-serif"><strong>02 結帳快照｜${escape(metadata.kind)}｜${escape(metadata.source)}</strong><p>HTTP ${metadata.httpStatus ?? '無回應'} · ${escape(metadata.method)} ${escape(metadata.endpoint)}</p><p>${escape(metadata.error || '')}</p><small>API 回應的離線呈現，不是重新開啟官網。商品頁／前一頁僅供定位，不代表已載入結帳頁。</small></aside>`;
  $('body').prepend(banner);
  $('head').append('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"><style>body{margin:0;background:white;color:#111}body>aside{position:relative!important;z-index:2147483647}*{animation:none!important}</style>');
  return $.html();
}

export async function renderCheckoutEvidence(html) {
  // A separate, cookie-free, offline renderer. It never navigates to Amazon.
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', viewport: {width:1280,height:960} });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, {waitUntil:'domcontentloaded',timeout:5000});
    return await page.screenshot({type:'png',fullPage:true,timeout:5000});
  } finally { await browser.close(); }
}

export class AmazonCheckoutEvidence {
  constructor(directory, { saveRecord, render = renderCheckoutEvidence } = {}) {
    this.directory = path.join(directory, 'evidence');
    this.saveRecord = saveRecord;
    this.render = render;
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  enqueue(record, kind, input = {}) {
    if (!evidenceRecordId.test(record.id) || !['entry','response','failure'].includes(kind)) return;
    record.evidence ||= [];
    if (record.evidence.some(item => item.kind === kind)) return;
    const id = `02-${String(record.evidence.length + 1).padStart(2,'0')}-${kind}`;
    const metadata = {id,kind,stage:'02',at:new Date().toISOString(),source:input.source || 'unavailable',
      httpStatus:Number.isInteger(input.status)?input.status:null,method:input.method || '',endpoint:evidenceEndpoint(input.url),
      error:String(input.error || '').replace(/https?:\/\/\S+/g,'[網址略]').slice(0,600),errorCode:String(input.errorCode || '').slice(0,80),status:'pending',
      requests:(input.trace || []).slice(-8).map(item=>({method:item.method,httpStatus:item.status??null,endpoint:evidenceEndpoint(item.url)}))};
    record.evidence.push(metadata);
    // Capture immutable bytes/HTML now; later page changes cannot change proof.
    const image = input.image ? Buffer.from(input.image) : null;
    const html = input.html ?? input.$?.html?.() ?? '';
    this.pending++;
    this.queue = this.queue.catch(()=>{}).then(async()=>{
      const folder = path.join(this.directory,record.id);
      try {
        await fs.mkdir(folder,{recursive:true});
        const safeHtml = checkoutEvidenceHtml(html,metadata);
        await fs.writeFile(path.join(folder,id+'.html'),safeHtml,'utf8');
        if(input.captureError)throw new Error(input.captureError);
        const png = image || await this.render(safeHtml);
        await fs.writeFile(path.join(folder,id+'.png'),png);
        metadata.status='saved';metadata.renderedAt=new Date().toISOString();
      } catch(error) {
        metadata.status='failed';metadata.captureError=String(error.message).replace(/https?:\/\/\S+/g,'[網址略]').slice(0,300);
      } finally {
        try { await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,id+'.json'),JSON.stringify(metadata,null,2),'utf8'); }
        catch { /* The record still carries an honest capture failure. */ }
        try { await this.saveRecord(record); } catch { /* Never propagate a diagnostics failure into checkout. */ }
        this.pending--;
      }
    });
    // The checkout hot path never waits for offline rendering or disk writes.
  }

  async read(recordId,fileName) {
    if (!evidenceRecordId.test(recordId) || !evidenceFileName.test(fileName)) throw new Error('快照路徑不符');
    return fs.readFile(path.join(this.directory,recordId,fileName));
  }
}
