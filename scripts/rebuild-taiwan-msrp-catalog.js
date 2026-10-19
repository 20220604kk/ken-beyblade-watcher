import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_DIR = path.join(ROOT, 'data', 'reference');
const localManualPath = path.join(REFERENCE_DIR, 'taiwan-msrp-manual.json');
const MANUAL_PATH = await fs.access(localManualPath).then(() => localManualPath)
  .catch(() => path.join(ROOT, 'assets', 'reference', 'taiwan-msrp-manual.json'));
const OUTPUT_PATH = path.join(REFERENCE_DIR, 'taiwan-msrp-catalog.json');
const TABLE_PATH = path.join(REFERENCE_DIR, 'taiwan-msrp-catalog.md');
const HUB_URL = 'https://beybladehub.app/parts/combos';
const USER_AGENT = 'Mozilla/5.0 (compatible; BeybladeTaiwanCatalog/1.0; +local-reference-build)';

const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const numberFrom = (value) => {
  const number = Number(String(value || '').replace(/[^0-9]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
};

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

function parseHubProduct(html, url) {
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());
  const heading = cleanText($('h1').first().text());
  const model = bodyText.match(/(?:型號\s*\|?\s*|\b)((?:BXG|BXA|BXH|BX|CX|UX)-\d{2})(?:\b|\s)/i)?.[1]?.toUpperCase()
    || heading.match(/\b(?:BXG|BXA|BXH|BX|CX|UX)-\d{2}\b/i)?.[0]?.toUpperCase()
    || '';
  const taiwanPrice = numberFrom(bodyText.match(/(?:台灣\s*)?NT\$\s*([\d,]+)/i)?.[1]);
  const japanPrice = numberFrom(bodyText.match(/日本\s*¥\s*([\d,]+)/i)?.[1]);
  const releaseDate = bodyText.match(/發售日\s*(20\d{2}-\d{2}-\d{2})/)?.[1] || null;
  const jan = bodyText.match(/\bJAN\s*(\d{13})\b/i)?.[1] || null;
  if (!model || !heading || !taiwanPrice) return null;
  return {
    catalogId: new URL(url).pathname.split('/').filter(Boolean).at(-1),
    model,
    name: heading.replace(/^戰鬥陀螺\s*X\s*/i, '').trim(),
    msrpTwd: taiwanPrice,
    msrpJpy: japanPrice,
    releaseDate,
    jan,
    sourceUrl: url,
    sourceKind: 'community_reference'
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function markdownTable(catalog) {
  const lines = [
    '# 台灣戰鬥陀螺建議售價基準',
    '',
    `更新：${catalog.generatedAt}`,
    '',
    `人工原價表：${catalog.summary.manualEntries} 筆；完整陀螺頁補遺：${catalog.summary.supplementEntries} 筆；合併後：${catalog.summary.totalEntries} 筆。`,
    '',
    '> 人工原價表是主要基準。BeybladeHub 為非官方玩家資料站，只作新品補遺與交叉核對；正式推播仍需搭配台灣官方通路來源。',
    '',
    '| 型號 | 品名／版本 | 台灣建議售價 | 來源 | 發售日 |',
    '|---|---|---:|---|---|'
  ];
  for (const product of catalog.products) {
    const source = product.primarySource === 'manual_image' ? '人工原價表' : 'BeybladeHub 補遺';
    lines.push(`| ${product.model} | ${product.name.replace(/\|/g, '／')} | NT$${product.msrpTwd.toLocaleString('en-US')} | ${source} | ${product.releaseDate || '—'} |`);
  }
  lines.push('', '## 使用規則', '',
    '- momo 商品先以 Goods Code 與官方專區身分判定，再用本表核對型號及價格。',
    '- 只靠名稱或價格相近，不足以判定為官方台灣正貨。',
    '- 同一型號可能存在限定色、復刻版或套組；BX-00 等多版本型號必須連同名稱與版本比對。',
    '- 新品若只出現在搜尋頁、不在可信官方來源，先記錄為候選，不直接公開推播。',
    '- 新品經 Funbox／momo 官方專區確認後，才升級成可信基準。',
    ''
  );
  return lines.join('\n');
}

async function main() {
  const manual = JSON.parse(await fs.readFile(MANUAL_PATH, 'utf8'));
  const listingHtml = await fetchText(HUB_URL);
  const $ = cheerio.load(listingHtml);
  const detailUrls = [...new Set(
    $('a[href^="/parts/combos/"]').map((_, element) => new URL($(element).attr('href'), HUB_URL).href).get()
  )].sort();

  const supplement = (await mapConcurrent(detailUrls, 4, async (url) => {
    try {
      return parseHubProduct(await fetchText(url), url);
    } catch (error) {
      console.warn(`略過 ${url}: ${error.message}`);
      return null;
    }
  })).filter(Boolean);

  const manualProducts = manual.products.map((product) => ({
    ...product,
    catalogId: `manual-${product.model.toLowerCase()}`,
    primarySource: 'manual_image',
    sourceUrl: null,
    releaseDate: null,
    jan: null
  }));
  const manualExactKeys = new Set(manualProducts.map((product) => `${product.model}|${product.msrpTwd}`));
  const supplementOnly = supplement
    .filter((product) => !manualExactKeys.has(`${product.model}|${product.msrpTwd}`))
    .map((product) => ({ ...product, primarySource: 'beybladehub' }));
  const products = [...manualProducts, ...supplementOnly]
    .sort((a, b) => a.model.localeCompare(b.model, 'en') || a.name.localeCompare(b.name, 'zh-Hant'));

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    currency: 'TWD',
    trustPolicy: {
      primary: 'user_supplied_price_table_image',
      supplement: 'beybladehub_community_reference',
      publicNotificationRequiresOfficialChannelConfirmation: true
    },
    sources: [
      manual.source,
      {
        kind: 'community_reference',
        url: HUB_URL,
        title: 'BeybladeHub 完整陀螺',
        disclaimer: '非官方玩家資料站，僅用於補遺與交叉核對。'
      }
    ],
    summary: {
      manualEntries: manualProducts.length,
      supplementEntries: supplementOnly.length,
      totalEntries: products.length,
      hubDetailPagesChecked: detailUrls.length,
      hubEntriesWithTaiwanPrice: supplement.length
    },
    products
  };

  await fs.mkdir(REFERENCE_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await fs.writeFile(TABLE_PATH, `${markdownTable(catalog)}\n`, 'utf8');
  console.log(JSON.stringify(catalog.summary));
}

await main();
