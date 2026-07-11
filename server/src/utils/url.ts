import type { Request } from "express";

export function getPublicAppUrl(req?: Request): string {
  const configured = process.env.PUBLIC_APP_URL || process.env.APP_URL || process.env.SITE_URL;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:5173";
  }
  throw new Error("PUBLIC_APP_URL must be configured in production");
}
