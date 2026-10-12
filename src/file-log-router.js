import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const logRoot = path.join(projectRoot, 'logs');
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
});
const createdDirectories = new Set();

const SHOPPING_RULES = [
  { label: '蝦皮-FUNBOX', pattern: /蝦皮|shopee/i },
  { label: '誠品線上', pattern: /誠品|eslite/i },
  { label: 'MM小舖-已停用', pattern: /MM小舖|M\.M小舖|mmtoy/i },
  { label: '童無忌', pattern: /童無忌|twj\.tw/i },
  { label: '森森文具', pattern: /森森文具|sensen/i },
  { label: '墊腳石', pattern: /墊腳石|tcsb|kingstone/i },
  { label: 'momo購物網', pattern: /momo/i },
  { label: 'FUNBOX官網', pattern: /funbox/i }
];

const JAPAN_RULES = [
  { label: '1999', pattern: /1999\.co\.jp|1999/i },
  { label: '樂天', pattern: /樂天|rakuten/i },
  { label: 'EDION', pattern: /edion/i },
  { label: 'Amazon-JP', pattern: /amazon|日亞/i }
];

function firstMatch(rules, message, fallback) {
  return rules.find((rule) => rule.pattern.test(message))?.label || fallback;
}

export function logDestinationFor(message, channel = 'system') {
  const text = String(message || '');
  if (channel === 'funbox') return { section: 'Funbox官網', label: '監控' };
  if (channel === 'shopping') {
    return { section: '購物網站', label: firstMatch(SHOPPING_RULES, text, '其他購物網站') };
  }
  if (channel === 'japan') {
    return { section: '日本網站', label: firstMatch(JAPAN_RULES, text, '其他日本網站') };
  }
  if (channel === 'regular') return { section: 'Facebook', label: '常態掃描' };
  if (channel === 'hotspot') return { section: 'Facebook', label: '熱點掃描' };

  const shopping = firstMatch(SHOPPING_RULES, text, '');
  if (shopping) return { section: '購物網站', label: shopping };
  const japan = firstMatch(JAPAN_RULES, text, '');
  if (japan) return { section: '日本網站', label: japan };
  return { section: '系統', label: '一般' };
}

export function taipeiDateKey(date = new Date()) {
  const parts = dateFormatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function routedLogFile(message, channel = 'system', date = new Date()) {
  const destination = logDestinationFor(message, channel);
  return path.join(logRoot, destination.section, destination.label, `${taipeiDateKey(date)}.log`);
}

export function appendRoutedLog(line, { message = line, channel = 'system', date = new Date() } = {}) {
  const file = routedLogFile(message, channel, date);
  const directory = path.dirname(file);
  if (!createdDirectories.has(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    createdDirectories.add(directory);
  }
  try {
    fs.appendFileSync(file, `${String(line).replace(/[\r\n]+$/g, '')}\n`, 'utf8');
  } catch (error) {
    createdDirectories.delete(directory);
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(file, `${String(line).replace(/[\r\n]+$/g, '')}\n`, 'utf8');
  }
  return file;
}
