const samples = [];
let sent = 0;
let failed = 0;
export function recordNotificationDuration(durationMs, ok) {
  if (ok) sent += 1; else failed += 1;
  samples.push({ ms: Math.round(durationMs), ok, at: new Date().toISOString() });
  if (samples.length > 100) samples.shift();
}
export function notificationMetrics() {
  const success = samples.filter(sample => sample.ok).map(sample => sample.ms).sort((a,b) => a-b);
  return {
    sent, failed, sampleCount: success.length,
    last: samples.at(-1) || null,
    p95Ms: success.length ? success[Math.ceil(success.length * 0.95) - 1] : null
  };
}
