import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { OperationalLogPolicy } from './log-policy.js';
import { safePurchaseText } from './purchase-diagnostics.js';
import { catalogListPatch } from './product-sheet-catalog.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { fixedCadenceRemainingMs, optionalDelayMs } from './scheduling.js';
import { FacebookScanner, FormAutoFill, Watcher, enforceFacebookArchive, activeProjectConfig, retireFacebookState } from './facebook-retired.js';
import {
  formatFunboxNotification, funboxDiscordPreview, funboxEmbed, FunboxMonitor,
  FUNBOX_BEYBLADE_SOURCES, FUNBOX_BEYBLADE_URL, normalizeFunboxSimulationProduct,
  parseFunboxProductData, parseFunboxResponse
} from './funbox.js';
import { FunboxSandbox } from './funbox-sandbox.js';
import {
  notificationEmbed, notificationPreview, ShoppingSiteMonitor, shoppingSiteName
} from './shopping-sites.js';
import {
AutoPurchaseCoordinator, MultiAccountEslitePurchaseAdapter, updateAutoPurchaseSettings, mergeAutoPurchaseLists,
  MultiAccountFunboxPurchaseAdapter,
  formatFunboxAccountPurchaseNotification, normalizeAutoPurchaseConfig
} from './auto-purchase.js';
import { LocalCredentialStore } from './credential-store.js';
import { EsliteSessionBridge } from './eslite-session-bridge.js';
import { PurchaseReadinessCheck } from './purchase-readiness.js';
import { PICKUP_SETUP_REQUIRED, verifyFunboxPickupOrder, verifyEslitePickupOrder } from './pickup-setup.js';
import { SaleReminderMonitor, saleReminderListedNotification } from './sale-reminders.js';
import { StateStore } from './state.js';
import { AmazonRaceCoordinator } from './amazon-race-coordinator.js';
import { AmazonRaceBridge } from './amazon-race-bridge.js';
import { DailyDutyNotifier } from './duty-notifications.js';
import {
  DEFAULT_JAPAN_EXCLUDE_KEYWORDS, JAPAN_1999_BEYBLADE_LIST_URL, ensureRakutenMarketTarget,
  JapanAuctionMonitor, japanAuctionFailureDelayMs, japanAuctionTestNotification
} from './japan-auctions.js';
import {
  AmazonJapanMonitor, amazonJapanTestNotification, nextAmazonJapanAdaptiveInterval
} from './amazon-jp-monitor.js';
import { AmazonJpProductOrderMonitor, normalizeAmazonJpProductUrl, normalizeAmazonJpProductMode } from './amazon-jp-product-order.js';
import { AmazonOrderHistory } from './amazon-order-history.js';
import { ensureJapanStoreTargets } from './japan-stores.js';
import { isTcsbSearchTarget, TCSB_BASELINE_VERSION } from './tcsb-monitor.js';
import { checkDiscordConnection, hasDiscordWebhook } from './discord.js';
import {
  syncDiscordSaleBoard,
  syncDiscordStatusChannel
} from './discord-automation.js';
import {
  checkLineConnection, facebookDiscordPreview, facebookPostEmbed, formatPostNotification
} from './line.js';
import {
  checkNotificationConnection, hasNotificationConfig, normalizeNotificationMode,
  notificationAvailability, notificationChannelName, sendNotification
} from './notifier.js';
import { createDashboard } from './dashboard.js';
import { createRuntimeMetrics } from './runtime-metrics.js';
import { ShopeeBridge } from './shopee-bridge.js';
import { EdionBrowserBridge } from './edion-browser-bridge.js';
import { appendRoutedLog, logDestinationFor } from './file-log-router.js';
import {
  isMmToyShoppingTarget, isWithinActiveHours, millisecondsUntilActiveStart, normalizeFacebookPage,
  parseFunboxInterval, parseHotspotInterval, parseKeywordList, parsePageNickname,
  parseScanInterval, parseTimeValue, selectFacebookModePages, shoppingActiveHoursForTarget
} from './settings.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'data');
const configFile = path.join(rootDir, 'config.json');
const lifecycleLogFile = path.join(rootDir, 'logs', '系統', 'service-lifecycle.log');
const ESLITE_EXHIBITION_DISCOVERY_URLS = [
  'https://www.eslite.com/exhibitions/CU202608-00061'
];
const ESLITE_TAKARA_TOMY_SEARCH_URL = 'https://www.eslite.com/Search?keyword=%22beyblade%22&final_price=0,&publishDate=0&sort=_weight_+desc&display=list&start=0&exp=c&brands=WyJUQUtBUkEgVE9NWSJd';
const ESLITE_TAKARA_TOMY_BRAND_SEARCHES = [
  { keyword: '"beyblade"', brands: ['TAKARA TOMY'], maxPages: 1 }
];
fsSync.mkdirSync(path.dirname(lifecycleLogFile), { recursive: true });

function logLifecycle(event, details = '') {
  const line = `[${new Date().toISOString()}] ${event}${details ? ` ${details}` : ''}\n`;
  try {
    if (fsSync.existsSync(lifecycleLogFile) && fsSync.statSync(lifecycleLogFile).size >= 2 * 1024 * 1024) {
      fsSync.renameSync(lifecycleLogFile, lifecycleLogFile.replace('.log', `-${Date.now()}.log`));
    }
    fsSync.appendFileSync(lifecycleLogFile, line, 'utf8');
  } catch {
    // Lifecycle logging must never prevent the monitor from starting.
  }
}

logLifecycle('START', `pid=${process.pid}`);
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
enforceFacebookArchive(config);
const purchaseCredentials = await new LocalCredentialStore(dataDir).load();
for (const [platform, account, password] of [
  ['funbox', process.env.FUNBOX_BUY_EMAIL, process.env.FUNBOX_BUY_PASSWORD],
  ['eslite', process.env.ESLITE_BUY_ACCOUNT, process.env.ESLITE_BUY_PASSWORD],
]) {
  if (!purchaseCredentials.get(platform).account && account && password) {
    await purchaseCredentials.set(platform, { account, password });
  }
}
config.pages ??= [];
config.pages = config.pages.map((page) => ({ ...page, enabled: page.enabled !== false }));
config.browserHeadless = true;
config.monitoringEnabled ??= true;
config.funbox ??= {
  enabled: false,
  intervalSeconds: 30,
  collectionUrl: FUNBOX_BEYBLADE_URL,
  notifyExistingOnFirstRun: false
};
config.funbox.enabled ??= false;
config.funbox.intervalSeconds = Math.min(3600, Math.max(2, Number(config.funbox.intervalSeconds) || 3));
config.funbox.collectionUrl = FUNBOX_BEYBLADE_URL;
config.funbox.notifyExistingOnFirstRun ??= false;
config.funbox.stockChangeNotificationsEnabled ??= false;
config.funbox.boostIntervalSeconds = 3;
config.funbox.boostDurationMinutes = Math.min(
  120,
  Math.max(5, Number(config.funbox.boostDurationMinutes) || 30)
);
config.funboxSandbox ??= {
  enabled: false,
  intervalSeconds: 5
};
config.funboxSandbox.enabled ??= false;
config.funboxSandbox.intervalSeconds = Math.max(2, Number(config.funboxSandbox.intervalSeconds) || 5);
config.notifications ??= {
  facebook: 'discord',
  funbox: 'discord',
  shopping: 'discord',
  hotspot: 'discord'
};
config.notifications.facebook = normalizeNotificationMode(config.notifications.facebook, 'discord');
config.notifications.funbox = normalizeNotificationMode(config.notifications.funbox, 'discord');
config.notifications.shopping = normalizeNotificationMode(config.notifications.shopping, 'discord');
config.notifications.hotspot = normalizeNotificationMode(
  config.notifications.hotspot,
  notificationAvailability().discordPrivate ? 'discord' : notificationAvailability().line ? 'line' : 'discord'
);
config.activeHours ??= { start: '09:00', end: '00:00' };
config.funbox.activeHours ??= { ...config.activeHours };
config.shoppingSites ??= {
  enabled: false,
  intervalSeconds: 60,
  targets: [
    {
      id: 'momo-funbox-beyblade',
      name: 'momo FUNBOX 官方品牌專區',
      siteName: 'momo購物網',
      url: 'https://www.momoshop.com.tw/categories/2701201977?p_orderType=4',
      sourceType: 'momo-category',
      baselineVersion: 'momo-funbox-official-v2',
      enabled: true
    },
    {
      id: 'momo-dianjiaoshi-beyblade',
      name: '墊腳石 TAKARA TOMY 專區',
      siteName: 'momo購物網',
      url: 'https://www.momoshop.com.tw/TP/TP0002451/main?brand=TAKARA%20TOMY&brandNo=20190717104950516&curPage=1',
      sourceType: 'momo-store-api',
      enabled: true
    },
    {
      id: 'eslite-beyblade-v3',
      name: '誠品戰鬥陀螺關鍵字探索',
      siteName: '誠品線上',
      url: ESLITE_TAKARA_TOMY_SEARCH_URL,
      sourceType: 'eslite-keywords',
      baselineVersion: 'eslite-keywords-v2',
      keywords: ['BEYBLADE X', '戰鬥陀螺'],
      categorySearches: [{ keyword: '"BEYBLADE X"', categoryId: '42773' }],
      latestSearches: [{ keyword: '"BEYBLADE X"' }, { keyword: '戰鬥陀螺' }],
      brandSearches: ESLITE_TAKARA_TOMY_BRAND_SEARCHES,
      availabilityUrl: 'https://www.eslite.com/Search?keyword=beyblade+x%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&final_price=0,&publishDate=0&sort=_weight_+desc&display=list&start=0&status=add_to_shopping_cart&exp=c&themes=WyLmiLDprKXpmYDonroiXQ',
      discoveryUrls: ESLITE_EXHIBITION_DISCOVERY_URLS,
      enabled: true
    }
  ]
};
config.shoppingSites.enabled ??= false;
config.shoppingSites.intervalSeconds = Math.min(3600, Math.max(10, Number(config.shoppingSites.intervalSeconds) || 60));
config.shoppingSites.boostIntervalSeconds = Math.min(
  10,
  Math.max(2, Number(config.shoppingSites.boostIntervalSeconds) || 3)
);
config.shoppingSites.boostDurationMinutes = Math.min(
  15,
  Math.max(2, Number(config.shoppingSites.boostDurationMinutes) || 5)
);
config.shoppingSites.activeHours ??= { start: '09:00', end: '22:00' };
config.shoppingSites.stockChangeNotificationsEnabled ??= true;
config.shoppingSites.excludeKeywords ??= ['戰鬥盒', '收納包'];
config.shoppingSites.excludeKeywords = [...new Set(
  (Array.isArray(config.shoppingSites.excludeKeywords) ? config.shoppingSites.excludeKeywords : [])
    .map((keyword) => String(keyword || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
)].slice(0, 50);
config.shoppingSites.targets ??= [];
config.shoppingSites.saleReminders ??= [];
config.japanAuctions ??= {
  enabled: true,
  intervalSeconds: 30,
  boostIntervalSeconds: 10,
  boostDurationMinutes: 5,
  activeHours: { start: '00:00', end: '00:00' },
  targets: [
    {
      id: 'japan-1999-beyblade',
      name: '1999.co.jp Beyblade X 可購清單',
      siteName: '1999.co.jp',
      sourceType: '1999',
      url: JAPAN_1999_BEYBLADE_LIST_URL,
      enabled: true
    },
    {
      id: 'japan-rakuten-yousaydo',
      name: '樂天優彩堂戰鬥陀螺專區',
      siteName: '樂天市場',
      sourceType: 'rakuten',
      url: 'https://item.rakuten.co.jp/yousay-do-pointup/c/0000000424/?i=1&s=4#risFil',
      enabled: true
    }
  ]
};
config.japanAuctions.enabled ??= true;
config.japanAuctions.intervalSeconds = Math.min(3600, Math.max(20, Number(config.japanAuctions.intervalSeconds) || 30));
config.japanAuctions.boostIntervalSeconds = Math.min(30, Math.max(10, Number(config.japanAuctions.boostIntervalSeconds) || 10));
config.japanAuctions.boostDurationMinutes = Math.min(30, Math.max(2, Number(config.japanAuctions.boostDurationMinutes) || 5));
config.japanAuctions.activeHours ??= { start: '00:00', end: '00:00' };
config.japanAuctions.excludeKeywords ??= DEFAULT_JAPAN_EXCLUDE_KEYWORDS;
config.japanAuctions.excludeKeywords = [...new Set(
  (Array.isArray(config.japanAuctions.excludeKeywords) ? config.japanAuctions.excludeKeywords : [])
    .map((keyword) => String(keyword || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
)].slice(0, 50);
config.japanAuctions.targets ??= [];
config.japanAuctions.targets = config.japanAuctions.targets.filter((target) => target.sourceType !== 'biccamera' && target.id !== 'japan-biccamera-beyblade');
for (const target of config.japanAuctions.targets) {
  if (target.id === 'japan-1999-beyblade') target.url = JAPAN_1999_BEYBLADE_LIST_URL;
  if (target.sourceType === 'edion') target.transport = 'chrome-bridge';
}
delete config.japanAuctions.xFeed;
config.amazonJp ??= {};
config.amazonJp.enabled ??= true;
config.amazonJp.adaptiveIntervalEnabled = config.amazonJp.adaptiveIntervalEnabled !== false;
config.amazonJp.intervalSeconds = 20;
config.amazonJp.normalIntervalRange = [15, 20];
config.amazonJp.blockedIntervalRange = [40, 60];
config.amazonJp.catalogRefreshMinutes = Math.min(1440, Math.max(60, Number(config.amazonJp.catalogRefreshMinutes) || 360));
config.amazonJp.brandRefreshMinutes = Math.min(1440, Math.max(30, Number(config.amazonJp.brandRefreshMinutes) || 360));
config.amazonJp.priceToleranceYen = Math.min(10, Math.max(0, Number(config.amazonJp.priceToleranceYen) || 1));
config.amazonJp.watchBatchSize = Math.min(4, Math.max(1, Number(config.amazonJp.watchBatchSize) || 2));
config.amazonJp.backgroundBatchSize = Math.min(3, Math.max(1, Number(config.amazonJp.backgroundBatchSize) || 1));
config.amazonJp.postalCode = /^\d{3}-?\d{4}$/.test(String(config.amazonJp.postalCode || ''))
  ? String(config.amazonJp.postalCode).replace(/^(\d{3})(\d{4})$/, '$1-$2')
  : '100-0001';
config.amazonJp.storePages ??= [
  'https://www.amazon.co.jp/stores/タカラトミー/page/33B74BDE-91D6-4BBF-A058-5A11184E0EE7',
  'https://www.amazon.co.jp/stores/page/17387C77-A324-4A79-8E18-7E81E7D00E02',
  'https://www.amazon.co.jp/stores/page/45515716-1665-4112-938E-7A30AFE0DF6F'
];
config.amazonJp.xSignalUrls ??= [
  'https://www.amazon.co.jp/dp/B0D6MZB1VF?aod=1&m=AN1VRQENFRJN5&f_new=1&f_freeShipping=1&linkCode=sl1&tag=bey_sokuhou-22'
];
config.amazonJp.watchProducts ??= [];
const legacyAmazonProductOrder = config.amazonJpProductOrder || {};
config.amazonJpProductOrders ??= {};
for (const slot of ['A', 'B', 'C']) {
  const source = config.amazonJpProductOrders[slot] || (slot === 'A' ? legacyAmazonProductOrder : {});
  config.amazonJpProductOrders[slot] = {
    enabled: Boolean(source.enabled),
    targetUrl: String(source.targetUrl || '').trim(),
    mode: normalizeAmazonJpProductMode(source.mode),
    checkoutTransport: source.checkoutTransport === 'browser' ? 'browser' : 'api',
    fastLane: source.fastLane !== false,
    maxShippingYen: Math.max(0, Math.min(10_000, Number(source.maxShippingYen ?? 500) || 0)),
    targetSuccessCount: Math.max(1, Math.min(99, Number(source.targetSuccessCount) || 1)),
    priceToleranceYen: Math.max(0, Math.min(10, Number(source.priceToleranceYen) || 1))
  };
}
delete config.amazonJpSingleOrder;
delete config.amazonJpProductOrder;
const amazonJpManualBaseline = [
  {
    asin: 'B0HJ7CPXJ6',
    code: 'BX-56',
    title: 'BEYBLADE X BX-56 ストリングランチャーL ホワイト×バイオレット',
    manualMsrpYen: 1100,
    dedicatedUntilCatalog: true,
    url: 'https://www.amazon.co.jp/dp/B0HJ7CPXJ6?aod=1&m=AN1VRQENFRJN5&f_new=1&f_freeShipping=1&linkCode=sl1&tag=bey_sokuhou-22'
  },
  {
    asin: 'B0HJ75X3PN',
    code: 'BX-53',
    title: 'BEYBLADE X BX-53 オールインワンセット',
    manualMsrpYen: 7480,
    dedicatedUntilCatalog: true,
    url: 'https://www.amazon.co.jp/dp/B0HJ75X3PN?aod=1&m=AN1VRQENFRJN5&f_new=1&f_freeShipping=1&linkCode=sl1&tag=bey_sokuhou-22'
  },
  {
    asin: 'B0HJ783F18',
    code: 'BX-52',
    title: 'BEYBLADE X BX-52 スターター ラスタードラグーン6-60LC',
    manualMsrpYen: 2300,
    dedicatedUntilCatalog: true,
    url: 'https://www.amazon.co.jp/dp/B0HJ783F18?aod=1&m=AN1VRQENFRJN5&f_new=1&f_freeShipping=1&linkCode=sl1&tag=bey_sokuhou-22'
  }
];
if (config.amazonJp.manualBaselineSeeded !== true) {
  for (const product of amazonJpManualBaseline) {
    const existing = config.amazonJp.watchProducts.find((item) => String(item.asin || '').toUpperCase() === product.asin);
    if (existing) {
      Object.assign(existing, product);
    } else {
      config.amazonJp.watchProducts.push(product);
    }
    if (!config.amazonJp.xSignalUrls.some((url) => String(url).toUpperCase().includes(product.asin))) {
      config.amazonJp.xSignalUrls.push(product.url);
    }
  }
  config.amazonJp.manualBaselineSeeded = true;
}
if (!config.japanAuctions.targets.some((target) => target.id === 'japan-edion-beyblade')) {
  config.japanAuctions.targets.push({
    id: 'japan-edion-beyblade',
    name: 'EDION Beyblade X 商品搜尋',
    siteName: 'EDION',
    sourceType: 'edion',
    url: 'https://www.edion.com/item_list.html?keyword=beyblade+x',
    enabled: true
  });
}
if (!config.japanAuctions.targets.some((target) => target.id === 'japan-rakuten-yousaydo-1')) {
  config.japanAuctions.targets.push({
    id: 'japan-rakuten-yousaydo-1',
    name: '優彩棠1號店 Beyblade 搜尋',
    siteName: '樂天・優彩棠1號店',
    sourceType: 'rakuten-search',
    shopId: '210240',
    url: 'https://search.rakuten.co.jp/search/mall/beyblade/?l-id=shoptop_shopmenu_search_bar&sid=210240',
    enabled: true
  });
}
if (!config.japanAuctions.targets.some((target) => target.id === 'japan-rakuten-ocn')) {
  config.japanAuctions.targets.push({
    id: 'japan-rakuten-ocn',
    name: 'OCN樂天 BEYBLADE X 搜尋',
    siteName: '樂天・OCN線上商店',
    sourceType: 'rakuten-search',
    shopId: '301897',
    url: 'https://search.rakuten.co.jp/search/mall/BEYBLADE+X+/?sid=301897',
    enabled: true
  });
}
ensureRakutenMarketTarget(config.japanAuctions.targets);
if (config.japanAuctions.additionalStoresSeeded !== true) {
  ensureJapanStoreTargets(config.japanAuctions.targets);
  config.japanAuctions.additionalStoresSeeded = true;
}
const RAKUTEN_BOOKS_BEYBLADE_URL = 'https://books.rakuten.co.jp/search?sitem=BEYBLADE+X&g=006&h=100&l-id=search-c-number-03';
const rakutenBooksTarget = config.japanAuctions.targets.find((target) => target.id === 'japan-rakuten-books-beyblade-x');
if (!rakutenBooksTarget) {
  config.japanAuctions.targets.push({
    id: 'japan-rakuten-books-beyblade-x',
    name: '樂天 Books BEYBLADE X 搜尋',
    siteName: '樂天 Books',
    sourceType: 'rakuten-books',
    url: RAKUTEN_BOOKS_BEYBLADE_URL,
    enabled: true
  });
} else {
  rakutenBooksTarget.url = RAKUTEN_BOOKS_BEYBLADE_URL;
}
if (!config.shoppingSites.targets.some((target) => target.id === 'momo-official-beyblade-limited')) {
  config.shoppingSites.targets.push({
    id: 'momo-official-beyblade-limited',
    name: 'momo 戰鬥陀螺限量發售',
    siteName: 'momo購物網',
    url: 'https://www.momoshop.com.tw/categories/2701202072',
    sourceType: 'momo-category',
    baselineVersion: 'momo-official-beyblade-limited-v2',
    enabled: true
  });
}
if (!config.shoppingSites.targets.some((target) => target.id === 'sensen-beyblade')) {
  config.shoppingSites.targets.push({
    id: 'sensen-beyblade',
    name: '森森文具戰鬥陀螺專區',
    siteName: '森森文具',
    url: 'https://www.sen-sen.com.tw/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BAx',
    sourceType: 'sensen-cyberbiz-collection',
    baselineVersion: 'sensen-beyblade-v2',
    enabled: true
  });
}
if (!config.shoppingSites.targets.some((target) => target.id === 'twj-beyblade')) {
  config.shoppingSites.targets.push({
    id: 'twj-beyblade',
    name: '童無忌戰鬥陀螺專區',
    siteName: '童無忌',
    url: 'https://www.twj.tw/collections/beyblade-x',
    sourceType: 'twj-cyberbiz-collection',
    baselineVersion: 'twj-beyblade-v1',
    enabled: true
  });
}
config.shoppingSites.targets = config.shoppingSites.targets.filter((target) => target.id !== 'momo-dianjiaoshi-variants-v2');
config.shoppingSites.targets = config.shoppingSites.targets.filter((target) =>
  target?.source !== 'sale-reminder' && !String(target?.id || '').startsWith('shopping-reminder-')
);
config.shoppingSites.targets = config.shoppingSites.targets.map((target, index) => ({
  ...target,
  ...(target.id === 'momo-funbox-beyblade' ? {
    name: 'momo FUNBOX 官方品牌專區',
    url: 'https://www.momoshop.com.tw/categories/2701201977?p_orderType=4',
    sourceType: 'momo-category',
    baselineVersion: 'momo-funbox-official-v2'
  } : {}),
  ...(target.id === 'momo-dianjiaoshi-beyblade' ? {
    name: target.name === '墊腳石戰鬥陀螺專區' ? '墊腳石 TAKARA TOMY 專區' : target.name,
    url: 'https://www.momoshop.com.tw/TP/TP0002451/main?brand=TAKARA%20TOMY&brandNo=20190717104950516&curPage=1',
    sourceType: 'momo-store-api',
    intervalSeconds: Math.min(10, Math.max(2, Number(target.intervalSeconds) || 3)),
    discoveryIntervalSeconds: Math.min(300, Math.max(10, Number(target.discoveryIntervalSeconds) || 30))
  } : {}),
  ...(/shop\.tcsb\.com\.tw/i.test(target.url || '') ? {
    siteName: '墊腳石購物網'
  } : {}),
  ...(isTcsbSearchTarget(target) ? {
    sourceType: 'tcsb-products-api', baselineVersion: TCSB_BASELINE_VERSION
  } : {}),
  ...(target.id === 'eslite-beyblade-v3' || /eslite\.com\/exhibitions\/CU202503-00091/i.test(target.url || '') ? {
    name: target.name === 'BEYBLADE X 精選策展' ? '誠品戰鬥陀螺關鍵字探索' : target.name,
    siteName: '誠品線上',
    url: ESLITE_TAKARA_TOMY_SEARCH_URL,
    sourceType: 'eslite-keywords',
    baselineVersion: 'eslite-keywords-v2',
    keywords: Array.isArray(target.keywords) && target.keywords.length
      ? target.keywords
      : ['BEYBLADE X', '戰鬥陀螺'],
    categorySearches: Array.isArray(target.categorySearches) && target.categorySearches.length
      ? target.categorySearches
      : [{ keyword: '"BEYBLADE X"', categoryId: '42773' }],
    latestSearches: Array.isArray(target.latestSearches) && target.latestSearches.length
      ? target.latestSearches
      : [{ keyword: '"BEYBLADE X"' }, { keyword: '戰鬥陀螺' }],
    brandSearches: [...new Map([
      ...(Array.isArray(target.brandSearches) ? target.brandSearches : []),
      ...ESLITE_TAKARA_TOMY_BRAND_SEARCHES
    ].map((profile) => [
      `${String(profile?.keyword || '').trim().toLocaleLowerCase('zh-TW')}|${(profile?.brands || []).join(',').toLocaleLowerCase('zh-TW')}`,
      profile
    ])).values()],
    availabilityUrl: 'https://www.eslite.com/Search?keyword=beyblade+x%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&final_price=0,&publishDate=0&sort=_weight_+desc&display=list&start=0&status=add_to_shopping_cart&exp=c&themes=WyLmiLDprKXpmYDonroiXQ',
    // 策展入口可能在上架前後短暫出現或撤下；保留代碼作為備援來源，
    // 並與 Holmes 搜尋索引及商品 purchase_status 合併，不取代既有搜尋。
    discoveryUrls: [...new Set([
      ...(Array.isArray(target.discoveryUrls) ? target.discoveryUrls : []),
      ...ESLITE_EXHIBITION_DISCOVERY_URLS
    ])]
  } : {}),
  id: String(target.id || `shopping-${index + 1}`),
  name: String(
    (target.id === 'eslite-beyblade-v3' && target.name === 'BEYBLADE X 精選策展')
      ? '誠品戰鬥陀螺關鍵字探索'
      : target.name || shoppingSiteName(target.url)
  ),
  siteName: String(isTcsbSearchTarget(target) ? '墊腳石官網' : target.id === 'eslite-beyblade-v3' ? '誠品線上' : target.siteName || shoppingSiteName(target.url)),
  enabled: target.enabled !== false,
  scheduleMode: target.id === 'eslite-beyblade-v3' ? 'default' : target.scheduleMode === 'custom' ? 'custom' : (
    target.scheduleMode === 'default' ? 'default' : (isMmToyShoppingTarget(target) ? 'custom' : 'default')
  ),
  activeHours: target.id === 'eslite-beyblade-v3'
    ? undefined
    : target.scheduleMode === 'custom' && target.activeHours
    ? {
        start: parseTimeValue(target.activeHours.start),
        end: parseTimeValue(target.activeHours.end)
      }
    : (target.scheduleMode === undefined && isMmToyShoppingTarget(target)
        ? { start: '00:00', end: '00:00' }
        : undefined)
}));
config.shoppingSites.saleReminders = config.shoppingSites.saleReminders
  .filter((reminder) => reminder && reminder.url && reminder.saleStartAt)
  .flatMap((reminder, index) => {
    const saleStartAt = new Date(reminder.saleStartAt);
    if (!Number.isFinite(saleStartAt.getTime())) return [];
    return [{
      id: String(reminder.id || `sale-reminder-${index + 1}`),
      name: String(reminder.name || '戰鬥陀螺商品'),
      siteName: String(reminder.siteName || shoppingSiteName(reminder.url)),
      url: canonicalSaleReminderUrl(reminder.url),
      saleStartAt: saleStartAt.toISOString(),
      enabled: reminder.enabled !== false,
      imageUrl: String(reminder.imageUrl || ''),
      price: String(reminder.price || ''),
      stock: reminder.stock !== null && reminder.stock !== undefined && reminder.stock !== ''
        && Number.isFinite(Number(reminder.stock)) ? Number(reminder.stock) : null,
      available: reminder.available === true ? true : reminder.available === false ? false : null,
      productCheckedAt: reminder.productCheckedAt || null,
      productError: String(reminder.productError || ''),
      autoDetected: reminder.autoDetected === true
    }];
  })
  .sort((left, right) => Date.parse(left.saleStartAt) - Date.parse(right.saleStartAt));
config.autoPurchase = normalizeAutoPurchaseConfig(config.autoPurchase);
config.systemPause = config.systemPause && typeof config.systemPause === 'object'
  ? config.systemPause
  : { active: false, pausedAt: null, resumeState: null };
config.systemPause.active = config.systemPause.active === true;
config.discordAutomation ??= {};
config.discordAutomation.statusActiveStart = parseTimeValue(
  config.discordAutomation.statusActiveStart || '09:00',
  '09:00'
);
config.discordAutomation.statusActiveEnd = parseTimeValue(
  config.discordAutomation.statusActiveEnd || '18:00',
  '18:00'
);
config.productKeywords ??= ['戰鬥陀螺', 'BEYBLADE'];
config.salesKeywords ??= ['抽選', '販售', '報名', '到貨', '補貨', '開賣', '現貨', '售完', '售罄'];
config.hotspot ??= {
  enabled: true,
  pageUrl: 'https://www.facebook.com/profile.php?id=61590975990981',
  activeHours: { start: '10:00', end: '21:00' },
  intervalSeconds: 60,
  pageLoadSeconds: 4,
  autoFillEnabled: true
};
config.hotspot.activeHours ??= { start: '10:00', end: '21:00' };
config.hotspot.intervalSeconds ??= 60;
config.hotspot.pageLoadSeconds ??= 4;
config.hotspot.burstModeEnabled ??= true;
config.hotspot.burstHours ??= { start: '13:30', end: '15:30' };
config.hotspot.burstIntervalSeconds ??= 5;
config.hotspot.burstPageLoadSeconds ??= 4;
config.hotspot.autoFillEnabled ??= true;
config.hotspot.autoSubmitEnabled ??= false;
config.hotspot.participantSlots ??= [1];
config.hotspot.pageUrls ??= [config.hotspot.pageUrl].filter(Boolean);
config.hotspot.pageUrls = [...new Set(config.hotspot.pageUrls.map(String).filter(Boolean))];
config.hotspot.pageUrl = config.hotspot.pageUrls[0] || '';

let configSaveQueue = Promise.resolve();

async function saveConfig() {
  configSaveQueue = configSaveQueue.then(async () => {
    const temporary = `${configFile}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(activeProjectConfig(config), null, 2)}\n`, 'utf8');
    await fs.rename(temporary, configFile);
  });
  return configSaveQueue;
}

const state = new StateStore(dataDir);
await state.load();
retireFacebookState(state.data);
state.data.commerce ||= {};
if (!state.data.commerce.amazonJpProductOrderA && state.data.commerce.amazonJpProductOrder) {
  state.data.commerce.amazonJpProductOrderA = state.data.commerce.amazonJpProductOrder;
}
delete state.data.commerce.amazonJpSingleOrder;
delete state.data.commerce.amazonJpProductOrder;
const funboxSandbox = new FunboxSandbox({
  dataDir,
  port: config.dashboardPort,
  onReset: async () => {
    state.data.commerce ||= {};
    delete state.data.commerce.funboxSandbox;
    await state.save();
  }
});
await funboxSandbox.load();
const dashboardNoteFile = path.join(dataDir, 'dashboard-note.txt');
let dashboardNote = '';
try {
  dashboardNote = await fs.readFile(dashboardNoteFile, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const runtime = {
  scanning: false,
  lastScan: state.data.lastScan,
  lastHotspotScan: state.data.lastHotspotScan,
  lastFunboxScan: state.data.commerce?.funbox?.lastScanAt
    ? {
        completedAt: state.data.commerce.funbox.lastScanAt,
        checked: state.data.commerce.funbox.lastProductCount || 0
      }
    : null,
  nextFunboxAt: null,
  funboxScanning: false,
  funboxBoostUntil: null,
  funboxBoostProductCount: 0,
  lastFunboxSandboxScan: state.data.commerce?.funboxSandbox?.lastScanAt
    ? {
        completedAt: state.data.commerce.funboxSandbox.lastScanAt,
        checked: state.data.commerce.funboxSandbox.lastProductCount || 0
      }
    : null,
  nextFunboxSandboxAt: null,
  funboxSandboxScanning: false,
  lastShoppingScan: state.data.commerce?.shoppingSites?.lastScan || null,
  lastShoppingFullScanAt: state.data.commerce?.shoppingSites?.lastFullScanAt || null,
  nextShoppingAt: null,
  shoppingScanning: false,
  shoppingBoostUntil: null,
  japanScanning: false,
  nextJapanAt: null,
  lastJapanScan: null,
  amazonJpScanning: false,
  nextAmazonJpAt: null,
  lastAmazonJpScan: null,
  amazonJpFailureCount: 0,
  amazonJpBackoffUntil: null,
  amazonJpAdaptiveIntervalSeconds: 20,
  amazonJpCadenceMode: 'normal',
  lastSaleReminderCheck: null,
  nextSaleReminderCheckAt: null,
  nextFormPrewarmAt: null,
  lastError: Date.parse(state.data.facebookAccess?.cooldownUntil || '') > Date.now()
    ? `Facebook 暫時限制存取；已暫停掃描至 ${new Date(state.data.facebookAccess.cooldownUntil).toLocaleString('zh-TW')}，之後自動重試。`
    : null,
  lastSelfCheck: null,
  lastMultiFill: null,
  lastMultiFillDryRun: null,
  facebookCooldownUntil: state.data.facebookAccess?.cooldownUntil || null,
  logs: [],
  regularLogs: [],
  hotspotLogs: [],
  funboxLogs: [],
  shoppingLogs: [],
  shoppingSiteLogs: {},
  japanLogs: []
};

function appendRuntimeLog(key, line) {
  runtime[key].unshift(line);
  runtime[key] = runtime[key].slice(0, 100);
}

function appendShoppingSiteRuntimeLog(message, channel, line) {
  if (channel !== 'shopping') return;
  const destination = logDestinationFor(message, channel);
  const key = destination.label;
  runtime.shoppingSiteLogs[key] ??= [];
  runtime.shoppingSiteLogs[key].unshift(line);
  runtime.shoppingSiteLogs[key] = runtime.shoppingSiteLogs[key].slice(0, 100);
}

const operationalLogPolicy = new OperationalLogPolicy();
const logDateFormatter = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' });
function log(message, channel = 'system', { persist = true } = {}) {
  message = safePurchaseText(message, 1800);
  // Live Amazon step/refresh records stay ephemeral; never deduplicate purchase
  // steps or change the transaction workflow itself.
  if (persist) {
    message = operationalLogPolicy.accept(message, channel);
    if (message === null) return;
  }
  const line = `[${logDateFormatter.format(new Date())}] ${message}`;
  appendRuntimeLog('logs', line);
  if (channel === 'regular') appendRuntimeLog('regularLogs', line);
  else if (channel === 'hotspot') appendRuntimeLog('hotspotLogs', line);
  else if (channel === 'funbox') appendRuntimeLog('funboxLogs', line);
  else if (channel === 'shopping') appendRuntimeLog('shoppingLogs', line);
  else if (channel === 'japan') appendRuntimeLog('japanLogs', line);
  else {
    appendRuntimeLog('regularLogs', line);
    appendRuntimeLog('hotspotLogs', line);
    appendRuntimeLog('funboxLogs', line);
    appendRuntimeLog('shoppingLogs', line);
  }
  appendShoppingSiteRuntimeLog(message, channel, line);
  if (!persist) return;
  try {
    appendRoutedLog(line, { message, channel });
  } catch (error) {
    console.error(`分類 LOG 寫入失敗：${error.message}`);
  }
  console.log(line);
}

function setStatus(patch) {
  const next = { ...patch };
  const cooldownUntil = Date.parse(runtime.facebookCooldownUntil || '');
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()
    && Object.hasOwn(next, 'lastError')) {
    delete next.lastError;
  }
  Object.assign(runtime, next);
}

const facebookDutyNotifier = new DailyDutyNotifier({
  id: 'facebook',
  label: 'FB 粉專監控',
  state: state.data,
  getConfig: () => ({
    enabled: config.monitoringEnabled,
    activeHours: config.activeHours
  }),
  notify: (message) => sendNotification(message, {
    discordPreview: message,
    channelMode: config.notifications.facebook
  }),
  save: () => state.save(),
  log: (message) => log(message, 'regular')
});
const funboxDutyNotifier = new DailyDutyNotifier({
  id: 'funbox',
  label: 'Funbox 官網監控',
  state: state.data,
  getConfig: () => ({
    enabled: config.funbox.enabled,
    activeHours: config.funbox.activeHours
  }),
  notify: (message) => sendNotification(message, {
    discordPreview: message,
    channelMode: config.notifications.funbox
  }),
  save: () => state.save(),
  log: (message) => log(message, 'funbox')
});
const shoppingDutyNotifier = new DailyDutyNotifier({
  id: 'shopping',
  label: '購物網站監控',
  state: state.data,
  getConfig: () => ({
    enabled: config.shoppingSites.enabled,
    activeHours: config.shoppingSites.activeHours
  }),
  notify: (message) => sendNotification(message, {
    discordPreview: message,
    channelMode: config.notifications.shopping
  }),
  save: () => state.save(),
  log: (message) => log(message, 'shopping')
});

const funboxMonitor = new FunboxMonitor({
  state,
  url: config.funbox.collectionUrl,
  sources: FUNBOX_BEYBLADE_SOURCES,
  log,
  onPurchaseCandidate: (candidate) => enqueueImmediateFunboxPurchaseCandidate(candidate),
  onInventorySnapshot: (products, observedAt) => autoPurchase.observeFunboxInventory(products, observedAt),
  notify: (text, options) => sendNotification(text, {
    ...options,
    channelMode: config.notifications.funbox
  })
});
const funboxSandboxMonitor = new FunboxMonitor({
  state,
  url: funboxSandbox.collectionUrl,
  stateKey: 'funboxSandbox',
  logLabel: 'Funbox 沙盒',
  log,
  notify: (text, options) => sendNotification(
    `🧪 Funbox 沙盒上架測試（不是真實販售）\n\n${text}`,
    {
      ...options,
      discordPreview: `🧪 ${options.discordPreview || 'Funbox 沙盒通知測試'}`,
      embeds: (options.embeds || []).map((embed) => ({
        ...embed,
        title: `🧪 ${embed.title}`,
        footer: { text: '本機測試通知・不是真實販售' }
      })),
      channelMode: config.notifications.funbox
    }
  )
});
const shoppingSiteMonitor = new ShoppingSiteMonitor({
  state,
  getTargets: () => config.shoppingSites.targets,
  isEsliteMonitoringAllowed: (target) => {
    const current = config.shoppingSites.targets.find((item) => String(item.id) === String(target.id));
    const hours = activeHoursForShoppingTarget(current || target);
    return Boolean(config.shoppingSites.enabled && current?.enabled !== false
      && isWithinActiveHours(new Date(), hours.start, hours.end));
  },
  getExcludeKeywords: () => config.shoppingSites.excludeKeywords,
  getPendingSaleReminder: (product, observedAt) => {
    const productId = String(product?.id || '');
    const observedTime = Date.parse(observedAt || '') || Date.now();
    return (config.shoppingSites.saleReminders || []).find((reminder) => {
      if (reminder.enabled === false || Date.parse(reminder.saleStartAt || '') <= observedTime) return false;
      const reminderId = String(reminder.url || '').match(/\/product\/(\d+)/i)?.[1] || '';
      return Boolean(productId && reminderId === productId);
    }) || null;
  },
  onPendingSaleDetected: async (product) => {
    const saleStartAt = new Date(product.saleStartAt || '');
    if (!Number.isFinite(saleStartAt.getTime()) || saleStartAt.getTime() <= Date.now()) return null;
    const url = canonicalSaleReminderUrl(product.url);
    const productId = String(product.id || '');
    const existing = config.shoppingSites.saleReminders.find((reminder) => {
      const reminderId = String(reminder.url || '').match(/\/product\/(\d+)/i)?.[1] || '';
      return reminderId && reminderId === productId;
    });
    if (existing) return existing;
    const stockVariant = (product.variants || []).find((variant) => Number.isFinite(Number(variant.stock)));
    const reminder = {
      id: `momo-auto-${productId}-${saleStartAt.getTime()}`,
      name: String(product.title || '戰鬥陀螺商品').trim().replace(/\s+/g, ' ').slice(0, 80),
      siteName: 'momo購物網',
      url,
      saleStartAt: saleStartAt.toISOString(),
      enabled: true,
      imageUrl: String(product.imageUrl || '').trim().slice(0, 2000),
      price: String(product.price || '').trim().slice(0, 50),
      stock: stockVariant ? Number(stockVariant.stock) : null,
      available: false,
      productCheckedAt: new Date().toISOString(),
      productError: '',
      autoDetected: true
    };
    config.shoppingSites.saleReminders.push(reminder);
    config.shoppingSites.saleReminders.sort(
      (left, right) => Date.parse(left.saleStartAt) - Date.parse(right.saleStartAt)
    );
    await saveConfig();
    scheduleSaleReminders({ immediate: true });
    log(`已自動辨識 momo 待售商品：${reminder.name}｜${saleStartAt.toLocaleString('zh-TW')}`, 'shopping');
    try {
      await syncDiscordAutomation();
      const announcement = saleReminderListedNotification(reminder);
      await sendNotification(announcement.text, {
        ...announcement.options,
        channelMode: 'discord'
      });
    } catch (error) {
      log(`momo 待售商品已保存，但 Discord 公告暫時失敗：${error.message}`, 'shopping');
    }
    return reminder;
  },
  log: (message) => log(message, 'shopping'),
  notify: (text, options) => sendNotification(text, {
    ...options,
    channelMode: config.notifications.shopping
  }),
  onPurchaseCandidate: (candidate) => enqueueImmediateShoppingPurchaseCandidate(candidate),
  getEslitePurchaseSettings: () => normalizeAutoPurchaseConfig(config.autoPurchase).eslite,
  onEslitePurchaseObservation: (product) => autoPurchase.observeEslitePurchaseProduct(product),
  onEsliteDiscoveryActivity: () => autoPurchase.notePlatformActivity('eslite', {
    durationMs: config.shoppingSites.boostDurationMinutes * 60 * 1000
  }),
  esliteApiSessionFile: path.join(dataDir, 'auto-purchase', 'eslite-session.json'),
  esliteApiOnly: true,
  browserLauncher: (options) => import('playwright').then(({ chromium }) => chromium.launch({
    ...options,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled']
  }))
});
const esliteCx19Seed = shoppingSiteMonitor.esliteManualProducts()
  .find((product) => product.id === '10042014802683232221009');
if (!esliteCx19Seed || !esliteCx19Seed.imageUrl) {
  await shoppingSiteMonitor.addEsliteManualProduct(
    'https://www.eslite.com/product/10042014802683232221009',
    {
      title: 'BEYBLADE X戰鬥陀螺/ CX-19/ 鱷魚裂甲',
      imageUrl: 'https://s2.eslite.com/unsafe/fit-in/x240/smart/filters:sharpen(sigma):format(webp)/s.eslite.com/b2b/vendor/vendor178962805493120260917145416/mainCoverImage1_1717420.jpg',
      price: 'NT$350',
      ...(!esliteCx19Seed ? { available: false, status: '無法購買' } : {})
    }
  );
}
const japanAuctionMonitor = new JapanAuctionMonitor({
  dataDir,
  state,
  getTargets: () => config.japanAuctions.targets,
  getExcludeKeywords: () => config.japanAuctions.excludeKeywords,
  log: (message) => log(message, 'japan'),
  notify: (text, options) => sendNotification(text, {
    ...options,
    channelMode: 'discord',
    discordAudience: 'japan'
  }),
  onAvailabilitySignal: () => undefined
});
const edionBrowser = new EdionBrowserBridge({
  dataDir, state, monitor: japanAuctionMonitor,
  getTargets: () => config.japanAuctions.targets,
  enabled: () => config.japanAuctions.enabled && !config.systemPause.active
    && isWithinActiveHours(new Date(), config.japanAuctions.activeHours.start, config.japanAuctions.activeHours.end),
  intervalSeconds: () => config.japanAuctions.intervalSeconds,
  log: message => log(message, 'japan'),
  notify: text => sendNotification(text, { channelMode: 'discord', discordAudience: 'private' })
});
const amazonJapanMonitor = new AmazonJapanMonitor({
  dataDir,
  state,
  getConfig: () => config.amazonJp,
  getExcludeKeywords: () => config.japanAuctions.excludeKeywords,
  log: (message) => log(message, 'japan'),
  notify: (text, options) => sendNotification(text, {
    ...options,
    channelMode: 'discord',
    discordAudience: 'japan'
  }),
  onAvailabilitySignal: (product, signal) => Promise.all(
    amazonJpProductOrders.map((monitor) => monitor.requestPurchaseFromSignal(product, signal))
  )
});
function isAutoPurchasePlatformMonitored(platform) {
  if (config.systemPause.active) return false;
  if (platform === 'funbox') return Boolean(config.funbox.enabled)
    && isWithinActiveHours(new Date(), config.funbox.activeHours.start, config.funbox.activeHours.end);
  if (platform !== 'eslite' || !config.shoppingSites.enabled) return false;
  const hostPatterns = {
    eslite: /(?:^|\.)eslite\.com$/i
  };
  return config.shoppingSites.targets.some((target) => {
    if (target.enabled === false) return false;
    try {
      return hostPatterns[platform].test(new URL(target.url).hostname)
        && isShoppingTargetWithinActiveHours(target, new Date());
    } catch {
      return false;
    }
  });
}
// Prefer ATM once; preserve saved profiles/templates. Later COD choices require official proof.
if (config.autoPurchase.pickupPolicyVersion < 1) {
  for (const platform of ['funbox', 'eslite']) {
    config.autoPurchase[platform].payment = 'virtual_atm_home';
    for (const slot of Object.keys(config.autoPurchase[platform].accountPayments)) config.autoPurchase[platform].accountPayments[slot] = 'virtual_atm_home';
  }
  config.autoPurchase.pickupPolicyVersion = 1;
  await saveConfig();
}
const autoPurchase = new AutoPurchaseCoordinator({
  continuousEsliteTasks: true,
  continuousFunboxTasks: true,
  state,
  esliteHistoryFile: path.join(dataDir, 'records', 'purchases', 'eslite-attempts.jsonl'),
  funboxHistoryFile: path.join(dataDir, 'records', 'purchases', 'funbox-attempts.jsonl'),
  getConfig: () => config.autoPurchase,
  isPlatformMonitoringEnabled: isAutoPurchasePlatformMonitored,
  adapters: {
    funbox: new MultiAccountFunboxPurchaseAdapter({
      dataDir,
      apiAtmCheckout: true,
      getPurchaseHold: (slot) => {
        const identity = autoPurchase.adapters.funbox.accountIdentity(slot);
        const record = Object.values(state.data.commerce?.autoPurchase?.records || {}).find(item => item.platform === 'funbox'
          && (item.accountSlot || item.slot) === slot && (!item.accountIdentity || item.accountIdentity === identity) && item.status === 'submitted_unconfirmed');
        return record ? { productId: record.product?.id, products: record.products, startedAt: record.startedAt } : null;
      },
      getAccounts: () => purchaseCredentials.getFunboxAccounts(),
      getPickupSetup: (slot) => purchaseCredentials.getPickupSetup('funbox', slot),
      onPickupOrderConfirmed: async(slot,api,result,expectedAccount)=>{
        const setup=await verifyFunboxPickupOrder(api,result.resultUrl,purchaseCredentials.getPickupProfile());
        await purchaseCredentials.setPickupSetup('funbox',slot,{...setup,storeInfo:result.store},expectedAccount);
      },
      getAccountPayment: (slot) => config.autoPurchase.funbox.accountPayments[slot] || 'virtual_atm_home',
      getPickupProfile: () => purchaseCredentials.getPickupProfile(),
      getDeliveryProfile: () => purchaseCredentials.getDeliveryProfile(),
      log: (message) => log(message, 'funbox')
    }),
    eslite: new MultiAccountEslitePurchaseAdapter({
      dataDir,
      apiOnly: true,
      autoLoginEnabled: true,
      verifyAccountIdentity: true,
      getAccounts: () => purchaseCredentials.getEsliteAccounts(),
      getCheckoutTemplate: (slot) => purchaseCredentials.getEsliteCheckoutTemplate(slot),
      getPickupSetup: (slot) => purchaseCredentials.getPickupSetup('eslite', slot),
      getAccountPayment: (slot) => config.autoPurchase.eslite.accountPayments[slot],
      onMemberIdentified: (slot, profile, context) => purchaseCredentials.setEsliteMemberProfile(slot, profile, context),
      onAccountPrepared: (slot, template, context) => purchaseCredentials.setEsliteCheckoutTemplate(slot, template, { ...context, paymentMode: context.payment }),
      getPurchaseHold: (slot) => {
        const probe = state.data.commerce?.autoPurchase?.esliteCartProbeHolds?.[slot];
        const identity = crypto.createHash('sha256').update('eslite:' + String(purchaseCredentials.getEsliteAccount(slot).account || '').trim().toLowerCase()).digest('hex');
        if (probe?.accountIdentity === identity) return probe;
        const record = Object.values(state.data.commerce?.autoPurchase?.records || {}).find((item) =>
          item.platform === 'eslite' && item.accountSlot === slot && item.status === 'submitted_unconfirmed');
        return record ? { productId: record.product?.id, products: record.products, quantity: record.quantity || 1, startedAt: record.startedAt } : null;
      },
      onSessionProblem: ({ slot, detail }) => sendNotification(`⚠️ 誠品帳號 ${slot} 登入需要注意\n${detail}\n確認登入失效時會停止本帳號送單；其他可用帳號與公開監控維持。`, {
        channelMode: 'discord', discordAudience: 'private'
      }),
      getPickupProfile: () => purchaseCredentials.getPickupProfile(),
      getDeliveryProfile: () => purchaseCredentials.getDeliveryProfile(),
      log: (message) => log(message, 'shopping')
    }),
  },
  notifyPrivate: (text, options) => sendNotification(text, {
    ...options,
    channelMode: 'discord',
    discordAudience: 'private'
  }),
  log: (message) => log(message, 'shopping')
});
const amazonOrderHistory = new AmazonOrderHistory(dataDir, { log: (message) => log(message, 'japan') });
const amazonRaceCoordinator = new AmazonRaceCoordinator({ state, getConfig: slot => config.amazonJpProductOrders[slot] });
const amazonJpProductOrders = ['A', 'B', 'C'].map((slot) => new AmazonJpProductOrderMonitor({
  dataDir,
  state,
  slot,
  storageKey: `amazonJpProductOrder${slot}`,
  profileName: slot === 'A' ? 'amazon-jp-product-order' : `amazon-jp-product-order-${slot.toLowerCase()}`,
  orderHistory: amazonOrderHistory,
  getConfig: () => config.amazonJpProductOrders[slot],
  onTerminal: async (result) => {
    // An unknown API result holds that route. Its separately authorized
    // frontend may still finish this wave; it is not an API retry.
    if (result?.status === 'submitted_unconfirmed' && (amazonRaceCoordinator.connected(slot) || amazonRaceCoordinator.current(slot)?.routes.frontend)) return;
    config.amazonJpProductOrders[slot].enabled = false;
    await saveConfig();
  },
  notifyPrivate: (text, options) => sendNotification(`【日亞任務 ${slot}】\n${text}`, {
    ...options,
    channelMode: 'discord',
    discordAudience: 'private'
  }),
  log: (message) => log(`日亞任務 ${slot}｜${message}`, 'japan', { persist: false })
}));
const amazonJpProductOrderBySlot = Object.fromEntries(amazonJpProductOrders.map((monitor) => [monitor.slot, monitor]));
const amazonRace = new AmazonRaceBridge({ coordinator: amazonRaceCoordinator, monitors: amazonJpProductOrderBySlot, history: amazonOrderHistory, saveConfig });
for (const monitor of amazonJpProductOrders) { monitor.raceCoordinator = amazonRaceCoordinator; monitor.raceBridge = amazonRace; }
let autoPurchaseWindowSignature = '';
async function syncAutoPurchaseWindowState({ force = false } = {}) {
  const signature = JSON.stringify({
    master: Boolean(config.autoPurchase.enabled),
    platformEnabled: Object.fromEntries(['funbox', 'eslite']
      .map((platform) => [platform, Boolean(config.autoPurchase[platform]?.enabled)])),
    monitored: Object.fromEntries(['funbox', 'eslite']
      .map((platform) => [platform, isAutoPurchasePlatformMonitored(platform)]))
  });
  if (!force && signature === autoPurchaseWindowSignature) return autoPurchase.getStatus();
  autoPurchaseWindowSignature = signature;
  return autoPurchase.applyRuntimeConfig();
}
void syncAutoPurchaseWindowState({ force: true }).catch((error) => {
  log(`私人購買執行環境初始化失敗：${error.message}`, 'shopping');
});

function enqueueFunboxAutoPurchase(scanResult) {
  if (scanResult?.purchaseCandidatesDispatched) return;
  const candidates = scanResult?.purchaseCandidates || [];
  if (!candidates.length) return;
  void autoPurchase.enqueue('funbox', candidates).catch((error) => {
    log(`私人 Funbox 購買佇列失敗：${error.message}`, 'funbox');
  });
}

function enqueueImmediateFunboxPurchaseCandidate(candidate) {
  void autoPurchase.enqueue('funbox', [candidate]).catch((error) => {
    log(`私人 Funbox 購買工作派送失敗：${error.message}`, 'funbox');
  });
}

async function inspectOfficialFunboxProduct(productUrl) {
  let parsed;
  try {
    parsed = new URL(String(productUrl || '').trim());
  } catch {
    throw new Error('請提供完整的 Funbox 商品網址');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'shop.funbox.com.tw') {
    throw new Error('手動真實下單只接受 shop.funbox.com.tw 官方商品網址');
  }
  const slug = parsed.pathname.match(/^\/products\/([^/?#]+)\/?$/i)?.[1];
  if (!slug) throw new Error('這不是 Funbox 單一商品網址');
  const canonicalUrl = `https://shop.funbox.com.tw/products/${slug}`;
  const response = await fetch(`${canonicalUrl}.json`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  });
  if (!response.ok) throw new Error(`Funbox 商品資料讀取失敗（HTTP ${response.status}）`);
  const raw = await response.json();
  const [product] = parseFunboxProductData([{ ...raw, url: canonicalUrl }], canonicalUrl);
  if (!product) throw new Error(`Funbox 商品資料無法解析：${slug}`);
  if (!product.available || !(Number(product.stock) > 0) || !product.variantId) {
    throw new Error(`${product.title} 目前不可購買（庫存 ${product.stock ?? '未知'}）`);
  }
  return product;
}

function enqueueImmediateShoppingPurchaseCandidate(candidate) {
  if (/eslite\.com/i.test(candidate?.url || '') || /誠品/.test(candidate?.siteName || '')) {
    autoPurchase.notePlatformActivity('eslite', {
      durationMs: config.shoppingSites.boostDurationMinutes * 60 * 1000
    });
  }
  const scanResult = { purchaseCandidates: [candidate] };
  enqueueEsliteAutoPurchase(scanResult);
}

function enqueueEsliteAutoPurchase(scanResult) {
  if (scanResult?.purchaseCandidatesDispatched) return;
  const candidates = (scanResult?.purchaseCandidates || []).filter((product) =>
    /eslite\.com/i.test(product.url || '') || /誠品/.test(product.siteName || '')
  );
  if (!candidates.length) return;
  void autoPurchase.enqueue('eslite', candidates).catch((error) => {
    log(`私人誠品購買佇列失敗：${error.message}`, 'shopping');
  });
}


function canonicalSaleReminderUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('商品網址僅支援 http 或 https');
  if (/momoshop\.com\.tw$/i.test(parsed.hostname)) {
    const productId = parsed.pathname.match(/\/product\/(\d+)/i)?.[1]
      || parsed.searchParams.get('i_code');
    if (productId) return `https://www.momoshop.com.tw/product/${productId}`;
    if (/\/TP\/[^/]+\/goodsDetail\//i.test(parsed.pathname)) {
      return `https://www.momoshop.com.tw${parsed.pathname}`;
    }
  }
  parsed.hash = '';
  return parsed.href;
}

async function inspectSaleReminderUrl(value) {
  const url = canonicalSaleReminderUrl(value);
  const product = await shoppingSiteMonitor.inspectProduct(url, { includeStock: true });
  if (!product) throw new Error('商品頁尚未提供可讀取的資料');
  const stock = ['momo-recommendation-goodsStock', 'momo-search-goodsStock'].includes(product.stockSource)
    && Number.isFinite(Number(product.variants?.[0]?.stock))
    ? Number(product.variants[0].stock)
    : null;
  return {
    url,
    name: product.title,
    siteName: shoppingSiteName(url),
    imageUrl: product.imageUrl || '',
    price: product.price || '',
    stock,
    available: stock === null ? null : stock > 0,
    productCheckedAt: stock === null ? null : new Date().toISOString(),
    saleStartAt: product.saleStartAt || null
  };
}

const saleReminderMonitor = new SaleReminderMonitor({
  state,
  getReminders: () => config.shoppingSites.saleReminders,
  log: (message) => log(message, 'shopping'),
  notify: (text, options) => sendNotification(text, {
    ...options,
    channelMode: 'discord'
  })
});
const FUNBOX_LIVE_TEST_URL =
  'https://shop.funbox.com.tw/category_products/takaratomy/tomica.json?limit=3&page=1&sort_by=sell_from-desc';

async function saveDashboardNote(value) {
  const note = String(value ?? '').replace(/\r\n/g, '\n');
  if (note.length > 5000) throw new Error('備忘錄最多 5000 字。');
  const temporary = `${dashboardNoteFile}.tmp`;
  await fs.writeFile(temporary, note, 'utf8');
  await fs.rename(temporary, dashboardNoteFile);
  dashboardNote = note;
  log('控制頁備忘錄已儲存在本機。');
  return { message: '備忘錄已儲存在本機。', note };
}

const scanner = new FacebookScanner({ dataDir, config, log });
const formAutoFillWorkers = new Map([1, 2, 3].map((slot) => [slot, new FormAutoFill({
  dataDir,
  config,
  profileSlot: slot,
  log: (message) => log(`[第 ${slot} 組] ${message}`, 'hotspot')
})]));
await Promise.all([...formAutoFillWorkers.values()].map((worker) => worker.load()));
const formAutoFill = formAutoFillWorkers.get(1);

function configuredParticipantSlots() {
  const slots = [...new Set((config.hotspot.participantSlots || [1]).map(Number))]
    .filter((slot) => formAutoFillWorkers.has(slot));
  return slots.length ? slots : [1];
}

function selectedFormAutoFillWorkers() {
  return configuredParticipantSlots().map((slot) => ({ slot, worker: formAutoFillWorkers.get(slot) }));
}

async function closeAllFormAutoFillWorkers() {
  await Promise.all([...formAutoFillWorkers.values()].map((worker) => worker.close()));
}
const TAIMALL_TEST_PAGE_URL = 'https://www.facebook.com/profile.php?id=61591565777499';
const watcher = new Watcher({
  config,
  scanner,
  state,
  log,
  setStatus,
  onNewRelevantPost: async (post) => {
    if (!config.hotspot.autoFillEnabled || !isHotspotPageUrl(post.pageUrl) || !post.formUrls.length) return;
    const formPolicy = post.pageUrl === TAIMALL_TEST_PAGE_URL ? 'taimall_test' : 'taimall';
    const attempts = await Promise.all(selectedFormAutoFillWorkers().map(async ({ slot, worker }) => {
      try {
        const result = await worker.prepareForm(post.formUrls[0], {
          autoSubmit: config.hotspot.autoSubmitEnabled,
          contextId: `${post.id}:profile-${slot}`,
          formPolicy,
          archiveLabel: slot === 1 && Number(post.formAttempt || 1) === 1 ? '台茂_陀螺_抽取資格' : '',
          archiveSource: {
            pageName: post.pageName,
            postUrl: post.postUrl,
            publishedAt: post.publishedAt
          }
        });
        return { slot, result };
      } catch (error) {
        return { slot, error: error.message };
      }
    }));
    const completedAt = new Date();
    const multiFillResult = {
      postId: post.id,
      postUrl: post.postUrl,
      completedAt: completedAt.toISOString(),
      results: attempts.map(({ slot, result, error }) => ({
        slot,
        submitted: Boolean(result?.submitted),
        status: result?.status || 'error',
        durationMs: result?.durationMs || 0,
        filledCount: result?.filled?.length || 0,
        uncertainCount: result?.uncertain?.length || 0,
        aiApproved: Boolean(result?.aiReview?.approved),
        error: error || ''
      }))
    };
    const hasSubmittedResult = multiFillResult.results.some((result) => result.submitted);
    const previousHasSubmittedResult = runtime.lastMultiFill?.results?.some((result) => result.submitted);
    if (hasSubmittedResult || !previousHasSubmittedResult) runtime.lastMultiFill = multiFillResult;
    const resultLines = attempts.map(({ slot, result, error }) => {
      if (error) return `🔴 第 ${slot} 組：執行失敗｜${error}`;
      const blockers = [
        ...(result.validationErrors || []),
        ...(result.dangerousSelections || []),
        ...(result.fixedFormatErrors || [])
      ];
      const aiText = result.aiReview?.approved ? '｜AI 複核通過' : result.aiReview?.used ? '｜AI 複核未通過' : '';
      if (result.submitted) return `✅ 第 ${slot} 組：已送出｜${result.durationMs} ms${aiText}`;
      if (result.status === 'closed') return `🔴 第 ${slot} 組：表單已關閉`;
      if (result.status === 'unpublished') return `🔴 第 ${slot} 組：表單尚未發布或已撤下`;
      if (result.status === 'already_responded') return `🔴 第 ${slot} 組：此 Google 帳號已填過這份表單`;
      if (result.status === 'permission_required') return `🟠 第 ${slot} 組：需要 Google 權限確認`;
      if (blockers.length) return `🔴 第 ${slot} 組：${blockers.join('｜')}`;
      return `🟡 第 ${slot} 組：已填 ${result.filled.length} 欄｜待確認 ${result.uncertain.length} 題${aiText}`;
    });
    const header = post.pageUrl === TAIMALL_TEST_PAGE_URL ? '🧪 三組突襲填表測試' : '🚨 台茂三組填表結果';
    const resultMessage = `${header}\n時間：${completedAt.toLocaleString('zh-TW')}\n\n${resultLines.join('\n')}`;
    if (Number(post.formAttempt || 1) === 1 || attempts.some(({ result }) => result?.submitted)) {
      try {
        const requestId = await sendNotification(resultMessage, {
          channelMode: config.notifications.hotspot,
          discordAudience: 'private'
        });
        log(`多組填表結果已通知${requestId ? `｜訊息 ID：${requestId}` : ''}`, 'hotspot');
      } catch (error) {
        log(`多組填表結果通知失敗：${error.message}`, 'hotspot');
      }
    }
    await Promise.all(attempts.map(async ({ slot, result }) => {
      if (!result) return;
      const worker = formAutoFillWorkers.get(slot);
      const blockers = [
        ...(result.validationErrors || []),
        ...(result.dangerousSelections || []),
        ...(result.fixedFormatErrors || [])
      ];
      if (result.submitted || ['closed', 'unpublished', 'already_responded'].includes(result.status)) await worker.close();
      else if (slot === 1 && result.status === 'open' && (result.uncertain.length || blockers.length)) {
        worker.showCurrentForm().catch((error) => log(`開啟第一組人工確認表單失敗：${error.message}`, 'hotspot'));
      }
    }));
    return multiFillResult;
  },
  onPageDetected: async (page, detectedName, channel = 'regular') => {
    if (page.nameMode === 'manual' || !detectedName || page.name === detectedName) return;
    page.name = detectedName;
    page.nameMode = 'auto';
    await saveConfig();
    log(`已自動更新粉專名稱：${detectedName}`, channel);
  }
});
let scheduleTimer = null;
let hotspotTimer = null;
let formPrewarmTimer = null;
let funboxTimer = null;
let funboxSandboxTimer = null;
const shoppingTimers = new Map();
const shoppingTargetRuntime = new Map();
const japanTimers = new Map();
const japanTargetRuntime = new Map();
let amazonJpTimer = null;
let saleReminderTimer = null;
let dutyNotificationTimer = null;
let discordAutomationTimer = null;
let funboxBoostProductIds = new Set();
let facebookBlockHandlingPromise = null;
const FACEBOOK_BLOCK_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const SALE_DIRECT_CHECK_LEAD_MS = 10 * 60 * 1000;
const SALE_DIRECT_CHECK_GRACE_MS = 30 * 60 * 1000;
const SALE_DIRECT_CHECK_INTERVAL_MS = 3_000;

function facebookCooldownRemaining(now = Date.now()) {
  const until = Date.parse(runtime.facebookCooldownUntil || '');
  return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}

function closeFacebookBrowserWhenIdle(retries = 40) {
  if (!watcher.running) {
    void scanner.close().catch((error) => log(`關閉 Facebook 背景瀏覽器失敗：${error.message}`));
    return;
  }
  if (retries <= 0) return;
  setTimeout(() => closeFacebookBrowserWhenIdle(retries - 1), 250);
}

async function handleFacebookAccessBlock(error, channel) {
  if (error?.code !== 'FACEBOOK_ACCESS_BLOCKED') return false;
  if (facebookBlockHandlingPromise) {
    await facebookBlockHandlingPromise;
    return true;
  }
  facebookBlockHandlingPromise = (async () => {
    const now = new Date();
    const cooldownUntil = new Date(now.getTime() + FACEBOOK_BLOCK_COOLDOWN_MS).toISOString();
    runtime.facebookCooldownUntil = cooldownUntil;
    runtime.lastError = `Facebook 暫時限制存取；已暫停掃描至 ${new Date(cooldownUntil).toLocaleString('zh-TW')}，之後自動重試。`;
    state.data.facebookAccess = {
      blockedAt: now.toISOString(),
      cooldownUntil
    };
    clearSchedule();
    clearHotspotSchedule();
    clearFormPrewarmSchedule();
    await state.save();
    closeFacebookBrowserWhenIdle();
    log(runtime.lastError, channel);
    if (config.monitoringEnabled) {
      scheduleNext({ immediate: true });
      scheduleHotspot({ immediate: true });
    }
  })();
  try {
    await facebookBlockHandlingPromise;
  } finally {
    facebookBlockHandlingPromise = null;
  }
  return true;
}

function clearSchedule() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = null;
  runtime.nextScanAt = null;
}

function clearHotspotSchedule() {
  if (hotspotTimer) clearTimeout(hotspotTimer);
  hotspotTimer = null;
  runtime.nextHotspotAt = null;
}

function clearFormPrewarmSchedule() {
  if (formPrewarmTimer) clearTimeout(formPrewarmTimer);
  formPrewarmTimer = null;
  runtime.nextFormPrewarmAt = null;
}

function clearFunboxSchedule() {
  if (funboxTimer) clearTimeout(funboxTimer);
  funboxTimer = null;
  runtime.nextFunboxAt = null;
}

function clearFunboxSandboxSchedule() {
  if (funboxSandboxTimer) clearTimeout(funboxSandboxTimer);
  funboxSandboxTimer = null;
  runtime.nextFunboxSandboxAt = null;
}

function clearShoppingSchedule(targetId = null) {
  const ids = targetId ? [String(targetId)] : [...shoppingTimers.keys()];
  for (const id of ids) {
    const timer = shoppingTimers.get(id);
    if (timer) clearTimeout(timer);
    shoppingTimers.delete(id);
    const targetRuntime = shoppingTargetRuntime.get(id);
    if (targetRuntime) targetRuntime.nextScanAt = null;
  }
  runtime.nextShoppingAt = null;
}

function clearShoppingBoost(targetId = null) {
  const ids = targetId ? [String(targetId)] : [...shoppingTargetRuntime.keys()];
  for (const id of ids) {
    const targetRuntime = shoppingTargetRuntime.get(id);
    if (targetRuntime) targetRuntime.boostUntil = null;
  }
  runtime.shoppingBoostUntil = null;
}

function shoppingRuntimeFor(targetId) {
  const id = String(targetId);
  if (!shoppingTargetRuntime.has(id)) {
    shoppingTargetRuntime.set(id, { nextScanAt: null, scanning: false, boostUntil: null, lastScan: null });
  }
  return shoppingTargetRuntime.get(id);
}

function activeHoursForShoppingTarget(target) {
  return shoppingActiveHoursForTarget(target, config.shoppingSites.activeHours);
}

function isShoppingTargetWithinActiveHours(target, date = new Date()) {
  const hours = activeHoursForShoppingTarget(target);
  return isWithinActiveHours(date, hours.start, hours.end);
}

function isShoppingTargetBoostActive(targetId, now = Date.now()) {
  const targetRuntime = shoppingRuntimeFor(targetId);
  const boostUntil = Date.parse(targetRuntime.boostUntil || '');
  if (!Number.isFinite(boostUntil) || now >= boostUntil) {
    targetRuntime.boostUntil = null;
    return false;
  }
  return true;
}

function isShoppingBoostActive(now = Date.now()) {
  return config.shoppingSites.targets.some((target) => (
    target.enabled !== false && isShoppingTargetBoostActive(target.id, now)
  ));
}

function effectiveShoppingIntervalSeconds(now = Date.now()) {
  const intervals = config.shoppingSites.targets
    .filter((target) => target.enabled !== false)
    .map((target) => shoppingTargetIntervalSeconds(target, now));
  return intervals.length ? Math.min(...intervals) : config.shoppingSites.intervalSeconds;
}

function shoppingTargetIntervalSeconds(target, now = Date.now()) {
  const normalInterval = Math.min(
    3600,
    Math.max(2, Number(target?.intervalSeconds) || config.shoppingSites.intervalSeconds)
  );
  const discoveryInterval = target?.sourceType === 'eslite-keywords' ? Math.min(normalInterval, 3) : normalInterval;
  return isShoppingTargetBoostActive(target?.id, now)
    ? Math.min(discoveryInterval, config.shoppingSites.boostIntervalSeconds)
    : discoveryInterval;
}

function updateShoppingBoost(targetId, result, now = new Date()) {
  if (!result || result.skipped) return;
  const targetRuntime = shoppingRuntimeFor(targetId);
  const changed = (result.restocked || 0) > 0
    || (result.discovered || 0) > 0
    || (result.stockChanged || 0) > 0
    || (result.unavailableListings || 0) > 0
    || (result.variantChanges || []).length > 0;
  if (changed) {
    const wasActive = isShoppingTargetBoostActive(targetId, now.getTime());
    targetRuntime.boostUntil = new Date(
      now.getTime() + config.shoppingSites.boostDurationMinutes * 60 * 1000
    ).toISOString();
    const target = config.shoppingSites.targets.find((item) => String(item.id) === String(targetId));
    if (/eslite\.com/i.test(target?.url || '') || /誠品/.test(target?.siteName || target?.name || '')) {
      autoPurchase.notePlatformActivity('eslite', {
        durationMs: config.shoppingSites.boostDurationMinutes * 60 * 1000
      });
    }
    log(`${target?.name || targetId}：${wasActive ? '獨立熱點已延長' : '偵測到變化，獨立切換熱點'}，每 ${shoppingTargetIntervalSeconds(target, now.getTime())} 秒掃描；其他專區維持各自排程。`, 'shopping');
  }
  runtime.shoppingBoostUntil = [...shoppingTargetRuntime.values()]
    .map((item) => item.boostUntil).filter(Boolean).sort().at(-1) || null;
}

function clearSaleReminderSchedule() {
  if (saleReminderTimer) clearTimeout(saleReminderTimer);
  saleReminderTimer = null;
  runtime.nextSaleReminderCheckAt = null;
}

function clearDutyNotificationSchedule() {
  if (dutyNotificationTimer) clearInterval(dutyNotificationTimer);
  dutyNotificationTimer = null;
}

function clearDiscordAutomationSchedule() {
  if (discordAutomationTimer) clearInterval(discordAutomationTimer);
  discordAutomationTimer = null;
}

async function syncDiscordAutomation() {
  const results = {};
  try {
    results.saleBoard = await syncDiscordSaleBoard({
      state,
      reminders: config.shoppingSites.saleReminders
    });
  } catch (error) {
    results.saleBoard = { error: error.message };
    log(`Discord momo 待售看板更新失敗：${error.message}`, 'shopping');
  }
  try {
    results.status = await syncDiscordStatusChannel({
      activeStart: config.discordAutomation.statusActiveStart,
      activeEnd: config.discordAutomation.statusActiveEnd
    });
  } catch (error) {
    results.status = { error: error.message };
    log(`Discord 監控狀態頻道更新失敗：${error.message}`);
  }
  runtime.discordAutomation = results;
  return results;
}

function scheduleDiscordAutomation() {
  clearDiscordAutomationSchedule();
  void syncDiscordAutomation();
  discordAutomationTimer = setInterval(() => {
    void syncDiscordAutomation();
  }, 60_000);
}

async function checkDutyNotifications() {
  for (const notifier of [facebookDutyNotifier, funboxDutyNotifier, shoppingDutyNotifier]) {
    try {
      await notifier.check();
    } catch (error) {
      log(`每日掃描時段通知失敗：${error.message}`);
    }
  }
}

function scheduleDutyNotificationChecks() {
  clearDutyNotificationSchedule();
  void checkDutyNotifications();
  dutyNotificationTimer = setInterval(() => {
    void checkDutyNotifications();
  }, 10_000);
}

function scheduleFormPrewarm() {
  clearFormPrewarmSchedule();
  if (!config.monitoringEnabled || !config.hotspot.enabled || !config.hotspot.autoFillEnabled || !hotspotPages().length) return;
  const now = new Date();
  const withinHours = isWithinActiveHours(now, config.hotspot.activeHours.start, config.hotspot.activeHours.end);
  const untilStart = withinHours ? 0 : millisecondsUntilActiveStart(now, config.hotspot.activeHours.start);
  const delay = Math.max(0, untilStart - 2 * 60 * 1000);
  runtime.nextFormPrewarmAt = new Date(now.getTime() + delay).toISOString();
  formPrewarmTimer = setTimeout(async () => {
    formPrewarmTimer = null;
    runtime.nextFormPrewarmAt = null;
    if (!config.monitoringEnabled || !config.hotspot.enabled || !config.hotspot.autoFillEnabled) return;
    try {
      await Promise.all(selectedFormAutoFillWorkers().map(({ worker }) => worker.prewarm()));
      log(`背景填表瀏覽器已預熱：第 ${configuredParticipantSlots().join('、')} 組。`, 'hotspot');
    } catch (error) {
      log(`台茂背景填表瀏覽器預熱失敗：${error.message}`, 'hotspot');
    }
  }, delay);
}

function activeFacebookPages() {
  return config.pages.filter((page) => page.enabled !== false);
}

function configuredHotspotPageUrls() {
  const configured = Array.isArray(config.hotspot.pageUrls) && config.hotspot.pageUrls.length
    ? config.hotspot.pageUrls
    : [config.hotspot.pageUrl].filter(Boolean);
  const knownUrls = new Set(activeFacebookPages().map((page) => page.url));
  return [...new Set(configured.map(String))].filter((url) => knownUrls.has(url));
}

function hotspotPages() {
  const selected = new Set(configuredHotspotPageUrls());
  return config.pages.filter((page) => selected.has(page.url));
}

function hotspotPage() {
  return hotspotPages()[0];
}

function isHotspotPageUrl(pageUrl) {
  return configuredHotspotPageUrls().includes(pageUrl);
}

function hotspotModeActive(date = new Date()) {
  return Boolean(config.monitoringEnabled)
    && Boolean(config.hotspot.enabled)
    && hotspotPages().length > 0
    && isWithinActiveHours(date, config.hotspot.activeHours.start, config.hotspot.activeHours.end);
}

function hotspotCadence(date = new Date()) {
  const burstActive = Boolean(config.hotspot.burstModeEnabled)
    && isWithinActiveHours(date, config.hotspot.burstHours.start, config.hotspot.burstHours.end);
  return {
    burstActive,
    intervalSeconds: burstActive ? config.hotspot.burstIntervalSeconds : config.hotspot.intervalSeconds,
    pageLoadSeconds: burstActive ? config.hotspot.burstPageLoadSeconds : config.hotspot.pageLoadSeconds
  };
}

function hotspotWaitMilliseconds(date = new Date(), elapsedMilliseconds = 0) {
  const cadence = hotspotCadence(date);
  let wait = cadence.intervalSeconds * 1000 - elapsedMilliseconds;
  if (config.hotspot.burstModeEnabled && !cadence.burstActive) {
    wait = Math.min(wait, millisecondsUntilActiveStart(date, config.hotspot.burstHours.start));
  }
  return Math.max(500, wait);
}

function scheduledRegularPages(date = new Date()) {
  return selectFacebookModePages(config.pages, {
    hotspotEnabled: config.hotspot.enabled,
    hotspotActive: hotspotModeActive(date),
    hotspotPageUrls: configuredHotspotPageUrls()
  }).regularPages;
}

function scheduleHotspot({ immediate = false, delayOverride } = {}) {
  clearHotspotSchedule();
  if (!config.monitoringEnabled || !config.hotspot.enabled || !hotspotPages().length) return;
  const now = new Date();
  const withinHours = isWithinActiveHours(now, config.hotspot.activeHours.start, config.hotspot.activeHours.end);
  const normalDelay = delayOverride ?? (withinHours
    ? (immediate ? 0 : hotspotWaitMilliseconds(now))
    : millisecondsUntilActiveStart(now, config.hotspot.activeHours.start));
  const delay = Math.max(normalDelay, facebookCooldownRemaining(now.getTime()));
  runtime.nextHotspotAt = new Date(now.getTime() + delay).toISOString();
  hotspotTimer = setTimeout(async () => {
    hotspotTimer = null;
    runtime.nextHotspotAt = null;
    if (!config.monitoringEnabled || !config.hotspot.enabled) return;
    if (!isWithinActiveHours(new Date(), config.hotspot.activeHours.start, config.hotspot.activeHours.end)) {
      await closeAllFormAutoFillWorkers();
      scheduleFormPrewarm();
      scheduleHotspot({ immediate: true });
      return;
    }
    const targets = hotspotPages();
    const startedAt = Date.now();
    const scanCadence = hotspotCadence(new Date());
    try {
      if (!targets.length) throw new Error('熱點粉專已不在監控清單中');
      const keepFormBrowserWarm = config.hotspot.autoFillEnabled
        ? Promise.all(selectedFormAutoFillWorkers().map(({ worker }) => worker.getStatus().browserOpen ? Promise.resolve() : worker.prewarm()))
        : Promise.resolve();
      await Promise.all([watcher.scanAll({
        pages: targets,
        channel: 'hotspot',
        pageLoadSeconds: scanCadence.pageLoadSeconds
      }), keepFormBrowserWarm]);
    } catch (error) {
      if (!await handleFacebookAccessBlock(error, 'hotspot')) {
        runtime.lastError = error.message;
        log(`熱點掃描失敗：${error.message}`, 'hotspot');
      }
    } finally {
      if (config.monitoringEnabled && config.hotspot.enabled) {
        const remaining = hotspotWaitMilliseconds(new Date(), Date.now() - startedAt);
        scheduleHotspot({ delayOverride: remaining });
      }
    }
  }, delay);
}

function scheduleNext({ immediate = false } = {}) {
  clearSchedule();
  if (!config.monitoringEnabled || !activeFacebookPages().length) return;
  const now = new Date();
  const withinHours = isWithinActiveHours(now, config.activeHours.start, config.activeHours.end);
  const normalDelay = withinHours
    ? (immediate ? 0 : config.scanIntervalMinutes * 60 * 1000)
    : millisecondsUntilActiveStart(now, config.activeHours.start);
  const delay = Math.max(normalDelay, facebookCooldownRemaining(now.getTime()));
  runtime.nextScanAt = new Date(now.getTime() + delay).toISOString();
  if (!withinHours && immediate) {
    log(`目前是休息時段；將於 ${config.activeHours.start} 自動恢復掃描。`, 'regular');
  }
  scheduleTimer = setTimeout(async () => {
    scheduleTimer = null;
    runtime.nextScanAt = null;
    if (!config.monitoringEnabled) return;
    if (!isWithinActiveHours(new Date(), config.activeHours.start, config.activeHours.end)) {
      scheduleNext({ immediate: true });
      return;
    }
    try {
      await watcher.scanAll({ pages: scheduledRegularPages() });
    } catch (error) {
      if (!await handleFacebookAccessBlock(error, 'regular')) {
        runtime.lastError = error.message;
        log(`排程掃描失敗：${error.message}`, 'regular');
      }
    } finally {
      if (config.monitoringEnabled) scheduleNext();
      else await scanner.close();
    }
  }, delay);
}

function clearFunboxBoost() {
  funboxBoostProductIds = new Set();
  runtime.funboxBoostUntil = null;
  runtime.funboxBoostProductCount = 0;
}

function isFunboxBoostActive(now = Date.now()) {
  const boostUntil = Date.parse(runtime.funboxBoostUntil || '');
  if (!funboxBoostProductIds.size || !Number.isFinite(boostUntil) || now >= boostUntil) {
    clearFunboxBoost();
    return false;
  }
  return true;
}

function effectiveFunboxIntervalSeconds(now = Date.now()) {
  return isFunboxBoostActive(now)
    ? config.funbox.boostIntervalSeconds
    : config.funbox.intervalSeconds;
}

function updateFunboxBoost(result, now = new Date()) {
  if (!result || result.skipped) return;
  if (!result.firstRun && result.discovered > 0) {
    for (const product of result.discoveredProducts || []) {
      if (product.available !== false && product.stock !== 0) {
        funboxBoostProductIds.add(String(product.id));
      }
    }
    if (funboxBoostProductIds.size) {
      runtime.funboxBoostUntil = new Date(
        now.getTime() + config.funbox.boostDurationMinutes * 60 * 1000
      ).toISOString();
      log(
        `Funbox 發現新品，切換為每 ${config.funbox.boostIntervalSeconds} 秒高速追蹤庫存。`,
        'funbox'
      );
    }
  }

  if (funboxBoostProductIds.size) {
    const products = new Map(
      (result.products || []).map((product) => [String(product.id), product])
    );
    for (const productId of [...funboxBoostProductIds]) {
      const product = products.get(productId);
      if (!product || product.available === false || Number(product.stock) === 0) {
        funboxBoostProductIds.delete(productId);
      }
    }
  }

  runtime.funboxBoostProductCount = funboxBoostProductIds.size;
  if (!funboxBoostProductIds.size) clearFunboxBoost();
  else isFunboxBoostActive(now.getTime());
}

function scheduleFunbox({ immediate = false, delayMs = null } = {}) {
  clearFunboxSchedule();
  if (!config.funbox.enabled) {
    void syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'funbox'));
    return;
  }
  const now = new Date();
  const withinHours = isWithinActiveHours(
    now,
    config.funbox.activeHours.start,
    config.funbox.activeHours.end
  );
  const delay = withinHours
    ? (immediate
        ? 0
        : delayMs === null
          ? effectiveFunboxIntervalSeconds(now.getTime()) * 1000
          : Math.max(0, Number(delayMs) || 0))
    : millisecondsUntilActiveStart(now, config.funbox.activeHours.start);
  runtime.nextFunboxAt = new Date(now.getTime() + delay).toISOString();
  funboxTimer = setTimeout(async () => {
    funboxTimer = null;
    runtime.nextFunboxAt = null;
    if (!config.funbox.enabled) {
      await syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'funbox'));
      return;
    }
    if (!isWithinActiveHours(
      new Date(),
      config.funbox.activeHours.start,
      config.funbox.activeHours.end
    )) {
      await syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'funbox'));
      scheduleFunbox({ immediate: true });
      return;
    }
    await syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'funbox'));
    runtime.funboxScanning = true;
    const scanStartedAtMs = Date.now();
    try {
      runtime.lastFunboxScan = await funboxMonitor.scan({
        notifyExistingOnFirstRun: config.funbox.notifyExistingOnFirstRun,
        notifyStockChanges: config.funbox.stockChangeNotificationsEnabled
      });
      enqueueFunboxAutoPurchase(runtime.lastFunboxScan);
      updateFunboxBoost(runtime.lastFunboxScan);
    } catch (error) {
      runtime.lastError = `Funbox 官網：${error.message}`;
      log(`Funbox 官網掃描失敗：${error.message}`, 'funbox');
    } finally {
      runtime.funboxScanning = false;
      if (config.funbox.enabled) {
        const intervalMs = effectiveFunboxIntervalSeconds(Date.now()) * 1000;
        scheduleFunbox({
          delayMs: fixedCadenceRemainingMs(intervalMs, scanStartedAtMs)
        });
      }
    }
  }, delay);
}

function scheduleFunboxSandbox({ immediate = false } = {}) {
  clearFunboxSandboxSchedule();
  if (!config.funboxSandbox.enabled) return;
  const delay = immediate ? 0 : config.funboxSandbox.intervalSeconds * 1000;
  runtime.nextFunboxSandboxAt = new Date(Date.now() + delay).toISOString();
  funboxSandboxTimer = setTimeout(async () => {
    funboxSandboxTimer = null;
    runtime.nextFunboxSandboxAt = null;
    if (!config.funboxSandbox.enabled) return;
    runtime.funboxSandboxScanning = true;
    try {
      runtime.lastFunboxSandboxScan = await funboxSandboxMonitor.scan({
        notifyStockChanges: config.funbox.stockChangeNotificationsEnabled
      });
    } catch (error) {
      runtime.lastError = `Funbox 沙盒：${error.message}`;
      log(`Funbox 沙盒掃描失敗：${error.message}`, 'funbox');
    } finally {
      runtime.funboxSandboxScanning = false;
      if (config.funboxSandbox.enabled) scheduleFunboxSandbox();
    }
  }, delay);
}

function refreshShoppingRuntimeSummary() {
  const active = config.shoppingSites.targets
    .filter((target) => target.enabled !== false)
    .map((target) => shoppingRuntimeFor(target.id));
  runtime.shoppingScanning = active.some((item) => item.scanning);
  runtime.nextShoppingAt = active.map((item) => item.nextScanAt).filter(Boolean).sort()[0] || null;
  runtime.shoppingBoostUntil = active.map((item) => item.boostUntil).filter(Boolean).sort().at(-1) || null;
}

function combineShoppingScanResults(results) {
  const valid = results.filter((result) => result && !result.skipped);
  const totals = (field) => valid.reduce((sum, result) => sum + Number(result[field] || 0), 0);
  return {
    completedAt: new Date().toISOString(),
    mode: 'parallel',
    checkedTargets: totals('checkedTargets'),
    checkedProducts: totals('checkedProducts'),
    discovered: totals('discovered'),
    unavailableListings: totals('unavailableListings'),
    ignoredUnavailable: totals('ignoredUnavailable'),
    excluded: totals('excluded'),
    restocked: totals('restocked'),
    stockChanged: totals('stockChanged'),
    notified: totals('notified'),
    durationMs: Math.max(0, ...valid.map((result) => Number(result.durationMs || 0))),
    variantChanges: valid.flatMap((result) => result.variantChanges || []),
    purchaseCandidates: valid.flatMap((result) => result.purchaseCandidates || []),
    purchaseCandidatesDispatched: valid.length > 0 && valid.every((result) => result.purchaseCandidatesDispatched),
    errors: valid.flatMap((result) => result.errors || [])
  };
}

function scheduleShoppingTarget(target, { immediate = false, delayMs = null } = {}) {
  clearShoppingSchedule(target.id);
  if (!config.shoppingSites.enabled || target.enabled === false) return;
  const now = new Date();
  const activeHours = activeHoursForShoppingTarget(target);
  const withinHours = isWithinActiveHours(now, activeHours.start, activeHours.end);
  const intervalSeconds = shoppingTargetIntervalSeconds(target, now.getTime());
  const requestedDelay = Number(delayMs);
  const hasRequestedDelay = delayMs !== null
    && delayMs !== undefined
    && Number.isFinite(requestedDelay)
    && requestedDelay >= 0;
  const delay = withinHours
    ? (immediate ? 0 : hasRequestedDelay ? requestedDelay : intervalSeconds * 1000)
    : millisecondsUntilActiveStart(now, activeHours.start);
  const targetRuntime = shoppingRuntimeFor(target.id);
  targetRuntime.nextScanAt = new Date(Date.now() + delay).toISOString();
  const timer = setTimeout(async () => {
    shoppingTimers.delete(String(target.id));
    targetRuntime.nextScanAt = null;
    const currentTarget = config.shoppingSites.targets.find((item) => String(item.id) === String(target.id));
    if (!config.shoppingSites.enabled || !currentTarget || currentTarget.enabled === false) {
      await syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'shopping'));
      refreshShoppingRuntimeSummary();
      return;
    }
    if (!isShoppingTargetWithinActiveHours(currentTarget, new Date())) {
      await syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'shopping'));
      scheduleShoppingTarget(currentTarget, { immediate: true });
      refreshShoppingRuntimeSummary();
      return;
    }
    await syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'shopping'));
    targetRuntime.scanning = true;
    const scanStartedAt = Date.now();
    refreshShoppingRuntimeSummary();
    try {
      const mmToyFast = currentTarget.sourceType === 'mmtoy-category'
        && isShoppingTargetBoostActive(currentTarget.id, scanStartedAt);
      const result = await shoppingSiteMonitor.scan({
        notifyStockChanges: config.shoppingSites.stockChangeNotificationsEnabled,
        targetIds: [currentTarget.id],
        mmToyFast
      });
      targetRuntime.lastScan = result;
      if (!result.skipped) runtime.lastShoppingScan = result;
      enqueueEsliteAutoPurchase(result);
      updateShoppingBoost(currentTarget.id, result);
    } catch (error) {
      runtime.lastError = `${currentTarget.name}：${error.message}`;
      log(`${currentTarget.name} 掃描失敗：${error.message}`, 'shopping');
    } finally {
      targetRuntime.scanning = false;
      if (config.shoppingSites.enabled && currentTarget.enabled !== false) {
        const nextIntervalSeconds = shoppingTargetIntervalSeconds(currentTarget);
        const nextDelayMs = Math.max(
          100,
          nextIntervalSeconds * 1000 - (Date.now() - scanStartedAt)
        );
        scheduleShoppingTarget(currentTarget, { delayMs: nextDelayMs });
      }
      refreshShoppingRuntimeSummary();
    }
  }, delay);
  shoppingTimers.set(String(target.id), timer);
  refreshShoppingRuntimeSummary();
}

function scheduleShopping({ immediate = false, targetId = null } = {}) {
  if (targetId) {
    const target = config.shoppingSites.targets.find((item) => String(item.id) === String(targetId));
    if (target) scheduleShoppingTarget(target, { immediate });
    return;
  }
  clearShoppingSchedule();
  if (!config.shoppingSites.enabled) {
    void syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'shopping'));
    return;
  }
  for (const target of config.shoppingSites.targets.filter((item) => item.enabled !== false)) {
    scheduleShoppingTarget(target, { immediate });
  }
  refreshShoppingRuntimeSummary();
  void syncAutoPurchaseWindowState().catch((error) => log(`登入心跳排程更新失敗：${error.message}`, 'shopping'));
}

function japanRuntimeFor(targetId) {
  const id = String(targetId);
  if (!japanTargetRuntime.has(id)) {
    japanTargetRuntime.set(id, {
      nextScanAt: null, scanning: false, boostUntil: null, lastScan: null,
      failureCount: 0, backoffUntil: null, lastError: ''
    });
  }
  return japanTargetRuntime.get(id);
}

function refreshJapanRuntimeSummary() {
  const active = config.japanAuctions.targets.filter((target) => target.enabled !== false).map((target) => japanRuntimeFor(target.id));
  runtime.japanScanning = active.some((item) => item.scanning);
  runtime.nextJapanAt = active.map((item) => item.nextScanAt).filter(Boolean).sort()[0] || null;
}

function clearJapanSchedule(targetId = null) {
  const ids = targetId ? [String(targetId)] : [...japanTimers.keys()];
  for (const id of ids) {
    const timer = japanTimers.get(id);
    if (timer) clearTimeout(timer);
    japanTimers.delete(id);
    const targetRuntime = japanTargetRuntime.get(id);
    if (targetRuntime) targetRuntime.nextScanAt = null;
  }
  refreshJapanRuntimeSummary();
}

function scheduleJapanTarget(target, { immediate = false, delayMs = null } = {}) {
  clearJapanSchedule(target.id);
  if (!config.japanAuctions.enabled || target.enabled === false) return;
  if (target.sourceType === 'edion' && target.transport === 'chrome-bridge') return;
  const now = new Date();
  const withinHours = isWithinActiveHours(now, config.japanAuctions.activeHours.start, config.japanAuctions.activeHours.end);
  const targetRuntime = japanRuntimeFor(target.id);
  // General Japanese sites stay on their normal cadence. Amazon.co.jp has its
  // own independent scheduler and is intentionally not affected here.
  targetRuntime.boostUntil = null;
  const seconds = Math.max(config.japanAuctions.intervalSeconds, Number(target.minIntervalSeconds) || 0);
  const requestedDelay = optionalDelayMs(delayMs, seconds * 1000);
  const delay = withinHours ? (immediate ? 0 : requestedDelay) : millisecondsUntilActiveStart(now, config.japanAuctions.activeHours.start);
  targetRuntime.nextScanAt = new Date(Date.now() + delay).toISOString();
  targetRuntime.backoffUntil = withinHours && requestedDelay > seconds * 1000
    ? targetRuntime.nextScanAt
    : null;
  const timer = setTimeout(async () => {
    japanTimers.delete(String(target.id));
    targetRuntime.nextScanAt = null;
    const current = config.japanAuctions.targets.find((item) => item.id === target.id);
    if (!config.japanAuctions.enabled || !current || current.enabled === false) return refreshJapanRuntimeSummary();
    targetRuntime.scanning = true;
    refreshJapanRuntimeSummary();
    let retryDelayMs = null;
    try {
      const result = await japanAuctionMonitor.scanTarget(current);
      targetRuntime.lastScan = result;
      targetRuntime.failureCount = 0;
      targetRuntime.lastError = '';
      runtime.lastJapanScan = { ...result, completedAt: new Date().toISOString(), siteName: current.siteName };
    } catch (error) {
      targetRuntime.failureCount = Number(targetRuntime.failureCount || 0) + 1;
      targetRuntime.lastError = error.message;
      retryDelayMs = japanAuctionFailureDelayMs(current.sourceType, targetRuntime.failureCount, config.japanAuctions.intervalSeconds, {
        verificationRequired: error.code === 'verification_required'
      });
      runtime.lastError = `${current.name}：${error.message}`;
      const retrySeconds = Math.ceil(retryDelayMs / 1000);
      log(`${current.name} 掃描失敗：${error.message}｜${retrySeconds} 秒後重試`, 'japan');
    } finally {
      targetRuntime.scanning = false;
      if (config.japanAuctions.enabled && current.enabled !== false) scheduleJapanTarget(current, { delayMs: retryDelayMs });
      refreshJapanRuntimeSummary();
    }
  }, delay);
  japanTimers.set(String(target.id), timer);
  refreshJapanRuntimeSummary();
}

function scheduleJapan({ immediate = false, targetId = null } = {}) {
  if (targetId) {
    const target = config.japanAuctions.targets.find((item) => item.id === String(targetId));
    if (target) scheduleJapanTarget(target, { immediate });
    return;
  }
  clearJapanSchedule();
  if (!config.japanAuctions.enabled) return;
  for (const target of config.japanAuctions.targets.filter((item) => item.enabled !== false)) scheduleJapanTarget(target, { immediate });
}

function clearAmazonJpSchedule() {
  if (amazonJpTimer) clearTimeout(amazonJpTimer);
  amazonJpTimer = null;
  runtime.nextAmazonJpAt = null;
}

async function runAmazonJpScan(options = {}) {
  if (runtime.amazonJpScanning) return { skipped: true };
  runtime.amazonJpScanning = true;
  try {
    const result = await amazonJapanMonitor.scan(options);
    if (!result.skipped) runtime.lastAmazonJpScan = result;
    return result;
  } finally {
    runtime.amazonJpScanning = false;
  }
}

function scheduleAmazonJp({ immediate = false, delayMs = null } = {}) {
  clearAmazonJpSchedule();
  if (!config.amazonJp.enabled) return;
  const configuredDelay = (config.amazonJp.adaptiveIntervalEnabled
    ? runtime.amazonJpAdaptiveIntervalSeconds
    : config.amazonJp.intervalSeconds) * 1000;
  const delay = immediate
    ? 0
    : Number.isFinite(Number(delayMs))
      ? Math.max(0, Number(delayMs))
      : configuredDelay;
  runtime.nextAmazonJpAt = new Date(Date.now() + delay).toISOString();
  amazonJpTimer = setTimeout(async () => {
    amazonJpTimer = null;
    runtime.nextAmazonJpAt = null;
    const cycleStartedAt = Date.now();
    let nextDelay = configuredDelay;
    try {
      await runAmazonJpScan();
      runtime.amazonJpFailureCount = 0;
      runtime.amazonJpBackoffUntil = null;
      if (config.amazonJp.adaptiveIntervalEnabled) {
        runtime.amazonJpAdaptiveIntervalSeconds = nextAmazonJapanAdaptiveInterval(
          runtime.amazonJpAdaptiveIntervalSeconds,
          'success'
        );
        runtime.amazonJpCadenceMode = runtime.amazonJpAdaptiveIntervalSeconds > 20 ? 'recovery' : 'normal';
        nextDelay = runtime.amazonJpAdaptiveIntervalSeconds * 1000;
      }
    } catch (error) {
      runtime.amazonJpFailureCount += 1;
      runtime.amazonJpAdaptiveIntervalSeconds = nextAmazonJapanAdaptiveInterval(
        runtime.amazonJpAdaptiveIntervalSeconds,
        'blocked'
      );
      runtime.amazonJpCadenceMode = 'recovery';
      nextDelay = runtime.amazonJpAdaptiveIntervalSeconds * 1000;
      runtime.amazonJpBackoffUntil = new Date(Date.now() + nextDelay).toISOString();
      log(
        `日亞官方原價掃描失敗：${error.message}｜第 ${runtime.amazonJpFailureCount} 次連續失敗，`
        + `線性降速至 ${runtime.amazonJpAdaptiveIntervalSeconds} 秒後重試。`,
        'japan'
      );
    } finally {
      if (config.amazonJp.enabled) {
        const delayAfterElapsed = runtime.amazonJpFailureCount > 0
          ? nextDelay
          : Math.max(0, nextDelay - (Date.now() - cycleStartedAt));
        scheduleAmazonJp({ delayMs: delayAfterElapsed });
      }
    }
  }, delay);
}

function hasPendingSaleReminder(now = Date.now()) {
  return config.shoppingSites.saleReminders.some((reminder) =>
    reminder.enabled !== false
    && Number.isFinite(Date.parse(reminder.saleStartAt))
    && Date.parse(reminder.saleStartAt) > now - SALE_DIRECT_CHECK_GRACE_MS
  );
}

async function pruneExpiredSaleReminders(now = Date.now()) {
  const expired = config.shoppingSites.saleReminders.filter((reminder) =>
    Number.isFinite(Date.parse(reminder.saleStartAt))
    && Date.parse(reminder.saleStartAt) <= now - SALE_DIRECT_CHECK_GRACE_MS
  );
  if (!expired.length) return 0;
  const expiredIds = new Set(expired.map((reminder) => reminder.id));
  config.shoppingSites.saleReminders = config.shoppingSites.saleReminders.filter(
    (reminder) => !expiredIds.has(reminder.id)
  );
  if (state.data.commerce?.saleReminders) {
    for (const id of expiredIds) delete state.data.commerce.saleReminders[id];
  }
  await Promise.all([saveConfig(), state.save()]);
  log(`已自動移除 ${expired.length} 個已開賣提醒。`, 'shopping');
  return expired.length;
}

async function verifyStartedMomoSaleReminders(now = Date.now()) {
  if (!config.shoppingSites.enabled) return [];
  const due = config.shoppingSites.saleReminders
    .filter((reminder) => reminder.enabled !== false)
    .filter((reminder) => /momoshop\.com\.tw\/product\/\d+/i.test(reminder.url || ''))
    .filter((reminder) => {
      const saleStart = Date.parse(reminder.saleStartAt || '');
      return Number.isFinite(saleStart)
        && saleStart <= now
        && saleStart > now - SALE_DIRECT_CHECK_GRACE_MS;
    });
  const unique = [...new Map(due.map((reminder) => [reminder.url, reminder])).values()].slice(0, 2);
  const results = await Promise.allSettled(unique.map(async (reminder) => {
    try {
      const result = await shoppingSiteMonitor.verifyKnownMomoProduct(reminder.url, {
        notifyStockChanges: config.shoppingSites.stockChangeNotificationsEnabled,
        reason: 'scheduled-sale-direct-check'
      });
      state.data.commerce ||= {};
      state.data.commerce.saleReminders ||= {};
      const record = state.data.commerce.saleReminders[reminder.id] || { handledMinutes: [] };
      record.productCheckedAt = new Date().toISOString();
      record.productAvailable = result.product?.available ?? null;
      record.productStock = result.product?.variants?.find((variant) => Number.isFinite(Number(variant.stock)))?.stock ?? null;
      record.productError = '';
      state.data.commerce.saleReminders[reminder.id] = record;
      return result;
    } catch (error) {
      state.data.commerce ||= {};
      state.data.commerce.saleReminders ||= {};
      const record = state.data.commerce.saleReminders[reminder.id] || { handledMinutes: [] };
      record.productCheckedAt = new Date().toISOString();
      record.productError = error.message;
      state.data.commerce.saleReminders[reminder.id] = record;
      log(`momo 開賣單品直查失敗｜${reminder.name}：${error.message}`, 'shopping');
      return { error: error.message };
    }
  }));
  if (unique.length) await state.save();
  return results;
}

function scheduleSaleReminders({ immediate = false } = {}) {
  clearSaleReminderSchedule();
  if (!hasPendingSaleReminder()) return;
  const now = Date.now();
  const hotWindow = config.shoppingSites.saleReminders.some((reminder) => {
    const saleStart = Date.parse(reminder.saleStartAt || '');
    return reminder.enabled !== false
      && Number.isFinite(saleStart)
      && saleStart <= now + SALE_DIRECT_CHECK_LEAD_MS
      && saleStart > now - SALE_DIRECT_CHECK_GRACE_MS;
  });
  const delay = immediate ? 0 : hotWindow ? SALE_DIRECT_CHECK_INTERVAL_MS : 15_000;
  runtime.nextSaleReminderCheckAt = new Date(Date.now() + delay).toISOString();
  saleReminderTimer = setTimeout(async () => {
    saleReminderTimer = null;
    runtime.nextSaleReminderCheckAt = null;
    try {
      runtime.lastSaleReminderCheck = await saleReminderMonitor.check();
      runtime.lastSaleDirectChecks = await verifyStartedMomoSaleReminders();
      await pruneExpiredSaleReminders();
    } catch (error) {
      runtime.lastError = `開賣倒數提醒：${error.message}`;
      log(`開賣倒數提醒檢查失敗：${error.message}`, 'shopping');
    } finally {
      scheduleSaleReminders();
    }
  }, delay);
}

async function runManualScan() {
  const result = await watcher.scanAll({ manual: true });
  if (!config.monitoringEnabled) await scanner.close();
  return result;
}

async function runManualHotspotScan() {
  const targets = hotspotPages();
  if (!targets.length) throw new Error('找不到熱點粉專');
  return watcher.scanAll({ manual: true, pages: targets, channel: 'hotspot', pageLoadSeconds: config.hotspot.pageLoadSeconds });
}

async function runManualFunboxScan() {
  runtime.funboxScanning = true;
  try {
    runtime.lastFunboxScan = await funboxMonitor.scan({
      notifyExistingOnFirstRun: config.funbox.notifyExistingOnFirstRun,
      notifyStockChanges: config.funbox.stockChangeNotificationsEnabled
    });
    enqueueFunboxAutoPurchase(runtime.lastFunboxScan);
    updateFunboxBoost(runtime.lastFunboxScan);
    return runtime.lastFunboxScan;
  } finally {
    runtime.funboxScanning = false;
  }
}

async function runManualFunboxSandboxScan() {
  runtime.funboxSandboxScanning = true;
  try {
    runtime.lastFunboxSandboxScan = await funboxSandboxMonitor.scan({
      notifyStockChanges: config.funbox.stockChangeNotificationsEnabled
    });
    return runtime.lastFunboxSandboxScan;
  } finally {
    runtime.funboxSandboxScanning = false;
  }
}

async function runManualShoppingScan() {
  runtime.shoppingScanning = true;
  try {
    const enabledTargets = config.shoppingSites.targets.filter((target) => target.enabled !== false);
    const results = await Promise.all(enabledTargets.map((target) => shoppingSiteMonitor.scan({
      notifyStockChanges: config.shoppingSites.stockChangeNotificationsEnabled,
      targetIds: [target.id]
    })));
    const combined = combineShoppingScanResults(results);
    runtime.lastShoppingScan = combined;
    enqueueEsliteAutoPurchase(combined);
    enabledTargets.forEach((target, index) => updateShoppingBoost(target.id, results[index]));
    return combined;
  } finally {
    runtime.shoppingScanning = false;
  }
}

async function runManualJapanScan() {
  runtime.japanScanning = true;
  try {
    const targets = config.japanAuctions.targets.filter((target) => target.enabled !== false);
    const results = await Promise.allSettled(targets.map((target) => japanAuctionMonitor.scanTarget(target)));
    const successful = results.filter((item) => item.status === 'fulfilled' && !item.value.skipped).map((item) => item.value);
    const failed = results.filter((item) => item.status === 'rejected');
    const result = {
      completedAt: new Date().toISOString(),
      checkedTargets: successful.length,
      checkedProducts: successful.reduce((sum, item) => sum + Number(item.checkedProducts || 0), 0),
      discovered: successful.reduce((sum, item) => sum + Number(item.discovered || 0), 0),
      restocked: successful.reduce((sum, item) => sum + Number(item.restocked || 0), 0),
      notified: successful.reduce((sum, item) => sum + Number(item.notified || 0), 0),
      errors: failed.map((item) => item.reason?.message || String(item.reason))
    };
    runtime.lastJapanScan = result;
    return result;
  } finally {
    runtime.japanScanning = false;
  }
}

async function runJapanUx15NotificationTest() {
  const { text, options, product } = japanAuctionTestNotification();
  const messageId = await sendNotification(text, {
    ...options,
    channelMode: 'discord',
    discordAudience: 'japan'
  });
  const destination = await checkDiscordConnection('japan');
  const messageUrl = destination.guildId && destination.channelId && messageId
    ? `https://discord.com/channels/${destination.guildId}/${destination.channelId}/${messageId}`
    : '';
  log(`1999.co.jp UX-15 測試通知已送出${messageId ? `｜回覆 ID：${messageId}` : ''}`, 'japan');
  return {
    message: '1999.co.jp UX-15 測試通知已送到日本拍賣 Discord。',
    messageId: messageId || '',
    messageUrl,
    destination,
    product
  };
}

async function runAmazonJpNotificationTest(body = {}) {
  const { text, options, product } = amazonJapanTestNotification(body, amazonJapanMonitor.status().manualProducts);
  const messageId = await sendNotification(text, {
    ...options,
    channelMode: 'discord',
    discordAudience: 'japan'
  });
  log(`日亞官方原價 ${product.code} 測試通知已送出${messageId ? `｜回覆 ID：${messageId}` : ''}`, 'japan');
  return { message: `日亞官方原價 ${product.code} 測試通知已送到日本拍賣 Discord。`, messageId: messageId || '', product };
}

async function runLiveFunboxProductNotificationTest() {
  const response = await fetch(FUNBOX_LIVE_TEST_URL, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Funbox 正式商品測試 HTTP ${response.status}`);
  const products = parseFunboxResponse(await response.text(), FUNBOX_LIVE_TEST_URL);
  const product = products.find((item) =>
    item.title && item.url && item.imageUrl && item.price && item.stock !== null
  );
  if (!product) throw new Error('正式官網目前沒有可完整驗證名稱、圖片、價格與庫存的測試商品');

  const messageId = await sendNotification(
    `🧪 正式官網商品資料測試（不是真實陀螺上架）\n\n${formatFunboxNotification(product)}`,
    {
      discordPreview: funboxDiscordPreview(product, { test: true }),
      embeds: [funboxEmbed(product, { test: true })],
      channelMode: config.notifications.funbox
    }
  );
  log(`Funbox 正式商品資料測試已通知：${product.title}${messageId ? `｜${messageId}` : ''}`, 'funbox');
  return {
    message: `測試推播已送出：${product.title}｜庫存 ${product.stock}｜不會寫入陀螺監控基線`,
    product: {
      id: product.id,
      title: product.title,
      price: product.price,
      stock: product.stock,
      imageUrl: product.imageUrl,
      url: product.url
    },
    messageId
  };
}

async function runFunboxPurchaseNotificationTest() {
  const product = {
    id: 'test-notification-ux21',
    title: 'BEYBLADE X 戰鬥陀螺 UX-21 惡魔冥界改造組',
    url: 'https://shop.funbox.com.tw/products/bb08554'
  };
  const message = formatFunboxAccountPurchaseNotification(product, {
    slot: 'B', ok: true, status: 'ordered', purchaseStatus: 'success', quantity: 1,
    payment: 'virtual_atm_home',
    orderNumber: 'TEST-NOTIFICATION-NO-ORDER',
    paymentUrl: 'https://shop.funbox.com.tw/orders/test-notification-no-order',
    resultUrl: 'https://shop.funbox.com.tw/orders/test-notification-no-order',
    paymentDeadline: '測試通知，不需付款', durationMs: 8275, attempts: 1,
    products: [product],
    productResults: [{ product, quantity: 1, status: 'ordered' }]
  });
  const messageId = await sendNotification(
    `🧪 測試通知（不會建立訂單）\n\n${message.text}`,
    {
      channelMode: 'discord', discordAudience: 'private',
      discordPreview: `🧪 ${message.preview}`
    }
  );
  const destination = await checkDiscordConnection('private');
  const messageUrl = destination.guildId && destination.channelId && messageId
    ? `https://discord.com/channels/${destination.guildId}/${destination.channelId}/${messageId}`
    : '';
  log(`Funbox 自動購買結果樣式測試已送到私人 Discord${messageId ? `｜${messageId}` : ''}`, 'funbox');
  return {
    message: 'Funbox 自動購買結果樣式已送到私人 Discord；沒有建立訂單。',
    messageId: messageId || '', messageUrl, destination
  };
}

async function runSimulatedRestockNotificationTest(body = {}) {
  if (body.type === 'facebook') throw new Error('Facebook 已封存：1010FB暫存');
  if (body.type === 'shopee') {
    const audience = body.audience === 'private' ? 'private' : 'public';
    const result = await shopee.test(audience);
    log(`蝦皮 FUNBOX 模擬通知已送到${audience === 'private' ? '私人管理' : '公開情報'}頻道｜${result.messageId}`);
    return {...result, routedAudience: audience};
  }
  const type = ['mmtoy', 'shopping', 'funbox', 'facebook'].includes(String(body.type))
    ? String(body.type)
    : 'mmtoy';
  const requestedAudience = body.audience === 'private' ? 'private' : 'public';
  const discordAudience = requestedAudience === 'private'
    ? 'private'
    : type === 'mmtoy' ? 'mmtoy' : 'public';
  let text;
  let embed;

  if (type === 'funbox') {
    const product = normalizeFunboxSimulationProduct(body.funbox || body);
    text = funboxDiscordPreview(product, { test: true });
    embed = funboxEmbed(product, { test: true });
  } else if (type === 'facebook') {
    const url = 'https://www.facebook.com/';
    text = '🧪 FB 模擬通知｜方爸測試\n戰鬥陀螺販售情報｜點擊查看貼文';
    embed = {
      author: { name: '陀螺通知監控儀表・FB 販售情報', url },
      title: '🧪 戰鬥陀螺販售情報（模擬）',
      url,
      color: 0x3c82f6,
      description: '**店家：** 方爸測試\n**關鍵字：** 戰鬥陀螺、販售、表單\n\n**原文：** [查看 Facebook 貼文](https://www.facebook.com/)',
      footer: { text: '模擬通知・不是真實貼文' },
      timestamp: new Date().toISOString()
    };
  } else {
    const mmtoy = type === 'mmtoy';
    const target = mmtoy ? {
      name: 'MM小舖戰鬥陀螺專區',
      siteName: 'MM小舖',
      url: 'https://mmtoyshop.com/category/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA',
      sourceType: 'mmtoy-category'
    } : {
      name: '墊腳石 TAKARA TOMY 專區',
      siteName: 'momo購物網',
      url: 'https://www.momoshop.com.tw/TP/TP0002451/main'
    };
    const product = mmtoy ? {
      id: 'simulation-mmtoy-ux16',
      title: '【M.M小舖】『預購』 9月 TAKARA TOMY 戰鬥陀螺 UX-16 時鐘幻象 隨機強化組 對戰 復古 熱血',
      url: 'https://mmtoyshop.com/category/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA',
      price: 'NT$350'
    } : {
      id: 'simulation-momo-ux14',
      title: 'BEYBLADE X 戰鬥陀螺 CX／BX／UX 系列',
      url: 'https://www.momoshop.com.tw/TP/TP0002451/main',
      price: 'NT$1,250'
    };
    const variant = mmtoy
      ? { id: 'simulation-mmtoy-variant', name: '預購-1個(不可搭其他預購) #不補', stock: 1, available: true }
      : { id: 'simulation-momo-variant', name: 'UX-14 天蠍長矛', stock: 18, available: true };
    text = notificationPreview(target, product, variant, 'restock', { test: true });
    embed = notificationEmbed(target, product, variant, 'restock', { test: true });
    if (!mmtoy) {
      text = `🧪 模擬｜${text.replace(/^[^ ]+\s*/, '')}`;
      embed = {
        ...embed,
        title: `🧪 ${embed.title}`,
        footer: { text: '模擬通知・不是真實補貨' }
      };
    }
  }

  const username = type === 'mmtoy' ? 'MM小舖獨立通知' : '陀螺通知監控儀表';
  const messageId = await sendNotification(text, {
    embeds: [embed],
    channelMode: 'discord',
    discordAudience,
    username
  });
  const destination = await checkDiscordConnection(discordAudience);
  const messageUrl = destination.guildId && destination.channelId && messageId
    ? `https://discord.com/channels/${destination.guildId}/${destination.channelId}/${messageId}`
    : '';
  const labels = { mmtoy: 'M.M小舖補貨', shopping: '購物網站補貨', funbox: 'Funbox 官網上架', facebook: 'FB 販售情報' };
  log(`${labels[type]}模擬通知已送到${requestedAudience === 'private' ? '私人管理頻道' : discordAudience === 'mmtoy' ? 'M.M小舖獨立頻道' : '公開情報頻道'}${messageId ? `｜${messageId}` : ''}`);
  return {
    message: `${labels[type]}模擬通知已由 Discord 接受`,
    messageId: messageId || '',
    messageUrl,
    destination,
    routedAudience: discordAudience
  };
}

function approximatePublishedTime(label, now = new Date()) {
  const value = String(label || '').replace(/\s+/g, '');
  if (value.includes('剛剛')) return now.getTime();
  let match = value.match(/(\d+)分鐘/);
  if (match) return now.getTime() - Number(match[1]) * 60 * 1000;
  match = value.match(/(\d+)小時/);
  if (match) return now.getTime() - Number(match[1]) * 60 * 60 * 1000;
  match = value.match(/昨天(?:上午|下午)?(\d{1,2}):(\d{2})/);
  if (match) {
    let hour = Number(match[1]);
    if (value.includes('下午') && hour < 12) hour += 12;
    if (value.includes('上午') && hour === 12) hour = 0;
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    date.setHours(hour, Number(match[2]), 0, 0);
    return date.getTime();
  }
  match = value.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (match) return new Date(Number(match[1] || now.getFullYear()), Number(match[2]) - 1, Number(match[3])).getTime();
  return 0;
}

async function performSelfCheck() {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add('控制服務', 'pass', '127.0.0.1:3210 正常回應，控制頁可用。');

  for (const [name, mode, audience] of [
    ['FUNBOX 通知', config.notifications.funbox, 'public'],
    ['購物網站通知', config.notifications.shopping, 'public'],
    ['私人訂單通知', 'discord', 'private']
  ]) {
    try {
      const info = await checkNotificationConnection(mode, { discordAudience: audience });
      add(name, 'pass', info.channel + ' 已連線。');
    } catch (error) { add(name, 'warn', error.message); }
  }
  add('FUNBOX／購物網站', 'pass', '設定與狀態可讀取；此檢查不送單、不推播。');

  const overall = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn') ? 'warn' : 'pass';
  const result = { overall, completedAt: new Date().toISOString(), checks };
  runtime.lastSelfCheck = result;
  log(`功能自檢完成：${overall === 'pass' ? '全部通過' : overall === 'warn' ? '通過但有警告' : '發現失敗項目'}。`);
  return {
    ...result,
    message: overall === 'pass' ? '功能自檢全部通過。' : overall === 'warn' ? '功能自檢完成，請查看警告項目。' : '功能自檢發現失敗項目。'
  };
}

function scanResultForDashboard(scanResult) {
  if (!scanResult || scanResult.relevantPages?.length || !Number(scanResult.relevant)) return scanResult;
  const completedAt = Date.parse(scanResult.completedAt);
  if (!Number.isFinite(completedAt)) return scanResult;
  const candidates = Object.values(state.data.seen || {})
    .filter((post) => post.relevant && post.isToday && post.pageName && post.lastDetectedAt)
    .filter((post) => {
      const detectedAt = Date.parse(post.lastDetectedAt);
      return Number.isFinite(detectedAt) && detectedAt <= completedAt && detectedAt >= completedAt - 2 * 60 * 60 * 1000;
    })
    .sort((left, right) => Date.parse(right.lastDetectedAt) - Date.parse(left.lastDetectedAt))
    .slice(0, Number(scanResult.relevant));
  const pageCounts = new Map();
  for (const post of candidates) {
    const key = post.pageUrl || post.pageName;
    const previous = pageCounts.get(key) || { name: post.pageName, url: post.pageUrl || '', count: 0 };
    previous.count += 1;
    pageCounts.set(key, previous);
  }
  return { ...scanResult, relevantPages: [...pageCounts.values()] };
}

const shopee = await new ShopeeBridge({
  file: path.join(rootDir, 'data', 'shopee-monitor.json'),
  parentEnabled: () => config.shoppingSites.enabled && !config.systemPause.active,
  notify: async (text, audience) => {
    const messageId = await sendNotification(text, { channelMode: 'discord', discordAudience: audience, username: '蝦皮陀螺追蹤' });
    if (!messageId) throw new Error('Discord 未回傳訊息編號，送達狀態未知');
    // Message creation already succeeded; a metadata lookup failure must not turn
    // it into a false delivery failure (and invite duplicate sends).
    const destination = await checkDiscordConnection(audience).catch(() => ({}));
    return { message: 'Discord 已接受蝦皮通知', destination, messageId, messageUrl: destination.guildId && destination.channelId ? `https://discord.com/channels/${destination.guildId}/${destination.channelId}/${messageId}` : '' };
  }
}).load();

function captureSystemResumeState() {
  return {
    monitoringEnabled: Boolean(config.monitoringEnabled),
    funboxEnabled: Boolean(config.funbox.enabled),
    funboxSandboxEnabled: Boolean(config.funboxSandbox.enabled),
    shoppingEnabled: Boolean(config.shoppingSites.enabled),
    japanEnabled: Boolean(config.japanAuctions.enabled),
    amazonJpEnabled: Boolean(config.amazonJp.enabled),
    autoPurchaseEnabled: Boolean(config.autoPurchase.enabled),
    amazonProductOrders: Object.fromEntries(['A', 'B', 'C'].map((slot) => [
      slot,
      Boolean(config.amazonJpProductOrders?.[slot]?.enabled)
    ]))
  };
}

function applySystemResumeState(resumeState = {}) {
  config.monitoringEnabled = Boolean(resumeState.monitoringEnabled);
  config.funbox.enabled = Boolean(resumeState.funboxEnabled);
  config.funboxSandbox.enabled = Boolean(resumeState.funboxSandboxEnabled);
  config.shoppingSites.enabled = Boolean(resumeState.shoppingEnabled);
  config.japanAuctions.enabled = Boolean(resumeState.japanEnabled);
  config.amazonJp.enabled = Boolean(resumeState.amazonJpEnabled);
  config.autoPurchase.enabled = Boolean(resumeState.autoPurchaseEnabled);
  for (const slot of ['A', 'B', 'C']) {
    if (config.amazonJpProductOrders?.[slot]) {
      config.amazonJpProductOrders[slot].enabled = Boolean(resumeState.amazonProductOrders?.[slot]);
    }
  }
}

function disableAllRuntimeFeatures() {
  applySystemResumeState({
    monitoringEnabled: false,
    funboxEnabled: false,
    funboxSandboxEnabled: false,
    shoppingEnabled: false,
    japanEnabled: false,
    amazonJpEnabled: false,
    autoPurchaseEnabled: false,
    amazonProductOrders: { A: false, B: false, C: false }
  });
}

const runtimeMetrics = createRuntimeMetrics({ state });
const esliteDashboardProbe = { checkedAtMs: 0, result: null, promise: null };
async function probeEsliteExhibitionForDashboard() {
  const now = Date.now();
  if (esliteDashboardProbe.result && now - esliteDashboardProbe.checkedAtMs < 30_000) {
    return esliteDashboardProbe.result;
  }
  if (esliteDashboardProbe.promise) return esliteDashboardProbe.promise;
  esliteDashboardProbe.promise = (async () => {
    const checkedAt = new Date().toISOString();
    try {
      const products = await shoppingSiteMonitor.loadEsliteExhibitProducts(ESLITE_EXHIBITION_DISCOVERY_URLS[0]);
      const page = products.discoveryPage || {};
      const productCount = Math.max(0, Number(page.productCount) || products.length || 0);
      const status = page.isLive === false && page.unavailableReason === 'page_not_found'
        ? '404'
        : productCount > 0
          ? 'live'
          : 'empty';
      const target = config.shoppingSites.targets.find((item) => item.sourceType === 'eslite-keywords');
      if (target && status !== 'live') {
        await shoppingSiteMonitor.applyImmediateEsliteDiscoveryPage(target, {
          ...page,
          url: ESLITE_EXHIBITION_DISCOVERY_URLS[0],
          productCount,
          isLive: false,
          unavailableReason: status === '404' ? 'page_not_found' : 'no_products'
        });
      }
      return {
        status,
        url: ESLITE_EXHIBITION_DISCOVERY_URLS[0],
        title: String(page.title || ''),
        productCount,
        checkedAt
      };
    } catch (error) {
      return {
        status: 'error',
        url: ESLITE_EXHIBITION_DISCOVERY_URLS[0],
        productCount: 0,
        checkedAt,
        error: String(error?.message || error).slice(0, 300)
      };
    }
  })().then((result) => {
    esliteDashboardProbe.result = result;
    esliteDashboardProbe.checkedAtMs = Date.now();
    return result;
  }).finally(() => {
    esliteDashboardProbe.promise = null;
  });
  return esliteDashboardProbe.promise;
}
const purchaseReadiness = new PurchaseReadinessCheck({
  dataDir, credentialStore: purchaseCredentials, getConfig: () => normalizeAutoPurchaseConfig(config.autoPurchase),
  isBusy: () => autoPurchase.activeWorkers > 0 || autoPurchase.maintenanceRunning
    || Object.values(autoPurchase.adapters).some(adapter => (adapter.runtimeStatus?.().accounts || [])
      .some(account => account.busy || account.interactiveLoginOpen || account.loginState === 'checking'))
});
const esliteBrowser = new EsliteSessionBridge({ state, importSession: body => autoPurchase.adapters.eslite.importBrowserSession(body) });
const dashboard = createDashboard({
  amazonRace,
  esliteBrowser,
  onCheckPurchaseReadiness: (body = {}) => purchaseReadiness.check(String(body.platform || '')),
  shopee,
  edionBrowser,
  port: config.dashboardPort,
  funboxSandbox,
  formPreviewImageFile: path.join(dataDir, 'form-preview.png'),
  formPreviewMetaFile: path.join(dataDir, 'form-preview.json'),
  log,
  onProbeEsliteExhibition: probeEsliteExhibitionForDashboard,
  getStatus: () => ({
    ...runtime,
    systemPause: {
      active: config.systemPause.active,
      pausedAt: config.systemPause.pausedAt || null
    },
    performance: runtimeMetrics.snapshot(),
    shopee: shopee.status(),
    lastScan: scanResultForDashboard(runtime.lastScan),
    lastHotspotScan: scanResultForDashboard(runtime.lastHotspotScan),
    note: dashboardNote,
    monitoringEnabled: config.monitoringEnabled,
    interval: config.scanIntervalMinutes,
    pageCount: activeFacebookPages().length,
    totalPageCount: config.pages.length,
    pausedPageCount: config.pages.length - activeFacebookPages().length,
    pages: config.pages.map((page) => ({ ...page })),
    productKeywords: [...config.productKeywords],
    salesKeywords: [...config.salesKeywords],
    notificationReady: hasNotificationConfig(config.notifications.facebook),
    notificationChannel: notificationChannelName(config.notifications.facebook),
    notifications: {
      facebook: config.notifications.facebook,
      funbox: config.notifications.funbox,
      shopping: config.notifications.shopping,
      hotspot: config.notifications.hotspot,
      availability: notificationAvailability(),
      facebookReady: hasNotificationConfig(config.notifications.facebook),
      funboxReady: hasNotificationConfig(config.notifications.funbox),
      shoppingReady: hasNotificationConfig(config.notifications.shopping),
      japanReady: hasDiscordWebhook('japan'),
      hotspotReady: hasNotificationConfig(config.notifications.hotspot, { discordAudience: 'private' }),
      facebookLabel: notificationChannelName(config.notifications.facebook),
      funboxLabel: notificationChannelName(config.notifications.funbox),
      shoppingLabel: notificationChannelName(config.notifications.shopping),
      hotspotLabel: notificationChannelName(config.notifications.hotspot, { discordAudience: 'private' })
    },
    browserMode: scanner.getMode(),
    browserOpenPages: scanner.getOpenPageCount(),
    activeHours: { ...config.activeHours },
    withinActiveHours: isWithinActiveHours(new Date(), config.activeHours.start, config.activeHours.end),
    nextScanAt: runtime.nextScanAt,
    funbox: {
      ...config.funbox,
      nextScanAt: runtime.nextFunboxAt,
      scanning: runtime.funboxScanning,
      withinActiveHours: isWithinActiveHours(
        new Date(),
        config.funbox.activeHours.start,
        config.funbox.activeHours.end
      ),
      boostActive: isFunboxBoostActive(),
      boostUntil: runtime.funboxBoostUntil,
      boostProductCount: runtime.funboxBoostProductCount,
      effectiveIntervalSeconds: effectiveFunboxIntervalSeconds(),
      lastScan: runtime.lastFunboxScan,
      seenCount: Object.keys(state.data.commerce?.funbox?.seen || {}).length,
      excludedCount: Object.keys(state.data.commerce?.funbox?.excluded || {}).length,
      recentExcludedProducts: Object.entries(state.data.commerce?.funbox?.excluded || {})
        .map(([id, product]) => ({ id, ...product }))
        .sort((left, right) => String(right.lastSeenAt || '').localeCompare(String(left.lastSeenAt || '')))
        .slice(0, 20),
      recentProducts: Object.entries(state.data.commerce?.funbox?.seen || {})
        .map(([id, product]) => ({ id, ...product }))
        .sort((left, right) => String(right.firstSeenAt || '').localeCompare(String(left.firstSeenAt || '')))
        .slice(0, 20)
    },
    funboxSandbox: {
      ...config.funboxSandbox,
      ...funboxSandbox.status(),
      nextScanAt: runtime.nextFunboxSandboxAt,
      scanning: runtime.funboxSandboxScanning,
      lastScan: runtime.lastFunboxSandboxScan,
      initialized: Boolean(state.data.commerce?.funboxSandbox?.initialized),
      seenCount: Object.keys(state.data.commerce?.funboxSandbox?.seen || {}).length,
      recentProducts: Object.entries(state.data.commerce?.funboxSandbox?.seen || {})
        .map(([id, product]) => ({ id, ...product }))
        .sort((left, right) => String(right.firstSeenAt || '').localeCompare(String(left.firstSeenAt || '')))
        .slice(0, 20)
    },
    shoppingSites: {
      ...config.shoppingSites,
      esliteManualProducts: shoppingSiteMonitor.esliteManualProducts(),
      nextScanAt: runtime.nextShoppingAt,
      scanning: runtime.shoppingScanning,
      boostActive: isShoppingBoostActive(),
      boostUntil: runtime.shoppingBoostUntil,
      effectiveIntervalSeconds: effectiveShoppingIntervalSeconds(),
      nextFullScanAt: runtime.lastShoppingFullScanAt
        ? new Date(Date.parse(runtime.lastShoppingFullScanAt) + config.shoppingSites.intervalSeconds * 1000).toISOString()
        : null,
      nextSaleReminderCheckAt: runtime.nextSaleReminderCheckAt,
      lastSaleReminderCheck: runtime.lastSaleReminderCheck,
      withinActiveHours: config.shoppingSites.targets.some((target) => (
        target.enabled !== false && isShoppingTargetWithinActiveHours(target, new Date())
      )),
      generalWithinActiveHours: isWithinActiveHours(
        new Date(), config.shoppingSites.activeHours.start, config.shoppingSites.activeHours.end
      ),
      lastScan: runtime.lastShoppingScan,
      targets: config.shoppingSites.targets.map((target) => {
        const saved = state.data.commerce?.shoppingSites?.targets?.[target.id];
        const targetRuntime = shoppingRuntimeFor(target.id);
        const boostActive = target.enabled !== false && isShoppingTargetBoostActive(target.id);
        const activeHours = activeHoursForShoppingTarget(target);
        return {
          ...target,
          scheduleGroup: target.scheduleMode === 'custom' ? 'custom' : 'default',
          activeHours,
          withinActiveHours: isWithinActiveHours(new Date(), activeHours.start, activeHours.end),
          scanning: targetRuntime.scanning,
          nextScanAt: targetRuntime.nextScanAt,
          boostActive,
          boostUntil: targetRuntime.boostUntil,
          effectiveIntervalSeconds: shoppingTargetIntervalSeconds(target),
          initialized: Boolean(saved?.initialized),
          productCount: Number(saved?.lastProductCount || 0),
          baselineCount: Object.keys(saved?.seen || {}).length,
          baselineProducts: Object.values(saved?.seen || {}).map((product) => ({
            id: String(product?.id || ''),
            title: String(product?.title || ''),
            url: String(product?.url || ''),
            firstSeenAt: product?.firstSeenAt || null
          })),
          esliteRoutes: saved?.esliteRoutes || null,
          esliteBaselineSweep: saved?.esliteBaselineSweep || null,
          discoveryPages: Object.values(saved?.discoveryPages || {}),
          excludedCount: Number(saved?.lastExcludedCount || 0),
          lastScanAt: saved?.lastScanAt || null,
          lastError: target.baselineVersion && saved?.baselineVersion !== target.baselineVersion
            ? ''
            : saved?.lastError || ''
        };
      }),
      saleReminders: config.shoppingSites.saleReminders.map((reminder) => ({
        ...reminder,
        handledMinutes: state.data.commerce?.saleReminders?.[reminder.id]?.handledMinutes || [],
        lastNotifiedAt: state.data.commerce?.saleReminders?.[reminder.id]?.lastNotifiedAt || null,
        lastNotifiedMinutes: state.data.commerce?.saleReminders?.[reminder.id]?.lastNotifiedMinutes || null,
        productCheckedAt: state.data.commerce?.saleReminders?.[reminder.id]?.productCheckedAt || reminder.productCheckedAt || null,
        productAvailable: state.data.commerce?.saleReminders?.[reminder.id]?.productAvailable ?? reminder.available ?? null,
        productStock: state.data.commerce?.saleReminders?.[reminder.id]?.productStock ?? reminder.stock ?? null,
        productError: state.data.commerce?.saleReminders?.[reminder.id]?.productError || ''
      }))
    },
    japanAuctions: {
      ...config.japanAuctions,
      edionBrowser: edionBrowser.status(),
      scanning: runtime.japanScanning,
      nextScanAt: runtime.nextJapanAt,
      lastScan: runtime.lastJapanScan,
      withinActiveHours: isWithinActiveHours(new Date(), config.japanAuctions.activeHours.start, config.japanAuctions.activeHours.end),
      notificationReady: hasDiscordWebhook('japan'),
      amazonJp: {
        ...config.amazonJp,
        ...amazonJapanMonitor.status(),
        scanning: runtime.amazonJpScanning,
        nextScanAt: runtime.nextAmazonJpAt,
        lastScan: runtime.lastAmazonJpScan,
        failureCount: runtime.amazonJpFailureCount,
        backoffUntil: runtime.amazonJpBackoffUntil,
        effectiveIntervalSeconds: runtime.amazonJpAdaptiveIntervalSeconds,
        cadenceMode: runtime.amazonJpCadenceMode
      },
      amazonJpProductOrders: amazonJpProductOrders.map((monitor) => monitor.status()),
      targets: config.japanAuctions.targets.map((target) => {
        const saved = japanAuctionMonitor.status(target);
        const targetRuntime = japanRuntimeFor(target.id);
        const chromeBridge = target.transport === 'chrome-bridge' ? edionBrowser.status(target.id) : null;
        const bridgeWaiting = chromeBridge && ['disconnected', 'waiting', 'paused'].includes(chromeBridge.state);
        const boostActive = false;
        return {
          ...target,
          ...(chromeBridge ? { chromeBridge } : {}),
          ...(target.sourceType === 'rakuten-item' ? { singleProduct: Object.values(saved.products || {})
            .map(({ title, price, available, stock }) => ({ title, price, available, stock }))[0] || null } : {}),
          initialized: Boolean(saved.initialized),
          productCount: Number(saved.lastProductCount || 0),
          baselineProductCount: Object.keys(saved.products || {}).length,
          lastRawProductCount: Number(saved.lastRawProductCount || 0),
          excludedCount: Number(saved.lastExcludedCount || 0),
          lastScanAt: saved.lastScanAt || null,
          lastError: bridgeWaiting ? (chromeBridge.state === 'paused' ? '' : '等待普通 Chrome 連接與商品觀測；當前庫存未確認') : saved.lastError || '',
          lastErrorCode: bridgeWaiting ? 'bridge_' + chromeBridge.state : saved.lastErrorCode || '',
          lastAttemptAt: saved.lastAttemptAt || saved.lastScanAt || null,
          scanning: targetRuntime.scanning,
          nextScanAt: targetRuntime.nextScanAt,
          failureCount: Number(targetRuntime.failureCount || 0),
          backoffUntil: targetRuntime.backoffUntil,
          boostActive,
          effectiveIntervalSeconds: targetRuntime.backoffUntil && targetRuntime.nextScanAt
            ? Math.max(config.japanAuctions.intervalSeconds, Number(target.minIntervalSeconds) || 0, Math.ceil((Date.parse(targetRuntime.nextScanAt) - Date.now()) / 1000))
            : Math.max(config.japanAuctions.intervalSeconds, Number(target.minIntervalSeconds) || 0)
        };
      })
    },
    hotspot: {
      ...config.hotspot,
      masterEnabled: config.monitoringEnabled,
      modeActive: hotspotModeActive(),
      pageName: hotspotPage()?.name || '',
      pageNames: hotspotPages().map((page) => page.name),
      pageUrls: configuredHotspotPageUrls(),
      regularPageNames: scheduledRegularPages().map((page) => page.name),
      withinActiveHours: isWithinActiveHours(new Date(), config.hotspot.activeHours.start, config.hotspot.activeHours.end),
      burstActive: hotspotCadence().burstActive,
      effectiveIntervalSeconds: hotspotCadence().intervalSeconds,
      nextScanAt: runtime.nextHotspotAt
    },
    autoFill: {
      ...formAutoFill.getStatus(),
      participantSlots: configuredParticipantSlots(),
      workers: [...formAutoFillWorkers.entries()].map(([slot, worker]) => ({ slot, ...worker.getStatus() }))
    },
    autoPurchase: { ...autoPurchase.getStatus(), esliteMemberNames: purchaseCredentials.getEsliteMemberNames() }
  }),
  onScan: runManualScan,
  onHotspotScan: runManualHotspotScan,
  onFunboxScan: runManualFunboxScan,
  onFunboxSandboxScan: runManualFunboxSandboxScan,
  onShoppingScan: runManualShoppingScan,
  onJapanScan: runManualJapanScan,
  onTestJapanNotification: runJapanUx15NotificationTest,
  onAmazonJpScan: () => runAmazonJpScan({ forceCatalog: true }),
  onTestAmazonJpNotification: runAmazonJpNotificationTest,
  onSaveAmazonJpProductOrder: async (body) => {
    const slot = String(body.slot || 'A').toUpperCase();
    const amazonJpProductOrder = amazonJpProductOrderBySlot[slot];
    if (!amazonJpProductOrder) throw new Error('日亞任務只能選擇 A、B、C');
    amazonJpProductOrder.assertIdle();
    const enabled = Boolean(body.enabled);
    const current = config.amazonJpProductOrders[slot];
    const targetUrl = normalizeAmazonJpProductUrl(body.targetUrl || current.targetUrl);
    const targetSuccessCount = Math.max(1, Math.min(99, Number(body.targetSuccessCount) || 1));
    const taskChanged = targetUrl !== current.targetUrl || targetSuccessCount !== current.targetSuccessCount;
    if ((taskChanged || body.resetProgress === true) && amazonRaceCoordinator.pending(slot)) throw new Error('雙路有進行中／待核對交易，不能換商品或重設');
    if ((taskChanged || body.resetProgress === true) && amazonJpProductOrder.hasPendingApiTransaction()) {
      throw new Error('日亞 API 有未核對交易，不能換商品或重設；請先核對官方訂單／購物車');
    }
    const mode = normalizeAmazonJpProductMode(body.mode ?? current.mode);
    if (!enabled) await amazonRaceCoordinator.cancel(slot);
    if (taskChanged || body.resetProgress === true) await amazonRaceCoordinator.reset(slot);
    amazonJpProductOrder.stop();
    config.amazonJpProductOrders[slot] = {
      enabled,
      mode,
      checkoutTransport: current.checkoutTransport === 'browser' ? 'browser' : 'api',
      // Old, still-open dashboard tabs always sent false for B/C. Once the
      // task has been upgraded, a normal settings save must not downgrade it.
      fastLane: current.fastLane === true || (body.fastLane ?? current.fastLane ?? true) === true,
      targetUrl,
      targetSuccessCount,
      maxShippingYen: Math.max(0, Math.min(10_000, Number(body.maxShippingYen ?? current.maxShippingYen ?? 500) || 0)),
      priceToleranceYen: Math.max(0, Math.min(10, Number(body.priceToleranceYen) || 1))
    };
    if (taskChanged || body.resetProgress === true) await amazonJpProductOrder.resetProgress();
    await saveConfig();
    if (enabled) await amazonJpProductOrder.start();
    else {
      await amazonJpProductOrder.closeBrowser();
      amazonJpProductOrder.interactive = false;
    }
    const modeDescription = mode === 'hybrid' ? `每 ${amazonJpProductOrder.pollIntervalMs() / 1000} 秒檢查＋補貨訊號立即觸發；不重疊，結帳中停止刷新，遇阻擋降速` : '只由日亞原價監控的同 ASIN 新品／補貨訊號觸發，不定時刷新';
    log(`日亞商品頁任務 ${slot} 已${enabled ? '啟用' : '停止'}；${modeDescription}。`, 'japan', { persist: false });
    return { message: enabled ? `日亞任務 ${slot} 已啟用：${modeDescription}；成功 ${targetSuccessCount} 次後停止。${amazonJpProductOrder.interactive ? '目前登入視窗開啟中，請先完成登入檢查。' : ''}` : `日亞任務 ${slot} 已停止。` };
  },
  onOpenAmazonJpProductOrderLogin: (body = {}) => (amazonJpProductOrderBySlot[String(body.slot || 'A').toUpperCase()] || amazonJpProductOrderBySlot.A).openLogin(),
  onCompleteAmazonJpProductOrderLogin: (body = {}) => (amazonJpProductOrderBySlot[String(body.slot || 'A').toUpperCase()] || amazonJpProductOrderBySlot.A).completeLogin(),
  onClearAmazonJpProductOrderLogs: async () => {
    for (const monitor of Object.values(amazonJpProductOrderBySlot)) monitor.clearDiagnostics();
    for (const runtime of amazonRace.runtime.values()) { runtime.steps = []; runtime.refreshCount = 0; }
    for (const key of ['logs', 'japanLogs']) runtime[key] = (runtime[key] || []).filter(line => !/日亞任務 [ABC]｜|日亞商品頁任務 [ABC]/.test(line));
    await state.save();
    return { message: '已清空 ABC 即時 LOG 與刷新次數；任務繼續執行，下單紀錄不受影響。' };
  },
  onReadAmazonJpOrderEvidence: (recordId,fileName) => amazonOrderHistory.readEvidence(recordId,fileName),
  onScanAmazonJpProductOrder: async (body = {}) => {
    const amazonJpProductOrder = amazonJpProductOrderBySlot[String(body.slot || 'A').toUpperCase()] || amazonJpProductOrderBySlot.A;
    if (body.check === true && ['granted', 'unknown'].includes(amazonRaceCoordinator.current(amazonJpProductOrder.slot)?.routes.frontend?.state)) return amazonRace.inspect(amazonJpProductOrder.slot);
    if (body.cartReviewed === true) return amazonJpProductOrder.confirmApiCartReviewed();
    if(body.check === true && amazonJpProductOrder.storage().status === 'needs_review' && amazonJpProductOrder.hasPendingApiTransaction() && !amazonJpProductOrder.canRecoverPreSubmit()){
      amazonJpProductOrder.assertIdle();
      const slot=amazonJpProductOrder.slot;
      config.amazonJpProductOrders[slot].enabled=false;amazonJpProductOrder.stop();await saveConfig();
    }
    const result = body.check === true ? await amazonJpProductOrder.check()
      : amazonJpProductOrder.storage().status === 'needs_review' && amazonJpProductOrder.hasPendingApiTransaction()
      ? await amazonJpProductOrder.reconcileApiOrder() : await amazonJpProductOrder.scanOnce();
    return { message: result.message || (result.skipped ? '任務忙碌或交易待核對；本次未加車／送單'
      : result.status === 'ordered' ? `官方查單確認成立：${result.snapshot.orderId}；沒有重送。`
      : result.status === 'submitted_unconfirmed' ? '官方訂單仍待核對；沒有重送。'
      : `API 只讀檢查完成：${result.snapshot?.asin || '目標商品'}｜${result.snapshot?.evaluation || result.status}；未觸發下單。`) };
  },
  onTestFunboxProductNotification: runLiveFunboxProductNotificationTest,
  onTestFunboxPurchaseNotification: runFunboxPurchaseNotificationTest,
  onTestSimulatedNotification: runSimulatedRestockNotificationTest,
  onSaveFunboxSettings: async (body) => {
    config.funbox.intervalSeconds = parseFunboxInterval(body.intervalSeconds);
    config.funbox.stockChangeNotificationsEnabled = Boolean(body.stockChangeNotificationsEnabled);
    config.funbox.activeHours = {
      start: parseTimeValue(body.activeStart ?? config.funbox.activeHours.start),
      end: parseTimeValue(body.activeEnd ?? config.funbox.activeHours.end)
    };
    await saveConfig();
    if (config.funbox.enabled) scheduleFunbox({ immediate: true });
    const stockText = config.funbox.stockChangeNotificationsEnabled ? '已開啟' : '已關閉';
    log(
      `Funbox 官網掃描時段已更新為 ${config.funbox.activeHours.start}～${config.funbox.activeHours.end}，`
      + `平時每 ${config.funbox.intervalSeconds} 秒；新品後每 ${config.funbox.boostIntervalSeconds} 秒，`
      + `庫存門檻通知${stockText}。`,
      'funbox'
    );
    return {
      message: `已儲存：${config.funbox.activeHours.start}～${config.funbox.activeHours.end}，`
        + `平時每 ${config.funbox.intervalSeconds} 秒；新品後每 ${config.funbox.boostIntervalSeconds} 秒強抓；`
        + `庫存門檻通知${stockText}。`
    };
  },
  onSaveNotificationSettings: async (body) => {
    config.notifications.funbox = normalizeNotificationMode(body.funbox, config.notifications.funbox);
    config.notifications.shopping = normalizeNotificationMode(body.shopping, config.notifications.shopping);
    await saveConfig();
    log(`通知通道已更新：Funbox 使用 ${notificationChannelName(config.notifications.funbox)}；購物網站使用 ${notificationChannelName(config.notifications.shopping)}。`);
    return {
      message: `已儲存：Funbox 使用 ${notificationChannelName(config.notifications.funbox)}；購物網站使用 ${notificationChannelName(config.notifications.shopping)}。`
    };
  },
  onSaveAutoPurchaseSettings: async (body) => {
    const previousPayments = { ...config.autoPurchase.eslite.accountPayments };
    const next = updateAutoPurchaseSettings(config.autoPurchase, body);
    for (const platform of ['funbox', 'eslite']) for (const [slot, payment] of Object.entries(next[platform].accountPayments)) {
      if (platform === 'funbox' && payment === 'seven_cod' && !purchaseCredentials.getPickupSetup(platform, slot)) throw new Error(`FUNBOX 帳號 ${slot}：${PICKUP_SETUP_REQUIRED}`);
    }
    config.autoPurchase = next;
    await saveConfig();
    await autoPurchase.applyRuntimeConfig();
    for (const { slot } of purchaseCredentials.getEsliteAccounts()) {
      if (previousPayments[slot] !== config.autoPurchase.eslite.accountPayments[slot]
        && purchaseCredentials.getEsliteAccounts().some(item => item.slot === slot && item.account && item.password && item.enabled)) {
        autoPurchase.adapters.eslite.scheduleAccountPreparation(slot);
      }
    }
    const name = body.platform === 'funbox' ? 'FUNBOX' : body.platform === 'eslite' ? '購物網站' : '自動下單';
    log(name + ' 設定已儲存；兩份黑白名單獨立，其他監控與通知維持。', 'shopping');
    return { message: name + ' 設定已儲存；另一平台設定不變。' };
  },
  onAddCatalogList: async (body) => {
    const { config: next, warning } = catalogListPatch(config.autoPurchase, body);
    const previous = config.autoPurchase;
    config.autoPurchase = next;
    try { await saveConfig(); } catch (error) { config.autoPurchase = previous; throw error; }
    const name = body.platform === 'funbox' ? 'FUNBOX' : '購物網站';
    const message = `${name}：${body.item.model} 已加入${body.list === 'black' ? '黑' : '白'}名單。${warning}`;
    log(message, body.platform === 'funbox' ? 'funbox' : 'shopping');
    return { message };
  },
  onSyncAutoPurchaseLists: async (body) => {
    config.autoPurchase = mergeAutoPurchaseLists(config.autoPurchase, body);
    await saveConfig();
    return { message: '已合併黑白名單：保留目的地原有項目；未更改購買模式、付款或啟用狀態。' };
  },
  onViewEsliteCredentials: (slot) => purchaseCredentials.viewEsliteCredentials(slot),
  onImportEsliteBrowserSession: (body) => autoPurchase.adapters.eslite.importBrowserSession(body),
  onEsliteDisplayIdentities: () => purchaseCredentials.getEsliteDisplayIdentities(),
  onSaveAutoPurchaseCredentials: async (body) => {
    const platform = String(body.platform || '');
    if (!['funbox', 'eslite'].includes(platform)) throw new Error('此平台自動下單已封存，不再提供帳密操作');
    let saved;
    if (platform === 'funbox') {
      const slot = String(body.accountSlot || 'A').toUpperCase();
      if (autoPurchase.activeEsliteSlots.has('funbox:' + slot)) throw new Error('此帳號正在下單，請完成後再修改帳密');
      const previous = purchaseCredentials.getFunboxAccount(slot);
      if (body.clear || body.account && String(body.account).trim().toLowerCase() !== previous.account.trim().toLowerCase()) {
        await autoPurchase.adapters.funbox.invalidateAccountSession(slot);
      }
      if (body.clear) {
        await purchaseCredentials.clearFunboxAccount(slot);
        await autoPurchase.applyRuntimeConfig();
        log(`Funbox 帳號 ${slot} 已清除；其他帳號不受影響。`, 'funbox');
        return { message: `Funbox 帳號 ${slot} 已清除。` };
      }
      saved = await purchaseCredentials.setFunboxAccount(slot, {
        account: body.account,
        password: body.password,
        enabled: body.enabled !== false
      });
      await autoPurchase.applyRuntimeConfig();
      log(`Funbox 帳號 ${slot} 已加密更新。`, 'funbox');
      return { message: `Funbox 帳號 ${slot} 已加密儲存在本機，背景登入驗證已排程。` };
    }
    if (platform === 'eslite') {
      const slot = String(body.accountSlot || 'A').toUpperCase();
      if (body.clear) {
        await purchaseCredentials.clearEsliteAccount(slot);
        await autoPurchase.applyRuntimeConfig();
        log(`誠品帳號 ${slot} 已清除；其他帳號不受影響。`, 'shopping');
        return { message: `誠品帳號 ${slot} 已清除。` };
      }
      saved = await purchaseCredentials.setEsliteAccount(slot, {
        account: body.account,
        password: body.password,
        enabled: body.enabled !== false
      });
      await autoPurchase.applyRuntimeConfig();
      log(`誠品帳號 ${slot} 已加密更新。`, 'shopping');
      if (body.enabled === false) return { message: `誠品帳號 ${slot} 已加密儲存並停用。` };
      return autoPurchase.adapters.eslite.scheduleAccountPreparation(slot);
    }
  },
  onTestAutoPurchaseLogin: async (body) => {
    const platform = String(body.platform || '');
    const result = await autoPurchase.testLogin(platform, {
      interactive: body.interactive !== false,
      accountSlot: body.accountSlot,
      manualOnly: body.manualOnly === true
    });
    log(result.message, platform === 'funbox' ? 'funbox' : 'shopping');
    return result;
  },
  onPurchaseAccountAction: (body) => autoPurchase.accountAction(body),
  onCompleteAutoPurchaseLogin: async (body) => {
    const platform = String(body.platform || '');
    const result = await autoPurchase.completeLogin(platform, { accountSlot: body.accountSlot });
    log(result.message, platform === 'funbox' ? 'funbox' : 'shopping');
    return result;
  },
  onPrepareEsliteAccount: (body) => autoPurchase.adapters.eslite.scheduleAccountPreparation(body.accountSlot),
  onProbeEslitePayments: (body) => autoPurchase.probeEslitePayments(body),
  onResolveFunboxHold: (body) => autoPurchase.resolveFunboxHold(body),
  onRefreshOrderStatuses: (body) => autoPurchase.refreshOrderStatuses(body),
  onVerifyPickupSetup: async ({ platform, accountSlot, orderReference }) => {
    if (!['funbox', 'eslite'].includes(platform) || !/^[A-Z]{1,4}$/.test(accountSlot || '')) throw new Error('平台或帳號格式不正確');
    const multi = autoPurchase.adapters[platform]; multi._syncAccounts();
    const adapter = multi.adapters[accountSlot];
    if (!adapter || adapter.activePurchaseHold() || adapter.interactiveLogin || adapter.accountBusy
      || adapter.warmWorkers?.some(worker => worker.busy) || multi.accountPurchaseTails?.has(accountSlot)
      || multi.busySlots?.has(accountSlot)) throw new Error('帳號正在執行或有待核對訂單，請稍後再核對門市');
    const account = platform === 'eslite' ? purchaseCredentials.getEsliteAccount(accountSlot) : purchaseCredentials.getFunboxAccount(accountSlot);
    const verify = async () => {
      const profile = purchaseCredentials.getPickupProfile();
      let setup;
      if (platform === 'eslite') {
        const member = await adapter.apiSessionVerifier(adapter.sessionFile);
        if (!member.ok || member.loggedIn !== true) throw new Error('本帳號會員 API 尚未確認登入，請先完成登入');
        setup = await verifyEslitePickupOrder(await adapter._ensureApiContext(), orderReference, profile);
      } else {
        if (adapter.loginState !== 'ready') throw new Error('請先檢查本帳號登入');
        const { request } = await import('playwright');
        const api = await request.newContext({ storageState: adapter.sessionFile });
        try { setup = await verifyFunboxPickupOrder(api, orderReference, profile); }
        finally { await api.dispose(); }
      }
      await purchaseCredentials.setPickupSetup(platform, accountSlot, setup, account.account);
      return { message: `帳號 ${accountSlot} 的官方貨到付款門市訂單已核對並加密保存；仍維持 ATM，現在可自行改選貨到付款。` };
    };
    if (platform === 'eslite') return adapter._withAccountLock(verify);
    let release;
    const reservation = new Promise(resolve => { release = resolve; });
    multi.accountPurchaseTails.set(accountSlot, reservation);
    try { return await verify(); }
    finally { release(); if (multi.accountPurchaseTails.get(accountSlot) === reservation) multi.accountPurchaseTails.delete(accountSlot); }
  },
  onResolveEsliteHold: (body) => body.action === 'query'
    ? autoPurchase.reconcileEsliteAccount(body) : autoPurchase.resolveEsliteHold(body),
  onRunAutoPurchaseMaintenance: async () => {
    const result = await autoPurchase.runMaintenance({ clearCart: true, reason: '控制台手動執行' });
    if (result.deferred) {
      return { message: '購買工作器正在執行，購物車保養已延後；不會清空進行中的訂單。', ...result };
    }
    const completed = result.results.filter((item) => item.result?.ok).length;
    const failed = result.results.length - completed;
    return {
      message: `購物車保養完成：${completed} 個平台登入正常並完成清理${failed ? `，${failed} 個平台需重新確認登入` : ''}。`,
      ...result
    };
  },
  onManualFunboxPurchase: async (body) => {
    if (body.confirmRealOrder !== true) {
      throw new Error('這個操作會成立真實訂單；必須明確傳入 confirmRealOrder=true');
    }
    const urls = [...new Set((Array.isArray(body.urls) ? body.urls : [body.url]).filter(Boolean))];
    if (!urls.length || urls.length > 3) throw new Error('一次可驗收 1～3 個 Funbox 商品網址');
    const detectedAt = body.detectedAt || new Date().toISOString();
    const products = await Promise.all(urls.map(inspectOfficialFunboxProduct));
    for (const product of products) product.detectedAt = detectedAt;
    log(`Funbox 真實購買驗收：模擬於 ${detectedAt} 偵測 ${products.length} 件補貨，通知與購買工作器同步執行。`, 'funbox');
    const queued = await autoPurchase.enqueue('funbox', products);
    if (queued.accepted) {
      await Promise.race([
        autoPurchase.whenIdle(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Funbox 真實購買驗收超過 4 分鐘仍未完成')), 240000))
      ]);
    }
    const productUrls = new Set(products.map((product) => product.url));
    const records = autoPurchase.getStatus().recent.filter((record) => productUrls.has(record.product?.url));
    return {
      message: `Funbox 真實購買驗收完成：排入 ${queued.accepted} 件。`,
      detectedAt,
      products: products.map(({ id, title, url, stock, variantId }) => ({ id, title, url, stock, variantId })),
      queued,
      records
    };
  },
  onManualFunboxAssignments: async (body) => {
    const verifyOnly = body.verifyOnly === true;
    if (body.confirmSensitiveData !== true) {
      throw new Error('將姓名、電話與地址傳給 Funbox 前必須明確傳入 confirmSensitiveData=true');
    }
    if (!verifyOnly && body.confirmRealOrder !== true) {
      throw new Error('這個操作會成立真實訂單；必須明確傳入 confirmRealOrder=true');
    }
    const rawAssignments = Array.isArray(body.assignments) ? body.assignments : [];
    if (!rawAssignments.length || rawAssignments.length > 3) {
      throw new Error('一次必須指定 1～3 組 Funbox 帳號與商品');
    }
    const slots = rawAssignments.map((item) => String(item.slot || '').toUpperCase());
    if (new Set(slots).size !== slots.length || slots.some((slot) => !['A', 'B', 'C'].includes(slot))) {
      throw new Error('帳號欄位必須是不同的 A、B、C');
    }
    const detectedAt = body.detectedAt || new Date().toISOString();
    const assignments = await Promise.all(rawAssignments.map(async (item) => {
      const product = await inspectOfficialFunboxProduct(item.url);
      product.detectedAt = detectedAt;
      return {
        slot: String(item.slot).toUpperCase(),
        product,
        cartUrl: String(item.cartUrl || item.resumeCartUrl || '').trim()
      };
    }));
    const evidenceDir = path.join(
      rootDir,
      'artifacts',
      `funbox-atm-${verifyOnly ? 'preflight' : 'orders'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    );
    log(`Funbox 虛擬 ATM ${verifyOnly ? '送單前驗證' : '真實訂單'}：${assignments.map((item) => `帳號 ${item.slot}／${item.product.title}`).join('｜')}`, 'funbox');
    const result = await autoPurchase.runFunboxAssignments(assignments, { verifyOnly, evidenceDir });
    return {
      message: verifyOnly
        ? `Funbox 三帳號送單前驗證完成：${result.accountResults.filter((item) => item.ok).length}/${result.accountResults.length} 組就緒。`
        : `Funbox 三帳號真實訂單流程完成：${result.accountResults.filter((item) => item.ok).length}/${result.accountResults.length} 組收到完成結果。`,
      detectedAt,
      evidenceDir,
      ...result
    };
  },
  onManualEslitePreflight: async (body) => {
    if (body.confirmSensitiveData !== true) {
      throw new Error('將姓名、電話與門市資料傳給誠品前必須明確傳入 confirmSensitiveData=true');
    }
    const url = new URL(String(body.url || '').trim());
    if (!/(?:^|\.)eslite\.com$/i.test(url.hostname)) throw new Error('誠品送單前驗證只接受 eslite.com 商品網址');
    let product;
    try {
      product = await shoppingSiteMonitor.inspectProduct(url.href, { includeStock: true });
    } catch (error) {
      log(`誠品驗收商品公開直查未完成，改由已登入的購買視窗現場確認：${error.message}`, 'shopping');
    }
    const productId = url.pathname.match(/\/product\/(\d+)/i)?.[1];
    if (!productId) throw new Error('找不到誠品商品編號');
    product ||= {
      id: productId,
      title: String(body.title || `誠品手動驗收商品 ${productId}`).trim(),
      url: `https://www.eslite.com/product/${productId}`,
      price: '',
      stock: 1,
      available: null
    };
    if (product.available === false || Number(product.stock) === 0) throw new Error('誠品測試商品目前不可購買');
    product.detectedAt = body.detectedAt || new Date().toISOString();
    const evidencePath = path.join(
      rootDir,
      'artifacts',
      `eslite-preflight-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    );
    log(`誠品 API 安全驗證：${product.title}｜確認會員 API 與本地結帳範本；不加車、不送單。`, 'shopping');
    const result = await autoPurchase.runPlatformPreflight('eslite', product, {
      evidencePath,
      accountSlot: body.accountSlot,
      payment: body.payment
    });
    return {
      message: result.ok ? (result.result?.status === 'api_verified'
        ? '誠品會員 API 與本地結帳範本已確認；沒有加車、送單或開啟結帳頁，不代表商品仍有庫存。'
        : '誠品送單前驗證完成，已到最終確認結帳按鈕且未送出訂單。') : '誠品送單前驗證未完成。',
      product: {
        id: product.id, title: product.title, url: product.url,
        price: product.price, stock: product.stock, available: product.available
      },
      evidencePath: result.result?.evidencePath || '',
      ...result
    };
  },
  onSelfCheck: performSelfCheck,
  onTestNotification: async (requestedChannel = 'discord-public') => {
    const channelMode = requestedChannel === 'line' ? 'line' : 'discord';
    const discordAudience = requestedChannel === 'discord-private' ? 'private' : 'public';
    const channel = channelMode === 'line'
      ? 'LINE'
      : discordAudience === 'private' ? 'Discord 私人管理頻道' : 'Discord 公開情報頻道';
    const messageId = await sendNotification(
      `✅ ${channel} 測試通知｜系統已成功送出\n通知來源：陀螺通知監控儀表\n時間：${new Date().toLocaleString('zh-TW')}`,
      { channelMode, discordAudience }
    );
    const destination = channelMode === 'line'
      ? await checkLineConnection()
      : await checkDiscordConnection(discordAudience);
    const messageUrl = channelMode === 'discord' && destination.guildId && destination.channelId && messageId
      ? `https://discord.com/channels/${destination.guildId}/${destination.channelId}/${messageId}`
      : '';
    log(`${channel} 測試通知已由平台接受${messageId ? `｜回覆 ID：${messageId}` : ''}`);
    return {
      channel,
      message: `${channel} 平台已接受測試通知`,
      messageId: messageId || '',
      messageUrl,
      destination
    };
  },
  onTestPostNotification: () => {
    const samplePage = activeFacebookPages()[0] || { name: '測試店家', url: 'https://www.facebook.com/' };
    const samplePost = {
      pageName: samplePage.name,
      pageUrl: samplePage.url,
      postUrl: samplePage.url,
      matchedKeywords: ['戰鬥陀螺', '抽選', '報名'],
      formUrls: ['https://example.com/beyblade-test-form'],
      text: '【模擬貼文】戰鬥陀螺限量抽選販售，請於表單開放期間完成報名。'
    };
    const sample = formatPostNotification(samplePost);
    return sendNotification(
      `🧪 模擬通知（不是真實販售，請勿填表）\n\n${sample}`,
      {
        discordPreview: facebookDiscordPreview(samplePost, { test: true }),
        embeds: [facebookPostEmbed(samplePost, { test: true })],
        channelMode: config.notifications.facebook
      }
    );
  },
  onTestLatestSogoPost: async () => {
    if (watcher.running) throw new Error('目前正在掃描，請等掃描結束後再測試最新貼文');
    const target = activeFacebookPages().find((page) => page.url.includes('61558958859748'));
    if (!target) throw new Error('監控清單中找不到中壢 SOGO 店');
    const { posts } = await scanner.scanPage(target);
    if (!posts.length) throw new Error('中壢 SOGO 店目前沒有可讀取的主貼文');
    const now = new Date();
    const latest = [...posts].sort((left, right) =>
      approximatePublishedTime(right.publishedLabel, now) - approximatePublishedTime(left.publishedLabel, now)
    )[0];
    const message = formatPostNotification({
      ...latest,
      matchedKeywords: latest.matchedKeywords.length ? latest.matchedKeywords : ['未命中'],
      detectedAt: now
    });
    await sendNotification(
      `🧪 最新貼文推播測試（中壢SOGO）\n\n${message}`,
      { channelMode: config.notifications.facebook }
    );
    if (!config.monitoringEnabled) await scanner.close();
    return { message: `已推播中壢 SOGO 最新貼文（Facebook 顯示時間：${latest.publishedLabel || '無法辨識'}）。` };
  },
  onPauseSystem: async () => {
    if (config.systemPause.active) return { message: '全部功能原本就已停止；控制頁仍保持可用。' };
    config.systemPause = {
      active: true,
      pausedAt: new Date().toISOString(),
      resumeState: captureSystemResumeState()
    };
    disableAllRuntimeFeatures();
    clearSchedule();
    clearHotspotSchedule();
    clearFormPrewarmSchedule();
    clearFunboxSchedule();
    clearFunboxBoost();
    clearFunboxSandboxSchedule();
    clearShoppingSchedule();
    clearShoppingBoost();
    clearJapanSchedule();
    clearAmazonJpSchedule();
    clearSaleReminderSchedule();
    clearDutyNotificationSchedule();
    clearDiscordAutomationSchedule();
    await saveConfig();
    for (const monitor of amazonJpProductOrders) monitor.stop();
    await Promise.allSettled([
      scanner.close(),
      closeAllFormAutoFillWorkers(),
      funboxMonitor.close(),
      funboxSandboxMonitor.close(),
      shoppingSiteMonitor.close(),
      japanAuctionMonitor.close(),
      amazonJapanMonitor.close(),
      ...amazonJpProductOrders.map((monitor) => monitor.closeBrowser()),
      autoPurchase.suspend()
    ]);
    log('遊戲模式已啟用：全部掃描、登入心跳、自動下單與背景瀏覽器均已停止。');
    return { message: '已停止全部功能並關閉背景瀏覽器；控制頁仍保持可用，可隨時恢復原本設定。' };
  },
  onResumeSystem: async () => {
    if (!config.systemPause.active) return { message: '系統目前沒有處於全部停止狀態。' };
    const resumeState = config.systemPause.resumeState || {};
    applySystemResumeState(resumeState);
    config.systemPause = { active: false, pausedAt: null, resumeState: null };
    await saveConfig();
    await autoPurchase.resume();
    autoPurchaseWindowSignature = '';
    await syncAutoPurchaseWindowState({ force: true });
    if (config.monitoringEnabled) {
      scheduleNext({ immediate: true });
      scheduleHotspot({ immediate: true });
      scheduleFormPrewarm();
    }
    if (config.funbox.enabled) scheduleFunbox({ immediate: true });
    if (config.funboxSandbox.enabled) scheduleFunboxSandbox({ immediate: true });
    if (config.shoppingSites.enabled) scheduleShopping({ immediate: true });
    if (config.japanAuctions.enabled) scheduleJapan({ immediate: true });
    if (config.amazonJp.enabled) scheduleAmazonJp({ immediate: true });
    for (const monitor of amazonJpProductOrders) {
      if (config.amazonJpProductOrders[monitor.slot].enabled) await monitor.start();
    }
    scheduleSaleReminders({ immediate: true });
    scheduleDutyNotificationChecks();
    scheduleDiscordAutomation();
    log('遊戲模式已解除：已依停止前的設定恢復各項功能。');
    return { message: '已依停止前的設定恢復監控、登入心跳與自動下單。' };
  },
  onStart: async () => {
    if (config.monitoringEnabled) return { message: '監控原本就已經啟動。' };
    config.monitoringEnabled = true;
    await saveConfig();
    log('FB 主監控已由控制頁啟動；熱點加速會依設定時段自動切換。');
    scheduleNext({ immediate: true });
    scheduleHotspot({ immediate: true });
    scheduleFormPrewarm();
    void checkDutyNotifications();
    return { message: 'FB 主監控已啟動；常態模式開始運作，熱點加速會依設定時段自動切換。' };
  },
  onStop: async () => {
    config.monitoringEnabled = false;
    clearSchedule();
    clearHotspotSchedule();
    clearFormPrewarmSchedule();
    await saveConfig();
    void checkDutyNotifications();
    if (watcher.running) {
      log('已要求停止 FB 主監控；常態與熱點加速會在本輪完成後一起停止。');
      return { message: '停止要求已接受；常態與熱點加速會在本輪完成後一起停止。' };
    }
    await Promise.all([scanner.close(), closeAllFormAutoFillWorkers()]);
    log('FB 主監控已停止；常態與熱點加速均已關閉，背景 Facebook 瀏覽器已關閉。');
    return { message: 'FB 主監控已停止，熱點加速已同步關閉。控制頁會繼續保持可用。' };
  },
  onStartFunbox: async () => {
    if (config.funbox.enabled) {
      await autoPurchase.applyRuntimeConfig();
      return { message: '官網監控原本就已經啟動。' };
    }
    config.funbox.enabled = true;
    await saveConfig();
    await autoPurchase.applyRuntimeConfig();
    log('Funbox 官網監控已啟動。', 'funbox');
    scheduleFunbox({ immediate: true });
    void checkDutyNotifications();
    return { message: '官網監控已啟動，正在立即檢查一次。' };
  },
  onStopFunbox: async () => {
    config.funbox.enabled = false;
    clearFunboxSchedule();
    clearFunboxBoost();
    await saveConfig();
    await autoPurchase.applyRuntimeConfig();
    void checkDutyNotifications();
    log('Funbox 官網監控已停止。', 'funbox');
    return { message: '官網監控已停止。FB 監控不受影響。' };
  },
  onStartShopping: async () => {
    if (config.shoppingSites.enabled) {
      await autoPurchase.applyRuntimeConfig();
      return { message: '購物網站監控原本就已經啟動。' };
    }
    config.shoppingSites.enabled = true;
    await saveConfig();
    await autoPurchase.applyRuntimeConfig();
    log('購物網站監控已啟動。', 'shopping');
    scheduleShopping({ immediate: true });
    void checkDutyNotifications();
    return { message: '購物網站監控已啟動，正在逐一建立或更新專區基線。' };
  },
  onStopShopping: async () => {
    config.shoppingSites.enabled = false;
    clearShoppingSchedule();
    clearShoppingBoost();
    await saveConfig();
    await autoPurchase.applyRuntimeConfig();
    await shoppingSiteMonitor.close();
    void checkDutyNotifications();
    log('購物網站監控已停止。', 'shopping');
    return { message: '購物網站監控已停止；FB 與 Funbox 官網不受影響。' };
  },
  onStartJapan: async () => {
    if (config.japanAuctions.enabled) return { message: '日本拍賣監控原本就已經啟動。' };
    config.japanAuctions.enabled = true;
    await saveConfig();
    log('日本拍賣監控已啟動。', 'japan');
    scheduleJapan({ immediate: true });
    return { message: '日本拍賣監控已啟動，各日本網站會彼此獨立掃描。' };
  },
  onStopJapan: async () => {
    config.japanAuctions.enabled = false;
    clearJapanSchedule();
    await saveConfig();
    await japanAuctionMonitor.close();
    log('日本拍賣監控已停止。', 'japan');
    return { message: '日本拍賣監控已停止；其他監控不受影響。' };
  },
  onSaveJapanSettings: async (body) => {
    config.japanAuctions.activeHours = {
      start: parseTimeValue(body.activeStart ?? config.japanAuctions.activeHours.start, '日本拍賣開始時間'),
      end: parseTimeValue(body.activeEnd ?? config.japanAuctions.activeHours.end, '日本拍賣結束時間')
    };
    config.japanAuctions.intervalSeconds = Math.min(3600, Math.max(20, Number(body.intervalSeconds) || 30));
    const excludeKeywords = [...new Set(
      String(body.excludeKeywords ?? '')
        .split(/[\n,，、;；]+/)
        .map((keyword) => keyword.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
    )];
    if (excludeKeywords.length > 50) throw new Error('日本購物黑名單關鍵字最多 50 組');
    if (excludeKeywords.some((keyword) => keyword.length > 40)) throw new Error('每組黑名單關鍵字最多 40 字');
    config.japanAuctions.excludeKeywords = excludeKeywords;
    await saveConfig();
    if (config.japanAuctions.enabled) scheduleJapan({ immediate: true });
    if (config.amazonJp.enabled) scheduleAmazonJp({ immediate: true });
    log(`日本拍賣設定已更新：${config.japanAuctions.activeHours.start}～${config.japanAuctions.activeHours.end}，平時每 ${config.japanAuctions.intervalSeconds} 秒；黑名單 ${excludeKeywords.length} 組。`, 'japan');
    return { message: `日本拍賣掃描時段、速度與 ${excludeKeywords.length} 組黑名單已儲存。` };
  },
  onSaveAmazonJpSettings: async (body) => {
    config.amazonJp.enabled = Boolean(body.enabled);
    config.amazonJp.adaptiveIntervalEnabled = true;
    config.amazonJp.intervalSeconds = 20;
    const postalCode = String(body.postalCode || config.amazonJp.postalCode).trim();
    if (!/^\d{3}-?\d{4}$/.test(postalCode)) throw new Error('日本郵遞區號格式必須是 123-4567');
    config.amazonJp.postalCode = postalCode.replace(/^(\d{3})(\d{4})$/, '$1-$2');
    await saveConfig();
    if (config.amazonJp.enabled) {
      runtime.amazonJpAdaptiveIntervalSeconds = 20;
      runtime.amazonJpCadenceMode = 'normal';
      scheduleAmazonJp({ immediate: true });
    }
    else {
      clearAmazonJpSchedule();
      runtime.amazonJpFailureCount = 0;
      runtime.amazonJpBackoffUntil = null;
      await amazonJapanMonitor.close();
    }
    log(`日亞官方原價監控已${config.amazonJp.enabled ? '啟用' : '暫停'}：線性浮動 15～20 秒，阻擋時 40～60 秒｜日本郵遞區號 ${config.amazonJp.postalCode}。`, 'japan');
    return { message: config.amazonJp.enabled ? '日亞官方原價監控已儲存並立即檢查。' : '日亞官方原價監控已暫停；其他監控不受影響。' };
  },
  onAddAmazonJpProduct: async (body) => {
    const product = await amazonJapanMonitor.addManualProduct(body.url);
    if (config.amazonJp.enabled) scheduleAmazonJp({ immediate: true });
    log(`已加入日亞單品資料庫：ASIN ${product.asin}`, 'japan');
    return {
      message: `已將 ASIN ${product.asin} 永久加入日亞單品資料庫與直接監控輪替。`,
      product
    };
  },
  onDeleteAmazonJpProduct: async (body) => {
    const asin = String(body.asin || '').trim().toUpperCase();
    const product = await amazonJapanMonitor.deleteManualProduct(asin);
    config.amazonJp.watchProducts = config.amazonJp.watchProducts.filter(
      (item) => String(item.asin || '').trim().toUpperCase() !== asin
    );
    config.amazonJp.xSignalUrls = config.amazonJp.xSignalUrls.filter(
      (url) => !String(url).toUpperCase().includes(asin)
    );
    await saveConfig();
    if (config.amazonJp.enabled) scheduleAmazonJp({ immediate: true });
    log(`已刪除日亞單品資料庫項目：ASIN ${asin}`, 'japan');
    return { message: `已從日亞單品資料庫與專屬直接監控移除 ASIN ${asin}。`, product };
  },
  onSetJapanTargetEnabled: async (body) => {
    const target = config.japanAuctions.targets.find((item) => item.id === String(body.id || ''));
    if (!target) throw new Error('找不到日本拍賣網站');
    target.enabled = Boolean(body.enabled);
    await saveConfig();
    if (target.enabled && config.japanAuctions.enabled) scheduleJapan({ immediate: true, targetId: target.id });
    else clearJapanSchedule(target.id);
    log(`${target.enabled ? '已恢復' : '已暫停'}：${target.name}`, 'japan');
    return { message: target.enabled ? `已恢復「${target.name}」。` : `已暫停「${target.name}」。` };
  },
  onDeleteJapanTarget: async (body) => {
    const index = config.japanAuctions.targets.findIndex((item) => item.id === String(body.id || ''));
    if (index < 0) throw new Error('找不到要刪除的日本網站');
    const [target] = config.japanAuctions.targets.splice(index, 1);
    clearJapanSchedule(target.id);
    japanTargetRuntime.delete(String(target.id));
    if (state.data.commerce?.japanAuctions?.targets) delete state.data.commerce.japanAuctions.targets[target.id];
    await Promise.all([saveConfig(), state.save()]);
    log(`已刪除日本網站：${target.siteName}｜${target.name}`, 'japan');
    return { message: `已刪除「${target.name}」。` };
  },
  onSaveShoppingSettings: async (body) => {
    config.shoppingSites.activeHours = {
      start: parseTimeValue(body.activeStart ?? config.shoppingSites.activeHours.start, '購物網站開始時間'),
      end: parseTimeValue(body.activeEnd ?? config.shoppingSites.activeHours.end, '購物網站結束時間')
    };
    config.shoppingSites.intervalSeconds = Math.min(3600, Math.max(10, Number(body.intervalSeconds) || 60));
    config.shoppingSites.stockChangeNotificationsEnabled = Boolean(body.stockChangeNotificationsEnabled);
    const excludeKeywords = [...new Set(
      String(body.excludeKeywords ?? '')
        .split(/[\n,，、;；]+/)
        .map((keyword) => keyword.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
    )];
    if (excludeKeywords.length > 50) throw new Error('購物網站黑名單關鍵字最多 50 組');
    if (excludeKeywords.some((keyword) => keyword.length > 40)) throw new Error('每組黑名單關鍵字最多 40 字');
    config.shoppingSites.excludeKeywords = excludeKeywords;
    await saveConfig();
    if (config.shoppingSites.enabled) scheduleShopping({ immediate: true });
    void checkDutyNotifications();
    log(`購物網站共用設定已更新：每天 ${config.shoppingSites.activeHours.start}～${config.shoppingSites.activeHours.end}；每 ${config.shoppingSites.intervalSeconds} 秒，庫存提醒${config.shoppingSites.stockChangeNotificationsEnabled ? '開啟' : '關閉'}；黑名單關鍵字 ${config.shoppingSites.excludeKeywords.length} 組。`, 'shopping');
    return { message: `已儲存共用時段與 ${config.shoppingSites.excludeKeywords.length} 組黑名單關鍵字。` };
  },
  onSaveEsliteKeywords: async (body) => {
    const keywords = [...new Set(
      String(body.keywords || '')
        .split(/[\n,，、;；]+/)
        .map((keyword) => keyword.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
    )];
    if (!keywords.length) throw new Error('請至少保留一組誠品搜尋關鍵字');
    if (keywords.length > 6) throw new Error('誠品搜尋關鍵字最多 6 組');
    if (keywords.some((keyword) => keyword.length > 30)) throw new Error('每組關鍵字最多 30 字');
    const target = config.shoppingSites.targets.find((item) => item.sourceType === 'eslite-keywords');
    if (!target) throw new Error('找不到誠品關鍵字監控來源');
    target.keywords = keywords;
    target.url = `https://www.eslite.com/Search?keyword=${encodeURIComponent(keywords[0])}&final_price=0,&publishDate=0&sort=_weight_+desc&size=20&display=list&start=0&exp=c`;
    target.baselineVersion = `eslite-keywords-v1-${Date.now()}`;
    await saveConfig();
    if (config.shoppingSites.enabled) scheduleShopping({ immediate: true, targetId: target.id });
    log(`誠品搜尋範圍已更新：${keywords.join('、')}。下一輪先重建安全基線，不推送既有商品。`, 'shopping');
    return { message: `已儲存 ${keywords.length} 組關鍵字；下一輪會先建立新基線，避免把既有商品誤報成新品。` };
  },
  onAddEsliteProduct: async (body) => {
    const product = await shoppingSiteMonitor.addEsliteManualProduct(body.url);
    const target = config.shoppingSites.targets.find((item) => item.sourceType === 'eslite-keywords');
    if (target?.enabled !== false && config.shoppingSites.enabled) {
      scheduleShopping({ immediate: true, targetId: target.id });
    }
    log(`已加入誠品單品資料庫：${product.id}｜${product.url}`, 'shopping');
    return {
      message: `已將誠品商品 ${product.id} 永久加入單品資料庫與直接監控。`,
      product
    };
  },
  onDeleteEsliteProduct: async (body) => {
    const product = await shoppingSiteMonitor.deleteEsliteManualProduct(body.id || body.url);
    log(`已刪除誠品單品資料庫項目：${product.id}`, 'shopping');
    return { message: `已從誠品單品資料庫與直接監控移除商品 ${product.id}。`, product };
  },
  onAddShoppingTarget: async (body) => {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('請輸入監控專區名稱');
    if (name.length > 80) throw new Error('監控專區名稱最多 80 字');
    let url;
    try {
      url = new URL(String(body.url || '').trim());
    } catch {
      throw new Error('請貼上完整的購物專區網址');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('購物專區網址必須使用 http 或 https');
    if (config.shoppingSites.targets.some((target) => target.url === url.href)) throw new Error('這個購物專區已經在名單內');
    const target = {
      id: `shopping-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name,
      siteName: shoppingSiteName(url.href),
      url: url.href,
      enabled: true
    };
    if (/mmtoyshop\.com\/category\//i.test(url.href)) {
      target.siteName = 'MM小舖';
      target.sourceType = 'mmtoy-category';
      target.baselineVersion = 'mmtoy-category-v1';
    }
    if (/sen-sen\.com\.tw\/collections\//i.test(url.href)) {
      target.siteName = '森森文具';
      target.sourceType = 'sensen-cyberbiz-collection';
      target.baselineVersion = 'sensen-beyblade-v2';
      url.search = '';
      target.url = url.href;
    }
    if (/(?:^|\.)twj\.tw$/i.test(url.hostname) && /\/collections\//i.test(url.pathname)) {
      target.siteName = '童無忌';
      target.sourceType = 'twj-cyberbiz-collection';
      target.baselineVersion = 'twj-beyblade-v1';
      url.search = '';
      url.hash = '';
      target.url = url.href;
    }
    if (isTcsbSearchTarget(target)) {
      target.sourceType = 'tcsb-products-api';
      target.baselineVersion = TCSB_BASELINE_VERSION;
    }
    config.shoppingSites.targets.push(target);
    await saveConfig();
    await autoPurchase.applyRuntimeConfig();
    if (config.shoppingSites.enabled) scheduleShopping({ immediate: true, targetId: target.id });
    log(`已新增購物專區：${target.siteName}｜${target.name}`, 'shopping');
    return { message: `已加入「${target.siteName}｜${target.name}」；第一次掃描只建立基線。` };
  },
  onSetShoppingTargetEnabled: async (body) => {
    const target = config.shoppingSites.targets.find((item) => item.id === String(body.id || ''));
    if (!target) throw new Error('找不到要調整的購物專區');
    target.enabled = Boolean(body.enabled);
    await saveConfig();
    await autoPurchase.applyRuntimeConfig();
    if (config.shoppingSites.enabled) {
      if (target.enabled) scheduleShopping({ immediate: true, targetId: target.id });
      else clearShoppingSchedule(target.id);
      refreshShoppingRuntimeSummary();
    }
    log(`${target.enabled ? '已恢復' : '已暫停'}購物專區：${target.siteName}｜${target.name}`, 'shopping');
    return { message: target.enabled ? `已恢復「${target.name}」監控。` : `已暫停「${target.name}」，網址仍會保留。` };
  },
  onSetShoppingTargetSchedule: async (body) => {
    const target = config.shoppingSites.targets.find((item) => item.id === String(body.id || ''));
    if (!target) throw new Error('找不到要設定時段的購物專區');
    const mode = body.mode === 'custom' ? 'custom' : 'default';
    target.scheduleMode = mode;
    target.activeHours = mode === 'custom'
      ? {
          start: parseTimeValue(body.start, '自訂開始時間'),
          end: parseTimeValue(body.end, '自訂結束時間')
        }
      : undefined;
    await saveConfig();
    if (config.shoppingSites.enabled && target.enabled !== false) {
      scheduleShopping({ immediate: true, targetId: target.id });
    }
    const hours = activeHoursForShoppingTarget(target);
    const label = mode === 'custom'
      ? (hours.start === hours.end ? '24 小時' : `${hours.start}～${hours.end}`)
      : `共用時段 ${hours.start}～${hours.end}`;
    log(`已更新購物專區時段：${target.name}｜${label}`, 'shopping');
    return { message: `「${target.name}」已套用${label}。` };
  },
  onRenameShoppingTarget: async (body) => {
    const target = config.shoppingSites.targets.find((item) => item.id === String(body.id || ''));
    if (!target) throw new Error('找不到要改名的購物專區');
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('暱稱不能留空');
    if (name.length > 80) throw new Error('暱稱最多 80 字');
    target.name = name;
    target.nameMode = 'manual';
    await saveConfig();
    log(`已更新購物專區暱稱：${target.siteName}｜${target.name}`, 'shopping');
    return { message: `已儲存暱稱「${target.name}」；後續 Discord／LINE 通知會使用這個名稱。` };
  },
  onDeleteShoppingTarget: async (body) => {
    const index = config.shoppingSites.targets.findIndex((item) => item.id === String(body.id || ''));
    if (index < 0) throw new Error('找不到要刪除的購物專區');
    const [target] = config.shoppingSites.targets.splice(index, 1);
    clearShoppingSchedule(target.id);
    shoppingTargetRuntime.delete(String(target.id));
    if (state.data.commerce?.shoppingSites?.targets) delete state.data.commerce.shoppingSites.targets[target.id];
    await Promise.all([saveConfig(), state.save()]);
    await autoPurchase.applyRuntimeConfig();
    log(`已刪除購物專區：${target.siteName}｜${target.name}`, 'shopping');
    return { message: `已刪除「${target.name}」。` };
  },
  onInspectSaleReminder: async (body) => {
    const inspected = await inspectSaleReminderUrl(body.url);
    const saleStart = inspected.saleStartAt ? new Date(inspected.saleStartAt) : null;
    return {
      ...inspected,
      saleStartAt: saleStart && saleStart.getTime() > Date.now() ? saleStart.toISOString() : null,
      message: inspected.saleStartAt
        ? `已辨識「${inspected.name}」，商品名稱與開賣時間已帶入。`
        : `已辨識「${inspected.name}」，但網頁尚未提供未來開賣時間，請手動設定。`
    };
  },
  onAddSaleReminder: async (body) => {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('請輸入商品或提醒名稱');
    if (name.length > 80) throw new Error('提醒名稱最多 80 字');
    let url;
    try {
      url = new URL(canonicalSaleReminderUrl(body.url));
    } catch {
      throw new Error('請貼上完整的商品頁網址');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('商品頁網址必須使用 http 或 https');
    const saleStart = new Date(String(body.saleStartAt || ''));
    if (!Number.isFinite(saleStart.getTime())) throw new Error('請選擇正確的開賣日期與時間');
    if (saleStart.getTime() <= Date.now()) throw new Error('開賣時間必須晚於現在');
    if (config.shoppingSites.saleReminders.some((reminder) =>
      reminder.url === url.href && reminder.saleStartAt === saleStart.toISOString()
    )) throw new Error('相同商品與開賣時間已經設定提醒');
    const reminder = {
      id: `sale-reminder-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name,
      siteName: shoppingSiteName(url.href),
      url: url.href,
      saleStartAt: saleStart.toISOString(),
      enabled: true,
      imageUrl: String(body.imageUrl || '').trim().slice(0, 2000),
      price: String(body.price || '').trim().slice(0, 50),
      stock: body.stock !== null && body.stock !== undefined && body.stock !== ''
        && Number.isFinite(Number(body.stock)) ? Number(body.stock) : null,
      available: body.stock !== null && body.stock !== undefined && body.stock !== ''
        && Number.isFinite(Number(body.stock)) ? Number(body.stock) > 0 : null,
      productCheckedAt: body.stock !== null && body.stock !== undefined && body.stock !== ''
        && Number.isFinite(Number(body.stock)) ? new Date().toISOString() : null,
      productError: ''
    };
    config.shoppingSites.saleReminders.push(reminder);
    config.shoppingSites.saleReminders.sort(
      (left, right) => Date.parse(left.saleStartAt) - Date.parse(right.saleStartAt)
    );
    await saveConfig();
    scheduleSaleReminders({ immediate: true });
    await syncDiscordAutomation();
    log(`已新增開賣倒數提醒：${reminder.siteName}｜${reminder.name}｜${saleStart.toLocaleString('zh-TW')}`, 'shopping');
    try {
      const announcement = saleReminderListedNotification(reminder);
      await sendNotification(announcement.text, {
        ...announcement.options,
        channelMode: 'discord'
      });
      log(`已送出首次商品提醒：${reminder.siteName}｜${reminder.name}`, 'shopping');
      return { message: `已新增「${reminder.name}」並送出 Discord 商品通知；開賣前 60、30、10 分鐘會再次提醒。` };
    } catch (error) {
      log(`首次商品提醒傳送失敗：${reminder.name}：${error.message}`, 'shopping');
      return { message: `提醒已新增，但 Discord 首次通知失敗：${error.message}` };
    }
  },
  onSetSaleReminderEnabled: async (body) => {
    const reminder = config.shoppingSites.saleReminders.find((item) => item.id === String(body.id || ''));
    if (!reminder) throw new Error('找不到要調整的開賣提醒');
    reminder.enabled = Boolean(body.enabled);
    await saveConfig();
    scheduleSaleReminders({ immediate: reminder.enabled });
    await syncDiscordAutomation();
    log(`${reminder.enabled ? '已恢復' : '已暫停'}開賣提醒：${reminder.siteName}｜${reminder.name}`, 'shopping');
    return { message: reminder.enabled ? `已恢復「${reminder.name}」倒數提醒。` : `已暫停「${reminder.name}」倒數提醒。` };
  },
  onRefreshSaleReminder: async (body) => {
    const reminder = config.shoppingSites.saleReminders.find((item) => item.id === String(body.id || ''));
    if (!reminder) throw new Error('找不到要更新的開賣提醒');
    const inspected = await inspectSaleReminderUrl(reminder.url);
    if (inspected.name) reminder.name = inspected.name;
    if (inspected.siteName) reminder.siteName = inspected.siteName;
    reminder.imageUrl = String(inspected.imageUrl || '').trim().slice(0, 2000);
    reminder.price = String(inspected.price || '').trim().slice(0, 50);
    reminder.stock = inspected.stock !== null && inspected.stock !== undefined && inspected.stock !== ''
      && Number.isFinite(Number(inspected.stock)) ? Number(inspected.stock) : null;
    reminder.available = inspected.available ?? (reminder.stock !== null ? reminder.stock > 0 : null);
    reminder.productCheckedAt = new Date().toISOString();
    reminder.productError = '';
    await saveConfig();
    await syncDiscordAutomation();
    log(`已重新抓取開賣商品資料：${reminder.siteName}｜${reminder.name}｜${reminder.price || '價格待公布'}｜可能庫存 ${reminder.stock ?? '待確認'}`, 'shopping');
    return { message: `已更新「${reminder.name}」的圖片、價格與可能庫存，並同步 Discord momo 待售清單。`, reminder };
  },
  onDeleteSaleReminder: async (body) => {
    const index = config.shoppingSites.saleReminders.findIndex((item) => item.id === String(body.id || ''));
    if (index < 0) throw new Error('找不到要刪除的開賣提醒');
    const [reminder] = config.shoppingSites.saleReminders.splice(index, 1);
    if (state.data.commerce?.saleReminders) delete state.data.commerce.saleReminders[reminder.id];
    await Promise.all([saveConfig(), state.save()]);
    scheduleSaleReminders({ immediate: true });
    await syncDiscordAutomation();
    log(`已刪除開賣提醒：${reminder.siteName}｜${reminder.name}`, 'shopping');
    return { message: `已刪除「${reminder.name}」倒數提醒。` };
  },
  onStartFunboxSandbox: async () => {
    if (config.funboxSandbox.enabled) return { message: '沙盒監控原本就已經啟動。' };
    config.funboxSandbox.enabled = true;
    await saveConfig();
    log('Funbox 沙盒監控已啟動。', 'funbox');
    scheduleFunboxSandbox({ immediate: true });
    return { message: '沙盒監控已啟動，正在建立或更新測試商品基線。' };
  },
  onStopFunboxSandbox: async () => {
    config.funboxSandbox.enabled = false;
    clearFunboxSandboxSchedule();
    await saveConfig();
    log('Funbox 沙盒監控已停止。', 'funbox');
    return { message: '沙盒監控已停止；正式官網與 FB 監控不受影響。' };
  },
  onResetFunboxSandboxMonitor: async () => {
    state.data.commerce ||= {};
    delete state.data.commerce.funboxSandbox;
    runtime.lastFunboxSandboxScan = null;
    await state.save();
    log('Funbox 沙盒監控基線已清除。', 'funbox');
    if (config.funboxSandbox.enabled) scheduleFunboxSandbox({ immediate: true });
    return { message: '沙盒監控基線已清除；下次掃描會重新建立基線。' };
  },
  onOpenFacebookLogin: async () => {
    if (watcher.running) throw new Error('目前正在掃描，請等掃描結束後再開啟登入視窗');
    return scanner.openLoginWindow();
  },
  onOpenGoogleLogin: () => formAutoFill.openGoogleLogin(),
  onOpenAdditionalGoogleLogin: (body) => formAutoFill.openAdditionalGoogleLogin(body.slot),
  onPrewarmForm: async () => {
    await Promise.all(selectedFormAutoFillWorkers().map(({ worker }) => worker.prewarm()));
    return { message: `第 ${configuredParticipantSlots().join('、')} 組背景填表瀏覽器已預熱。` };
  },
  onTestAutoFill: async () => {
    const result = await formAutoFill.prepareForm(`http://127.0.0.1:${config.dashboardPort}/autofill-test-form`);
    return { message: `動態測試已預填 ${result.filled.length} 欄、待確認 ${result.uncertain.length} 題；總填寫 ${result.durationMs} ms，AI ${result.ai?.used ? `已使用（${result.ai.latencyMs} ms）` : '未使用'}，測試頁不會送出並會保持背景預熱。` };
  },
  onTestMultiAutoFill: async (body) => {
    const rawUrl = String(body.url || '').trim();
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      throw new Error('請提供有效的測試表單網址');
    }
    const allowed = target.protocol === 'https:' && (
      target.hostname === 'reurl.cc'
      || target.hostname === 'forms.gle'
      || (target.hostname === 'docs.google.com' && target.pathname.startsWith('/forms/'))
    );
    if (!allowed) throw new Error('三組測試只允許 reurl.cc 或 Google Forms 網址');
    const startedAt = Date.now();
    const attempts = await Promise.all([...formAutoFillWorkers.entries()].map(async ([slot, worker]) => {
      try {
        const result = await worker.prepareForm(target.href, {
          autoSubmit: false,
          contextId: `three-profile-dry-run-${Date.now()}-${slot}`,
          formPolicy: 'taimall_test'
        });
        return {
          slot,
          status: result.status,
          submitted: result.submitted,
          filledCount: result.filled?.length || 0,
          uncertainCount: result.uncertain?.length || 0,
          durationMs: result.durationMs,
          fixedFormatErrors: result.fixedFormatErrors || [],
          dangerousSelections: result.dangerousSelections || [],
          validationErrors: result.validationErrors || [],
          aiUsed: Boolean(result.aiReview?.used),
          aiApproved: Boolean(result.aiReview?.approved),
          aiIssues: result.aiReview?.issues || []
        };
      } catch (error) {
        return { slot, status: 'error', error: error.message };
      }
    }));
    runtime.lastMultiFillDryRun = {
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      results: attempts
    };
    const passed = attempts.every((item) => item.status === 'open'
      && item.filledCount === 10
      && item.uncertainCount === 0
      && item.fixedFormatErrors.length === 0
      && item.dangerousSelections.length === 0
      && item.aiUsed
      && item.aiApproved);
    log(`三組正式表單送出前驗證：${passed ? '三組全部通過' : '有未通過項目'}｜${Date.now() - startedAt} ms。`, 'hotspot');
    return {
      message: passed ? '三組不送出預演全部通過。' : '三組不送出預演有未通過項目，禁止開始正式突襲。',
      passed,
      durationMs: Date.now() - startedAt,
      results: attempts
    };
  },
  onSaveAutoFillProfile: async (body) => {
    const result = await formAutoFill.saveProfile(body);
    await Promise.all([...formAutoFillWorkers.values()].filter((worker) => worker !== formAutoFill).map((worker) => worker.reloadProfile(body.slot)));
    return result;
  },
  onGetAutoFillProfile: (slot) => formAutoFill.getProfileForDashboard(slot),
  onSaveAISettings: async (body) => {
    const result = await formAutoFill.saveAISettings(body);
    await Promise.all([...formAutoFillWorkers.values()].filter((worker) => worker !== formAutoFill).map((worker) => worker.reloadAISettings()));
    return result;
  },
  onTestFormAI: () => formAutoFill.testAIConnection(),
  onSaveNote: (body) => saveDashboardNote(body.note),
  onSaveHotspot: async (body) => {
    const requestedPageUrls = Array.isArray(body.pageUrls)
      ? body.pageUrls.map(String)
      : [String(body.pageUrl || '')];
    const knownPageUrls = new Set(activeFacebookPages().map((page) => page.url));
    const pageUrls = [...new Set(requestedPageUrls)].filter((url) => knownPageUrls.has(url));
    if (Boolean(body.enabled) && !pageUrls.length) throw new Error('啟動熱點前，請至少選擇一個粉專');
    const participantSlots = [...new Set((Array.isArray(body.participantSlots) ? body.participantSlots : [1]).map(Number))]
      .filter((slot) => [1, 2, 3].includes(slot));
    if (!participantSlots.length) throw new Error('請至少選擇一組參加成員');
    config.hotspot = {
      ...config.hotspot,
      enabled: Boolean(body.enabled),
      pageUrl: pageUrls[0] || '',
      pageUrls,
      activeHours: {
        start: parseTimeValue(body.activeStart),
        end: parseTimeValue(body.activeEnd)
      },
      intervalSeconds: parseHotspotInterval(body.intervalSeconds),
      burstModeEnabled: Boolean(body.burstModeEnabled),
      burstHours: {
        start: parseTimeValue(body.burstStart ?? config.hotspot.burstHours.start),
        end: parseTimeValue(body.burstEnd ?? config.hotspot.burstHours.end)
      },
      burstIntervalSeconds: parseHotspotInterval(body.burstIntervalSeconds ?? config.hotspot.burstIntervalSeconds),
      burstPageLoadSeconds: 4,
      autoFillEnabled: Boolean(body.autoFillEnabled),
      autoSubmitEnabled: Boolean(body.autoSubmitEnabled),
      participantSlots
    };
    await saveConfig();
    if (config.monitoringEnabled) scheduleNext({ immediate: true });
    scheduleHotspot({ immediate: true });
    scheduleFormPrewarm();
    const masterText = config.monitoringEnabled ? 'FB 主監控已開啟，將依時段切換' : 'FB 主監控目前關閉，不會開始掃描';
    log(`熱點加速設定已更新：${hotspotPages().map((page) => page.name).join('、')}，${config.hotspot.activeHours.start}～${config.hotspot.activeHours.end} 每 ${config.hotspot.intervalSeconds} 秒；${masterText}；參加第 ${participantSlots.join('、')} 組。`, 'hotspot');
    return { message: `熱點加速模式已儲存；${masterText}。` };
  },
  onSaveSettings: async (body) => {
    config.scanIntervalMinutes = parseScanInterval(body.scanIntervalMinutes);
    config.activeHours = {
      start: parseTimeValue(body.activeStart ?? config.activeHours.start),
      end: parseTimeValue(body.activeEnd ?? config.activeHours.end)
    };
    await saveConfig();
    if (config.monitoringEnabled) scheduleNext();
    log(`掃描設定已更新：每 ${config.scanIntervalMinutes} 分鐘，時段 ${config.activeHours.start}～${config.activeHours.end}。`, 'regular');
    return { message: `已儲存：${config.activeHours.start}～${config.activeHours.end}，每 ${config.scanIntervalMinutes} 分鐘掃描。` };
  },
  onSaveKeywords: async (body) => {
    const productKeywords = parseKeywordList(body.productKeywords, '產品命中詞');
    const salesKeywords = parseKeywordList(body.salesKeywords, '販售／抽選命中詞');
    config.productKeywords = productKeywords;
    config.salesKeywords = salesKeywords;
    await saveConfig();
    log(`命中詞庫已更新：產品詞 ${productKeywords.length} 個，販售／抽選詞 ${salesKeywords.length} 個。`);
    return { message: `命中詞庫已儲存：產品詞 ${productKeywords.length} 個，販售／抽選詞 ${salesKeywords.length} 個。` };
  },
  onAddPage: async (body) => {
    const page = normalizeFacebookPage(body, config.pages);
    if (page.nameMode === 'auto' && !watcher.running) {
      try {
        page.name = await scanner.detectPageName(page.url);
      } catch (error) {
        log(`新增專頁時暫時無法抓取名稱：${error.message}`);
      }
    }
    config.pages.push(page);
    await saveConfig();
    if (!config.monitoringEnabled) await scanner.close();
    log(`已新增粉絲專頁：${page.name}`);
    return { message: `已新增「${page.name}」。第一次讀取只會建立基準。` };
  },
  onRenamePage: async (body) => {
    const page = config.pages.find((item) => item.url === String(body.url || ''));
    if (!page) throw new Error('找不到要修改的粉絲專頁');
    page.name = parsePageNickname(body.name);
    page.nameMode = 'manual';
    await saveConfig();
    log(`已設定粉專暱稱：${page.name}`);
    return { message: `暱稱已儲存為「${page.name}」。` };
  },
  onDetectPageName: async (body) => {
    if (watcher.running) throw new Error('目前正在掃描，請等掃描結束後再抓取名稱');
    const page = config.pages.find((item) => item.url === String(body.url || ''));
    if (!page) throw new Error('找不到要更新的粉絲專頁');
    page.name = await scanner.detectPageName(page.url);
    page.nameMode = 'auto';
    await saveConfig();
    if (!config.monitoringEnabled) await scanner.close();
    log(`已重新抓取粉專名稱：${page.name}`);
    return { message: `已抓取粉專名稱「${page.name}」。` };
  },
  onSetPageEnabled: async (body) => {
    const page = config.pages.find((item) => item.url === String(body.url || ''));
    if (!page) throw new Error('找不到要調整的粉絲專頁');
    const enabled = Boolean(body.enabled);
    if (page.enabled === enabled) {
      return { message: enabled ? `「${page.name}」原本就在監控中。` : `「${page.name}」原本就在暫停區。` };
    }
    page.enabled = enabled;
    await saveConfig();
    scheduleNext({ immediate: enabled });
    scheduleHotspot({ immediate: enabled });
    scheduleFormPrewarm();
    log(`${enabled ? '已恢復監控' : '已移至暫停區'}：${page.name}`, 'regular');
    return {
      message: enabled
        ? `已恢復「${page.name}」；將從下一輪開始掃描。`
        : `已暫停「${page.name}」；網址與暱稱仍會保留。`
    };
  },
  onDeletePage: async (body) => {
    const url = String(body.url || '');
    const index = config.pages.findIndex((page) => page.url === url);
    if (index < 0) throw new Error('找不到要刪除的粉絲專頁');
    const [removed] = config.pages.splice(index, 1);
    config.hotspot.pageUrls = configuredHotspotPageUrls().filter((pageUrl) => pageUrl !== removed.url);
    config.hotspot.pageUrl = config.hotspot.pageUrls[0] || '';
    delete state.data.initializedPages[removed.url];
    await Promise.all([saveConfig(), state.save()]);
    scheduleHotspot({ immediate: true });
    log(`已刪除粉絲專頁：${removed.name}`);
    return { message: `已刪除「${removed.name}」。` };
  }
});

const dashboardUrl = `http://127.0.0.1:${config.dashboardPort}`;
log(`控制頁：${dashboardUrl}`);
log(hasNotificationConfig(config.notifications.funbox)
  ? `Funbox 通知：${notificationChannelName(config.notifications.funbox)} 已設定。`
  : `Funbox 通知選擇 ${notificationChannelName(config.notifications.funbox)}，但設定尚未完整。`, 'funbox');
log(config.funbox.enabled ? 'Funbox 官網監控已啟動。' : 'Funbox 官網監控目前停止。', 'funbox');
if (config.funbox.enabled) scheduleFunbox({ immediate: true });
log(config.funboxSandbox.enabled ? 'Funbox 沙盒監控已啟動。' : 'Funbox 沙盒監控目前停止。', 'funbox');
if (config.funboxSandbox.enabled) scheduleFunboxSandbox({ immediate: true });
log(config.shoppingSites.enabled ? '購物網站監控已啟動。' : '購物網站監控目前停止。', 'shopping');
if (config.shoppingSites.enabled) scheduleShopping({ immediate: true });
log(config.japanAuctions.enabled ? '日本拍賣監控已啟動。' : '日本拍賣監控目前停止。', 'japan');
if (config.japanAuctions.enabled) scheduleJapan({ immediate: true });
log(config.amazonJp.enabled
  ? 'Amazon.co.jp 官方原價監控已啟動；採日本配送環境、官方定價與賣家 ID 三重核對。'
  : 'Amazon.co.jp 官方原價監控目前停止。', 'japan');
if (config.amazonJp.enabled) scheduleAmazonJp({ immediate: true });
for (const amazonJpProductOrder of amazonJpProductOrders) {
  log(config.amazonJpProductOrders[amazonJpProductOrder.slot].enabled
    ? `日亞商品頁任務 ${amazonJpProductOrder.slot} 已啟用。`
    : `日亞商品頁任務 ${amazonJpProductOrder.slot} 目前停止。`, 'japan');
  if (config.amazonJpProductOrders[amazonJpProductOrder.slot].enabled) await amazonJpProductOrder.start();
}
await pruneExpiredSaleReminders();
await saveConfig();
if (!config.systemPause.active) {
  scheduleSaleReminders({ immediate: true });
  scheduleDutyNotificationChecks();
  scheduleDiscordAutomation();
} else {
  log('遊戲模式仍在啟用：所有背景功能維持停止，控制頁可用。');
}

let shutdownPromise = null;

// Separate process: scanning/checkout must not wait for historical log IO.
let logMaintenanceWorker = null;
function scheduleLogMaintenance() {
  if (logMaintenanceWorker || shutdownPromise) return;
  logMaintenanceWorker = spawn(process.execPath, [path.join(rootDir, 'scripts', 'maintain-logs.mjs'), '--apply'], {
    cwd: rootDir, windowsHide: true, stdio: 'ignore'
  });
  logMaintenanceWorker.on('error', error => { log(`日誌清理失敗：${error.message}`); logMaintenanceWorker = null; });
  logMaintenanceWorker.on('exit', code => {
    logMaintenanceWorker = null;
    if (code) log(`日誌清理失敗：維護程式退出 ${code}`);
  });
}
const logMaintenanceStart = setTimeout(scheduleLogMaintenance, 60_000);
logMaintenanceStart.unref();
const logMaintenanceTimer = setInterval(scheduleLogMaintenance, 6 * 60 * 60_000);
logMaintenanceTimer.unref();

function shutdown(reason = 'shutdown', exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  logLifecycle('STOP_REQUEST', `reason=${reason} exitCode=${exitCode}`);
  shutdownPromise = (async () => {
    clearTimeout(logMaintenanceStart);
    clearInterval(logMaintenanceTimer);
    clearSchedule();
    clearHotspotSchedule();
    clearFormPrewarmSchedule();
    clearFunboxSchedule();
    clearFunboxSandboxSchedule();
    clearShoppingSchedule();
    clearJapanSchedule();
    clearAmazonJpSchedule();
    clearSaleReminderSchedule();
    clearDutyNotificationSchedule();
    clearDiscordAutomationSchedule();
    dashboard.close();
    const results = await Promise.allSettled([
      scanner.close(),
      closeAllFormAutoFillWorkers(),
      shoppingSiteMonitor.close(),
      japanAuctionMonitor.close(),
      amazonJapanMonitor.close(),
      ...amazonJpProductOrders.map((monitor) => monitor.close()),
      autoPurchase.close()
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('關閉服務元件失敗：', result.reason);
        logLifecycle('SHUTDOWN_COMPONENT_ERROR', String(result.reason?.stack || result.reason));
      }
    }
    logLifecycle('STOPPED', `reason=${reason} exitCode=${exitCode}`);
    process.exit(exitCode);
  })().catch((error) => {
    console.error('監控服務關閉失敗：', error);
    logLifecycle('SHUTDOWN_ERROR', String(error?.stack || error));
    process.exit(1);
  });
  return shutdownPromise;
}

process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('uncaughtException', (error) => {
  console.error('未捕捉例外：', error);
  logLifecycle('UNCAUGHT_EXCEPTION', String(error?.stack || error));
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  console.error('未處理 Promise 拒絕：', reason);
  logLifecycle('UNHANDLED_REJECTION', String(reason?.stack || reason));
  void shutdown('unhandledRejection', 1);
});
process.on('exit', (code) => logLifecycle('EXIT', `code=${code}`));
