// Operational text only. Purchase records, ledgers and checkout evidence never
// pass through this retention policy. Unknown messages are kept conservatively.
export const LOG_RETENTION = Object.freeze({ eventDays: 30, errorDays: 14, systemDays: 14 });
const ERROR = /失敗|錯誤|逾時|超時|限流|阻擋|無法|結果不明|待核對|error|exception|timed?\s*out|HTTP\s*[45]\d\d/i;
const TRANSACTION = /訂單|送單|結帳|付款|轉帳|銀行|ATM|checkout|order[_ -]?(?:id|number|result)|submitted|transaction/i;
const COUNT = /(?:新發現|新品|補貨|庫存變動|通知)\s*[：:]?\s*(\d+)/g;

export function classifyLog(message) {
  const text = String(message || '');
  if (TRANSACTION.test(text)) return { kind: 'transaction', days: null };
  if (ERROR.test(text)) return { kind: 'error', days: LOG_RETENTION.errorDays };
  const counts = [...text.matchAll(COUNT)].map(match => Number(match[1]));
  const scanSummary = /掃描完成|原始\s*\d+\s*件|日亞官方原價：官方定價/.test(text);
  if (scanSummary && counts.length) {
    return counts.some(n => n > 0)
      ? { kind: 'event', days: LOG_RETENTION.eventDays }
      : { kind: 'routine', days: 0 };
  }
  if (/本輪來源讀取\s*\d+\s*件|：讀取\s*\d+\s*件商品[。.]?\s*$|momo 詳細 API 專線確認|誠品來源讀到商品｜|近期已通知相同品項，略過重複推播/.test(text)) {
    return { kind: 'routine', days: 0 };
  }
  if (/首次建立安全基線|新品訊號|庫存變動|補貨|推播送達|商品推播|發現新商品|已售罄，狀態已更新|前台可售.*→/.test(text)) {
    return { kind: 'event', days: LOG_RETENTION.eventDays };
  }
  if (/已啟動|目前停止|控制頁：|守護程式啟動|監控程序|START\b|STOPPED\b|STOP_REQUEST\b|EXIT\b/.test(text)) {
    return { kind: 'system', days: LOG_RETENTION.systemDays };
  }
  return { kind: 'unknown', days: null };
}

export class OperationalLogPolicy {
  constructor({ repeatMs = 300_000, maxKeys = 2000 } = {}) {
    this.repeatMs = repeatMs;
    this.maxKeys = maxKeys;
    this.errors = new Map();
  }

  accept(message, channel = 'system', now = Date.now()) {
    const classification = classifyLog(message);
    if (classification.kind === 'routine') return null;
    if (classification.kind !== 'error') return String(message);
    // Strip only the line timestamp, never account/product IDs or error codes.
    const key = `${channel}:${String(message).replace(/^\[[^\]]+\]\s*/, '')}`;
    const previous = this.errors.get(key);
    if (previous && now - previous.at < this.repeatMs) {
      previous.suppressed++;
      return null;
    }
    this.errors.delete(key);
    this.errors.set(key, { at: now, suppressed: 0 });
    if (this.errors.size > this.maxKeys) this.errors.delete(this.errors.keys().next().value);
    return previous?.suppressed
      ? `${message}（相同錯誤另略過 ${previous.suppressed} 次）`
      : String(message);
  }
}
