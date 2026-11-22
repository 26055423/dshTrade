# 部署中继

中继是**独立项目**：自己的目录、用户、Node 运行时、数据库、systemd 单元和 nginx 片段。
和同机的其它项目只共用一件事——域名和证书（只读复用）。删掉中继不会影响别人，反之亦然。

## 一条命令

```bash
scp relay/server.js relay/deploy/install.sh admin@<服务器>:/tmp/
ssh admin@<服务器> "sudo bash /tmp/install.sh /tmp/server.js sync-trade.top"
```

脚本做的事：

1. 把 Node 22 装到 `/opt/dshtrade-relay/runtime/`（**项目私有**，不写 `/usr/local/bin`，卸载时一起删）；
2. 建 `dshtrade` 用户、`/opt/dshtrade-relay`、`/var/lib/dshtrade`，装 `dshtrade-relay.service`；
3. 服务只监听 `127.0.0.1:8791`，用 `RELAY_DB=/var/lib/dshtrade/relay.db`；
4. 写 nginx 片段 `/etc/nginx/dshtrade.d/relay.conf`，并在站点 443 server 块里加**一行** `include /etc/nginx/dshtrade.d/*.conf;`（已存在就跳过；改动前备份，`nginx -t` 失败自动回滚）；
5. `systemctl reload nginx` 后用 `https://<域名>/relay/v1/health` 自检。

幂等：重复执行只更新 `server.js`、重启服务、覆盖片段。

## 为什么用「目录通配 + include 一行」

站点配置里只有一行 `include /etc/nginx/dshtrade.d/*.conf;`，它指向一个空目录也合法。
下线中继时只删 `/etc/nginx/dshtrade.d/relay.conf`，目录空了、`nginx -t` 依然通过，
**旧站配置不需要再改一次**。如果直接把 `location /relay/` 写进站点配置，删中继就得回头改别人的文件。

## 独立性验收

```bash
# 中继停掉：站点照旧，/relay 变成 502
sudo systemctl stop dshtrade-relay
curl -s -o /dev/null -w '%{http_code}\n' https://sync-trade.top/
curl -s -o /dev/null -w '%{http_code}\n' https://sync-trade.top/relay/v1/health
sudo systemctl start dshtrade-relay

# 片段摘掉：nginx 配置仍然合法
sudo mv /etc/nginx/dshtrade.d/relay.conf /tmp/
sudo nginx -t
sudo mv /tmp/relay.conf /etc/nginx/dshtrade.d/
```

## 卸载

```bash
sudo systemctl disable --now dshtrade-relay
sudo rm -f /etc/systemd/system/dshtrade-relay.service /etc/nginx/dshtrade.d/relay.conf
sudo rm -rf /opt/dshtrade-relay /var/lib/dshtrade
sudo systemctl daemon-reload && sudo systemctl reload nginx
```

站点配置里那行 `include` 留着也没关系（空目录合法）；想清干净再手动把它删掉。

## 写进插件

`cordis.patch.yml` 或插件配置里：

```yaml
relayUrl: https://sync-trade.top/relay
```

保存后插件会重新登记本机公钥（Ed25519/X25519），好友码不变。

## 注意

- 中继只存密文信封；`/v1/ack` 之后立刻删除，未确认的按 `RELAY_TTL` 过期。
- 不要把 8791 暴露到公网，只让 nginx 从回环访问。
- 换域名、换路径前缀都必须同步改 `relayUrl`，否则好友互相取不到件。
