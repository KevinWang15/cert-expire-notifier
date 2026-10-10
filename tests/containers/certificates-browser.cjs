const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const puppeteer = require("/home/pptruser/node_modules/puppeteer");

(async () => {
  const report = JSON.parse(await fs.readFile("/artifacts/report.json", "utf8"));
  assert.equal(report.status, "PASS", "Run the container suite first");
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const multiBadge = 'button[aria-label*="Show certificate details for multi.example.test:8443"]';
  const partialBadge =
    'button[aria-label*="Show certificate details for partial.example.test:8445"]';
  try {
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto("http://gateway:3000/login", { waitUntil: "networkidle0" });
    await page.locator('input[type="email"]').fill(report.multiIp.email);
    await page.locator('input[type="password"]').fill(report.multiIp.password);
    await page.click('button[type="submit"]');
    await page.waitForSelector(multiBadge);
    const domains = await page.evaluate(
      async () =>
        (
          await (
            await fetch("/api/domains", {
              headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
            })
          ).json()
        ).domains,
    );
    const multi = domains.find((domain) => domain.domain.startsWith("multi."));
    const partial = domains.find((domain) => domain.domain.startsWith("partial."));
    assert.equal(multi.lastIpResults.length, 2);
    const domainOrder = () =>
      page.$$eval("tbody tr", (rows) =>
        rows
          .map((row) => row.querySelector("td:first-child .truncate")?.textContent)
          .filter(Boolean),
      );
    assert.deepEqual(await domainOrder(), [
      "multi.example.test:8443",
      "partial.example.test:8445",
      "healthy.example.test:8444",
    ]);
    const rowText = await page.$eval(multiBadge, (button) => button.closest("tr").textContent);
    assert.ok(rowText.includes(`Earliest: ${multi.certIp}`));
    assert.ok(rowText.includes(multi.certIssuer));
    assert.equal(await page.$eval(multiBadge, (button) => button.textContent.trim()), "2 IPs");
    await page.hover(multiBadge);
    await page.waitForSelector('[role="tooltip"]', { visible: true });
    const details = await page.$eval('[role="tooltip"]', (popover) => popover.textContent);
    for (const result of multi.lastIpResults) {
      assert.ok(details.includes(result.ip));
      assert.ok(details.includes(result.issuer));
    }
    assert.ok(details.includes("Earliest expiry"));
    await page.screenshot({ path: "/artifacts/certificates-desktop.png", fullPage: true });
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="tooltip"]', { hidden: true });
    await page.focus(partialBadge);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="tooltip"]', { visible: true });
    const failureDetails = await page.$eval('[role="tooltip"]', (popover) => popover.textContent);
    assert.ok(failureDetails.includes("1 failed"));
    for (const result of partial.lastIpResults) {
      assert.ok(failureDetails.includes(result.ip));
      if (result.error) assert.ok(failureDetails.includes(result.error));
    }
    await page.mouse.click(5, 5);
    await page.waitForSelector('[role="tooltip"]', { hidden: true });
    // Toggling the date sort reverses the domain ordering using each domain's minimum expiry.
    await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent.trim() === "Expiry")
        .click(),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("tbody tr td:first-child .truncate")?.textContent ===
        "healthy.example.test:8444",
    );
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await page.waitForSelector(multiBadge, { visible: true });
    await page.tap(multiBadge);
    await page.waitForSelector('[role="tooltip"]', { visible: true });
    const box = await page.$eval('[role="tooltip"]', (popover) => {
      const box = popover.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    });
    assert.ok(
      box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height,
      JSON.stringify(box),
    );
    await page.screenshot({ path: "/artifacts/certificates-mobile.png", fullPage: true });
    assert.deepEqual(errors, []);
    await fs.writeFile(
      "/artifacts/certificates-browser-report.json",
      JSON.stringify(
        {
          status: "PASS",
          checks: [
            "minimum-expiry ordering",
            "matching expiry IP and issuer",
            "per-IP certificates",
            "partial failure details",
            "hover, keyboard and click",
            "Escape and outside dismissal",
            "reverse sorting",
            "mobile viewport",
          ],
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "PASS: per-IP certificate details, expiry ordering, keyboard access, and mobile layout",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
