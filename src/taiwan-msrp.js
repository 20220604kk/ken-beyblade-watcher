import fs from 'node:fs';

const CATALOG_URL = new URL('../data/reference/taiwan-msrp-catalog.json', import.meta.url);
const IMPORT_VERSION_WORDS = /(?:美版|韓版|日版|海外版|歐美版|平行輸入|水貨)/i;
const MODEL_PATTERN = /\b(?:BXG|BXA|BXH|BX|CX|UX)-\d{2}\b/gi;

export const taiwanMsrpCatalog = JSON.parse(fs.readFileSync(CATALOG_URL, 'utf8'));

export function extractBeybladeModels(text) {
  return [...new Set(String(text || '').match(MODEL_PATTERN)?.map((value) => value.toUpperCase()) || [])];
}

export function taiwanMsrpEntries(model) {
  const normalized = String(model || '').trim().toUpperCase();
  return taiwanMsrpCatalog.products.filter((product) => product.model === normalized);
}

function parsePrice(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function evaluateTaiwanMsrpCandidate({ title, price }) {
  const text = String(title || '');
  const models = extractBeybladeModels(text);
  const observedPrice = parsePrice(price);
  if (IMPORT_VERSION_WORDS.test(text)) {
    return { accepted: false, reason: 'import_version', models, observedPrice, entries: [] };
  }
  if (models.length !== 1) {
    return {
      accepted: false,
      reason: models.length ? 'multiple_models' : 'missing_model',
      models,
      observedPrice,
      entries: []
    };
  }
  const entries = taiwanMsrpEntries(models[0]);
  if (!entries.length) {
    return { accepted: false, reason: 'unknown_model', models, observedPrice, entries };
  }
  if (!observedPrice) {
    return { accepted: false, reason: 'missing_price', models, observedPrice, entries };
  }
  if (entries.some((entry) => entry.ambiguousModel)) {
    return { accepted: false, reason: 'ambiguous_model_version', models, observedPrice, entries };
  }

  const matched = entries.find((entry) => observedPrice === entry.msrpTwd)
    || entries.find((entry) => observedPrice >= Math.ceil(entry.msrpTwd * 0.85) && observedPrice < entry.msrpTwd);
  if (!matched) {
    return { accepted: false, reason: 'price_mismatch', models, observedPrice, entries };
  }
  return {
    accepted: true,
    reason: observedPrice === matched.msrpTwd ? 'exact_msrp' : 'official_price_promotion',
    models,
    observedPrice,
    matched,
    entries
  };
}

