// Research only: reads the local dashboard and public product timing fields.
// Never changes settings, talks to Amazon, reads cookies or submits a purchase.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const seconds = Math.max(10, Math.min(60, Number(process.argv[2]) || 55));
const started = Date.now(), scans = new Map(), lanes = new Map(), products = new Map();
let initial, last, localReads = 0, stopReason = 'completed';
while (Date.now() - started < seconds * 1000) {
  const response = await fetch('http://127.0.0.1:3210/api/status', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) { stopReason = 'local_status_unavailable'; break; }
  localReads++;
  const status = await response.json(), amazon = status.japanAuctions?.amazonJp;
  if (!amazon) { stopReason = 'amazon_status_missing'; break; }
  const current = { effectiveIntervalSeconds: amazon.effectiveIntervalSeconds, cadenceMode: amazon.cadenceMode,
    failureCount: amazon.failureCount, manualCount: amazon.manualProductCount, knownCount: amazon.lastKnownCount,
    directSelectionCount: amazon.lastDirectCheckedCount };
  initial ||= current; last = current;
  if (amazon.lastScan?.checkedAt) scans.set(amazon.lastScan.checkedAt, {
    at: amazon.lastScan.checkedAt, durationMs: amazon.lastScan.durationMs,
    selectedDirect: amazon.lastScan.directCheckedCount, candidates: amazon.lastScan.candidateCount,
    notifications: amazon.lastScan.notified });
  for (const lane of status.japanAuctions.amazonJpProductOrders || []) {
    if (!lanes.has(lane.slot)) lanes.set(lane.slot, new Map());
    if (lane.phase === 'ordering' || lane.apiTransactionStatus) {
      stopReason = 'purchase_started_no_interference'; break;
    }
    if (lane.lastCheckedAt) lanes.get(lane.slot).set(lane.lastCheckedAt, {
      at: lane.lastCheckedAt, asin: lane.targetProduct?.asin, enabled: lane.enabled,
      targetInterval: lane.pollIntervalSeconds, quoteMs: lane.lastSnapshot?.diagnostic?.quoteMs ?? null,
      result: lane.lastSnapshot?.evaluation, status: lane.status });
  }
  // Only public ASINs and timestamps are selected from local state.
  const state = JSON.parse(await fs.readFile('data/state.json','utf8'));
  const storage = state.commerce?.amazonJp || {};
  for (const asin of Object.keys(storage.manualProducts || {})) {
    if (!products.has(asin)) products.set(asin, new Set());
    const at = storage.products?.[asin]?.lastOfferCheckedAt;
    if (at) products.get(asin).add(at);
  }
  if (stopReason !== 'completed') break;
  await delay(1000);
}
const percentile = (values,p) => values.length ? values.toSorted((a,b)=>a-b)[Math.ceil(values.length*p)-1] : null;
const intervals = rows => rows.slice(1).map((row,i)=>Date.parse(row.at)-Date.parse(rows[i].at));
const laneReports = [...lanes].map(([slot,values])=> {
  const rows = [...values.values()], gaps = intervals(rows), quotes = rows.filter(x=>Number.isFinite(x.quoteMs)).map(x=>x.quoteMs);
  return { slot, samples: rows.length, enabled: rows.at(-1)?.enabled, targetIntervalSeconds: rows.at(-1)?.targetInterval,
    intervalMs: { p50: percentile(gaps,.5),p95: percentile(gaps,.95) },
    quoteMs: { p50: percentile(quotes,.5),p95: percentile(quotes,.95) }, rows };
});
const scanRows = [...scans.values()];
const report = { startedAt:new Date(started).toISOString(),endedAt:new Date().toISOString(),stopReason,
  researchOnly:true,requestsAmazon:0,mutations:0,localReads,initial,last,lanes:laneReports,
  scanner: { samples:scanRows.length,durationMs:{p50:percentile(scanRows.map(x=>x.durationMs),.5),p95:percentile(scanRows.map(x=>x.durationMs),.95)},
    intervalMs:{p50:percentile(intervals(scanRows),.5),p95:percentile(intervals(scanRows),.95)},rows:scanRows },
  manualProductChecks:[...products].map(([asin,values])=>({asin,lastSuccessfulProductPageChecks:[...values]})) };
const dir = path.resolve('data/records/amazon-priority-research'); await fs.mkdir(dir,{recursive:true});
const file = path.join(dir,new Date(started).toISOString().replace(/[:.]/g,'-')+'.json');
await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,lanes:laneReports.map(({rows,...lane})=>lane),scanner:{...report.scanner,rows:undefined},file}));
