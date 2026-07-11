# cert-expire-notifier

SSL certificate monitoring dashboard with email verification, password recovery, expiring-certificate alerts, and an auditable email history.

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
- Upcoming expiry-alert previews in the dashboard with planned send time and modal email body preview.
- Admin default certificate-expiry alert window with a per-user days-before-expiry override.
- Safer JWT secret handling, stronger password minimum, normalized emails/domains, and safer certificate checker resolution.
- Config import/export, renewal notes, grouped domain inventory, test-email button, and expiry alert cron job.
- Optional per-domain certificate check ports using `hostname:port`; entries without a port continue to use 443.

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

## Email-related environment variables

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

## Deployment notes

For k3s, copy `k3s/.env.example` to `k3s/.env` if you keep that workflow, or update `k3s/secret.yaml`/`k3s/deploy.sh` values. Make sure `PUBLIC_APP_URL`, `JWT_SECRET`, and EngageLab settings are present in the generated Kubernetes secret before deploying.
