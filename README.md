# dshTrade

同频（Tongpin）的 DeepSeek Harness 插件：**本机优先**的本机交易台。数据默认只留在本机，不依赖云端站点。

- 直连本机 MT5 EA（`ws://127.0.0.1:18765/ws`），读账户、持仓、挂单、tick 与 K 线。
- 成交、已收盘 K 线、复盘笔记写入本机 SQLite。
- 后续：K 线交易台、复盘编辑、端到端加密的 IM 与复盘卡片分享（独立薄中继）。
- 旧站 Tongpin 保持不动，本项目不引用它的代码或数据。

## 结构

```
index.js            Host 插件入口（Cordis）
host/ea.js          EA WebSocket 客户端（自带 RFC6455 握手/帧）
host/store.js       本地 SQLite（node:sqlite）
host/identity.js    本机 Ed25519 + X25519 身份与好友码
host/crypto.js      端到端加密与信封签名
host/im.js          好友码添加、加密发送、中继收件
host/routes.js      同源 HTTP 路由
client.js           DSH 客户端插件：设置页、交易台、状态条
docs/PROTOCOL.md    同源路由、EA 连接与中继信封契约
docs/DETAIL.md      插件详情页
relay/server.js     独立薄中继（零依赖，Node 22+）
```

## 开发

```bash
node test/smoke.mjs    # 假 EA：握手/配对/快照/K 线/下单 + 本地库
node test/routes.mjs   # 同源路由：身份、下单、来源校验、参数校验
node test/client.mjs   # 客户端 bundle：解析与三个插槽注册
node test/relay.mjs    # 中继：注册、加密投递、解密落库、无明文
node test/plugin.mjs   # 真正调用 apply：装配、路由注册、卸载
```

安装：DSH **插件 → 添加插件**（本地目录），或 `plugin_manager` 的 `install_bundle` 指向本目录。

配置在 `cordis.patch.yml`：

```yaml
eaUrl: ws://127.0.0.1:18765/ws
eaOrigin: http://127.0.0.1:56162   # DSH 页面地址，EA 的允许来源要包含它
symbol: XAUUSD
```

## 状态

- [x] Host 插件骨架、同源路由、本地库
- [x] EA 握手与配对（只读快照）
- [x] 设置页：连接状态、账户、持仓、好友码
- [x] 交易台：画布 K 线、周期切换、十字光标
- [x] 市价下单与平仓（确认、超时记为未确认、不自动重发）
- [x] 中继：登记、加密投递、确认删除
- [x] IM Host：好友码、收发消息、复盘卡片载荷、本地会话
- [x] IM 界面：会话列表、气泡、好友码添加、卡片缩略图
- [x] 交易台内分享复盘卡片（当前窗口 K 线 + 附言）
- [ ] 复盘点与笔记编辑界面
- [ ] EA 侧允许 DSH 本地 Origin（需要改 EA 源码）
