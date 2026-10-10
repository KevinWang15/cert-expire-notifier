# Container certificate and notification tests

Run `npm run test:containers` from the repository root. Docker and Docker Compose are required.

The suite builds the production image, applies every Prisma migration to a dedicated MySQL database, and tests through the public HTTP API. Mocks and the app run on an internal Docker network. EngageLab's hostname resolves to a local HTTPS mock; the app trusts a generated test CA through `NODE_EXTRA_CA_CERTS`. Email code and TLS verification run normally. The webhook mock accepts arbitrary HTTP methods, records requests, and simulates failures, redirects, and timeouts. Certificate targets serve certificates expiring in two and ninety days; a closed port exercises failed certificate checks.

First, the unit tests run in the production Dockerfile's builder stage with networking disabled. These use local TLS, HTTP CONNECT, and SOCKS servers to cover IPv4/IPv6, SNI, retries, proxy cleanup, timeouts, changing DNS snapshots, concurrency limits, and notification rules. This also checks compatibility with the production Node version. To rerun just those tests after building: `docker compose -f tests/containers/compose.yaml run --rm --no-deps unit`.

Proxy recovery tests run several local proxies together: some reject requests, some stall, and others recover on a later attempt. They verify that a later healthy proxy can succeed without waiting for stalled routes, every route must exhaust its retries before an IP fails, successful IPs are not rechecked, and cancellation closes direct/HTTP/SOCKS sockets. One recovery test waits the real 10-second retry interval; the other tests shorten only retry pauses, leaving connection deadlines unchanged. Structured proxy authentication, deduplication, and credential masking are also checked.

The main app uses an annual cron to keep API tests deterministic. A separate production app container then runs the real scheduler every five seconds. The suite verifies grouped certificate alerts, equal email/webhook content, webhook-only delivery, daily limits, retries after all deliveries fail, recovery, and disabled targets. It stops that worker, restarts the main app, and verifies settings and history persist. No application functions are replaced, and tests do not write directly to MySQL.

Other checks cover all seven HTTP methods, URL component encoding, JSON and text templates, quotes and Unicode, custom headers, target ownership, test sends to disabled targets, failure isolation, password recovery, legacy email tests, import/export compatibility, validation, retained history after deletion, and the ten-second timeout.

Two certificate containers share the `multi.example.test` and `partial.example.test` DNS aliases. They present different certificates on port 8443; only one listens on port 8445. The tests check that single-domain and check-all APIs record both addresses, select the earliest expiry and its issuer/IP, retain partial failures in expiry alerts, clear snapshots on config import, and preserve per-IP results after restart.

After that suite passes, run the optional browser check in its own container:

```bash
docker compose -f tests/containers/compose.yaml run --rm --no-deps browser
```

It uses headless Chrome to log in, create a PATCH webhook in the dashboard, send a test, inspect delivery history, remove the target, and dismiss the modal. Results and a screenshot appear in `artifacts/browser-report.json` and `artifacts/notifications.png`.

Check the certificate list's sorting, per-IP details, keyboard access, and mobile layout with:

```bash
docker compose -f tests/containers/compose.yaml run --rm --no-deps --entrypoint node browser /fixtures/certificates-browser.cjs
```

Results and screenshots appear in `artifacts/certificates-browser-report.json`, `artifacts/certificates-desktop.png`, and `artifacts/certificates-mobile.png`. The `multiIp` account in `artifacts/report.json` owns the multi-address fixtures.

For a repeatable three-host, three-IP scenario with screenshots, run:

```bash
npm run test:containers:scenario
```

Three local TLS containers share all three hostnames through Docker DNS. Each IP presents a different certificate for each hostname using SNI, giving nine distinct certificates. The test records the actual local IPs and exact certificate dates/issuers, checks all of them through the production API, and compares the rendered rows and badges against the fixture certificates.

| Host                    | IP 1 lifetime | IP 2 lifetime | IP 3 lifetime | Expected row minimum |
| ----------------------- | ------------- | ------------- | ------------- | -------------------- |
| `checkout.example.test` | 30 days       | 2 days        | 90 days       | 2 days on IP 2       |
| `api.example.test`      | 45 days       | 120 days      | 7 days        | 7 days on IP 3       |
| `assets.example.test`   | 21 days       | 180 days      | 60 days       | 21 days on IP 1      |

Chrome verifies the row's minimum expiry, its matching IP/issuer, complete badge details, expiry and days-left sorting in both directions, and the global **Nearest** value of **2**. Filtering to the 21-day host must leave the global value at 2. It then renews only checkout's 2-day certificate to 365 days and clicks the dashboard's check button: checkout must move to 30 days on IP 1, API must sort first, and global **Nearest** must become **7**. A reload and mobile check verify the updated details.

Evidence is saved in `artifacts/scenario-report.json`, `artifacts/scenario-browser-report.json`, and `artifacts/scenario-*.png`. Screenshots include the list before/after renewal, each host's badge, the renewed badge, and mobile details. The initial certificates are regenerated on each run; generated test credentials are kept only in ignored artifacts. No application data or functions are mocked. Stop these fixtures and the app with `docker compose -f tests/containers/compose.yaml -f tests/containers/compose.scenario.yaml --profile cron stop`.

For an additional live-domain check, choose a hostname that resolves to multiple IPs and run this after the isolated suite. Replace the placeholder below with the hostname to test:

```bash
LIVE_CERT_DOMAIN=your-domain.example npm run test:containers:live
```

`LIVE_CERT_DOMAIN` is required; there is no default live target. This opts the test app into Internet access, and both the app and runner use Docker's configured DNS resolver. DNS answers vary by resolver and over time; the test records its actual answers and fails if they change during comparison. It checks every returned address independently with OpenSSL and hostname SNI, compares expiry and issuer with the single-domain and check-all APIs, verifies explicit IP overrides and notification previews, restarts the app to verify persistence, and checks the real certificate details in desktop/mobile Chrome. A long list must scroll without covering its badge or reopening after Escape. Notification delivery still uses local mocks.

Live evidence is saved in `artifacts/live-certificate-report.json`, `artifacts/live-certificates-browser-report.json`, and `artifacts/live-certificates-{desktop,mobile}.png`. Reports contain only generated test credentials and are ignored by Git. Repeated runs retire previous live targets through the API; the isolated suite also removes them before its scheduler checks. The live sample may present identical certificates across all IPs, so the deterministic fixtures remain responsible for validating different expiries and partial failures.

The live app retains Internet access for inspection. Restore the isolated configuration with `docker compose -f tests/containers/compose.yaml up -d --no-deps --wait app`.

The stack remains running for inspection:

| Service          | Host address                              |
| ---------------- | ----------------------------------------- |
| App              | http://localhost:23800                    |
| Webhook mock     | http://localhost:23801/\_\_admin/requests |
| Email mock       | http://localhost:23802/\_\_admin/requests |
| Certificate mock | http://localhost:23803/\_\_admin/requests |

`artifacts/report.json` contains test results and a generated demo login. `artifacts/payloads.json` contains captured certificate alert payloads. These artifacts are ignored by Git. Override inspection ports with `CONTAINER_TEST_APP_PORT`, `CONTAINER_TEST_WEBHOOK_PORT`, `CONTAINER_TEST_EMAIL_PORT`, and `CONTAINER_TEST_WEBSITE_PORT`.

Mocks expose `GET /__admin/health`, `GET /__admin/requests`, `POST /__admin/reset`, and `GET`/`PUT /__admin/state`. For example, set `{"status":503}` on the email mock to simulate an outage, or `{"routes":{"/receive":{"status":503}}}` on the webhook mock to fail one receiver. Webhook `/fail` always returns 503; `/redirect` returns 302; `/slow` delays thirty seconds. The test stack explicitly enables private webhook IPs.

Stop the stack with:

```bash
docker compose -f tests/containers/compose.yaml --profile cron down
```

Add `--volumes` to discard the test database and generated certificates.
