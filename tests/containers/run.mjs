import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const app = process.env.APP_URL;
const email = process.env.EMAIL_URL;
const webhook = process.env.WEBHOOK_URL;
const certificate = process.env.CERTIFICATE_URL;
assert.equal(new URL(app).hostname, "app", "Use this runner only inside the test Compose stack");
const reportPath = "/artifacts/report.json";
const previousReport = await readFile(reportPath, "utf8")
  .then(JSON.parse)
  .catch(() => null);
const previousLiveReport = await readFile("/artifacts/live-certificate-report.json", "utf8")
  .then(JSON.parse)
  .catch(() => null);
const previousScenarioReport = await readFile("/artifacts/scenario-report.json", "utf8")
  .then(JSON.parse)
  .catch(() => null);
const persistence = process.argv.includes("--persistence");
const cron = process.argv.includes("--cron");
const report =
  persistence || cron
    ? JSON.parse(await readFile(reportPath, "utf8"))
    : {
        startedAt: new Date().toISOString(),
        status: "RUNNING",
        steps: [],
      };
let owner, stranger;

async function saveReport() {
  await mkdir("/artifacts", { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}

async function step(name, action) {
  const started = Date.now();
  process.stdout.write(`RUN  ${name}\n`);
  try {
    await action();
    report.steps.push({ name, status: "PASS", durationMs: Date.now() - started });
    process.stdout.write(`PASS ${name} (${Date.now() - started} ms)\n`);
  } catch (error) {
    report.steps.push({
      name,
      status: "FAIL",
      durationMs: Date.now() - started,
      error: error.stack,
    });
    throw error;
  } finally {
    await saveReport();
  }
}

async function call(
  base,
  path,
  { method = "GET", body, token, status = 200, timeout = 90000 } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
const api = (path, options = {}, account = owner) =>
  call(app, `/api${path}`, { token: account?.token, ...options });
const records = async (base) => (await call(base, "/__admin/requests")).requests;
const emailRecords = async (account) =>
  (await records(email)).filter((record) => record.body?.to?.includes(account.email));
const adminState = (base, state) => call(base, "/__admin/state", { method: "PUT", body: state });
const settings = () => api("/notifications/settings");
const history = () => api("/notifications/history?limit=100");
const domains = async () => (await api("/domains")).domains;

async function createAccount(label) {
  const account = {
    email: `container-${label}-${Date.now()}@example.test`.toLowerCase(),
    password: "Container-test-123!",
    name: `Container ${label} "用户" & / ? # % + = $TEXT \\`,
  };
  const signup = await api("/auth/signup", { method: "POST", body: account, status: 201 }, null);
  assert.equal(signup.emailDeliveryStatus, "SENT");
  await api("/auth/login", { method: "POST", body: account, status: 403 }, null);
  const messages = await emailRecords(account);
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.responseStatus, 200);
  assert.equal(message.headers.host, "email.api.engagelab.cc");
  assert.equal(message.headers.authorization, "(present)");
  const link = message.body.body.content.html
    .match(/href="([^"]+\/verify-email\?token=[^"]+)"/)[1]
    .replaceAll("&amp;", "&");
  const verificationToken = new URL(link).searchParams.get("token");
  const verified = await api(
    "/auth/verify-email",
    { method: "POST", body: { token: verificationToken } },
    null,
  );
  await api(
    "/auth/verify-email",
    { method: "POST", body: { token: verificationToken }, status: 400 },
    null,
  );
  account.token = verified.token;
  const login = await api("/auth/login", { method: "POST", body: account }, null);
  assert.equal(login.user.email, account.email);
  account.token = login.token;
  return account;
}

function webhookConfig(overrides = {}) {
  return {
    name: "Container JSON relay",
    enabled: true,
    url: `${webhook}/receive`,
    method: "POST",
    headers: {},
    bodyTemplate: null,
    ...overrides,
  };
}
async function createWebhook(config, account = owner) {
  return (
    await api("/notifications/webhooks", { method: "POST", body: config, status: 201 }, account)
  ).webhook;
}
const setWebhook = (target, overrides, account = owner) =>
  api(
    `/notifications/webhooks/${target.id}`,
    { method: "PUT", body: { ...target, ...overrides } },
    account,
  );
const setEmail = (enabled, account = owner) =>
  api("/notifications/email", { method: "PUT", body: { enabled } }, account);
const testTarget = (target, status = 200, account = owner) =>
  api(`/notifications/webhooks/${target.id}/test`, { method: "POST", status }, account);

async function poll(action, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for scheduled notification");
}
const alerts = async (account) =>
  (await api("/notifications/history?limit=100", {}, account)).entries.filter(
    (entry) => entry.purpose === "CERT_ALERT",
  );
async function addDomain(domain, account = owner) {
  return (
    await api(
      "/domains",
      {
        method: "POST",
        status: 201,
        body: { domain, notes: 'Renew "quoted" certificate\n中文 & slash \\' },
      },
      account,
    )
  ).domain;
}

async function run() {
  if (persistence || cron) {
    owner = { ...report.demo };
    owner.token = (await api("/auth/login", { method: "POST", body: owner }, null)).token;
  }
  if (persistence) {
    await step(
      "settings and delivery history persist after restarting the production container",
      async () => {
        const exported = await api("/config/export");
        assert.deepEqual(exported.notifications, report.expectedConfig.notifications);
        assert.deepEqual(exported.domains, report.expectedConfig.domains);
        assert.deepEqual((await history()).entries, report.expectedHistory);
        const savedDomains = await domains();
        assert.equal(savedDomains.length, 3);
        assert.ok(savedDomains.every((domain) => domain.lastCheckedAt));
        const multiDomains = (await api("/domains", {}, report.multiIp)).domains;
        assert.deepEqual(
          multiDomains.map(({ certExpiresAt, certIssuer, certIp, certError, lastIpResults }) => ({
            certExpiresAt,
            certIssuer,
            certIp,
            certError,
            lastIpResults,
          })),
          report.expectedIpSnapshots,
        );
      },
    );
    report.status = "PASS";
    report.finishedAt = new Date().toISOString();
    await saveReport();
    console.log(`PASS: ${report.steps.length} container checks; report: ${reportPath}`);
    return;
  }
  if (cron) {
    const webhookOnly = report.webhookOnly;
    const retry = report.retry;
    const disabled = report.disabled;
    for (const account of [webhookOnly, retry, disabled])
      account.token = (await api("/auth/login", { method: "POST", body: account }, null)).token;
    await step(
      "real cron checks TLS and sends a grouped certificate alert through all enabled targets",
      async () => {
        await poll(
          async () => (await alerts(owner)).filter((entry) => entry.status === "SENT").length === 3,
        );
        const sent = (await records(webhook)).filter(
          (record) =>
            record.body?.purpose === "CERT_ALERT" || record.headers["x-purpose"] === "CERT_ALERT",
        );
        const payload = sent.find((record) => record.url === "/receive").body;
        const message = (await emailRecords(owner)).find(
          (record) => record.body.body.subject === payload.subject,
        );
        assert.ok(message.body.body.content.html.startsWith(payload.html));
        assert.equal(payload.app, "cert-expire-notifier");
        assert.deepEqual(payload.details, [
          "expiring.example.test:8443",
          "broken.example.test:9443",
        ]);
        assert.ok(!payload.text.includes("healthy.example.test"));
        assert.match(payload.text, /Notes: Renew "quoted" certificate\n中文/);
        assert.match(payload.text, /Notification window: 30 days/);
        assert.match(payload.shortText, /expiring.example.test:8443: -?\d+ days left/);
        assert.match(payload.shortText, /broken.example.test:9443:/);
        assert.ok(!Number.isNaN(Date.parse(payload.requestedAt)));
        const wechat = sent.find((record) => record.url === "/wechat");
        assert.equal(wechat.body.text.content, payload.shortText);
        assert.equal(wechat.body.full, payload.text);
        assert.equal(wechat.headers["x-purpose"], "CERT_ALERT");
        assert.ok(!sent.some((record) => record.url === "/disabled"));
        assert.equal((await alerts(owner)).filter((entry) => entry.status === "FAILED").length, 1);
        report.samples = { email: message.body, webhook: payload, wechat: wechat.body };
        await writeFile("/artifacts/payloads.json", JSON.stringify(report.samples, null, 2) + "\n");
      },
    );
    await step(
      "webhook-only delivery advances the daily limit and upcoming notification schedule",
      async () => {
        await poll(async () =>
          (await alerts(webhookOnly)).some((entry) => entry.status === "SENT"),
        );
        assert.ok((await alerts(webhookOnly)).every((entry) => entry.channel === "WEBHOOK"));
        const upcoming = await api("/email/upcoming", {}, webhookOnly);
        assert.equal(upcoming.emails[0].sentToday, true);
        assert.ok(
          new Date(upcoming.nextRunAt).toISOString().slice(0, 10) !==
            new Date().toISOString().slice(0, 10),
        );
        const before = (await alerts(webhookOnly)).length;
        await poll(
          async () =>
            (await alerts(retry)).filter((entry) => entry.status === "FAILED").length >= 2,
        );
        assert.equal((await alerts(webhookOnly)).length, before);
        assert.equal((await alerts(owner)).length, 4);
      },
    );
    await step(
      "all-failed deliveries retry on later cron runs and stop after recovery",
      async () => {
        const failed = await alerts(retry);
        assert.ok(failed.length >= 2 && failed.every((entry) => entry.status === "FAILED"));
        assert.equal((await api("/email/upcoming", {}, retry)).emails[0].sentToday, false);
        await adminState(webhook, { routes: { "/retry": { status: 200 } } });
        await poll(async () => (await alerts(retry)).some((entry) => entry.status === "SENT"));
        const before = (await alerts(retry)).length;
        const now = Date.now();
        await poll(async () => Date.now() - now > 6500);
        assert.equal((await alerts(retry)).length, before);
        assert.equal((await alerts(disabled)).length, 0);
        const upcoming = await api("/email/upcoming", {}, disabled);
        assert.equal(upcoming.nextRunAt, null);
        assert.match(upcoming.note, /Enable an email or webhook/);
        // Keep auxiliary test accounts from generating alerts on subsequent runs.
        for (const account of [webhookOnly, retry, disabled]) {
          for (const domain of (await api("/domains", {}, account)).domains)
            await api(`/domains/${domain.id}`, { method: "DELETE" }, account);
        }
      },
    );
    report.expectedConfig = await api("/config/export");
    report.expectedHistory = (await history()).entries;
    report.expectedIpSnapshots = (await api("/domains", {}, report.multiIp)).domains.map(
      ({ certExpiresAt, certIssuer, certIp, certError, lastIpResults }) => ({
        certExpiresAt,
        certIssuer,
        certIp,
        certError,
        lastIpResults,
      }),
    );
    report.status = "AWAITING_RESTART_CHECK";
    await saveReport();
    return;
  }

  await step("production image serves the dashboard and API", async () => {
    assert.match(await call(app, "/"), /<div id="root">/);
    assert.equal((await api("/health", {}, null)).app, "cert-expire-notifier");
    const asset = (await call(app, "/")).match(/src="([^"]+\.js)"/)[1];
    assert.match(await call(app, asset), /Notifications/);
  });
  await step("signup, verification and login use the mock EngageLab HTTPS API", async () => {
    // Retire fixture domains from a prior run before exercising the shared scheduler again.
    for (const account of [
      previousReport?.demo,
      previousReport?.webhookOnly,
      previousReport?.retry,
      previousReport?.disabled,
      previousReport?.multiIp,
      previousLiveReport?.account,
      previousScenarioReport?.account,
    ]) {
      if (!account?.token || !account.email?.startsWith("container-")) continue;
      for (const domain of (await api("/domains", {}, account)).domains)
        await api(`/domains/${domain.id}`, { method: "DELETE" }, account);
    }
    for (const base of [email, webhook, certificate])
      await call(base, "/__admin/reset", { method: "POST" });
    owner = await createAccount("monitor");
    stranger = await createAccount("stranger");
    report.demo = { ...owner, appUrl: process.env.PUBLIC_APP_URL };
  });
  await step("email starts enabled and multiple webhook targets can be configured", async () => {
    assert.deepEqual((await settings()).email, { address: owner.email, enabled: true });
    report.targets = [
      await createWebhook(webhookConfig()),
      await createWebhook(
        webhookConfig({
          name: "WeChat text relay",
          url: `${webhook}/wechat`,
          headers: { "X-Purpose": "$PURPOSE" },
          bodyTemplate: '{"msgtype":"text","text":{"content":"$SHORT_TEXT"},"full":"$TEXT"}',
        }),
      ),
      await createWebhook(webhookConfig({ name: "Failing relay", url: `${webhook}/fail` })),
      await createWebhook(
        webhookConfig({ name: "Disabled relay", url: `${webhook}/disabled`, enabled: false }),
      ),
    ];
  });
  await step("authentication, validation and ownership protect targets and history", async () => {
    await api("/notifications/settings", { status: 401 }, null);
    const target = report.targets[0];
    for (const [method, suffix] of [
      ["PUT", ""],
      ["DELETE", ""],
      ["POST", "/test"],
    ])
      await api(
        `/notifications/webhooks/${target.id}${suffix}`,
        { method, body: method === "PUT" ? webhookConfig() : undefined, status: 404 },
        stranger,
      );
    assert.deepEqual((await api("/notifications/settings", {}, stranger)).webhooks, []);
    assert.ok(
      (await api("/notifications/history", {}, stranger)).entries.every(
        (entry) => entry.channel === "EMAIL",
      ),
    );
    for (const config of [
      { url: "file:///etc/passwd" },
      { url: "https://user:pass@example.com" },
      { method: "TRACE" },
      { headers: { Authorization: "token\r\nInjected: yes" } },
      { headers: { Host: "internal" } },
      { headers: { "Content-Length": "10" } },
      { headers: [] },
      { bodyTemplate: {} },
      { enabled: "true" },
    ])
      await api("/notifications/webhooks", {
        method: "POST",
        body: webhookConfig(config),
        status: 400,
      });
    await api("/notifications/webhooks/invalid", { method: "DELETE", status: 400 });
  });
  await step(
    "test send fans out; failed targets do not block email or other webhooks",
    async () => {
      const result = await api("/notifications/test", { method: "POST" });
      assert.deepEqual(
        result.deliveries.map((delivery) => delivery.status),
        ["SENT", "SENT", "SENT", "FAILED"],
      );
      assert.equal((await records(webhook)).length, 3);
      assert.equal(result.deliveries.at(-1).error, "Webhook returned HTTP 503");
      const payload = (await records(webhook)).find((record) => record.url === "/receive").body;
      const wechat = (await records(webhook)).find((record) => record.url === "/wechat").body;
      assert.equal(wechat.full, payload.text);
      assert.equal(wechat.text.content, payload.shortText);
      assert.ok(payload.text.includes(owner.name));
    },
  );
  await step("email provider failure and disabled email do not block webhook tests", async () => {
    await adminState(email, { status: 503 });
    const failed = await api("/notifications/test", { method: "POST" });
    assert.deepEqual(
      failed.deliveries.map((delivery) => delivery.status),
      ["FAILED", "SENT", "SENT", "FAILED"],
    );
    await adminState(email, { status: 200 });
    await setEmail(false);
    const before = (await emailRecords(owner)).length;
    const result = await api("/notifications/test", { method: "POST" });
    assert.deepEqual(
      result.deliveries.map((delivery) => delivery.status),
      ["SENT", "SENT", "FAILED"],
    );
    assert.equal((await emailRecords(owner)).length, before);
  });
  await step(
    "each HTTP method substitutes variables; URL values survive reserved characters and Unicode",
    async () => {
      for (const methods of [
        ["GET", "POST", "PUT", "PATCH"],
        ["DELETE", "HEAD", "OPTIONS"],
      ]) {
        const transport = await createAccount(`transport-${methods[0]}`);
        await setEmail(false, transport);
        const target = await createWebhook(webhookConfig({ enabled: false }), transport);
        for (const method of methods) {
          await setWebhook(
            target,
            {
              method,
              url: `${webhook}/method/$SUBJECT?text=$TEXT&short=$SHORT_TEXT&details=$DETAILS&time=$TIMESTAMP`,
              headers: { "X-Purpose": "$PURPOSE" },
              bodyTemplate:
                method === "PUT" ? "$TEXT" : '{"text":"$TEXT","html":"$HTML","subject":"$SUBJECT"}',
            },
            transport,
          );
          await testTarget(target, 200, transport);
          const record = (await records(webhook)).at(-1);
          const url = new URL(record.url, webhook);
          assert.equal(record.method, method);
          assert.ok(url.searchParams.get("text").includes(transport.name));
          assert.equal(url.searchParams.get("details"), "");
          assert.ok(!Number.isNaN(Date.parse(url.searchParams.get("time"))));
          assert.equal(
            decodeURIComponent(url.pathname.split("/").at(-1)),
            "Cert Expire Notifier - Test Email",
          );
          assert.equal(record.headers["x-purpose"], "TEST_EMAIL");
          if (["GET", "HEAD"].includes(method)) assert.equal(record.rawBody, "");
          else if (method === "PUT") {
            assert.equal(record.rawBody, url.searchParams.get("text"));
            assert.match(record.headers["content-type"], /^text\/plain/);
          } else assert.equal(record.body.text, url.searchParams.get("text"));
        }
      }
    },
  );
  await step(
    "redirects and timeouts fail safely; all-failed and no-target tests return errors",
    async () => {
      const account = await createAccount("errors");
      await setEmail(false, account);
      const target = await createWebhook(webhookConfig({ url: `${webhook}/redirect` }), account);
      assert.equal(
        (await testTarget(target, 502, account)).deliveries[0].error,
        "Webhook returned HTTP 302",
      );
      assert.ok(!(await records(certificate)).some((record) => record.url === "/redirect-target"));
      await setWebhook(target, { url: `${webhook}/slow` }, account);
      const started = Date.now();
      await testTarget(target, 502, account);
      assert.ok(Date.now() - started >= 9000 && Date.now() - started < 15000);
      await poll(async () => (await records(webhook)).at(-1).aborted);
      await setWebhook(target, { url: `${webhook}/fail` }, account);
      assert.equal((await testTarget(target, 502, account)).sent, false);
      await setWebhook(target, { enabled: false }, account);
      const before = (await records(webhook)).length;
      assert.deepEqual(
        (await api("/notifications/test", { method: "POST", status: 502 }, account)).deliveries,
        [],
      );
      assert.equal((await records(webhook)).length, before);
    },
  );
  await step(
    "password recovery and legacy email test work with monitoring email disabled",
    async () => {
      const before = (await records(webhook)).length;
      await api("/auth/forgot-password", { method: "POST", body: { email: owner.email } }, null);
      const message = (await emailRecords(owner)).at(-1);
      assert.match(message.body.body.subject, /Reset/);
      assert.equal(message.responseStatus, 200);
      const link = message.body.body.content.html
        .match(/href="([^"]+\/reset-password\?token=[^"]+)"/)[1]
        .replaceAll("&amp;", "&");
      const token = new URL(link).searchParams.get("token");
      owner.password = "Container-test-456!";
      await api(
        "/auth/reset-password",
        { method: "POST", body: { token, password: owner.password } },
        null,
      );
      owner.token = (await api("/auth/login", { method: "POST", body: owner }, null)).token;
      await api("/email/test", { method: "POST" });
      assert.equal((await records(webhook)).length, before);
      report.demo = { ...owner, appUrl: process.env.PUBLIC_APP_URL };
    },
  );
  await step(
    "export/import preserves targets, supports old files, and rejects invalid files atomically",
    async () => {
      const exported = await api("/config/export");
      const before = (await history()).entries.filter((entry) => entry.channel === "WEBHOOK");
      for (const target of (await settings()).webhooks)
        await api(`/notifications/webhooks/${target.id}`, { method: "DELETE" });
      assert.deepEqual(
        (await history()).entries.filter((entry) => entry.channel === "WEBHOOK"),
        before,
      );
      await api("/config/import", { method: "POST", body: exported });
      assert.deepEqual((await api("/config/export")).notifications, exported.notifications);
      const legacy = { ...exported };
      delete legacy.notifications;
      await api("/config/import", { method: "POST", body: legacy });
      assert.deepEqual((await api("/config/export")).notifications, exported.notifications);
      await api("/config/import", {
        method: "POST",
        status: 400,
        body: {
          ...exported,
          notifications: {
            emailEnabled: true,
            webhooks: [webhookConfig({ url: "ftp://invalid" })],
          },
        },
      });
      assert.deepEqual((await api("/config/export")).notifications, exported.notifications);
    },
  );
  await step(
    "real TLS certificates and failed checks populate upcoming certificate alerts",
    async () => {
      await setEmail(true);
      await addDomain("expiring.example.test:8443");
      await addDomain("healthy.example.test:8444");
      await addDomain("broken.example.test:9443");
      const checked = await api("/domains/check-all", { method: "POST" });
      assert.equal(checked.checked, 3);
      assert.ok(checked.domains[0].certExpiresAt && !checked.domains[0].certError);
      assert.ok(checked.domains[1].certExpiresAt && !checked.domains[1].certError);
      assert.ok(checked.domains[2].certError);
      const upcoming = await api("/email/upcoming");
      // The preview uses the future scheduled run; the active worker checks today's alert window.
      assert.ok(
        upcoming.emails[0].domains.some((domain) => domain.domain === "expiring.example.test:8443"),
      );
      assert.equal(upcoming.emails[0].failedDomains.length, 1);
      assert.equal(upcoming.emails[0].sentToday, false);
      for (const [label, enabled, path] of [
        ["webhook-only", true, "/webhook-only"],
        ["retry", true, "/retry"],
        ["disabled", false, "/never"],
      ]) {
        const account = await createAccount(label);
        await setEmail(false, account);
        await createWebhook(webhookConfig({ url: `${webhook}${path}`, enabled }), account);
        await addDomain("expiring.example.test:8443", account);
        report[label === "webhook-only" ? "webhookOnly" : label] = account;
      }
      await adminState(webhook, { routes: { "/retry": { status: 503 } } });
    },
  );
  report.status = "AWAITING_CRON_CHECK";
  await step(
    "multiple DNS addresses persist distinct certificates and partial failures without hiding expiry",
    async () => {
      report.multiIp = stranger;
      await addDomain("healthy.example.test:8444", stranger);
      const multi = await addDomain("multi.example.test:8443", stranger);
      const partial = await addDomain("partial.example.test:8445", stranger);
      const single = (await api(`/domains/${multi.id}/check`, { method: "POST" }, stranger)).domain;
      assert.equal(single.lastIpResults.length, 2);
      assert.equal(single.certError, null);
      const sorted = [...single.lastIpResults].sort(
        (a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt),
      );
      assert.ok(Date.parse(sorted[0].expiresAt) < Date.parse(sorted[1].expiresAt));
      assert.equal(single.certExpiresAt, sorted[0].expiresAt);
      assert.equal(single.certIssuer, sorted[0].issuer);
      assert.equal(single.certIp, sorted[0].ip);
      const checked = (await api("/domains/check-all", { method: "POST" }, stranger)).domains;
      const failed = checked.find((domain) => domain.id === partial.id);
      assert.equal(failed.lastIpResults.length, 2);
      assert.equal(failed.lastIpResults.filter((entry) => entry.error).length, 1);
      assert.ok(failed.certExpiresAt && failed.certIp);
      assert.match(failed.certError, /1 of 2 IP checks failed/);
      const upcoming = (await api("/email/upcoming", {}, stranger)).emails[0];
      assert.ok(upcoming.domains.some((domain) => domain.domain === partial.domain));
      assert.ok(upcoming.failedDomains.some((domain) => domain.domain === partial.domain));
      assert.ok(upcoming.html.includes(failed.certIp));
      await setEmail(false, stranger);
      // Import resets the snapshot along with the scalar certificate fields.
      const exported = await api("/config/export", {}, stranger);
      await api("/config/import", { method: "POST", body: exported }, stranger);
      const reset = (await api("/domains", {}, stranger)).domains;
      assert.ok(
        reset.every((domain) => domain.certIp === null && domain.lastIpResults.length === 0),
      );
      await api("/domains/check-all", { method: "POST" }, stranger);
    },
  );
  await saveReport();
  console.log(`PASS: ${report.steps.length} checks before the scheduled notification phase.`);
}

try {
  await run();
} catch (error) {
  report.status = "FAIL";
  report.finishedAt = new Date().toISOString();
  report.error = error.stack;
  await saveReport();
  console.error(error);
  process.exitCode = 1;
}
