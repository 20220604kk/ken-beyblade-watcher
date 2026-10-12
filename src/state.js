import fs from 'node:fs/promises';
import path from 'node:path';

const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function renameWithRetry(
  source,
  target,
  {
    rename = fs.rename,
    attempts = 8,
    waitFor = wait
  } = {}
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_ERRORS.has(error.code) || attempt === attempts - 1) throw error;
      await waitFor(40 * (attempt + 1));
    }
  }
  throw lastError;
}

export class StateStore {
  constructor(dataDir, { saveDelayMs = 350 } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.data = { seen: {}, forms: {}, initializedPages: {}, lastScan: null };
    this.saveQueue = Promise.resolve();
    this.saveDelayMs = Math.max(0, Number(saveDelayMs) || 0);
    this.scheduledSave = null;
    this.saveTimer = null;
    this.saveStats = { requested: 0, writes: 0, coalesced: 0, lastWriteAt: '', lastBytes: 0 };
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.data.seen ||= {};
    this.data.initializedPages ||= {};
    const needsFormHistoryMigration = !this.data.forms;
    this.data.forms ||= {};
    // 升級前已經看過的表單不能在重啟後被誤當成剛出現，否則會補送
    // 歷史表單。新版本之後出現的網址會直接寫入 forms，不再需要推測。
    if (needsFormHistoryMigration) {
      for (const [postId, post] of Object.entries(this.data.seen)) {
        for (const formUrl of post.formUrls || []) {
          this.data.forms[formUrl] ||= {
            status: 'legacy_seen',
            postId,
            pageName: post.pageName,
            firstDetectedAt: post.firstDetectedAt || post.firstSeen
          };
        }
      }
    }
    return this.data;
  }

  has(postId) {
    return Boolean(this.data.seen[postId]);
  }

  mark(postId, details = {}) {
    const now = new Date().toISOString();
    this.data.seen[postId] = {
      ...this.data.seen[postId],
      ...details,
      firstSeen: this.data.seen[postId]?.firstSeen || now,
      lastSeen: now
    };
  }

  isPageInitialized(pageUrl) {
    return Boolean(this.data.initializedPages[pageUrl]);
  }

  initializePage(pageUrl) {
    this.data.initializedPages[pageUrl] = new Date().toISOString();
  }

  canAttemptForm(formUrl, now = new Date()) {
    this.data.forms ||= {};
    const record = this.data.forms[formUrl];
    if (!record) return true;
    if (['submitted', 'needs_confirmation', 'closed', 'permission_required', 'handled', 'legacy_seen'].includes(record.status)) return false;
    if (Number(record.attempts || 0) >= 3) return false;
    const lastAttempt = Date.parse(record.lastAttemptAt || '');
    const retryDelay = record.status === 'processing' ? 120000 : 10000;
    return !Number.isFinite(lastAttempt) || now.getTime() - lastAttempt >= retryDelay;
  }

  claimForm(formUrl, details = {}) {
    if (!this.canAttemptForm(formUrl)) return false;
    const now = new Date().toISOString();
    const previous = this.data.forms[formUrl] || {};
    this.data.forms[formUrl] = {
      ...previous,
      ...details,
      status: 'processing',
      firstDetectedAt: previous.firstDetectedAt || details.detectedAt || now,
      lastAttemptAt: now,
      attempts: Number(previous.attempts || 0) + 1
    };
    return true;
  }

  completeForm(formUrl, details = {}) {
    const now = new Date().toISOString();
    const previous = this.data.forms[formUrl] || {};
    this.data.forms[formUrl] = {
      ...previous,
      ...details,
      completedAt: now
    };
  }

  async writeSnapshot() {
    const operation = this.saveQueue.catch(() => {}).then(async () => {
      const entries = Object.entries(this.data.seen);
      if (entries.length > 3000) {
        entries.sort((a, b) => String(b[1].lastSeen).localeCompare(String(a[1].lastSeen)));
        this.data.seen = Object.fromEntries(entries.slice(0, 3000));
      }
      const serialized = `${JSON.stringify(this.data)}\n`;
      const temporary = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await fs.writeFile(temporary, serialized, 'utf8');
        await renameWithRetry(temporary, this.file);
        this.saveStats.writes += 1;
        this.saveStats.lastWriteAt = new Date().toISOString();
        this.saveStats.lastBytes = Buffer.byteLength(serialized, 'utf8');
      } finally {
        await fs.unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
    this.saveQueue = operation;
    return operation;
  }

  async save() {
    this.saveStats.requested += 1;
    // 立即接住上一輪錯誤；否則 debounce 等待期間會先形成未處理 rejection。
    this.saveQueue = this.saveQueue.catch(() => {});
    if (this.scheduledSave) {
      this.saveStats.coalesced += 1;
      return this.scheduledSave;
    }
    this.scheduledSave = new Promise((resolve, reject) => {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.scheduledSave = null;
        this.writeSnapshot().then(resolve, reject);
      }, this.saveDelayMs);
    });
    return this.scheduledSave;
  }

  getSaveStats() {
    return { ...this.saveStats, pending: Boolean(this.scheduledSave) };
  }
}
