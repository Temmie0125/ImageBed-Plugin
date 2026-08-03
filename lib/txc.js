/**
 * 兔小巢图床 (support.qq.com)
 * 游客登录，无需任何 Cookie / 账号
 * 限制: 单张 5MB 以内
 * 严格参照 temp/一些图片上传接口/兔小巢.js 实现
 */

import { BaseHosting, getSetCookies } from './base.js'

const BASE = 'https://support.qq.com'

export class TxcHosting extends BaseHosting {
  get configKey() { return 'txc' }
  get defaults() { return { enabled: false, name: '兔小巢', upload_node: '162934', cookie: '' } }
  get configTemplate() {
    return `# ========== 兔小巢图床 (support.qq.com) ==========
# 兔小巢已关闭游客上传通道，纯游客凭证上传会报"请先登录"。
# 必须填入浏览器里已登录的 cookie 才能上传 (有效期约 1 天，过期需重填)。
# 是否启用
enabled: false
# 图床名称
name: "兔小巢"
# 兔小巢产品 ID (数字，在兔小巢后台产品页 URL 中获取)
upload_node: "162934"
# 已登录的兔小巢 cookie:
#   浏览器 F12 -> Application -> Cookies -> support.qq.com (或 qq.com)
#   复制 _tucao_custom_info 的完整 Value (形如 xxx==--yyy==--zzz)，或整段 cookie 串。
#   留空则走游客流程 (当前会失败)。
cookie: ""
`
  }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    if (fileBuffer.length > 5 * 1024 * 1024) throw new Error('超过5MB限制')
    const node = this.config.upload_node
    if (!node) throw new Error('未配置 upload_node (兔小巢产品ID)')

    const file = new File([fileBuffer], fileName || 'image.png')
    const formData = new FormData()
    formData.append('type', 'reply')
    formData.append('upload', file, fileName || 'image.png')

    const session = await this.getTucaoSession(node)
    const uploadUrl = `${BASE}/api/v1/${node}/posts/upload/images`
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        cookie: session,
        Referer: `${BASE}/product/${node}`,
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
      body: formData,
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json().catch(() => ({}))

    const url =
      data?.url ||
      data?.data?.url ||
      data?.data?.path ||
      (Array.isArray(data?.data) ? data.data[0]?.url : null)
    if (!url) throw new Error(`兔小巢上传失败: ${JSON.stringify(data).slice(0, 200)}`)
    return url
  }

  async getTucaoSession(node) {
    // 已配置浏览器登录 cookie 则直接用它 (兔小巢现已关闭游客上传通道)。
    const configured = (this.config.cookie || '').trim()
    if (configured) {
      // 只填了 _tucao_custom_info 值 (不含 = 号的键名) 时，自动补上键名
      const cookie = configured.includes('=')
        ? configured
        : `_tucao_custom_info=${configured}`
      return cookie.endsWith(';') ? cookie : `${cookie};`
    }

    // 未配置则走游客流程 (当前服务端会返回"请先登录")
    const response = await fetch(
      `${BASE}/login/init_user_info/${node}?_=${Date.now()}`,
      { signal: AbortSignal.timeout(15000) }
    )
    const responseHeader = getSetCookies(response.headers)
    const infos = responseHeader.filter((i) => i.startsWith('_tucao_custom_info'))
    if (!infos.length) {
      throw new Error('兔小巢登录失败: step1 未返回 _tucao_custom_info')
    }
    const last = infos[infos.length - 1].split(';')[0]
    return `${last};`
  }
}
