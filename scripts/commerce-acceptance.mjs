import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acceptanceGroups, manualGates } from './commerce-acceptance-manifest.mjs';
import { loadHistoricalFixture, replayRestock, assertReplayInvariants } from './commerce-restock-replay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(a => !['--runtime', '--help'].includes(a))) throw Error('只接受 --runtime 或 --help；本套件沒有真實送單入口。');
if (args.includes('--help')) {
  console.log('node scripts/commerce-acceptance.mjs [--runtime]\n完全離線測試 + 18種共享庫存模型。--runtime 額外只 GET 本機3210狀態，不呼叫官網。');
  process.exit(0);
}
const timestamp = new Date().toISOString().replaceAll(':', '-');
const directory = path.join(root, 'artifacts', 'commerce-acceptance', timestamp);
await fs.mkdir(directory, { recursive: true });
const start = Date.now(), groups = [], environment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT)$/i.test(key)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
for (const file of (await fs.readdir(path.join(root, 'src'))).filter(f => f.endsWith('.js')).sort())
  sourceHashes['src/' + file] = hash(await fs.readFile(path.join(root, 'src', file)));
for (const file of acceptanceGroups.flatMap(g => g.files))
  sourceHashes['test/' + file] = hash(await fs.readFile(path.join(root, 'test', file)));
for (const file of ['commerce-acceptance.mjs', 'commerce-acceptance-guard.mjs', 'commerce-acceptance-reporter.mjs', 'commerce-restock-replay.mjs', 'commerce-acceptance-manifest.mjs'])
  sourceHashes['scripts/' + file] = hash(await fs.readFile(path.join(root, 'scripts', file)));
for (const file of ['FUNBOX_2026-09-04_多品項補貨模擬基準.md', '誠品_2026-10-08_策展補貨模擬基準.md'])
  sourceHashes['docs/restock-reference-for-ai/' + file] = hash(await fs.readFile(path.join(root, 'docs', 'restock-reference-for-ai', file)));

async function runGroup(group) {
  const tests = []; let pending = '', stderrBytes = 0, stdoutBytes = 0, malformed = 0, timedOut = false;
  const began = Date.now();
  const child = spawn(process.execPath, ['--import', './scripts/commerce-acceptance-guard.mjs', '--test', '--test-concurrency=2',
    '--test-reporter=./scripts/commerce-acceptance-reporter.mjs', ...group.files.map(f => 'test/' + f)],
  { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBytes += Buffer.byteLength(chunk); pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines.filter(Boolean)) {
      try { const event = JSON.parse(line); event.file = event.file ? path.relative(root, event.file).replaceAll('\\', '/') : ''; tests.push(event); }
      catch { malformed++; }
    }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; }); // Never export raw diagnostics that might contain an assertion's data.
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); clearTimeout(timer);
  if (pending.trim()) malformed++;
  const passed = tests.filter(t => t.type === 'test:pass' && !t.skipped && !t.todo).length;
  const failed = tests.filter(t => t.type === 'test:fail').length;
  const skipped = tests.filter(t => t.skipped || t.todo).length;
  const result = { id: group.id, name: group.name, files: group.files, exitCode, timedOut, durationMs: Date.now() - began,
    passed, failed, skipped, malformed, stderrBytes, stdoutBytes, status: exitCode === 0 && !failed && !skipped && passed > 0 && !malformed ? 'pass' : 'fail', tests };
  console.log(`${result.status === 'pass' ? '通過' : '未通過'}｜${group.name}｜${passed} 成功 / ${failed} 失敗 / ${skipped} 略過`);
  await fs.writeFile(path.join(directory, group.id + '.json'), JSON.stringify(result, null, 2)); return result;
}
for (const group of acceptanceGroups) groups.push(await runGroup(group));

const replays = [];
for (const platform of ['funbox', 'eslite']) {
  const fixture = await loadHistoricalFixture(platform);
  for (const profile of ['smooth', 'late', 'congested']) for (const mode of ['single', 'batch', 'mixed']) {
    const result = replayRestock(fixture, { platform, profile, mode }); assertReplayInvariants(result); replays.push(result);
  }
}
await fs.writeFile(path.join(directory, 'shared-stock-replays.json'), JSON.stringify(replays, null, 2));
let runtime = { status: 'not_run', note: '未指定 --runtime；沒有讀取正式服務。' };
if (args.includes('--runtime')) {
  try {
    const response = await fetch('http://127.0.0.1:3210/api/status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('本機狀態 HTTP ' + response.status);
    const state = await response.json(), purchase = state.autoPurchase || {};
    const flag = value => typeof value === 'boolean' ? value : null;
    runtime = { status: 'read_only_local_snapshot', processing: flag(purchase.processing), queued: purchase.queued == null ? null : Number(purchase.queued),
      platforms: Object.fromEntries(['funbox', 'eslite'].map(platform => [platform, (purchase.runtime?.[platform]?.accounts || []).map(account => ({
        slot: account.slot || account.accountSlot, state: account.state, loginState: account.loginState,
        apiReady: flag(account.apiReady), busy: flag(account.busy), interactiveLoginOpen: flag(account.interactiveLoginOpen)
      }))])), note: '僅讀本機標籤，不是本輪官方會員 API 驗證或下单證據。' };
  } catch (error) { runtime = { status: 'unavailable', note: '本機唯讀狀態無法取得；不啟動服務、不登入、不修改設定。' }; }
}
const changedFiles = [];
for (const [file, previousHash] of Object.entries(sourceHashes))
  if (hash(await fs.readFile(path.join(root, file))) !== previousHash) changedFiles.push(file);
const offlinePassed = groups.every(g => g.status === 'pass') && !changedFiles.length;
const report = { version: 1, timestamp, node: process.version, durationMs: Date.now() - start, sourceHashes,
  sourceVersionStable: !changedFiles.length, changedFiles,
  scope: 'offline_regression_and_synthetic_model', safety: { realOrderCalls: 0, realPaymentCalls: 0, realNotifications: 0,
    guard: 'Blocks external Node network, production3210 in child, common secret reads/writes and browser spawn; not an OS sandbox.' },
  verdict: changedFiles.length ? 'SOURCE_CHANGED_RERUN' : offlinePassed ? 'OFFLINE_PASS_LIVE_NOT_VERIFIED' : 'OFFLINE_FAIL',
  passed: groups.reduce((n, g) => n + g.passed, 0), failed: groups.reduce((n, g) => n + g.failed, 0), skipped: groups.reduce((n, g) => n + g.skipped, 0),
  groups, runtime, manualGates, modelCount: replays.length };
await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
const rows = groups.map(g => `| ${g.name} | ${g.status === 'pass' ? '通過' : '未通過'} | ${g.passed} | ${g.failed} | ${g.skipped} | ${(g.durationMs / 1000).toFixed(1)}s |`).join('\n');
const modelRows = replays.map(r => `| ${r.platform} | ${r.profile} | ${r.mode} | ${r.accounts.map(a => a.orderCount).join(' / ')} | ${r.orders.length} | ${r.orders.reduce((n, o) => n + o.quantity, 0)} |`).join('\n');
const failures = groups.flatMap(g => g.tests.filter(t => t.type === 'test:fail').map(t => `- ${g.id}：${t.name}（${t.file}:${t.line || '?'}；${t.errorCode}）`));
const markdown = `# FUNBOX／誠品多角度驗收報告\n\n時間：${timestamp}；Node ${process.version}。\n\n**結論：${report.verdict}**\n\n本次只驗證離線行為及模型；官網可用性、真實付款門市與真實補貨成交尚未因此通過。沒有執行官網請求、送單或通知。\n\n## 六面向回歸\n\n| 面向 | 結果 | 通過 | 失敗 | 略過 | 耗時 |\n|---|---|---:|---:|---:|---|\n${rows}\n\n共 ${report.passed} 通過、${report.failed} 失敗、${report.skipped} 略過。每個測試檔只執行一次；分組時間不是官方下單時間。\n\n## 18 種共享庫存策略模型\n\n以下數字是 SIM 假單，不是當日回推成交量，也不是下次成功預測。延遲、競品消耗、每件100元、運費120元、120秒售罄均為人工設定。誠品庫存取歷史快照，FUNBOX庫存是假設；A誠品已買UX-03亦是假設。同毫秒A先B後C有模型偏差。\n\n| 平台 | 情況 | 模式 | A / B / C 假單 | 假單合計 | 件數 |\n|---|---|---|---|---:|---:|\n${modelRows}\n\n完整時間線、派單順序、略過原因、假單及設定：shared-stock-replays.json。正式執行器的 mock API 回歸見 checkout/identity/recovery 分組，不以模型代替。\n\n## 尚須另驗收的關卡\n\n${manualGates.map(g => `- ${g.id}｜${g.status}｜${g.name}：${g.evidence}`).join('\n')}\n\n## 失敗定位\n\n${failures.join('\n') || '沒有測試案例失敗。若分組未通過但沒有案例名稱，檢查 exitCode、timedOut、malformed 與 stderrBytes；原始錯誤資料不匯出。'}\n\n## 證據\n\nreport.json：版本雜湊、逐項結果、未驗收關卡、本機唯讀狀態（如有）。各分組JSON：案例、檔案、行號、執行時間。不得把本機 apiReady 標籤當本輪官網驗證。\n`;
await fs.writeFile(path.join(directory, 'REPORT.md'), markdown);
await fs.writeFile(path.join(directory, 'SUMMARY.txt'), `結果：${report.verdict}\r\n${report.passed} 通過／${report.failed} 失敗／${report.skipped} 略過\r\n18種模型；實單0；官網狀態未驗收\r\n報告：${directory}\r\n`, 'utf8');
await fs.writeFile(path.join(root, 'artifacts', 'commerce-acceptance', 'latest.json'), JSON.stringify({ timestamp, directory, verdict: report.verdict }, null, 2));
console.log(`\n報告：${path.join(directory, 'REPORT.md')}\n結果：${report.verdict}（不代表官網／實單通過）`);
process.exitCode = offlinePassed ? 0 : 1;
