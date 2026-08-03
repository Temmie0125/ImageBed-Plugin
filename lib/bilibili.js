/**
 * B站图床
 */

import { BaseHosting } from './base.js'
import { fileTypeFromBuffer } from 'file-type'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

export class BilibiliHosting extends BaseHosting {
  get configKey() { return 'bilibili' }
  get defaults() { return { enabled: false, name: 'B站', csrf_token: '', sessdata: '', bucket: 'openplatform' } }
  get configTemplate() { return `# ========== B站图床 (bilibili) ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "B站"\n# B站登录后的 csrf_token (bili_jct Cookie)\ncsrf_token: ""\n# B站登录后的 SESSDATA Cookie\nsessdata: ""\n# 上传分区: openplatform / newlist / draw\nbucket: "openplatform"\n` }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    const c = this.config
    if (!c.csrf_token || !c.sessdata) throw new Error('B站 cookie 未配置')
    if (fileBuffer.length > 20 * 1024 * 1024) throw new Error('超过20MB限制')

    const ft = await fileTypeFromBuffer(fileBuffer)
    const mime = ft?.mime || 'image/jpeg'; const ext = ft?.ext || 'jpg'

    const form = new FormData()
    form.append('file', new Blob([fileBuffer], { type: mime }), `image.${ext}`)
    form.append('bucket', c.bucket || 'openplatform')
    form.append('csrf', c.csrf_token)

    const resp = await fetch('https://api.bilibili.com/x/upload/web/image', {
      method: 'POST', body: form,
      headers: { 'User-Agent': UA, Cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.csrf_token}` },
      signal: AbortSignal.timeout(30000),
    })
    const d = await resp.json()
    if (d?.code !== 0) throw new Error(`B站失败 (code ${d?.code})`)
    const url = d?.data?.location || ''
    if (!url) throw new Error('B站返回 URL 为空')
    return url.startsWith('http://') ? url.replace('http://', 'https://') : url
  }
}
