#!/usr/bin/env bash
# Batches every sudo-requiring step for the govee-cli web console into one run.
#
# The two app services are systemd *user* units (see deploy/*.service) and are
# already installed + running without root; only nginx needs privileges. Run:
#
#     ./deploy/install-nginx-govee.sh
#
# Idempotent: safe to re-run. Leaves nginx untouched if the config fails its
# syntax check.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/deploy/nginx-govee.conf"
AVAIL=/etc/nginx/sites-available/govee.conf
ENABLED=/etc/nginx/sites-enabled/govee.conf
TAILSCALE_IP=100.121.176.1

echo "==> govee web console: nginx setup"
[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }

# Fail early and clearly if the app services aren't up — otherwise nginx would
# happily proxy to nothing and the browser would just show 502.
for unit in govee-webui-api govee-webui; do
    if ! systemctl --user is-active --quiet "$unit.service"; then
        echo "!! $unit.service is not active. Start it first:" >&2
        echo "     systemctl --user enable --now $unit.service" >&2
        exit 1
    fi
done
echo "    user services active (6057 sidecar, 6056 next)"

echo "==> requesting sudo (nginx config install + reload)"
sudo -v

# Everything privileged happens in this single block: one password prompt.
sudo bash -s -- "$SRC" "$AVAIL" "$ENABLED" <<'SUDO_BLOCK'
set -euo pipefail
SRC="$1"; AVAIL="$2"; ENABLED="$3"

# Keep a backup of any previous version so a bad edit is recoverable.
if [[ -f "$AVAIL" ]] && ! cmp -s "$SRC" "$AVAIL"; then
    cp -a "$AVAIL" "$AVAIL.bak.$(date +%Y%m%d%H%M%S)"
    echo "    backed up previous $AVAIL"
fi

install -o root -g root -m 0644 "$SRC" "$AVAIL"
ln -sfn "$AVAIL" "$ENABLED"
echo "    installed $AVAIL and symlinked into sites-enabled"

# Validate BEFORE reloading. If this fails, set -e aborts and the running
# nginx keeps serving the old (working) config.
if ! nginx -t; then
    echo "!! nginx config test failed — removing the new site and leaving nginx as-is" >&2
    rm -f "$ENABLED"
    exit 1
fi

systemctl reload nginx
echo "    nginx reloaded"
SUDO_BLOCK

echo "==> verifying"
sleep 2

# nginx must now be listening on the tailnet IP.
if ss -tln 2>/dev/null | grep -q "$TAILSCALE_IP:6056"; then
    echo "    nginx listening on $TAILSCALE_IP:6056"
else
    echo "!! nothing listening on $TAILSCALE_IP:6056" >&2
    exit 1
fi

# End-to-end through TLS: page, then the API behind the Next.js rewrite.
code=$(curl -sk -o /dev/null -w '%{http_code}' -m 15 "https://$TAILSCALE_IP:6056/")
echo "    GET / -> HTTP $code"
[[ "$code" == "200" ]] || { echo "!! frontend not reachable through nginx" >&2; exit 1; }

health=$(curl -sk -m 30 "https://$TAILSCALE_IP:6056/api/v1/health")
echo "    GET /api/v1/health -> $health"
grep -q '"status":"ok"' <<<"$health" || { echo "!! sidecar not reachable through nginx" >&2; exit 1; }

cat <<DONE

==> done. Open the console:

      https://$TAILSCALE_IP:6056        (or https://pop-os:6056 on the tailnet)

    The cert is the shared self-signed tailscale-proxy cert, so expect the
    usual browser warning — same as Portainer/Uptime Kuma/etc.
DONE
