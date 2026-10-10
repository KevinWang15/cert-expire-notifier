const assert = require("node:assert/strict");
const { test, before, after, beforeEach } = require("node:test");
const dns = require("node:dns").promises;
const tls = require("node:tls");
const net = require("node:net");
const http = require("node:http");
const timers = require("node:timers/promises");
const wait = timers.setTimeout;
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
const {
  getConfiguredProxyUrls,
  logCertCheckProxyConfig,
} = require("../src/services/certificateProxyConfig");

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

function tunnel(downstream, head, address = "127.0.0.2") {
  const upstream = net.connect(port, address, () => {
    downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(downstream).pipe(upstream);
  });
  track(upstream);
  downstream.on("close", () => upstream.destroy());
  upstream.on("close", () => downstream.destroy());
}

async function httpProxy(connect) {
  const requests = [];
  const server = http.createServer();
  server.on("connect", (request, downstream, head) => {
    requests.push(request);
    connect(request, downstream, head, requests.length);
  });
  const proxyPort = await listen(server, "127.0.0.1");
  return { server, requests, url: `http://127.0.0.1:${proxyPort}` };
}

async function stalledServer() {
  const active = new Set();
  const server = net.createServer((socket) => {
    active.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => active.delete(socket));
  });
  const stalledPort = await listen(server, "127.0.0.1");
  return { server, active, port: stalledPort };
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
beforeEach((t) => {
  delete process.env.CERT_CHECK_PROXY_URLS;
  handshakes.length = 0;
  // Speed up recovery pauses, leaving actual socket deadlines untouched.
  t.mock.method(timers, "setTimeout", (delay, value, options) =>
    wait(Math.min(delay, 20), value, options),
  );
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
  assert.equal(hosts.filter((host) => host === "127.0.0.3").length, 3);
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

test("proxy configuration accepts URL lists and structured authenticated bindings without duplicates or credential logs", (t) => {
  assert.deepEqual(
    getConfiguredProxyUrls(
      " http://proxy.example.test:8080,\nsocks5h://proxy.example.test:1080\nhttp://proxy.example.test:8080 ",
    ),
    ["http://proxy.example.test:8080/", "socks5h://proxy.example.test:1080"],
  );
  const bindings = [
    {
      type: "HTTPS",
      url: "proxy.example.test:8443",
      basicAuthUsername: "test-user",
      basicAuthPassword: "p%ss@:/word",
    },
    { type: "SOCKS5", url: "proxy.example.test:1080" },
    "http://proxy.example.test:8080",
  ];
  const urls = getConfiguredProxyUrls(JSON.stringify(bindings));
  assert.equal(new URL(urls[0]).protocol, "https:");
  assert.equal(decodeURIComponent(new URL(urls[0]).password), "p%ss@:/word");
  assert.equal(new URL(urls[1]).protocol, "socks5:");
  assert.deepEqual(getConfiguredProxyUrls(JSON.stringify({ proxies: bindings })), urls);
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(
    getConfiguredProxyUrls(
      JSON.stringify([
        null,
        { url: "ftp://test-user:secret@proxy.example.test" },
        "http://valid.example.test:8080",
      ]),
    ),
    ["http://valid.example.test:8080/"],
  );
  assert.equal(warn.mock.callCount(), 1);
  process.env.CERT_CHECK_PROXY_URLS = JSON.stringify(bindings);
  const log = t.mock.method(console, "log", () => {});
  logCertCheckProxyConfig();
  const output = JSON.stringify(
    [...warn.mock.calls, ...log.mock.calls].map((call) => call.arguments),
  );
  assert.doesNotMatch(output, /test-user|secret|p%ss|p%25ss/);
});

test("a successful direct check never contacts configured proxies", async (t) => {
  resolve(t, ["127.0.0.1"]);
  const proxy = await httpProxy((_request, socket) => socket.destroy());
  process.env.CERT_CHECK_PROXY_URLS = proxy.url;
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`);
  assert.equal(result.error, null);
  assert.equal(proxy.requests.length, 0);
  assert.equal(timers.setTimeout.mock.callCount(), 0);
});

test("all proxies start together and the first success cancels stalled routes without rechecking healthy IPs", async (t) => {
  resolve(t, ["127.0.0.1", "127.0.0.3"]);
  const stalledHttp = await stalledServer();
  const stalledSocks = await stalledServer();
  const rejected = await httpProxy((_request, socket) =>
    socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n"),
  );
  let ready;
  const healthy = await httpProxy((_request, socket, head) => {
    ready.then(() => tunnel(socket, head));
  });
  process.env.CERT_CHECK_PROXY_URLS = [
    rejected.url,
    `http://127.0.0.1:${stalledHttp.port}`,
    `socks5h://127.0.0.1:${stalledSocks.port}`,
    healthy.url,
  ].join(",");
  // Repeat cancellation while other agents own sockets to catch native TLS cleanup regressions.
  for (let run = 0; run < 3; run++) {
    ready = Promise.all([
      once(stalledHttp.server, "connection"),
      once(stalledSocks.server, "connection"),
      once(rejected.server, "connect"),
    ]);
    const started = Date.now();
    const result = await checkCertForDomainWithRetries(`${hostname}:${port}`);
    assert.equal(result.error, null);
    assert.equal(result.ip, "127.0.0.3");
    assert.equal(result.issuer, "expiring test issuer");
    assert.ok(
      Date.now() - started < 2000,
      "A stalled earlier proxy must not delay a healthy later proxy",
    );
    await wait(100);
    assert.equal(stalledHttp.active.size, 0);
    assert.equal(stalledSocks.active.size, 0);
  }
  assert.equal(handshakes.filter((entry) => entry.address === "127.0.0.1").length, 3);
  assert.ok(
    [...healthy.requests, ...rejected.requests].every(
      (request) => request.url === `127.0.0.3:${port}`,
    ),
  );
  assert.ok(handshakes.every((entry) => entry.servername === hostname));
});

test("a proxy recovering on its last retry succeeds after other routes exhaust their retries", async (t) => {
  resolve(t, ["127.0.0.3"]);
  const rejected = await httpProxy((_request, socket) =>
    socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n"),
  );
  const recovering = await httpProxy((_request, socket, head, attempt) => {
    if (attempt < 3) socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
    else wait(100).then(() => tunnel(socket, head));
  });
  process.env.CERT_CHECK_PROXY_URLS = JSON.stringify([
    rejected.url,
    {
      type: "HTTPS",
      url: recovering.url,
      basicAuthUsername: "test",
      basicAuthPassword: "temporary%@password",
    },
  ]);
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`);
  assert.equal(result.error, null);
  assert.equal(result.issuer, "expiring test issuer");
  assert.equal(rejected.requests.length, 3);
  assert.equal(recovering.requests.length, 3);
  assert.ok(
    recovering.requests.every(
      (request) =>
        request.headers["proxy-authorization"] ===
        `Basic ${Buffer.from("test:temporary%@password").toString("base64")}`,
    ),
  );
  assert.ok(timers.setTimeout.mock.calls.every((call) => call.arguments[0] === 10000));
});

test("a recovered direct route cancels proxy retries and clears the initial connection failure", async (t) => {
  resolve(t, ["127.0.0.1"]);
  let attempts = 0;
  const gate = net.createServer((downstream) => {
    attempts += 1;
    if (attempts === 1) {
      downstream.destroy();
      return;
    }
    const upstream = net.connect(port, "127.0.0.2", () => upstream.pipe(downstream).pipe(upstream));
    track(upstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  const gatePort = await listen(gate, "127.0.0.1");
  const proxy = await httpProxy((_request, socket) =>
    socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n"),
  );
  process.env.CERT_CHECK_PROXY_URLS = proxy.url;
  const result = await checkCertForDomainWithRetries(`${hostname}:${gatePort}`);
  assert.equal(result.error, null);
  assert.equal(result.issuer, "expiring test issuer");
  assert.equal(attempts, 2);
  await wait(100);
  assert.equal(proxy.requests.length, 1, "No proxy retry may run after direct recovery");
});

test("success for one IP leaves another IP's proxy recovery running and keeps the earliest certificate", async (t) => {
  resolve(t, ["127.0.0.3", "127.0.0.4"]);
  const attempts = new Map();
  const proxy = await httpProxy((request, socket, head) => {
    const count = (attempts.get(request.url) || 0) + 1;
    attempts.set(request.url, count);
    if (request.url === `127.0.0.3:${port}`) tunnel(socket, head);
    else if (count === 1) socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
    else tunnel(socket, head, "127.0.0.1");
  });
  process.env.CERT_CHECK_PROXY_URLS = proxy.url;
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`);
  assert.equal(result.error, null);
  assert.equal(result.ip, "127.0.0.3");
  assert.deepEqual(
    result.ipResults.map((entry) => entry.issuer),
    ["expiring test issuer", "healthy test issuer"],
  );
  assert.equal(attempts.get(`127.0.0.3:${port}`), 1);
  assert.equal(attempts.get(`127.0.0.4:${port}`), 2);
});

test("IPv6 overrides keep the address pinned through HTTP CONNECT recovery without DNS", async (t) => {
  t.mock.method(dns, "lookup", () => {
    throw new Error("DNS must not run");
  });
  const proxy = await httpProxy((_request, socket, head) => tunnel(socket, head));
  process.env.CERT_CHECK_PROXY_URLS = proxy.url;
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}:[::2]`);
  assert.equal(result.error, null);
  assert.equal(result.ip, "::2");
  assert.equal(proxy.requests[0].url, `[::2]:${port}`);
  assert.deepEqual(handshakes, [{ address: "127.0.0.2", servername: hostname }]);
});

test("temporary proxy failure gets a real ten-second recovery interval", async (t) => {
  timers.setTimeout.mock.restore();
  resolve(t, ["127.0.0.3"]);
  const attemptedAt = [];
  const proxy = await httpProxy((_request, socket, head, attempt) => {
    attemptedAt.push(Date.now());
    if (attempt === 1) socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
    else tunnel(socket, head);
  });
  process.env.CERT_CHECK_PROXY_URLS = proxy.url;
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`, 2);
  assert.equal(result.error, null);
  assert.equal(attemptedAt.length, 2);
  assert.ok(attemptedAt[1] - attemptedAt[0] >= 9900);
});

test("each IP fails only after direct and every configured proxy exhaust their own retries", async (t) => {
  resolve(t, ["127.0.0.1", "127.0.0.3", "127.0.0.4"]);
  const rejected = await httpProxy((_request, socket) =>
    socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n"),
  );
  const closed = await httpProxy((_request, socket) => socket.destroy());
  process.env.CERT_CHECK_PROXY_URLS = `${rejected.url},${closed.url}`;
  const connect = t.mock.method(tls, "connect");
  const result = await checkCertForDomainWithRetries(`${hostname}:${port}`, 3);
  assert.equal(result.ip, "127.0.0.1");
  assert.match(result.error, /2 of 3 IP checks failed/);
  for (const address of ["127.0.0.3", "127.0.0.4"]) {
    assert.equal(connect.mock.calls.filter((call) => call.arguments[0].host === address).length, 4);
    assert.equal(
      rejected.requests.filter((request) => request.url === `${address}:${port}`).length,
      3,
    );
    assert.equal(
      closed.requests.filter((request) => request.url === `${address}:${port}`).length,
      3,
    );
    assert.match(
      result.ipResults.find((entry) => entry.ip === address).error,
      /All 3 connection routes failed: direct .*proxy 1 .*proxy 2/,
    );
  }
  assert.equal(result.ipResults[0].error, null);
});

test("cancelling direct, HTTP and SOCKS handshakes closes sockets and already-cancelled probes never connect", async (t) => {
  const stalled = await stalledServer();
  const { probeCertificate } = require("../src/services/certificateProbe");
  const controller = new AbortController();
  const target = { hostname, address: "127.0.0.1", port: stalled.port };
  const probes = [
    undefined,
    `http://127.0.0.1:${stalled.port}`,
    `socks5h://127.0.0.1:${stalled.port}`,
  ].map((url) => probeCertificate(target, url, controller.signal));
  for (let retry = 0; retry < 100 && stalled.active.size < 3; retry++) await wait(10);
  assert.equal(stalled.active.size, 3);
  controller.abort();
  const results = await Promise.all(probes);
  assert.ok(results.every((result) => result.error === "Certificate check cancelled"));
  await wait(100);
  assert.equal(stalled.active.size, 0);
  const connect = t.mock.method(tls, "connect");
  assert.equal(
    (await probeCertificate(target, undefined, controller.signal)).error,
    "Certificate check cancelled",
  );
  assert.equal(connect.mock.callCount(), 0);
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

test("stalled TLS, HTTP and SOCKS handshakes time out and release their connections", async () => {
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
    probeCertificate(
      { hostname, address: "127.0.0.3", port },
      `socks5h://127.0.0.1:${stalledPort}`,
    ),
  ]);
  for (const result of results) assert.equal(result.error, "Connection timeout");
  assert.ok(Date.now() - started < 12000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stalledSockets.size, 0);
});
