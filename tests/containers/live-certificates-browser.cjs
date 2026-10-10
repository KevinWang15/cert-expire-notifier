const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const puppeteer = require("/home/pptruser/node_modules/puppeteer");

(async () => {
  const report = JSON.parse(await fs.readFile("/artifacts/live-certificate-report.json", "utf8"));
  assert.equal(report.status, "PASS", "Run the live container checks first");
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const badge = `button[aria-label$="Show certificate details for ${report.hostname}"]`;
  const expected = report.persistedDomains.find((domain) => domain.id === report.target.id);

  async function checkDetails() {
    const overlapsBadge = await page.$eval(badge, (button) => {
      const anchor = button.getBoundingClientRect();
      const popover = document.querySelector('[role="tooltip"]').getBoundingClientRect();
      return popover.top < anchor.bottom && popover.bottom > anchor.top;
    });
    assert.equal(overlapsBadge, false, "The certificate list must not cover its badge");
    const entries = await page.$$eval('[role="tooltip"] > div:nth-child(2) > div', (items) =>
      items.map((item) => item.textContent),
    );
    assert.equal(entries.length, report.addresses.length);
    for (const certificate of report.opensslResults) {
      const entry = entries.find((text) => text.includes(certificate.ip));
      assert.ok(entry, `Missing ${certificate.ip} in certificate details`);
      if (certificate.error) assert.ok(entry.includes("failed") || !certificate.expiresAt);
      else {
        const date = new Date(certificate.expiresAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "UTC",
        });
        assert.ok(entry.includes(date), `${certificate.ip}: missing ${date}`);
        assert.ok(entry.includes(certificate.issuer));
      }
      assert.equal(entry.includes("Earliest expiry"), certificate.ip === expected.certIp);
    }
  }

  try {
    await page.emulateTimezone("UTC");
    await page.setViewport({ width: 1440, height: 1200 });
    await page.goto("http://gateway:3000/login", { waitUntil: "networkidle0" });
    await page.locator('input[type="email"]').fill(report.account.email);
    await page.locator('input[type="password"]').fill(report.account.password);
    await page.click('button[type="submit"]');
    await page.waitForSelector(badge);
    assert.equal(
      await page.$eval(badge, (button) => button.textContent.trim()),
      `${report.addresses.length} IPs`,
    );
    const text = await page.$eval(badge, (button) => button.closest("tr").textContent);
    assert.ok(text.includes(`Earliest: ${expected.certIp}`));
    assert.ok(text.includes(expected.certIssuer));
    await page.hover(badge);
    await page.waitForSelector('[role="tooltip"]', { visible: true });
    await checkDetails();
    await page.screenshot({ path: "/artifacts/live-certificates-desktop.png", fullPage: true });
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="tooltip"]', { hidden: true });

    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await page.waitForSelector(badge, { visible: true });
    await page.tap(badge);
    await page.waitForSelector('[role="tooltip"]', { visible: true });
    await checkDetails();
    const layout = await page.$eval('[role="tooltip"]', (popover) => {
      const box = popover.getBoundingClientRect();
      popover.scrollTop = popover.scrollHeight;
      const last = popover.lastElementChild.lastElementChild.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
        finalEntryVisible: last.bottom <= box.bottom && last.top >= box.top,
      };
    });
    assert.ok(
      layout.left >= 0 &&
        layout.right <= layout.width &&
        layout.top >= 0 &&
        layout.bottom <= layout.height,
      JSON.stringify(layout),
    );
    assert.ok(layout.finalEntryVisible, "Every IP must be reachable by scrolling on mobile");
    await page.$eval('[role="tooltip"]', (popover) => {
      popover.scrollTop = 0;
    });
    await page.screenshot({ path: "/artifacts/live-certificates-mobile.png" });
    assert.deepEqual(errors, []);
    await fs.writeFile(
      "/artifacts/live-certificates-browser-report.json",
      JSON.stringify(
        {
          status: "PASS",
          hostname: report.hostname,
          addresses: report.addresses,
          checks: [
            "live IP count",
            "matching earliest IP and issuer",
            "all OpenSSL certificate details",
            "desktop hover and dismissal",
            "mobile tap and viewport",
            "scroll access to every IP",
            "no browser errors",
          ],
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `PASS: ${report.hostname}, ${report.addresses.length} IP certificates, desktop and mobile`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
