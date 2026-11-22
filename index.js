/**
 * 同频（dshTrade）Host 插件。
 *
 * 本机优先：EA 直连 + 本地 SQLite。没有云端账号，也没有上传。
 * 旧站 Tongpin 不在这个进程里，也不被引用。
 */
import path from 'node:path'
import { Store } from './host/store.js'
import { EaClient } from './host/ea.js'
import { registerRoutes } from './host/routes.js'

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const log = (...args) => console.log('[dshtrade]', ...args)
  const home = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || process.cwd()
  const dataDir = String(config.dataDir || path.join(home, 'dshtrade'))
  const store = new Store(path.join(dataDir, 'dshtrade.db'))
  const ea = new EaClient({
    url: String(config.eaUrl || 'ws://127.0.0.1:18765/ws'),
    origin: String(config.eaOrigin || '').trim() || pageOrigin(ctx),
    symbol: String(config.symbol || 'XAUUSD'),
    tf: String(config.tf || '1m'),
    store,
    log,
  })

  ctx.effect(() => {
    ea.start()
    return () => {
      ea.stop()
      store.close()
    }
  })

  registerRoutes(ctx, { store, ea, log })
  log('ready', { dataDir, ea: String(config.eaUrl || 'ws://127.0.0.1:18765/ws') })
}

function pageOrigin(ctx) {
  try { return ctx.webServer.getOrigin() } catch { return '' }
}
