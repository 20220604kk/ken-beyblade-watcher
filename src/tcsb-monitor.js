// Public read-only API used by the current TCSB search page (not the older
// shop.tcsb.com.tw / 91APP storefront). No account or cart requests.
export const TCSB_SEARCH_URL = 'https://www.tcsb.com.tw/search?query=beyblade+x+%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&place_of_origin=%E5%85%B6%E4%BB%96';
export const TCSB_BASELINE_VERSION = 'tcsb-products-v1';

export function isTcsbSearchTarget(target) {
  try {
    const url = new URL(target?.url || '');
    return url.protocol === 'https:' && /^(?:www\.)?tcsb\.com\.tw$/i.test(url.hostname)
      && /^\/search\/?$/.test(url.pathname);
  } catch { return false; }
}

export function parseTcsbProductsData(data) {
  if (!Array.isArray(data?.data)) throw new Error('墊腳石商品 API 格式不完整，保留上次基線');
  const products = new Map();
  for (const item of data.data) {
    const title = String(item?.name || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const id = String(item?.id || '');
    const slug = String(item?.url_key || '').trim();
    // Keep genuine modelled toys/accessories; customer blacklists still decide
    // which accessories to suppress. Search suggestions/books are not toys.
    if (!/^\d+$/.test(id) || !slug || !/(?:BEYBLADE\s*X|戰鬥陀螺)/i.test(title)
      || !/\b(?:BXG|BX|UX|CX)-\d{2}\b/i.test(title)
      || /(?:漫畫|紙陀螺|圖鑑|百科|攻略|童書|電子書|背包|書包)/i.test(title)) continue;
    const available = typeof item.is_saleable === 'boolean' ? item.is_saleable : null;
    const rawPrice = item.prices?.final?.price;
    const priceNumber = rawPrice === null || rawPrice === undefined ? NaN : Number(rawPrice);
    const image = item.base_image?.medium_image_url || item.base_image?.large_image_url || '';
    let imageUrl = '';
    try { const parsed = new URL(image); if (parsed.protocol === 'https:') imageUrl = parsed.href; } catch {}
    products.set(id, {
      id, title, url: `https://www.tcsb.com.tw/product/${encodeURIComponent(slug)}`, imageUrl,
      price: Number.isFinite(priceNumber) && priceNumber > 0 ? `NT$${priceNumber.toLocaleString('zh-TW')}` : '',
      available, status: available === true ? 'available' : available === false ? '售完補貨中' : '',
      availabilitySource: 'tcsb-products-api',
      // The API exposes saleability, not quantities. Never invent stock=1/0.
      variants: []
    });
  }
  return [...products.values()];
}

export async function loadTcsbSearchProducts(target, fetcher = fetch) {
  if (!isTcsbSearchTarget(target)) throw new Error('墊腳石 API 只接受官方搜尋頁');
  const search = new URL(target.url);
  if (!search.searchParams.get('query')?.trim()) throw new Error('墊腳石搜尋關鍵字不能留空');
  const endpoint = new URL('https://www.tcsb.com.tw/api/products');
  endpoint.search = search.search;
  const signal = AbortSignal.timeout(15_000);
  const pageData = async page => {
    const url = new URL(endpoint);
    url.searchParams.set('page', String(page));
    const response = await fetcher(url.href, {
      headers: { Accept: 'application/json', 'Accept-Language': 'zh-TW,zh;q=0.9',
        'Cache-Control': 'no-cache', Referer: search.href }, signal
    });
    if (!response.ok) throw new Error(`墊腳石商品 API HTTP ${response.status}，保留上次基線`);
    const data = await response.json();
    if (!Array.isArray(data?.data) || Number(data?.meta?.current_page) !== page
      || !Number.isInteger(Number(data?.meta?.last_page)) || Number(data.meta.last_page) < page
      || !Number.isInteger(Number(data?.meta?.total)) || Number(data.meta.total) < 0
      || !data.data.length && Number(data.meta.total) > 0) {
      throw new Error('墊腳石商品 API 分頁資料不完整，保留上次基線');
    }
    return data;
  };
  const first = await pageData(1);
  const pages = Number(first.meta.last_page);
  if (pages > 10) throw new Error('墊腳石搜尋超過 10 頁，請縮小搜尋範圍；保留上次基線');
  const rows = [...first.data];
  // Bound traffic to two simultaneous reads and 15 seconds for the whole scan.
  for (let page = 2; page <= pages; page += 2) {
    const batch = await Promise.all(Array.from({ length: Math.min(2, pages - page + 1) }, (_, i) => pageData(page + i)));
    for (const data of batch) {
      if (Number(data.meta.last_page) !== pages || Number(data.meta.total) !== Number(first.meta.total)) {
        throw new Error('墊腳石搜尋分頁在掃描中變動，保留上次基線待下輪確認');
      }
      rows.push(...data.data);
    }
  }
  if (new Set(rows.map(item => String(item.id))).size !== Number(first.meta.total)) {
    throw new Error('墊腳石搜尋結果未完整讀取，保留上次基線');
  }
  return parseTcsbProductsData({ data: rows });
}
