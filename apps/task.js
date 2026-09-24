/**
 * 图床定时清理任务
 *
 * 利用 Yunzai 自带 task 定时任务机制，每日定时调用各图床的
 * cleanExpiredCache() 进行自动删除兜底：
 *   - CNB  / COS：清理 Redis 缓存中过期的远端资源并删除
 *   - PicGo：清理过期 URL 缓存并按 delete_url 删除远端文件
 *
 * 配置开关 (settings.yaml -> apps.task):
 *   apps:
 *     task: true      # 是否启用定时清理 (默认 true)
 *
 * 图床自身的清理窗口由各自 config 中的 cache_expire_days 控制。
 */

export class HostingTask extends plugin {
  constructor() {
    super({
      name: '图床定时清理',
      dsc: '每日定时清理各图床过期缓存与远端文件',
      event: 'message',
      priority: 6000,
      rule: [],
      task: [
        {
          // 每天凌晨 4:00 执行 (Yunzai cron: 秒 分 时 日 月 周)
          name: '图床过期缓存清理',
          cron: '0 0 4 * * ?',
          fnc: () => this.cleanExpiredCache(),
          log: true,
        },
        {
          // 每10分钟检查并准备qqbot分片上传缓存链接
          name: '分片上传预上传缓存准备',
          cron: '0 0/10 * * * ?',
          fnc: () => this.checkPrepareCache(),
          log: true,
        }
      ],
    })
  }

  /** 定时任务：遍历所有图床，调用 cleanExpiredCache 兜底清理过期资源 */
  async cleanExpiredCache() {
    if (Bot._hostingSettings?.apps?.task === false) return
    const hostings = Bot._hostings || []
    if (hostings.length === 0) return

    let totalCleaned = 0
    const details = []
    for (const h of hostings) {
      if (typeof h.cleanExpiredCache !== 'function') continue
      try {
        const n = await h.cleanExpiredCache()
        if (n > 0) {
          totalCleaned += n
          details.push(`${h.configKey}:${n}`)
        }
      } catch (e) {
        logger.error(`[图床定时清理] ${h.configKey} cleanExpiredCache 失败: ${e?.message || e}`)
      }
    }

    if (totalCleaned > 0) {
      logger.mark(`[图床定时清理] 共清理 ${totalCleaned} 个过期资源 (${details.join(', ')})`)
    }
  }
  async checkPrepareCache() {
    if (Bot._hostingSettings?.apps?.task === false) return
    try {
      const h = Bot.getHosting?.('qqbot')
      if (!h?.enabled) return
      const cacheNum = await h.checkPrepareCache()
      if (cacheNum) {
        logger.mark(`[分片预上传缓存准备] 分片上传预上传缓存准备完成(${cacheNum}个)`)
      }
    } catch (e) {
      logger.error(`[分片预上传缓存准备] 失败: ${e?.message || e}`)
    }
  }
}
