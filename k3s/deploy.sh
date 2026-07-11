#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
      local key="${line%%=*}"
      local value="${line#*=}"
      export "$key=$value"
    done <"$file"
  fi
}

load_env_file "$ROOT_DIR/.env"
load_env_file "$SCRIPT_DIR/.env"

ACTION="${1:-deploy}"

NAMESPACE="${DEPLOYMENT_NAMESPACE:-cert-expire-notifier}"
APP_NAME="${DEPLOYMENT_APP_NAME:-cert-expire-notifier}"
SERVICE_NAME="${DEPLOYMENT_SERVICE_NAME:-cert-expire-notifier-service}"
SECRET_NAME="${DEPLOYMENT_SECRET_NAME:-cert-expire-notifier-secret}"
IMAGE="${DEPLOYMENT_IMAGE:-ghcr.io/your-org/cert-expire-notifier:latest}"
IMAGE_PULL_SECRET="${DEPLOYMENT_IMAGE_PULL_SECRET:-}"
REPLICAS="${DEPLOYMENT_REPLICAS:-1}"
CONTAINER_PORT="${DEPLOYMENT_CONTAINER_PORT:-3000}"
NODE_PORT="${DEPLOYMENT_NODE_PORT:-25334}"
RUN_MIGRATIONS="${DEPLOYMENT_RUN_MIGRATIONS:-true}"
CREATE_MYSQL="${DEPLOYMENT_CREATE_MYSQL:-true}"
MYSQL_NAME="${DEPLOYMENT_MYSQL_NAME:-cert-expire-notifier-mysql}"
MYSQL_SERVICE_NAME="${DEPLOYMENT_MYSQL_SERVICE_NAME:-cert-expire-notifier-mysql}"
MYSQL_SECRET_NAME="${DEPLOYMENT_MYSQL_SECRET_NAME:-cert-expire-notifier-mysql-secret}"
MYSQL_IMAGE="${DEPLOYMENT_MYSQL_IMAGE:-mysql:8.4}"
MYSQL_PORT="${DEPLOYMENT_MYSQL_PORT:-3306}"
MYSQL_STORAGE_SIZE="${DEPLOYMENT_MYSQL_STORAGE_SIZE:-10Gi}"
MYSQL_STORAGE_CLASS="${DEPLOYMENT_MYSQL_STORAGE_CLASS:-}"

MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
MYSQL_DATABASE="${MYSQL_DATABASE:-cert-expire-notifier}"
MYSQL_USER="${MYSQL_USER:-cert_expire_notifier}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
DATABASE_URL="${DATABASE_URL:-}"

kubectl_required() {
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl not found"
    exit 1
  fi

  if ! kubectl version >/dev/null 2>&1; then
    echo "kubectl cannot reach the cluster"
    exit 1
  fi
}

require_image() {
  if [[ "$IMAGE" == "ghcr.io/your-org/cert-expire-notifier:latest" ]]; then
    echo "Set DEPLOYMENT_IMAGE in k3s/.env before deploying"
    exit 1
  fi
}

require_mysql_config() {
  if [[ "$CREATE_MYSQL" != "true" ]]; then
    return
  fi

  if [[ -z "$MYSQL_ROOT_PASSWORD" || -z "$MYSQL_PASSWORD" ]]; then
    echo "Set MYSQL_ROOT_PASSWORD and MYSQL_PASSWORD in k3s/.env before deploying"
    exit 1
  fi
}

env_secret_source() {
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    printf '%s\n' "$SCRIPT_DIR/.env"
    return
  fi

  if [[ -f "$ROOT_DIR/.env" ]]; then
    printf '%s\n' "$ROOT_DIR/.env"
    return
  fi

  echo "No .env file found. Create k3s/.env from k3s/.env.example."
  exit 1
}

create_namespace() {
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
}

write_env_key() {
  local key="$1"
  if [[ -n "${!key+x}" ]]; then
    printf '%s=%s\n' "$key" "${!key}"
  fi
}

resolved_database_url() {
  if [[ -n "$DATABASE_URL" ]]; then
    printf '%s\n' "$DATABASE_URL"
    return
  fi

  if [[ "$CREATE_MYSQL" == "true" ]]; then
    printf 'mysql://%s:%s@%s:%s/%s\n' \
      "$MYSQL_USER" \
      "$MYSQL_PASSWORD" \
      "$MYSQL_SERVICE_NAME" \
      "$MYSQL_PORT" \
      "$MYSQL_DATABASE"
    return
  fi

  echo "Set DATABASE_URL in k3s/.env before deploying"
  exit 1
}

create_app_secret() {
  local tmp_env
  env_secret_source >/dev/null
  tmp_env="$(mktemp)"

  {
    write_env_key APP_VERSION
    write_env_key NODE_ENV
    write_env_key SITE
    write_env_key PUBLIC_APP_URL
    write_env_key PORT
    write_env_key JWT_SECRET
    printf 'DATABASE_URL=%s\n' "$(resolved_database_url)"
    write_env_key TZ
    write_env_key ENGAGE_LAB_USERNAME
    write_env_key ENGAGE_LAB_API_KEY
    write_env_key ENGAGE_LAB_FROM_EMAIL
    write_env_key HEALTHCHECKS_PING_URL
    write_env_key CERT_CHECK_CRON
    write_env_key CERT_CHECK_PROXY_URLS
    write_env_key CERT_EXPIRY_THRESHOLD_DAYS
    write_env_key EMAIL_VERIFICATION_TOKEN_TTL_MINUTES
    write_env_key PASSWORD_RESET_TOKEN_TTL_MINUTES
  } >"$tmp_env"

  kubectl create secret generic "$SECRET_NAME" \
    --from-env-file="$tmp_env" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -

  rm -f "$tmp_env"
}

create_mysql_secret() {
  local tmp_env

  if [[ "$CREATE_MYSQL" != "true" ]]; then
    return
  fi

  tmp_env="$(mktemp)"
  {
    printf 'MYSQL_ROOT_PASSWORD=%s\n' "$MYSQL_ROOT_PASSWORD"
    printf 'MYSQL_DATABASE=%s\n' "$MYSQL_DATABASE"
    printf 'MYSQL_USER=%s\n' "$MYSQL_USER"
    printf 'MYSQL_PASSWORD=%s\n' "$MYSQL_PASSWORD"
  } >"$tmp_env"

  kubectl create secret generic "$MYSQL_SECRET_NAME" \
    --from-env-file="$tmp_env" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -

  rm -f "$tmp_env"
}

create_image_pull_secret() {
  if [[ -z "$IMAGE_PULL_SECRET" ]]; then
    return
  fi

  if [[ -z "${GHCR_USERNAME:-}" || -z "${GHCR_TOKEN:-}" ]]; then
    echo "Skipping image pull secret creation because GHCR_USERNAME or GHCR_TOKEN is not set"
    return
  fi

  kubectl create secret docker-registry "$IMAGE_PULL_SECRET" \
    --docker-server=ghcr.io \
    --docker-username="$GHCR_USERNAME" \
    --docker-password="$GHCR_TOKEN" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -
}

render_namespace() {
  cat <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${APP_NAME}
EOF
}

render_service() {
  cat <<EOF
apiVersion: v1
kind: Service
metadata:
  name: ${SERVICE_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${APP_NAME}
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: ${APP_NAME}
  ports:
    - name: http
      port: 80
      targetPort: ${CONTAINER_PORT}
      nodePort: ${NODE_PORT}
      protocol: TCP
EOF
}

render_mysql() {
  local storage_class_block=""

  if [[ "$CREATE_MYSQL" != "true" ]]; then
    return
  fi

  if [[ -n "$MYSQL_STORAGE_CLASS" ]]; then
    storage_class_block=$(cat <<EOF
        storageClassName: ${MYSQL_STORAGE_CLASS}
EOF
)
  fi

  cat <<EOF
apiVersion: v1
kind: Service
metadata:
  name: ${MYSQL_SERVICE_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${MYSQL_NAME}
spec:
  selector:
    app.kubernetes.io/name: ${MYSQL_NAME}
  ports:
    - name: mysql
      port: ${MYSQL_PORT}
      targetPort: ${MYSQL_PORT}
      protocol: TCP
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${MYSQL_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${MYSQL_NAME}
spec:
  serviceName: ${MYSQL_SERVICE_NAME}
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${MYSQL_NAME}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${MYSQL_NAME}
    spec:
      containers:
        - name: mysql
          image: ${MYSQL_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: ${MYSQL_PORT}
          envFrom:
            - secretRef:
                name: ${MYSQL_SECRET_NAME}
          volumeMounts:
            - name: mysql-data
              mountPath: /var/lib/mysql
          livenessProbe:
            exec:
              command:
                - sh
                - -c
                - mysqladmin ping -h 127.0.0.1 -uroot -p"\$MYSQL_ROOT_PASSWORD"
            initialDelaySeconds: 30
            periodSeconds: 20
            timeoutSeconds: 5
            failureThreshold: 6
          readinessProbe:
            exec:
              command:
                - sh
                - -c
                - mysqladmin ping -h 127.0.0.1 -uroot -p"\$MYSQL_ROOT_PASSWORD"
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 6
  volumeClaimTemplates:
    - metadata:
        name: mysql-data
        labels:
          app.kubernetes.io/name: ${MYSQL_NAME}
      spec:
        accessModes:
          - ReadWriteOnce
${storage_class_block}
        resources:
          requests:
            storage: ${MYSQL_STORAGE_SIZE}
EOF
}

render_deployment() {
  local image_pull_secret_block=""
  local init_container_block=""

  if [[ -n "$IMAGE_PULL_SECRET" ]]; then
    image_pull_secret_block=$(cat <<EOF
      imagePullSecrets:
        - name: ${IMAGE_PULL_SECRET}
EOF
)
  fi

  if [[ "$RUN_MIGRATIONS" == "true" ]]; then
    init_container_block=$(cat <<EOF
      initContainers:
        - name: prisma-migrate
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          command: ["npx", "prisma", "migrate", "deploy"]
          envFrom:
            - secretRef:
                name: ${SECRET_NAME}
EOF
)
  fi

  cat <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${APP_NAME}
spec:
  replicas: ${REPLICAS}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app.kubernetes.io/name: ${APP_NAME}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${APP_NAME}
    spec:
${image_pull_secret_block}
${init_container_block}
      containers:
        - name: ${APP_NAME}
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: ${CONTAINER_PORT}
          envFrom:
            - secretRef:
                name: ${SECRET_NAME}
          livenessProbe:
            httpGet:
              path: /api/health
              port: ${CONTAINER_PORT}
            initialDelaySeconds: 30
            periodSeconds: 30
            successThreshold: 1
            failureThreshold: 5
            timeoutSeconds: 5
          readinessProbe:
            httpGet:
              path: /api/health
              port: ${CONTAINER_PORT}
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 5
EOF
}

deploy() {
  kubectl_required
  require_image
  require_mysql_config

  echo "Deploying ${APP_NAME} to namespace ${NAMESPACE}"
  create_namespace
  create_mysql_secret
  create_app_secret
  create_image_pull_secret

  if [[ "$CREATE_MYSQL" == "true" ]]; then
    render_mysql | kubectl apply -f -
    kubectl rollout status statefulset/"$MYSQL_NAME" -n "$NAMESPACE" --timeout=300s
  fi

  render_deployment | kubectl apply -f -
  render_service | kubectl apply -f -

  kubectl rollout status deployment/"$APP_NAME" -n "$NAMESPACE" --timeout=300s
  kubectl get pods,svc -n "$NAMESPACE"
  echo "Application should be available on NodePort ${NODE_PORT}"
}

status() {
  kubectl_required
  kubectl get all -n "$NAMESPACE"
}

logs() {
  kubectl_required
  kubectl logs -f deployment/"$APP_NAME" -n "$NAMESPACE"
}

restart() {
  kubectl_required
  kubectl rollout restart deployment/"$APP_NAME" -n "$NAMESPACE"
  kubectl rollout status deployment/"$APP_NAME" -n "$NAMESPACE" --timeout=300s
}

delete_resources() {
  kubectl_required
  kubectl delete service "$SERVICE_NAME" -n "$NAMESPACE" --ignore-not-found
  kubectl delete deployment "$APP_NAME" -n "$NAMESPACE" --ignore-not-found
  kubectl delete secret "$SECRET_NAME" -n "$NAMESPACE" --ignore-not-found
  if [[ "$CREATE_MYSQL" == "true" ]]; then
    kubectl delete service "$MYSQL_SERVICE_NAME" -n "$NAMESPACE" --ignore-not-found
    kubectl delete statefulset "$MYSQL_NAME" -n "$NAMESPACE" --ignore-not-found
    kubectl delete secret "$MYSQL_SECRET_NAME" -n "$NAMESPACE" --ignore-not-found
    echo "MySQL PVCs are retained. Delete them manually if you also want to remove database data."
  fi
  if [[ -n "$IMAGE_PULL_SECRET" ]]; then
    kubectl delete secret "$IMAGE_PULL_SECRET" -n "$NAMESPACE" --ignore-not-found
  fi
}

render() {
  render_namespace
  echo "---"
  if [[ "$CREATE_MYSQL" == "true" ]]; then
    render_mysql
    echo "---"
  fi
  render_deployment
  echo "---"
  render_service
}

case "$ACTION" in
  deploy)
    deploy
    ;;
  status)
    status
    ;;
  logs)
    logs
    ;;
  restart)
    restart
    ;;
  delete)
    delete_resources
    ;;
  render)
    render
    ;;
  *)
    echo "Usage: $0 [deploy|status|logs|restart|delete|render]"
    exit 1
    ;;
esac
