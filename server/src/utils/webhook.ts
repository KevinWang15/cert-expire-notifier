import { validateHeaderName, validateHeaderValue } from "node:http";
import type { WebhookConfig } from "@shared/types/notifications";
import { WEBHOOK_METHODS, type WebhookMethod } from "@shared/types/notifications";

export class WebhookValidationError extends Error {}

export function validateWebhookUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new WebhookValidationError("Webhook URL is required and must be at most 2048 characters");
  }
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error();
    }
    return value.trim();
  } catch {
    throw new WebhookValidationError(
      "Webhook URL must use HTTP or HTTPS without credentials or a fragment",
    );
  }
}

export function parseWebhookConfig(value: unknown): WebhookConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebhookValidationError("Webhook configuration must be an object");
  }
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 191) {
    throw new WebhookValidationError("Webhook name is required and must be at most 191 characters");
  }
  const method = input.method ?? "POST";
  if (!WEBHOOK_METHODS.includes(method as WebhookMethod)) {
    throw new WebhookValidationError(`Webhook method must be ${WEBHOOK_METHODS.join(", ")}`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new WebhookValidationError("Webhook enabled must be a boolean");
  }
  const rawHeaders = input.headers ?? {};
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    throw new WebhookValidationError("Webhook headers must be an object of string values");
  }
  const headers: Record<string, string> = {};
  const seenHeaders = new Set<string>();
  for (const [key, val] of Object.entries(rawHeaders)) {
    try {
      const lower = key.toLowerCase();
      if (
        typeof val !== "string" ||
        seenHeaders.has(lower) ||
        ["host", "content-length", "transfer-encoding", "connection", "upgrade"].includes(lower)
      ) {
        throw new Error();
      }
      validateHeaderName(key);
      validateHeaderValue(key, val);
      seenHeaders.add(lower);
      Object.defineProperty(headers, lower, { value: val, enumerable: true });
    } catch {
      throw new WebhookValidationError(`Invalid or reserved webhook header: ${key}`);
    }
  }
  if (JSON.stringify(headers).length > 16384) {
    throw new WebhookValidationError("Webhook headers must be at most 16384 characters");
  }
  const bodyTemplate = input.bodyTemplate ?? null;
  if (
    bodyTemplate !== null &&
    (typeof bodyTemplate !== "string" || Buffer.byteLength(bodyTemplate, "utf8") > 65535)
  ) {
    throw new WebhookValidationError("Webhook body template must be at most 65535 bytes");
  }
  return {
    name,
    enabled: input.enabled ?? true,
    url: validateWebhookUrl(input.url),
    method: method as WebhookMethod,
    headers,
    bodyTemplate: bodyTemplate === "" ? null : bodyTemplate,
  };
}
