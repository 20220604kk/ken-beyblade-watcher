import { assertFunboxCheckoutRows } from './funbox-cart.js';

const TELEMETRY_HOSTS = new Set(['www.googletagmanager.com', 'www.google-analytics.com',
  'googleads.g.doubleclick.net', 'connect.facebook.net', 'www.clarity.ms', 'scripts.clarity.ms']);
export function isFunboxCheckoutTelemetry(url) {
  try { return TELEMETRY_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

export async function installFunboxCheckoutResourcePolicy(page) {
  // This page belongs to the background checkout worker only. Keep every
  // unknown script, stylesheet, image, authentication and payment request.
  await page.route('**/*', route => isFunboxCheckoutTelemetry(route.request().url())
    ? route.abort() : route.fallback());
}

export async function captureFunboxCheckoutHtml(page) {
  // page.content() serializes default HTML attributes, not live form values.
  // Clone the DOM and record current values without mutating the checkout.
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    const selector = 'input,select,textarea';
    const originals = document.querySelectorAll(selector), copies = clone.querySelectorAll(selector);
    originals.forEach((element, index) => {
      const copy = copies[index];
      if (element.tagName === 'SELECT') {
        [...element.options].forEach((option, optionIndex) => {
          const target = copy.options[optionIndex];
          if (option.selected) target.setAttribute('selected', '');
          else target.removeAttribute('selected');
        });
      } else if (element.tagName === 'TEXTAREA') copy.textContent = element.value;
      else {
        copy.setAttribute('value', element.value);
        if (['checkbox', 'radio'].includes(element.type)) {
          if (element.checked) copy.setAttribute('checked', '');
          else copy.removeAttribute('checked');
        }
      }
    });
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  });
}

export const FUNBOX_CONTACT_FIELDS = {
  'order[billing_address_attributes][name]': 'fullName',
  'order[billing_address_attributes][phone]': 'phone',
  'order[billing_address_attributes][city]': 'city',
  'order[billing_address_attributes][district]': 'district',
  'order[billing_address_attributes][zip]': 'postalCode',
  'order[billing_address_attributes][address1]': 'address',
  'order[shipping_address_attributes][name]': 'fullName',
  'order[shipping_address_attributes][phone]': 'phone'
};

export function validateFunboxDeliveryProfile(profile) {
  if (!profile?.fullName || !/^09\d{8}$/.test(profile.phone) || !profile.city
    || !profile.district || !/^\d{3,5}$/.test(profile.postalCode) || !profile.address) {
    throw new Error('尚未設定完整的 Funbox 宅配收件資料');
  }
}

// Read all rendered cart rows in one browser round trip. The authoritative API
// has already set exact quantities: never repair a mismatch via debounced UI
// mutations while racing checkout.
export async function verifyFunboxRenderedCart(page, expected) {
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('tr.line-item')]
      .filter(row => row.querySelector('input[data-testid="quantity-input"]'));
    return rows.length > 0 && rows.every(row => row.querySelector('a[href*="/products/"]'));
  }, null, { timeout: 12000 });
  const rows = await page.locator('tr.line-item:has(input[data-testid="quantity-input"])').evaluateAll(rows =>
    rows.map(row => ({ url: row.querySelector('a[href*="/products/"]')?.getAttribute('href'),
      quantity: Number(row.querySelector('input[data-testid="quantity-input"]')?.value) })));
  assertFunboxCheckoutRows(rows, expected);
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

export async function fillFunboxHomeContact(page, profile) {
  validateFunboxDeliveryProfile(profile);
  for (const [name, key] of Object.entries(FUNBOX_CONTACT_FIELDS)) {
    const field = page.locator(`[name="${name}"]:visible`).first();
    const wanted = String(profile[key]);
    await field.waitFor({ state: 'visible', timeout: 5000 });
    if (name.endsWith('[city]') || name.endsWith('[district]')) {
      // selectOption waits for an asynchronously rebuilt district option. A
      // fixed delay after city selection is neither necessary nor sufficient.
      const selected = await field.evaluate(element => element.selectedOptions[0]?.textContent?.trim());
      if (selected !== wanted) await field.selectOption({ label: wanted });
    } else if (await field.inputValue() !== wanted) {
      await field.fill(wanted);
    }
    // The official AddressForm commits phone to React state onBlur, not on
    // input. The last phone may still be focused when bonus is already zero;
    // explicitly commit even when its visible defaultValue was already right.
    if (key === 'phone') {
      await field.focus();
      await field.blur();
    }
  }
}

export function assertFunboxAtmContactSnapshot(snapshot, profile) {
  validateFunboxDeliveryProfile(profile);
  if (snapshot.paymentService !== 'cyberbizpay_atm' || !snapshot.paymentId || !snapshot.shippingRate) {
    throw new Error('Funbox ATM／宅配付款欄位尚未套用，已停止送單');
  }
  const noBonusFacility = snapshot.bonusUsed === undefined && snapshot.bonusInputPresent === false;
  if (!noBonusFacility && snapshot.bonusUsed !== '0') throw new Error('Funbox 紅利折抵尚未歸零，已停止送單');
  for (const [name, key] of Object.entries(FUNBOX_CONTACT_FIELDS)) {
    const values = snapshot.fields[name];
    if (!Array.isArray(values) || !values.length || values.some(value => value !== String(profile[key]))) {
      // Never put names, addresses or phone numbers in diagnostics.
      throw new Error(`Funbox 宅配資料尚未正確套用：${name}`);
    }
  }
  for (const key of ['city', 'district', 'zip', 'address1']) {
    const name = `order[shipping_address_attributes][${key}]`;
    const values = snapshot.fields[name];
    const profileKey = { zip: 'postalCode', address1: 'address' }[key] || key;
    if (!values?.length || values.some(value => value !== String(profile[profileKey]))) {
      throw new Error(`Funbox 收件地址尚未正確套用：${name}`);
    }
  }
}

export async function verifyFunboxAtmContact(page, profile) {
  const snapshot = await page.evaluate(() => {
    const fields = {};
    for (const element of document.querySelectorAll('input[name], select[name]')) {
      if (!/^order\[(billing|shipping)_address_attributes\]/.test(element.name)) continue;
      (fields[element.name] ||= []).push(String(element.value));
    }
    return { fields, paymentService: document.querySelector('#order_payment_service')?.value,
      paymentId: document.querySelector('[name="order[payment_id]"]')?.value,
      shippingRate: document.querySelector('[name="order[shipping_rate]"]')?.value,
      bonusUsed: document.querySelector('input[name="bonus_used"]')?.value,
      bonusInputPresent: Boolean(document.querySelector('#bonus-for-use, input[aria-label="請輸入會員紅利折抵點數"]')) };
  });
  assertFunboxAtmContactSnapshot(snapshot, profile);
}
