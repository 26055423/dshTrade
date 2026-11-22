# 中继（relay）

独立项目，不修改也不依赖旧站 Tongpin。只做一件事：在两位 DSH 用户之间转发**密文信封**。

- 不解析业务字段，不保存图表、笔记或成交。
- 每个收件人一个信箱，按好友码（公钥指纹）寻址；信封 TTL 到期即删，收件人确认后立即删除。
- 没有账号、密码、邀请码；登记时用 Ed25519 证明持有私钥。
- 单文件、零依赖（Node 22+ 内置 `node:sqlite` 与 `fetch`）。

## 运行

```bash
node relay/server.js
# 或
RELAY_PORT=8791 RELAY_HOST=127.0.0.1 RELAY_DB=/var/lib/dshtrade/relay.db node relay/server.js
```

放到服务器时建议只监听回环或内网，由 nginx 终止 TLS 并反向代理；不要直接暴露明文端口。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_PORT` | `8791` | 监听端口 |
| `RELAY_HOST` | `127.0.0.1` | 监听地址 |
| `RELAY_DB` | `relay.db` | SQLite 路径 |
| `RELAY_TTL` | `604800` | 信封最长保留秒数（上限） |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 存活与信封数量 |
| POST | `/v1/register` | 登记公钥，返回 Bearer 令牌 |
| GET | `/v1/keys?code=` | 取公钥 |
| POST | `/v1/send` | 投递信封（Bearer，验签） |
| POST | `/v1/inbox` | 取件（Bearer） |
| POST | `/v1/ack` | 确认删除（Bearer） |

协议细节见 `../docs/PROTOCOL.md` 第 3 节。
