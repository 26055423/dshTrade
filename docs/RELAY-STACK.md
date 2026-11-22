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

**结论：选 A（Node 版）。**

理由：

1. **加密协议只有一份实现**。信封 canonical 串、DER/base64url 编码、好友码指纹都定死在 Node 里并被测试覆盖；换语言等于把安全边界重新推导一遍，错了只表现为「偶尔收不到」。
2. **运行时成本是一次性的**。Node 装在 `/opt/dshtrade-relay/runtime`，属于本项目私有，和旧站没有共享；卸载时随项目删除。
3. **和插件同栈**。本地加解密与中继验签可以共用同一批测试向量，漂移风险最低。

服务器原先没有 Node 这一点，只影响「装不装」的便利性，不改变上面的取舍。

放弃的替代方案：

- **Python 版**：服务器有 `python3` 和 apt 的 `python3-cryptography`，确实不用装运行时；但中继是协议里有签名的那一类，双实现 + 跨语言测试的长期成本更高。只有在「服务器不许装第三方运行时」或「服务端要做重度统计」时才更划算。
- **纯标准库手写 Ed25519 验签**：密码学代码不手写。

## 部署形态（已落地）

- 独立项目：`/opt/dshtrade-relay`（含私有 Node 运行时）、用户 `dshtrade`、库 `/var/lib/dshtrade/relay.db`、`dshtrade-relay.service`；
- 只监听 `127.0.0.1:8791`；
- nginx 只共用域名与证书：片段放 `/etc/nginx/dshtrade.d/relay.conf`，站点 443 块里一行 `include /etc/nginx/dshtrade.d/*.conf;`；
- 删中继 = 删片段 + 停服务 + 删目录，站点配置不用动；反过来中继挂掉也只是 `/relay/*` 502。
- 步骤与卸载见 `relay/deploy/README.md`。

## 验收标准

1. `python3 -m py_compile relay/server.py` 通过。（Node 方案下不适用，改为 `node --check relay/server.js` 与本地 5 套测试。）
2. 中继测试覆盖：注册 / 好友码 / 加密投递 / 解密落库 / 中继无明文 / `/relay` 前缀 / 幂等。
3. `https://sync-trade.top/relay/v1/health` 返回 `{"ok":true,...}`。
4. 本机身份注册成功（`/dshtrade/api/state` 的 `im.registered` 为 `true`）。
5. 旧站首页与交易接口在部署前后响应不变；停掉中继、摘掉片段时旧站仍正常。


## 不采用的方案

- **在服务器上装 Node**：只为 300 行中继装一个运行时，且与旧站技术栈分叉；除非以后本项目在服务器上还有别的 Node 需求。
- **纯标准库手写 Ed25519 验签**：验证只需约 80 行，但密码学代码不应该手写；`cryptography` 已经是系统包，没有理由重造。
