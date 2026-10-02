const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const puppeteer = require("/home/pptruser/node_modules/puppeteer");

(async () => {
  const report = JSON.parse(await fs.readFile("/artifacts/report.json", "utf8"));
  assert.equal(report.status, "PASS", "Run API and scheduler checks first");
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = "http://gateway:3000";
  const click = async (text) => {
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent.trim() === text && !button.disabled,
        ),
      {},
      text,
    );
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === text && !button.disabled)
          .click(),
      text,
    );
  };
  try {
    await page.goto(`${base}/login`, { waitUntil: "networkidle0" });
    await page.locator('input[type="email"]').fill(report.demo.email);
    await page.locator('input[type="password"]').fill(report.demo.password);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.pathname === "/");
    await click("Notifications");
    await page.waitForSelector('[role="dialog"]');
    await page.waitForFunction(() =>
      document.querySelector('[role="dialog"]').textContent.includes("WeChat text relay"),
    );
    await click("Add webhook");
    await page.locator('form input[maxlength="191"]').fill("Browser webhook");
    await page.locator('form input[type="url"]').fill("http://webhook:8080/browser?text=$TEXT");
    await page.select("form select", "PATCH");
    assert.deepEqual(
      await page.$$eval("form select option", (options) => options.map((option) => option.value)),
      ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    );
    const textareas = await page.$$("form textarea");
    await page.locator("form textarea").fill('{"X-Purpose":"$PURPOSE"}');
    await textareas[1].type('{"text":"$TEXT","short":"$SHORT_TEXT"}');
    await click("Save webhook");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"] form'));
    const targetAction = async (text) => {
      await page.waitForFunction(
        (text) => {
          const title = [...document.querySelectorAll('[role="dialog"] p')].find(
            (node) => node.textContent.trim() === "Browser webhook",
          );
          const card = title?.parentElement.parentElement.parentElement;
          return (
            card &&
            [...card.querySelectorAll("button")].some(
              (button) => button.textContent.trim() === text && !button.disabled,
            )
          );
        },
        {},
        text,
      );
      await page.evaluate((text) => {
        const title = [...document.querySelectorAll('[role="dialog"] p')].find(
          (node) => node.textContent.trim() === "Browser webhook",
        );
        const card = title.parentElement.parentElement.parentElement;
        [...card.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === text)
          .click();
      }, text);
    };
    await targetAction("Send test");
    await page.waitForFunction(() =>
      document.querySelector('[role="status"]')?.textContent.includes("Test delivered to 1 target"),
    );
    const records = await (await fetch("http://gateway:8081/__admin/requests")).json();
    const request = records.requests.findLast((request) => request.url.startsWith("/browser?"));
    assert.equal(request.method, "PATCH");
    assert.equal(
      new URL(request.url, "http://webhook").searchParams.get("text"),
      request.body.text,
    );
    assert.ok(request.body.text.includes(report.demo.name));
    await click("Delivery history");
    await page.waitForFunction(() =>
      document.querySelector('[role="dialog"]').textContent.includes("Browser webhook"),
    );
    await page.screenshot({ path: "/artifacts/notifications.png", fullPage: true });
    await click("Targets");
    await targetAction("Remove");
    await page.waitForFunction(() =>
      document.querySelector('[role="status"]')?.textContent.includes("Webhook removed"),
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    assert.equal(await page.$('[role="dialog"]'), null);
    assert.deepEqual(errors, []);
    await fs.writeFile(
      "/artifacts/browser-report.json",
      JSON.stringify(
        {
          status: "PASS",
          checks: [
            "login",
            "open targets",
            "create PATCH webhook",
            "test send",
            "encoded URL and JSON body",
            "delivery history",
            "remove",
            "Escape dismissal",
          ],
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log("PASS: browser notification settings, test send, history, and removal");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
