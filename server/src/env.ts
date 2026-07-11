import dotenv from "dotenv";

dotenv.config();

const configuredPublicAppUrl =
  process.env.PUBLIC_APP_URL || process.env.APP_URL || process.env.SITE_URL;

if (process.env.NODE_ENV === "production") {
  if (!configuredPublicAppUrl) {
    throw new Error("PUBLIC_APP_URL must be set in production");
  }

  try {
    new URL(configuredPublicAppUrl);
  } catch {
    throw new Error("PUBLIC_APP_URL must be a valid absolute URL in production");
  }
}
