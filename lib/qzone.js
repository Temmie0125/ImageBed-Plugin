/**
 * QQ空间图床 (qzone.qq.com)
 * 依赖 OneBotv11 登录机器人的 qzone.qq.com Cookie (自动获取，无需手填)
 */

import { BaseHosting, parseCookie, getBkn, getBotCookie } from './base.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

export class QzoneHosting extends BaseHosting {
  get configKey() { return 'qzone' }
  get defaults() { return { enabled: false, name: 'QQ空间', bot_uin: '' } }
  get configTemplate() {
    return `# ========== QQ空间图床 (qzone.qq.com) ==========
# Cookie 由 OneBotv11 登录账号自动获取，无需手动填写
# 是否启用
enabled: false
# 图床名称
name: "QQ空间"
# 用于获取 Cookie 的机器人 uin (留空 = 第一个已登录机器人)
bot_uin: ""
`
  }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    const cookieStr = await getBotCookie('qzone.qq.com', this.config.bot_uin)
    if (!cookieStr) throw new Error('未获取到 qzone.qq.com Cookie，请确认 OneBotv11 已登录')
    const ck = parseCookie(cookieStr)
    const pUin = ck.p_uin || ck.uin || ''
    const skey = ck.p_skey || ck.skey || ''
    if (!skey) throw new Error('Cookie 缺少 p_skey/skey')
    const bkn = getBkn(skey)
    const base64 = fileBuffer.toString('base64')

    const form = new URLSearchParams()
    form.append('filename', 'filename')
    form.append('uin', pUin)
    form.append('skey', skey)
    form.append('zzpaneluin', pUin)
    form.append('zzpanelkey', '')
    form.append('p_uin', pUin)
    form.append('p_skey', skey)
    form.append('qzonetoken', '')
    form.append('uploadtype', '1')
    form.append('albumtype', '7')
    form.append('exttype', '0')
    form.append('refer', 'shuoshuo')
    form.append('output_type', 'jsonhtml')
    form.append('charset', 'utf-8')
    form.append('output_charset', 'utf-8')
    form.append('upload_hd', '1')
    form.append('hd_width', '2048')
    form.append('hd_height', '10000')
    form.append('hd_quality', '96')
    form.append('backUrls', '')
    form.append('url', '')
    form.append('base64', '1')
    form.append('jsonhtml_callback', 'callback')
    form.append('picfile', base64)
    form.append('qzreferrer', `https://user.qzone.qq.com/${pUin}/infocenter`)

    const bodyStr = form.toString()
    const uploadUrl = `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${bkn}`
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Cookie: cookieStr,
        'User-Agent': UA,
        Referer: 'https://user.qzone.qq.com/',
      },
      body: bodyStr,
      signal: AbortSignal.timeout(30000),
    })
    const text = await resp.text()
    const m = text.match(/"origin_url":"(.*?)"/)
    if (!m) throw new Error(`QQ空间上传失败: ${text.slice(0, 200)}`)
    return m[1].replace(/\\\//g, '/')
  }
}
