export const SHARED_APP_NAME = "cert-expire-notifier";
export const API_PREFIX = "/api";
export const DEFAULT_SITE = "new";

export function buildHealthPayload(service: string) {
  return {
    ok: true,
    service,
    app: SHARED_APP_NAME,
    timestamp: new Date().toISOString(),
  };
}
