# k3s deployment

1. Copy `k3s/.env.example` to `k3s/.env` and set the deployment image, public app URL, JWT secret, app secrets, email settings, and MySQL passwords.
2. Make sure your cluster can pull the image. If the image is private on GHCR, set `GHCR_USERNAME` and `GHCR_TOKEN`.
3. Run `./k3s/deploy.sh`.

`deploy.sh` creates a MySQL instance in the same namespace by default, waits for it to become ready, and then deploys the app against that in-cluster database. If `DATABASE_URL` is left empty, the script generates it from the `MYSQL_*` settings in `k3s/.env`.

The deployment script is the main entrypoint and supports:

- `./k3s/deploy.sh deploy`
- `./k3s/deploy.sh status`
- `./k3s/deploy.sh logs`
- `./k3s/deploy.sh restart`
- `./k3s/deploy.sh delete`
- `./k3s/deploy.sh render`

`deploy.sh` loads environment variables from the repo root `.env` and then `k3s/.env` so k3s-specific overrides can live under `k3s/`.

`delete` removes the deployment resources but leaves the MySQL PVC intact so database data is not destroyed by default.

Email verification and password reset links use `PUBLIC_APP_URL`. Set it to the external URL users will open in their browser.

CERT_EXPIRY_THRESHOLD_DAYS is the admin default alert window. Individual users can override it from the dashboard without changing the cluster secret.
