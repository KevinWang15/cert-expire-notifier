import { Router, Response } from "express";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { getDomainValidationError, normalizeDomain } from "../utils/domain";
import { parseNotificationThresholdOverride } from "../services/notificationSettings";
import { normalizeName, normalizeNotes } from "../utils/validation";
import { parseWebhookConfig } from "../utils/webhook";
import type { WebhookConfig } from "@shared/types/notifications";

const router = Router();

const EXPORT_VERSION = 1;
const EXPORT_APP = "cert-expire-notifier";

class ConfigImportValidationError extends Error {}

interface ImportedDomainConfig {
  domain: string;
  notes?: string | null;
}

interface ConfigImportPayload {
  version?: number;
  app?: string;
  user?: {
    name?: string | null;
    notificationThresholdDays?: number | null;
  };
  domains?: ImportedDomainConfig[];
  notifications?: { emailEnabled: boolean; webhooks: WebhookConfig[] };
}

function parseImportPayload(payload: unknown): {
  name?: string | null;
  notificationThresholdDays?: number | null;
  domains: ImportedDomainConfig[];
  notifications?: { emailEnabled: boolean; webhooks: WebhookConfig[] };
} {
  if (!payload || typeof payload !== "object") {
    throw new ConfigImportValidationError("Import payload must be a JSON object");
  }

  const { version, app, user, domains, notifications } = payload as ConfigImportPayload;

  if (version !== EXPORT_VERSION) {
    throw new ConfigImportValidationError(
      `Unsupported export version: ${String(version ?? "missing")}`,
    );
  }

  if (app !== EXPORT_APP) {
    throw new ConfigImportValidationError("Invalid export file");
  }

  if (!Array.isArray(domains)) {
    throw new ConfigImportValidationError("Import file must contain a domains array");
  }

  const normalizedDomains = new Map<string, ImportedDomainConfig>();

  for (const entry of domains) {
    if (!entry || typeof entry !== "object" || typeof entry.domain !== "string") {
      throw new ConfigImportValidationError("Each imported domain must include a domain string");
    }

    const normalizedDomain = normalizeDomain(entry.domain);
    const domainError = getDomainValidationError(normalizedDomain);
    if (domainError) {
      throw new ConfigImportValidationError(`Invalid domain in import: ${entry.domain}`);
    }

    normalizedDomains.set(normalizedDomain, {
      domain: normalizedDomain,
      notes: normalizeNotes(entry.notes),
    });
  }

  const hasName = !!user && Object.prototype.hasOwnProperty.call(user, "name");
  const hasNotificationThreshold =
    !!user && Object.prototype.hasOwnProperty.call(user, "notificationThresholdDays");
  const name = hasName ? normalizeName(user?.name) : undefined;

  let notificationThresholdDays: number | null | undefined;
  if (hasNotificationThreshold) {
    try {
      notificationThresholdDays = parseNotificationThresholdOverride(
        user?.notificationThresholdDays ?? null,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid notification threshold";
      throw new ConfigImportValidationError(message);
    }
  }

  let normalizedNotifications;
  if (notifications !== undefined) {
    if (
      !notifications ||
      typeof notifications.emailEnabled !== "boolean" ||
      !Array.isArray(notifications.webhooks)
    ) {
      throw new ConfigImportValidationError(
        "Notifications must include emailEnabled and a webhooks array",
      );
    }
    try {
      normalizedNotifications = {
        emailEnabled: notifications.emailEnabled,
        webhooks: notifications.webhooks.map(parseWebhookConfig),
      };
    } catch (error) {
      throw new ConfigImportValidationError(
        error instanceof Error ? error.message : "Invalid webhook configuration",
      );
    }
  }
  return {
    name,
    notificationThresholdDays,
    domains: [...normalizedDomains.values()],
    notifications: normalizedNotifications,
  };
}

router.use(authMiddleware);

router.get("/export", async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        email: true,
        name: true,
        notificationThresholdDays: true,
        notificationEmailEnabled: true,
        webhookTargets: {
          orderBy: { id: "asc" },
          select: {
            name: true,
            enabled: true,
            url: true,
            method: true,
            headers: true,
            bodyTemplate: true,
          },
        },
        domains: {
          orderBy: { createdAt: "asc" },
          select: {
            domain: true,
            notes: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      version: EXPORT_VERSION,
      app: EXPORT_APP,
      exportedAt: new Date().toISOString(),
      user: {
        email: user.email,
        name: user.name,
        notificationThresholdDays: user.notificationThresholdDays,
      },
      domains: user.domains,
      notifications: { emailEnabled: user.notificationEmailEnabled, webhooks: user.webhookTargets },
    });
  } catch (err) {
    console.error("Export config error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/import", async (req: AuthRequest, res: Response) => {
  try {
    const { name, notificationThresholdDays, domains, notifications } = parseImportPayload(
      req.body,
    );

    await prisma.$transaction(async (tx) => {
      if (notifications) {
        await tx.user.update({
          where: { id: req.userId },
          data: { notificationEmailEnabled: notifications.emailEnabled },
        });
        await tx.webhookTarget.deleteMany({ where: { userId: req.userId } });
        if (notifications.webhooks.length) {
          await tx.webhookTarget.createMany({
            data: notifications.webhooks.map((webhook) => ({ ...webhook, userId: req.userId! })),
          });
        }
      }
      if (name !== undefined || notificationThresholdDays !== undefined) {
        await tx.user.update({
          where: { id: req.userId },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(notificationThresholdDays !== undefined ? { notificationThresholdDays } : {}),
          },
        });
      }

      await tx.domain.deleteMany({
        where: {
          userId: req.userId,
          ...(domains.length > 0
            ? {
                domain: {
                  notIn: domains.map((entry) => entry.domain),
                },
              }
            : {}),
        },
      });

      for (const entry of domains) {
        await tx.domain.upsert({
          where: {
            userId_domain: {
              userId: req.userId!,
              domain: entry.domain,
            },
          },
          update: {
            notes: entry.notes ?? null,
            lastCheckedAt: null,
            certExpiresAt: null,
            certIssuer: null,
            certError: null,
          },
          create: {
            userId: req.userId!,
            domain: entry.domain,
            notes: entry.notes ?? null,
          },
        });
      }
    });

    res.json({
      success: true,
      importedDomains: domains.length,
      message: `Restored ${domains.length} domain configuration${domains.length === 1 ? "" : "s"}`,
    });
  } catch (err: unknown) {
    console.error("Import config error:", err);

    if (err instanceof ConfigImportValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
