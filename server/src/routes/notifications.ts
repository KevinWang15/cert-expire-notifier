import { Router, type Response } from "express";
import prisma from "../prisma";
import { authMiddleware, type AuthRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { parseWebhookConfig, WebhookValidationError } from "../utils/webhook";
import { sendNotification, testNotification } from "../services/notificationService";

const router = Router();
router.use(authMiddleware);
const testRateLimit = rateLimit({
  bucket: "notification-test",
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  message: "Too many test notification requests. Please try again later.",
  key: (req) => String((req as AuthRequest).userId),
});

function handleError(error: unknown, res: Response) {
  if (error instanceof WebhookValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error("Notification settings error:", error);
  res.status(500).json({ error: "Internal server error" });
}

function targetId(req: AuthRequest): number {
  const value = Number(req.params.id);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new WebhookValidationError("Invalid webhook ID");
  return value;
}

router.get("/settings", async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        email: true,
        notificationEmailEnabled: true,
        webhookTargets: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            name: true,
            enabled: true,
            url: true,
            method: true,
            headers: true,
            bodyTemplate: true,
          },
        },
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({
      email: { address: user.email, enabled: user.notificationEmailEnabled },
      webhooks: user.webhookTargets,
    });
  } catch (error) {
    handleError(error, res);
  }
});

router.put("/email", async (req: AuthRequest, res: Response) => {
  try {
    if (typeof req.body?.enabled !== "boolean")
      throw new WebhookValidationError("Email enabled must be a boolean");
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        notificationEmailEnabled: req.body.enabled,
      },
      select: { email: true, notificationEmailEnabled: true },
    });
    res.json({ address: user.email, enabled: user.notificationEmailEnabled });
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/webhooks", async (req: AuthRequest, res: Response) => {
  try {
    const config = parseWebhookConfig(req.body);
    const webhook = await prisma.webhookTarget.create({ data: { ...config, userId: req.userId! } });
    res.status(201).json({ webhook });
  } catch (error) {
    handleError(error, res);
  }
});

router.put("/webhooks/:id", async (req: AuthRequest, res: Response) => {
  try {
    const id = targetId(req);
    const config = parseWebhookConfig(req.body);
    const result = await prisma.webhookTarget.updateMany({
      where: { id, userId: req.userId },
      data: config,
    });
    if (!result.count) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    handleError(error, res);
  }
});

router.delete("/webhooks/:id", async (req: AuthRequest, res: Response) => {
  try {
    const result = await prisma.webhookTarget.deleteMany({
      where: { id: targetId(req), userId: req.userId },
    });
    if (!result.count) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    handleError(error, res);
  }
});

async function sendTest(req: AuthRequest, res: Response, individual: boolean) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerifiedAt: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (!user.emailVerifiedAt) {
      res.status(403).json({ error: "Verify your email before sending test notifications" });
      return;
    }
    const webhook = individual
      ? await prisma.webhookTarget.findFirst({ where: { id: targetId(req), userId: req.userId } })
      : undefined;
    if (individual && !webhook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    const result = await sendNotification(testNotification(user), webhook ?? undefined);
    if (!result.sent) {
      res.status(502).json({
        error: result.deliveries.length
          ? "All notification deliveries failed. See delivery history for details."
          : "No notification targets are enabled",
        ...result,
      });
      return;
    }
    res.json({ success: true, ...result });
  } catch (error) {
    handleError(error, res);
  }
}

router.post("/test", testRateLimit, (req: AuthRequest, res: Response) => sendTest(req, res, false));
router.post("/webhooks/:id/test", testRateLimit, (req: AuthRequest, res: Response) =>
  sendTest(req, res, true),
);

router.get("/history", async (req: AuthRequest, res: Response) => {
  try {
    const rawLimit = Number(req.query.limit ?? 25);
    const limit = Number.isSafeInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 25;
    const [emails, webhooks] = await prisma.$transaction([
      prisma.emailLog.findMany({
        where: { userId: req.userId },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.webhookLog.findMany({
        where: { userId: req.userId },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
    ]);
    const entries = [
      ...emails.map((log) => ({
        id: `email-${log.id}`,
        channel: "EMAIL",
        target: log.toEmail,
        requestedAt: log.requestedAt,
        sentAt: log.sentAt,
        status: log.status,
        purpose: log.purpose,
        subject: log.subject,
        preview: log.preview,
        error: log.error,
      })),
      ...webhooks.map((log) => ({
        id: `webhook-${log.id}`,
        channel: "WEBHOOK",
        target: log.targetName,
        requestedAt: log.requestedAt,
        sentAt: log.sentAt,
        status: log.status,
        purpose: log.purpose,
        subject: log.subject,
        preview: log.preview,
        error: log.error,
      })),
    ]
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
      .slice(0, limit);
    res.json({ entries });
  } catch (error) {
    handleError(error, res);
  }
});

export default router;
