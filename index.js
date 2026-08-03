/**
 * 统一图床服务 - 入口
 *
 * 自动初始化 Bot.imageToUrl(file, opts) → URL
 * 按优先级依次尝试已开启的图床，失败则尝试下一个，全部失败则回退到 Bot.fileToUrl
 *
 * 用法:
 *   const url = await Bot.imageToUrl(imageBuffer)
 *   const url = await Bot.imageToUrl(imageBuffer, { autoDelete: 30 })
 */

import { CnbHosting } from './lib/cnb.js'
import { NatureHosting } from './lib/nature.js'
import { ChatglmHosting } from './lib/chatglm.js'
import { UkakaHosting, XingyeHosting } from './lib/ukaka_xingye.js'
import { CosHosting } from './lib/cos.js'
import { BilibiliHosting } from './lib/bilibili.js'
import { QqChannelHosting } from './lib/qqchannel.js'
import { QzoneHosting } from './lib/qzone.js'
import { QqbotHosting } from './lib/qqbot.js'
import { HomeworkHosting } from './lib/homework.js'
import { TxcHosting } from './lib/txc.js'
import { KurobbsHosting } from './lib/kurobbs.js'
import { loadSettings } from './lib/base.js'
import { TestHosting } from './apps/testHosting.js'
import { HostingStats } from './apps/stats.js'

// ==================== 图床注册表 ====================

const HOSTING_MAP = {
  cnb: CnbHosting,
  nature: NatureHosting,
  chatglm: ChatglmHosting,
  ukaka: UkakaHosting,
  xingye: XingyeHosting,
  cos: CosHosting,
  bilibili: BilibiliHosting,
  qq_channel: QqChannelHosting,
  qzone: QzoneHosting,
  qqbot: QqbotHosting,
  homework: HomeworkHosting,
  txc: TxcHosting,
  kurobbs: KurobbsHosting,
}

// ==================== 初始化 ====================

let _initialized = false

;(async () => {
  if (_initialized) return

  const settingsTemplate = `# ========== 图床服务 - 全局设置 ==========

# 优先级：越靠前越优先，Bot.imageToUrl 按此顺序尝试
priority:
${Object.keys(HOSTING_MAP).map(k => `  - ${k}`).join('\n')}

# 统计设置
stats:
  # 是否启用上传统计 (数据存于 Redis)
  enabled: true
  # 统计数据保留天数
  max_days: 30

# 功能开关
apps:
  # #测试图床
  test: true
  # #图床状态 / #图床失败原因 / #清空CNB图床
  stats: true
`

  const hostCfg = loadSettings({
    priority: Object.keys(HOSTING_MAP),
    stats: { enabled: true, max_days: 30 },
    apps: { test: true, stats: true },
  }, settingsTemplate)
  Bot._hostingCfg = hostCfg
  Bot._hostingSettings = hostCfg

  // 实例化所有图床
  const instances = []
  for (const [, Cls] of Object.entries(HOSTING_MAP)) {
    const inst = new Cls()
    instances.push(inst)
  }
  Bot._hostings = instances

  // 设置 Bot.imageToUrl
  Bot.imageToUrl = async (file, opts = {}) => {
    const all = Bot._hostings || instances
    const priority = hostCfg.priority || []
    const name = opts.name || 'image.png'

    let fileBuf
    if (Buffer.isBuffer(file)) fileBuf = file
    else if (typeof file === 'string') {
      if (file.startsWith('http')) return file
      try { fileBuf = await Bot.Buffer(file, { size: undefined }) } catch { return Bot.fileToUrl(file, { name, time: 5 * 60000 }) }
    } else fileBuf = file?.buffer || file?.file || file

    if (!Buffer.isBuffer(fileBuf)) return Bot.fileToUrl(file, { name, time: 5 * 60000 })

    let sorted

    // 若 opts.imagebed 指定了图床，优先使用
    if (opts.imagebed) {
      const target = all.find(h =>
        h.configKey === opts.imagebed || h.name === opts.imagebed
      )
      if (target && target.enabled) {
        sorted = [target]
      } else {
        logger.warn(`[图床] 不存在指定图床: ${opts.imagebed}`)
        // 指定图床不存在或未启用，回退到优先级列表
        const prioMap = new Map(priority.map((k, i) => [k, i]))
        sorted = [...all].filter(h => h.enabled).sort((a, b) => (prioMap.get(a.configKey) ?? 99) - (prioMap.get(b.configKey) ?? 99))
      }
    } else {
      const prioMap = new Map(priority.map((k, i) => [k, i]))
      sorted = [...all].filter(h => h.enabled).sort((a, b) => (prioMap.get(a.configKey) ?? 99) - (prioMap.get(b.configKey) ?? 99))
    }

    if (sorted.length === 0) return Bot.fileToUrl({ buffer: fileBuf, name }, { name, time: 5 * 60000 })

    for (const h of sorted) {
      const t0 = Date.now()
      try {
        const url = await h.uploadAndScheduleDelete(fileBuf, name, opts)
        if (url) {
          logger.info(`[图床] ${h.name} 上传成功 (${Date.now() - t0}ms)`)
          return url
        }
      } catch (e) {
        logger.debug(`[${h.name}] 失败 (${Date.now() - t0}ms): ${e.message}`)
      }
    }
    logger.warn('[图床] 全部失败，使用本地存储')
    return Bot.fileToUrl({ buffer: fileBuf, name }, { name, time: 5 * 60000 })
  }

  // CNB 缓存定时清理 (每3小时)
  try {
    const schedule = (await import('node-schedule')).default
    schedule.scheduleJob('0 */3 * * *', async () => {
      const cnb = instances.find(h => h.configKey === 'cnb')
      if (cnb?.enabled && cnb.cleanExpiredCache) await cnb.cleanExpiredCache()
    })
  } catch { /* 无 node-schedule 则跳过 */ }

  _initialized = true
  const names = instances.filter(h => h.enabled).map(h => h.name).join(', ')
  logger.mark(`图床服务就绪 (可用: ${names || '无'})`)
})()

// ==================== 挂载到 Bot 供外部查询 ====================

/**
 * 获取指定图床实例
 * @param {string} key - 如 'cnb', 'nature', 'cos'
 */
Bot.getHosting = (key) => (Bot._hostings || []).find(h => h.configKey === key)


// ==================== 导出 apps (Yunzai 加载器约定) ====================

export const apps = { TestHosting, HostingStats }
