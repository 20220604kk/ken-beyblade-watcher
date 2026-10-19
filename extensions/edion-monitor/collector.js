// Runs only in the top-level, ordinary Chrome EDION tab. Read public product
// cards, not cookies, hidden form fields, account details or CAPTCHA frames.
export function collectEdionDom(html = '', pageUrl = '') {
  const doc = html ? new DOMParser().parseFromString(html, 'text/html') : document;
  const sourceUrl = pageUrl || location.href;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const items = []; const seen = new Set();
  const scope = doc.querySelector('.resultArea, #resultArea') || doc;
  for (const anchor of scope.querySelectorAll('a[href*="/detail.html?p_cd="]')) {
    const card = anchor.closest('li'); if (!card) continue;
    let url;
    try { url = new URL(anchor.getAttribute('href'), sourceUrl); } catch { continue; }
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
  const bodyText = html ? doc.body?.textContent : doc.body?.innerText;
  const accessText = clean(doc.title + ' ' + (bodyText || '').slice(0, 1500));
  const blocked = /Just a moment|Checking your browser|Attention Required|人間であること|セキュリティチェック|セキュリティ検証|Verify you are human|驗證您是人類/i.test(accessText)
    || (!items.length && Boolean(doc.querySelector('script[src*="/cdn-cgi/challenge-platform"], iframe[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"]')));
  const range = clean(scope.textContent).match(/検索結果[：:]?\s*([\d,]+)件中\s*([\d,]+)\s*[-～〜]\s*([\d,]+)件/);
  const expectedCount = range ? Number(range[3].replace(/,/g,'')) - Number(range[2].replace(/,/g,'')) + 1 : null;
  const complete = !html || expectedCount > 0 && expectedCount <= 200 && items.length === expectedCount;
  const ready = (html || doc.readyState === 'complete') && items.length && complete;
  return { url: sourceUrl, health: blocked ? 'verification_required' : ready ? 'ready' : 'unreadable',
    expectedCount, items: blocked || !complete ? [] : items };
}
