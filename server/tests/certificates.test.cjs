const assert = require("node:assert/strict");
const { test, before, after, beforeEach } = require("node:test");
const dns = require("node:dns").promises;
const tls = require("node:tls");
const net = require("node:net");
const http = require("node:http");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const { X509Certificate } = require("node:crypto");
const {
  checkCertForDomainWithRetries,
  summarizeCertificates,
} = require("../src/services/certChecker");
const { updateDomainCertificateState } = require("../src/services/domainCertificateState");
const {
  domainsExpiringBy,
  domainsWithCheckFailures,
  buildCertificateNotificationEmail,
} = require("../src/services/certificateNotifications");
const prisma = require("../src/prisma").default;

const originalProxyUrls = process.env.CERT_CHECK_PROXY_URLS;
const hostname = "certificates.example.test";
const servers = [];
const sockets = new Set();
const handshakes = [];
const certificates = {};
let fixtureDir;
let port;

function track(socket) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
}
async function listen(server, host, targetPort = 0) {
  server.on("connection", track);
  server.listen(targetPort, host);
  await once(server, "listening");
  servers.push(server);
  return server.address().port;
}
function resolve(t, addresses) {
  return t.mock.method(dns, "lookup", async (name, options) => {
    assert.equal(name, hostname);
    assert.equal(options.all, true);
    return addresses.map((address) => ({ address, family: net.isIP(address) }));
  });
}

before(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "cert-ip-tests-"));
  for (const [name, days] of [
    ["healthy", 90],
    ["expiring", 2],
  ]) {
    const keyFile = join(fixtureDir, `${name}.key`);
    const certFile = join(fixtureDir, `${name}.pem`);
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
        keyFile,
        "-out",
        certFile,
        "-subj",
        `/CN=${name} test issuer`,
      ],
      { stdio: "ignore" },
    );
    certificates[name] = { key: readFileSync(keyFile), cert: readFileSync(certFile) };
  }
  for (const [address, name] of [
    ["127.0.0.1", "healthy"],
    ["127.0.0.2", "expiring"],
    ["::1", "expiring"],
  ]) {
    const context = tls.createSecureContext(certificates[name]);
    const server = tls.createServer({
      ...certificates[name],
      SNICallback: (servername, callback) => {
        handshakes.push({ address, servername });
        callback(servername === hostname ? null : new Error("Wrong SNI"), context);
      },
    });
    const assignedPort = await listen(server, address, port);
    port ??= assignedPort;
  }
});
beforeEach(() => {
  delete process.env.CERT_CHECK_PROXY_URLS;
  handshakes.length = 0;
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (originalProxyUrls === undefined) delete process.env.CERT_CHECK_PROXY_URLS;
  else process.env.CERT_CHECK_PROXY_URLS = originalProxyUrls;
  await prisma.$disconnect();
});

test("checks every unique IPv4 and IPv6 address with domain SNI and selects matching earliest issuer", async (t) => {
  const lookup = resolve(t, ["127.0.0.1", "127.0.0.2", "::1", "127.0.0.1"]);
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`);
  assert.equal(lookup.mock.callCount(), 1);
  assert.deepEqual(
    result.ipResults.map((entry) => entry.ip),
    ["127.0.0.1", "127.0.0.2", "::1"],
  );
  assert.equal(result.error, null);
  assert.equal(result.issuer, "expiring test issuer");
  assert.equal(
    result.expiresAt.toISOString(),
    new Date(new X509Certificate(certificates.expiring.cert).validTo).toISOString(),
  );
  assert.ok(["127.0.0.2", "::1"].includes(result.ip));
  assert.equal(handshakes.length, 3);
  assert.ok(handshakes.every((entry) => entry.servername === hostname));
});

test("IP overrides skip DNS and only probe the requested IPv4 or IPv6 address", async (t) => {
  const lookup = t.mock.method(dns, "lookup", () => {
    throw new Error("DNS must not run");
  });
  for (const [address, literal] of [
    ["127.0.0.1", "127.0.0.1"],
    ["::1", "[::1]"],
  ]) {
    const result = await checkCertForDomainWithRetries(`${hostname}:${port}:${literal}`);
    assert.equal(result.error, null);
    assert.deepEqual(
      result.ipResults.map((entry) => entry.ip),
      [address],
    );
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test("retries failures independently without rechecking successful IPs or losing their earliest expiry", async (t) => {
  resolve(t, ["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
  const connect = t.mock.method(tls, "connect");
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`, 2);
  assert.match(result.error, /1 of 3 IP checks failed: 127\.0\.0\.3/);
  assert.equal(result.ip, "127.0.0.2");
  assert.equal(result.issuer, "expiring test issuer");
  assert.equal(result.ipResults[2].expiresAt, null);
  const hosts = connect.mock.calls.map((call) => call.arguments[0].host);
  assert.equal(hosts.filter((host) => host === "127.0.0.1").length, 1);
  assert.equal(hosts.filter((host) => host === "127.0.0.2").length, 1);
  assert.equal(hosts.filter((host) => host === "127.0.0.3").length, 2);
});

test("HTTP proxy fallback tunnels to the failing IP and preserves domain SNI", async (t) => {
  resolve(t, ["127.0.0.1", "127.0.0.3"]);
  const destinations = [];
  const proxy = http.createServer();
  proxy.on("connect", (request, downstream, head) => {
    destinations.push(request.url);
    const upstream = net.connect(port, "127.0.0.2", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(downstream).pipe(upstream);
    });
    track(upstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  const proxyPort = await listen(proxy, "127.0.0.1");
  process.env.CERT_CHECK_PROXY_URLS = `http://127.0.0.1:${proxyPort}`;
  // Repeated handshakes also exercise cleanup: aborting the underlying TCP
  // transport after wrapping it in TLS used to crash the Node 20 runtime.
  for (let i = 0; i < 3; i++) {
    const result = await checkCertForDomainWithRetries(`${hostname}:${port}`, 1);
    assert.equal(result.error, null);
    assert.equal(result.ip, "127.0.0.3");
    assert.equal(result.issuer, "expiring test issuer");
  }
  assert.deepEqual(destinations, Array(3).fill(`127.0.0.3:${port}`));
  assert.ok(handshakes.every((entry) => entry.servername === hostname));
});

test("SOCKS5 fallback sends the pinned IP rather than letting the proxy resolve the hostname", async (t) => {
  resolve(t, ["127.0.0.3"]);
  const destinations = [];
  const proxy = net.createServer((downstream) => {
    let buffer = Buffer.alloc(0);
    let greeted = false;
    const receive = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        downstream.write(Buffer.from([5, 0]));
        greeted = true;
      }
      if (buffer.length < 10) return;
      assert.equal(buffer[3], 1, "SOCKS destination must be an IPv4 literal");
      destinations.push(`${[...buffer.subarray(4, 8)].join(".")}:${buffer.readUInt16BE(8)}`);
      downstream.removeListener("data", receive);
      const upstream = net.connect(port, "127.0.0.2", () => {
        downstream.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 2, 0, 0]));
        if (buffer.length > 10) upstream.write(buffer.subarray(10));
        upstream.pipe(downstream).pipe(upstream);
      });
      track(upstream);
      downstream.on("close", () => upstream.destroy());
      upstream.on("close", () => downstream.destroy());
    };
    downstream.on("data", receive);
  });
  const proxyPort = await listen(proxy, "127.0.0.1");
  process.env.CERT_CHECK_PROXY_URLS = `socks5h://127.0.0.1:${proxyPort}`;
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`, 1);
  assert.equal(result.error, null);
  assert.equal(result.ip, "127.0.0.3");
  assert.equal(result.issuer, "expiring test issuer");
  assert.deepEqual(destinations, [`127.0.0.3:${port}`]);
  assert.deepEqual(handshakes, [{ address: "127.0.0.2", servername: hostname }]);
});

test("large DNS answers are checked in bounded batches without dropping any addresses", async (t) => {
  const addresses = Array.from({ length: 13 }, (_, index) => `192.0.2.${index + 1}`);
  resolve(t, addresses);
  let active = 0;
  let peak = 0;
  t.mock.method(require("../src/services/certificateProbe"), "probeCertificate", async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { expiresAt: new Date("2030-01-01"), issuer: "Test issuer", error: null };
  });
  const result = await checkCertForDomainWithRetries(hostname);
  assert.equal(result.error, null);
  assert.deepEqual(result.ipResults.map((entry) => entry.ip).sort(), addresses.sort());
  assert.ok(peak > 1 && peak <= 5);
});

test("DNS errors, empty answers and invalid targets cannot report success", async (t) => {
  t.mock.method(dns, "lookup", async () => {
    throw new Error("ENOTFOUND");
  });
  let result = await checkCertForDomainWithRetries(hostname);
  assert.match(result.error, /DNS lookup failed.*ENOTFOUND/);
  assert.deepEqual(result.ipResults, []);
  t.mock.restoreAll();
  resolve(t, []);
  result = await checkCertForDomainWithRetries(hostname);
  assert.match(result.error, /No IP addresses found/);
  result = await checkCertForDomainWithRetries("not a domain");
  assert.equal(result.error, "Invalid domain target");
  assert.equal(result.expiresAt, null);
});

test("expired certificates take precedence over future certificates and preserve issuer/IP pairing", () => {
  const result = summarizeCertificates([
    { ip: "192.0.2.1", expiresAt: new Date("2030-01-01"), issuer: "Later", error: null },
    { ip: "192.0.2.2", expiresAt: new Date("2000-01-01"), issuer: "Expired", error: null },
  ]);
  assert.equal(result.ip, "192.0.2.2");
  assert.equal(result.issuer, "Expired");
  assert.equal(result.expiresAt.getUTCFullYear(), 2000);
});

test("each persisted snapshot replaces removed IPs and clears stale certificates after total failure", async (t) => {
  let addresses = ["127.0.0.1", "127.0.0.2"];
  t.mock.method(dns, "lookup", async () => addresses.map((address) => ({ address, family: 4 })));
  const originalUpdate = prisma.domain.update;
  const update = t.mock.fn(async ({ data }) => data);
  prisma.domain.update = update;
  t.after(() => {
    prisma.domain.update = originalUpdate;
  });
  const first = await updateDomainCertificateState(7, `${hostname}:${port}`);
  assert.equal(first.certIp, "127.0.0.2");
  assert.equal(first.lastIpResults.length, 2);
  assert.equal(typeof first.lastIpResults[0].expiresAt, "string");
  addresses = ["127.0.0.1"];
  const second = await updateDomainCertificateState(7, `${hostname}:${port}`);
  assert.equal(second.certIp, "127.0.0.1");
  assert.ok(second.certExpiresAt > first.certExpiresAt);
  assert.equal(second.lastIpResults.length, 1);
  addresses = ["127.0.0.3"];
  const failed = await updateDomainCertificateState(7, `${hostname}:${port}`);
  assert.equal(failed.certExpiresAt, null);
  assert.equal(failed.certIssuer, null);
  assert.equal(failed.certIp, null);
  assert.match(failed.certError, /1 of 1 IP checks failed/);
  assert.equal(update.mock.callCount(), 3);
  assert.ok(update.mock.calls.every((call) => call.arguments[0].where.id === 7));
});

test("partial failures retain expiry alerts with the affected IP and deduplicate notification domain names", async () => {
  const domains = [
    {
      domain: hostname,
      certExpiresAt: new Date("2026-10-11"),
      certIp: "192.0.2.2",
      certError: "1 of 2 IP checks failed: 192.0.2.3 (Connection timeout)",
      notes: null,
    },
  ];
  const expiringDomains = domainsExpiringBy(domains, new Date("2026-10-20"));
  const failedDomains = domainsWithCheckFailures(domains);
  assert.equal(expiringDomains.length, 1);
  assert.equal(failedDomains.length, 1);
  const email = await buildCertificateNotificationEmail({
    user: { id: 1, name: "Test", email: "test@example.test" },
    expiringDomains,
    failedDomains,
    thresholdDays: 30,
    referenceDate: new Date("2026-10-10"),
  });
  assert.match(email.html, /Earliest expiry: 192\.0\.2\.2/);
  assert.match(email.text, /Earliest expiry IP: 192\.0\.2\.2/);
  assert.match(email.shortText, /\[192\.0\.2\.2\]/);
  assert.match(email.text, /192\.0\.2\.3 \(Connection timeout\)/);
  assert.deepEqual(email.domainNames, [hostname]);
  assert.equal(
    domainsExpiringBy([{ ...domains[0], certIp: null }], new Date("2026-10-20")).length,
    0,
    "Failed legacy snapshots may contain stale expiry data",
  );
});

test("stalled TLS and HTTP proxy handshakes time out and release their connections", async () => {
  const stalledSockets = new Set();
  const stalled = net.createServer((socket) => {
    stalledSockets.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => stalledSockets.delete(socket));
  });
  const stalledPort = await listen(stalled, "127.0.0.1");
  const { probeCertificate } = require("../src/services/certificateProbe");
  const started = Date.now();
  const results = await Promise.all([
    probeCertificate({ hostname, address: "127.0.0.1", port: stalledPort }),
    probeCertificate({ hostname, address: "127.0.0.3", port }, `http://127.0.0.1:${stalledPort}`),
  ]);
  for (const result of results) assert.equal(result.error, "Connection timeout");
  assert.ok(Date.now() - started < 12000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stalledSockets.size, 0);
});
