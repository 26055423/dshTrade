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
| POST | `/dshtrade/api/pair` | `{code:"8位数字"}`，转发给 EA |
| POST | `/dshtrade/api/bars` | `{tf,limit}`，向 EA 请求历史 K 线 |
| POST | `/dshtrade/api/notes` | `{id?,ticket,body,tags}`，写入本地笔记 |

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
  "counts": {"trades":0,"bars":0,"notes":0,"messages":0}
}
```

## 2. EA 连接

- 端点：`ws://127.0.0.1:18765/ws`，子协议 `tongpin-local.v1`。
- 握手必须带 `Origin`，值取插件配置 `eaOrigin`；EA 只接受精确匹配。
- 只读阶段发送：`ping`、`snapshot`、`bars`。不发送 `command`。
- 本地令牌只存在 Host 内存，不落库、不进日志。

## 3. 未来：中继信封

中继为独立项目，只转发密文，不参与业务字段。计划中的信封：

```json
{"v":1,"id":"...","from":"<公钥指纹>","to":"<公钥指纹>","sent_at":0,"ttl":604800,"nonce":"...","box":"<base64>"}
```

- 密钥对在本机生成，私钥不出 Host。
- 卡片消息的正文加密后放进 `box`，中继看不到图表、笔记或成交。
- 中继只保存收件人信箱与投递时间，过期即删。
