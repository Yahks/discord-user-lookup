import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer as createViteServer} from 'vite';
import {
  DiscordApiClient,
  LookupJobManager,
  type LookupOptions,
} from './server/discordLookup.ts';
import {TelegramBotRunner} from './server/telegramBot.ts';

const PORT = 3000;
const EXPORTS_DIR = path.resolve(process.cwd(), 'exports');
const FILENAME_REGEX = /^[a-zA-Z0-9._-]+\.(csv|json)$/;

function resolveExportPath(filename: string): string | null {
  if (!FILENAME_REGEX.test(filename)) return null;
  const resolved = path.resolve(EXPORTS_DIR, filename);
  if (!resolved.startsWith(EXPORTS_DIR + path.sep)) return null;
  return resolved;
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
  return Array.from(new Set(list)).slice(0, 500);
}

async function startServer(): Promise<void> {
  const app = express();
  const jobManager = new LookupJobManager(EXPORTS_DIR);
  await jobManager.init();

  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const telegramBot = new TelegramBotRunner({
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    jobManager,
    exportsDir: EXPORTS_DIR,
    allowedUserIds: allowedUsers,
  });

  app.use(express.json({limit: '1mb'}));

  app.get('/api/telegram/status', (_req, res) => {
    res.json({ok: true, status: telegramBot.getStatus()});
  });

  app.post('/api/verify', async (req, res) => {
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

  app.post('/api/lookups', (req, res) => {
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
    const delayMsRaw = Number(rawOpts.delayMs ?? 1000);
    const delayMs = Number.isFinite(delayMsRaw)
      ? Math.min(Math.max(250, delayMsRaw), 10000)
      : 1000;
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

    const job = jobManager.startJob(token, targets, options);
    res.status(201).json({ok: true, job});
  });

  app.get('/api/lookups/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    res.json({ok: true, job});
  });

  app.post('/api/lookups/:jobId/pause', (req, res) => {
    const job = jobManager.pauseJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    res.json({ok: true, job});
  });

  app.post('/api/lookups/:jobId/resume', (req, res) => {
    const job = jobManager.resumeJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    res.json({ok: true, job});
  });

  app.post('/api/lookups/:jobId/stop', async (req, res) => {
    const job = await jobManager.stopJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ok: false, error: 'Lookup job not found.'});
      return;
    }
    res.json({ok: true, job});
  });

  app.get('/api/exports', async (_req, res) => {
    try {
      await fs.mkdir(EXPORTS_DIR, {recursive: true});
      const entries = await fs.readdir(EXPORTS_DIR);
      const files = [];

      for (const name of entries) {
        const resolved = resolveExportPath(name);
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
    const resolved = resolveExportPath(req.params.filename);
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
        res.setHeader('Content-Type', isCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
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
    const resolved = resolveExportPath(req.params.filename);
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
    if (process.env.TELEGRAM_BOT_TOKEN) {
      void telegramBot.start();
    }
  });
}

void startServer();
