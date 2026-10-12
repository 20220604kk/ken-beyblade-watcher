import * as cheerio from 'cheerio';
import { readEsliteOrderHistory } from './eslite-orders.js';

export const PICKUP_SETUP_REQUIRED = '7-11 貨到付款未設定：請先在官方完成選店並成立一張真實訂單，再核對門市訂單；目前請使用宅配 ATM';
const normalize = value => String(value || '').replace(/\s/g, '').toLowerCase();

export function pickupSetupMatches(setup, profile = {}) {
  return Boolean(setup?.verifiedAt && setup.orderNumber && setup.storeName
    && (!profile.storeName || normalize(setup.storeName) === normalize(profile.storeName)));
}

// All requests here are GET-only. A supplied reference is never itself proof.
export async function verifyFunboxPickupOrder(api, reference, profile = {}) {
  let url;
  try { url = new URL(reference); } catch { throw new Error('請貼上 FUNBOX 官方訂單詳細頁連結'); }
  const token = url.pathname.match(/^\/(?:account\/)?orders\/([a-f0-9]{32})\/?$/i)?.[1];
  if (url.origin !== 'https://shop.funbox.com.tw' || !token) throw new Error('請貼上 FUNBOX 官方訂單詳細頁連結');
  if (!profile.storeName) throw new Error('請先設定要使用的共用 7-11 門市名稱');
  const listResponse = await api.get('https://shop.funbox.com.tw/account/orders', { timeout: 8000, maxRedirects: 0 });
  if (!listResponse.ok()) throw new Error('FUNBOX 官方訂單列表無法讀取，請先確認本帳號登入');
  const list = cheerio.load(await listResponse.text());
  const owned = list('a[href]').toArray().some(element => {
    try {
      const link = new URL(list(element).attr('href'), 'https://shop.funbox.com.tw');
      return link.origin === 'https://shop.funbox.com.tw' && link.pathname === '/account/orders/' + token;
    } catch { return false; }
  });
  if (!owned) throw new Error('這張訂單尚未出現在本帳號官方訂單列表，不能解鎖貨到付款');
  const response = await api.get('https://shop.funbox.com.tw/account/orders/' + token, { timeout: 8000, maxRedirects: 0 });
  if (!response.ok()) throw new Error('FUNBOX 官方訂單明細無法確認');
  const page = cheerio.load(await response.text());
  const field = label => page('.item_title').filter((_, element) => page(element).text().trim() === label).siblings('.item_content').text().trim();
  const orderNumber = page('.order_name .value').text().trim();
  const payment = field('付款方式'), shipping = field('配送方式');
  if (!/^[A-Za-z0-9-]{4,64}$/.test(orderNumber) || /^TEST/i.test(orderNumber)
    || !/7-11\s*貨到付款|7-ELEVEN.*取貨付款/i.test(payment)
    || !/7-11|7-ELEVEN|統一超商/i.test(shipping) || !shipping.includes('門市名稱')
    || !normalize(shipping).includes(normalize(profile.storeName))) {
    throw new Error('官方明細未確認為指定 7-11 門市的貨到付款真實訂單');
  }
  return { orderNumber, storeName: profile.storeName, source: 'official_order', verifiedAt: new Date().toISOString() };
}

export async function verifyEslitePickupOrder(api, reference, profile = {}) {
  if (!/^\d{8,20}$/.test(String(reference || '').trim())) throw new Error('請填入誠品正式訂單編號');
  let setup;
  await readEsliteOrderHistory(api, { expectedOrderId: String(reference).trim(), maxPages: 3, maxDetails: 1,
    timeoutMs: 5000, maxDurationMs: 20000, onDetail: body => {
      const shipping = body.shipping || {};
      // Unknown payment enums fail closed; an ATM/prepaid receipt must not unlock COD.
      // Official live COD receipt on 2026-10-10 uses pay_711 + ship_711.
      // Accept this pair, not an arbitrary 711 payment enum by itself.
      const cod = /^(?:pay_)?(?:cod|seven_cod|711_cod)$/i.test(body.payment?.type || '')
        || body.payment?.type === 'pay_711' && shipping.type === 'ship_711';
      if (!cod
        || !body.sub_orders?.some(sub => sub.status?.order_init && !sub.status.order_failed)
        || !/^\d{6}$/.test(String(shipping.store_id || '')) || !shipping.store_name || !shipping.store_address
        // Official 2026-10-10 successful COD detail leaves city/district/zip blank.
        // Owned receipt + known COD/store enums + exact store ID/name/address prove selection.
        // Preserve optional blank fields; never invent geography or reject an actual receipt.
        || !/^(?:5|seven|seven_eleven|7-11|711)$/i.test(String(shipping.store_type || ''))
        || (profile.storeName && normalize(shipping.store_name) !== normalize(profile.storeName))) return;
      setup = { orderNumber: String(body.order_number), storeName: String(shipping.store_name), storeId: String(shipping.store_id),
        source: 'official_order', verifiedAt: new Date().toISOString(),
        recipient: { id: '', type: '5', country: 'TW', name: String(body.recipient?.name || ''),
          mobile: structuredClone(body.recipient?.mobile || {}), telephone: structuredClone(body.recipient?.telephone || {}),
          city: String(shipping.city || ''), district: String(shipping.district || ''), zip: String(shipping.zip || ''),
          address: String(shipping.store_address), full_address: String(shipping.full_address || shipping.store_address),
          isIsland: /金門|連江|澎湖/.test(shipping.city || ''), store: { id: String(shipping.store_id), type: '5', name: String(shipping.store_name),
            address: String(shipping.store_address), city: String(shipping.city || '') } } };
    } });
  if (!setup || !setup.recipient.name || !/^09\d{8}$/.test(setup.recipient.mobile?.number || '')) {
    throw new Error('官方明細尚未確認指定 7-11 貨到付款訂單／門市格式，不能解鎖；請繼續使用 ATM');
  }
  return setup;
}
