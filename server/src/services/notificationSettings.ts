import { parsePositiveInt } from "../utils/tokens";

export const MIN_NOTIFICATION_THRESHOLD_DAYS = 1;
export const MAX_NOTIFICATION_THRESHOLD_DAYS = 365;

function clampThresholdDays(value: number): number {
  return Math.min(
    MAX_NOTIFICATION_THRESHOLD_DAYS,
    Math.max(MIN_NOTIFICATION_THRESHOLD_DAYS, value),
  );
}

export function getAdminDefaultNotificationThresholdDays(): number {
  return clampThresholdDays(parsePositiveInt(process.env.CERT_EXPIRY_THRESHOLD_DAYS, 30));
}

export function resolveNotificationThresholdDays(
  userThresholdDays: number | null | undefined,
): number {
  return clampThresholdDays(userThresholdDays ?? getAdminDefaultNotificationThresholdDays());
}

export function parseNotificationThresholdOverride(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new Error("Notification threshold must be a whole number of days");
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);

  if (!Number.isInteger(parsed)) {
    throw new Error("Notification threshold must be a whole number of days");
  }

  if (parsed < MIN_NOTIFICATION_THRESHOLD_DAYS || parsed > MAX_NOTIFICATION_THRESHOLD_DAYS) {
    throw new Error(
      `Notification threshold must be between ${MIN_NOTIFICATION_THRESHOLD_DAYS} and ${MAX_NOTIFICATION_THRESHOLD_DAYS} days`,
    );
  }

  return parsed;
}

export function buildNotificationSettings(userThresholdDays: number | null | undefined) {
  const adminDefaultThresholdDays = getAdminDefaultNotificationThresholdDays();
  const userThreshold = parseNotificationThresholdOverride(userThresholdDays ?? null);

  return {
    adminDefaultThresholdDays,
    userThresholdDays: userThreshold,
    effectiveThresholdDays: userThreshold ?? adminDefaultThresholdDays,
    minThresholdDays: MIN_NOTIFICATION_THRESHOLD_DAYS,
    maxThresholdDays: MAX_NOTIFICATION_THRESHOLD_DAYS,
    cronExpression: process.env.CERT_CHECK_CRON || "0 * * * *",
  };
}
