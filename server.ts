import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer as createViteServer} from 'vite';
import {
  DiscordApiClient,
  LookupJobManager,
  type LookupJob,
  type LookupOptions,
} from './server/discordLookup.ts';
import {QuotaManager} from './server/quota.ts';
import {
  createBurstRateLimiter,
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

  const jobManager = new LookupJobManager(EXPORTS_DIR, quotaManager);
  await jobManager.init();

  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const telegramBot = new TelegramBotRunner({
    botToken,
    jobManager,
    quotaManager,
    exportsDir: EXPORTS_DIR,
    allowedUserIds: allowedUsers,
  });

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
    });
  });

  app.post('/api/verify', verifyLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 500) {
      res.status(400).json({ok: false, error: 'Please enter a valid Discord token.'});
      return;
    }

    const client = new DiscordApiClient(token);
    const result = await client.verifyToken();
    if (!result.ok) {
      res.status(401).json({ok: false, error: result.error || 'Token verification failed.'});
      return;
    }
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
      res.status(started.status).json({
        ok: false,
        error: started.error,
        quota: quotaManager.getQuota(identity.ownerKey),
      });
      return;
    }

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
      res.json({ok: true});
    } catch {
      res.status(404).json({ok: false, error: 'Export file not found.'});
    }
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
