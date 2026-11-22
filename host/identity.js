/**
 * 本机身份：Ed25519（签名）+ X25519（加密）两对密钥。没有账号、没有注册。
 * 好友码是两把公钥的指纹；私钥只在本机数据库里，不上传、不写日志。
 */
import { friendCodeFrom, fingerprint, generateKeys, signText, verifyText } from './crypto.js'

const KEY_RECORD = 'identity.keys.v1'

export class Identity {
  constructor(store) {
    this.store = store
    let keys = null
    try { keys = JSON.parse(store.meta(KEY_RECORD, '') || 'null') } catch { keys = null }
    if (!keys || !keys.ed25519 || !keys.x25519) {
      keys = generateKeys()
      store.setMeta(KEY_RECORD, JSON.stringify(keys))
    }
    this.keys = keys
    this.fingerprint = fingerprint({ ed25519: keys.ed25519.publicDer, x25519: keys.x25519.publicDer })
    this.friendCode = friendCodeFrom(this.fingerprint)
  }

  get edPrivate() { return this.keys.ed25519.privateKey }
  get xPrivate() { return this.keys.x25519.privateKey }
  get edPublic() { return this.keys.ed25519.publicDer }
  get xPublic() { return this.keys.x25519.publicDer }

  sign(text) {
    return signText(this.edPrivate, text)
  }

  static verify(publicDer, text, signature) {
    return verifyText(publicDer, text, signature)
  }

  view() {
    return {
      friend_code: this.friendCode,
      fingerprint: this.fingerprint,
      ed25519_public: this.edPublic,
      x25519_public: this.xPublic,
    }
  }
}
