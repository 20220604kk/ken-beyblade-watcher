export function optionalDelayMs(value, fallbackMs) {
  if (value === null || value === undefined || value === '') return fallbackMs;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallbackMs;
}

export function fixedCadenceRemainingMs(intervalMs, startedAtMs, nowMs = Date.now()) {
  const interval = Math.max(0, Number(intervalMs) || 0);
  const startedAt = Number(startedAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return interval;
  return Math.max(0, interval - Math.max(0, now - startedAt));
}
