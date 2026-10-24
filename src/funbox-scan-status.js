// Shared plain-text status for the local dashboard; no inference from quiet logs.
export function funboxScanStatus(status, now = Date.now()) {
  const f = status.funbox || {}, last = f.lastScan || {};
  const time = value => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚無';
  if (status.systemPause?.active) return '已暫停｜全部功能已停止';
  if (!f.enabled) return '已停止｜FUNBOX 監控未啟用';
  if (f.withinActiveHours === false) return '等待監控時段｜下次啟動 ' + time(f.nextScanAt);
  if (f.scanning) return '掃描中｜開始 ' + time(f.scanStartedAt) + '｜最近完成 ' + time(last.completedAt);
  const next = '｜下次 ' + time(f.nextScanAt);
  if (f.lastScanError) return '讀取異常｜最近嘗試 ' + time(f.lastAttemptAt) + next + '｜' + f.lastScanError;
  if (!last.completedAt) return '等待首次完成' + next;
  if (last.errors?.length) return '部分來源失敗｜最近完成 ' + time(last.completedAt) + next;
  if (now - Date.parse(last.completedAt) > Math.max(30_000, (f.effectiveIntervalSeconds || 2) * 5000)) {
    return '完成紀錄過久，請查看錯誤｜最近完成 ' + time(last.completedAt) + next;
  }
  return '掃描正常｜最近完成 ' + time(last.completedAt) + next
    + '｜追蹤 ' + (last.checked || 0) + ' 件／排除 ' + (last.skipped || 0) + ' 件';
}
