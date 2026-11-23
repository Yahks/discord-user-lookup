import fs from 'node:fs/promises';
import path from 'node:path';

export interface QuotaSnapshot {
  tier: 'free';
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  dateUtc: string;
}

type QuotaStore = Record<string, Record<string, number>>;

function getUtcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getNextUtcMidnightIso(date = new Date()): string {
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.toISOString();
}

export class QuotaManager {
  private readonly filePath: string;
  private readonly dailyLimit: number;
  private store: QuotaStore = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, dailyLimit = 50) {
    this.filePath = path.resolve(dataDir, 'quota.json');
    this.dailyLimit = Math.max(1, Math.floor(dailyLimit));
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {recursive: true});
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.store = parsed as QuotaStore;
        this.pruneOldDates();
      }
    } catch {
      this.store = {};
    }
  }

  private pruneOldDates(): void {
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const dateKey of Object.keys(this.store)) {
      if (dateKey < cutoff) {
        delete this.store[dateKey];
      }
    }
  }

  private async persist(): Promise<void> {
    this.pruneOldDates();
    const payload = JSON.stringify(this.store, null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.writeFile(this.filePath, payload, 'utf8'))
      .catch(() => undefined);
    await this.writeChain;
  }

  getQuota(ownerKey: string): QuotaSnapshot {
    const now = new Date();
    const dateKey = getUtcDateKey(now);
    const used = Math.max(0, Number(this.store[dateKey]?.[ownerKey] ?? 0));
    const remaining = Math.max(0, this.dailyLimit - used);

    return {
      tier: 'free',
      limit: this.dailyLimit,
      used,
      remaining,
      resetsAt: getNextUtcMidnightIso(now),
      dateUtc: dateKey,
    };
  }

  async consumeOne(ownerKey: string): Promise<{allowed: boolean; quota: QuotaSnapshot}> {
    const now = new Date();
    const dateKey = getUtcDateKey(now);
    if (!this.store[dateKey]) {
      this.store[dateKey] = {};
    }
    const current = Math.max(0, Number(this.store[dateKey][ownerKey] ?? 0));

    if (current >= this.dailyLimit) {
      return {
        allowed: false,
        quota: this.getQuota(ownerKey),
      };
    }

    this.store[dateKey][ownerKey] = current + 1;
    await this.persist();
    return {
      allowed: true,
      quota: this.getQuota(ownerKey),
    };
  }
}
