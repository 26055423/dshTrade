#!/usr/bin/env bash
# 在服务器上装中继（只装中继，不碰旧站代码和数据）。
# 用法：sudo bash install.sh /path/to/server.js
set -euo pipefail

SRC="${1:-server.js}"
APP=/opt/dshtrade-relay
DATA=/var/lib/dshtrade
UNIT=/etc/systemd/system/dshtrade-relay.service

command -v node >/dev/null || { echo "需要 Node 22+（node:sqlite）"; exit 1; }
node -e "require('node:sqlite')" 2>/dev/null || { echo "当前 node 版本没有 node:sqlite，请升级到 22+"; exit 1; }

id dshtrade >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin dshtrade

install -d -o dshtrade -g dshtrade "$APP" "$DATA"
install -o dshtrade -g dshtrade -m 0644 "$SRC" "$APP/server.js"

cat > "$UNIT" <<'EOF'
[Unit]
Description=dshTrade thin relay (ciphertext envelopes only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dshtrade
Group=dshtrade
WorkingDirectory=/opt/dshtrade-relay
Environment=RELAY_HOST=127.0.0.1
Environment=RELAY_PORT=8791
Environment=RELAY_DB=/var/lib/dshtrade/relay.db
Environment=RELAY_TTL=604800
ExecStart=/usr/bin/node /opt/dshtrade-relay/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dshtrade

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now dshtrade-relay
sleep 1
curl -fsS http://127.0.0.1:8791/v1/health && echo
echo "中继已启动；下一步把 nginx-relay.conf 的 location /relay/ 放进 443 站点块并 reload nginx。"
