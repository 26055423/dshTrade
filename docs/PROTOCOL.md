# dshTrade 本机协议

本文档记录插件自己新增的契约。EA 侧协议仍以既有 `tongpin-local.v1` 为准（见旧项目的 `bridge/LOCAL_PROTOCOL.md`），这里只写包装层。

## 1. 同源 HTTP

浏览器只访问 DSH 自身地址下的 `/dshtrade/api/*`，不跨域、不带 Cookie。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dshtrade/api/state` | EA 相位、身份、账户、持仓、挂单、tick、本地库计数；不含 K 线正文 |
| GET | `/dshtrade/api/health` | 存活与相位 |
| GET | `/dshtrade/api/trades?from&to&symbol&limit` | 本地成交，按平仓时间倒序 |
| GET | `/dshtrade/api/bars?symbol&tf&from&to&limit` | 本地已收盘 K 线 |
| GET | `/dshtrade/api/notes?limit` | 本地笔记 |
| GET | `/dshtrade/api/commands?limit` | 本机指令记录 |
| POST | `/dshtrade/api/pair` | `{code:"8位数字"}`，转发给 EA |
| POST | `/dshtrade/api/bars` | `{tf,limit}`，向 EA 请求历史 K 线 |
| POST | `/dshtrade/api/notes` | `{id?,ticket,body,tags}`，写入本地笔记 |
| POST | `/dshtrade/api/command` | 市价/平仓/撤单/改单，见第 4 节 |

写接口校验 `Origin` 与 `Sec-Fetch-Site`；`Origin` 必须等于 `ctx.webServer.getOrigin()`。

### state 形状

```json
{
  "ok": true,
  "ea": {
    "phase": "connected",
    "error": "",
    "identity": {"account_id":"5001","server":"Broker-Demo","epoch":"...","demo":true,"read_only":true,"trade_enabled":false,"capabilities":[]},
    "account": {"balance":0,"equity":0,"margin":0,"free_margin":0,"profit":0,"currency":"USD"},
    "positions": [], "orders": [], "tick": null, "bars": {"1m": 500},
    "updated": 0
  },
  "counts": {"trades":0,"bars":0,"notes":0,"messages":0},
  "identity": {"friend_code":"TP-XXXX-XXXX-XXXX-XXXX","fingerprint":"...","public_key":"..."}
}
```

## 4. 交易命令

`POST /dshtrade/api/command` 只放行协议允许的字段：

| action | 字段 |
|---|---|
| `market` | `side=buy/sell`、`volume>0`、可选 `sl`、`tp`、`deviation`、`symbol` |
| `close` | `position_ticket`、`volume`（0 = 全平） |
| `cancel` | `order_ticket` |
| `modify` | `ticket`、`sl`、`tp` |

Host 在发送前检查：EA 已连接、`trade_enabled`、`capabilities` 包含该动作。EA 仍会做它自己的最终校验。

- 每次确认生成一个 `command_id`，**只发送一次**；超时或断线返回 `state:"uncertain"`，不自动重发。
- 结果写入本地 `commands` 表，返回给界面。
- `expires_at_ms` 为当前时间 +10 秒，EA 拒绝过期指令。

## 2. EA 连接

- 端点：`ws://127.0.0.1:18765/ws`，子协议 `tongpin-local.v1`。
- 握手必须带 `Origin`，值取插件配置 `eaOrigin`（缺省为 DSH 页面地址）。
- EA 默认同时接受两类来源：精确的 `InpAllowedOrigin`（HTTPS 网站），以及任意回环 `http://127.0.0.1:<端口>` / `http://localhost:<端口>`；后者由 `InpAllowLocalOrigin` 控制，关闭后只认网站来源。
- 只读阶段发送：`ping`、`snapshot`、`bars`。不发送 `command`。
- 本地令牌只存在 Host 内存，不落库、不进日志。

## 3. 中继与 IM

中继是独立项目（`relay/server.js`），只转发密文。

### 3.1 登记

本机首次使用中继时登记两把公钥：

```json
POST /v1/register
{"code":"TP-XXXX-XXXX-XXXX-XXXX","ed25519":"<SPKI DER base64>","x25519":"<SPKI DER base64>","sig":"<base64url>"}
```

`sig` 是 `dshtrade-register-v1\n<code>\n<ed25519>\n<x25519>` 的 Ed25519 签名；中继验签后返回一次性 Bearer 令牌。`GET /v1/keys?code=...` 供发件人取公钥。

### 3.2 信封

```json
{
  "v": 1, "id": "<uuid>", "from": "TP-...", "to": "TP-...",
  "sent": 0, "ttl": 604800, "nonce": "<base64>", "box": "<base64>", "sig": "<base64url>"
}
```

- `box` = AES-256-GCM(X25519 共享密钥, JSON 正文)，正文形如 `{"kind":"text|card","text":"...","card":{...},"at":0}`。
- `sig` 是 `v\nid\nfrom\nto\nsent\nttl\nnonce\nbox` 的签名，中继入库前验证。
- `POST /v1/send` 需 Bearer；`POST /v1/inbox` 取件；`POST /v1/ack` 删除。TTL 到期自动清理。
- 中继不保存正文，也不保存公钥之外的任何个人资料。

### 3.3 复盘卡片

`kind:"card"` 的 `card` 由发件人本地生成，至少包含 `symbol`、`tf`、`note` 与当时窗口的 K 线摘要。收件人用本地画布渲染，不需要访问发件人的券商数据。卡片仍受同一信封加密与 TTL 约束。
