import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const app = process.env.APP_URL;
const email = process.env.EMAIL_URL;
const hostname = process.env.LIVE_CERT_DOMAIN?.trim();
assert.ok(hostname, "Set LIVE_CERT_DOMAIN to a multi-IP hostname to test");
assert.equal(new URL(app).hostname, "app", "Use the dedicated Compose test stack");
assert.match(hostname, /^[a-z0-9.-]+\.[a-z]{2,}$/i);
const reportPath = "/artifacts/live-certificate-report.json";
const persistence = process.argv.includes("--persistence");
const previousReport = await readFile(reportPath, "utf8")
  .then(JSON.parse)
  .catch(() => null);
const report = persistence
  ? previousReport
  : {
      status: "RUNNING",
      hostname,
      runtime: { node: process.version, openssl: process.versions.openssl },
      startedAt: new Date().toISOString(),
      checks: [],
    };
let token;

async function save() {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}

async function step(name, action) {
  const started = Date.now();
  console.log(`RUN  ${name}`);
  try {
    await action();
    report.checks.push({ name, status: "PASS", durationMs: Date.now() - started });
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    report.checks.push({ name, status: "FAIL", error: error.message });
    throw error;
  } finally {
    await save();
  }
}

async function api(path, method = "GET", body, status = 200) {
  const response = await fetch(`${app}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

function openssl(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "openssl",
      args,
      { timeout: 12000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function probeIp(ip) {
  const startedAt = new Date().toISOString();
  try {
    const address = isIP(ip) === 6 ? `[${ip}]:443` : `${ip}:443`;
    const { stdout } = await openssl([
      "s_client",
      "-connect",
      address,
      "-servername",
      hostname,
      "-showcerts",
    ]);
    const pem = stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
    assert.ok(pem, `No leaf certificate received from ${ip}`);
    const { stdout: details } = await openssl(
      ["x509", "-noout", "-enddate", "-issuer", "-subject", "-serial", "-fingerprint", "-sha256"],
      pem,
    );
    const certificate = new X509Certificate(pem);
    const issuer = certificate.toLegacyObject().issuer;
    return {
      ip,
      startedAt,
      expiresAt: new Date(details.match(/^notAfter=(.+)$/m)[1]).toISOString(),
      issuer: [issuer.O, issuer.CN].filter(Boolean).join(" - ") || null,
      subject: certificate.subject,
      fingerprint: certificate.fingerprint256,
      openssl: details.trim(),
      error: null,
    };
  } catch (error) {
    return {
      ip,
      startedAt,
      expiresAt: null,
      issuer: null,
      error: error.killed ? "OpenSSL connection timeout" : (error.stderr || error.message).trim(),
    };
  }
}

async function resolveIps() {
  return [
    ...new Set(
      (await dns.lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address),
    ),
  ].sort();
}

function validateSnapshot(domain, reference) {
  assert.deepEqual(
    domain.lastIpResults.map(({ ip }) => ip).sort(),
    reference.map(({ ip }) => ip).sort(),
  );
  for (const expected of reference) {
    const actual = domain.lastIpResults.find(({ ip }) => ip === expected.ip);
    if (expected.error) {
      assert.ok(actual.error, `${expected.ip}: app and independent probe must agree on failure`);
      assert.equal(actual.expiresAt, null);
    } else {
      assert.equal(actual.error, null, `${expected.ip}: ${actual.error}`);
      assert.equal(actual.expiresAt, expected.expiresAt, `Expiry mismatch for ${expected.ip}`);
      assert.equal(actual.issuer, expected.issuer, `Issuer mismatch for ${expected.ip}`);
    }
  }
  const earliest = reference
    .filter((result) => !result.error)
    .sort(
      (a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.ip.localeCompare(b.ip),
    )[0];
  assert.ok(earliest, "At least one independent probe must succeed to validate the minimum expiry");
  assert.equal(domain.certExpiresAt, earliest.expiresAt);
  assert.equal(domain.certIssuer, earliest.issuer);
  assert.equal(domain.certIp, earliest.ip);
  assert.equal(
    !!domain.certError,
    reference.some((result) => result.error),
  );
}

async function run() {
  if (persistence) {
    token = (await api("/auth/login", "POST", report.account)).token;
    await step("live per-IP snapshots persist unchanged after application restart", async () => {
      const { domains } = await api("/domains");
      assert.deepEqual(domains, report.persistedDomains);
    });
    return;
  }

  // Retire live targets before replacing their report so later fixture-only
  // scheduler runs cannot get stuck probing Internet IPs on an internal network.
  if (previousReport?.account?.token) {
    token = previousReport.account.token;
    const response = await fetch(`${app}/api/domains`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      for (const domain of (await response.json()).domains)
        await api(`/domains/${domain.id}`, "DELETE");
    } else assert.equal(response.status, 401, "Previous test account cleanup failed");
    token = undefined;
  }

  await step("resolve all live addresses from the validation container", async () => {
    report.addresses = await resolveIps();
    assert.ok(report.addresses.length > 1, "Live example must resolve to multiple IPs");
    console.log(
      `${hostname}: ${report.addresses.length} addresses: ${report.addresses.join(", ")}`,
    );
    report.dns = await Promise.all(
      ["resolve4", "resolve6"].map(async (method) => {
        try {
          return { method, records: await dns[method](hostname, { ttl: true }) };
        } catch (error) {
          return { method, error: error.code };
        }
      }),
    );
  });

  await step(
    "independently inspect each live certificate with OpenSSL and domain SNI",
    async () => {
      report.opensslResults = [];
      for (let i = 0; i < report.addresses.length; i += 4) {
        report.opensslResults.push(
          ...(await Promise.all(report.addresses.slice(i, i + 4).map(probeIp))),
        );
      }
      for (const result of report.opensslResults)
        console.log(`${result.ip}: ${result.error || `${result.expiresAt} (${result.issuer})`}`);
      assert.ok(report.opensslResults.some((result) => !result.error));
    },
  );

  await step(
    "create a verified test account through the public API and local email mock",
    async () => {
      report.account = {
        email: `container-live-${Date.now()}@example.test`,
        password: "Container-live-validation-123!",
        name: "Live certificate validation",
      };
      await api("/auth/signup", "POST", report.account, 201);
      const requests = (await (await fetch(`${email}/__admin/requests`)).json()).requests;
      const message = requests.findLast((entry) => entry.body?.to?.includes(report.account.email));
      assert.ok(message, "Verification email must be captured by the local mock");
      const link = message.body.body.content.html
        .match(/href="([^"]+\/verify-email\?token=[^"]+)"/)[1]
        .replaceAll("&amp;", "&");
      token = (
        await api("/auth/verify-email", "POST", { token: new URL(link).searchParams.get("token") })
      ).token;
      report.account.token = token;
      await api("/notifications/email", "PUT", { enabled: false });
      report.target = (
        await api(
          "/domains",
          "POST",
          { domain: hostname, notes: "Live multi-IP certificate validation" },
          201,
        )
      ).domain;
    },
  );

  await step(
    "single-domain check matches every independently probed IP, expiry and issuer",
    async () => {
      report.singleCheck = (await api(`/domains/${report.target.id}/check`, "POST")).domain;
      report.addressesAfterCheck = await resolveIps();
      assert.deepEqual(
        report.addressesAfterCheck,
        report.addresses,
        "DNS changed during validation; rerun against a stable snapshot",
      );
      validateSnapshot(report.singleCheck, report.opensslResults);
    },
  );

  await step(
    "explicit IP overrides agree with the earliest and latest live certificates",
    async () => {
      const ordered = report.opensslResults
        .filter((result) => !result.error)
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
      report.overrides = [];
      for (const result of [ordered[0], ordered.at(-1)].filter(
        (entry, index, entries) => entries.findIndex((other) => other.ip === entry.ip) === index,
      )) {
        const address = isIP(result.ip) === 6 ? `[${result.ip}]` : result.ip;
        const domain = (
          await api("/domains", "POST", { domain: `${hostname}:443:${address}` }, 201)
        ).domain;
        const checked = (await api(`/domains/${domain.id}/check`, "POST")).domain;
        validateSnapshot(checked, [result]);
        report.overrides.push(checked);
      }
    },
  );

  await step(
    "check-all refreshes the complete live address set and keeps the minimum certificate",
    async () => {
      const checked = await api("/domains/check-all", "POST");
      assert.equal(checked.checked, 1 + report.overrides.length);
      validateSnapshot(
        checked.domains.find((domain) => domain.id === report.target.id),
        report.opensslResults,
      );
      for (const override of report.overrides) {
        validateSnapshot(
          checked.domains.find((domain) => domain.id === override.id),
          report.opensslResults.filter((result) => result.ip === override.certIp),
        );
      }
      report.persistedDomains = (await api("/domains")).domains;
      assert.deepEqual(report.persistedDomains, checked.domains);
    },
  );

  await step("upcoming expiry notification identifies the same earliest live IP", async () => {
    await api("/notifications/email", "PUT", { enabled: true });
    try {
      const upcoming = await api("/email/upcoming");
      report.upcoming = upcoming;
      const expected = report.singleCheck;
      const threshold =
        new Date(upcoming.nextRunAt).getTime() +
        upcoming.settings.effectiveThresholdDays * 86400000;
      if (Date.parse(expected.certExpiresAt) <= threshold) {
        const planned = upcoming.emails[0].domains.find((domain) => domain.domain === hostname);
        assert.equal(planned.certExpiresAt, expected.certExpiresAt);
        assert.ok(upcoming.emails[0].html.includes(expected.certIp));
      } else {
        assert.ok(
          !upcoming.emails.some((entry) =>
            entry.domains.some((domain) => domain.domain === hostname),
          ),
        );
      }
    } finally {
      await api("/notifications/email", "PUT", { enabled: false });
    }
  });
}

try {
  await run();
  report.status = "PASS";
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(`PASS: ${report.checks.length} live container checks for ${hostname}`);
} catch (error) {
  report.status = "FAIL";
  report.error = error.stack;
  await save();
  console.error(error);
  process.exitCode = 1;
}
