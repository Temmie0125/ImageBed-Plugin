/**
 * CNB 图床 (cnb.cool)
 */

import { BaseHosting, getFileInfo } from './base.js'

const IMG_CACHE_PREFIX = 'imagebed:cnb:cache:'

export class CnbHosting extends BaseHosting {
  get configKey() { return 'cnb' }

  get defaults() {
    return {
      enabled: false, name: 'CNB',
      baseUrl: 'https://api.cnb.cool', token: '', defaultRepo: '',
      autodelete: 30, recordurl: true, cache_expire_days: 7,
      checkUrlAlive: true,
    }
  }

  get configTemplate() { return `# ========== CNB 图床 (cnb.cool) ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "CNB"\n# CNB API 地址\nbaseUrl: "https://api.cnb.cool"\n# CNB 个人访问令牌 (Personal Access Token)\ntoken: ""\n# 默认仓库，格式: 用户名/仓库名\ndefaultRepo: ""\n# 秒，不存 URL 模式下的自动删除时间\nautodelete: 30\n# 是否记录 URL 到 Redis 缓存 (缓存命中时跳过重复上传)\nrecordurl: true\n# 缓存过期天数\ncache_expire_days: 7\n# 读取缓存时是否先校验链接连通性 (缓存命中但已失效则重新上传)\ncheckUrlAlive: true\n` }

  get autoDelete() {
    return this.config.recordurl ? 0 : (this.config.autodelete || 0)
  }

  async upload(fileBuffer, fileName, opts = {}) {
    const cfg = this.config
    if (!cfg.token) throw new Error('CNB token 未配置')
    const repo = opts.repo || cfg.defaultRepo
    if (!repo) throw new Error('CNB 仓库未配置')

    // 自动删除: 优先用 opts.autoDelete, 否则当 recordurl=false 且配置了 autodelete 时读取配置
    const hasOptAutoDelete = typeof opts.autoDelete === 'number'
    const isAutoDelete = hasOptAutoDelete || (!cfg.recordurl && this.autoDelete > 0)
    const autoDeleteSec = hasOptAutoDelete ? opts.autoDelete : this.autoDelete

    // 计算文件信息 (含 md5)；autoDelete 模式下跳过缓存查询，始终上传新文件
    const fi = await (async () => {
      const info = await getFileInfo(fileBuffer, fileName || `${Date.now().toString(36)}.png`)
      if (info.md5 && cfg.recordurl && !isAutoDelete) {
        const cached = await this._getCache(info.md5)
        if (cached) return cached
      }
      return info
    })()

    // 缓存命中直接返回
    if (typeof fi === 'string' && fi.startsWith('http')) return fi

    const enc = encodeURIComponent(fi.name)
    const info = await this._getUploadUrl(repo, enc, fileBuffer.length)
    await this._uploadPut(fileBuffer, info)

    let url = info.assets?.url || info.assets?.path
    if (!url) throw new Error('CNB 返回 URL 为空')
    if (!url.startsWith('http')) url = `https://cnb.cool${url}`

    // 记录缓存 (autoDelete 模式也记录，确保重启后 cleanExpiredCache 能兜底清理)
    if (fi?.md5 && cfg.recordurl && info.assets) {
      this._setCache(fi.md5, { url, repo, ...info.assets, size: fi.size, ext: fi.ext || '' }).catch(() => {})
    }

    // autoDelete 模式：定时删除远端文件 + 同步清理缓存记录
    if (info.assets?.path && isAutoDelete) {
      const filePath = info.assets.path
      const md5 = fi?.md5
      setTimeout(async () => {
        try {
          await this._deleteFile(filePath)
          logger.info(`[CNB] 定时删除: ${filePath}`)
        } catch {
          logger.warn(`[CNB] 定时删除失败: ${filePath}，将在自动清理时清理`)
        }
        // 同步删除缓存记录
        if (md5 && redis) {
          try { await redis.del(IMG_CACHE_PREFIX + md5) } catch { /* 忽略 */ }
        }
      }, (autoDeleteSec || 0) * 1000)
    }

    return url
  }

  async _getUploadUrl(repo, fileName, size) {
    const cfg = this.config
    const isImg = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(fileName)
    const up = isImg ? 'imgs' : 'files'
    const resp = await fetch(`${cfg.baseUrl}/${repo}/-/upload/${up}`, {
      method: 'POST',
      headers: { accept: 'application/json', Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: fileName, size }),
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) { const t = await resp.text(); throw new Error(`CNB 获取URL失败: ${resp.status} - ${t}`) }
    return await resp.json()
  }

  async _uploadPut(buf, info) {
    let url = info.upload_url; const h = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }
    if (info.form && Object.keys(info.form).length) { const u = new URL(url); for (const [k, v] of Object.entries(info.form)) u.searchParams.append(k, v); url = u.toString() }
    if (info.token) h.Authorization = `Bearer ${info.token}`
    const resp = await fetch(url, { method: 'PUT', headers: h, body: buf, signal: AbortSignal.timeout(60000) })
    if (!resp.ok) { const t = await resp.text(); throw new Error(`CNB 上传失败: ${resp.status} - ${t}`) }
  }

 async isUrlAvailable(url) {
    try {
      const start = Date.now()
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ImgCheck/1.0)',
          'Range': 'bytes=0-0'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      })
      logger.info(`[图床] 检验缓存链接连通性耗时${Date.now() - start}ms`)
      return res.status >= 200 && res.status < 400
    } catch {
      return false
    }
  }

  async _getCache(md5) {
    if (!redis) return null
    const key = IMG_CACHE_PREFIX + md5
    const d = await redis.hGetAll(key)
    if (!d?.url) return null
    const rawUrl = d.url
    const url = rawUrl.startsWith('http')
      ? rawUrl
      : `https://cnb.cool${rawUrl}`
    const ok = this.config.checkUrlAlive === false ? true : await this.isUrlAvailable(url)
    if (!ok) {
      await redis.del(key)
      return null
    }
    await redis.hSet(key, 'lastUsed', Date.now())
    return url
  }

  async _setCache(md5, data) {
    if (!redis) return
    const key = IMG_CACHE_PREFIX + md5
    const fields = {
      url: String(data.url || ''), repo: String(data.repo || ''),
      path: String(data.path || ''), size: String(data.size || 0),
      ext: String(data.ext || ''), createdAt: String(Date.now()), lastUsed: String(Date.now()),
    }
    for (const [field, value] of Object.entries(fields)) {
      await redis.hSet(key, field, value)
    }
  }

  /** 构造无权限终止错误 (Token 缺少 repo-manage:rw 等 scope) */
  _forbiddenError(cause) {
    const e = new Error(
      'CNB 清空中止：Token 权限不足，缺少必要授权范围 repo-manage:rw。' +
      '请前往 CNB 个人访问令牌设置页，为当前 token 勾选「仓库管理(repo-manage)」读写权限后重试。'
    )
    e.code = 'FORBIDDEN'
    e.cause = cause
    return e
  }

  /**
   * 权限预检：对占位路径发一次删除请求，探测 token 是否具备 repo-manage:rw
   * - 403 -> 抛出 FORBIDDEN 错误 (无权限，不应继续)
   * - 404 / 其它 -> 权限正常，返回 true
   * 占位删除无副作用，仅用于进入清空流程前提前拦截
   */
  async checkPermission() {
    try {
      await this._deleteFile('__imagebed_permission_check__')
    } catch (e) {
      if (e?.code === 'FORBIDDEN') throw e
      // 其它异常(网络等)不阻断，交由正式流程报错
    }
    return true
  }

  /** 删除 CNB 仓库中的文件 (含限流 429 / 5xx 指数退避重试) */
  async _deleteFile(cnbPath) {
    const cfg = this.config
    const url = cnbPath.startsWith('http')
      ? cnbPath
      : `${cfg.baseUrl}/${cnbPath.replace(/^\//, '')}`

    const MAX_RETRY = 5
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      const resp = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(15000),
      })
      // 404 视为已删除，直接成功
      if (resp.status === 404) return
      if (resp.ok) return
      // 429 限流 / 5xx 服务端错误 -> 指数退避后重试
      if (resp.status === 429 || resp.status >= 500) {
        const t = await resp.text().catch(() => '')
        if (attempt < MAX_RETRY) {
          const delay = Math.min(2000 * 2 ** attempt, 30000) // 2s,4s,8s,16s,32s(封顶30s)
          logger.warn(`[CNB] 删除遇限流(${resp.status})，${delay}ms 后重试: ${t.slice(0, 80)}`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        logger.error(`CNB 删除失败(重试耗尽): ${resp.status} - ${t.slice(0, 200)}`)
        return
      }
      // 403 权限不足 (如缺少 repo-manage:rw) -> 抛出标记错误，终止整个清空流程
      if (resp.status === 403) {
        const t = await resp.text().catch(() => '')
        const e = new Error(`CNB 删除失败(403 无权限)${t ? ' - ' + t.slice(0, 200) : ''}`)
        e.code = 'FORBIDDEN'
        throw e
      }
      // 其它客户端错误 (4xx 非 404/429/403) 不重试，直接返回
      const t = await resp.text().catch(() => '')
      logger.error(`CNB 删除失败: ${resp.status}${t ? ' - ' + t.slice(0, 200) : ''}`)
      return
    }
  }

  async cleanExpiredCache() {
    if (!redis) return 0
    const expireMs = (this.config.cache_expire_days || 7) * 24 * 60 * 60 * 1000
    const keys = await redis.keys(IMG_CACHE_PREFIX + '*')
    let cleaned = 0
    for (const key of keys) {
      const d = await redis.hGetAll(key)
      if (!d?.path || !d.lastUsed || Date.now() - Number(d.lastUsed) <= expireMs) continue
      try {
        await this._deleteFile(d.path)
        await redis.del(key)
        cleaned++
      } catch { /* skip */ }
    }
    if (cleaned) logger.info(`[CNB] 清理 ${cleaned} 张过期缓存`)
    return cleaned
  }

  /**
   * 获取仓库 asset 记录列表 (分页自动拉取全部)
   * @param {string} repo - 仓库 slug
   * @returns {Promise<Array>} asset 列表
   */
  /**
   * 分页拉取仓库 asset 记录。
   * 若传入 onPage 回调，则「拉一页处理一页」(用于边获取边删除，中断后不会重删整批)；
   * 否则收集全部返回。
   * @param {string} repo - 仓库 slug
   * @param {(items: Array) => (Promise<void>|void|boolean)} [onPage] - 每页回调，返回 false 可提前停止
   * @returns {Promise<Array>} 未提供 onPage 时返回全部记录数组
   */
  async _listAssets(repo, onPage) {
    const cfg = this.config
    const all = []
    let page = 1
    const pageSize = 100
    while (true) {
      const resp = await fetch(
        `${cfg.baseUrl}/${repo}/-/list-assets?page=${page}&page_size=${pageSize}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.cnb.api+json',
            Authorization: `Bearer ${cfg.token}`,
          },
          signal: AbortSignal.timeout(30000),
        },
      )
      if (!resp.ok) {
        const t = await resp.text()
        logger.error(`CNB 获取资源列表失败: ${resp.status} - ${t}`)
        break
      }
      const data = await resp.json()
      if (!Array.isArray(data) || data.length === 0) break
      if (onPage) {
        const stop = await onPage(data)
        if (stop === false) break
      } else {
        all.push(...data)
      }
      if (data.length < pageSize) break
      page++
    }
    return all
  }

  /**
   * 一键清空 CNB 图床的所有远端资源 + 本地 Redis 缓存映射
   *
   * 优化策略 (减少 list 查询请求、避免资源过多时 list 耗时过长):
   *   1. 先扫本地 Redis 缓存，直接按缓存中的 path 删除远端文件，并同步清理缓存记录；
   *      (绝大多数资源都在缓存里，无需先 list)
   *   2. 缓存清空后，再 list 拉取「缓存未覆盖」的残留记录 (如曾关闭 recordurl / 重启丢缓存)；
   *      采用边拉页边删除：每拉到一页立即删除该页，中断后再跑只需处理剩余页，不会重删整批。
   *   3. 最终兜底清理 list 期间可能新增的缓存 key。
   *
   * @param {string} [repo] - 可选指定仓库，默认使用配置中的 defaultRepo
   * @returns {Promise<{deleted: number, cacheCleared: number, failed: number}>}
   */
  async clearAllAssets(repo) {
    const cfg = this.config
    if (!cfg.token) throw new Error('CNB token 未配置')
    const targetRepo = repo || cfg.defaultRepo
    if (!targetRepo) throw new Error('CNB 仓库未配置')

    const CONCURRENCY = 1
    let deleted = 0, failed = 0, cacheCleared = 0

    // === 阶段 1: 基于本地缓存删除 (不触发 list 查询) ===
    if (redis) {
      const cacheKeys = await redis.keys(IMG_CACHE_PREFIX + '*')
      logger.info(`[CNB] 本地缓存共 ${cacheKeys.length} 条，先按缓存删除远端`)
      for (let i = 0; i < cacheKeys.length; i += CONCURRENCY) {
        const batch = cacheKeys.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map(async (key) => {
            const d = await redis.hGetAll(key)
            // 删除远端 (有 path 才删，避免无效请求)
            if (d?.path) {
              try { await this._deleteFile(d.path) }
              catch (e) {
                if (e?.code === 'FORBIDDEN') throw e // 权限不足，向上中止
                failed++ // 其它失败计入，但缓存仍清
              }
            }
            // 同步清理缓存记录
            await redis.del(key)
            cacheCleared++
            if (d?.path) deleted++
          })
        )
        for (const r of results) {
          if (r.status === 'rejected') {
            if (r.reason?.code === 'FORBIDDEN') throw this._forbiddenError(r.reason)
            failed++
            logger.debug(`[CNB] 缓存删除异常: ${r.reason?.message || r.reason}`)
          }
        }
        if (i + CONCURRENCY < cacheKeys.length) {
          await new Promise(resolve => setTimeout(resolve, 300))
        }
      }
      logger.info(`[CNB] 阶段1完成: 基于缓存删除 ${deleted} 个远端, 清理 ${cacheCleared} 条缓存, 失败 ${failed} 个`)
    }

    // === 阶段 2: 兜底 list 残留 (缓存未覆盖的资源)，边拉页边删 ===
    // 每拉到一页立即删除该页资源，中断后再跑只需处理剩余页，不会重删整批
    let rDeleted = 0, rFailed = 0
    let lastPageCount = 0
    await this._listAssets(targetRepo, async (pageItems) => {
      // 仅处理可删除类型 (slug_img / slug_file)
      const deletable = pageItems.filter(a =>
        a.record_type === 'slug_img' || a.record_type === 'slug_file',
      )
      lastPageCount += deletable.length
      for (let i = 0; i < deletable.length; i += CONCURRENCY) {
        const batch = deletable.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map(asset => this._deleteFile(asset.path).catch(e => { throw { path: asset.path, error: e } }))
        )
        for (const r of results) {
          if (r.status === 'fulfilled') rDeleted++
          else {
            const err = r.reason
            if (err?.error?.code === 'FORBIDDEN') throw this._forbiddenError(err.error)
            rFailed++
            logger.debug(`[CNB] 残留删除失败: ${err?.path || '?'} - ${err?.error?.message || err?.message || err}`)
          }
        }
        if (i + CONCURRENCY < deletable.length) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
    })
    deleted += rDeleted
    failed += rFailed
    logger.info(`[CNB] 阶段2完成: 兜底删除 ${rDeleted} 个残留, 失败 ${rFailed} 个`)

    // === 阶段 3: 最终兜底清理可能新增的缓存 key (list 期间若有新上传) ===
    if (redis) {
      const leftKeys = await redis.keys(IMG_CACHE_PREFIX + '*')
      if (leftKeys.length) {
        await redis.del(leftKeys)
        cacheCleared += leftKeys.length
      }
    }

    logger.mark(`[CNB] 清空完成: 远端删除 ${deleted} 个, 失败 ${failed} 个, 缓存清理 ${cacheCleared} 条`)
    return { deleted, cacheCleared, failed }
  }

  /**
   * 获取 CNB 仓库对象存储占用量
   * @returns {Promise<{volume: number, slug: string}|null>} 字节数及仓库路径, 获取失败返回 null
   */
  async getRepoVolume() {
    const cfg = this.config
    if (!cfg.token || !cfg.defaultRepo) return null
    const parts = cfg.defaultRepo.split('/')
    if (parts.length < 2) return null
    const org = parts[0]
    const fullSlug = cfg.defaultRepo

    try {
      const resp = await fetch(
        `${cfg.baseUrl}/${org}/-/charge/repos-volume?type=charge_type_object`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.cnb.api+json',
            Authorization: `Bearer ${cfg.token}`,
          },
          signal: AbortSignal.timeout(15000),
        },
      )
      if (!resp.ok) return null
      const data = await resp.json()
      if (!Array.isArray(data)) return null
      const repo = data.find(r => r.slug === fullSlug && !r.is_deleted)
      if (!repo) return null
      return { volume: parseInt(repo.volume, 10) || 0, slug: repo.slug }
    } catch {
      return null
    }
  }
}
