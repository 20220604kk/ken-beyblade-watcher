import { createHash } from 'node:crypto';
import { purchaseKeywordMatches } from './purchase-rules.js';

// No personal/community spreadsheet is bundled with the release.
export const SHEET_ID = '';
export const SHEET_URL = '';
export const SHEET_CSV_URL = '';
export const CATALOG_CATEGORIES = ['BX', 'UX', 'CX', '配件', '聯名', '對戰盤'];

// The source is a CSV document, never executable instructions or HTML.
export function parseCatalogCsv(text) {
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('試算表資料過大或無效');
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('試算表 CSV 格式不完整');
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()?.map(x => x.replace(/^\uFEFF/, '').trim());
  if (!header || header.join('|') !== '型號|品項|售價（NT$）|類型') throw new Error('終端品項及售價欄位已變更，請核對原表');
  const seen = new Set();
  return rows.filter(r => r.some(x => x.trim())).map((r, index) => {
    if (r.length !== 4) throw new Error(`第 ${index + 2} 列欄位不完整`);
    const [rawModel, rawName, rawPrice, rawType] = r.map(x => x.trim());
    const model = rawModel.toUpperCase();
    if (!/^(?:BX|UX|CX|BXG|BXA)-\d{2}(?:-[A-Z0-9]+)?$/.test(model) || seen.has(model)
      || !rawName || rawName.length > 240 || rawType.length > 80 || rawPrice.length > 40) throw new Error(`第 ${index + 2} 列型號或內容異常`);
    seen.add(model);
    const category = /聯名/.test(rawName + rawType) ? '聯名'
      : /戰鬥盤|對戰盤/.test(rawName + rawType) ? '對戰盤'
      : /發射器|握把|收納盒|工具|通行證/.test(rawName + rawType) ? '配件'
      : model.startsWith('BX') ? 'BX' : model.startsWith('UX') ? 'UX' : 'CX';
    const priceText = rawPrice.replace(/^(?:NT\$?|NTD|\$)\s*/i, '').replace(/,/g, '');
    const price = /^\d+(?:\.\d{1,2})?$/.test(priceText) ? Number(priceText) : null;
    return { id: createHash('sha256').update(model).digest('hex').slice(0, 16), model, name: rawName, type: rawType,
      category, price, priceText: price === null ? rawPrice || '待查' : '', row: index + 2 };
  });
}

export class ProductSheetCatalog {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetch = fetchImpl; this.now = now; this.items = []; this.updatedAt = null; this.error = ''; this.lastAttempt = null; this.pending = null;
    const id = String(process.env.PRODUCT_CATALOG_SHEET_ID || '').trim();
    const gid = String(process.env.PRODUCT_CATALOG_SHEET_GID || '0').trim();
    const valid = /^[A-Za-z0-9_-]{20,100}$/.test(id) && /^\d{1,12}$/.test(gid);
    this.sourceUrl = valid ? `https://docs.google.com/spreadsheets/d/${id}/edit?gid=${gid}` : '';
    this.csvUrl = valid ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}` : '';
    this.embedUrl = valid ? `https://docs.google.com/spreadsheets/d/${id}/htmlview?gid=${gid}&single=true&widget=true&headers=false` : '';
  }
  async read({ force = false } = {}) {
    if (!this.csvUrl) return { sourceUrl: '', embedUrl: '', configured: false,
      sheetName: '未設定商品試算表', categories: CATALOG_CATEGORIES,
      items: [], updatedAt: null, stale: false, error: '請在本機 .env 設定 PRODUCT_CATALOG_SHEET_ID 與 PRODUCT_CATALOG_SHEET_GID' };
    const age = this.lastAttempt === null ? Infinity : this.now() - this.lastAttempt;
    if (this.pending) await this.pending;
    else if (age >= (force ? 30_000 : 900_000)) {
      this.lastAttempt = this.now();
      this.pending = this.load().finally(() => { this.pending = null; });
      await this.pending;
    }
    return { sourceUrl: this.sourceUrl, embedUrl: this.embedUrl, configured: true,
      sheetName: '終端品項及售價', categories: CATALOG_CATEGORIES,
      items: this.items, updatedAt: this.updatedAt, stale: Boolean(this.error), error: this.error };
  }
  async load() {
    try {
      const response = await this.fetch(this.csvUrl, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'text/csv' } });
      if (!response.ok) throw new Error(`Google 回覆 HTTP ${response.status}`);
      if (Number(response.headers?.get('content-length')) > 1_000_000) throw new Error('試算表資料過大');
      const items = parseCatalogCsv(await response.text());
      if (!items.length || items.length > 1000) throw new Error('試算表沒有可用商品或超過筆數上限');
      this.items = items; this.updatedAt = new Date(this.now()).toISOString(); this.error = '';
    } catch (error) {
      // Keep last known data; an unavailable source must not become a zero-price catalog.
      this.error = '讀取原表失敗：' + (error.name === 'TimeoutError' ? '連線逾時' : String(error.message).slice(0, 160));
    }
  }
  find(id) { return this.items.find(item => item.id === id); }
}

export function catalogListState(item, settings = {}) {
  const title = item.model + ' ' + item.name;
  const black = (settings.skipBuyKeywords || []).filter(word => purchaseKeywordMatches(title, word));
  const white = (settings.buyKeywords || []).filter(word => purchaseKeywordMatches(title, word));
  return { black, white, mode: settings.buyMode || 'whitelist' };
}

export function catalogListPatch(current, { platform, list, item } = {}) {
  if (!['funbox', 'eslite'].includes(platform) || !['black', 'white'].includes(list) || !item?.model) throw new Error('請選擇平台、商品與黑／白名單');
  const settings = current[platform] || {};
  const key = list === 'black' ? 'skipBuyKeywords' : 'buyKeywords';
  const other = list === 'black' ? 'buyKeywords' : 'skipBuyKeywords';
  const normalized = value => String(value).normalize('NFKC').trim().toUpperCase();
  const result = { ...current, [platform]: { ...settings,
    [key]: [...(settings[key] || []).filter(word => normalized(word) !== item.model), item.model],
    [other]: (settings[other] || []).filter(word => normalized(word) !== item.model) } };
  const state = catalogListState(item, result[platform]);
  return { config: result, warning: list === 'white' && state.black.length
    ? `仍命中黑名單「${state.black.join('、')}」；黑名單優先，未移除其他廣泛規則。`
    : platform === 'eslite' && list === 'white' && settings.buyMode !== 'whitelist'
      ? '已加入白名單；購物網站目前為黑名單以外皆可模式，未自動切換模式。' : '' };
}
