# Container notification tests

Run `npm run test:containers` from the repository root. Docker and Docker Compose are required.

The suite builds the production image, applies every Prisma migration to a dedicated MySQL database, and tests through the public HTTP API. Mocks and the app run on an internal Docker network. EngageLab's hostname resolves to a local HTTPS mock; the app trusts a generated test CA through `NODE_EXTRA_CA_CERTS`. Email code and TLS verification run normally. The webhook mock accepts arbitrary HTTP methods, records requests, and simulates failures, redirects, and timeouts. Certificate targets serve certificates expiring in two and ninety days; a closed port exercises failed certificate checks.

The main app uses an annual cron to keep API tests deterministic. A separate production app container then runs the real scheduler every five seconds. The suite verifies grouped certificate alerts, equal email/webhook content, webhook-only delivery, daily limits, retries after all deliveries fail, recovery, and disabled targets. It stops that worker, restarts the main app, and verifies settings and history persist. No application functions are replaced, and tests do not write directly to MySQL.

Other checks cover all seven HTTP methods, URL component encoding, JSON and text templates, quotes and Unicode, custom headers, target ownership, test sends to disabled targets, failure isolation, password recovery, legacy email tests, import/export compatibility, validation, retained history after deletion, and the ten-second timeout.

After that suite passes, run the optional browser check in its own container:

```bash
docker compose -f tests/containers/compose.yaml run --rm --no-deps browser
```

It uses headless Chrome to log in, create a PATCH webhook in the dashboard, send a test, inspect delivery history, remove the target, and dismiss the modal. Results and a screenshot appear in `artifacts/browser-report.json` and `artifacts/notifications.png`.

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
