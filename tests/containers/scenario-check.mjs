import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { readFile, writeFile } from "node:fs/promises";

const reportPath = "/artifacts/scenario-report.json";
const prior = await readFile(reportPath, "utf8")
  .then(JSON.parse)
  .catch(() => null);
const report = { status: "RUNNING", startedAt: new Date().toISOString(), checks: [] };
const app = "http://app:3000/api";
let token;

async function api(path, method = "GET", body, status = 200) {
  const response = await fetch(`${app}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
function passed(name) {
  report.checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  report.nodes = await Promise.all(
    [1, 2, 3].map(async (node) =>
      (await fetch(`http://certificate-node-${node}:8080/__admin/state`)).json(),
    ),
  );
  const addresses = report.nodes.map((node) => node.address).sort();
  assert.equal(new Set(addresses).size, 3);
  report.certificates = report.nodes.flatMap((node) => node.certificates);
  assert.equal(new Set(report.certificates.map((cert) => cert.fingerprint)).size, 9);
  const expectedDays = {
    "checkout.example.test": [30, 2, 90],
    "api.example.test": [45, 120, 7],
    "assets.example.test": [21, 180, 60],
  };
  for (const [hostname, days] of Object.entries(expectedDays)) {
    const resolved = await dns.lookup(hostname, { all: true });
    assert.deepEqual(resolved.map((record) => record.address).sort(), addresses);
    const certs = report.certificates
      .filter((cert) => cert.hostname === hostname)
      .sort((a, b) => a.node - b.node);
    assert.deepEqual(
      certs.map((cert) => cert.days),
      days,
    );
  }
  passed("three fake hosts each resolve to three local IPs with nine distinct certificates");

  if (prior?.account?.token) {
    token = prior.account.token;
    for (const domain of (await api("/domains")).domains)
      await api(`/domains/${domain.id}`, "DELETE");
    token = undefined;
  }
  report.account = {
    email: `container-scenario-${Date.now()}@example.test`,
    password: "Container-scenario-123!",
    name: "Local certificate fixtures",
  };
  await api("/auth/signup", "POST", report.account, 201);
  const requests = (await (await fetch("http://email:8080/__admin/requests")).json()).requests;
  const message = requests.findLast((entry) => entry.body?.to?.includes(report.account.email));
  const link = message.body.body.content.html
    .match(/href="([^"]+\/verify-email\?token=[^"]+)"/)[1]
    .replaceAll("&amp;", "&");
  token = (
    await api("/auth/verify-email", "POST", { token: new URL(link).searchParams.get("token") })
  ).token;
  report.account.token = token;
  await api("/notifications/email", "PUT", { enabled: false });
  for (const hostname of Object.keys(expectedDays)) {
    await api(
      "/domains",
      "POST",
      {
        domain: hostname,
        notes: `Local TLS fixture: ${expectedDays[hostname].join(" / ")} days across three IPs.`,
      },
      201,
    );
  }
  passed("isolated test account created through public APIs with local email verification");

  const checked = await api("/domains/check-all", "POST");
  assert.equal(checked.checked, 3);
  report.domains = checked.domains;
  for (const domain of checked.domains) {
    const expected = report.certificates.filter((cert) => cert.hostname === domain.domain);
    assert.deepEqual(domain.lastIpResults.map((cert) => cert.ip).sort(), addresses);
    for (const certificate of expected) {
      const actual = domain.lastIpResults.find((entry) => entry.ip === certificate.ip);
      assert.equal(actual.expiresAt, certificate.expiresAt);
      assert.equal(actual.issuer, certificate.issuer);
      assert.equal(actual.error, null);
    }
    const shortest = expected.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0];
    assert.equal(domain.certExpiresAt, shortest.expiresAt);
    assert.equal(domain.certIssuer, shortest.issuer);
    assert.equal(domain.certIp, shortest.ip);
    assert.equal(domain.certError, null);
    passed(
      `${domain.domain}: all three IP certificates match; summary selects ${shortest.days} days on IP ${shortest.node}`,
    );
  }
  for (const node of report.nodes) {
    const state = await (
      await fetch(`http://certificate-node-${node.node}:8080/__admin/state`)
    ).json();
    assert.deepEqual(
      [...new Set(state.handshakes.map((entry) => entry.hostname))].sort(),
      Object.keys(expectedDays).sort(),
    );
  }
  passed("each local IP received a TLS handshake with the correct hostname SNI");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
