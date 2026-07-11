import https from "https";
import tls from "tls";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { DEFAULT_CERT_PORT, parseDomainTarget } from "../utils/domain";

const DEFAULT_CHECK_RETRY_ATTEMPTS = 3;
const DEFAULT_CERT_CHECK_TIMEOUT_MS = 10000;

export interface CertCheckResult {
  expiresAt: Date | null;
  issuer: string | null;
  error: string | null;
}

interface CertCheckOptions {
  proxyUrl?: string;
}

function normalizeProxyUrl(proxyUrl: string): string {
  const trimmed = proxyUrl.trim();
  if (/^socks[45]?[ah]?:\/\//i.test(trimmed) || /^[a-zA-Z]+:\/\//.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed.replace(/^\/+/, "")}`;
}

function getConfiguredProxyUrls(): string[] {
  const configured = process.env.CERT_CHECK_PROXY_URLS;
  if (!configured) {
    return [];
  }

  return configured
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeProxyUrl);
}

function maskProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "****" : "";
      parsed.password = parsed.password ? "****" : "";
    }
    return parsed.toString();
  } catch {
    return proxyUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, "//****:****@");
  }
}

export function logCertCheckProxyConfig(): void {
  const proxyUrls = getConfiguredProxyUrls();
  if (proxyUrls.length === 0) {
    console.log("[CertChecker] No certificate check proxy fallbacks configured");
    return;
  }

  console.log(
    `[CertChecker] Registered ${proxyUrls.length} certificate check proxy fallback(s): ${proxyUrls
      .map(maskProxyUrl)
      .join(", ")}`,
  );
}

function buildProxyAgent(proxyUrl: string): HttpsProxyAgent<string> | SocksProxyAgent {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol.toLowerCase().startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  }

  return new HttpsProxyAgent(proxyUrl);
}

function readCertificateFromSocket(socket: tls.TLSSocket): CertCheckResult {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.valid_to) {
    return { expiresAt: null, issuer: null, error: "No certificate found" };
  }

  const expiresAt = new Date(cert.valid_to);
  if (Number.isNaN(expiresAt.getTime())) {
    return { expiresAt: null, issuer: null, error: "Invalid certificate expiry" };
  }

  const issuer = cert.issuer ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(" - ") : null;

  return { expiresAt, issuer, error: null };
}

function normalizeCertCheckResult(result: CertCheckResult): CertCheckResult {
  if (result.error || result.expiresAt) {
    return result;
  }

  return {
    ...result,
    error: "Certificate check returned no expiry",
  };
}

function checkCertForDomainViaProxy(
  domain: string,
  port: number,
  proxyUrl: string,
): Promise<CertCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    const agent = buildProxyAgent(proxyUrl);

    const done = (result: CertCheckResult) => {
      if (settled) {
        return;
      }
      settled = true;
      req.destroy();
      resolve(result);
    };

    const req = https.request(
      {
        host: domain,
        port,
        path: "/",
        method: "HEAD",
        agent,
        rejectUnauthorized: false,
        servername: domain,
        timeout: DEFAULT_CERT_CHECK_TIMEOUT_MS,
      },
      (response) => {
        const socket = response.socket;
        response.resume();
        if (socket instanceof tls.TLSSocket) {
          try {
            done(readCertificateFromSocket(socket));
          } catch (err: unknown) {
            done({
              expiresAt: null,
              issuer: null,
              error: err instanceof Error ? err.message : "Unknown certificate error",
            });
          }
        } else {
          done({
            expiresAt: null,
            issuer: null,
            error: "Proxy response did not expose a TLS socket",
          });
        }
      },
    );

    req.on("socket", (socket) => {
      if (socket instanceof tls.TLSSocket) {
        const resolveFromSocket = () => {
          try {
            done(readCertificateFromSocket(socket));
          } catch (err: unknown) {
            done({
              expiresAt: null,
              issuer: null,
              error: err instanceof Error ? err.message : "Unknown certificate error",
            });
          }
        };

        const existingCert = socket.getPeerCertificate();
        if (existingCert && existingCert.valid_to) {
          resolveFromSocket();
        } else {
          socket.once("secureConnect", resolveFromSocket);
        }
      }
    });

    req.on("timeout", () => {
      done({ expiresAt: null, issuer: null, error: "Connection timeout" });
    });

    req.on("error", (err) => {
      done({ expiresAt: null, issuer: null, error: err.message });
    });

    req.end();
  });
}

export function checkCertForDomain(
  domain: string,
  port?: number,
  options: CertCheckOptions = {},
): Promise<CertCheckResult> {
  const parsedTarget = parseDomainTarget(domain);
  const host = parsedTarget?.host ?? domain;
  const effectivePort = port ?? parsedTarget?.port ?? DEFAULT_CERT_PORT;

  if (options.proxyUrl) {
    return checkCertForDomainViaProxy(host, effectivePort, options.proxyUrl);
  }

  return new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | undefined;
    let timeout: NodeJS.Timeout;

    const done = (result: CertCheckResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket?.destroy();
      resolve(result);
    };

    timeout = setTimeout(() => {
      done({ expiresAt: null, issuer: null, error: "Connection timeout" });
    }, DEFAULT_CERT_CHECK_TIMEOUT_MS);

    socket = tls.connect(
      {
        host,
        port: effectivePort,
        servername: host,
        rejectUnauthorized: false,
      },
      () => {
        try {
          done(readCertificateFromSocket(socket as tls.TLSSocket));
        } catch (err: unknown) {
          done({
            expiresAt: null,
            issuer: null,
            error: err instanceof Error ? err.message : "Unknown certificate error",
          });
        }
      },
    );

    socket.on("error", (err) => {
      done({ expiresAt: null, issuer: null, error: err.message });
    });
  });
}

export async function checkCertForDomainWithRetries(
  domain: string,
  attempts = DEFAULT_CHECK_RETRY_ATTEMPTS,
): Promise<CertCheckResult> {
  const target = parseDomainTarget(domain);
  if (!target) {
    return {
      expiresAt: null,
      issuer: null,
      error: "Invalid domain target",
    };
  }

  const targetLabel =
    target.port === DEFAULT_CERT_PORT ? target.host : `${target.host}:${target.port}`;
  const proxyUrls = getConfiguredProxyUrls();
  let lastResult: CertCheckResult = {
    expiresAt: null,
    issuer: null,
    error: "Certificate check failed",
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = normalizeCertCheckResult(await checkCertForDomain(target.host, target.port));
      if (!result.error) {
        return result;
      }
      lastResult = result;
    } catch (err) {
      lastResult = {
        expiresAt: null,
        issuer: null,
        error: err instanceof Error ? err.message : "Certificate check failed",
      };
    }
  }

  if (proxyUrls.length === 0) {
    console.warn(
      `[CertChecker] Direct check failed for ${targetLabel} after ${attempts} attempts (${lastResult.error || "unknown error"}); no CERT_CHECK_PROXY_URLS configured`,
    );
    return lastResult;
  }

  console.warn(
    `[CertChecker] Direct check failed for ${targetLabel} after ${attempts} attempts (${lastResult.error || "unknown error"}); trying ${proxyUrls.length} configured proxy fallback(s)`,
  );

  for (const proxyUrl of proxyUrls) {
    const maskedProxyUrl = maskProxyUrl(proxyUrl);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = normalizeCertCheckResult(
          await checkCertForDomain(target.host, target.port, { proxyUrl }),
        );
        if (!result.error) {
          console.info(
            `[CertChecker] Proxy fallback succeeded for ${targetLabel} via ${maskedProxyUrl} on attempt ${attempt}`,
          );
          return result;
        }
        lastResult = result;
      } catch (err) {
        lastResult = {
          expiresAt: null,
          issuer: null,
          error: err instanceof Error ? err.message : "Certificate check failed",
        };
      }
    }
    console.warn(
      `[CertChecker] Proxy fallback failed for ${targetLabel} via ${maskedProxyUrl} after ${attempts} attempts (${lastResult.error || "unknown error"})`,
    );
  }

  return lastResult;
}
