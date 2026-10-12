// First-party GET-only account preparation. No cart writes or checkout requests.
// Payload contract: captured official checkout A/C; member/address API verified 2026-10-09.
import { decodeEsliteOrderBody } from './eslite-orders.js';

function setupError(message, purchaseStatus = 'needs_setup') {
  return Object.assign(new Error(message), { purchaseStatus });
}
const text = value => String(value ?? '').trim();
const normalize = value => text(value).replace(/\s/g, '').replaceAll('臺', '台');
const phone = value => text(value).replace(/\D/g, '').replace(/^8860?/, '0');
const isIsland = city => /澎湖|金門|連江/.test(text(city));
// Member API uses "1" where captured official checkout uses "TW".
const countryCode = value => text(value) === '1' ? 'TW' : text(value);

export function esliteMemberMatchesAccount(member, expectedAccount) {
  const expected = text(expectedAccount).toLowerCase();
  if (!expected) return false;
  const aliases = [member.account, member.email, member.card_code, member.lms_member_id, member.phone_number].filter(Boolean);
  return aliases.some(value => text(value).toLowerCase() === expected
    || /^\+?\d{9,13}$/.test(expected) && phone(value) === phone(expected));
}

async function get(api, url, timeoutMs) {
  let response;
  try { response = await api.get(url, { timeout: timeoutMs, maxRetries: 0 }); }
  catch { throw setupError('會員／配送 API 暫時連線失敗；保留既有登入與資料，稍後再查', 'unknown'); }
  try {
    if (response.status() === 401) throw setupError('會員登入憑證已失效', 'needs_login');
    if (!response.ok()) throw setupError(`資料暫時無法讀取（HTTP ${response.status()}）；保留既有資料，稍後再查`, 'unknown');
    try { return decodeEsliteOrderBody(await response.json()); }
    catch { throw setupError('官方會員資料格式已變更；未覆寫既有資料', 'unknown'); }
  } finally { await response.dispose?.(); }
}

export async function readEsliteMemberDetail(api, { expectedAccount, timeoutMs = 8000 } = {}) {
  const member = await get(api, '/api/v2/member_detail', timeoutMs);
  if (!member || !(member.id || member.uuid) || !text(member.name)) {
    throw setupError('會員 API 未提供完整會員姓名與身分，無法自動辨識', 'unknown');
  }
  if (!esliteMemberMatchesAccount(member, expectedAccount)) {
    throw setupError('目前登入的會員與這一欄帳號不符，需重新登入此帳號', 'needs_login');
  }
  return member;
}

function splitAddress(value) {
  const match = text(value).replace(/^\d{3,6}\s*/, '').match(/^(.{2,3}[縣市])(.{1,5}[區鄉鎮市])(.+)$/);
  return match ? { city: match[1], district: match[2], address: match[3] } : null;
}

function subscriberFromMember(member, addresses, profile, existing) {
  const rawAddress = text(member.address);
  const zip = text(member.zipcode);
  const number = phone(member.phone_number);
  if (!/^09\d{8}$/.test(number)) throw setupError('會員手機資料不完整，請先在誠品會員資料補齊');
  if (!rawAddress && !zip && (!text(member.country) || countryCode(member.country) === 'TW')) {
    // Observed official A/C checkout contract: subscriber address may be blank.
    // Shipping still requires a separately validated recipient below.
    return { address: '', city: '', country: 'TW', district: '', name: text(member.name), zip: '', isIsland: false,
      full_address: '', mobile: { country: Number(member.phone_country_code) || 886, number },
      telephone: { country: 886, number: '', extension: '' } };
  }
  const sameStreet = candidate => normalize(candidate?.address) === normalize(rawAddress)
    || normalize((candidate?.city || '') + (candidate?.district || '') + (candidate?.address || '')) === normalize(rawAddress);
  const match = addresses.find(item => text(item.zip) === zip && sameStreet(item));
  const old = existing && text(existing.zip) === zip && sameStreet(existing) ? existing : null;
  const configured = text(profile?.postalCode) === zip && sameStreet(profile) ? profile : null;
  const location = splitAddress(rawAddress) || match || old || configured;
  const country = countryCode(member.country);
  if (country !== 'TW' || !location?.city || !location?.district || !rawAddress || !/^\d{3,6}$/.test(zip)) {
    throw setupError('會員地址不完整，請先在誠品會員資料補齊台灣地址');
  }
  const street = splitAddress(rawAddress)?.address || text(location.address) || rawAddress;
  return { address: street, city: text(location.city), country, district: text(location.district),
    name: text(member.name), zip, isIsland: isIsland(location.city),
    full_address: text(location.city) + text(location.district) + street,
    mobile: { country: Number(member.phone_country_code) || 886, number },
    telephone: { country: 886, number: '', extension: '' } };
}

function homeRecipient(addresses, profile) {
  // The user's configured shipping address wins. Otherwise choose only a unique saved home address.
  if (profile?.fullName && /^09\d{8}$/.test(phone(profile.phone)) && profile.city && profile.district
    && /^\d{3,6}$/.test(text(profile.postalCode)) && profile.address) {
    return { id: '', isIsland: isIsland(profile.city), type: '2', name: text(profile.fullName), country: 'TW',
      city: text(profile.city), district: text(profile.district), zip: text(profile.postalCode), address: text(profile.address),
      full_address: text(profile.city) + text(profile.district) + text(profile.address),
      mobile: { country: 886, number: phone(profile.phone) }, telephone: { country: 886, number: '', extension: '' },
      store: { id: '', type: '', delivery: '', name: '', address: '', city: '' } };
  }
  const candidates = addresses.filter(item => item.delivery_type === '2' && item.name && item.city && item.district
    && item.address && item.country === 'TW' && /^09\d{8}$/.test(phone(item.mobile_phone)));
  if (candidates.length !== 1) throw setupError('宅配地址尚未設定或有多個選項，請先設定共用宅配資料');
  const address = candidates[0];
  return homeRecipient([], { fullName: address.name, phone: address.mobile_phone, city: address.city,
    district: address.district, postalCode: address.zip, address: address.address });
}

function pickupRecipient(addresses, profile, existing) {
  const candidates = addresses.filter(item => item.delivery_type === '5' && item.country === 'TW'
    && item.store_code && item.store_name && item.address
    && (!profile?.storeName || normalize(item.store_name).includes(normalize(profile.storeName))
      || normalize(profile.storeName).includes(normalize(item.store_name))));
  if (candidates.length === 0 && existing?.type === '5' && existing.country === 'TW'
    && existing.store?.id && existing.store.name && existing.store.address
    && (!profile?.storeName || normalize(existing.store.name).includes(normalize(profile.storeName))
      || normalize(profile.storeName).includes(normalize(existing.store.name)))) {
    // Reuse only this account's captured store selection, never another account's template.
    const recipient = structuredClone(existing);
    if (profile?.fullName) recipient.name = text(profile.fullName);
    if (profile?.phone) recipient.mobile = { country: 886, number: phone(profile.phone) };
    if (recipient.name && /^09\d{8}$/.test(recipient.mobile?.number)) return recipient;
  }
  if (candidates.length !== 1) throw Object.assign(setupError('無法唯一辨識 7-11 取貨門市，請先在誠品保存預設門市'), { setupCode: 'pickup_unavailable' });
  const address = candidates[0];
  const number = phone(profile?.phone || address.mobile_phone);
  const name = text(profile?.fullName || address.name);
  if (!name || !/^09\d{8}$/.test(number)) throw Object.assign(setupError('超商取貨姓名或手機不完整'), { setupCode: 'pickup_unavailable' });
  return { id: '', isIsland: isIsland(address.city), type: '5', name, city: text(address.city), country: 'TW',
    district: text(address.district), zip: text(address.zip), address: text(address.address),
    full_address: text(address.city) + text(address.district) + text(address.address),
    mobile: { country: 886, number }, telephone: { country: 886, number: '', extension: '' },
    store: { id: text(address.store_code), type: '5', name: text(address.store_name), city: text(address.city),
      country: 'TW', district: text(address.district), zip: text(address.zip), address: text(address.address),
      full_address: text(address.city) + text(address.district) + text(address.address) } };
}

export function buildEsliteAccountTemplate({ member, addresses, payment, deliveryProfile = {}, pickupProfile = {}, existingTemplate }) {
  if (!['seven_cod', 'virtual_atm_home'].includes(payment)) throw setupError('尚未設定支援的付款方式');
  if (!Array.isArray(addresses)) throw setupError('官方配送地址資料格式無法確認', 'unknown');
  const existing = existingTemplate?.paymentMode === payment ? existingTemplate.checkout : null;
  const subscriber = subscriberFromMember(member, addresses, deliveryProfile, existing?.subscriber);
  const recipient = payment === 'virtual_atm_home' ? homeRecipient(addresses, deliveryProfile) : pickupRecipient(addresses, pickupProfile, existing?.recipient);
  return { paymentMode: payment, checkout: {
    payment: payment === 'virtual_atm_home' ? '3' : '8', delivery: payment === 'virtual_atm_home' ? '2' : '5',
    discount_point: 0, subscriber, recipient,
    invoice: existing?.invoice?.type ? structuredClone(existing.invoice) : { type: 'invoice_member_account', company: '', number: '', cellphone_barcode: '',
      citizen_digital_certificate_barcode: '', invoice_city: '', invoice_district: '', invoice_zip: '', invoice_address: '' },
    crm_consent_list: existing?.crm_consent_list || [], utm_url: null, eslite_card_id: existing?.eslite_card_id || '', order_source: 1, check_member_email: ''
  } };
}

export function esliteAtmFallbackTemplate(template, deliveryProfile, reason = '7-11 取貨資料不可用') {
  // Share recipient information only, never another member's identity or token.
  if (!deliveryProfile?.fullName || !/^09\d{8}$/.test(phone(deliveryProfile.phone)) || !deliveryProfile.city
    || !deliveryProfile.district || !/^\d{3,6}$/.test(text(deliveryProfile.postalCode)) || !deliveryProfile.address) {
    throw setupError('7-11 取貨資料不可用，且共用 ATM 宅配資料不完整；未加車、未送單');
  }
  const subscriber = template?.checkout?.subscriber;
  if (!subscriber?.name || subscriber.country !== 'TW' || !/^09\d{8}$/.test(phone(subscriber.mobile?.number))) {
    throw setupError('ATM 備援缺少本帳號會員資料，請先執行帳號檢查；未加車、未送單');
  }
  return { ...structuredClone(template), paymentMode: 'virtual_atm_home', requestedPayment: 'seven_cod',
    paymentFallback: { from: 'seven_cod', to: 'virtual_atm_home', reason },
    checkout: { ...structuredClone(template.checkout), payment: '3', delivery: '2', discount_point: 0,
      recipient: homeRecipient([], deliveryProfile) } };
}

// Captured official frontend 2026-10-12: pay_line=19, delivery=2, cardholder prime.
// A payment code alone is not sufficient. The caller must obtain a fresh official SDK result.
export function esliteLinePayFallbackTemplate(template, deliveryProfile, paymentCode, primeResult) {
  if (primeResult?.status !== 0 || typeof primeResult.prime !== 'string' || !primeResult.prime.trim()) {
    throw setupError('LINE Pay 缺少官方一次性付款憑證，未送單');
  }
  if (!/^\d+$/.test(String(paymentCode || ''))) throw setupError('官方 LINE Pay 付款代碼尚未確認，未送單');
  const home = esliteAtmFallbackTemplate(template, deliveryProfile, '原付款策略不可用');
  return { ...home, paymentMode: 'line_pay_home', requestedPayment: template?.paymentMode,
    paymentFallback: { from: template?.paymentMode, to: 'line_pay_home', reason: '官方已提供宅配 LINE Pay 並取得本次一次性憑證' },
    checkout: { ...home.checkout, payment: String(paymentCode), discount_point: 0,
      cardholder: { prime: primeResult.prime, name: '', remember: false } } };
}

export function resolveEsliteCheckoutSelection({ template, payment, deliveryProfile, pickupUnavailable = false }) {
  const recipient = template?.checkout?.recipient;
  const incompletePickup = template?.paymentMode === 'seven_cod' && recipient
    && (!/^\d{6}$/.test(text(recipient.store?.id)) || !recipient.store?.name || !recipient.store?.address
      || !recipient.name || !/^09\d{8}$/.test(phone(recipient.mobile?.number)));
  if (payment === 'seven_cod' && (pickupUnavailable || incompletePickup || template?.paymentMode === 'virtual_atm_home')) {
    const checkoutTemplate = esliteAtmFallbackTemplate(template, deliveryProfile);
    return { checkoutTemplate, payment: 'virtual_atm_home', requestedPayment: payment, paymentFallback: checkoutTemplate.paymentFallback };
  }
  return { checkoutTemplate: template, payment, requestedPayment: payment };
}

export async function prepareEsliteAccountViaApi({ api, expectedAccount, payment, deliveryProfile, pickupProfile, existingTemplate, pickupUnavailable = false,
  onMember = async () => {}, timeoutMs = 8000 }) {
  const member = await readEsliteMemberDetail(api, { expectedAccount, timeoutMs });
  // Save verified name independently, even if a required shipping field is missing.
  await onMember({ id: String(member.id || ''), uuid: String(member.uuid || ''), name: text(member.name) });
  const addresses = await get(api, '/api/v2/member_address_books', timeoutMs);
  let checkoutTemplate;
  try {
    if (payment === 'seven_cod' && pickupUnavailable) throw Object.assign(setupError('本帳號尚無可用的 7-11 門市驗證資料'), { setupCode: 'pickup_unavailable' });
    checkoutTemplate = buildEsliteAccountTemplate({ member, addresses, payment, deliveryProfile, pickupProfile, existingTemplate });
  } catch (error) {
    // Only a confirmed pickup-data gap may change payment, never API failures or identity mismatches.
    if (payment !== 'seven_cod' || error.setupCode !== 'pickup_unavailable') throw error;
    const atm = buildEsliteAccountTemplate({ member, addresses, payment: 'virtual_atm_home', deliveryProfile,
      existingTemplate: existingTemplate?.checkout ? { ...existingTemplate, paymentMode: 'virtual_atm_home' } : existingTemplate });
    checkoutTemplate = esliteAtmFallbackTemplate(atm, deliveryProfile, error.message);
  }
  const cart = await get(api, '/api/v2/cart/items?type=shopping&step=1', timeoutMs);
  if (!Array.isArray(cart?.cart?.cart_items)) throw setupError('購物車資料格式無法確認；未清車、未送單', 'unknown');
  return { checkoutTemplate, cartEmpty: cart.cart.cart_items.length === 0 };
}
