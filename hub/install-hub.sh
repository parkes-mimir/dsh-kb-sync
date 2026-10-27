#!/usr/bin/env bash
# 在 hub 服务器上安装通知服务（Debian/Ubuntu，systemd）
#   sudo ./install-hub.sh /home/mnemon/mnemon-sync.git
set -euo pipefail
REPO="${1:?用法: install-hub.sh <bare-repo-path>}"
TOKEN="${KB_NOTIFY_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -d -m 755 /opt/kb-notify
install -m 755 "$HERE/kb-hub-notify.py" /opt/kb-notify/kb-hub-notify.py
printf '%s\n' "$TOKEN" > /etc/kb-notify.token
chmod 600 /etc/kb-notify.token
chown mnemon:mnemon /etc/kb-notify.token 2>/dev/null || true

install -m 755 -o mnemon -g mnemon "$HERE/post-receive" "$REPO/hooks/post-receive"

sed "s#/home/mnemon/mnemon-sync.git#$REPO#" "$HERE/kb-notify.service" > /etc/systemd/system/kb-notify.service
systemctl daemon-reload
systemctl enable --now kb-notify.service
sleep 1
systemctl --no-pager --lines=5 status kb-notify.service | head -8
echo "token: $TOKEN"
echo "health: $(curl -s http://127.0.0.1:7392/health || true)"
