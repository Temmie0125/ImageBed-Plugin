/**
 * Ukaka / 星野图床 (免费)
 */

import { BaseHosting } from './base.js'
import { fileTypeFromBuffer } from 'file-type'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
const SIGN = 'https://bed-sign.vercel.0013107.xyz/sign'
const ORIGIN = 'https://bed.vercel.0013107.xyz'

export class UkakaHosting extends BaseHosting {
  get configKey() { return 'ukaka' }
  get defaults() { return { enabled: false, name: 'Ukaka' } }
  get configTemplate() { return `# ========== Ukaka 图床 (免费, 无需配置) ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "Ukaka"\n` }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    if (fileBuffer.length > 20 * 1024 * 1024) throw new Error('超过20MB限制')
    const ft = await fileTypeFromBuffer(fileBuffer)
    const mime = ft?.mime || 'image/jpeg'; const ext = ft?.ext || 'jpg'
    const fn = `image.${ext}`

    // 签名
    const sr = await fetch(`${SIGN}?module=ukaka&filename=${fn}&mimeType=${encodeURIComponent(mime)}`, {
      headers: { Accept:'*/*', Origin:ORIGIN, Referer:`${ORIGIN}/`, 'User-Agent':UA },
      signal: AbortSignal.timeout(15000),
    })
    if (!sr.ok) throw new Error(`Ukaka 签名服务异常 (HTTP ${sr.status})`)
    const sd = await sr.json()
    logger.debug(`[Ukaka] 签名返回: ${JSON.stringify(sd)}`)
    if (!sd.url || !sd.resourceUrl) throw new Error(`Ukaka 签名缺少 url/resourceUrl`)

    // 上传 POST
    const form = new FormData()
    const body = sd.body || {}
    // 如果 body 里有 token，需要在 headers 里也带上
    const extraHeaders = { 'User-Agent': UA }
    if (body.token) extraHeaders.Authorization = `Bearer ${body.token}`
    for (const [k, v] of Object.entries(body)) {
      if (k !== 'file' && k !== 'token' && v != null && v !== '') form.append(k, String(v))
    }
    form.append('file', new File([fileBuffer], fn, { type: mime }))
    const resp = await fetch(sd.url, {
      method: 'POST', body: form, headers: extraHeaders,
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      throw new Error(`Ukaka 失败 (HTTP ${resp.status}): ${t.slice(0, 200)}`)
    }
    return sd.resourceUrl
  }
}

export class XingyeHosting extends BaseHosting {
  get configKey() { return 'xingye' }
  get defaults() { return { enabled: false, name: '星野' } }
  get configTemplate() { return `# ========== 星野图床 (免费, 无需配置) ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "星野"\n` }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    if (fileBuffer.length > 20 * 1024 * 1024) throw new Error('超过20MB限制')
    const ft = await fileTypeFromBuffer(fileBuffer)
    const mime = ft?.mime || 'image/jpeg'; const ext = ft?.ext || 'jpg'
    const fn = `image.${ext}`

    const sr = await fetch(`${SIGN}?module=xingye&filename=${fn}&mimeType=${encodeURIComponent(mime)}`, {
      headers: { Accept:'*/*', Origin:ORIGIN, Referer:`${ORIGIN}/`, 'User-Agent':UA },
      signal: AbortSignal.timeout(15000),
    })
    if (!sr.ok) throw new Error(`星野 签名服务异常 (HTTP ${sr.status})`)
    const sd = await sr.json()
    logger.debug(`[星野] 签名返回: ${JSON.stringify(sd)}`)
    if (!sd.url || !sd.resourceUrl) throw new Error(`星野 签名缺少 url/resourceUrl`)

    const ct = (sd.header || {})['Content-Type']
    const hdrs = { 'User-Agent': UA }
    if (ct) hdrs['Content-Type'] = ct
    const resp = await fetch(sd.url, {
      method: 'PUT', body: fileBuffer, headers: hdrs,
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      throw new Error(`星野 失败 (HTTP ${resp.status}): ${t.slice(0, 200)}`)
    }
    return sd.resourceUrl
  }
}
