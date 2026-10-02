export type NotificationPurpose = "TEST_EMAIL" | "VERIFY_EMAIL" | "PASSWORD_RESET" | "CERT_ALERT";
export type NotificationStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED";
export const WEBHOOK_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

export interface WebhookConfig {
  name: string;
  enabled: boolean;
  url: string;
  method: WebhookMethod;
  headers: Record<string, string>;
  bodyTemplate: string | null;
}

export interface WebhookTarget extends WebhookConfig {
  id: number;
}

export interface NotificationSettings {
  email: { address: string; enabled: boolean };
  webhooks: WebhookTarget[];
}

export interface NotificationHistoryEntry {
  id: string;
  channel: "EMAIL" | "WEBHOOK";
  target: string;
  requestedAt: string;
  sentAt: string | null;
  status: NotificationStatus;
  purpose: NotificationPurpose;
  subject: string;
  preview: string | null;
  error: string | null;
}
