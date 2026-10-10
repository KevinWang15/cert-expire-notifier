import assert from "node:assert/strict";
import http from "node:http";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

const node = Number(process.env.FIXTURE_NODE);
assert.ok([1, 2, 3].includes(node));
const address = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry.family === "IPv4" && !entry.internal).address;
const directory = mkdtempSync(join(tmpdir(), "certificate-scenario-"));
const hosts = [
  { hostname: "checkout.example.test", label: "Checkout", days: [30, 2, 90] },
  { hostname: "api.example.test", label: "API", days: [45, 120, 7] },
  { hostname: "assets.example.test", label: "Assets", days: [21, 180, 60] },
];
const contexts = new Map();
const certificates = new Map();
const handshakes = [];

function issue(hostname, days) {
  const host = hosts.find((entry) => entry.hostname === hostname);
  assert.ok(host && Number.isInteger(days) && days > 0 && days <= 3650);
  const keyPath = join(directory, `${hostname}.key`);
  const certPath = join(directory, `${hostname}.pem`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      String(days),
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/O=Local Certificate Tests/CN=${host.label} IP ${node} - ${days} days`,
      "-addext",
      `subjectAltName=DNS:${hostname}`,
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  contexts.set(hostname, tls.createSecureContext({ key: readFileSync(keyPath), cert }));
  const parsed = new X509Certificate(cert);
  const issuer = parsed.toLegacyObject().issuer;
  certificates.set(hostname, {
    hostname,
    ip: address,
    node,
    days,
    expiresAt: new Date(parsed.validTo).toISOString(),
    issuer: [issuer.O, issuer.CN].filter(Boolean).join(" - "),
    fingerprint: parsed.fingerprint256,
  });
}
for (const host of hosts) issue(host.hostname, host.days[node - 1]);

const secure = tls.createServer(
  {
    SNICallback(hostname, callback) {
      const context = contexts.get(hostname);
      handshakes.push({ hostname, at: new Date().toISOString() });
      callback(context ? null : new Error("Unknown fixture hostname"), context);
    },
  },
  (socket) => {
    socket.on("error", () => {});
  },
);
secure.on("tlsClientError", () => {});
secure.listen(443, "0.0.0.0");

const admin = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/__admin/renew") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { hostname, days } = JSON.parse(body);
      issue(hostname, days);
    } else assert.ok(req.method === "GET" && req.url === "/__admin/state");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ node, address, certificates: [...certificates.values()], handshakes }),
    );
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});
admin.listen(8080, "0.0.0.0", () =>
  console.log(`Fixture IP ${node}: ${address}, three SNI certificates`),
);
