/**
 * ChatGLM 图床 (智谱, 免费)
 */

import { BaseHosting } from './base.js'
import { fileTypeFromBuffer } from 'file-type'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

export class ChatglmHosting extends BaseHosting {
  get configKey() { return 'chatglm' }
  get defaults() { return { enabled: false, name: 'ChatGLM' } }
  get configTemplate() { return `# ========== ChatGLM 图床 (智谱, 免费, 无需配置) ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "ChatGLM"\n` }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    if (fileBuffer.length > 20 * 1024 * 1024) throw new Error('超过20MB限制')
    const ft = await fileTypeFromBuffer(fileBuffer)
    const mime = ft?.mime || 'image/jpeg'
    const ext = ft?.ext || 'jpg'

    const form = new FormData()
    form.append('file', new Blob([fileBuffer], { type: mime }), `image.${ext}`)

    const resp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/file_upload', {
      method: 'POST', body: form,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br' },
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) throw new Error(`ChatGLM 失败 (HTTP ${resp.status})`)
    const data = await resp.json()
    const url = data?.result?.file_url
    if (!url) throw new Error('ChatGLM 返回 URL 为空')
    return url
  }
}
