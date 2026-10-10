const PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeProxy(entry: unknown): string | null {
  const binding = typeof entry === "string" ? { url: entry } : entry;
  if (!isRecord(binding) || typeof binding.url !== "string" || !binding.url.trim()) return null;

  let url = binding.url.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) {
    const type = typeof binding.type === "string" ? binding.type.trim().toUpperCase() : "";
    url = `${type === "SOCKS" || type === "SOCKS5" ? "socks5" : "https"}://${url.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(url);
    if (!PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return null;
    if (typeof binding.basicAuthUsername === "string") {
      parsed.username = encodeURIComponent(binding.basicAuthUsername);
    }
    if (typeof binding.basicAuthPassword === "string") {
      parsed.password = encodeURIComponent(binding.basicAuthPassword);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Normalize URL lists and structured proxy bindings to unique connection URLs. */
export function getConfiguredProxyUrls(raw = process.env.CERT_CHECK_PROXY_URLS): string[] {
  if (!raw?.trim()) return [];
  let entries: unknown[];
  try {
    const parsed: unknown = JSON.parse(raw);
    entries = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.proxies)
        ? parsed.proxies
        : [parsed];
  } catch {
    entries = raw
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const urls = entries.map(normalizeProxy);
  const invalidCount = urls.filter((url) => url === null).length;
  if (invalidCount) {
    // Never log rejected entries: they may contain credentials.
    console.warn(`[CertChecker] Ignoring ${invalidCount} invalid certificate check proxy entry(s)`);
  }
  return [...new Set(urls.filter((url): url is string => url !== null))];
}

export function logCertCheckProxyConfig(): void {
  const urls = getConfiguredProxyUrls();
  const masked = urls.map((url) => {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = "****";
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  });
  console.log(
    urls.length
      ? `[CertChecker] Registered ${urls.length} certificate check proxy fallback(s): ${masked.join(", ")}`
      : "[CertChecker] No certificate check proxy fallbacks configured",
  );
}
