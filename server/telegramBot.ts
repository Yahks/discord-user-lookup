import fs from 'node:fs/promises';
import path from 'node:path';
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
  private readonly exportsDir: string;
  private readonly allowedUserIds: Set<number>;
  private readonly sessions = new Map<number, ChatSession>();
  private readonly jobOwners = new Map<string, number>();

  private running = false;
  private offset = 0;
  private botUsername: string | null = null;
  private botName: string | null = null;

  constructor(options: {
    botToken: string;
    jobManager: LookupJobManager;
    quotaManager: QuotaManager;
    exportsDir: string;
    allowedUserIds?: number[];
  }) {
    this.botToken = options.botToken.trim();
    this.jobManager = options.jobManager;
    this.quotaManager = options.quotaManager;
    this.exportsDir = options.exportsDir;
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
  }

  private getMiniAppUrl(): string | null {
    const raw = (process.env.APP_URL || '').trim();
    if (!raw || raw === 'MY_APP_URL') return null;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:') {
        return parsed.toString().replace(/\/$/, '');
      }
    } catch {
      return null;
    }
    return null;
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
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
    }
    const mime = filename.endsWith('.csv') ? 'text/csv' : 'application/json';
    form.append('document', new Blob([bytes], {type: mime}), filename);

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

      // Ensure polling works even if a webhook was previously attached
      await this.tgApi('deleteWebhook', {drop_pending_updates: false});
      await this.tgApi('setMyCommands', {
        commands: [
          {command: 'start', description: 'Show welcome guide and Mini App link'},
          {command: 'settoken', description: 'Set & verify your Discord token'},
          {command: 'lookup', description: 'Look up usernames, User IDs, or DM IDs'},
          {command: 'quota', description: 'Check your 50/day free-tier lookup quota'},
          {command: 'pause', description: 'Pause the active lookup job'},
          {command: 'continue', description: 'Continue a paused lookup job'},
          {command: 'stop', description: 'Stop job and export CSV & JSON'},
          {command: 'clear', description: 'Clear your token from bot memory'},
        ],
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
    if (action === 'pause') updated = this.jobManager.pauseJob(jobId);
    if (action === 'resume') updated = this.jobManager.resumeJob(jobId);
    if (action === 'stop') updated = await this.jobManager.stopJob(jobId);

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
  ): Promise<void> {
    const session = this.getOrCreateSession(chatId);
    session.awaitingToken = false;

    // Best-effort removal of user's message containing their token
    await this.tgApi('deleteMessage', {chat_id: chatId, message_id: messageId}).catch(() => undefined);

    const token = rawToken.trim();
    if (!token || token.length > 500) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Invalid token format. Use /settoken <DISCORD_TOKEN>.',
      });
      return;
    }

    const client = new DiscordApiClient(token);
    const verified = await client.verifyToken();
    if (!verified.ok || !verified.account) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: `Token verification failed: ${verified.error || 'Unauthorized'}`,
      });
      return;
    }

    session.discordToken = token;
    session.account = verified.account;
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
    userId?: number,
  ): Promise<void> {
    const session = this.getOrCreateSession(chatId);
    if (!session.discordToken) {
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

    const {ownerKey, ownerHash} = this.getOwnerKey(chatId, userId);
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
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: started.error,
      });
      return;
    }

    const job = started.job;
    session.activeJobId = job.id;
    this.jobOwners.set(job.id, chatId);

    const sent = await this.tgApi<{message_id: number}>('sendMessage', {
      chat_id: chatId,
      text: this.formatJobProgress(job),
      reply_markup: this.buildJobKeyboard(job),
    });

    const statusMsgId = sent.result?.message_id;
    void this.monitorJobAndDeliverExports(chatId, job.id, ownerKey, ownerHash, statusMsgId);
  }

  private async monitorJobAndDeliverExports(
    chatId: number,
    jobId: string,
    ownerKey: string,
    ownerHash: string,
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
        }
        break;
      }

      await sleep(1400);
    }
  }

  private async handleDocumentUpload(
    chatId: number,
    doc: TelegramDocument,
    userId?: number,
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

    await this.startLookupForChat(chatId, targets, userId);
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!this.isAuthorized(userId)) {
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Access restricted. Your Telegram user ID is not in TELEGRAM_ALLOWED_USER_IDS.',
      });
      return;
    }

    const session = this.getOrCreateSession(chatId);
    const text = (msg.text || '').trim();

    if (msg.document) {
      await this.handleDocumentUpload(chatId, msg.document, userId);
      return;
    }

    if (!text) return;

    if (text.startsWith('/start') || text.startsWith('/help')) {
      session.awaitingToken = false;
      await this.sendWelcome(chatId, userId);
      return;
    }

    if (text.startsWith('/quota')) {
      const {ownerKey} = this.getOwnerKey(chatId, userId);
      const q = this.quotaManager.getQuota(ownerKey);
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
      await this.verifyAndSaveToken(chatId, msg.message_id, arg);
      return;
    }

    if (text.startsWith('/pause')) {
      const job = session.activeJobId ? this.jobManager.pauseJob(session.activeJobId) : null;
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: job ? `Job paused at ${job.currentIndex}/${job.total}.` : 'No active job to pause.',
      });
      return;
    }

    if (text.startsWith('/continue') || text.startsWith('/resume')) {
      const job = session.activeJobId ? this.jobManager.resumeJob(session.activeJobId) : null;
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: job ? `Continuing job from ${job.currentIndex}/${job.total}...` : 'No paused job to continue.',
      });
      return;
    }

    if (text.startsWith('/stop')) {
      const job = session.activeJobId ? await this.jobManager.stopJob(session.activeJobId) : null;
      await this.tgApi('sendMessage', {
        chat_id: chatId,
        text: job ? 'Job stopped. Exporting saved CSV and JSON files...' : 'No active job to stop.',
      });
      return;
    }

    if (text.startsWith('/lookup')) {
      const rawArgs = text.replace(/^\/lookup(@\w+)?/i, '').trim();
      const targets = parseTargetsText(rawArgs);
      await this.startLookupForChat(chatId, targets, userId);
      return;
    }

    if (session.awaitingToken) {
      await this.verifyAndSaveToken(chatId, msg.message_id, text);
      return;
    }

    if (!text.startsWith('/')) {
      const targets = parseTargetsText(text);
      await this.startLookupForChat(chatId, targets, userId);
    }
  }
}
