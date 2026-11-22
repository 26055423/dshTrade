/**
 * IM：本机身份 + 中继投递。
 *
 * 发件人用收件人的 X25519 公钥加密，中继只存密文；收件人解密后落本地库。
 * 没有账号、没有好友申请：交换好友码即可。
 */
import { randomUUID } from 'node:crypto'
import { canonicalEnvelope, open as openBox, seal, verifyText } from './crypto.js'

const TTL = 7 * 24 * 3600

export class Im {
  constructor({ identity, store, relayUrl = '', log = () => {} }) {
    this.identity = identity
    this.store = store
    this.relay = String(relayUrl || '').replace(/\/+$/, '')
    this.log = log
    this.token = store.meta('relay.token', '')
    this.timer = null
    this.phase = this.relay ? 'idle' : 'disabled'
    this.error = ''
    this.lastSync = Number(store.meta('relay.lastSync', '0')) || 0
  }

  status() {
    return {
      phase: this.phase,
      error: this.error,
      relay: this.relay,
      registered: Boolean(this.token),
      last_sync: this.lastSync,
      identity: this.identity.view(),
      contacts: this.store.contacts().length,
    }
  }

  start() {
    if (!this.relay) return
    this.sync().catch((error) => this.fail(error))
    this.timer = setInterval(() => this.sync().catch((error) => this.fail(error)), 6000)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }

  fail(error) {
    this.phase = 'error'
    this.error = String(error?.message || error)
    this.log('relay error', this.error)
  }

  async request(pathName, body, authenticated = false) {
    const headers = { 'Content-Type': 'application/json' }
    if (authenticated) headers.Authorization = 'Bearer ' + this.token
    const response = await fetch(this.relay + pathName, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    })
    const value = await response.json().catch(() => ({}))
    if (!response.ok || value.ok === false) throw new Error(value.error || ('中继返回 ' + response.status))
    return value
  }

  async register() {
    if (!this.relay) return this.status()
    const code = this.identity.friendCode
    const ed25519 = this.identity.edPublic
    const x25519 = this.identity.xPublic
    const sig = this.identity.sign(registerText(code, ed25519, x25519))
    const reply = await this.request('/v1/register', { code, ed25519, x25519, sig })
    this.token = String(reply.token || '')
    this.store.setMeta('relay.token', this.token)
    this.phase = 'ready'
    this.error = ''
    return this.status()
  }

  async lookup(code) {
    const cached = this.store.contact(code)
    if (cached && cached.x25519 && cached.ed25519) return cached
    if (!this.relay) throw new Error('尚未配置中继')
    const response = await fetch(this.relay + '/v1/keys?code=' + encodeURIComponent(code))
    const value = await response.json().catch(() => ({}))
    if (!response.ok || value.ok === false) throw new Error(value.error || '好友码不存在或尚未在中继登记')
    this.store.upsertContact({ code, alias: cached?.alias || '', ed25519: value.ed25519, x25519: value.x25519 })
    return this.store.contact(code)
  }

  async addContact(code, alias = '') {
    const normalized = String(code || '').trim().toUpperCase()
    if (!/^TP-[A-Z0-9-]{4,40}$/.test(normalized)) throw new Error('好友码格式不正确')
    if (normalized === this.identity.friendCode) throw new Error('不能添加自己')
    const contact = await this.lookup(normalized)
    this.store.upsertContact({ code: normalized, alias: String(alias || contact.alias || ''), ed25519: contact.ed25519, x25519: contact.x25519 })
    return this.store.contact(normalized)
  }

  async send(to, payload) {
    if (!this.relay) throw new Error('尚未配置中继')
    if (!this.token) await this.register()
    const contact = await this.lookup(to)
    const plaintext = JSON.stringify({ kind: payload.kind || 'text', text: payload.text || '', card: payload.card || null, at: Date.now() })
    const { nonce, box } = seal(this.identity.xPrivate, contact.x25519, plaintext)
    const envelope = {
      v: 1, id: randomUUID(), from: this.identity.friendCode, to: String(to),
      sent: Date.now(), ttl: TTL, nonce, box,
    }
    envelope.sig = this.identity.sign(canonicalEnvelope(envelope))
    await this.request('/v1/send', { envelope }, true)
    this.store.addMessage({ id: envelope.id, peer: String(to), direction: 'out', kind: payload.kind || 'text', body: payload.text || '', data: payload.card || null, created: envelope.sent, read: 1 })
    return { id: envelope.id, sent: envelope.sent }
  }

  async sync() {
    if (!this.relay) return this.status()
    if (!this.token) await this.register()
    const reply = await this.request('/v1/inbox', {}, true)
    const ids = []
    for (const envelope of reply.envelopes || []) {
      ids.push(envelope.id)
      try {
        const contact = await this.lookup(envelope.from)
        if (!verifyText(contact.ed25519, canonicalEnvelope(envelope), envelope.sig)) {
          this.log('drop envelope with bad signature', envelope.id)
          continue
        }
        const plaintext = openBox(this.identity.xPrivate, contact.x25519, envelope.nonce, envelope.box)
        const payload = JSON.parse(plaintext)
        this.store.addMessage({
          id: envelope.id, peer: envelope.from, direction: 'in',
          kind: payload.kind || 'text', body: payload.text || '', data: payload.card || null, created: Number(envelope.sent) || Date.now(),
        })
      } catch (error) {
        this.log('drop envelope', envelope.id, String(error?.message || error))
      }
    }
    if (ids.length) await this.request('/v1/ack', { ids }, true)
    this.phase = 'ready'
    this.error = ''
    this.lastSync = Date.now()
    this.store.setMeta('relay.lastSync', String(this.lastSync))
    return this.status()
  }
}

function registerText(code, ed25519, x25519) {
  return 'dshtrade-register-v1\n' + code + '\n' + ed25519 + '\n' + x25519
}
