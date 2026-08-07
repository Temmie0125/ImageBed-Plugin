/**
 * 王者图床 (腾讯COS直传, 内置密钥, 长期存储)
 */

import crypto from 'crypto'
import { BaseHosting } from './base.js'

const SID = Buffer.from('QUtJRHJiOFRiZlhBWnJ5cVRzMnlnQlNWSkdzSFRROGR0d21O', 'base64').toString()
const SKEY = Buffer.from('UFphTnhLV2ZjTHAzNHJQanJ1dGtXRnlaQ2N5REdCMGQ=', 'base64').toString()
const BKT = 'sgame-data-service-1252931805'
const REG = 'ap-nanjing'
const CDN = 'https://download.nature.qq.com'
const PFX = 'SnsShare/SocialProfile'

export class NatureHosting extends BaseHosting {
  get configKey() { return 'nature' }
  get defaults() { return { enabled: false, name: '王者图床' } }
  get configTemplate() { return `# ========== 王者图床 (COS直传, 内置密钥, 长期存储) ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "王者图床"\n` }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    const d = detectMime(fileBuffer)
    if (!d) throw new Error('仅支持 PNG/JPG/WebP/GIF 格式')
    const ct = d.mime === 'image/gif' ? 'image/jpeg' : d.mime

    const ts = Math.floor(Date.now() / 1000)
    const rand = crypto.randomBytes(4).toString('hex')
    const upPath = `${PFX}/${ts}_${rand}.${d.ext}`
    const host = `${BKT}.cos.${REG}.myqcloud.com`

    const st = `${ts};${ts + 3600}`
    const sk = crypto.createHmac('sha1', SKEY).update(st).digest('hex')
    const fmt = `put\n/${upPath}\n\nhost=${host}\n`
    const sts = `sha1\n${st}\n${crypto.createHash('sha1').update(fmt).digest('hex')}\n`
    const sig = crypto.createHmac('sha1', sk).update(sts).digest('hex')
    const auth = `q-sign-algorithm=sha1&q-ak=${SID}&q-sign-time=${st}&q-key-time=${st}&q-header-list=host&q-url-param-list=&q-signature=${sig}`

    const resp = await fetch(`https://${host}/${upPath}`, {
      method: 'PUT', body: fileBuffer,
      headers: { Host: host, 'Content-Type': ct, Authorization: auth },
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) throw new Error(`王者图床失败 (HTTP ${resp.status})`)
    return `${CDN}/${upPath}`
  }
}

function detectMime(d) {
  if (d[0]===0x89&&d[1]===0x50&&d[2]===0x4e&&d[3]===0x47) return { mime:'image/png',ext:'png' }
  if (d[0]===0xff&&d[1]===0xd8&&d[2]===0xff) return { mime:'image/jpeg',ext:'jpg' }
  if (d[0]===0x52&&d[1]===0x49&&d[2]===0x46&&d[3]===0x46&&d[8]===0x57&&d[9]===0x45) return { mime:'image/webp',ext:'webp' }
  if (d[0]===0x47&&d[1]===0x49&&d[2]===0x46) return { mime:'image/gif',ext:'gif' }
  return null
}
