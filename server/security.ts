import crypto from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';

export interface VerifiedIdentity {
  ok: true;
  ownerKey: string;
  ownerHash: string;
  source: 'telegram_webapp' | 'ip';
  telegramUserId?: number;
}

export interface RejectedIdentity {
  ok: false;
  status: number;
  error: string;
}

export function hashOwnerKey(ownerKey: string): string {
  return crypto.createHash('sha256').update(ownerKey).digest('hex').slice(0, 16);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex').slice(0, 24);
}

export function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Verifies Telegram Mini App initData HMAC-SHA256 signature using the bot token.
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSeconds = 86400,
): {ok: true; userId: number; username?: string} | {ok: false; error: string} {
  if (!initDataRaw || !botToken) {
    return {ok: false, error: 'Missing Telegram initData or bot token.'};
  }

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
      return {ok: false, error: 'Missing or malformed Telegram signature hash.'};
    }

    const authDate = Number(params.get('auth_date') || '0');
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate <= 0 || nowSec - authDate > maxAgeSeconds) {
      return {ok: false, error: 'Telegram session expired. Reopen the Mini App.'};
    }

    const pairs: string[] = [];
    params.forEach((value, key) => {
      if (key !== 'hash') {
        pairs.push(`${key}=${value}`);
      }
    });
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();
    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const providedBuf = Buffer.from(hash.toLowerCase(), 'utf8');
    const computedBuf = Buffer.from(computedHash.toLowerCase(), 'utf8');
    if (
      providedBuf.length !== computedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, computedBuf)
    ) {
      return {ok: false, error: 'Invalid Telegram initData signature.'};
    }

    const userRaw = params.get('user');
    if (!userRaw) {
      return {ok: false, error: 'Telegram user payload missing.'};
    }
    const parsedUser = JSON.parse(userRaw) as {id?: unknown; username?: unknown};
    const userId = Number(parsedUser.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return {ok: false, error: 'Invalid Telegram user ID.'};
    }

    return {
      ok: true,
      userId,
      username: typeof parsedUser.username === 'string' ? parsedUser.username : undefined,
    };
  } catch {
    return {ok: false, error: 'Failed to validate Telegram initData.'};
  }
}

export function resolveRequestIdentity(
  req: Request,
  botToken: string,
  requireTelegramInitData: boolean,
): VerifiedIdentity | RejectedIdentity {
  const initDataHeader = req.headers['x-telegram-init-data'];
  const initDataRaw = typeof initDataHeader === 'string' ? initDataHeader.trim() : '';

  if (initDataRaw && botToken) {
    const verified = verifyTelegramInitData(initDataRaw, botToken);
    if (!verified.ok) {
      return {ok: false, status: 401, error: verified.error};
    }
    const ownerKey = `tg:${verified.userId}`;
    return {
      ok: true,
      ownerKey,
      ownerHash: hashOwnerKey(ownerKey),
      source: 'telegram_webapp',
      telegramUserId: verified.userId,
    };
  }

  if (requireTelegramInitData) {
    return {
      ok: false,
      status: 401,
      error: 'Access allowed only from inside the Telegram Mini App.',
    };
  }

  const clientIp = extractClientIp(req);
  const ownerKey = `ip:${clientIp}`;
  return {
    ok: true,
    ownerKey,
    ownerHash: hashOwnerKey(ownerKey),
    source: 'ip',
  };
}

interface BucketEntry {
  timestamps: number[];
}

export function createBurstRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  bucketName: string;
}) {
  const store = new Map<string, BucketEntry>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const cutoff = now - options.windowMs;
    const identityKey =
      (res.locals.identity as VerifiedIdentity | undefined)?.ownerKey ||
      `ip:${extractClientIp(req)}`;
    const key = `${options.bucketName}:${identityKey}`;

    let entry = store.get(key);
    if (!entry) {
      entry = {timestamps: []};
      store.set(key, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= options.maxRequests) {
      const oldest = entry.timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `Too many requests. Please wait ${retryAfterSec}s before trying again.`,
      });
      return;
    }

    entry.timestamps.push(now);
    next();
  };
}
