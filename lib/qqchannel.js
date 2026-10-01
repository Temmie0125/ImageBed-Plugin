/**
 * QQ频道图床
 */

import crypto from 'crypto'
import { BaseHosting } from './base.js'

export class QqChannelHosting extends BaseHosting {
  get configKey() { return 'qq_channel' }
  get defaults() { return { enabled: false, name: 'QQ频道', bot_qq: '', channel_id: '' } }
  get configTemplate() { return `# ========== QQ频道图床 ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "QQ频道"\n# QQ Bot 的 QQ 号，用于指定使用哪个 Bot 发送频道图片，留空则自动选择\nbot_qq: ""\n# QQ频道 ID\nchannel_id: ""\n` }
  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    const c = this.config
    if (!c.channel_id) throw new Error('QQ频道 channel_id 未配置')

    let botId
    if (c.bot_qq) {
      if (!Bot[c.bot_qq]) throw new Error(`bot_qq ${c.bot_qq} 未登录`)
      if (typeof Bot[c.bot_qq].adapter?.sendGuildMsg !== 'function') {
        logger.error(`[QQ频道] bot_qq ${c.bot_qq} 的适配器不是 QQBot，无法上传`)
        botId = Bot.uin.find(id => Bot[id]?.adapter?.sendGuildMsg && id !== c.bot_qq)
      } else {
        botId = c.bot_qq
      }
    }
    if (!botId) botId = Bot.uin.find(id => Bot[id]?.adapter?.sendGuildMsg)
    if (!botId) throw new Error('无可用的 QQ Bot (未登录)')

    await Bot[botId].sdk.sendGuildMessage(c.channel_id, [segment.image(fileBuffer)])

    const hash = crypto.createHash('md5').update(fileBuffer).digest('hex').toUpperCase()
    return `https://gchat.qpic.cn/qmeetpic/0/0-0-${hash}/0`
  }
}
