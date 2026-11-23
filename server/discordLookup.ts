import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {QuotaManager} from './quota.ts';
import {hashToken} from './security.ts';

const DISCORD_BASE_URL = 'https://discord.com/api/v9';
const DISCORD_EPOCH_MS = 1420070400000n;
const MIN_SAFE_DELAY_MS = 1200;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

export interface LookupOptions {
  fetchProfile: boolean;
  fetchSupplemental: boolean;
  fetchMessages: boolean;
  messageLimit: number;
  withMutualGuilds: boolean;
  withMutualFriends: boolean;
  delayMs: number;
  label: string;
}

export interface LookupResultEntry {
  query: string;
  id: string;
  status: 'resolved' | 'failed';
  resolved_from: string;
  username: string;
  global_name: string;
  discriminator: string;
  tag: string;
  bot: boolean;
  created_at: string;
  avatar: string;
  avatar_url: string;
  public_flags: number;
  bio: string;
  pronouns: string;
  badges: string[];
  connected_accounts: string[];
  mutual_guilds: string[];
  mutual_friends: string[];
  dm_channel_id: string;
  message_count_sampled: number;
  error: string;
  raw: {
    dm_channel?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    supplemental_data?: unknown;
    messages?: unknown[];
  };
}

export type JobStatus = 'running' | 'paused' | 'completed' | 'stopped' | 'failed';

export interface LookupJob {
  id: string;
  ownerKey: string;
  ownerHash: string;
  status: JobStatus;
  label: string;
  targets: string[];
  currentIndex: number;
  total: number;
  resolvedCount: number;
  failedCount: number;
  currentTarget: string;
  rateLimitNote: string;
  quotaNote: string;
  haltReason: string;
  startedAt: string;
  finishedAt: string | null;
  options: LookupOptions;
  results: LookupResultEntry[];
  savedFiles: {
    csv: string | null;
    json: string | null;
  };
}

export interface VerifiedAccount {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar_url: string;
}

function buildSuperProperties(): string {
  const props = {
    os: 'Linux',
    browser: 'Chrome',
    device: '',
    device_model_name: '',
    system_locale: 'en-NG',
    has_client_mods: false,
    browser_user_agent: USER_AGENT,
    browser_version: '147.0.0.0',
    os_version: '',
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: 673919,
    client_event_source: null,
    client_app_state: 'focused',
  };
  return Buffer.from(JSON.stringify(props)).toString('base64');
}

function buildContextProperties(location: string): string {
  return Buffer.from(JSON.stringify({location})).toString('base64');
}

const SUPER_PROPERTIES = buildSuperProperties();

export function snowflakeToIso(snowflakeId: string): string {
  if (!/^\d+$/.test(snowflakeId)) return '';
  try {
    const id = BigInt(snowflakeId);
    const ms = Number((id >> 22n) + DISCORD_EPOCH_MS);
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

export function buildAvatarUrl(
  userId: string,
  avatarHash?: string | null,
  discriminator = '0',
): string {
  if (avatarHash && /^[a-zA-Z0-9_-]+$/.test(avatarHash)) {
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'webp';
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(userId)}/${encodeURIComponent(avatarHash)}.${ext}?size=256`;
  }
  try {
    if (discriminator && discriminator !== '0' && /^\d+$/.test(discriminator)) {
      const index = Number(discriminator) % 5;
      return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }
    if (/^\d+$/.test(userId)) {
      const index = Number((BigInt(userId) >> 22n) % 6n);
      return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }
  } catch {
    // Fallback below
  }
  return 'https://cdn.discordapp.com/embed/avatars/0.png';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(str) && !/^-\d+(\.\d+)?$/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

export class DiscordApiClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token.trim();
  }

  private baseHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.token,
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'en-NG,en-US;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Origin: 'https://discord.com',
      Referer: 'https://discord.com/channels/@me',
      'User-Agent': USER_AGENT,
      'X-Debug-Options': 'bugReporterEnabled',
      'X-Discord-Locale': 'en-US',
      'X-Discord-Timezone': 'America/New_York',
      'X-Super-Properties': SUPER_PROPERTIES,
      ...extra,
    };
  }

  async request(
    method: 'GET' | 'POST',
    endpoint: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      onRateLimit?: (seconds: number) => void;
      onAccountAlert?: (reason: string) => void;
    },
  ): Promise<{ok: boolean; status: number; data: unknown; error: string; fatalAccountAlert?: string}> {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = `${DISCORD_BASE_URL}/${cleanEndpoint}`;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await fetch(url, {
          method,
          headers: this.baseHeaders(options?.headers),
          body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        });

        const text = await resp.text();
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }

        if (resp.status === 429) {
          let retryAfter = 5;
          if (parsed && typeof parsed === 'object' && 'retry_after' in parsed) {
            const val = Number((parsed as Record<string, unknown>).retry_after);
            if (!Number.isNaN(val) && val > 0) retryAfter = val;
          } else {
            const headerVal = Number(resp.headers.get('retry-after'));
            if (!Number.isNaN(headerVal) && headerVal > 0) retryAfter = headerVal;
          }
          const safeWaitSec = retryAfter + 1.0;
          options?.onRateLimit?.(safeWaitSec);
          await sleep(Math.ceil(safeWaitSec * 1000));
          continue;
        }

        if (resp.status >= 500) {
          await sleep(1500 * (attempt + 1));
          continue;
        }

        if (resp.ok) {
          return {ok: true, status: resp.status, data: parsed, error: ''};
        }

        let errMsg = `HTTP ${resp.status}`;
        let code = 0;
        let hasCaptcha = false;
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          if ('message' in obj) errMsg = String(obj.message);
          if ('code' in obj) code = Number(obj.code) || 0;
          if ('captcha_key' in obj) hasCaptcha = true;
        } else if (typeof parsed === 'string' && parsed.trim()) {
          errMsg = parsed.slice(0, 200);
        }

        let fatalAccountAlert = '';
        if (resp.status === 401) {
          fatalAccountAlert = 'Token rejected (401 Unauthorized). Halted to protect account.';
        } else if (hasCaptcha) {
          fatalAccountAlert = 'Discord requested CAPTCHA verification. Halted to protect account.';
        } else if (resp.status === 403 && code === 40002) {
          fatalAccountAlert = 'Discord requested account verification (40002). Halted to protect account.';
        }

        if (fatalAccountAlert) {
          options?.onAccountAlert?.(fatalAccountAlert);
        }

        return {ok: false, status: resp.status, data: parsed, error: errMsg, fatalAccountAlert};
      } catch (err) {
        if (attempt === maxRetries - 1) {
          const message = err instanceof Error ? err.message : 'Network error';
          return {ok: false, status: 0, data: null, error: message};
        }
        await sleep(1500);
      }
    }

    return {ok: false, status: 429, data: null, error: 'Rate limit retries exceeded'};
  }

  async verifyToken(): Promise<{ok: boolean; account?: VerifiedAccount; error?: string}> {
    const res = await this.request('GET', 'users/@me');
    if (!res.ok || !res.data || typeof res.data !== 'object') {
      return {ok: false, error: res.error || 'Invalid Discord token'};
    }
    const user = res.data as Record<string, unknown>;
    const id = String(user.id ?? '');
    const username = String(user.username ?? '');
    const discriminator = String(user.discriminator ?? '0');
    const avatar = typeof user.avatar === 'string' ? user.avatar : null;

    return {
      ok: true,
      account: {
        id,
        username,
        global_name: typeof user.global_name === 'string' ? user.global_name : null,
        discriminator,
        avatar_url: buildAvatarUrl(id, avatar, discriminator),
      },
    };
  }

  private matchesUsername(userObj: Record<string, unknown>, target: string): boolean {
    const needle = target.trim().replace(/^@/, '').toLowerCase();
    const uname = String(userObj.username ?? '').toLowerCase();
    const disc = String(userObj.discriminator ?? '0');
    const gname = String(userObj.global_name ?? '').toLowerCase();

    if (needle.includes('#')) {
      return `${uname}#${disc}` === needle;
    }
    return uname === needle || (gname.length > 0 && gname === needle);
  }

  async resolveUsernameToId(
    username: string,
    onRateLimit?: (seconds: number) => void,
  ): Promise<{userId: string; source: string; user: Record<string, unknown>} | null> {
    const cleanName = username.trim().replace(/^@/, '');
    const baseQuery = cleanName.split('#')[0];

    const dmRes = await this.request('GET', 'users/@me/channels', {onRateLimit});
    if (dmRes.ok && Array.isArray(dmRes.data)) {
      for (const ch of dmRes.data) {
        if (ch && typeof ch === 'object' && Array.isArray((ch as Record<string, unknown>).recipients)) {
          for (const rec of (ch as Record<string, unknown>).recipients as Record<string, unknown>[]) {
            if (this.matchesUsername(rec, cleanName)) {
              return {userId: String(rec.id), source: 'dm_channels', user: rec};
            }
          }
        }
      }
    }

    const relRes = await this.request('GET', 'users/@me/relationships', {onRateLimit});
    if (relRes.ok && Array.isArray(relRes.data)) {
      for (const rel of relRes.data) {
        if (rel && typeof rel === 'object') {
          const u = (rel as Record<string, unknown>).user;
          if (u && typeof u === 'object' && this.matchesUsername(u as Record<string, unknown>, cleanName)) {
            const userObj = u as Record<string, unknown>;
            return {userId: String(userObj.id), source: 'relationships', user: userObj};
          }
        }
      }
    }

    const guildsRes = await this.request('GET', 'users/@me/guilds', {onRateLimit});
    if (guildsRes.ok && Array.isArray(guildsRes.data)) {
      for (const g of guildsRes.data) {
        if (!g || typeof g !== 'object') continue;
        const guildObj = g as Record<string, unknown>;
        const gid = String(guildObj.id ?? '');
        if (!/^\d+$/.test(gid)) continue;

        const qs = new URLSearchParams({query: baseQuery, limit: '10'}).toString();
        const searchRes = await this.request(
          'GET',
          `guilds/${encodeURIComponent(gid)}/members/search?${qs}`,
          {onRateLimit},
        );
        if (searchRes.ok && Array.isArray(searchRes.data)) {
          for (const member of searchRes.data) {
            if (member && typeof member === 'object') {
              const u = (member as Record<string, unknown>).user;
              if (u && typeof u === 'object' && this.matchesUsername(u as Record<string, unknown>, cleanName)) {
                const userObj = u as Record<string, unknown>;
                const guildName = String(guildObj.name ?? gid);
                return {userId: String(userObj.id), source: `guild:${guildName}`, user: userObj};
              }
            }
          }
        }
        await sleep(200);
      }
    }

    return null;
  }

  async lookupTarget(
    target: string,
    opts: LookupOptions,
    callbacks?: {
      onRateLimit?: (seconds: number) => void;
      onAccountAlert?: (reason: string) => void;
    },
  ): Promise<LookupResultEntry> {
    const query = target.trim();
    let uid = query;
    let resolvedFrom = 'user_id';
    let preResolvedUser: Record<string, unknown> = {};
    let preChannelId = '';
    const onRateLimit = callbacks?.onRateLimit;
    const onAccountAlert = callbacks?.onAccountAlert;

    if (!/^\d+$/.test(query)) {
      const resolved = await this.resolveUsernameToId(query, onRateLimit);
      if (!resolved) {
        return {
          query,
          id: '',
          status: 'failed',
          resolved_from: 'username_not_found',
          username: query,
          global_name: '',
          discriminator: '0',
          tag: query,
          bot: false,
          created_at: '',
          avatar: '',
          avatar_url: '',
          public_flags: 0,
          bio: '',
          pronouns: '',
          badges: [],
          connected_accounts: [],
          mutual_guilds: [],
          mutual_friends: [],
          dm_channel_id: '',
          message_count_sampled: 0,
          error: `Could not resolve username "${query}" in DMs, friends, or shared servers`,
          raw: {},
        };
      }
      uid = resolved.userId;
      resolvedFrom = resolved.source;
      preResolvedUser = resolved.user;
    }

    let dmRes = await this.request('POST', 'users/@me/channels', {
      body: {recipients: [uid]},
      headers: {
        'X-Context-Properties': buildContextProperties('Quickswitcher'),
        Referer: 'https://discord.com/channels/@me',
      },
      onRateLimit,
      onAccountAlert,
    });

    if (dmRes.fatalAccountAlert) {
      return {
        query,
        id: uid,
        status: 'failed',
        resolved_from: resolvedFrom,
        username: '',
        global_name: '',
        discriminator: '0',
        tag: '',
        bot: false,
        created_at: snowflakeToIso(uid),
        avatar: '',
        avatar_url: '',
        public_flags: 0,
        bio: '',
        pronouns: '',
        badges: [],
        connected_accounts: [],
        mutual_guilds: [],
        mutual_friends: [],
        dm_channel_id: '',
        message_count_sampled: 0,
        error: dmRes.fatalAccountAlert,
        raw: {},
      };
    }

    if (!dmRes.ok && /^\d+$/.test(query)) {
      const chRes = await this.request('GET', `channels/${encodeURIComponent(query)}`, {
        onRateLimit,
        onAccountAlert,
      });
      if (chRes.ok && chRes.data && typeof chRes.data === 'object') {
        const chData = chRes.data as Record<string, unknown>;
        const recipients = Array.isArray(chData.recipients) ? chData.recipients : [];
        if (recipients.length > 0 && recipients[0] && typeof recipients[0] === 'object') {
          const firstRec = recipients[0] as Record<string, unknown>;
          preChannelId = String(chData.id ?? query);
          uid = String(firstRec.id ?? '');
          preResolvedUser = firstRec;
          resolvedFrom = 'dm_channel_id';
          dmRes = chRes;
        }
      }
    }

    const dmData =
      dmRes.ok && dmRes.data && typeof dmRes.data === 'object'
        ? (dmRes.data as Record<string, unknown>)
        : {};
    const channelId = String(dmData.id ?? preChannelId ?? '');

    let recipientUser: Record<string, unknown> = {...preResolvedUser};
    if (Array.isArray(dmData.recipients)) {
      const found = (dmData.recipients as Record<string, unknown>[]).find(
        (r) => String(r?.id ?? '') === uid,
      );
      if (found) {
        recipientUser = found;
      } else if (dmData.recipients[0] && typeof dmData.recipients[0] === 'object') {
        recipientUser = dmData.recipients[0] as Record<string, unknown>;
      }
    }

    let supplementalData: unknown = null;
    if (opts.fetchSupplemental && channelId) {
      const suppQs = new URLSearchParams({channel_ids: channelId}).toString();
      const suppRes = await this.request(
        'GET',
        `users/@me/message-requests/supplemental-data?${suppQs}`,
        {
          headers: {Referer: `https://discord.com/channels/@me/${channelId}`},
          onRateLimit,
          onAccountAlert,
        },
      );
      if (suppRes.ok) supplementalData = suppRes.data;
    }

    let profileData: Record<string, unknown> = {};
    let profileError = '';
    if (opts.fetchProfile && /^\d+$/.test(uid)) {
      const profQs = new URLSearchParams({
        type: 'sidebar',
        with_mutual_guilds: String(opts.withMutualGuilds),
        with_mutual_friends: String(opts.withMutualFriends),
        with_mutual_friends_count: 'false',
      }).toString();

      const profRes = await this.request(
        'GET',
        `users/${encodeURIComponent(uid)}/profile?${profQs}`,
        {
          headers: {
            Referer: channelId
              ? `https://discord.com/channels/@me/${channelId}`
              : 'https://discord.com/channels/@me',
          },
          onRateLimit,
          onAccountAlert,
        },
      );

      if (profRes.ok && profRes.data && typeof profRes.data === 'object') {
        profileData = profRes.data as Record<string, unknown>;
      } else if (!profRes.ok) {
        profileError = `profile(${profRes.status}): ${profRes.error}`;
      }
    }

    let messages: unknown[] = [];
    if (opts.fetchMessages && channelId) {
      const limit = Math.min(Math.max(1, opts.messageLimit || 10), 100);
      const msgRes = await this.request(
        'GET',
        `channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`,
        {
          headers: {Referer: `https://discord.com/channels/@me/${channelId}`},
          onRateLimit,
          onAccountAlert,
        },
      );
      if (msgRes.ok && Array.isArray(msgRes.data)) {
        messages = msgRes.data;
      }
    }

    const profileUser =
      profileData.user && typeof profileData.user === 'object'
        ? (profileData.user as Record<string, unknown>)
        : {};
    const mergedUser = {...recipientUser, ...profileUser};

    const username = String(mergedUser.username ?? '');
    const globalName = typeof mergedUser.global_name === 'string' ? mergedUser.global_name : '';
    const discriminator = String(mergedUser.discriminator ?? '0');
    const tag = username && discriminator !== '0' ? `${username}#${discriminator}` : username;
    const avatarHash = typeof mergedUser.avatar === 'string' ? mergedUser.avatar : '';

    const userProfileMeta =
      profileData.user_profile && typeof profileData.user_profile === 'object'
        ? (profileData.user_profile as Record<string, unknown>)
        : {};

    const badges = Array.isArray(profileData.badges)
      ? profileData.badges
          .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === 'object'))
          .map((b) => String(b.id ?? b.description ?? ''))
          .filter(Boolean)
      : [];

    const connectedAccounts = Array.isArray(profileData.connected_accounts)
      ? profileData.connected_accounts
          .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
          .map((a) => `${String(a.type ?? '')}:${String(a.name ?? '')}`)
      : [];

    const mutualGuilds = Array.isArray(profileData.mutual_guilds)
      ? profileData.mutual_guilds
          .filter((g): g is Record<string, unknown> => Boolean(g && typeof g === 'object'))
          .map((g) => (g.nick ? `${String(g.id ?? '')}:${String(g.nick)}` : String(g.id ?? '')))
      : [];

    const mutualFriends = Array.isArray(profileData.mutual_friends)
      ? profileData.mutual_friends
          .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
          .map((f) => `${String(f.username ?? '')}(${String(f.id ?? '')})`)
      : [];

    const resolved = Boolean(username);
    const errors: string[] = [];
    if (!dmRes.ok && dmRes.error) {
      errors.push(`dm_channel(${dmRes.status}): ${dmRes.error}`);
    }
    if (profileError) {
      errors.push(profileError);
    }

    return {
      query,
      id: uid,
      status: resolved ? 'resolved' : 'failed',
      resolved_from: resolvedFrom,
      username,
      global_name: globalName,
      discriminator,
      tag,
      bot: Boolean(mergedUser.bot),
      created_at: snowflakeToIso(uid),
      avatar: avatarHash,
      avatar_url: resolved ? buildAvatarUrl(uid, avatarHash, discriminator) : '',
      public_flags: Number(mergedUser.public_flags ?? 0) || 0,
      bio: String(userProfileMeta.bio ?? ''),
      pronouns: String(userProfileMeta.pronouns ?? ''),
      badges,
      connected_accounts: connectedAccounts,
      mutual_guilds: mutualGuilds,
      mutual_friends: mutualFriends,
      dm_channel_id: channelId,
      message_count_sampled: messages.length,
      error: !resolved ? errors.join(' | ') || 'Lookup failed' : '',
      raw: {
        dm_channel: dmData,
        profile: profileData,
        supplemental_data: supplementalData,
        messages,
      },
    };
  }
}

export class LookupJobManager {
  private readonly jobs = new Map<string, LookupJob>();
  private readonly activeOwners = new Set<string>();
  private readonly activeTokens = new Set<string>();
  private readonly notifiedFinishedJobs = new Set<string>();
  private readonly exportsDir: string;
  private readonly quotaManager: QuotaManager;
  private readonly onJobFinished?: (job: LookupJob) => void;

  constructor(
    exportsDir: string,
    quotaManager: QuotaManager,
    options?: {onJobFinished?: (job: LookupJob) => void},
  ) {
    this.exportsDir = exportsDir;
    this.quotaManager = quotaManager;
    this.onJobFinished = options?.onJobFinished;
  }

  private notifyJobFinished(job: LookupJob): void {
    if (this.notifiedFinishedJobs.has(job.id)) return;
    this.notifiedFinishedJobs.add(job.id);
    this.onJobFinished?.(job);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.exportsDir, {recursive: true});
  }

  getJob(jobId: string): LookupJob | undefined {
    return this.jobs.get(jobId);
  }

  startJob(
    ownerKey: string,
    ownerHash: string,
    token: string,
    targets: string[],
    options: LookupOptions,
  ): {ok: true; job: LookupJob} | {ok: false; status: number; error: string} {
    if (this.activeOwners.has(ownerKey)) {
      return {
        ok: false,
        status: 409,
        error: 'You already have an active lookup job running. Wait for it to finish or stop it first.',
      };
    }

    const tokenDigest = hashToken(token);
    if (this.activeTokens.has(tokenDigest)) {
      return {
        ok: false,
        status: 409,
        error: 'This Discord token is already running another lookup job. Concurrent jobs are blocked to protect the account.',
      };
    }

    const quota = this.quotaManager.getQuota(ownerKey);
    if (quota.remaining <= 0) {
      return {
        ok: false,
        status: 429,
        error: `Free tier daily limit reached (${quota.limit}/${quota.limit} lookups used today). Resets at 00:00 UTC.`,
      };
    }

    let cappedTargets = targets;
    let quotaNote = '';
    if (targets.length > quota.remaining) {
      cappedTargets = targets.slice(0, quota.remaining);
      quotaNote = `Free tier limit (${quota.limit}/day): capped batch from ${targets.length} to ${quota.remaining} remaining lookups today.`;
    }

    const safeDelayMs = Math.max(MIN_SAFE_DELAY_MS, options.delayMs || MIN_SAFE_DELAY_MS);
    const safeOptions: LookupOptions = {
      ...options,
      delayMs: safeDelayMs,
    };

    const id = crypto.randomUUID();
    const job: LookupJob = {
      id,
      ownerKey,
      ownerHash,
      status: 'running',
      label: safeOptions.label || 'usernames',
      targets: cappedTargets,
      currentIndex: 0,
      total: cappedTargets.length,
      resolvedCount: 0,
      failedCount: 0,
      currentTarget: cappedTargets[0] ?? '',
      rateLimitNote: '',
      quotaNote,
      haltReason: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      options: safeOptions,
      results: [],
      savedFiles: {csv: null, json: null},
    };

    this.jobs.set(id, job);
    this.activeOwners.add(ownerKey);
    this.activeTokens.add(tokenDigest);
    void this.runLoop(job, token, tokenDigest);
    return {ok: true, job};
  }

  pauseJob(jobId: string): LookupJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'running') {
      job.status = 'paused';
    }
    return job;
  }

  resumeJob(jobId: string): LookupJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'paused') {
      job.status = 'running';
    }
    return job;
  }

  async stopJob(jobId: string): Promise<LookupJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'running' || job.status === 'paused') {
      job.status = 'stopped';
      job.finishedAt = new Date().toISOString();
      if (job.results.length > 0 && !job.savedFiles.csv) {
        await this.persistExportFiles(job);
      }
    }
    return job;
  }

  private async runLoop(job: LookupJob, token: string, tokenDigest: string): Promise<void> {
    const client = new DiscordApiClient(token);
    const getStatus = (): JobStatus => job.status;

    try {
      while (job.currentIndex < job.targets.length) {
        if (getStatus() === 'stopped') break;

        while (getStatus() === 'paused') {
          await sleep(250);
          if (getStatus() === 'stopped') break;
        }
        if (getStatus() === 'stopped') break;

        const consumed = await this.quotaManager.consumeOne(job.ownerKey);
        if (!consumed.allowed) {
          job.haltReason = `Daily free tier limit reached (${consumed.quota.limit}/${consumed.quota.limit} lookups used today).`;
          job.status = 'stopped';
          break;
        }

        const target = job.targets[job.currentIndex];
        job.currentTarget = target;
        job.rateLimitNote = '';

        let fatalAlert = '';
        const entry = await client.lookupTarget(target, job.options, {
          onRateLimit: (sec) => {
            job.rateLimitNote = `Discord rate limit — cooling down ${sec.toFixed(1)}s`;
          },
          onAccountAlert: (reason) => {
            fatalAlert = reason;
          },
        });

        job.rateLimitNote = '';
        job.results.push(entry);
        if (entry.status === 'resolved') {
          job.resolvedCount += 1;
        } else {
          job.failedCount += 1;
        }
        job.currentIndex += 1;

        if (fatalAlert) {
          job.haltReason = fatalAlert;
          job.status = 'stopped';
          break;
        }

        if (job.currentIndex < job.targets.length) {
          const jitterMs = 250 + Math.floor(Math.random() * 600);
          const totalDelay = job.options.delayMs + jitterMs;
          const steps = Math.max(1, Math.ceil(totalDelay / 200));
          for (let s = 0; s < steps; s++) {
            if (getStatus() !== 'running') break;
            await sleep(Math.min(200, totalDelay));
          }
        }
      }

      if (getStatus() !== 'stopped') {
        job.status = 'completed';
      }
      job.currentTarget = '';
      job.finishedAt = new Date().toISOString();
      if (job.results.length > 0) {
        await this.persistExportFiles(job);
      }
      this.notifyJobFinished(job);
    } catch {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      if (job.results.length > 0) {
        await this.persistExportFiles(job);
      }
      this.notifyJobFinished(job);
    } finally {
      this.activeOwners.delete(job.ownerKey);
      this.activeTokens.delete(tokenDigest);
    }
  }

  async persistExportFiles(job: LookupJob): Promise<{csv: string; json: string}> {
    await this.init();
    const ownerDir = path.resolve(this.exportsDir, job.ownerHash);
    if (!ownerDir.startsWith(this.exportsDir + path.sep)) {
      throw new Error('Invalid owner export directory');
    }
    await fs.mkdir(ownerDir, {recursive: true});

    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const safeLabel = job.label.replace(/[^a-zA-Z0-9_-]/g, '') || 'lookup';
    const baseName = `lookup_${safeLabel}_${stamp}_${job.id.slice(0, 6)}`;

    const jsonFilename = `${baseName}.json`;
    const csvFilename = `${baseName}.csv`;

    const jsonPayload = {
      metadata: {
        job_id: job.id,
        label: safeLabel,
        status: job.status,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        total_requested: job.total,
        total_resolved: job.resolvedCount,
        total_failed: job.failedCount,
      },
      results: job.results,
    };

    const jsonPath = path.resolve(ownerDir, jsonFilename);
    await fs.writeFile(jsonPath, JSON.stringify(jsonPayload, null, 2), 'utf8');

    const headers = [
      'query',
      'id',
      'status',
      'resolved_from',
      'username',
      'global_name',
      'discriminator',
      'tag',
      'bot',
      'created_at',
      'avatar',
      'avatar_url',
      'public_flags',
      'bio',
      'pronouns',
      'badges',
      'connected_accounts',
      'mutual_guilds',
      'mutual_friends',
      'dm_channel_id',
      'error',
    ];

    const lines = [headers.map(csvCell).join(',')];
    for (const r of job.results) {
      lines.push(
        [
          r.query,
          r.id,
          r.status,
          r.resolved_from,
          r.username,
          r.global_name,
          r.discriminator,
          r.tag,
          r.bot,
          r.created_at,
          r.avatar,
          r.avatar_url,
          r.public_flags,
          r.bio,
          r.pronouns,
          r.badges.join(','),
          r.connected_accounts.join(','),
          r.mutual_guilds.join(','),
          r.mutual_friends.join(','),
          r.dm_channel_id,
          r.error,
        ]
          .map(csvCell)
          .join(','),
      );
    }

    const csvPath = path.resolve(ownerDir, csvFilename);
    await fs.writeFile(csvPath, lines.join('\n'), 'utf8');

    job.savedFiles = {csv: csvFilename, json: jsonFilename};
    return {csv: csvFilename, json: jsonFilename};
  }
}
