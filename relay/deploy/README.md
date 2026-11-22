# 部署中继

中继是独立进程，和旧站 Tongpin 只共用一台机器与一个 HTTPS 入口，不读写它的代码和数据库。

## 1. 建目录与用户

```bash
sudo useradd --system --home /opt/dshtrade-relay --shell /usr/sbin/nologin dshtrade
sudo mkdir -p /opt/dshtrade-relay /var/lib/dshtrade
sudo cp server.js /opt/dshtrade-relay/server.js
sudo chown -R dshtrade:dshtrade /opt/dshtrade-relay /var/lib/dshtrade
```

`server.js` 零依赖，只要求 Node 22+（`node:sqlite`）。

## 2. systemd

```bash
sudo cp dshtrade-relay.service /etc/systemd/system/dshtrade-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now dshtrade-relay
curl -s http://127.0.0.1:8791/v1/health
```

## 3. 反向代理

把 `nginx-relay.conf` 里的 `location /relay/` 放进现有 443 站点块，然后 `sudo nginx -t && sudo systemctl reload nginx`。

```bash
curl -s https://<你的域名>/relay/v1/health
```

## 4. 写进插件

`cordis.patch.yml` 或插件配置里：

```yaml
relayUrl: https://<你的域名>/relay
```

保存后插件会重新登记本机公钥（`identity.js` 里的 Ed25519/X25519），好友码不变。

## 注意

- 中继只存密文信封；`/v1/ack` 之后立刻删除，未确认的按 `RELAY_TTL` 过期。
- 不要把 8791 直接暴露到公网，只让 nginx 从回环访问。
- 换域名或换路径前缀都必须同步改 `relayUrl`，否则好友互相取不到件。
