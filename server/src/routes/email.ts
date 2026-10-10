import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import prisma from "../prisma";
import { sendTrackedEmail } from "../services/emailService";
import { testNotification } from "../services/notificationService";
import {
  buildCertificateNotificationEmail,
  domainsExpiringBy,
  domainsWithCheckFailures,
  getNextEligibleCertificateNotificationTime,
  MS_PER_DAY,
} from "../services/certificateNotifications";
import {
  buildNotificationSettings,
  parseNotificationThresholdOverride,
} from "../services/notificationSettings";

const router = Router();
const testEmailRateLimit = rateLimit({
  bucket: "email-test",
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  message: "Too many test email requests. Please try again later.",
});

router.use(authMiddleware);

function parseLimit(rawLimit: unknown): number {
  const value = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : 25;
  if (!Number.isFinite(value)) {
    return 25;
  }
  return Math.max(1, Math.min(value, 100));
}

async function buildUpcomingCertificateEmailResponse(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerifiedAt: true,
      notificationThresholdDays: true,
      notificationEmailEnabled: true,
      webhookTargets: { where: { enabled: true }, select: { id: true } },
      domains: {
        where: {
          OR: [{ certExpiresAt: { not: null }, certError: null }, { certError: { not: null } }],
        },
        orderBy: [{ certExpiresAt: "asc" }, { domain: "asc" }],
        select: {
          domain: true,
          certExpiresAt: true,
          certIp: true,
          notes: true,
          certError: true,
        },
      },
    },
  });

  if (!user) {
    return null;
  }

  const settings = buildNotificationSettings(user.notificationThresholdDays);
  const cronExpression = settings.cronExpression;

  if (!user.emailVerifiedAt) {
    return {
      settings,
      nextRunAt: null,
      emails: [],
      note: "Verify your email before certificate alerts can be scheduled.",
    };
  }

  if (!user.notificationEmailEnabled && user.webhookTargets.length === 0) {
    return {
      settings,
      nextRunAt: null,
      emails: [],
      note: "Enable an email or webhook target to receive certificate alerts.",
    };
  }

  const { plannedFor, sentToday } = await getNextEligibleCertificateNotificationTime(
    user.id,
    cronExpression,
  );

  if (!plannedFor) {
    return {
      settings,
      nextRunAt: null,
      emails: [],
      note: `Could not calculate the next run for cron schedule \"${cronExpression}\".`,
    };
  }

  const thresholdDate = new Date(
    plannedFor.getTime() + settings.effectiveThresholdDays * MS_PER_DAY,
  );
  const domains = domainsExpiringBy(user.domains, thresholdDate);
  const failedDomains = domainsWithCheckFailures(user.domains);

  if (domains.length === 0 && failedDomains.length === 0) {
    return {
      settings,
      nextRunAt: plannedFor,
      emails: [],
      note: "No certificate alert is currently planned from the latest certificate data.",
    };
  }

  const email = await buildCertificateNotificationEmail({
    user,
    expiringDomains: domains,
    failedDomains,
    thresholdDays: settings.effectiveThresholdDays,
    referenceDate: plannedFor,
  });

  return {
    settings,
    nextRunAt: plannedFor,
    emails: [
      {
        toEmail: user.email,
        subject: email.subject,
        plannedFor,
        thresholdDays: settings.effectiveThresholdDays,
        domains: domains.map((domain) => ({
          domain: domain.domain,
          certExpiresAt: domain.certExpiresAt,
          daysUntilExpiry: Math.ceil(
            (domain.certExpiresAt.getTime() - plannedFor.getTime()) / MS_PER_DAY,
          ),
        })),
        failedDomains: failedDomains.map((domain) => ({
          domain: domain.domain,
          error: domain.certError,
        })),
        preview: email.preview,
        html: email.html,
        sentToday,
      },
    ],
    note: sentToday
      ? "A certificate alert was already sent today. The next eligible notification time is shown."
      : "Upcoming alert is based on the latest stored certificate data and the next scheduled cron run.",
  };
}

router.get("/history", async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseLimit(req.query.limit);
    const [emails, total, pending, sent, failed, skipped] = await prisma.$transaction([
      prisma.emailLog.findMany({
        where: { userId: req.userId },
        orderBy: { requestedAt: "desc" },
        take: limit,
        select: {
          id: true,
          requestedAt: true,
          sentAt: true,
          status: true,
          purpose: true,
          toEmail: true,
          subject: true,
          domains: true,
          preview: true,
          error: true,
          updatedAt: true,
        },
      }),
      prisma.emailLog.count({ where: { userId: req.userId } }),
      prisma.emailLog.count({ where: { userId: req.userId, status: "PENDING" } }),
      prisma.emailLog.count({ where: { userId: req.userId, status: "SENT" } }),
      prisma.emailLog.count({ where: { userId: req.userId, status: "FAILED" } }),
      prisma.emailLog.count({ where: { userId: req.userId, status: "SKIPPED" } }),
    ]);

    res.json({
      emails,
      summary: {
        total,
        pending,
        sent,
        failed,
        skipped,
      },
    });
  } catch (err) {
    console.error("Email history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/settings", async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { notificationThresholdDays: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ settings: buildNotificationSettings(user.notificationThresholdDays) });
  } catch (err) {
    console.error("Email settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/settings", async (req: AuthRequest, res: Response) => {
  try {
    const notificationThresholdDays = parseNotificationThresholdOverride(
      req.body.notificationThresholdDays,
    );

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { notificationThresholdDays },
      select: { notificationThresholdDays: true },
    });

    res.json({ settings: buildNotificationSettings(user.notificationThresholdDays) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid notification settings";
    console.error("Update email settings error:", err);
    res.status(400).json({ error: message });
  }
});

router.get("/upcoming", async (req: AuthRequest, res: Response) => {
  try {
    const result = await buildUpcomingCertificateEmailResponse(req.userId!);

    if (!result) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(result);
  } catch (err) {
    console.error("Upcoming certificate email error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Backwards-compatible alias: these are pending planned certificate alerts, not transient delivery-log rows.
router.get("/pending", async (req: AuthRequest, res: Response) => {
  try {
    const result = await buildUpcomingCertificateEmailResponse(req.userId!);

    if (!result) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(result);
  } catch (err) {
    console.error("Pending certificate email error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Send a test email to the current user
router.post("/test", testEmailRateLimit, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!user.emailVerifiedAt) {
      res.status(403).json({ error: "Verify your email before sending test emails" });
      return;
    }

    const log = await sendTrackedEmail(testNotification(user));

    res.json({ success: true, message: "Test email sent successfully", email: log });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Test email error:", err);
    res.status(500).json({
      error: "Failed to send test email",
      details: message,
    });
  }
});

export default router;
