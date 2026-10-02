import axios from "axios";
import type { EmailLog, EmailPurpose } from "@prisma/client";
import prisma from "../prisma";
import { stripHtml } from "../utils/html";

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

export interface TrackedEmailPayload extends EmailPayload {
  userId: number;
  purpose: EmailPurpose;
  domains?: string[] | string | null;
  preview?: string | null;
}

interface TrackedEmailOptions {
  throwOnFailure?: boolean;
}

function normalizeDomains(domains: string[] | string | null | undefined): string | null {
  if (Array.isArray(domains)) {
    return domains.join(", ");
  }
  return domains || null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown email delivery error";
}

export function isEmailConfigured(): boolean {
  return Boolean(
    process.env.ENGAGE_LAB_USERNAME &&
    process.env.ENGAGE_LAB_API_KEY &&
    process.env.ENGAGE_LAB_FROM_EMAIL,
  );
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  const username = process.env.ENGAGE_LAB_USERNAME;
  const apiKey = process.env.ENGAGE_LAB_API_KEY;
  const fromEmail = process.env.ENGAGE_LAB_FROM_EMAIL;

  if (!username || !apiKey || !fromEmail) {
    throw new Error(
      "EngageLab email configuration is incomplete. Please set ENGAGE_LAB_USERNAME, ENGAGE_LAB_API_KEY, and ENGAGE_LAB_FROM_EMAIL.",
    );
  }

  const authString = Buffer.from(`${username}:${apiKey}`).toString("base64");

  await axios.post(
    "https://email.api.engagelab.cc/v1/mail/send",
    {
      from: fromEmail,
      to: [payload.to],
      body: {
        subject: payload.subject,
        content: {
          html:
            payload.html +
            `<p style='font-size:12px;opacity:0;pointer-events: none;position: absolute;left: 0;top: 0;'><a href='%%user_defined_unsubscribe_link%%'>&nbsp;</a></p>`,
        },
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${authString}`,
      },
      timeout: 15000,
    },
  );
}

export async function sendTrackedEmail(
  payload: TrackedEmailPayload,
  options: TrackedEmailOptions = {},
): Promise<EmailLog> {
  const log = await prisma.emailLog.create({
    data: {
      userId: payload.userId,
      status: "PENDING",
      purpose: payload.purpose,
      toEmail: payload.to,
      subject: payload.subject,
      domains: normalizeDomains(payload.domains),
      preview: payload.preview || stripHtml(payload.html).slice(0, 500) || null,
    },
  });

  try {
    await sendEmail(payload);
    return await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        error: null,
      },
    });
  } catch (error: unknown) {
    const message = errorMessage(error);
    const updated = await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: isEmailConfigured() ? "FAILED" : "SKIPPED",
        error: message,
      },
    });

    if (options.throwOnFailure ?? true) {
      throw error;
    }

    return updated;
  }
}
