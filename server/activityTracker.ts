import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {QuotaManager, QuotaSnapshot} from './quota.ts';

export type ActivityChannel = 'telegram_bot' | 'telegram_webapp' | 'web';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  ownerKey: string;
  ownerHash: string;
  channel: ActivityChannel;
  telegramUserId?: number;
  telegramUsername?: string;
  firstName?: string;
  action: string;
  details: string;
  targetsCount?: number;
  targetsSample?: string[];
}

export interface TrackedUser {
  ownerKey: string;
  ownerHash: string;
  channel: ActivityChannel;
  telegramUserId?: number;
  telegramUsername?: string;
  firstName?: string;
  discordAccountId?: string;
  discordUsername?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAction: string;
  lastDetails: string;
  totalActions: number;
  totalJobsStarted: number;
  totalLookupsProcessed: number;
  totalLookupsResolved: number;
  totalLookupsFailed: number;
  totalExportsDownloaded: number;
  blockedCount: number;
}

export interface RecordActivityInput {
  ownerKey: string;
  ownerHash: string;
  channel: ActivityChannel;
  telegramUserId?: number;
  telegramUsername?: string;
  firstName?: string;
  discordAccountId?: string;
  discordUsername?: string;
  action: string;
  details: string;
  targetsCount?: number;
  targetsSample?: string[];
  increments?: {
    jobsStarted?: number;
    lookupsProcessed?: number;
    lookupsResolved?: number;
    lookupsFailed?: number;
    exportsDownloaded?: number;
    blocked?: number;
  };
}

interface ActivityStore {
  users: Record<string, TrackedUser>;
  events: ActivityEvent[];
}

const MAX_EVENTS = 1000;
const MAX_USERS = 2000;

function sanitizeText(raw: string, maxLen = 280): string {
  // Never store anything shaped like a Discord user/bot token or Telegram token
  const scrubbed = raw
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, '[redacted-token]')
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/g, '[redacted-bot-token]');
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(str) && !/^-\d+(\.\d+)?$/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

export class ActivityTracker {
  private readonly filePath: string;
  private store: ActivityStore = {users: {}, events: []};
  private writeChain: Promise<void> = Promise.resolve();
  private listeners = new Set<(event: ActivityEvent, user: TrackedUser, isNewUser: boolean) => void>();

  constructor(dataDir: string) {
    this.filePath = path.resolve(dataDir, 'activity.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {recursive: true});
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Partial<ActivityStore>;
        this.store = {
          users: obj.users && typeof obj.users === 'object' ? obj.users : {},
          events: Array.isArray(obj.events) ? obj.events.slice(-MAX_EVENTS) : [],
        };
      }
    } catch {
      this.store = {users: {}, events: []};
    }
  }

  onEvent(
    listener: (event: ActivityEvent, user: TrackedUser, isNewUser: boolean) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private pruneStore(): void {
    if (this.store.events.length > MAX_EVENTS) {
      this.store.events = this.store.events.slice(-MAX_EVENTS);
    }
    const keys = Object.keys(this.store.users);
    if (keys.length > MAX_USERS) {
      keys.sort((a, b) =>
        this.store.users[b].lastSeenAt.localeCompare(this.store.users[a].lastSeenAt),
      );
      for (const oldKey of keys.slice(MAX_USERS)) {
        delete this.store.users[oldKey];
      }
    }
  }

  private schedulePersist(): void {
    this.pruneStore();
    const payload = JSON.stringify(this.store, null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.writeFile(this.filePath, payload, 'utf8'))
      .catch(() => undefined);
  }

  record(input: RecordActivityInput): {
    isNewUser: boolean;
    event: ActivityEvent;
    user: TrackedUser;
  } {
    const now = new Date().toISOString();
    const existing = this.store.users[input.ownerKey];
    const isNewUser = !existing;
    const cleanDetails = sanitizeText(input.details);
    const cleanSample = Array.isArray(input.targetsSample)
      ? input.targetsSample.slice(0, 5).map((t) => sanitizeText(t, 64))
      : undefined;

    const user: TrackedUser = existing
      ? {
          ...existing,
          channel: input.channel,
          telegramUserId: input.telegramUserId ?? existing.telegramUserId,
          telegramUsername: input.telegramUsername ?? existing.telegramUsername,
          firstName: input.firstName ?? existing.firstName,
          discordAccountId: input.discordAccountId ?? existing.discordAccountId,
          discordUsername: input.discordUsername ?? existing.discordUsername,
          lastSeenAt: now,
          lastAction: input.action,
          lastDetails: cleanDetails,
          totalActions: existing.totalActions + 1,
          totalJobsStarted: existing.totalJobsStarted + (input.increments?.jobsStarted ?? 0),
          totalLookupsProcessed:
            existing.totalLookupsProcessed + (input.increments?.lookupsProcessed ?? 0),
          totalLookupsResolved:
            existing.totalLookupsResolved + (input.increments?.lookupsResolved ?? 0),
          totalLookupsFailed:
            existing.totalLookupsFailed + (input.increments?.lookupsFailed ?? 0),
          totalExportsDownloaded:
            existing.totalExportsDownloaded + (input.increments?.exportsDownloaded ?? 0),
          blockedCount: existing.blockedCount + (input.increments?.blocked ?? 0),
        }
      : {
          ownerKey: input.ownerKey,
          ownerHash: input.ownerHash,
          channel: input.channel,
          telegramUserId: input.telegramUserId,
          telegramUsername: input.telegramUsername,
          firstName: input.firstName,
          discordAccountId: input.discordAccountId,
          discordUsername: input.discordUsername,
          firstSeenAt: now,
          lastSeenAt: now,
          lastAction: input.action,
          lastDetails: cleanDetails,
          totalActions: 1,
          totalJobsStarted: input.increments?.jobsStarted ?? 0,
          totalLookupsProcessed: input.increments?.lookupsProcessed ?? 0,
          totalLookupsResolved: input.increments?.lookupsResolved ?? 0,
          totalLookupsFailed: input.increments?.lookupsFailed ?? 0,
          totalExportsDownloaded: input.increments?.exportsDownloaded ?? 0,
          blockedCount: input.increments?.blocked ?? 0,
        };

    this.store.users[input.ownerKey] = user;

    const event: ActivityEvent = {
      id: crypto.randomUUID().slice(0, 12),
      timestamp: now,
      ownerKey: input.ownerKey,
      ownerHash: input.ownerHash,
      channel: input.channel,
      telegramUserId: user.telegramUserId,
      telegramUsername: user.telegramUsername,
      firstName: user.firstName,
      action: input.action,
      details: cleanDetails,
      targetsCount: input.targetsCount,
      targetsSample: cleanSample,
    };

    this.store.events.push(event);
    this.schedulePersist();

    for (const listener of this.listeners) {
      try {
        listener(event, user, isNewUser);
      } catch {
        // Never allow listener errors to break activity tracking
      }
    }

    return {isNewUser, event, user};
  }

  getSummary(quotaManager: QuotaManager, eventLimit = 100): {
    totalUsers: number;
    activeToday: number;
    totalEvents: number;
    users: Array<TrackedUser & {quota: QuotaSnapshot}>;
    events: ActivityEvent[];
  } {
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const allUsers = Object.values(this.store.users)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((u) => ({
        ...u,
        quota: quotaManager.getQuota(u.ownerKey),
      }));

    const activeToday = allUsers.filter((u) => u.lastSeenAt.startsWith(todayPrefix)).length;
    const clampedLimit = Math.min(Math.max(1, eventLimit), MAX_EVENTS);
    const events = this.store.events.slice(-clampedLimit).reverse();

    return {
      totalUsers: allUsers.length,
      activeToday,
      totalEvents: this.store.events.length,
      users: allUsers,
      events,
    };
  }

  getUserDetail(
    query: string,
    quotaManager: QuotaManager,
    eventLimit = 20,
  ): {
    user: TrackedUser;
    quota: QuotaSnapshot;
    events: ActivityEvent[];
  } | null {
    const clean = query.trim().replace(/^@/, '').toLowerCase();
    if (!clean) return null;

    const match = Object.values(this.store.users).find((u) => {
      if (u.ownerKey.toLowerCase() === clean) return true;
      if (u.ownerHash.toLowerCase() === clean) return true;
      if (u.telegramUserId !== undefined && String(u.telegramUserId) === clean) return true;
      if (u.telegramUsername && u.telegramUsername.toLowerCase() === clean) return true;
      if (u.discordUsername && u.discordUsername.toLowerCase() === clean) return true;
      return false;
    });

    if (!match) return null;

    const events = this.store.events
      .filter((e) => e.ownerKey === match.ownerKey)
      .slice(-Math.min(Math.max(1, eventLimit), 100))
      .reverse();

    return {
      user: match,
      quota: quotaManager.getQuota(match.ownerKey),
      events,
    };
  }

  buildExportCsv(quotaManager: QuotaManager): string {
    const summary = this.getSummary(quotaManager, MAX_EVENTS);
    const headers = [
      'timestamp',
      'owner_key',
      'channel',
      'telegram_user_id',
      'telegram_username',
      'first_name',
      'action',
      'details',
      'targets_count',
      'targets_sample',
    ];
    const lines = [headers.map(csvCell).join(',')];
    for (const ev of summary.events) {
      lines.push(
        [
          ev.timestamp,
          ev.ownerKey,
          ev.channel,
          ev.telegramUserId ?? '',
          ev.telegramUsername ?? '',
          ev.firstName ?? '',
          ev.action,
          ev.details,
          ev.targetsCount ?? '',
          ev.targetsSample ? ev.targetsSample.join(', ') : '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\n');
  }

  buildExportJson(quotaManager: QuotaManager): string {
    const summary = this.getSummary(quotaManager, MAX_EVENTS);
    return JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        total_users: summary.totalUsers,
        active_today: summary.activeToday,
        total_events: summary.totalEvents,
        users: summary.users,
        events: summary.events,
      },
      null,
      2,
    );
  }
}
