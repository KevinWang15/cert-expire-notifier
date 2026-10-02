const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const {
  expandWebhookTemplate,
  renderWebhookBody,
  isPublicWebhookAddress,
  sendWebhook,
} = require("../src/services/webhookService");
const { parseWebhookConfig } = require("../src/utils/webhook");
const { buildWebhookPayload } = require("../src/services/notificationService");
const { buildCertificateNotificationEmail } = require("../src/services/certificateNotifications");
const prisma = require("../src/prisma").default;

after(() => prisma.$disconnect());
const payload = {
  app: "cert-expire-notifier",
  purpose: "CERT_ALERT",
  subject: 'Alert "quoted" & / ? # % + = 中文',
  html: '<p>Quote " and newline\n中文 & /</p>',
  text: 'Quote " backslash \\ newline\n中文 & / ? # % + = $SUBJECT',
  shortText: "Short\n中文",
  details: ["a.example.test", "b.example.test"],
  requestedAt: "2026-10-02T00:00:00.000Z",
};

test("all variables expand once; URL values round-trip without changing path/query structure", () => {
  const url = new URL(
    expandWebhookTemplate(
      "https://example.com/$SUBJECT?text=$TEXT&html=$HTML&short=$SHORT_TEXT&purpose=$PURPOSE&details=$DETAILS&time=$TIMESTAMP",
      payload,
      true,
    ),
  );
  assert.equal(decodeURIComponent(url.pathname.slice(1)), payload.subject);
  for (const [key, value] of Object.entries({
    text: payload.text,
    html: payload.html,
    short: payload.shortText,
    purpose: payload.purpose,
    details: payload.details.join(", "),
    time: payload.requestedAt,
  }))
    assert.equal(url.searchParams.get(key), value);
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.size, 6);
  assert.equal(expandWebhookTemplate("$TEXT $UNKNOWN", payload), `${payload.text} $UNKNOWN`);
});

test("nested JSON string templates remain valid, and plain text is sent verbatim", () => {
  assert.deepEqual(
    JSON.parse(
      renderWebhookBody(
        '{"msgtype":"text","text":{"content":"$SHORT_TEXT"},"nested":["$TEXT","$HTML"]}',
        payload,
      ),
    ),
    { msgtype: "text", text: { content: payload.shortText }, nested: [payload.text, payload.html] },
  );
  assert.equal(
    renderWebhookBody("$SUBJECT\n$TEXT", payload),
    `${payload.subject}\n${payload.text}`,
  );
  assert.deepEqual(JSON.parse(renderWebhookBody(null, payload)), payload);
});

test("configuration accepts common HTTP methods and rejects unsafe headers and invalid templates", () => {
  const base = { name: "Relay", url: "https://example.com/", headers: { "X-Key": "value" } };
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert.equal(parseWebhookConfig({ ...base, method }).method, method);
  for (const invalid of [
    { method: "TRACE" },
    { method: {} },
    { enabled: "true" },
    { url: "file:///etc/passwd" },
    { url: "https://user:pass@example.com" },
    { url: "https://example.com/#fragment" },
    { headers: [] },
    { headers: { "X-Key": 42 } },
    { headers: { "X-Key": "value", "x-key": "duplicate" } },
    { headers: { Host: "private" } },
    { headers: { "Content-Length": "1" } },
    { headers: { Authorization: "token\r\nInjected: true" } },
    { bodyTemplate: "界".repeat(22000) },
    { bodyTemplate: {} },
  ])
    assert.throws(() => parseWebhookConfig({ ...base, ...invalid }));
});

test("private/reserved literal and DNS destinations are blocked with the default configuration", async () => {
  const previous = process.env.WEBHOOK_ALLOW_PRIVATE_IPS;
  delete process.env.WEBHOOK_ALLOW_PRIVATE_IPS;
  try {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
    ])
      assert.equal(isPublicWebhookAddress(address), false, address);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      assert.equal(isPublicWebhookAddress(address), true, address);
    const target = {
      ...parseWebhookConfig({ name: "Relay", url: "http://127.0.0.1:9/" }),
      id: 1,
      userId: 1,
    };
    await assert.rejects(sendWebhook(target, payload), /private or reserved/);
    await assert.rejects(
      sendWebhook({ ...target, url: "http://localhost:9/" }, payload),
      /private or reserved/,
    );
  } finally {
    if (previous === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_IPS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_IPS = previous;
  }
});

test("header substitutions reject newlines without exposing message contents", async () => {
  const target = {
    ...parseWebhookConfig({
      name: "Relay",
      url: "https://example.com/",
      headers: { "X-Message": "$TEXT" },
    }),
    id: 1,
    userId: 1,
  };
  await assert.rejects(sendWebhook(target, payload), {
    message: "Invalid rendered webhook header: x-message",
  });
});

test("certificate text includes expiry, failed checks and notes; short text retains useful domain details", async () => {
  const email = await buildCertificateNotificationEmail({
    user: { id: 1, name: "Test & User", email: "user@example.test" },
    expiringDomains: [
      {
        domain: "a.example.test:8443",
        certExpiresAt: new Date("2026-10-04T00:00:00Z"),
        notes: 'Renew "quoted"\n中文',
      },
    ],
    failedDomains: [{ domain: "b.example.test", certError: "TLS error & timeout", notes: null }],
    thresholdDays: 30,
    referenceDate: new Date("2026-10-02T00:00:00Z"),
  });
  assert.match(email.shortText, /a.example.test:8443: 2 days left/);
  assert.match(email.shortText, /b.example.test: TLS error & timeout/);
  assert.match(email.text, /Notes: Renew "quoted"\n中文/);
  assert.match(email.text, /Notification window: 30 days/);
  assert.match(email.html, /Test &amp; User/);
  const webhook = buildWebhookPayload(
    {
      userId: 1,
      to: "user@example.test",
      purpose: "CERT_ALERT",
      ...email,
      domains: email.domainNames,
    },
    new Date(payload.requestedAt),
  );
  assert.equal(webhook.text, email.text);
  assert.equal(webhook.shortText, email.shortText);
  assert.deepEqual(webhook.details, email.domainNames);
});
