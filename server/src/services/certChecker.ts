import { promises as dns } from "dns";
import { isIP } from "net";
import type { CertificateResult, IpCertificateResult } from "@shared/types/certificates";
import { parseDomainTarget, type DomainTarget } from "../utils/domain";
import {
  CERT_CHECK_TIMEOUT_MS,
  probeCertificate,
  type CertificateTarget,
} from "./certificateProbe";

const DEFAULT_CHECK_RETRY_ATTEMPTS = 3;
const IP_CHECK_CONCURRENCY = 5;

export interface DomainCertCheckResult extends CertificateResult<Date> {
  ip: string | null;
  ipResults: IpCertificateResult<Date>[];
}

function normalizeProxyUrl(proxyUrl: string): string {
  const trimmed = proxyUrl.trim();
  if (/^socks[45]?[ah]?:\/\//i.test(trimmed) || /^[a-zA-Z]+:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, "")}`;
}

function getConfiguredProxyUrls(): string[] {
  return (process.env.CERT_CHECK_PROXY_URLS || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeProxyUrl);
}

function maskProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username) parsed.username = "****";
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return proxyUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, "//****:****@");
  }
}

export function logCertCheckProxyConfig(): void {
  const proxyUrls = getConfiguredProxyUrls();
  console.log(
    proxyUrls.length === 0
      ? "[CertChecker] No certificate check proxy fallbacks configured"
      : `[CertChecker] Registered ${proxyUrls.length} certificate check proxy fallback(s): ${proxyUrls.map(maskProxyUrl).join(", ")}`,
  );
}

async function resolveTargets(target: DomainTarget): Promise<CertificateTarget[]> {
  if (target.resolveAddress || isIP(target.host)) {
    return [
      { hostname: target.host, port: target.port, address: target.resolveAddress || target.host },
    ];
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    // Use the system resolver (including /etc/hosts), requesting both IPv4 and IPv6.
    const addresses = await Promise.race([
      dns.lookup(target.host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("DNS lookup timeout")), CERT_CHECK_TIMEOUT_MS);
      }),
    ]);
    const uniqueAddresses = [...new Set(addresses.map(({ address }) => address))].sort();
    if (!uniqueAddresses.length) throw new Error("No IP addresses found");
    return uniqueAddresses.map((address) => ({
      hostname: target.host,
      port: target.port,
      address,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function checkTargetWithRetries(
  target: CertificateTarget,
  attempts: number,
  proxyUrls: string[],
): Promise<IpCertificateResult<Date>> {
  let result: CertificateResult<Date> = {
    expiresAt: null,
    issuer: null,
    error: "Certificate check failed",
  };
  // Every retry/fallback is pinned to this address, never a fresh DNS choice.
  for (const proxyUrl of [undefined, ...proxyUrls]) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      result = await probeCertificate(target, proxyUrl);
      if (!result.error && result.expiresAt) return { ip: target.address, ...result };
    }
  }
  return { ip: target.address, ...result };
}

export function summarizeCertificates(
  ipResults: IpCertificateResult<Date>[],
): DomainCertCheckResult {
  const earliest = ipResults
    .filter((result) => !result.error && result.expiresAt)
    .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime() || a.ip.localeCompare(b.ip))[0];
  const failures = ipResults.filter((result) => result.error || !result.expiresAt);
  return {
    expiresAt: earliest?.expiresAt ?? null,
    issuer: earliest?.issuer ?? null,
    ip: earliest?.ip ?? null,
    error: failures.length
      ? `${failures.length} of ${ipResults.length} IP checks failed: ${failures.map((result) => `${result.ip} (${result.error || "No certificate expiry"})`).join("; ")}`
      : ipResults.length
        ? null
        : "No IP addresses found",
    ipResults,
  };
}

export async function checkCertForDomainWithRetries(
  domain: string,
  attempts = DEFAULT_CHECK_RETRY_ATTEMPTS,
): Promise<DomainCertCheckResult> {
  const target = parseDomainTarget(domain);
  if (!target) {
    return {
      expiresAt: null,
      issuer: null,
      ip: null,
      error: "Invalid domain target",
      ipResults: [],
    };
  }
  let targets: CertificateTarget[];
  try {
    targets = await resolveTargets(target);
  } catch (error) {
    return {
      expiresAt: null,
      issuer: null,
      ip: null,
      ipResults: [],
      error: `DNS lookup failed for ${target.host}: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }

  const proxyUrls = getConfiguredProxyUrls();
  const ipResults: IpCertificateResult<Date>[] = [];
  for (let index = 0; index < targets.length; index += IP_CHECK_CONCURRENCY) {
    ipResults.push(
      ...(await Promise.all(
        targets
          .slice(index, index + IP_CHECK_CONCURRENCY)
          .map((target) => checkTargetWithRetries(target, Math.max(1, attempts), proxyUrls)),
      )),
    );
  }
  return summarizeCertificates(ipResults);
}
