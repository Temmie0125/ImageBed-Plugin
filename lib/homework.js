/**
 * QQ群作业图床 (qun.qq.com/cgi-bin/hw/util/image)
 * 依赖 OneBotv11 登录机器人的 qun.qq.com Cookie (自动获取，无需手填)
 * 几乎没有大小限制
 */

import { BaseHosting, parseCookie, getBkn, getBotCookie } from './base.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

export class HomeworkHosting extends BaseHosting {
  get configKey() { return 'homework' }
  get defaults() { return { enabled: false, name: 'QQ群作业', bot_uin: '' } }
  get configTemplate() {
    return `# ========== QQ群作业图床 (qun.qq.com) ==========
# Cookie 由 OneBotv11 登录账号自动获取，无需手动填写
# 是否启用
enabled: false
# 图床名称
name: "QQ群作业"
# 用于获取 Cookie 的机器人 uin (留空 = 第一个已登录机器人)
bot_uin: ""
`
  }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    const cookieStr = await getBotCookie('qun.qq.com', this.config.bot_uin)
    if (!cookieStr) throw new Error('未获取到 qun.qq.com Cookie，请确认 OneBotv11 已登录')
    const ck = parseCookie(cookieStr)
    const uin = ck.uin || ''
    const skey = ck.skey || ''
    if (!skey) throw new Error('Cookie 缺少 skey')
    const bkn = getBkn(skey)
    const base64 = fileBuffer.toString('base64')

    const form = new URLSearchParams()
    form.append('pic', base64)
    form.append('client_type', '1')
    form.append('bkn', String(bkn))

    const bodyStr = form.toString()
    const uploadUrl = 'https://qun.qq.com/cgi-bin/hw/util/image'
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieStr,
        'User-Agent': UA,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(30000),
    })
    const data = await resp.json().catch(() => ({}))
    logger.debug(`[QQ群作业] 响应: ${JSON.stringify(data)}`)

    let url = data?.url || data?.data?.url || data?.data?.pic || data?.pic
    // data.url 可能是对象 {small, middle, big, origin}，取原图
    if (url && typeof url === 'object') {
      url = url.origin || url.big || url.middle || url.small
    }
    if (typeof url !== 'string') {
      url = typeof data === 'string' ? data.match(/https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)/i)?.[0] : null
    }
    if (!url) throw new Error(`QQ群作业上传失败: ${JSON.stringify(data).slice(0, 200)}`)
    return url
  }
}
