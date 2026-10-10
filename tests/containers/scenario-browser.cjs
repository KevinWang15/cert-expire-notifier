const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const puppeteer = require("/home/pptruser/node_modules/puppeteer");

(async () => {
  const fixture = JSON.parse(await fs.readFile("/artifacts/scenario-report.json", "utf8"));
  assert.equal(fixture.status, "PASS");
  const report = { status: "RUNNING", checks: [], screenshots: [] };
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const badge = (hostname) => `button[aria-label$="Show certificate details for ${hostname}"]`;
  const date = (value) =>
    new Date(value).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
  const remaining = (value) => Math.ceil((Date.parse(value) - Date.now()) / 86400000);
  const pass = (name) => {
    report.checks.push(name);
    console.log(`PASS ${name}`);
  };

  async function nearest() {
    return page.evaluate(() => {
      const label = [...document.querySelectorAll("span")].find(
        (span) => span.textContent === "Nearest",
      );
      return Number(label.closest("div.rounded-3xl").querySelector("p").textContent.trim());
    });
  }
  async function rows() {
    return page.$$eval("tbody tr", (rows) =>
      rows
        .filter((row) => row.children.length === 7)
        .map((row) => ({
          hostname: row.querySelector("td:first-child .truncate").textContent,
          expiry: row.children[2].textContent,
          issuer: row.children[4].textContent.trim(),
        })),
    );
  }
  async function assertRows(certificates, order) {
    const actual = await rows();
    assert.deepEqual(
      actual.map((row) => row.hostname),
      order,
    );
    for (const row of actual) {
      const shortest = certificates
        .filter((cert) => cert.hostname === row.hostname)
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0];
      assert.ok(row.expiry.includes(`${remaining(shortest.expiresAt)} days left`), row.expiry);
      assert.ok(row.expiry.includes(date(shortest.expiresAt)), row.expiry);
      assert.ok(row.expiry.includes(`Earliest: ${shortest.ip}`), row.expiry);
      assert.equal(row.issuer, shortest.issuer);
    }
    const expectedNearest = Math.min(...certificates.map((cert) => remaining(cert.expiresAt)));
    assert.equal(await nearest(), expectedNearest);
    return actual;
  }
  async function screenshot(name, fullPage = true) {
    await page.screenshot({ path: `/artifacts/${name}`, fullPage });
    report.screenshots.push(name);
  }
  async function details(hostname, certificates, name, mobile = false) {
    assert.equal(await page.$eval(badge(hostname), (button) => button.textContent.trim()), "3 IPs");
    if (mobile) await page.tap(badge(hostname));
    else await page.hover(badge(hostname));
    await page.waitForSelector('[role="tooltip"]', { visible: true });
    const entries = await page.$$eval('[role="tooltip"] > div:nth-child(2) > div', (items) =>
      items.map((item) => item.textContent),
    );
    const expected = certificates
      .filter((cert) => cert.hostname === hostname)
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    assert.equal(entries.length, 3);
    for (let i = 0; i < expected.length; i++) {
      assert.ok(entries[i].includes(expected[i].ip));
      assert.ok(entries[i].includes(expected[i].issuer));
      assert.ok(entries[i].includes(date(expected[i].expiresAt)));
      assert.ok(entries[i].includes(`${remaining(expected[i].expiresAt)} days left`));
      assert.equal(entries[i].includes("Earliest expiry"), i === 0);
    }
    const fits = await page.$eval('[role="tooltip"]', (popover) => {
      const box = popover.getBoundingClientRect();
      return (
        box.top >= 0 &&
        box.left >= 0 &&
        box.right <= window.innerWidth &&
        box.bottom <= window.innerHeight
      );
    });
    assert.ok(fits);
    await screenshot(name, !mobile);
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="tooltip"]', { hidden: true });
    pass(`${hostname} badge displays all three IPs, dates, issuers and the shortest certificate`);
  }
  async function select(label, value) {
    const selector = await page.evaluate((text) => {
      const options = [...document.querySelectorAll("select")];
      return options.findIndex(
        (element) => element.closest("label").querySelector("span").textContent === text,
      );
    }, label);
    assert.ok(selector >= 0, `Missing ${label} selector`);
    await (await page.$$("select"))[selector].select(value);
  }
  try {
    await page.emulateTimezone("UTC");
    await page.setViewport({ width: 1600, height: 1160 });
    await page.goto("http://gateway:3000/login", { waitUntil: "networkidle0" });
    await page.locator('input[type="email"]').fill(fixture.account.email);
    await page.locator('input[type="password"]').fill(fixture.account.password);
    await page.click('button[type="submit"]');
    await page.waitForSelector(badge("checkout.example.test"));
    const order = ["checkout.example.test", "api.example.test", "assets.example.test"];
    report.before = {
      nearestDays: await nearest(),
      rows: await assertRows(fixture.certificates, order),
    };
    assert.equal(report.before.nearestDays, 2);
    await screenshot("scenario-list-before.png");
    pass(
      "list rows use minimum expiry, matching issuer/IP, ascending order, and global nearest is 2 days",
    );
    for (const hostname of order)
      await details(
        hostname,
        fixture.certificates,
        `scenario-${hostname.split(".")[0]}-details.png`,
      );

    await select("Sort by", "daysLeft");
    await assertRows(fixture.certificates, order);
    await select("Group", "none");
    await assertRows(fixture.certificates, order);
    await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent.trim() === "Asc")
        .click(),
    );
    await assertRows(fixture.certificates, [...order].reverse());
    await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent.trim() === "Desc")
        .click(),
    );
    await select("Sort by", "expiry");
    await select("Group", "base");
    pass(
      "expiry and days-left sorting use the minimum in grouped and flat views, in both directions",
    );

    // Filtering must not hide a globally urgent certificate from the top summary.
    await page
      .locator('input[placeholder="Search domain, issuer, notes, error..."]')
      .fill("assets");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
    assert.equal(await nearest(), 2);
    await screenshot("scenario-filtered-list.png");
    await page.focus('input[placeholder="Search domain, issuer, notes, error..."]');
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 3);
    pass("global nearest stays at 2 days when the list is filtered to the 21-day host");

    const renewed = await fetch("http://certificate-node-2:8080/__admin/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "checkout.example.test", days: 365 }),
    });
    assert.equal(renewed.status, 200);
    const replacement = (await renewed.json()).certificates.find(
      (cert) => cert.hostname === "checkout.example.test",
    );
    report.certificatesAfterRenewal = fixture.certificates.map((cert) =>
      cert.hostname === replacement.hostname && cert.ip === replacement.ip ? replacement : cert,
    );
    const response = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(
            `/domains/${fixture.domains.find((domain) => domain.domain === "checkout.example.test").id}/check`,
          ) && response.request().method() === "POST",
    );
    await page.click('button[aria-label="Check certificate for checkout.example.test"]');
    const checked = await response;
    assert.equal(checked.status(), 200);
    const { domain } = await checked.json();
    assert.equal(domain.certIp, fixture.nodes.find((node) => node.node === 1).address);
    assert.equal(
      domain.lastIpResults.find((result) => result.ip === replacement.ip).expiresAt,
      replacement.expiresAt,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("tbody tr td:first-child .truncate").textContent ===
        "api.example.test",
    );
    report.after = {
      nearestDays: await nearest(),
      rows: await assertRows(report.certificatesAfterRenewal, [
        "api.example.test",
        "assets.example.test",
        "checkout.example.test",
      ]),
    };
    assert.equal(report.after.nearestDays, 7);
    await screenshot("scenario-list-after-renewal.png");
    await details(
      "checkout.example.test",
      report.certificatesAfterRenewal,
      "scenario-checkout-renewed-details.png",
    );
    pass(
      "renewing the 2-day certificate changes its row to 30 days and global nearest to the other host's 7 days",
    );

    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(badge("api.example.test"));
    await assertRows(report.certificatesAfterRenewal, [
      "api.example.test",
      "assets.example.test",
      "checkout.example.test",
    ]);
    assert.deepEqual(errors, []);
    pass("renewed per-IP results survive page reload with no browser errors");
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await page.waitForSelector(badge("api.example.test"), { visible: true });
    await details(
      "api.example.test",
      report.certificatesAfterRenewal,
      "scenario-mobile-details.png",
      true,
    );
    assert.deepEqual(errors, []);
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = error.stack;
    await page.screenshot({ path: "/artifacts/scenario-failure.png", fullPage: true });
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(
      "/artifacts/scenario-browser-report.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
