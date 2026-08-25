#!/usr/bin/env bash
# Installs/refreshes the govee-cli web console app services. Needs NO sudo:
# both are systemd *user* units (linger is enabled, so they survive logout).
#
#     ./deploy/install-services.sh
#
# Run this after every `git pull` that touches webui/ — it reinstalls deps,
# rebuilds the frontend, and restarts both units. Then, only the first time
# (or if the nginx site changes), run ./deploy/install-nginx-govee.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
cd "$REPO"

echo "==> python sidecar deps"
[[ -d .venv ]] || python3 -m venv .venv
./.venv/bin/pip install -q -e ".[webui]"
echo "    ok"

echo "==> frontend build"
cd "$REPO/webui/app"
npm ci --silent
npm run build
cd "$REPO"

echo "==> systemd user units"
mkdir -p "$UNIT_DIR"
install -m 0644 deploy/govee-webui-api.service deploy/govee-webui.service "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable govee-webui-api.service govee-webui.service >/dev/null
# restart (not start) so a re-run picks up the new build.
systemctl --user restart govee-webui-api.service govee-webui.service

echo "==> verifying"
for i in $(seq 1 20); do
    if curl -sf -m 5 http://127.0.0.1:6056/api/v1/health >/dev/null 2>&1; then break; fi
    sleep 2
done

systemctl --user is-active govee-webui-api.service govee-webui.service

health=$(curl -s -m 30 http://127.0.0.1:6056/api/v1/health || true)
echo "    health: $health"
grep -q '"status":"ok"' <<<"$health" || { echo "!! sidecar unhealthy" >&2; exit 1; }
grep -q '"mock":false' <<<"$health" || { echo "!! sidecar is in MOCK mode" >&2; exit 1; }

echo "    local stack up on 127.0.0.1:6056"
echo
echo "==> next: ./deploy/install-nginx-govee.sh   (sudo — exposes it on the tailnet)"
