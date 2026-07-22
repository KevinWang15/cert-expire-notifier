import { isIP } from "node:net";

export const DEFAULT_CERT_PORT = 443;
export const MAX_DOMAIN_TARGET_LENGTH = 320;
const MAX_HOSTNAME_LENGTH = 253;

export interface DomainTarget {
  host: string;
  port: number;
  resolveAddress?: string;
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return port;
}

function splitHostAndPort(value: string): { host: string; port: number | null } | null {
  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount === 0) {
    return { host: value.replace(/\.$/, ""), port: null };
  }

  if (colonCount > 1) {
    return null;
  }

  const [host, rawPort] = value.split(":");
  if (!host || !rawPort) {
    return null;
  }

  const port = parsePort(rawPort);
  if (port === null) {
    return null;
  }

  return { host: host.replace(/\.$/, ""), port };
}

function splitDomainTarget(value: string): DomainTarget | null {
  const resolveMatch = value.match(/^([^:]+):([^:]+):(.+)$/);
  if (resolveMatch) {
    const [, rawHost, rawPort, rawAddress] = resolveMatch;
    const port = parsePort(rawPort);
    if (port === null) {
      return null;
    }

    const hasOpeningBracket = rawAddress.startsWith("[");
    const hasClosingBracket = rawAddress.endsWith("]");
    if (hasOpeningBracket !== hasClosingBracket) {
      return null;
    }

    const resolveAddress =
      hasOpeningBracket && hasClosingBracket ? rawAddress.slice(1, -1) : rawAddress;
    const addressVersion = isIP(resolveAddress);
    if (addressVersion === 0 || (addressVersion === 4 && hasOpeningBracket)) {
      return null;
    }

    return {
      host: rawHost.replace(/\.$/, ""),
      port,
      resolveAddress,
    };
  }

  const target = splitHostAndPort(value);
  if (!target) {
    return null;
  }

  return {
    host: target.host,
    port: target.port ?? DEFAULT_CERT_PORT,
  };
}

function formatDomainTarget(target: DomainTarget): string {
  if (target.resolveAddress) {
    const formattedAddress =
      isIP(target.resolveAddress) === 6 ? `[${target.resolveAddress}]` : target.resolveAddress;
    return `${target.host}:${target.port}:${formattedAddress}`;
  }

  return target.port === DEFAULT_CERT_PORT ? target.host : `${target.host}:${target.port}`;
}

export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");

  const target = splitDomainTarget(value);
  return target ? formatDomainTarget(target) : value.replace(/\.$/, "");
}

function isValidHostname(hostname: string): boolean {
  if (
    !hostname ||
    hostname.length > MAX_HOSTNAME_LENGTH ||
    hostname.includes(" ") ||
    hostname.includes("*")
  ) {
    return false;
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    return false;
  }

  return labels.every((label) => {
    if (!label || label.length > 63) {
      return false;
    }
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  });
}

export function parseDomainTarget(domain: string): DomainTarget | null {
  const normalizedDomain = normalizeDomain(domain);
  const target = splitDomainTarget(normalizedDomain);
  if (!target || !isValidHostname(target.host)) {
    return null;
  }

  return target;
}

export function isValidDomain(domain: string): boolean {
  return parseDomainTarget(domain) !== null;
}

export function getDomainValidationError(domain: string): string | null {
  if (!domain) {
    return "Domain is required";
  }

  const hostname = domain.split(":", 1)[0];
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return `Domain must be ${MAX_HOSTNAME_LENGTH} characters or fewer`;
  }

  if (domain.length > MAX_DOMAIN_TARGET_LENGTH) {
    return `Domain target must be ${MAX_DOMAIN_TARGET_LENGTH} characters or fewer`;
  }

  if (!isValidDomain(domain)) {
    return "Enter a valid hostname, optionally with a port or IP override, for example api.example.com:443:192.0.2.10";
  }

  return null;
}
