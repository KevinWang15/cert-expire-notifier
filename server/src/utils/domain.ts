export const DEFAULT_CERT_PORT = 443;

interface DomainTarget {
  host: string;
  port: number;
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

export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }

  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");

  const target = splitHostAndPort(value);
  if (!target) {
    return value.replace(/\.$/, "");
  }

  if (!target.port || target.port === DEFAULT_CERT_PORT) {
    return target.host;
  }

  return `${target.host}:${target.port}`;
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253 || hostname.includes(" ") || hostname.includes("*")) {
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
  const target = splitHostAndPort(normalizedDomain);
  if (!target || !isValidHostname(target.host)) {
    return null;
  }

  return {
    host: target.host,
    port: target.port ?? DEFAULT_CERT_PORT,
  };
}

export function isValidDomain(domain: string): boolean {
  return parseDomainTarget(domain) !== null;
}

export function getDomainValidationError(domain: string): string | null {
  if (!domain) {
    return "Domain is required";
  }

  if (domain.length > 253) {
    return "Domain must be 253 characters or fewer";
  }

  if (!isValidDomain(domain)) {
    return "Enter a valid hostname, optionally with a port, for example api.example.com:8443";
  }

  return null;
}
