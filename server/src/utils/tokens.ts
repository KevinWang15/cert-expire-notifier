import crypto from "node:crypto";

export function createRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
