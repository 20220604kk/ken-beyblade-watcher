import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { safePurchaseText } from './purchase-diagnostics.js';
import { isEsliteAccountSlot } from './eslite-account-slots.js';
const digest = value => createHash('sha256').update(value).digest();
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
// Separate pairing from EDION: this connector can read authentication data.
export class EsliteSessionBridge {
  constructor({ state, importSession }) { Object.assign(this, { state, importSession }); this.tail = Promise.resolve(); }
  root() { this.state.data.commerce ||= {}; return this.state.data.commerce.esliteBrowser ||= {}; }
  async handle(request, response) {
    if (!request.url.startsWith('/eslite-browser/')) return false;
    const reply = (code, body) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    const origin = String(request.headers.origin || '');
    const extension = request.url === '/eslite-browser/import';
    try {
      if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host || '')) throw new Error('僅接受本機');
      if (extension && extensionOrigin.test(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        if (request.method === 'OPTIONS') { reply(200, {}); return true; }
      }
      if (request.method !== 'POST' || !String(request.headers['content-type']).startsWith('application/json')) throw new Error('僅接受 JSON POST');
      let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw new Error('資料過大'); }
      const body = JSON.parse(raw || '{}');
      const work = async () => {
        const root = this.root();
        if (request.url === '/eslite-browser/pair') {
          if (origin !== `http://${request.headers.host}` || request.headers['x-local-session-import'] !== '1') throw new Error('僅由本機控制台配對');
          const token = randomBytes(32).toString('hex'); root.tokenHash = digest(token).toString('hex'); root.origin = '';
          await this.state.save(); return { token };
        }
        const expected = Buffer.from(root.tokenHash || '', 'hex');
        const bearer = String(request.headers.authorization || '').replace(/^Bearer /, '');
        if (!extension || !extensionOrigin.test(origin) || expected.length !== 32 || !timingSafeEqual(expected, digest(bearer))
          || root.origin && root.origin !== origin) throw new Error('誠品同步配對無效');
        if (!isEsliteAccountSlot(body.accountSlot)) throw new Error('帳號欄位無效');
        // Real member API identity validation and per-account lock stay in the adapter.
        const result = await this.importSession(body);
        root.origin = origin; root.lastImportedAt = new Date().toISOString(); root.lastSlot = result.accountSlot;
        await this.state.save(); return result;
      };
      const result = this.tail.then(work); this.tail = result.catch(() => {});
      reply(200, await result);
    } catch (error) { reply(400, { error: safePurchaseText(error.message), retryAfterSeconds: 60 }); }
    return true;
  }
}
