# cert-expire-notifier

SSL certificate monitoring dashboard with email verification, password recovery, certificate alerts over email and webhooks, and delivery history.

## Stack

- Frontend: Vite + React + TypeScript + Tailwind (`client`)
- Backend: Node.js + Express + TypeScript + Prisma (`server`)
- Shared code: `shared` (importable from frontend and backend)
- Dev launcher: root `./run.sh`
- CI image build: GitHub Actions + GHCR
- Container build: `k3s/Dockerfile.multistage`

## What is included

- Account signup with email verification before login.
- Resend verification email flow.
- Forgot-password and reset-password flow using single-use expiring email tokens.
- Email delivery audit trail for verification, reset, test, and certificate expiry emails.
- Configurable webhook targets with test sends, HTTP methods, headers, body templates, and delivery history.
- Upcoming expiry-alert previews in the dashboard with planned send time and modal email body preview.
- Admin default certificate-expiry alert window with a per-user days-before-expiry override.
- Safer JWT secret handling, stronger password minimum, normalized emails/domains, and safer certificate checker resolution.
- Config import/export, renewal notes, grouped domain inventory, test-email button, and expiry alert cron job.
- Optional per-domain certificate check ports using `hostname:port`; entries without a port continue to use 443.
- Curl-style per-domain DNS overrides using `hostname:port:ip`; the hostname is preserved for TLS/SNI while the connection is made directly to the chosen IP address.

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   npm install --prefix server
   npm install --prefix client
   ```

2. Create local environment settings:

   ```bash
   cp .env.sample .env
   ```

   Set `PUBLIC_APP_URL`, `DATABASE_URL`, `JWT_SECRET`, and EngageLab email settings. In development, verification and reset links are also printed to the server logs so the auth flows can be tested before email delivery is configured.

3. Generate Prisma client and run migrations:

   ```bash
   npm run prisma:generate --prefix server
   npm run prisma:migrate --prefix server
   ```

4. Run locally:

   ```bash
   ./run.sh
   ```

Frontend: http://localhost:5173  
Backend health: http://localhost:3000/api/health

## Certificate targets

Certificate targets support the following forms:

- `api.example.com` checks port 443 using normal DNS resolution.
- `api.example.com:8443` checks a custom port using normal DNS resolution.
- `api.example.com:443:192.0.2.10` connects to `192.0.2.10` while using `api.example.com` for TLS/SNI.
- `api.example.com:443:[2001:db8::10]` is the equivalent IPv6 override form.

## Notifications

Open **Notifications** in the dashboard to enable or disable monitoring email, manage webhook targets, send tests to all enabled targets or one saved webhook, and inspect email/webhook delivery history. Individual webhook tests work even when that target is disabled. Verification and password recovery always use email. The existing **Test email** button remains available.

Certificate alerts include both expiring certificates and failed checks. They are delivered to every enabled target independently. A failed target does not prevent other targets from receiving the alert. Any successful email or webhook delivery counts toward the existing one-alert-per-day limit; when every delivery fails, the next cron run retries. Configure the expiry window through the existing email settings API or dashboard email debug panel.

Webhook methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. GET and HEAD send no body. Other methods send the default JSON payload unless you provide a body template:

```json
{
  "app": "cert-expire-notifier",
  "purpose": "CERT_ALERT",
  "subject": "[Cert Expiry Warning] 1 domain expiring soon",
  "html": "<div>...</div>",
  "text": "Full certificate details, failures, and renewal notes...",
  "shortText": "example.com: 2 days left (2026-10-04)",
  "details": ["example.com"],
  "requestedAt": "2026-10-02T00:00:00.000Z"
}
```

Templates support these variables in the URL, header values, and body:

| Variable      | Value                                      |
| ------------- | ------------------------------------------ |
| `$SUBJECT`    | Notification subject.                      |
| `$TEXT`       | Full plain text, including renewal notes.  |
| `$SHORT_TEXT` | Compact domain expiry and failure details. |
| `$HTML`       | The same HTML body sent by email.          |
| `$PURPOSE`    | `CERT_ALERT` or `TEST_EMAIL`.              |
| `$DETAILS`    | Comma-separated certificate targets.       |
| `$TIMESTAMP`  | ISO request timestamp.                     |

For example, use `https://example.com/notify?message=$SHORT_TEXT` for a GET receiver, or `{"msgtype":"text","text":{"content":"$SHORT_TEXT"}}` for a WeChat-style JSON receiver. Each substituted URL value uses `encodeURIComponent`, so slashes, ampersands, newlines, and Unicode remain within their component. Valid JSON templates expand string values and automatically escape quotes, backslashes, and newlines; plain text templates expand directly. Without a custom Content-Type header, rendered JSON uses `application/json` and other bodies use `text/plain; charset=utf-8`.

Requests have a ten-second deadline and accept only HTTP 2xx responses. Redirects are not followed. Private and reserved destinations are blocked by default, including DNS results. Set `WEBHOOK_ALLOW_PRIVATE_IPS=true` for trusted receivers on your private network. Config exports include notification settings and webhook credentials; older exports preserve existing notification settings when imported.

Authenticated API routes:

| Route                                       | Action                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/notifications/settings`           | Read email and webhook targets.                                                         |
| `PUT /api/notifications/email`              | Set `{ "enabled": true }`.                                                              |
| `POST /api/notifications/webhooks`          | Create a target with `name`, `enabled`, `url`, `method`, `headers`, and `bodyTemplate`. |
| `PUT /api/notifications/webhooks/:id`       | Replace a target configuration.                                                         |
| `DELETE /api/notifications/webhooks/:id`    | Delete a target, retaining its history.                                                 |
| `POST /api/notifications/test`              | Test all enabled targets.                                                               |
| `POST /api/notifications/webhooks/:id/test` | Test a saved target.                                                                    |
| `GET /api/notifications/history?limit=50`   | Read combined delivery history, up to 100 entries.                                      |

Test sends require a verified account and are limited to five requests per user per fifteen minutes.

## Notification environment variables

| Variable                               | Purpose                                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_APP_URL`                       | Public frontend URL used in verification and password reset links.                                                                                                                                                                                                     |
| `ENGAGE_LAB_USERNAME`                  | EngageLab API username.                                                                                                                                                                                                                                                |
| `ENGAGE_LAB_API_KEY`                   | EngageLab API key.                                                                                                                                                                                                                                                     |
| `ENGAGE_LAB_FROM_EMAIL`                | Sender address for outbound app emails.                                                                                                                                                                                                                                |
| `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES` | Verification link lifetime, default `1440`.                                                                                                                                                                                                                            |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES`     | Password reset link lifetime, default `60`.                                                                                                                                                                                                                            |
| `CERT_CHECK_CRON`                      | Cron expression for cert checks and notifications, default hourly.                                                                                                                                                                                                     |
| `CERT_EXPIRY_THRESHOLD_DAYS`           | Admin default expiry alert threshold, default `30`; users can override this in the dashboard.                                                                                                                                                                          |
| `CERT_CHECK_PROXY_URLS`                | Optional comma/newline-separated proxy URLs for fallback cert checks; each proxy gets the same retry count after direct attempts. Supports `http://...`, `https://...`, and `socks5://...`, including auth in the URL. Bare `host:port` entries default to `https://`. |
| `WEBHOOK_ALLOW_PRIVATE_IPS`            | Allow webhook destinations on private/reserved networks, default `false`.                                                                                                                                                                                              |

## Tests

Run `npm run test:notifications --prefix server` for template, validation, and destination checks. Run `npm run test:containers` for the production app, MySQL, mock HTTPS EngageLab API, webhook receiver, and TLS certificate targets. The container suite exercises the real scheduler and checks persistence after restarting the app. See [container test instructions](tests/containers/README.md).

## Deployment notes

For k3s, copy `k3s/.env.example` to `k3s/.env` if you keep that workflow, or update `k3s/secret.yaml`/`k3s/deploy.sh` values. Make sure `PUBLIC_APP_URL`, `JWT_SECRET`, and EngageLab settings are present in the generated Kubernetes secret before deploying.
