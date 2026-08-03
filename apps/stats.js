/**
 * 图床状态 / 失败原因查询
 *
 * 命令:
 *   #图床状态          - 查看所有已启用图床近1天统计
 *   #图床状态 cnb      - 查看指定图床近1天统计
 *   #图床状态7天       - 查看所有已启用图床近7天统计
 *   #图床状态30天      - 查看所有已启用图床近30天统计
 *   #图床失败原因       - 查看近1天失败原因
 *   #图床失败原因 cnb   - 查看指定图床失败原因
 *   #图床失败原因30天   - 查看近30天失败原因
 */

import plugin from '../../../lib/plugins/plugin.js'
import { getStats, getFailReasons, toInt, formatBytes, formatMs, speedLevel, percent } from '../lib/base.js'

const btn = segment.button([
  { text: '图床状态', callback: '图床状态' },
  { text: '图床状态7天', callback: '图床状态7天' },
], [
  { text: '图床状态30天', callback: '图床状态30天' },
  { text: '图床失败原因30天', callback: '图床失败原因30天' },
])

/**
 * 从消息文本中解析天数和图床名称
 * @returns {{ days: number, hosting: string|null }}
 */
function parseArgs(msg) {
  let days = 1
  let hosting = null

  // 提取天数: 匹配 "XX天" 或末尾数字
  const dayMatch = msg.match(/(\d+)\s*天/)
  if (dayMatch) {
    days = toInt(dayMatch[1], 1)
  }

  // 查找已知图床名称
  const knownHostings = (Bot._hostings || []).map(h => h.configKey)
  for (const key of knownHostings) {
    if (msg.includes(key)) {
      hosting = key
      break
    }
  }

  // 限制天数范围
  const maxDays = Bot._hostingSettings?.stats?.max_days || 30
  days = Math.max(1, Math.min(maxDays, days))

  return { days, hosting }
}

export class HostingStats extends plugin {
  constructor() {
    super({
      name: '图床状态',
      dsc: '查看图床上传统计与失败原因',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#?(图床|imagebed)状态',
          fnc: 'hostingStats',
          permission: 'master',
        },
        {
          reg: '^#?(图床|imagebed)失败(记录|原因)',
          fnc: 'hostingFailReasons',
          permission: 'master',
        },
        {
          reg: '^#清空CNB图床$',
          fnc: 'clearCnbAssets',
          permission: 'master',
        },
      ],
    })
  }

  /** #图床状态 */
  async hostingStats() {
    if (Bot._hostingSettings?.apps?.stats === false) return
    if (this.e.adapter_id !== 'QQBot') return
    const msg = this.e.msg || ''
    const hostings = Bot._hostings || []
    if (hostings.length === 0) {
      await this.reply('⚠️ 没有任何图床')
      return
    }

    const { days, hosting } = parseArgs(msg)

    if (hosting) {
      // 查询单个图床
      const stats = await getStats(hosting, days)
      if (!stats || stats.count === 0) {
        await this.reply(`📊 图床 ${hosting} 在近 ${days} 天内暂无上传记录`, true)
        return
      }
      await this.reply([this._formatSingleStats(hosting, stats, await this._getCnbVolume(hosting)), btn])
    } else {
      // 查询所有图床
      const results = []
      for (const h of hostings) {
        const stats = await getStats(h.configKey, days)
        if (stats) results.push({ name: h.configKey, stats, disabled: !h.enabled })
      }

      if (results.length === 0) {
        await this.reply('📊 暂无任何上传记录')
        return
      }

      let msgText = '# 📅 图床状态总览\r'
      msgText += `> 统计区间：**${days} 天** | 数据保留：**${Bot._hostingSettings?.stats?.max_days || 30} 天**\r\r`

      // 汇总
      let totalCount = 0, totalFail = 0, totalSize = 0
      const allCosts = []
      for (const r of results) {
        totalCount += r.stats.count
        totalFail += r.stats.fail
        totalSize += r.stats.totalSize
        if (r.stats.avgCost > 0) allCosts.push(r.stats.avgCost)
      }
      const avgCost = allCosts.length ? Math.round(allCosts.reduce((a, b) => a + b, 0) / allCosts.length) : 0

      msgText += `| 图床 | 成功 | 失败 | 成功率 | 总大小 | 平均耗时 | 速度 |\r`
      msgText += `|---|---|---|---|---|---|---|\r`

      for (const r of results) {
        const s = r.stats
        const label = r.name + (r.disabled ? ' (已关闭)' : '')
        msgText += `| ${label} | ${s.count} | ${s.fail} | ${percent(s.count, s.count + s.fail)} | ${formatBytes(s.totalSize)} | ${s.count > 0 ? formatMs(s.avgCost) : '—'} | ${s.count > 0 ? speedLevel(s.avgCost) : '—'} |\r`
      }

      msgText += `\r> 合计：成功 ${totalCount} 张 | 失败 ${totalFail} 次 | 总大小 ${formatBytes(totalSize)} | 均耗时 ${formatMs(avgCost)}`

      // CNB 对象存储占用量
      const cnb = Bot.getHosting?.('cnb')
      if (cnb?.enabled && cnb.getRepoVolume) {
        const vol = await cnb.getRepoVolume()
        if (vol !== null) {
          msgText += `\r> CNB图床占用: **${formatBytes(vol.volume)}** / 100 GB`
        }
      }

      await this.reply([msgText, btn])
    }
  }

  /** #图床失败原因 */
  async hostingFailReasons() {
    if (Bot._hostingSettings?.apps?.stats === false) return
    if (this.e.adapter_id !== 'QQBot') return
    const msg = this.e.msg || ''
    const hostings = Bot._hostings || []
    if (hostings.length === 0) {
      await this.reply('⚠️ 没有任何图床')
      return
    }

    const { days, hosting } = parseArgs(msg)

    if (hosting) {
      const data = await getFailReasons(hosting, days)
      if (!data || data.total === 0) {
        await this.reply(`📉 图床 ${hosting} 近 ${days} 天没有记录到任何上传失败`)
        return
      }
      await this.reply([this._formatFailReasons(hosting, data), btn])
    } else {
      // 汇总所有图床
      const allReasons = {}
      let totalFails = 0

      for (const h of hostings) {
        const data = await getFailReasons(h.configKey, days)
        if (!data || data.total === 0) continue
        totalFails += data.total
        for (const r of data.reasons) {
          const key = `[${h.configKey}] ${r.reason}`
          allReasons[key] = (allReasons[key] || 0) + r.count
        }
      }

      if (totalFails === 0) {
        await this.reply(`📉 近 ${days} 天没有记录到任何上传失败`)
        return
      }

      const reasons = Object.entries(allReasons)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([reason, count]) => ({ reason, count }))

      let msgText = `# ❌ 图床失败记录总览\r`
      msgText += `> 统计区间：**${days} 天**\r`
      msgText += `> 失败总数：**${totalFails} 次**\r\r`
      msgText += `| 失败原因 | 次数 |\r`
      msgText += `|---|---|\r`

      for (const item of reasons) {
        msgText += `| ${item.reason.replace(/\r/g, ' ').replace(/\n/g, ' ').slice(0, 80)} | ${item.count} |\r`
      }

      await this.reply([msgText, btn])
    }
  }

  /** #清空CNB图床 */
  async clearCnbAssets() {
    if (Bot._hostingSettings?.apps?.stats === false) return
    if (this.e.adapter_id !== 'QQBot') return

    const cnbHosting = Bot.getHosting('cnb')
    if (!cnbHosting) {
      await this.reply('❌ CNB 图床未注册')
      return
    }
    if (!cnbHosting.enabled) {
      await this.reply('⚠️ CNB 图床未启用')
      return
    }
    if (!cnbHosting.config?.token) {
      await this.reply('❌ CNB token 未配置，请先在 config/cnb.yaml 中填写 token')
      return
    }

    await this.reply('🗑️ 正在清空 CNB 仓库的所有资源，请稍候...')

    let result
    try {
      result = await cnbHosting.clearAllAssets()
    } catch (e) {
      await this.reply(`❌ 清空失败: ${e.message}`)
      return
    }

    const msg = [
      '✅ CNB 图床清空完成',
      `> 远端删除: ${result.deleted} 个`,
      `> 删除失败: ${result.failed} 个`,
      `> 缓存清理: ${result.cacheCleared} 条`,
      ``,
      `总计已清理 ${result.deleted} 个远端资源 + ${result.cacheCleared} 条本地缓存`,
    ].join('\r')
    await this.reply(msg)
  }

  /** 获取 CNB 存储占用 (仅当查询单个 cnb 图床时) */
  async _getCnbVolume(hostingKey) {
    if (hostingKey !== 'cnb') return null
    const cnb = Bot.getHosting?.('cnb')
    if (!cnb?.enabled || !cnb.getRepoVolume) return null
    return await cnb.getRepoVolume()
  }

  _formatSingleStats(name, stats, cnbVolume) {
    let msg = `# 📅 图床状态 - ${name}\r`
    msg += `> 统计区间：**${stats.days} 天** | 数据保留：**${Bot._hostingSettings?.stats?.max_days || 30} 天**\r`
    msg += `> 上传表现：**${speedLevel(stats.avgCost)}**\r\r`
    msg += `## 📊 状态统计\r`
    msg += `| 指标 | 数值 |\r`
    msg += `|---|---|\r`
    msg += `| 上传成功 | **${stats.count}** 张 |\r`
    msg += `| 上传失败 | **${stats.fail}** 次 |\r`
    msg += `| 成功率 | **${percent(stats.count, stats.count + stats.fail)}** |\r`
    msg += `| 最大文件 | **${formatBytes(stats.maxSize)}** |\r`
    msg += `| 最小文件 | **${formatBytes(stats.minSize)}** |\r`
    msg += `| 总大小 | **${formatBytes(stats.totalSize)}** |\r`
    msg += `| 平均单张 | **${formatBytes(stats.count > 0 ? Math.round(stats.totalSize / stats.count) : 0)}** |\r\r`
    msg += `## ⏰ 耗时统计\r`
    msg += `| 项目 | 数值 |\r`
    msg += `|---|---|\r`
    msg += `| 最短耗时 | **${formatMs(stats.minCost)}** |\r`
    msg += `| 最长耗时 | **${formatMs(stats.maxCost)}** |\r`
    msg += `| 平均耗时 | **${formatMs(stats.avgCost)}** |`
    if (cnbVolume !== null) {
      msg += `\r\r> CNB图床占用: **${formatBytes(cnbVolume.volume)}** / 100 GB`
    }
    return msg
  }

  _formatFailReasons(name, data) {
    let msg = `# ❌ 图床失败记录 - ${name}\r`
    msg += `> 统计区间：**${data.days} 天**\r`
    msg += `> 失败总数：**${data.total} 次**\r\r`
    msg += `| 失败原因 | 次数 |\r`
    msg += `|---|---|\r`

    for (const item of data.reasons) {
      msg += `| ${item.reason.replace(/\r/g, ' ').replace(/\n/g, ' ').slice(0, 80)} | ${item.count} |\r`
    }

    return msg
  }
}
