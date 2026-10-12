// Runs only in the top-level, ordinary Chrome EDION tab. Read public product
// cards, not cookies, hidden form fields, account details or CAPTCHA frames.
export function collectEdionDom() {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const items = []; const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href*="/detail.html?p_cd="]')) {
    const card = anchor.closest('li'); if (!card) continue;
    let url;
    try { url = new URL(anchor.getAttribute('href'), location.href); } catch { continue; }
    const id = url.searchParams.get('p_cd');
    if (!/^\d{5,20}$/.test(id || '') || seen.has(id) || !['www.edion.com', 'edion.com'].includes(url.hostname)) continue;
    let title = clean(anchor.textContent || anchor.querySelector('img[alt]')?.alt || card.querySelector('a[href*="/detail.html?p_cd="]')?.textContent);
    if (!title) continue;
    if (title.length % 2 === 0 && title.slice(0, title.length / 2) === title.slice(title.length / 2)) title = title.slice(0, title.length / 2);
    const text = clean(card.textContent); const stockMatch = text.match(/在庫数\s*(\d+)\s*(?:台|個|点)?/i);
    const stock = stockMatch ? Number(stockMatch[1]) : null;
    const unavailable = /販売終了|販売を終了|予定数終了|完売|在庫切れ|売り切れ|sold\s*out/i.test(text) || stock === 0
      || card.matches('.soldout, .sold_out') || Boolean(card.querySelector('.soldout, .sold_out, [class*="soldout"]'));
    const available = unavailable ? false : stock > 0 || /在庫あり|カートに入れる|予約受付中/.test(text) ? true : null;
    const image = card.querySelector('img'); const price = text.match(/[￥¥]\s*([\d,]+)/);
    url.search = ''; url.searchParams.set('p_cd', id); url.hash = '';
    seen.add(id); items.push({ url: url.href, title: title.slice(0, 300), stock, available, price: price ? '¥' + price[1] : '', imageUrl: image?.getAttribute('data-src') || image?.src || '' });
    if (items.length === 200) break;
  }
  const accessText = clean(document.title + ' ' + (document.body?.innerText || '').slice(0, 1500));
  const blocked = /Just a moment|Checking your browser|Attention Required|人間であること|セキュリティチェック|セキュリティ検証|Verify you are human|驗證您是人類/i.test(accessText)
    || (!items.length && Boolean(document.querySelector('script[src*="/cdn-cgi/challenge-platform"], iframe[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"]')));
  return { url: location.href, health: blocked ? 'verification_required' : document.readyState === 'complete' && items.length ? 'ready' : 'unreadable', items: blocked ? [] : items };
}
