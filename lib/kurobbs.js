/**
 * 库街区图床 (api.kurobbs.com)
 * 通过库街区 H5 接口上传论坛图片，需配置 Token (库街区账号登录凭证)
 */

import { BaseHosting, getFileInfo } from './base.js'

const BASE = 'https://api.kurobbs.com'
const UPLOAD_PATH = '/forum/uploadForumImgForH5'

export class KurobbsHosting extends BaseHosting {
  get configKey() { return 'kurobbs' }

  get defaults() {
    return {
      enabled: false,
      name: '库街区',
      token: '',
    }
  }

  get configTemplate() {
    return `# ========== 库街区图床 (api.kurobbs.com) ==========
# 通过库街区论坛 H5 接口上传图片，返回可直接访问的图片直链
# 是否启用
enabled: false
# 图床名称
name: "库街区"
# 库街区登录 Token (从 App / 网页端抓包获取，请求头中的 Token 字段)
#   抓包位置: 库街区任意已登录请求 -> 请求头 -> Token
token: ""
`
  }

  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    const token = this.config.token
    if (!token) throw new Error('库街区 Token 未配置')

    const fi = await getFileInfo(fileBuffer, fileName || 'image.png')
    if (!Buffer.isBuffer(fi.buffer)) throw new Error('库街区上传失败: 文件数据为空')

    const formData = new FormData()
    formData.append('files', new File([fi.buffer], fi.name, { type: fi.mime || 'image/png' }))

    const response = await fetch(`${BASE}${UPLOAD_PATH}`, {
      method: 'POST',
      body: formData,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        source: 'h5',
        Referer: 'http://www.kurobbs.com/',
        Token: token,
      },
      signal: AbortSignal.timeout(30000),
    })

    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`库街区图床返回非 JSON: ${text.slice(0, 200)}`)
    }

    if (!response.ok) {
      throw new Error(`库街区图床上传失败: ${response.status} ${response.statusText} ${text.slice(0, 200)}`)
    }

    // data.data 为图片直链数组；部分响应直接返回字符串
    const url = Array.isArray(data?.data) ? data.data[0] : data?.data
    if (!url) throw new Error(`库街区图床返回无图片地址: ${text.slice(0, 200)}`)

    return url
  }
}
