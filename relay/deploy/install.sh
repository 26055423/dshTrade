#!/usr/bin/env bash
# 在服务器上装 dshTrade 中继。它和同机其它项目（例如 SyncNote）完全独立：
# 自己的目录、用户、运行时、数据库、systemd 单元，以及 nginx 的一个独立片段目录。
#
# 用法：sudo bash install.sh [server.js 路径] [域名]
#   域名缺省 sync-trade.top；中继会挂到 https://<域名>/relay/。
#
# 卸载：
#   systemctl disable --now dshtrade-relay
#   rm -f /etc/systemd/system/dshtrade-relay.service /etc/nginx/dshtrade.d/relay.conf
#   rm -rf /opt/dshtrade-relay /var/lib/dshtrade
#   systemctl daemon-reload && systemctl reload nginx
# 注：/etc/nginx/dshtrade.d/ 空了也不会影响 nginx，因为站点里 include 的是目录通配。
set -euo pipefail

SRC="${1:-server.js}"
DOMAIN="${2:-sync-trade.top}"
NODE_VERSION="${NODE_VERSION:-v22.20.0}"
APP=/opt/dshtrade-relay
DATA=/var/lib/dshtrade
UNIT=/etc/systemd/system/dshtrade-relay.service
SNIPPET_DIR=/etc/nginx/dshtrade.d
SNIPPET=$SNIPPET_DIR/relay.conf

[ -f "$SRC" ] || { echo "找不到 $SRC"; exit 1; }

# ---- 私有 Node 运行时（属于本项目，卸载时一起删）----
NODE_BIN=$APP/runtime/bin/node
if [ ! -x "$NODE_BIN" ]; then
  echo "安装私有 Node $NODE_VERSION 到 $APP/runtime"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" -o /tmp/dshtrade-node.tar.gz
  mkdir -p "$APP/runtime"
  tar -xzf /tmp/dshtrade-node.tar.gz -C "$APP/runtime" --strip-components=1
  rm -f /tmp/dshtrade-node.tar.gz
fi
"$NODE_BIN" -e "require('node:sqlite')" || { echo "这个 Node 没有 node:sqlite，需要 22.5+"; exit 1; }

# ---- 用户、目录、代码 ----
id dshtrade >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin dshtrade
install -d -o dshtrade -g dshtrade "$APP" "$DATA"
install -o dshtrade -g dshtrade -m 0644 "$SRC" "$APP/server.js"
chown -R dshtrade:dshtrade "$APP/runtime"

# ---- systemd ----
cat > "$UNIT" <<EOF
[Unit]
Description=dshTrade thin relay (ciphertext envelopes only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dshtrade
Group=dshtrade
WorkingDirectory=$APP
Environment=RELAY_HOST=127.0.0.1
Environment=RELAY_PORT=8791
Environment=RELAY_DB=$DATA/relay.db
Environment=RELAY_TTL=604800
ExecStart=$NODE_BIN $APP/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dshtrade-relay >/dev/null 2>&1 || true
systemctl restart dshtrade-relay
sleep 1
curl -fsS http://127.0.0.1:8791/v1/health >/dev/null || { echo "中继没起来：journalctl -u dshtrade-relay -n 50"; exit 1; }
echo "中继已在 127.0.0.1:8791 运行"

# ---- nginx：独立片段目录 + 站点里只加一行 include ----
install -d "$SNIPPET_DIR"
cat > "$SNIPPET" <<'EOF'
# dshTrade 中继。删掉本文件即可下线这个路径，站点本身的配置不用改。
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
EOF

INCLUDE_LINE="include $SNIPPET_DIR/*.conf;"
CONF=$(grep -rl "server_name[[:space:]]*${DOMAIN}" /etc/nginx 2>/dev/null | grep -v "$SNIPPET_DIR" | head -1 || true)
if [ -z "$CONF" ]; then
  echo "没找到 ${DOMAIN} 的站点配置；请手动在 443 server 块里加一行：$INCLUDE_LINE"
  exit 0
fi

if grep -qF "$INCLUDE_LINE" "$CONF"; then
  echo "站点已包含 $INCLUDE_LINE，跳过"
  nginx -t && systemctl reload nginx
else
  BACKUP="${CONF}.bak-$(date +%Y%m%d%H%M%S)"
  cp -a "$CONF" "$BACKUP"
  echo "已备份到 $BACKUP"
  python3 - "$CONF" "$INCLUDE_LINE" <<'PY'
import sys
path, line = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().splitlines(keepends=True)
last = None
for i, text in enumerate(lines):
    if text.strip() == '}':
        last = i
if last is None:
    sys.exit('配置文件里没有可插入的位置')
lines.insert(last, '    ' + line + '\n')
open(path, 'w', encoding='utf-8').writelines(lines)
print('已在', path, '的最后一个 server 块里加入 include')
PY
  if ! nginx -t 2>&1; then
    echo "nginx 语法检查失败，回滚站点配置"
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
  echo "中继已可用：https://${DOMAIN}/relay — relayUrl 填这个地址"
else
  echo "自检没通过，检查证书/安全组后手动试 https://${DOMAIN}/relay/v1/health"
fi
