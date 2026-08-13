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
    }
  }

  get configTemplate() { return `# ========== CNB 图床 (cnb.cool) ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "CNB"\n# CNB API 地址\nbaseUrl: "https://api.cnb.cool"\n# CNB 个人访问令牌 (Personal Access Token)\ntoken: ""\n# 默认仓库，格式: 用户名/仓库名\ndefaultRepo: ""\n# 秒，不存 URL 模式下的自动删除时间\nautodelete: 30\n# 是否记录 URL 到 Redis 缓存 (缓存命中时跳过重复上传)\nrecordurl: true\n# 缓存过期天数\ncache_expire_days: 7\n` }

  get autoDelete() {
    return this.config.recordurl ? 0 : (this.config.autodelete || 0)
  }

  async upload(fileBuffer, fileName, opts = {}) {
    const cfg = this.config
    if (!cfg.token) throw new Error('CNB token 未配置')
    const repo = opts.repo || cfg.defaultRepo
    if (!repo) throw new Error('CNB 仓库未配置')

    const isAutoDelete = typeof opts.autoDelete === 'number'

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
        } catch { /* 忽略 */ }
        // 同步删除缓存记录
        if (md5 && redis) {
          try { await redis.del(IMG_CACHE_PREFIX + md5) } catch { /* 忽略 */ }
        }
      }, opts.autoDelete * 1000)
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
    const ok = await this.isUrlAvailable(url)
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

  /** 删除 CNB 仓库中的文件 */
  async _deleteFile(cnbPath) {
    const cfg = this.config
    const url = cnbPath.startsWith('http')
      ? cnbPath
      : `${cfg.baseUrl}/${cnbPath.replace(/^\//, '')}`
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok && resp.status !== 404) {
      const t = await resp.text().catch(() => '')
      throw new Error(`CNB 删除失败: ${resp.status}${t ? ' - ' + t.slice(0, 200) : ''}`)
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
  async _listAssets(repo) {
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
        throw new Error(`CNB 获取资源列表失败: ${resp.status} - ${t}`)
      }
      const data = await resp.json()
      if (!Array.isArray(data) || data.length === 0) break
      all.push(...data)
      if (data.length < pageSize) break
      page++
    }
    return all
  }

  /**
   * 一键清空 CNB 图床的所有远端资源 + 本地 Redis 缓存映射
   * @param {string} [repo] - 可选指定仓库，默认使用配置中的 defaultRepo
   * @returns {Promise<{deleted: number, cacheCleared: number, failed: number}>}
   */
  async clearAllAssets(repo) {
    const cfg = this.config
    if (!cfg.token) throw new Error('CNB token 未配置')
    const targetRepo = repo || cfg.defaultRepo
    if (!targetRepo) throw new Error('CNB 仓库未配置')

    // 1. 获取所有远端 asset 记录
    const assets = await this._listAssets(targetRepo)
    logger.info(`[CNB] 共获取到 ${assets.length} 条资源记录`)

    // 2. 筛选可删除类型 (slug_img / slug_file)
    const deletable = assets.filter(a =>
      a.record_type === 'slug_img' || a.record_type === 'slug_file',
    )
    logger.info(`[CNB] 其中 ${deletable.length} 条可删除 (slug_img/slug_file)`)

    // 3. 并发批量删除远端资源
    const CONCURRENCY = 20
    let deleted = 0, failed = 0
    for (let i = 0; i < deletable.length; i += CONCURRENCY) {
      const batch = deletable.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map(asset => this._deleteFile(asset.path).catch(e => { throw { path: asset.path, error: e } }))
      )
      for (const r of results) {
        if (r.status === 'fulfilled') {
          deleted++
        } else {
          failed++
          const err = r.reason
          logger.debug(`[CNB] 删除失败: ${err?.path || '?'} - ${err?.error?.message || err?.message || err}`)
        }
      }
      // 每批之间短暂间隔，避免触发 API 限流
      if (i + CONCURRENCY < deletable.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // 4. 清空所有本地 Redis 缓存映射
    let cacheCleared = 0
    if (redis) {
      const keys = await redis.keys(IMG_CACHE_PREFIX + '*')
      if (keys.length) {
        await redis.del(keys)
        cacheCleared = keys.length
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
