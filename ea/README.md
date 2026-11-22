# SyncTrade EA（本仓版本）

来源：旧站 Tongpin 的 `bridge/SyncTrade.mq5` 1.113，原样复制，只加了一处改动：

- 新参数 **`InpAllowLocalOrigin`**（默认 `true`）：在原有精确 HTTPS 来源之外，额外接受
  `http://127.0.0.1:<端口>` 与 `http://localhost:<端口>` 的 `Origin`（仅回环地址）。

只读版 `SyncNoteLocal` 不在本仓库，行为不变：回环放行默认关闭，只有本 EA 的参数会打开它。

## 编译

```powershell
& 'C:\Program Files\MetaTrader 5\MetaEditor64.exe' `
  /compile:"<仓库>\ea\SyncTrade.mq5" `
  /log:"<仓库>\ea\SyncTrade.compile.log"
```

本仓提交的 `SyncTrade.ex5` 由上述命令编译，结果：`0 errors, 0 warnings`。

## 安装

1. 把 `SyncTrade.ex5` 放进 MT5 的 `MQL5/Experts`（或直接用 MetaEditor 打开 `.mq5` 编译）。
2. MT5 选项里允许系统 DLL 导入（`Ws2_32.dll`、`bcrypt.dll`）。
3. 挂到图表，确认面板显示监听 `127.0.0.1:18765`。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `InpAllowedOrigin` | `https://sync-trade.top` | 网页来源，必须是一个精确的 HTTPS 来源 |
| `InpAllowLocalOrigin` | `true` | 额外放行回环来源，供 DSH 插件连接（插件端口每次启动可能不同） |

## 安全边界

- 回环放行只解决“谁能发起 WebSocket 握手”，**配对仍然需要 8 位配对码 + EA 图表上的本地确认**。
- 不接受公网来源；非回环来源仍必须与 `InpAllowedOrigin` 完全一致。
- 关闭 `InpAllowLocalOrigin` 即回到旧行为，只认网站 HTTPS 来源。
