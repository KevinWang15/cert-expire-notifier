import type { Request, Response, NextFunction } from "express";

interface RateLimitOptions {
  bucket: string;
  windowMs: number;
  maxRequests: number;
  message: string;
  key?: (req: Request) => string;
}

interface BucketState {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, BucketState>();

function getClientIp(req: Request): string {
  return (
    req.ip ||
    req.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function cleanupExpiredEntries(now: number) {
  for (const [key, value] of buckets.entries()) {
    if (value.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    cleanupExpiredEntries(now);

    const keySuffix = options.key ? options.key(req) : getClientIp(req);
    const bucketKey = `${options.bucket}:${keySuffix}`;
    const existing = buckets.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      buckets.set(bucketKey, {
        count: 1,
        resetAt: now + options.windowMs,
      });
      next();
      return;
    }

    if (existing.count >= options.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: options.message });
      return;
    }

    existing.count += 1;
    buckets.set(bucketKey, existing);
    next();
  };
}

export function emailRateLimitKey(req: Request): string {
  const email =
    typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "no-email";
  return `${getClientIp(req)}:${email}`;
}
