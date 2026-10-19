// Observes existing A-lane status only. Never starts tasks or requests Amazon.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const seconds = Math.max(5, Math.min(60, Number(process.argv[2]) || 30));
const label = String(process.argv[3] || 'observation').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
const started = Date.now(), rows = [], seen = new Set(); let stopReason = 'duration_complete', asin;
while (Date.now() - started < seconds * 1000) {
  const response = await fetch('http://127.0.0.1:3210/api/status', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) { stopReason = 'dashboard_unavailable'; break; }
  const s = await response.json(), a = s.japanAuctions?.amazonJpProductOrders?.find(x => x.slot === 'A');
  if (!a || !a.enabled) { stopReason = 'A_not_enabled'; break; }
  const configured = a.targetUrl?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  asin ||= configured;
  if (configured !== asin) { stopReason = 'target_changed'; break; }
  if (a.phase === 'ordering' || a.apiTransactionStatus) { stopReason = 'purchase_in_progress_no_interference'; break; }
  if (a.backoffUntil && Date.parse(a.backoffUntil) > Date.now()) { stopReason = 'official_cooldown'; break; }
  if (['needs_login','needs_verification','needs_review','completed'].includes(a.status)) { stopReason = a.status; break; }
  if (a.lastCheckedAt && !seen.has(a.lastCheckedAt) && a.lastSnapshot?.asin === asin) {
    seen.add(a.lastCheckedAt);
    rows.push({ at: a.lastCheckedAt, observedAt: new Date().toISOString(), refreshCount: a.refreshCount,
      configuredIntervalSeconds: a.pollIntervalSeconds, fastLane: a.fastLane === true,
      quoteMs: a.lastSnapshot?.diagnostic?.quoteMs ?? null, result: a.lastSnapshot?.evaluation });
  }
  await delay(500);
}
const percentile = (values, p) => values.length ? values.toSorted((a,b) => a-b)[Math.ceil(values.length*p)-1] : null;
const intervals = rows.slice(1).map((row,i) => Date.parse(row.at)-Date.parse(rows[i].at));
const quote = rows.filter(row => Number.isFinite(row.quoteMs)).map(row => row.quoteMs);
const report = { label, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), asin,
  readonly: true, requestsAmazon: 0, sendsOrders: 0, stopReason, samples: rows.length,
  completionIntervalMs: { p50: percentile(intervals,.5), p95: percentile(intervals,.95) },
  quoteMs: { p50: percentile(quote,.5), p95: percentile(quote,.95) }, rows };
const dir = path.resolve('data/records/amazon-a-speed'); await fs.mkdir(dir,{recursive:true});
const file = path.join(dir, `${new Date(started).toISOString().replace(/[:.]/g,'-')}-${label}.json`);
await fs.writeFile(file, JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ ...report, rows: undefined, file }));
