/**
 * QQBot 官方机器人 分片上传图床
 *
 * 使用官方 QQ 机器人 SDK (bot.sdk.request) 在群聊(group)或单聊(user)内通过
 * 分片上传发送图片/视频/语音，合并后响应体中的 raw_url 即为文件下载直链。
 *
 * 流程: upload_prepare -> 逐片 PUT 预签名 URL -> upload_part_finish 确认 -> 合并(files) 取 raw_url
 * 依赖: 已登录的官方 QQBot 实例 (Bot[id].sdk 为 @windtrace/qq-group-bot)
 * 说明: sdk.request 自带 access_token 与 baseurl，无需手动拼装鉴权；
 *       仅分片 PUT 到 COS 预签名 URL 仍是外部链接，走原生 fetch。
 */

import { BaseHosting } from './base.js'
import crypto from 'node:crypto'

// file_type: 1=图片 2=视频 3=语音 4=文件(此类型不返回 raw_url)
const FILE_TYPE = { image: 1, video: 2, voice: 3 }

// 各 file_type 对应的 HTTP Content-Type，拼到下载直链后用于设置响应类型
// (语音用 mp3；type 4 文件类型不拼接该参数)
const CONTENT_TYPE = {
  1: 'image/jpeg',
  2: 'video/mp4',
  3: 'audio/mp3',
}

// QQBot 分片上传单文件上限
const MAX_SIZE = 200 * 1024 * 1024

export class QqbotHosting extends BaseHosting {
  get configKey() { return 'qqbot' }

  get defaults() {
    return {
      enabled: false,
      name: 'QQBot分片上传',
      // 用于上传的机器人 QQ 号 (留空 = 自动选择第一个 QQBot 实例)
      bot_qq: '',
      // 发送目标类型: group (群聊) / user (单聊/私信)
      target_type: 'group',
      // 目标群/用户的 OpenID (group_openid / user_openid)
      target_openid: '',
      // 文件类型: auto (按扩展名推断) / image / video / voice
      file_type: 'auto',
    }
  }

  get configTemplate() {
    return `# ========== QQBot 官方机器人 分片上传图床 ==========
# 依赖已登录的官方 QQ 机器人 (QQBot)，通过 SDK 在群聊/单聊内分片上传
# 图片/视频/语音，利用合并响应体中的 raw_url (文件下载直链) 作为图床链接
# 说明: 上传目标完全由下方配置决定 (bot_qq / target_type / target_openid)，
#       调用时无需传入任何事件。

# 是否启用
enabled: false
# 图床名称
name: "QQBot分片上传"
# 用于上传的机器人 QQ 号 (留空 = 自动选择第一个 QQBot 实例)
bot_qq: ""
# 发送目标类型: group (群聊) / user (单聊/私信)
target_type: "group"
# 目标群/用户的 OpenID (group_openid / user_openid)
target_openid: ""
# 文件类型: auto (按扩展名推断) / image / video / voice
file_type: "auto"
`
  }

  get autoDelete() { return 0 }

  async _getBot() {
    let botId = this.config.bot_qq
    if (botId && !Bot[botId]?.sdk) {
      throw new Error(`bot_qq ${botId} 不可用或不是 QQBot 实例`)
    }
    if (!botId) botId = Bot.uin.find(id => Bot[id]?.sdk)
    if (!botId) throw new Error('未找到可用的 QQBot 实例 (未登录)')
    return { botId, bot: Bot[botId] }
  }

  /** 经 SDK 请求 OpenAPI，自动带 token + baseurl；兼容 { data } 包装返回 */
  async _api(bot, path, data) {
    const res = await bot.sdk.request(path, { method: 'POST', data })
    if (res && typeof res === 'object' && 'data' in res && !('upload_id' in res) && !('raw_url' in res)) {
      return res.data
    }
    return res
  }

  async upload(fileBuffer, fileName, opts = {}) {
    // 直接使用配置中的 bot / 目标上传
    const r = await this._getBot()
    const bot = r.bot
    if (!this.config.target_openid) throw new Error('QQBot 分片上传未配置 target_openid')
    const isGroup = this.config.target_type !== 'user'
    const openid = this.config.target_openid

    const scope = isGroup ? `groups/${openid}` : `users/${openid}`

    // 解析文件类型 (image / video / voice)，仅 1/2/3 才会返回 raw_url
    let ft = this.config.file_type
    if (ft === 'auto' || !ft) ft = this._guessType(fileName)
    const fileType = FILE_TYPE[ft] || 1

    const fileSize = fileBuffer.length
    if (fileSize > MAX_SIZE) {
      const mb = (n) => (n / 1024 / 1024).toFixed(1)
      throw new Error(`文件大小 ${mb(fileSize)}MB 超过 QQBot 分片上传上限 ${mb(MAX_SIZE)}MB`)
    }
    const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex')
    const sha1 = crypto.createHash('sha1').update(fileBuffer).digest('hex')
    // 文件前 10MB(10002432) 的 md5，小文件则等于整文件 md5；QQBot 必须随 prepare 提交
    const MD5_10M_SIZE = 10002432
    const md5_10m = fileSize > MD5_10M_SIZE
      ? crypto.createHash('md5').update(fileBuffer.subarray(0, MD5_10M_SIZE)).digest('hex')
      : md5

    // 1) 分片预上传：获取 upload_id 与 各分片预签名 URL
    const prepare = await this._api(bot, `/v2/${scope}/upload_prepare`, {
      file_type: fileType,
      file_size: fileSize,
      file_name: fileName,
      md5,
      sha1,
      md5_10m,
    })
    const uploadId = prepare.upload_id
    const parts = prepare.parts || []
    const blockSize = Number(prepare.block_size || 5 * 1024 * 1024)
    if (!uploadId) throw new Error('分片预上传失败: ' + JSON.stringify(prepare).slice(0, 200))

    // 2) 逐片 PUT 上传 + 3) 分片完成确认（严格对齐官方 SDK 实现）
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const partIndex = part.index || (i + 1)
      const offset = (partIndex - 1) * blockSize
      const length = Math.min(blockSize, fileSize - offset)
      // 拷成独立 Buffer，避免 subarray 视图在 fetch 中被按 byteOffset 取错字节
      const chunk = Buffer.from(fileBuffer.subarray(offset, offset + length))
      if (chunk.length === 0) continue

      const putRes = await fetch(part.presigned_url, {
        method: 'PUT',
        headers: { 'Content-Length': String(chunk.length) },
        body: chunk,
      })
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => '')
        throw new Error(`分片 ${partIndex} 上传失败: ${putRes.status} ${body.slice(0, 200)}`)
      }

      await this._api(bot, `/v2/${scope}/upload_part_finish`, {
        upload_id: uploadId,
        part_index: partIndex,
        block_size: length,
        md5: crypto.createHash('md5').update(chunk).digest('hex'),
      })
    }

    // 4) 合并：仅携带 upload_id 调用 files 接口，响应体顶级返回 raw_url
    const merge = await this._api(bot, `/v2/${scope}/files`, { upload_id: uploadId })
    const rawUrl = merge.raw_url || merge?.file_info?.url
    if (!rawUrl) {
      throw new Error('未返回 raw_url (需 file_type 为 1/2/3 且走分片上传): ' + JSON.stringify(merge).slice(0, 200))
    }
    // 拼接 response-content-type，使下载直链直接按对应类型响应 (type 4 不拼接)
    const ct = CONTENT_TYPE[fileType]
    if (!ct) return rawUrl
    const sep = rawUrl.includes('?') ? '&' : '?'
    return rawUrl + sep + 'response-content-type=' + encodeURIComponent(ct)
  }

  /** 按扩展名粗略推断文件类型 */
  _guessType(name) {
    const ext = (name || '').split('.').pop()?.toLowerCase() || ''
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return 'image'
    if (['mp4', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video'
    if (['mp3', 'wav', 'amr', 'm4a', 'silk'].includes(ext)) return 'voice'
    return 'image'
  }
}
