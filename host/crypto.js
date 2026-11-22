/**
 * 端到端加密：X25519 协商 + AES-256-GCM，Ed25519 签名。
 * 私钥只在本机；中继只看到密文信封。公钥以 SPKI DER 的 base64 形式传递。
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify,
} from 'node:crypto'

export function generateKeys() {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  return {
    ed25519: {
      privateKey: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: ed.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      publicDer: ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    },
    x25519: {
      privateKey: x.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: x.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      publicDer: x.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    },
  }
}

export function publicDer(pem) {
  return createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64')
}

export function keyFromDer(der) {
  return createPublicKey({ key: Buffer.from(String(der), 'base64'), format: 'der', type: 'spki' })
}

export function fingerprint({ ed25519, x25519 }) {
  return createHash('sha256').update(String(ed25519)).update(String(x25519)).digest('hex')
}

export function friendCodeFrom(hex) {
  const body = String(hex).slice(0, 16).toUpperCase()
  return 'TP-' + body.match(/.{4}/g).join('-')
}

export function sharedKey(privatePem, peerDer) {
  const secret = diffieHellman({ privateKey: createPrivateKey(privatePem), publicKey: keyFromDer(peerDer) })
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from('dshtrade-envelope-v1'), 32))
}

export function seal(privatePem, peerDer, plaintext) {
  const key = sharedKey(privatePem, peerDer)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  return { nonce: iv.toString('base64'), box: Buffer.concat([body, cipher.getAuthTag()]).toString('base64') }
}

export function open(privatePem, peerDer, nonce, box) {
  const key = sharedKey(privatePem, peerDer)
  const raw = Buffer.from(String(box), 'base64')
  const tag = raw.subarray(raw.length - 16)
  const body = raw.subarray(0, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(nonce), 'base64'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

export function canonicalEnvelope(envelope) {
  return [envelope.v, envelope.id, envelope.from, envelope.to, envelope.sent, envelope.ttl, envelope.nonce, envelope.box].join('\n')
}

export function signText(privatePem, text) {
  return sign(null, Buffer.from(text), privatePem).toString('base64url')
}

export function verifyText(publicDerBase64, text, signature) {
  try {
    return verify(null, Buffer.from(text), keyFromDer(publicDerBase64), Buffer.from(String(signature), 'base64url'))
  } catch {
    return false
  }
}
