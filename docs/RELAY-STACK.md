# 中继技术栈评估：复用 SyncNote 还是引入 Node

## 背景

- 线上服务器 `43.103.49.141` 跑的是 `SyncNote`：`syncnote.service` → `/usr/bin/python3 /SyncTrade/app_server.py`，监听 `127.0.0.1:18886`，nginx 443 反代，数据在 `/SyncTrade/data`。
- 后端**纯 Python 3.12 标准库**（无 pip 依赖）；前端 Vite 8 + React 19 + Vela，构建产物由后端静态分发。
- 服务器上**没有 Node**；`/opt` 是空的。
- 中继（relay）是这个插件唯一的服务端组件：只转发端到端加密的信封，不碰旧站数据。

## 候选

| | A. Node 22 版（现仓库 `relay/server.js`） | B. Python 3.12 版（stdlib + `cryptography`） |
|---|---|---|
| 运行时 | 需要新装 Node 22（约 100MB，装 `/opt/node22`） | 服务器已有 `python3` 3.12.3 |
| 加密依赖 | Node `node:crypto` 内置 | `python3-cryptography` **41.0.7，apt 已装**（`ii python3-cryptography 41.0.7-4ubuntu0.4`） |
| 与现有运维 | 新增一套运行时与升级路径 | 和 `syncnote.service` 同一套 systemd / 日志 / Python 运维习惯 |
| 实现状态 | 已实现，5 套测试覆盖（含 `/relay` 前缀、无明文、幂等投递） | 只有草案，未提交、未测 |
| 内存 | 约 40–60MB | 约 20–30MB |
| 仓库依赖 | 零依赖单文件 | 一个 Python 文件 + 一个已存在的系统包 |
| 风险 | 多一个运行时；与旧站技术栈不一致 | 需要移植实现并补齐同等测试；加密调用要正确 |

## 评估

**结论：选 B（Python 版），删除 Node 版。**

理由：

1. **不新增运行时**。服务器上 `cryptography` 是 apt 系统包（41.0.7），不是为这个项目装的，直接可用；本机 Python 3.12 也有 46.0.5，可以本地跑全套测试。
2. **运维同构**。中继就是一个 `python3 relay/server.py` 的 systemd 服务，和 `syncnote.service` 的写法、日志、目录约定一致，出问题的人不用学第二种运行时。
3. **负载极小**。中继只做：验签、写一行密文、按收件人取件、确认删除。邮件箱上限 2000 条，单条上限 256KB，实际每秒个位数请求，`ThreadingHTTPServer` + 每请求一个 SQLite 连接（WAL）完全够。
4. **加密不手写**。Ed25519 验签交给 `cryptography`（OpenSSL 后端），不自己实现曲线运算。

代价与缓解：

| 代价 | 缓解 |
|---|---|
| 放弃「零依赖 Node」这个卖点 | 换来不装运行时的部署简单性；文档写清楚依赖是 apt 包 |
| 需要把 Node 版移植成 Python 并补齐测试 | 移植后删除 `server.js`，只保留一份实现，避免漂移 |
| `cryptography` 版本差异（服务器 41 / 本机 46） | 只用 `serialization.load_der_public_key` + `Ed25519PublicKey.verify`，两版都稳定 |
| 并发模型 | 每请求一个短连接 SQLite + 线程池；限流 240 次/分/IP，与 Node 版一致 |

## 验收标准

1. `python3 -m py_compile relay/server.py` 通过。
2. 现有客户端测试全部改为启动 `python3 relay/server.py` 子进程，断言不变：
   注册 / 好友码 / 加密投递 / 解密落库 / 中继无明文 / `/relay` 前缀 / 幂等。
3. 部署后 `https://sync-trade.top/relay/v1/health` 返回 `{"ok":true,...}`。
4. 用本机真实身份向中继注册一次（`/dshtrade/api/state` 的 `im.registered` 为 `true`）。
5. 部署前后 `curl -s https://sync-trade.top/` 与旧站交易接口响应不变。

## 不采用的方案

- **在服务器上装 Node**：只为 300 行中继装一个运行时，且与旧站技术栈分叉；除非以后本项目在服务器上还有别的 Node 需求。
- **纯标准库手写 Ed25519 验签**：验证只需约 80 行，但密码学代码不应该手写；`cryptography` 已经是系统包，没有理由重造。
