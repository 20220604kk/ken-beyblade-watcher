import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE_PATTERN = /^\d{13}-[a-f0-9-]{36}\.json$/;
const text = (value) => String(value || '').slice(0, 600);
const safeError = (value) => text(value).replace(/https?:\/\/\S+/g, '[網址略去]');

export function amazonOrderTimings(record) {
  const at = (name) => record.steps?.find((step) => step.name === name)?.at;
  const elapsed = (start, end) => {
    const value = Date.parse(end) - Date.parse(start);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const purchaseAt = at('buy_now_click') || at('add_cart_click');
  const submitAt = at('submit_order');
  const confirmedAt = record.status === 'ordered' ? record.finishedAt : null;
  return {
    signalToRefreshMs: elapsed(record.signalAt, at('refresh_start')),
    refreshToQualifiedMs: elapsed(at('refresh_start'), at('product_evaluated')),
    qualifiedToPurchaseMs: elapsed(at('product_evaluated'), purchaseAt),
    purchaseToSubmitMs: elapsed(purchaseAt, submitAt),
    submitToConfirmedMs: elapsed(submitAt, confirmedAt),
    refreshToConfirmedMs: elapsed(at('refresh_start'), confirmedAt),
    confirmedToNotificationMs: record.notification?.status === 'sent'
      ? elapsed(confirmedAt, record.notification.at) : null
  };
}

// One bounded JSON file per purchase attempt, independent of resettable task state.
// Checkpoints use atomic replacement; routine sold-out polling creates no files.
export class AmazonOrderHistory {
  constructor(dataDir, { log = () => {} } = {}) {
    this.directory = path.join(dataDir, 'records', 'amazon-product-orders');
    this.log = log;
    this.recent = [];
    this.total = 0;
    this.lastError = '';
    this.ready = this.load();
  }

  problem(error) {
    const message = `訂單時間紀錄無法完整保存：${safeError(error.message)}`;
    if (message !== this.lastError) this.log(message);
    this.lastError = message;
  }

  async load() {
    try {
      await fs.mkdir(this.directory, { recursive: true });
      const names = [];
      for await (const entry of await fs.opendir(this.directory)) {
        if (!entry.isFile() || !FILE_PATTERN.test(entry.name)) continue;
        this.total += 1;
        names.push(entry.name);
        names.sort().reverse();
        if (names.length > 20) names.pop();
      }
      for (const name of names) {
        try {
          const record = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
          if (record.schemaVersion !== 1 || `${record.id}.json` !== name || !Array.isArray(record.steps)) throw new Error('歷史紀錄格式不符');
          if (record.status === 'in_progress') record.status = 'interrupted';
          this.recent.push(record);
        } catch (error) { this.problem(error); }
      }
    } catch (error) { this.problem(error); }
  }

  async save(record) {
    try {
      const file = path.join(this.directory, `${record.id}.json`);
      const temp = `${file}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await fs.rename(temp, file);
    } catch (error) {
      // A logging failure must not turn an accepted order into a retry.
      this.problem(error);
    }
  }

  async begin({ slot = 'A', mode, trigger, signalAt, scanStartedAt, taskStartedAt, snapshot, msrpYen, steps }) {
    await this.ready;
    const record = {
      schemaVersion: 1, id: `${Date.now()}-${randomUUID()}`, platform: 'amazon_jp_product',
      slot, mode, trigger, signalAt: signalAt || null, scanStartedAt, taskStartedAt: taskStartedAt || null,
      startedAt: new Date().toISOString(), status: 'in_progress',
      product: { asin: text(snapshot.asin), code: text(snapshot.code), title: text(snapshot.title), priceYen: snapshot.priceYen, msrpYen },
      steps: (steps || []).map((step) => this.cleanStep(step))
    };
    this.recent.unshift(record);
    this.recent = this.recent.slice(0, 20);
    this.total += 1;
    await this.save(record);
    return record;
  }

  cleanStep(step) {
    // Do not retain checkout URLs, page bodies, cookies, addresses or payment data.
    return {
      name: text(step.name), at: step.at, elapsedMs: step.elapsedMs,
      ...(step.step ? { step: step.step } : {}),
      ...(step.result ? { result: text(step.result) } : {}),
      ...(step.status ? { status: text(step.status) } : {}),
      ...(step.orderId ? { orderId: text(step.orderId) } : {}),
      ...(step.error ? { error: safeError(step.error) } : {})
    };
  }

  async step(record, step) {
    record.steps.push(this.cleanStep(step));
    await this.save(record);
  }

  async finish(record, { status, orderId, error }) {
    if (record.finishedAt) return;
    Object.assign(record, { status, orderId: text(orderId), error: safeError(error), finishedAt: new Date().toISOString() });
    await this.save(record);
  }

  async notification(record, { status, at, error }) {
    record.notification = { status, at, error: safeError(error) };
    await this.save(record);
  }

  status() {
    return { total: this.total, error: this.lastError, directory: this.directory,
      recent: this.recent.map((record) => ({ ...record, timings: amazonOrderTimings(record) })) };
  }
}
