import cron from "node-cron";
import axios from "axios";
import prisma from "../prisma";
import { updateDomainCertificateState } from "./domainCertificateState";
import { sendNotification } from "./notificationService";
import {
  buildCertificateNotificationEmail,
  domainsExpiringBy,
  domainsWithCheckFailures,
  MS_PER_DAY,
  hasSentCertificateNotificationToday,
} from "./certificateNotifications";
import { resolveNotificationThresholdDays } from "./notificationSettings";
import { getNextCronRun } from "../utils/cronSchedule";

const CHECK_ALL_CONCURRENCY = 10;

async function checkAllCerts(): Promise<void> {
  console.log(`[CronJob] Starting cert check for all domains at ${new Date().toISOString()}`);

  const domains = await prisma.domain.findMany();
  console.log(`[CronJob] Found ${domains.length} domains to check`);

  for (let index = 0; index < domains.length; index += CHECK_ALL_CONCURRENCY) {
    const batch = domains.slice(index, index + CHECK_ALL_CONCURRENCY);
    await Promise.all(
      batch.map(async (domain) => {
        try {
          const updated = await updateDomainCertificateState(domain.id, domain.domain);
          console.log(
            `[CronJob] Checked ${domain.domain}: expires=${updated.certExpiresAt?.toISOString() || "N/A"}, error=${updated.certError || "none"}`,
          );
        } catch (err) {
          console.error(`[CronJob] Error checking ${domain.domain}:`, err);
        }
      }),
    );
  }

  console.log(`[CronJob] Cert check complete at ${new Date().toISOString()}`);
}

async function sendCertificateNotifications(): Promise<void> {
  console.log("[CronJob] Checking for certificate alerts to notify...");

  const users = await prisma.user.findMany({
    where: {
      emailVerifiedAt: { not: null },
      domains: {
        some: {
          OR: [{ certExpiresAt: { not: null }, certError: null }, { certError: { not: null } }],
        },
      },
    },
    select: {
      id: true,
      email: true,
      name: true,
      notificationThresholdDays: true,
      domains: {
        where: {
          OR: [{ certExpiresAt: { not: null }, certError: null }, { certError: { not: null } }],
        },
        orderBy: [{ certExpiresAt: "asc" }, { domain: "asc" }],
        select: {
          domain: true,
          certExpiresAt: true,
          notes: true,
          certError: true,
        },
      },
    },
  });

  if (users.length === 0) {
    console.log("[CronJob] No verified users with certificate data found");
    return;
  }

  let sentCount = 0;

  for (const user of users) {
    const thresholdDays = resolveNotificationThresholdDays(user.notificationThresholdDays);
    const thresholdDate = new Date(Date.now() + thresholdDays * MS_PER_DAY);
    const expiringDomains = domainsExpiringBy(user.domains, thresholdDate);
    const failedDomains = domainsWithCheckFailures(user.domains);

    if (expiringDomains.length === 0 && failedDomains.length === 0) {
      continue;
    }

    try {
      if (await hasSentCertificateNotificationToday(user.id)) {
        console.log(`[CronJob] Already sent certificate alert to ${user.email} today, skipping`);
        continue;
      }

      const email = await buildCertificateNotificationEmail({
        user,
        expiringDomains,
        failedDomains,
        thresholdDays,
      });

      const result = await sendNotification({
        userId: user.id,
        to: user.email,
        subject: email.subject,
        purpose: "CERT_ALERT",
        domains: email.domainNames,
        preview: email.preview,
        html: email.html,
        text: email.text,
        shortText: email.shortText,
      });

      if (!result.sent) {
        console.log(`[CronJob] No successful certificate alert delivery for user ${user.id}`);
        continue;
      }

      sentCount += 1;
      console.log(
        `[CronJob] Sent certificate alert to ${user.email} for ${expiringDomains.length} expiring domains and ${failedDomains.length} failed checks using ${thresholdDays}-day window`,
      );
    } catch (err) {
      console.error(`[CronJob] Error sending notification to user ${user.id}:`, err);
    }
  }

  if (sentCount === 0) {
    console.log("[CronJob] No certificate alerts needed for this run");
  }
}

async function pingHealthcheck(): Promise<void> {
  const pingUrl = process.env.HEALTHCHECKS_PING_URL;
  if (!pingUrl) {
    return;
  }

  try {
    await axios.get(pingUrl, { timeout: 10000 });
    console.log("[CronJob] Healthcheck ping sent successfully");
  } catch (err) {
    console.error("[CronJob] Healthcheck ping failed:", err);
  }
}

export function initCronJobs(): void {
  const cronExpression = process.env.CERT_CHECK_CRON || "0 * * * *";

  if (!cron.validate(cronExpression) || getNextCronRun(cronExpression) === null) {
    throw new Error(`Invalid CERT_CHECK_CRON expression: ${cronExpression}`);
  }

  console.log(`[CronJob] Initializing cron jobs with schedule: ${cronExpression}`);

  cron.schedule(cronExpression, async () => {
    try {
      await checkAllCerts();
      await sendCertificateNotifications();
      await pingHealthcheck();
    } catch (err) {
      console.error("[CronJob] Error in scheduled task:", err);
    }
  });

  console.log("[CronJob] Cron jobs initialized");
}
