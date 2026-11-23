import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer as createViteServer} from 'vite';
import {ActivityTracker} from './server/activityTracker.ts';
import {
  DiscordApiClient,
  LookupJobManager,
  type LookupJob,
  type LookupOptions,
} from './server/discordLookup.ts';
import {QuotaManager} from './server/quota.ts';
import {
  createBurstRateLimiter,
  hashOwnerKey,
  resolveRequestIdentity,
  type VerifiedIdentity,
} from './server/security.ts';
import {TelegramBotRunner} from './server/telegramBot.ts';

const PORT = 3000;
const EXPORTS_DIR = path.resolve(process.cwd(), 'exports');
const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILENAME_REGEX = /^[a-zA-Z0-9._-]+\.(csv|json)$/;
const FREE_DAILY_LIMIT = Math.max(1, Number(process.env.FREE_DAILY_LIMIT || 50) || 50);

function resolveOwnerExportPath(ownerHash: string, filename: string): string | null {
  if (!/^[a-f0-9]{16}$/.test(ownerHash)) return null;
  if (!FILENAME_REGEX.test(filename)) return null;
  const ownerDir = path.resolve(EXPORTS_DIR, ownerHash);
  if (!ownerDir.startsWith(EXPORTS_DIR + path.sep)) return null;
  const resolved = path.resolve(ownerDir, filename);
  if (!resolved.startsWith(ownerDir + path.sep)) return null;
  return resolved;
}

function sanitizeJobForClient(job: LookupJob) {
  const {ownerKey: _ownerKey, ownerHash: _ownerHash, ...safeJob} = job;
  return safeJob;
}

function parseTargets(rawTargets: unknown): string[] {
  const list: string[] = [];
  if (Array.isArray(rawTargets)) {
    for (const item of rawTargets) {
      if (typeof item === 'string') {
        for (const token of item.split(/[\s,]+/)) {
          const clean = token.trim();
          if (clean) list.push(clean);
        }
      }
    }
  } else if (typeof rawTargets === 'string') {
    for (const token of rawTargets.split(/[\s,]+/)) {
      const clean = token.trim();
      if (clean) list.push(clean);
    }
  }
  return Array.from(new Set(list)).slice(0, FREE_DAILY_LIMIT);
}

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);

  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const requireTelegramInitData = process.env.TELEGRAM_REQUIRE_INIT_DATA === 'true';

  const quotaManager = new QuotaManager(DATA_DIR, FREE_DAILY_LIMIT);
  await quotaManager.init();

  const activityTracker = new ActivityTracker(DATA_DIR);
  await activityTracker.init();

  const jobActorMeta = new Map<
    string,
    {
      channel: 'telegram_bot' | 'telegram_webapp' | 'web';
      telegramUserId?: number;
      telegramUsername?: string;
      firstName?: string;
    }
  >();

  const jobManager = new LookupJobManager(EXPORTS_DIR, quotaManager, {
    onJobFinished: (job) => {
      const actor = jobActorMeta.get(job.id);
      jobActorMeta.delete(job.id);
      const isBot = job.label.startsWith('tg_');
      const channel = actor?.channel ?? (isBot ? 'telegram_bot' : 'web');
      const existing = activityTracker.getUserDetail(job.ownerKey, quotaManager, 1);
      const action = job.haltReason
        ? 'lookup_halted'
        : job.status === 'completed'
          ? 'lookup_completed'
          : 'lookup_stopped';
      const details = job.haltReason
        ? `${job.haltReason} (${job.resolvedCount}/${job.total} resolved)`
        : `Batch ${job.status}: ${job.resolvedCount} resolved, ${job.failedCount} failed of ${job.total}`;

      activityTracker.record({
        ownerKey: job.ownerKey,
        ownerHash: job.ownerHash,
        channel,
        telegramUserId: actor?.telegramUserId ?? existing?.user.telegramUserId,
        telegramUsername: actor?.telegramUsername ?? existing?.user.telegramUsername,
        firstName: actor?.firstName ?? existing?.user.firstName,
        action,
        details,
        targetsCount: job.total,
        increments: {
          lookupsProcessed: job.results.length,
          lookupsResolved: job.resolvedCount,
          lookupsFailed: job.failedCount,
        },
      });
    },
  });
  await jobManager.init();

  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const adminUsersList = (process.env.TELEGRAM_ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const adminUserIds = new Set<number>(adminUsersList);
  const adminAlertsEnabled = process.env.TELEGRAM_ADMIN_ALERTS !== 'false';

  const telegramBot = new TelegramBotRunner({
    botToken,
    jobManager,
    quotaManager,
    activityTracker,
    exportsDir: EXPORTS_DIR,
    allowedUserIds: allowedUsers,
    adminUserIds: adminUsersList,
    adminAlertsEnabled,
  });

  function recordWebActivity(
    identity: VerifiedIdentity,
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
    activityTracker.record({
      ownerKey: identity.ownerKey,
      ownerHash: identity.ownerHash,
      channel: identity.source === 'telegram_webapp' ? 'telegram_webapp' : 'web',
      telegramUserId: identity.telegramUserId,
      telegramUsername: identity.telegramUsername,
      firstName: identity.telegramFirstName,
      discordAccountId: extra?.discordAccountId,
      discordUsername: extra?.discordUsername,
      action,
      details,
      targetsCount: extra?.targetsCount,
      targetsSample: extra?.targetsSample,
      increments: extra?.increments,
    });
  }

  function isVerifiedAdmin(identity: VerifiedIdentity): boolean {
    return (
      identity.source === 'telegram_webapp' &&
      typeof identity.telegramUserId === 'number' &&
      adminUserIds.has(identity.telegramUserId)
    );
  }

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use(express.json({limit: '256kb'}));

  const generalApiLimiter = createBurstRateLimiter({
    windowMs: 60_000,
    maxRequests: 60,
    bucketName: 'api_general',
  });
  const verifyLimiter = createBurstRateLimiter({
    windowMs: 60_000,
    maxRequests: 8,
    bucketName: 'api_verify',
  });
  const lookupStartLimiter = createBurstRateLimiter({
    windowMs: 60_000,
    maxRequests: 10,
    bucketName: 'api_lookup_start',
  });

  // Resolve verified Telegram Mini App or IP identity for all /api routes
  app.use('/api', (req, res, next) => {
    const identity = resolveRequestIdentity(req, botToken, requireTelegramInitData);
    if (!identity.ok) {
      const ipKey = `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
      activityTracker.record({
        ownerKey: ipKey,
        ownerHash: hashOwnerKey(ipKey),
        channel: 'web',
        action: 'unauthorized_access',
        details: `Rejected /api request (${identity.error})`,
        increments: {blocked: 1},
      });
      res.status(identity.status).json({ok: false, error: identity.error});
      return;
    }
    res.locals.identity = identity;
    next();
  }, generalApiLimiter);

  app.get('/api/quota', (_req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    res.json({
      ok: true,
      quota: quotaManager.getQuota(identity.ownerKey),
      source: identity.source,
      isAdmin: isVerifiedAdmin(identity),
    });
  });

  app.post('/api/verify', verifyLimiter, async (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 500) {
      res.status(400).json({ok: false, error: 'Please enter a valid Discord token.'});
      return;
    }

    const client = new DiscordApiClient(token);
    const result = await client.verifyToken();
    if (!result.ok || !result.account) {
      recordWebActivity(
        identity,
        'token_verify_failed',
        `Discord token rejected: ${result.error || 'Unauthorized'}`,
      );
      res.status(401).json({ok: false, error: result.error || 'Token verification failed.'});
      return;
    }
    recordWebActivity(
      identity,
      'token_verified',
      `Verified Discord @${result.account.username} (${result.account.id})`,
      {
        discordAccountId: result.account.id,
        discordUsername: result.account.username,
      },
    );
    res.json({ok: true, account: result.account});
  });

  app.post('/api/lookups', lookupStartLimiter, (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 500) {
      res.status(400).json({ok: false, error: 'A Discord token is required.'});
      return;
    }

    const targets = parseTargets(req.body?.targets);
    if (targets.length === 0) {
      res.status(400).json({
        ok: false,
        error: 'Enter at least one Discord User ID, username, or DM Channel ID.',
      });
      return;
    }

    const rawOpts =
      req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
    const delayMsRaw = Number(rawOpts.delayMs ?? 1500);
    const delayMs = Number.isFinite(delayMsRaw)
      ? Math.min(Math.max(1200, delayMsRaw), 10000)
      : 1500;
    const rawLabel = typeof rawOpts.label === 'string' ? rawOpts.label : 'usernames';
    const label = rawLabel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'usernames';

    const options: LookupOptions = {
      fetchProfile: rawOpts.fetchProfile !== false,
      fetchSupplemental: rawOpts.fetchSupplemental !== false,
      fetchMessages: Boolean(rawOpts.fetchMessages),
      messageLimit: Math.min(Math.max(1, Number(rawOpts.messageLimit ?? 10) || 10), 100),
      withMutualGuilds: rawOpts.withMutualGuilds !== false,
      withMutualFriends: rawOpts.withMutualFriends !== false,
      delayMs,
      label,
    };

    const started = jobManager.startJob(
      identity.ownerKey,
      identity.ownerHash,
      token,
      targets,
      options,
    );
    if (!started.ok) {
      const action = started.status === 429 ? 'quota_blocked' : 'lookup_rejected';
      recordWebActivity(identity, action, started.error, {
        targetsCount: targets.length,
        targetsSample: targets.slice(0, 5),
        increments: started.status === 429 ? {blocked: 1} : undefined,
      });
      res.status(started.status).json({
        ok: false,
        error: started.error,
        quota: quotaManager.getQuota(identity.ownerKey),
      });
      return;
    }

    jobActorMeta.set(started.job.id, {
      channel: identity.source === 'telegram_webapp' ? 'telegram_webapp' : 'web',
      telegramUserId: identity.telegramUserId,
      telegramUsername: identity.telegramUsername,
      firstName: identity.telegramFirstName,
    });
    recordWebActivity(
      identity,
      'lookup_started',
      `Started lookup batch (${started.job.total} target${started.job.total === 1 ? '' : 's'}) [${label}]`,
      {
        targetsCount: started.job.total,
        targetsSample: started.job.targets.slice(0, 5),
        increments: {jobsStarted: 1},
      },
    );

    res.status(201).json({
      ok: true,
      job: sanitizeJobForClient(started.job),
      quota: quotaManager.getQuota(identity.ownerKey),
    });
  });

  app.get('/api/lookups/:jobId', (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const job = jobManager.getJob(req.params.jobId);
    if (!job || job.ownerKey !== identity.ownerKey) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    res.json({
      ok: true,
      job: sanitizeJobForClient(job),
      quota: quotaManager.getQuota(identity.ownerKey),
    });
  });

  app.post('/api/lookups/:jobId/pause', (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const existing = jobManager.getJob(req.params.jobId);
    if (!existing || existing.ownerKey !== identity.ownerKey) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    const job = jobManager.pauseJob(req.params.jobId);
    if (job) {
      recordWebActivity(
        identity,
        'lookup_paused',
        `Paused job ${job.id.slice(0, 8)} at ${job.currentIndex}/${job.total}`,
      );
    }
    res.json({ok: true, job: job ? sanitizeJobForClient(job) : null});
  });

  app.post('/api/lookups/:jobId/resume', (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const existing = jobManager.getJob(req.params.jobId);
    if (!existing || existing.ownerKey !== identity.ownerKey) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    const job = jobManager.resumeJob(req.params.jobId);
    if (job) {
      recordWebActivity(
        identity,
        'lookup_resumed',
        `Resumed job ${job.id.slice(0, 8)} at ${job.currentIndex}/${job.total}`,
      );
    }
    res.json({ok: true, job: job ? sanitizeJobForClient(job) : null});
  });

  app.post('/api/lookups/:jobId/stop', async (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const existing = jobManager.getJob(req.params.jobId);
    if (!existing || existing.ownerKey !== identity.ownerKey) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    const job = await jobManager.stopJob(req.params.jobId);
    if (job) {
      recordWebActivity(
        identity,
        'lookup_stopped',
        `Stopped job ${job.id.slice(0, 8)} at ${job.currentIndex}/${job.total}`,
      );
    }
    res.json({
      ok: true,
      job: job ? sanitizeJobForClient(job) : null,
      quota: quotaManager.getQuota(identity.ownerKey),
    });
  });

  app.get('/api/exports', async (_req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const ownerDir = path.resolve(EXPORTS_DIR, identity.ownerHash);
    if (!ownerDir.startsWith(EXPORTS_DIR + path.sep)) {
      res.status(400).json({ok: false, error: 'Invalid export scope.'});
      return;
    }

    try {
      await fs.mkdir(ownerDir, {recursive: true});
      const entries = await fs.readdir(ownerDir);
      const files = [];

      for (const name of entries) {
        const resolved = resolveOwnerExportPath(identity.ownerHash, name);
        if (!resolved) continue;
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) continue;
        const ext = path.extname(name).slice(1).toLowerCase();

        let recordCount = 0;
        try {
          const content = await fs.readFile(resolved, 'utf8');
          if (ext === 'json') {
            const parsed = JSON.parse(content) as {results?: unknown[]};
            recordCount = Array.isArray(parsed.results) ? parsed.results.length : 0;
          } else if (ext === 'csv') {
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            recordCount = Math.max(0, lines.length - 1);
          }
        } catch {
          recordCount = 0;
        }

        files.push({
          filename: name,
          format: ext as 'csv' | 'json',
          sizeBytes: stat.size,
          recordCount,
          createdAt: stat.mtime.toISOString(),
        });
      }

      files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ok: true, files});
    } catch {
      res.status(500).json({ok: false, error: 'Failed to list saved exports.'});
    }
  });

  app.get('/api/exports/:filename', async (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const resolved = resolveOwnerExportPath(identity.ownerHash, req.params.filename);
    if (!resolved) {
      res.status(400).json({ok: false, error: 'Invalid export filename.'});
      return;
    }

    try {
      const content = await fs.readFile(resolved, 'utf8');
      const isDownload = req.query.download === '1';
      const isCsv = req.params.filename.endsWith('.csv');

      if (isDownload) {
        recordWebActivity(
          identity,
          'export_downloaded',
          `Downloaded ${req.params.filename}`,
          {increments: {exportsDownloaded: 1}},
        );
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
        res.setHeader(
          'Content-Type',
          isCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        );
        res.send(content);
        return;
      }

      res.json({
        ok: true,
        filename: req.params.filename,
        format: isCsv ? 'csv' : 'json',
        content,
      });
    } catch {
      res.status(404).json({ok: false, error: 'Export file not found.'});
    }
  });

  app.delete('/api/exports/:filename', async (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    const resolved = resolveOwnerExportPath(identity.ownerHash, req.params.filename);
    if (!resolved) {
      res.status(400).json({ok: false, error: 'Invalid export filename.'});
      return;
    }

    try {
      await fs.unlink(resolved);
      recordWebActivity(identity, 'export_deleted', `Deleted export ${req.params.filename}`);
      res.json({ok: true});
    } catch {
      res.status(404).json({ok: false, error: 'Export file not found.'});
    }
  });

  app.get('/api/admin/activity', (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    if (!isVerifiedAdmin(identity)) {
      recordWebActivity(
        identity,
        'unauthorized_access',
        'Attempted access to /api/admin/activity',
        {increments: {blocked: 1}},
      );
      res.status(403).json({ok: false, error: 'Admin access required.'});
      return;
    }
    const limit = Number(req.query.limit ?? 150) || 150;
    const summary = activityTracker.getSummary(quotaManager, limit);
    res.json({ok: true, ...summary});
  });

  app.get('/api/admin/activity/export', (req, res) => {
    const identity = res.locals.identity as VerifiedIdentity;
    if (!isVerifiedAdmin(identity)) {
      recordWebActivity(
        identity,
        'unauthorized_access',
        'Attempted access to /api/admin/activity/export',
        {increments: {blocked: 1}},
      );
      res.status(403).json({ok: false, error: 'Admin access required.'});
      return;
    }

    const format = req.query.format === 'json' ? 'json' : 'csv';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    if (format === 'json') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="activity_report_${stamp}.json"`,
      );
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(activityTracker.buildExportJson(quotaManager));
      return;
    }

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="activity_report_${stamp}.csv"`,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(activityTracker.buildExportCsv(quotaManager));
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LookupDesk SaaS server listening on http://localhost:${PORT}`);
    if (botToken) {
      void telegramBot.start();
    }
  });
}

void startServer();
