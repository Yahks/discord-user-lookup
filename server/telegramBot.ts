import fs from 'node:fs/promises';
import path from 'node:path';
import type {ActivityEvent, ActivityTracker, TrackedUser} from './activityTracker.ts';
import {
  DiscordApiClient,
  type LookupJob,
  type LookupJobManager,
  type LookupOptions,
  type VerifiedAccount,
} from './discordLookup.ts';
import type {QuotaManager} from './quota.ts';
import {hashOwnerKey} from './security.ts';

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface ChatSession {
  discordToken: string;
  account: VerifiedAccount | null;
  awaitingToken: boolean;
  activeJobId: string | null;
}

export interface TelegramBotStatus {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  botName: string | null;
  miniAppUrl: string | null;
  restrictedToAllowlist: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTargetsText(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const clean = part.trim().replace(/^"|"$/g, '');
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
    if (out.length >= 500) break;
  }
  return out;
}

function parseCsvTargets(rawText: string): string[] {
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map((s) => s.trim().toLowerCase().replace(/^"|"$/g, ''));
  const colIdx = headers.findIndex((h) => ['username', 'id', 'user_id', 'target', 'query'].includes(h));

  if (colIdx !== -1 && lines.length > 1) {
    const items: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const val = (cols[colIdx] ?? '').trim().replace(/^"|"$/g, '');
      if (val) items.push(val);
    }
    return parseTargetsText(items.join('\n'));
  }
  return parseTargetsText(rawText);
}

export class TelegramBotRunner {
  private readonly botToken: string;
  private readonly jobManager: LookupJobManager;
  private readonly quotaManager: QuotaManager;
  private readonly activityTracker: ActivityTracker;
  private readonly exportsDir: string;
  private readonly allowedUserIds: Set<number>;
  private readonly adminUserIds: Set<number>;
  private readonly adminAlertsEnabled: boolean;
  private readonly sessions = new Map<number, ChatSession>();
  private readonly jobOwners = new Map<string, number>();

  private running = false;
  private offset = 0;
  private botUsername: string | null = null;
  private botName: string | null = null;
  private unsubscribeActivity: (() => void) | null = null;

  constructor(options: {
    botToken: string;
    jobManager: LookupJobManager;
    quotaManager: QuotaManager;
    activityTracker: ActivityTracker;
    exportsDir: string;
    allowedUserIds?: number[];
    adminUserIds?: number[];
    adminAlertsEnabled?: boolean;
  }) {
    this.botToken = options.botToken.trim();
    this.jobManager = options.jobManager;
    this.quotaManager = options.quotaManager;
    this.activityTracker = options.activityTracker;
    this.exportsDir = options.exportsDir;
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
    this.adminUserIds = new Set(options.adminUserIds ?? []);
    this.adminAlertsEnabled = options.adminAlertsEnabled !== false;
  }

  private getMiniAppUrl(): string | null {
    const explicit = (process.env.TELEGRAM_MINI_APP_URL || '').trim();
    const fallback = (process.env.APP_URL || '').trim();
    const candidate = explicit || fallback;
    if (!candidate || candidate === 'MY_APP_URL') return null;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:') return null;
      // Do not send public Telegram users to private ais-dev preview URLs gated by Google login
      if (!explicit && parsed.hostname.startsWith('ais-dev-')) {
        return null;
      }
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  getStatus(): TelegramBotStatus {
    return {
      configured: Boolean(this.botToken),
      running: this.running,
      botUsername: this.botUsername,
      botName: this.botName,
      miniAppUrl: this.getMiniAppUrl(),
      restrictedToAllowlist: this.allowedUserIds.size > 0,
    };
  }

  private async tgApi<T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
  ): Promise<{ok: boolean; result?: T; description?: string}> {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload ?? {}),
    });
    const data = (await resp.json()) as {ok: boolean; result?: T; description?: string};
    return data;
  }

  private async sendDocument(chatId: number, filePath: string, caption?: string): Promise<void> {
    const bytes = await fs.readFile(filePath);
    const filename = path.basename(filePath);
    await this.sendDocumentBuffer(chatId, filename, bytes, caption);
  }

  private async sendDocumentBuffer(
    chatId: number,
    filename: string,
    content: Uint8Array | string,
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
    }
    const mime = filename.endsWith('.csv') ? 'text/csv' : 'application/json';
    const blobBytes = typeof content === 'string' ? content : Uint8Array.from(content);
    form.append('document', new Blob([blobBytes], {type: mime}), filename);

    await fetch(`https://api.telegram.org/bot${this.botToken}/sendDocument`, {
      method: 'POST',
      body: form,
    });
  }

  private getOrCreateSession(chatId: number): ChatSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        discordToken: '',
        account: null,
        awaitingToken: false,
        activeJobId: null,
      };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  private isAuthorized(userId?: number): boolean {
    if (this.allowedUserIds.size === 0) return true;
    return typeof userId === 'number' && this.allowedUserIds.has(userId);
  }

  private isAdmin(userId?: number): boolean {
    return typeof userId === 'number' && this.adminUserIds.has(userId);
  }

  private formatActorLabel(event: ActivityEvent): string {
    const uname = event.telegramUsername ? `@${event.telegramUsername}` : '';
    const name = event.firstName || '';
    const idPart = event.telegramUserId ? String(event.telegramUserId) : event.ownerKey;
    return [name, uname, `(${idPart})`].filter(Boolean).join(' ');
  }

  private async notifyAdminsForEvent(
    event: ActivityEvent,
    _user: TrackedUser,
    isNewUser: boolean,
  ): Promise<void> {
    if (!this.running || !this.adminAlertsEnabled || this.adminUserIds.size === 0) return;

    const alertActions = new Set([
      'token_verified',
      'lookup_started',
      'lookup_completed',
      'lookup_halted',
      'quota_blocked',
      'unauthorized_access',
      'rate_limited',
    ]);

    if (!isNewUser && !alertActions.has(event.action)) return;

    const prefix = isNewUser ? '[NEW USER]' : `[${event.action.toUpperCase()}]`;
    const sample =
      event.targetsSample && event.targetsSample.length > 0
        ? `\nTargets: ${event.targetsSample.join(', ')}${(event.targetsCount ?? 0) > event.targetsSample.length ? ' ...' : ''}`
        : '';
    const text =
      `${prefix} ${this.formatActorLabel(event)}\n` +
      `Channel: ${event.channel}\n` +
      `${event.details}${sample}`;

    for (const adminId of this.adminUserIds) {
      if (event.telegramUserId === adminId) continue;
      void this.tgApi('sendMessage', {
        chat_id: adminId,
        text,
      }).catch(() => undefined);
    }
  }

  private trackBotEvent(
    chatId: number,
    user: TelegramUser | undefined,
    action: string,
    details: string,
    extra?: {
      discordAccountId?: string;
      discordUsername?: string;
      targetsCount?: number;
      targetsSample?: string[];
      increments?: {
        jobsStarted?: number;
        exportsDownloaded?: number;
        blocked?: number;
      };
    },
  ): void {
    const {ownerKey, ownerHash} = this.getOwnerKey(chatId, user?.id);
    this.activityTracker.record({
      ownerKey,
      ownerHash,
      channel: 'telegram_bot',
      telegramUserId: user?.id,
      telegramUsername: user?.username,
      firstName: user?.first_name,
      discordAccountId: extra?.discordAccountId,
      discordUsername: extra?.discordUsername,
      action,
      details,
      targetsCount: extra?.targetsCount,
      targetsSample: extra?.targetsSample,
      increments: extra?.increments,
    });
  }

  async start(): Promise<void> {
    if (!this.botToken || this.running) return;

    try {
      const me = await this.tgApi<{username?: string; first_name?: string}>('getMe');
      if (!me.ok || !me.result) {
        console.warn('Telegram Bot: failed to verify TELEGRAM_BOT_TOKEN via getMe.');
        return;
      }
      this.botUsername = me.result.username ?? null;
      this.botName = me.result.first_name ?? null;

      const publicCommands = [
        {command: 'start', description: 'Show welcome guide and Mini App link'},
        {command: 'settoken', description: 'Set & verify your Discord token'},
        {command: 'lookup', description: 'Look up usernames, User IDs, or DM IDs'},
        {command: 'quota', description: 'Check your 50/day free-tier lookup quota'},
        {command: 'pause', description: 'Pause the active lookup job'},
        {command: 'continue', description: 'Continue a paused lookup job'},
        {command: 'stop', description: 'Stop job and export CSV & JSON'},
        {command: 'clear', description: 'Clear your token from bot memory'},
        {command: 'whoami', description: 'Show your Telegram ID and session info'},
      ];

      // Ensure polling works even if a webhook was previously attached
      await this.tgApi('deleteWebhook', {drop_pending_updates: false});
      await this.tgApi('setMyCommands', {commands: publicCommands});

      for (const adminId of this.adminUserIds) {
        await this.tgApi('setMyCommands', {
          scope: {type: 'chat', chat_id: adminId},
          commands: [
            ...publicCommands,
            {command: 'users', description: '[Admin] List all tracked users'},
            {command: 'activity', description: '[Admin] View recent user actions'},
            {command: 'user', description: '[Admin] Inspect a user by ID or @username'},
            {command: 'exportlogs', description: '[Admin] Download CSV & JSON activity logs'},
          ],
        }).catch(() => undefined);
      }

      this.unsubscribeActivity = this.activityTracker.onEvent((event, user, isNewUser) => {
        void this.notifyAdminsForEvent(event, user, isNewUser);
      });

      this.running = true;
      console.log(
        `Telegram Bot active${this.botUsername ? ` as @${this.botUsername}` : ''}`,
      );
      void this.pollLoop();
    } catch {
      console.warn('Telegram Bot: could not connect to Telegram Bot API.');
    }
  }

  stop(): void {
    this.running = false;
    this.unsubscribeActivity?.();
    this.unsubscribeActivity = null;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.tgApi<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });

        if (res.ok && Array.isArray(res.result)) {
          for (const update of res.result) {
            this.offset = Math.max(this.offset, update.update_id + 1);
            await this.handleUpdate(update);
          }
        } else {
          await sleep(3000);
        }
      } catch {
        await sleep(3000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  private buildJobKeyboard(job: LookupJob): Record<string, unknown> | undefined {
    if (job.status === 'running') {
      return {
        inline_keyboard: [
          [
            {text: 'Pause', callback_data: `pause:${job.id}`},
            {text: 'Stop & Save', callback_data: `stop:${job.id}`},
          ],
        ],
      };
    }
    if (job.status === 'paused') {
      return {
        inline_keyboard: [
          [
            {text: 'Continue', callback_data: `resume:${job.id}`},
            {text: 'Stop & Save', callback_data: `stop:${job.id}`},
          ],
        ],
      };
    }
    return undefined;
  }

  private formatJobProgress(job: LookupJob): string {
    const pct = job.total > 0 ? Math.round((job.currentIndex / job.total) * 100) : 0;
    const lines = [
      `Lookup Job: ${job.status.toUpperCase()}`,
      `Processed: ${job.currentIndex} / ${job.total} (${pct}%)`,
      `Resolved: ${job.resolvedCount} | Failed: ${job.failedCount}`,
    ];
    if (job.quotaNote) {
      lines.push(job.quotaNote);
    }
    if (job.currentTarget && job.status === 'running') {
      lines.push(`Current target: ${job.currentTarget}`);
    }
    if (job.rateLimitNote) {
      lines.push(job.rateLimitNote);
    }
    if (job.haltReason) {
      lines.push(`Notice: ${job.haltReason}`);
    }
    return lines.join('\n');
  }

  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    const chatId = cb.message?.chat.id;
    const messageId = cb.message?.message_id;
    if (!chatId || !messageId || !cb.data) {
      await this.tgApi('answerCallbackQuery', {callback_query_id: cb.id});
      return;
    }

    if (!this.isAuthorized(cb.from.id)) {
      this.trackBotEvent(
        chatId,
        cb.from,
        'unauthorized_access',
        `Blocked inline action (${cb.data})`,
        {increments: {blocked: 1}},
      );
      await this.tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Unauthorized Telegram user.',
        show_alert: true,
      });
      return;
    }

    const [action, jobId] = cb.data.split(':', 2);
    if (!jobId || this.jobOwners.get(jobId) !== chatId) {
      await this.tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Job not found for this chat.',
      });
      return;
    }

    let updated: LookupJob | null = null;
    if (action === 'pause') {
      updated = this.jobManager.pauseJob(jobId);
      if (updated) this.trackBotEvent(chatId, cb.from, 'lookup_paused', `Paused job ${jobId.slice(0, 8)} at ${updated.currentIndex}/${updated.total}`);
    }
    if (action === 'resume') {
      updated = this.jobManager.resumeJob(jobId);
      if (updated) this.trackBotEvent(chatId, cb.from, 'lookup_resumed', `Resumed job ${jobId.slice(0, 8)} at ${updated.currentIndex}/${updated.total}`);
    }
    if (action === 'stop') {
      updated = await this.jobManager.stopJob(jobId);
      if (updated) this.trackBotEvent(chatId, cb.from, 'lookup_stopped', `Stopped job ${jobId.slice(0, 8)} at ${updated.currentIndex}/${updated.total}`);
    }

    await this.tgApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: updated ? `Status: ${updated.status}` : 'Job finished.',
    });

    if (updated) {
      await this.tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: this.formatJobProgress(updated),
        reply_markup: this.buildJobKeyboard(updated),
      });
    }
  }

  private getOwnerKey(chatId: number, userId?: number): {ownerKey: string; ownerHash: string} {
    const ownerKey = `tg:${userId ?? chatId}`;
    return {ownerKey, ownerHash: hashOwnerKey(ownerKey)};
  }

  private async sendWelcome(chatId: number, userId?: number): Promise<void> {
    const miniAppUrl = this.getMiniAppUrl();
    const {ownerKey} = this.getOwnerKey(chatId, userId);
    const quota = this.quotaManager.getQuota(ownerKey);
    const lines = [
      'LookupDesk Bot Ready',
      `Free Tier Quota: ${quota.remaining}/${quota.limit} lookups remaining today`,
      '',
      'Commands:',
      '/settoken <TOKEN> — Verify and save your Discord token in session memory',
      '/lookup <targets> — Look up usernames, User IDs, or DM channel IDs',
      '/quota — Check remaining daily free-tier lookups (50/day)',
      '/pause | /continue | /stop — Control an active batch lookup',
      '/clear — Remove your token from bot memory',
      '',
      'You can also upload a .txt or .csv file of targets directly to this chat.',
      'Completed lookups automatically export and send both CSV and JSON files here.',
    ];

    const replyMarkup = miniAppUrl
      ? {
          inline_keyboard: [
            [{text: 'Open LookupDesk Panel', web_app: {url: miniAppUrl}}],
          ],
        }
      : undefined;

    await this.tgApi('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      reply_markup: replyMarkup,
    });
  }

  private async verifyAndSaveToken(
    chatId: number,
    messageId: number,
    rawToken: string,
    user?: TelegramUser,
  ): Promise<void> {
    const session = this.getOrCreateSession(chatId);
    session.awaitingToken = false;

    // Best-effort removal of user's message containing their token
    await this.tgApi('deleteMessage', {chat_id: chatId, message_id: messageId}).catch(() => undefined);

    const token = rawToken.trim();
    if (!token || token.length > 500) {
      this.trackBotEvent(chatId, user, 'token_verify_failed', 'Submitted malformed token');
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Invalid token format. Use /settoken <DISCORD_TOKEN>.',
      });
      return;
    }

    const client = new DiscordApiClient(token);
    const verified = await client.verifyToken();
    if (!verified.ok || !verified.account) {
      this.trackBotEvent(
        chatId,
        user,
        'token_verify_failed',
        `Token rejected: ${verified.error || 'Unauthorized'}`,
      );
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: `Token verification failed: ${verified.error || 'Unauthorized'}`,
      });
      return;
    }

    session.discordToken = token;
    session.account = verified.account;
    this.trackBotEvent(
      chatId,
      user,
      'token_verified',
      `Verified Discord @${verified.account.username} (${verified.account.id})`,
      {
        discordAccountId: verified.account.id,
        discordUsername: verified.account.username,
      },
    );
    await this.tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `Token verified for @${verified.account.username} (${verified.account.id}).\n` +
        'Send /lookup <username_or_id> or upload a .txt / .csv file to start.',
    });
  }

  private async startLookupForChat(
    chatId: number,
    targets: string[],
    user?: TelegramUser,
  ): Promise<void> {
    const session = this.getOrCreateSession(chatId);
    if (!session.discordToken) {
      this.trackBotEvent(chatId, user, 'lookup_rejected', 'Tried lookup without verified token');
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Set your Discord token first using /settoken <DISCORD_TOKEN>.',
      });
      return;
    }

    if (session.activeJobId) {
      const existing = this.jobManager.getJob(session.activeJobId);
      if (existing && (existing.status === 'running' || existing.status === 'paused')) {
        await this.tgApi('sendMessage', {
          chat_id: chatId,
          text: 'A lookup job is already active. Use /pause, /continue, or /stop first.',
        });
        return;
      }
    }

    if (targets.length === 0) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'No targets found. Example: /lookup 227540255362777088 some_username',
      });
      return;
    }

    const {ownerKey, ownerHash} = this.getOwnerKey(chatId, user?.id);
    const options: LookupOptions = {
      fetchProfile: true,
      fetchSupplemental: true,
      fetchMessages: false,
      messageLimit: 10,
      withMutualGuilds: true,
      withMutualFriends: true,
      delayMs: 1500,
      label: `tg_${ownerHash.slice(0, 8)}`,
    };

    const started = this.jobManager.startJob(
      ownerKey,
      ownerHash,
      session.discordToken,
      targets,
      options,
    );

    if (!started.ok) {
      const action = started.status === 429 ? 'quota_blocked' : 'lookup_rejected';
      this.trackBotEvent(chatId, user, action, started.error, {
        targetsCount: targets.length,
        targetsSample: targets.slice(0, 5),
        increments: started.status === 429 ? {blocked: 1} : undefined,
      });
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: started.error,
      });
      return;
    }

    const job = started.job;
    session.activeJobId = job.id;
    this.jobOwners.set(job.id, chatId);

    this.trackBotEvent(
      chatId,
      user,
      'lookup_started',
      `Started lookup batch (${job.total} target${job.total === 1 ? '' : 's'})`,
      {
        targetsCount: job.total,
        targetsSample: job.targets.slice(0, 5),
        increments: {jobsStarted: 1},
      },
    );

    const sent = await this.tgApi<{message_id: number}>('sendMessage', {
      chat_id: chatId,
      text: this.formatJobProgress(job),
      reply_markup: this.buildJobKeyboard(job),
    });

    const statusMsgId = sent.result?.message_id;
    void this.monitorJobAndDeliverExports(chatId, job.id, ownerKey, ownerHash, user, statusMsgId);
  }

  private async monitorJobAndDeliverExports(
    chatId: number,
    jobId: string,
    ownerKey: string,
    ownerHash: string,
    user?: TelegramUser,
    statusMsgId?: number,
  ): Promise<void> {
    let lastRender = '';

    while (this.running) {
      const job = this.jobManager.getJob(jobId);
      if (!job) break;

      const rendered = this.formatJobProgress(job);
      if (statusMsgId && rendered !== lastRender) {
        lastRender = rendered;
        await this.tgApi('editMessageText', {
          chat_id: chatId,
          message_id: statusMsgId,
          text: rendered,
          reply_markup: this.buildJobKeyboard(job),
        }).catch(() => undefined);
      }

      if (job.status === 'completed' || job.status === 'stopped' || job.status === 'failed') {
        const ownerDir = path.resolve(this.exportsDir, ownerHash);
        const quota = this.quotaManager.getQuota(ownerKey);
        if (job.savedFiles.csv && job.savedFiles.json && ownerDir.startsWith(this.exportsDir + path.sep)) {
          const csvPath = path.resolve(ownerDir, job.savedFiles.csv);
          const jsonPath = path.resolve(ownerDir, job.savedFiles.json);
          if (csvPath.startsWith(ownerDir + path.sep)) {
            await this.sendDocument(
              chatId,
              csvPath,
              `CSV Export (${job.resolvedCount}/${job.total} resolved) · ${quota.remaining}/${quota.limit} daily lookups left`,
            ).catch(() => undefined);
          }
          if (jsonPath.startsWith(ownerDir + path.sep)) {
            await this.sendDocument(chatId, jsonPath, 'Full JSON Export').catch(() => undefined);
          }
          this.trackBotEvent(
            chatId,
            user,
            'export_delivered',
            `Delivered CSV & JSON exports (${job.savedFiles.csv})`,
            {increments: {exportsDownloaded: 1}},
          );
        }
        break;
      }

      await sleep(1400);
    }
  }

  private async handleDocumentUpload(
    chatId: number,
    doc: TelegramDocument,
    user?: TelegramUser,
  ): Promise<void> {
    const filename = (doc.file_name || '').toLowerCase();
    if (!filename.endsWith('.txt') && !filename.endsWith('.csv')) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Only .txt and .csv target lists are supported.',
      });
      return;
    }

    if (typeof doc.file_size === 'number' && doc.file_size > 512 * 1024) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'File too large (512 KB maximum).',
      });
      return;
    }

    const fileMeta = await this.tgApi<{file_path?: string}>('getFile', {file_id: doc.file_id});
    const filePath = fileMeta.result?.file_path;
    if (!fileMeta.ok || !filePath) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Could not retrieve uploaded file from Telegram.',
      });
      return;
    }

    const fileResp = await fetch(
      `https://api.telegram.org/file/bot${this.botToken}/${filePath}`,
    );
    if (!fileResp.ok) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Failed downloading uploaded file.',
      });
      return;
    }

    const content = await fileResp.text();
    const targets = filename.endsWith('.csv')
      ? parseCsvTargets(content)
      : parseTargetsText(content);

    this.trackBotEvent(
      chatId,
      user,
      'file_uploaded',
      `Uploaded ${doc.file_name || 'target-list'} (${targets.length} unique target${targets.length === 1 ? '' : 's'})`,
      {targetsCount: targets.length, targetsSample: targets.slice(0, 5)},
    );

    await this.startLookupForChat(chatId, targets, user);
  }

  private async handleAdminCommand(
    chatId: number,
    text: string,
    user?: TelegramUser,
  ): Promise<boolean> {
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
    if (!['/users', '/activity', '/user', '/exportlogs'].includes(cmd)) {
      return false;
    }

    if (!this.isAdmin(user?.id)) {
      this.trackBotEvent(
        chatId,
        user,
        'unauthorized_access',
        `Attempted admin command ${cmd}`,
        {increments: {blocked: 1}},
      );
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Admin access required. Add your Telegram ID from /whoami to TELEGRAM_ADMIN_USER_IDS.',
      });
      return true;
    }

    if (cmd === '/users') {
      const summary = this.activityTracker.getSummary(this.quotaManager, 20);
      const header = `Tracked Users: ${summary.totalUsers} (Active today: ${summary.activeToday})`;
      if (summary.users.length === 0) {
        await this.tgApi('sendMessage', {chat_id: chatId, text: `${header}\nNo users recorded yet.`});
        return true;
      }

      const lines = [header, ''];
      for (const u of summary.users.slice(0, 20)) {
        const label =
          [u.firstName, u.telegramUsername ? `@${u.telegramUsername}` : '']
            .filter(Boolean)
            .join(' ') || u.ownerKey;
        const idTag = u.telegramUserId ? `id:${u.telegramUserId}` : u.ownerKey;
        lines.push(
          `• ${label} (${idTag}) [${u.channel}]\n` +
            `  Quota: ${u.quota.used}/${u.quota.limit} today | Lookups: ${u.totalLookupsResolved}/${u.totalLookupsProcessed} ok | Actions: ${u.totalActions}\n` +
            `  Last: ${u.lastAction} (${u.lastSeenAt.slice(0, 16).replace('T', ' ')})`,
        );
      }
      await this.tgApi('sendMessage', {chat_id: chatId, text: lines.join('\n').slice(0, 4000)});
      return true;
    }

    if (cmd === '/activity') {
      const arg = Number(text.split(/\s+/)[1] || '15');
      const limit = Number.isFinite(arg) ? Math.min(Math.max(1, arg), 30) : 15;
      const summary = this.activityTracker.getSummary(this.quotaManager, limit);
      if (summary.events.length === 0) {
        await this.tgApi('sendMessage', {chat_id: chatId, text: 'No user activity logged yet.'});
        return true;
      }
      const lines = [`Recent Activity (${summary.events.length} of ${summary.totalEvents}):`, ''];
      for (const ev of summary.events) {
        const stamp = ev.timestamp.slice(5, 19).replace('T', ' ');
        lines.push(
          `[${stamp}] ${this.formatActorLabel(ev)} [${ev.channel}] -> ${ev.action}: ${ev.details}`,
        );
      }
      await this.tgApi('sendMessage', {chat_id: chatId, text: lines.join('\n').slice(0, 4000)});
      return true;
    }

    if (cmd === '/user') {
      const query = text.replace(/^\/user(@\w+)?/i, '').trim();
      if (!query) {
        await this.tgApi('sendMessage', {
          chat_id: chatId,
          text: 'Usage: /user <telegram_id_or_@username>',
        });
        return true;
      }
      const detail = this.activityTracker.getUserDetail(query, this.quotaManager, 12);
      if (!detail) {
        await this.tgApi('sendMessage', {
          chat_id: chatId,
          text: `No tracked user matching "${query}".`,
        });
        return true;
      }
      const {user: u, quota, events} = detail;
      const lines = [
        `User Report: ${u.firstName || ''} ${u.telegramUsername ? `@${u.telegramUsername}` : ''} (${u.ownerKey})`,
        `Channel: ${u.channel} | First seen: ${u.firstSeenAt.slice(0, 16).replace('T', ' ')}`,
        `Discord linked: ${u.discordUsername ? `@${u.discordUsername} (${u.discordAccountId})` : 'None'}`,
        `Today's Quota: ${quota.used}/${quota.limit} (${quota.remaining} left)`,
        `Totals: ${u.totalActions} actions | ${u.totalJobsStarted} jobs | ${u.totalLookupsResolved}/${u.totalLookupsProcessed} resolved | ${u.totalExportsDownloaded} exports | ${u.blockedCount} blocked`,
        '',
        'Recent Actions:',
        ...events.map(
          (ev) =>
            `• [${ev.timestamp.slice(5, 19).replace('T', ' ')}] ${ev.action}: ${ev.details}`,
        ),
      ];
      await this.tgApi('sendMessage', {chat_id: chatId, text: lines.join('\n').slice(0, 4000)});
      return true;
    }

    if (cmd === '/exportlogs') {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
      const csvContent = this.activityTracker.buildExportCsv(this.quotaManager);
      const jsonContent = this.activityTracker.buildExportJson(this.quotaManager);
      await this.sendDocumentBuffer(
        chatId,
        `activity_report_${stamp}.csv`,
        csvContent,
        'User Activity Report (CSV)',
      );
      await this.sendDocumentBuffer(
        chatId,
        `activity_report_${stamp}.json`,
        jsonContent,
        'User Activity Report (JSON)',
      );
      return true;
    }

    return false;
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const user = msg.from;
    const userId = user?.id;

    if (!this.isAuthorized(userId)) {
      this.trackBotEvent(
        chatId,
        user,
        'unauthorized_access',
        `Blocked non-allowlisted user (${userId ?? chatId})`,
        {increments: {blocked: 1}},
      );
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Access restricted. Your Telegram user ID is not in TELEGRAM_ALLOWED_USER_IDS.',
      });
      return;
    }

    const session = this.getOrCreateSession(chatId);
    const text = (msg.text || '').trim();

    if (msg.document) {
      await this.handleDocumentUpload(chatId, msg.document, user);
      return;
    }

    if (!text) return;

    if (await this.handleAdminCommand(chatId, text, user)) {
      return;
    }

    if (text.startsWith('/whoami')) {
      this.trackBotEvent(chatId, user, 'whoami_checked', 'Checked Telegram user ID');
      const {ownerHash} = this.getOwnerKey(chatId, userId);
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `Telegram User ID: ${userId ?? chatId}\n` +
          `Username: ${user?.username ? `@${user.username}` : 'None'}\n` +
          `Role: ${this.isAdmin(userId) ? 'Admin' : 'Standard User'}\n` +
          `Workspace Scope: ${ownerHash}`,
      });
      return;
    }

    if (text.startsWith('/start') || text.startsWith('/help')) {
      session.awaitingToken = false;
      this.trackBotEvent(chatId, user, 'bot_start', 'Opened bot welcome/help');
      await this.sendWelcome(chatId, userId);
      return;
    }

    if (text.startsWith('/quota')) {
      const {ownerKey} = this.getOwnerKey(chatId, userId);
      const q = this.quotaManager.getQuota(ownerKey);
      this.trackBotEvent(chatId, user, 'quota_checked', `Checked quota (${q.used}/${q.limit} used)`);
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text:
          `Free Tier Daily Quota:\n` +
          `Used today: ${q.used} / ${q.limit}\n` +
          `Remaining: ${q.remaining}\n` +
          `Resets at: 00:00 UTC`,
      });
      return;
    }

    if (text.startsWith('/clear')) {
      session.discordToken = '';
      session.account = null;
      session.awaitingToken = false;
      this.trackBotEvent(chatId, user, 'token_cleared', 'Cleared Discord token from session');
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Discord token cleared from this chat session.',
      });
      return;
    }

    if (text.startsWith('/settoken')) {
      const arg = text.replace(/^\/settoken(@\w+)?/i, '').trim();
      if (!arg) {
        session.awaitingToken = true;
        await this.tgApi('sendMessage', {
          chat_id: chatId,
          text: 'Reply with your Discord authorization token now (your message will be deleted immediately after verification).',
        });
        return;
      }
      await this.verifyAndSaveToken(chatId, msg.message_id, arg, user);
      return;
    }

    if (text.startsWith('/pause')) {
      const job = session.activeJobId ? this.jobManager.pauseJob(session.activeJobId) : null;
      if (job) {
        this.trackBotEvent(chatId, user, 'lookup_paused', `Paused job ${job.id.slice(0, 8)} at ${job.currentIndex}/${job.total}`);
      }
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: job ? `Job paused at ${job.currentIndex}/${job.total}.` : 'No active job to pause.',
      });
      return;
    }

    if (text.startsWith('/continue') || text.startsWith('/resume')) {
      const job = session.activeJobId ? this.jobManager.resumeJob(session.activeJobId) : null;
      if (job) {
        this.trackBotEvent(chatId, user, 'lookup_resumed', `Resumed job ${job.id.slice(0, 8)} at ${job.currentIndex}/${job.total}`);
      }
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: job ? `Continuing job from ${job.currentIndex}/${job.total}...` : 'No paused job to continue.',
      });
      return;
    }

    if (text.startsWith('/stop')) {
      const job = session.activeJobId ? await this.jobManager.stopJob(session.activeJobId) : null;
      if (job) {
        this.trackBotEvent(chatId, user, 'lookup_stopped', `Stopped job ${job.id.slice(0, 8)} at ${job.currentIndex}/${job.total}`);
      }
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: job ? 'Job stopped. Exporting saved CSV and JSON files...' : 'No active job to stop.',
      });
      return;
    }

    if (text.startsWith('/lookup')) {
      const rawArgs = text.replace(/^\/lookup(@\w+)?/i, '').trim();
      const targets = parseTargetsText(rawArgs);
      await this.startLookupForChat(chatId, targets, user);
      return;
    }

    if (session.awaitingToken) {
      await this.verifyAndSaveToken(chatId, msg.message_id, text, user);
      return;
    }

    if (!text.startsWith('/')) {
      const targets = parseTargetsText(text);
      await this.startLookupForChat(chatId, targets, user);
    }
  }
}
