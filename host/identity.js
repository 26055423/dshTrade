/**
 * 本机身份：Ed25519 密钥对。没有账号、没有注册，好友码就是公钥指纹。
 * 私钥只在本机数据库里，用于给中继信封签名；不进入日志、不上传。
 */
import { createHash, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto'

const PRIVATE_KEY = 'identity.private.pem'
const PUBLIC_KEY = 'identity.public.pem'

export class Identity {
  constructor(store) {
    this.store = store
    let privatePem = store.meta(PRIVATE_KEY, '')
    let publicPem = store.meta(PUBLIC_KEY, '')
    if (!privatePem || !publicPem) {
      const pair = generateKeyPairSync('ed25519')
      privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      store.setMeta(PRIVATE_KEY, privatePem)
      store.setMeta(PUBLIC_KEY, publicPem)
    }
    this.privatePem = privatePem
    this.publicPem = publicPem
    this.publicKey = Buffer.from(publicPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
    this.fingerprint = createHash('sha256').update(this.publicKey).digest('hex')
    this.friendCode = formatFriendCode(this.fingerprint)
  }

  /** 供中继验证「消息确实来自持有私钥的一方」。 */
  sign(text) {
    return signBytes(null, Buffer.from(String(text)), this.privatePem).toString('base64url')
  }

  static verify(text, signature, publicKeyPem) {
    return verifyBytes(null, Buffer.from(String(text)), publicKeyPem, Buffer.from(String(signature), 'base64url'))
  }

  view() {
    return {
      friend_code: this.friendCode,
      fingerprint: this.fingerprint,
      public_key: this.publicKey.toString('base64'),
    }
  }
}

function formatFriendCode(hex) {
  const body = hex.slice(0, 16).toUpperCase()
  return 'TP-' + body.match(/.{4}/g).join('-')
}
