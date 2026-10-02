import type { WebhookTarget } from "@prisma/client";
import prisma from "../prisma";
import { sendTrackedEmail, type TrackedEmailPayload } from "./emailService";
import { sendTrackedWebhook, type WebhookPayload } from "./webhookService";
import { escapeHtml, stripHtml } from "../utils/html";

export interface NotificationPayload extends TrackedEmailPayload {
  text?: string;
  shortText?: string;
}

export function buildWebhookPayload(
  payload: NotificationPayload,
  requestedAt: Date,
): WebhookPayload {
  return {
    app: "cert-expire-notifier",
    purpose: payload.purpose,
    subject: payload.subject,
    html: payload.html,
    text: payload.text ?? stripHtml(payload.html),
    shortText: payload.shortText ?? payload.preview ?? payload.subject,
    details: payload.domains ?? null,
    requestedAt: requestedAt.toISOString(),
  };
}

export async function sendNotification(payload: NotificationPayload, onlyWebhook?: WebhookTarget) {
  const requestedAt = new Date();
  const user = onlyWebhook
    ? null
    : await prisma.user.findUnique({
        where: { id: payload.userId },
        select: {
          notificationEmailEnabled: true,
          webhookTargets: { where: { enabled: true }, orderBy: { id: "asc" } },
        },
      });
  if (!onlyWebhook && !user) throw new Error("Notification user not found");
  const webhookPayload = buildWebhookPayload(payload, requestedAt);
  const tasks = [
    ...(user?.notificationEmailEnabled
      ? [
          {
            channel: "EMAIL" as const,
            target: payload.to,
            run: async () => {
              const log = await sendTrackedEmail(payload, { throwOnFailure: false });
              return {
                channel: "EMAIL" as const,
                target: payload.to,
                status: log.status,
                error: log.error,
              };
            },
          },
        ]
      : []),
    ...(onlyWebhook ? [onlyWebhook] : (user?.webhookTargets ?? [])).map((target) => ({
      channel: "WEBHOOK" as const,
      target: target.name,
      run: async () => {
        const log = await sendTrackedWebhook(target, webhookPayload);
        return {
          channel: "WEBHOOK" as const,
          target: target.name,
          status: log.status,
          error: log.error,
        };
      },
    })),
  ];
  // Bound concurrent outbound requests; an individual failure cannot stop the other targets.
  const deliveries: Array<{
    channel: "EMAIL" | "WEBHOOK";
    target: string;
    status: string;
    error: string | null;
  }> = [];
  for (let index = 0; index < tasks.length; index += 5) {
    const batch = tasks.slice(index, index + 5);
    const results = await Promise.allSettled(batch.map((task) => task.run()));
    for (const [offset, result] of results.entries()) {
      if (result.status === "fulfilled") deliveries.push(result.value);
      else {
        console.error("[Notification] Delivery could not be recorded:", result.reason);
        deliveries.push({
          channel: batch[offset].channel,
          target: batch[offset].target,
          status: "FAILED",
          error: "Delivery could not be recorded",
        });
      }
    }
  }
  return {
    requestedAt,
    sent: deliveries.some((delivery) => delivery.status === "SENT"),
    deliveries,
  };
}

export function testNotification(user: {
  id: number;
  email: string;
  name: string | null;
}): NotificationPayload {
  return {
    userId: user.id,
    to: user.email,
    subject: "Cert Expire Notifier - Test Email",
    purpose: "TEST_EMAIL",
    preview: "Test email requested from the dashboard.",
    text: `Hello ${user.name || user.email},\nThis is a test notification from Cert Expire Notifier to confirm delivery is configured.`,
    shortText: "Cert Expire Notifier: Test notification to confirm delivery is configured.",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #0f172a;">
        <h2 style="color: #1a1a2e;">Test Email from Cert Expire Notifier</h2>
        <p>Hello ${escapeHtml(user.name || user.email)},</p>
        <p>This is a test email to confirm that email delivery is configured.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="color: #888; font-size: 12px;">Cert Expire Notifier</p>
      </div>
    `,
  };
}
