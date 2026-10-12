import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { FacebookScanner } from './facebook.js';
import { FormAutoFill } from './form-autofill.js';
import { StateStore } from './state.js';
import { sendNotification } from './notifier.js';
import { Watcher } from './watcher.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'data');
const drillDataDir = path.join(dataDir, 'drill');
const statusFile = path.join(drillDataDir, 'status.json');
const config = JSON.parse(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'));
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const pageConfig = {
  name: '🧪 方芳爸爸測試小頁面（突襲演練）',
  url: 'https://www.facebook.com/profile.php?id=61591565777499',
  nameMode: 'manual'
};
const intervalSeconds = 5;
const scannerConfig = {
  ...config,
  browserHeadless: true,
  pageLoadSeconds: 4,
  formClaimPerPost: true,
  maxPostsPerPage: Math.max(5, Number(config.maxPostsPerPage || 0)),
  notifyExistingRelevantPostsOnFirstRun: false,
  pages: [pageConfig]
};

await fs.mkdir(drillDataDir, { recursive: true });
const state = new StateStore(drillDataDir);
await state.load();
const runtime = {
  armed: false,
  page: pageConfig,
  intervalSeconds,
  startedAt: new Date().toISOString(),
  lastScan: null,
  lastError: null,
  lastFormResult: null,
  logs: []
};

let statusWriteQueue = Promise.resolve();

function saveStatus() {
  const payload = `${JSON.stringify(runtime, null, 2)}\n`;
  const write = statusWriteQueue.then(async () => {
    const temporary = `${statusFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, payload, 'utf8');
    await fs.rename(temporary, statusFile);
  });
  statusWriteQueue = write.catch(() => {});
  return write;
}

function log(message) {
  const line = `[${new Date().toLocaleString('zh-TW')}] ${message}`;
  runtime.logs.unshift(line);
  runtime.logs = runtime.logs.slice(0, 100);
  console.log(line);
  saveStatus().catch(() => {});
}

function setStatus(patch) {
  Object.assign(runtime, patch);
  saveStatus().catch(() => {});
}

// 演練狀態與正式監控隔離，但重用目前未被背景監控占用的已登入 Facebook 設定檔。
// 正式監控使用 facebook-public-monitor-profile，因此兩個 Chromium 不會搶同一個目錄。
const scanner = new FacebookScanner({
  dataDir: drillDataDir,
  config: scannerConfig,
  log,
  publicProfileDir: path.join(dataDir, 'facebook-profile')
});
const formAutoFill = new FormAutoFill({ dataDir, config: scannerConfig, log });
await formAutoFill.load();
await Promise.all([
  formAutoFill.prewarm(),
  formAutoFill.testAIConnection()
]);
const watcher = new Watcher({
  config: scannerConfig,
  scanner,
  state,
  log,
  setStatus,
  onPageDetected: async () => {},
  onNewRelevantPost: async (post) => {
    const result = await formAutoFill.prepareForm(post.formUrls[0], { autoSubmit: true, contextId: post.id });
    runtime.lastFormResult = {
      at: result.at,
      requestedUrl: result.requestedUrl,
      resolvedUrl: result.url,
      status: result.status,
      submitted: result.submitted,
      filled: result.filled.map(({ field, label }) => ({ field, label })),
      uncertain: result.uncertain,
      durationMs: result.durationMs,
      ai: result.ai
    };
    await saveStatus();
    const message = result.submitted
      ? `✅ 突襲演練成功：測試表單已自動送出一次\n時間：${new Date().toLocaleString('zh-TW')}\n已確認 Google 成功頁。`
      : result.status === 'closed' || result.status === 'unpublished'
        ? `🔴 突襲演練：測試表單無法填寫（${result.status}），未送出。`
        : `🟡 突襲演練：已預填 ${result.filled.length} 欄，仍有 ${result.uncertain.length} 題需要確認，未送出。`;
    try {
      await sendNotification(message);
    } catch (error) {
      log(`演練結果通知失敗：${error.message}`);
    }
    if (result.submitted || ['closed', 'unpublished'].includes(result.status)) await formAutoFill.close();
    else if (result.status === 'open' && result.uncertain.length) {
      formAutoFill.showCurrentForm().catch((error) => log(`開啟演練人工確認表單失敗：${error.message}`));
    }
    return result;
  }
});

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  runtime.armed = false;
  runtime.stoppedAt = new Date().toISOString();
  runtime.stopReason = reason;
  await saveStatus().catch(() => {});
  await scanner.close().catch(() => {});
  if (!runtime.lastFormResult || runtime.lastFormResult.submitted) await formAutoFill.close().catch(() => {});
}

process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
process.on('uncaughtException', (error) => {
  log(`未處理錯誤：${error.stack || error.message}`);
  shutdown('uncaughtException').finally(() => process.exit(1));
});

// 先直接讀取目前貼文並逐篇封存表單。演練使用「貼文＋表單網址」作為唯一鍵，
// 因此新貼文即使重用同一張測試表單，也仍會被視為新的突襲事件。
const baselineRead = await scanner.scanPage(pageConfig, {
  pageLoadSeconds: scannerConfig.pageLoadSeconds,
  workerKey: 'drill',
  fastNavigation: true
});
for (const post of baselineRead.posts) {
  state.mark(post.id, {
    pageName: post.pageName,
    postUrl: post.postUrl,
    relevant: post.relevant,
    formUrls: post.formUrls,
    matchedKeywords: post.matchedKeywords,
    publishedLabel: post.publishedLabel,
    ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
    firstDetectedAt: post.detectedAt,
    lastDetectedAt: post.detectedAt,
    isToday: post.isToday
  });
  for (const formUrl of post.formUrls) {
    state.completeForm(`${post.id}::${formUrl}`, {
      formUrl,
      postId: post.id,
      status: 'legacy_seen',
      baseline: true
    });
  }
}
state.initializePage(pageConfig.url);
await state.save();
runtime.armed = true;
runtime.baselineAt = new Date().toISOString();
runtime.baselineChecked = baselineRead.posts.length;
await saveStatus();
log(`突襲演練通道已武裝：每 ${intervalSeconds} 秒檢查「${pageConfig.name}」；DeepSeek 與背景填表已預熱。`);

while (!stopping) {
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  try {
    const result = await watcher.scanAll({
      pages: [pageConfig],
      channel: 'drill',
      pageLoadSeconds: scannerConfig.pageLoadSeconds
    });
    runtime.lastScan = { ...result, completedAt: new Date().toISOString() };
    runtime.lastError = result.errors?.length ? result.errors.join('\n') : null;
  } catch (error) {
    runtime.lastError = error.message;
    log(`演練掃描失敗：${error.message}`);
  }
  await saveStatus();
}
