export function parseScanInterval(value) {
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 5 || interval > 1440) {
    throw new Error('掃描間隔必須是 5～1440 分鐘的整數');
  }
  return interval;
}

export function parseHotspotInterval(value) {
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 5 || interval > 300) {
    throw new Error('熱點掃描間隔必須是 5～300 秒的整數');
  }
  return interval;
}

export function parseFunboxInterval(value) {
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 2 || interval > 3600) {
    throw new Error('Funbox 掃描間隔必須是 2～3600 秒的整數');
  }
  return interval;
}

export function parseTimeValue(value) {
  const time = String(value || '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('監控時間格式必須是 HH:MM');
  }
  return time;
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isWithinActiveHours(date, start, end) {
  const current = date.getHours() * 60 + date.getMinutes();
  const startMinutes = timeToMinutes(parseTimeValue(start));
  const endMinutes = timeToMinutes(parseTimeValue(end));
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return current >= startMinutes && current < endMinutes;
  return current >= startMinutes || current < endMinutes;
}

export function millisecondsUntilActiveStart(date, start) {
  const startMinutes = timeToMinutes(parseTimeValue(start));
  const target = new Date(date);
  target.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  if (target <= date) target.setDate(target.getDate() + 1);
  return target.getTime() - date.getTime();
}

export function isMmToyShoppingTarget(target) {
  if (String(target?.sourceType || '') === 'mmtoy-category') return true;
  try {
    return new URL(String(target?.url || '')).hostname.toLowerCase() === 'mmtoyshop.com';
  } catch {
    return false;
  }
}

export function shoppingActiveHoursForTarget(target, generalHours) {
  const fallback = { start: '09:00', end: '22:00' };
  if (target?.scheduleMode === 'custom' && target?.activeHours) {
    return {
      start: parseTimeValue(target.activeHours.start),
      end: parseTimeValue(target.activeHours.end)
    };
  }
  return { ...(generalHours || fallback) };
}

export function selectFacebookModePages(
  pages,
  { hotspotEnabled = false, hotspotActive = false, hotspotPageUrls = [] } = {}
) {
  const activePages = (Array.isArray(pages) ? pages : []).filter((page) => page.enabled !== false);
  if (!hotspotEnabled || !hotspotActive) {
    return { regularPages: activePages, hotspotPages: [] };
  }

  const selectedUrls = new Set((Array.isArray(hotspotPageUrls) ? hotspotPageUrls : []).map(String));
  return {
    regularPages: activePages.filter((page) => !selectedUrls.has(page.url)),
    hotspotPages: activePages.filter((page) => selectedUrls.has(page.url))
  };
}

export function normalizeFacebookPage(input, existingPages = []) {
  const rawName = String(input?.name || '').trim();
  const rawUrl = String(input?.url || '').trim();
  if (!rawUrl) throw new Error('請輸入 Facebook 粉絲專頁網址');

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Facebook 網址格式不正確');
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(hostname)) {
    throw new Error('只允許 https://www.facebook.com 的粉絲專頁網址');
  }

  url.hostname = 'www.facebook.com';
  url.hash = '';
  ['fbclid', 'mibextid', 'ref'].forEach((key) => url.searchParams.delete(key));
  const normalizedUrl = url.toString();
  if (existingPages.some((page) => page.url === normalizedUrl)) {
    throw new Error('這個粉絲專頁已經在監控清單中');
  }

  return {
    name: rawName || `Facebook 粉絲頁 ${existingPages.length + 1}`,
    url: normalizedUrl,
    nameMode: rawName ? 'manual' : 'auto',
    enabled: true
  };
}

export function parsePageNickname(value) {
  const nickname = String(value || '').trim();
  if (!nickname) throw new Error('暱稱不能留空；若要使用粉專名稱，請按「自動抓取名稱」');
  if (nickname.length > 80) throw new Error('暱稱最多 80 個字元');
  return nickname;
}

export function parseKeywordList(value, label = '命中詞') {
  if (!Array.isArray(value)) throw new Error(`${label}格式不正確`);
  const keywords = [];
  const seen = new Set();
  for (const item of value) {
    const keyword = String(item || '').trim();
    if (!keyword) continue;
    if (keyword.length > 60) throw new Error(`${label}每個詞最多 60 個字元`);
    const key = keyword.toLocaleLowerCase('zh-TW');
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
  }
  if (!keywords.length) throw new Error(`${label}至少要保留一個`);
  if (keywords.length > 100) throw new Error(`${label}最多 100 個`);
  return keywords;
}
