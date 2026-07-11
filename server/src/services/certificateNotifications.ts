import { marked } from "marked";
import prisma from "../prisma";
import { escapeHtml } from "../utils/html";
import { getNextCronRun } from "../utils/cronSchedule";

export const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface ExpiringCertificateNotificationDomain {
  domain: string;
  certExpiresAt: Date;
  notes: string | null;
}

export interface FailedCheckNotificationDomain {
  domain: string;
  certError: string;
  notes: string | null;
}

interface CertificateNotificationUser {
  id: number;
  email: string;
  name: string | null;
}

interface BuildCertificateNotificationEmailArgs {
  user: CertificateNotificationUser;
  expiringDomains: ExpiringCertificateNotificationDomain[];
  failedDomains: FailedCheckNotificationDomain[];
  thresholdDays: number;
  referenceDate?: Date;
}

export interface BuiltCertificateNotificationEmail {
  subject: string;
  html: string;
  preview: string;
  domainNames: string[];
}

function pluralize(count: number, singular: string, plural = singular + "s"): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function startOfToday(date = new Date()): Date {
  const copy = new Date(date.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function startOfTomorrow(date = new Date()): Date {
  const copy = startOfToday(date);
  copy.setDate(copy.getDate() + 1);
  return copy;
}

export async function buildCertificateNotificationEmail({
  user,
  expiringDomains,
  failedDomains,
  thresholdDays,
  referenceDate = new Date(),
}: BuildCertificateNotificationEmailArgs): Promise<BuiltCertificateNotificationEmail> {
  const expiringRows = await Promise.all(
    expiringDomains.map(async (domain) => {
      const daysLeft = Math.ceil(
        (domain.certExpiresAt.getTime() - referenceDate.getTime()) / MS_PER_DAY,
      );
      const notesHtml = domain.notes
        ? await marked.parse(escapeHtml(domain.notes))
        : "<em>No notes</em>";
      const riskColor = daysLeft <= 7 ? "#dc2626" : "#f59e0b";

      return `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: bold;">${escapeHtml(domain.domain)}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: ${riskColor};">
            ${domain.certExpiresAt.toISOString().split("T")[0]} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)
          </td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${notesHtml}</td>
        </tr>`;
    }),
  );

  const failedRows = await Promise.all(
    failedDomains.map(async (domain) => {
      const notesHtml = domain.notes
        ? await marked.parse(escapeHtml(domain.notes))
        : "<em>No notes</em>";

      return `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: bold;">${escapeHtml(domain.domain)}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #dc2626;">${escapeHtml(domain.certError)}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${notesHtml}</td>
        </tr>`;
    }),
  );

  const subject =
    expiringDomains.length > 0 && failedDomains.length > 0
      ? `[Cert Alert] ${pluralize(expiringDomains.length, "expiring certificate")}, ${pluralize(failedDomains.length, "failed check")}`
      : expiringDomains.length > 0
        ? `[Cert Expiry Warning] ${expiringDomains.length} domain${expiringDomains.length === 1 ? "" : "s"} expiring soon`
        : `[Cert Check Failure] ${failedDomains.length} domain check${failedDomains.length === 1 ? "" : "s"} failed`;

  const previewParts: string[] = [];
  if (expiringDomains.length > 0) {
    previewParts.push(
      `${pluralize(expiringDomains.length, "certificate")} expiring within ${thresholdDays} day${thresholdDays === 1 ? "" : "s"}.`,
    );
  }
  if (failedDomains.length > 0) {
    previewParts.push(`${pluralize(failedDomains.length, "domain check")} currently failing.`);
  }

  const sections: string[] = [];
  if (expiringDomains.length > 0) {
    sections.push(`
      <p>The following domains have SSL certificates expiring within <strong>${thresholdDays} days</strong>:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <thead>
          <tr style="background: #f8f9fa;">
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Domain</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Expires</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Notes</th>
          </tr>
        </thead>
        <tbody>
          ${expiringRows.join("")}
        </tbody>
      </table>
      <p>Please renew these certificates before they expire.</p>
    `);
  }

  if (failedDomains.length > 0) {
    sections.push(`
      <p>The following domains could not be checked successfully and need attention:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <thead>
          <tr style="background: #f8f9fa;">
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Domain</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Failure</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Notes</th>
          </tr>
        </thead>
        <tbody>
          ${failedRows.join("")}
        </tbody>
      </table>
      <p>Check DNS, connectivity, and whether the service is expected to present TLS on the monitored port.</p>
    `);
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 760px; margin: 0 auto; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Certificate Monitoring Alert</h2>
      <p>Hello ${escapeHtml(user.name || user.email)},</p>
      ${sections.join("")}
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="color: #888; font-size: 12px;">Cert Expire Notifier</p>
    </div>
  `;

  return {
    subject,
    html,
    preview: previewParts.join(" "),
    domainNames: [
      ...expiringDomains.map((domain) => domain.domain),
      ...failedDomains.map((domain) => domain.domain),
    ],
  };
}

export async function getNextEligibleCertificateNotificationTime(
  userId: number,
  cronExpression: string,
): Promise<{
  plannedFor: Date | null;
  sentToday: boolean;
}> {
  const now = new Date();
  const recentEmail = await prisma.emailLog.findFirst({
    where: {
      userId,
      purpose: "CERT_ALERT",
      status: "SENT",
      sentAt: { gte: startOfToday(now) },
    },
  });

  const searchFrom = recentEmail ? new Date(startOfTomorrow(now).getTime() - 60 * 1000) : now;
  return {
    plannedFor: getNextCronRun(cronExpression, searchFrom),
    sentToday: Boolean(recentEmail),
  };
}

export function domainsExpiringBy(
  domains: Array<{
    domain: string;
    certExpiresAt: Date | null;
    certError?: string | null;
    notes: string | null;
  }>,
  thresholdDate: Date,
): ExpiringCertificateNotificationDomain[] {
  return domains
    .filter(
      (domain): domain is ExpiringCertificateNotificationDomain =>
        !domain.certError &&
        domain.certExpiresAt !== null &&
        domain.certExpiresAt.getTime() <= thresholdDate.getTime(),
    )
    .sort((left, right) => left.certExpiresAt.getTime() - right.certExpiresAt.getTime());
}

export function domainsWithCheckFailures(
  domains: Array<{ domain: string; certError: string | null; notes: string | null }>,
): FailedCheckNotificationDomain[] {
  return domains
    .filter(
      (domain): domain is FailedCheckNotificationDomain =>
        typeof domain.certError === "string" && domain.certError.trim().length > 0,
    )
    .sort((left, right) =>
      left.domain.localeCompare(right.domain, undefined, { sensitivity: "base" }),
    );
}
