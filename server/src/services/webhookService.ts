import axios from "axios";
import { lookup } from "node:dns";
import { Agent as HttpAgent, validateHeaderValue } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { WebhookTarget } from "@prisma/client";
import prisma from "../prisma";
import { validateWebhookUrl } from "../utils/webhook";
import type { NotificationPurpose } from "@shared/types/notifications";

export interface WebhookPayload {
  app: "cert-expire-notifier";
  purpose: NotificationPurpose;
  subject: string;
  html: string;
  text: string;
  shortText: string;
  details: string[] | string | null;
  requestedAt: string;
}

const blockedIps = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blockedIps.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedIps.addSubnet(ip, prefix, "ipv6");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIps.check(address, "ipv4");
  return family === 6 && globalIpv6.check(address, "ipv6") && !blockedIps.check(address, "ipv6");
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: options.family, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (!addresses.length || addresses.some(({ address }) => !isPublicWebhookAddress(address))) {
      return callback(
        new Error("Webhook destination resolves to a private or reserved IP address"),
        "",
      );
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

function placeholders(payload: WebhookPayload): Record<string, string> {
  return {
    SUBJECT: payload.subject,
    HTML: payload.html,
    TEXT: payload.text,
    SHORT_TEXT: payload.shortText,
    PURPOSE: payload.purpose,
    DETAILS: Array.isArray(payload.details) ? payload.details.join(", ") : payload.details || "",
    TIMESTAMP: payload.requestedAt,
  };
}

export function expandWebhookTemplate(
  template: string,
  payload: WebhookPayload,
  encode = false,
): string {
  const values = placeholders(payload);
  return template.replace(
    /\$(SUBJECT|HTML|TEXT|SHORT_TEXT|PURPOSE|DETAILS|TIMESTAMP)\b/g,
    (_match, key: string) => (encode ? encodeURIComponent(values[key]) : values[key]),
  );
}

export function renderWebhookBody(template: string | null, payload: WebhookPayload): string {
  if (template === null) return JSON.stringify(payload);
  // Expand JSON string values after parsing, so quotes and newlines remain valid JSON.
  try {
    return JSON.stringify(
      JSON.parse(template, (_key, value: unknown) =>
        typeof value === "string" ? expandWebhookTemplate(value, payload) : value,
      ),
    );
  } catch {
    return expandWebhookTemplate(template, payload);
  }
}

export async function sendWebhook(target: WebhookTarget, payload: WebhookPayload): Promise<void> {
  const url = validateWebhookUrl(expandWebhookTemplate(target.url, payload, true));
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_IPS === "true";
  if (!allowPrivate && isIP(hostname) && !isPublicWebhookAddress(hostname)) {
    throw new Error("Webhook destination is a private or reserved IP address");
  }
  const headers = Object.fromEntries(
    Object.entries(target.headers as Record<string, string>).map(([key, value]) => {
      const rendered = expandWebhookTemplate(value, payload);
      try {
        validateHeaderValue(key, rendered);
      } catch {
        throw new Error(`Invalid rendered webhook header: ${key}`);
      }
      return [key, rendered];
    }),
  );
  const body =
    target.method === "GET" || target.method === "HEAD"
      ? undefined
      : renderWebhookBody(target.bodyTemplate, payload);
  if (
    body !== undefined &&
    !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
  ) {
    try {
      JSON.parse(body);
      headers["content-type"] = "application/json";
    } catch {
      headers["content-type"] = "text/plain; charset=utf-8";
    }
  }
  const httpAgent = new HttpAgent({ lookup: allowPrivate ? undefined : safeLookup });
  const httpsAgent = new HttpsAgent({ lookup: allowPrivate ? undefined : safeLookup });
  try {
    await axios.request({
      url,
      method: target.method,
      headers,
      data: body,
      // Send the rendered body verbatim, including plain-text templates.
      transformRequest: [(data) => data],
      httpAgent,
      httpsAgent,
      proxy: false,
      maxRedirects: 0,
      timeout: 10000,
      signal: AbortSignal.timeout(10000),
      maxContentLength: 65536,
      maxBodyLength: 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } finally {
    httpAgent.destroy();
    httpsAgent.destroy();
  }
}

export async function sendTrackedWebhook(target: WebhookTarget, payload: WebhookPayload) {
  const log = await prisma.webhookLog.create({
    data: {
      userId: target.userId,
      targetName: target.name,
      targetUrl: target.url,
      purpose: payload.purpose,
      subject: payload.subject,
      preview: payload.shortText.slice(0, 500),
      requestedAt: new Date(payload.requestedAt),
    },
  });
  try {
    await sendWebhook(target, payload);
    return await prisma.webhookLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        error: null,
      },
    });
  } catch (error) {
    // Axios errors may include secret URLs. Store only the response code or safe error message.
    const message = axios.isAxiosError(error)
      ? error.response
        ? `Webhook returned HTTP ${error.response.status}`
        : `Webhook request failed (${error.code || "network error"})`
      : error instanceof Error
        ? error.message
        : "Unknown webhook delivery error";
    return await prisma.webhookLog.update({
      where: { id: log.id },
      data: { status: "FAILED", error: message },
    });
  }
}
