#!/usr/bin/env bash
# 在服务器上装中继（只装中继，不碰旧站代码和数据）。
#
# 用法：sudo bash install.sh [/path/to/server.js] [域名]
#   域名缺省 sync-trade.top；中继会挂在 https://<域名>/relay/。
# 幂等：重复执行只会更新 server.js 并重启服务，nginx 里已有 location /relay/ 就不再插入。
set -euo pipefail

SRC="${1:-server.js}"
DOMAIN="${2:-sync-trade.top}"
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
systemctl enable dshtrade-relay >/dev/null 2>&1 || true
systemctl restart dshtrade-relay
sleep 1
curl -fsS http://127.0.0.1:8791/v1/health >/dev/null || { echo "中继没有起来，看 journalctl -u dshtrade-relay"; exit 1; }
echo "中继已在 127.0.0.1:8791 运行"

# ---- nginx 反代 ----
CONF=$(grep -rl "server_name[[:space:]]*${DOMAIN}" /etc/nginx 2>/dev/null | head -1 || true)
if [ -z "$CONF" ]; then
  echo "没找到 ${DOMAIN} 的站点配置，跳过 nginx；请手动把 location /relay/ 加进 443 站点块"
  exit 0
fi

if grep -q "location /relay/" "$CONF"; then
  echo "nginx 已有 location /relay/，跳过"
else
  BACKUP="${CONF}.bak-$(date +%Y%m%d%H%M%S)"
  cp -a "$CONF" "$BACKUP"
  echo "已备份到 $BACKUP"
  python3 - "$CONF" <<'PY'
import sys
path = sys.argv[1]
snippet = """
    location /relay/ {
        proxy_pass http://127.0.0.1:8791/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        client_max_body_size 512k;
    }
"""
lines = open(path, encoding='utf-8').read().splitlines(keepends=True)
last = None
for i, line in enumerate(lines):
    if line.strip() == '}':
        last = i
if last is None:
    sys.exit('配置文件里没有可插入的位置')
lines.insert(last, snippet)
open(path, 'w', encoding='utf-8').writelines(lines)
print('已把 location /relay/ 插入', path)
PY

  if ! nginx -t 2>&1; then
    echo "nginx 语法检查失败，正在回滚"
    cp -a "$BACKUP" "$CONF"
    nginx -t >/dev/null 2>&1 || true
    exit 1
  fi
  systemctl reload nginx
  echo "nginx 已 reload"
fi

sleep 1
if curl -fsS "https://${DOMAIN}/relay/v1/health"; then
  echo
  echo "中继已可用：https://${DOMAIN}/relay — 把 relayUrl 填成它即可"
else
  echo "本机 curl 没验证通过，检查证书/防火墙后手动试 https://${DOMAIN}/relay/v1/health"
fi
