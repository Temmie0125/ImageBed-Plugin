/**
 * PicGo 图床 (www.picgo.net)
 * 基于 chevereto 分支的图床服务，提供标准 V1 上传 API。
 *
 * 文档: https://www.picgo.net/page/api/?lang=zh-CN
 * 上传端点: POST {url}/api/1/upload
 * 鉴权:    请求头 X-API-Key = 个人中心「设置 - API」获取的密钥 (仅显示一次)
 *          (留空则使用站点 Guest API key，部分部署允许匿名上传)
 * 参数:    source = 图片二进制文件
 * 返回:    { status_code, image: { url, delete_url, ... } } 直链取 image.url
 *
 * 注意:
 *   - 注册用户单文件最大 25MB；匿名/guest 通常更小
 *   - 接口返回标准 chevereto 结构，失败时为 { status_code!=200, error: {...} }
 *   - 支持 recordurl(URL 缓存去重)、autodelete(自动删除)、cache_expire_days(缓存过期清理)
 */

import { BaseHosting, getFileInfo } from './base.js'

const API_BASE = 'https://www.picgo.net'
const UPLOAD_PATH = '/api/1/upload'

// 仅允许图片类型上传
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']

// 单文件大小硬上限 (注册用户 25MB)；超过则提前报错，避免无谓请求
const MAX_FILE_SIZE = 25 * 1024 * 1024

const PICGO_CACHE_PREFIX = 'imagebed:picgo:cache:'

/**
 * 将秒数转换为 ISO8601 时间间隔格式 (Chevereto expiration 参数)
 * 例: 300 -> "PT5M", 5 -> "PT5S", 259200 -> "P3D"
 * @param {number} seconds
 * @returns {string}
 */
function toExpiration(seconds) {
  const s = Math.max(1, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const secs = s % 60
  let str = 'P'
  if (days) str += `${days}D`
  let t = ''
  if (hours) t += `${hours}H`
  if (minutes) t += `${minutes}M`
  if (secs || t === '') t += `${secs}S`
  if (t) str += 'T' + t
  return str
}

export class PicGoHosting extends BaseHosting {
  get configKey() { return 'picgo' }

  get defaults() {
    return {
      enabled: false,
      name: 'PicGo',
      // API 密钥: 个人中心「设置 - API」获取 (仅显示一次)
      //   留空则使用站点 Guest key (若站点开启匿名上传)；上传失败请填 key
      key: '',
      // 秒，不存 URL 模式下的自动删除时间
      autodelete: 30,
      // 是否记录 URL 到 Redis 缓存 (缓存命中时跳过重复上传)
      recordurl: true,
      // 缓存过期天数 (过期后自动清理远端文件与缓存记录)
      cache_expire_days: 7,
    }
  }

  get configTemplate() {
    return `# ========== PicGo 图床 (www.picgo.net) ==========
# 基于 chevereto 的免费图床，标准 V1 API 上传
# 是否启用
enabled: false
# 图床名称
name: "PicGo"
# API 密钥 (key)
#   获取: 个人中心 -> 设置 -> API -> 创建密钥 (仅显示一次，请保存)
#   留空则使用站点 Guest key (若站点允许匿名上传)；若上传报 key 错误请填此处
key: ""
# 秒，不存 URL 模式下的自动删除时间
autodelete: 30
# 是否记录 URL 到 Redis 缓存 (缓存命中时跳过重复上传)
recordurl: true
# 缓存过期天数 (过期后自动清理远端文件与缓存记录)
cache_expire_days: 7
`
  }

  // 记录 URL 时不自动删除 (URL 需长期复用)；未记录 URL 时按 autodelete 配置
  get autoDelete() {
    return this.config.recordurl ? 0 : (this.config.autodelete || 0)
  }

  async upload(fileBuffer, fileName, opts = {}) {
    const cfg = this.config
    const key = cfg.key || ''
    const base = API_BASE

    const fi = await getFileInfo(fileBuffer, fileName || 'image.png')
    if (!Buffer.isBuffer(fi.buffer)) throw new Error('PicGo 上传失败: 文件数据为空')

    const ext = (fi.ext || '').toLowerCase()
    if (!IMG_EXT.includes(ext)) {
      throw new Error(`PicGo 上传失败: 不支持的文件类型 .${ext || '未知'} (仅支持图片 ${IMG_EXT.join('/')})`)
    }
    if (fi.size > MAX_FILE_SIZE) {
      throw new Error(`PicGo 上传失败: 文件过大 (${(fi.size / 1024 / 1024).toFixed(1)}MB > 25MB 上限)`)
    }

    // 自动删除秒数: 优先用 opts.autoDelete；否则未记录 URL 时取 config.autodelete
    const delSec = typeof opts.autoDelete === 'number'
      ? opts.autoDelete
      : (cfg.recordurl ? 0 : (cfg.autodelete || 0))
    const effAutoDelete = delSec > 0

    // 记录 URL 模式下，非 autoDelete 场景先查缓存去重
    if (fi.md5 && cfg.recordurl && !effAutoDelete) {
      const cached = await this._getCache(fi.md5)
      if (cached) return cached
    }

    // 构造 multipart 表单: key + source(文件)
    const formData = new FormData()
    if (key) formData.append('key', key)
    formData.append('source', new File([fi.buffer], fi.name, { type: fi.type || 'image/png' }))
    // expiration: 让服务端在上传时就设置自动过期 (ISO8601 间隔格式)，跨进程重启仍生效
    if (effAutoDelete) {
      formData.append('expiration', toExpiration(delSec))
    }

    const resp = await fetch(`${base}${UPLOAD_PATH}`, {
      method: 'POST',
      headers: key ? { 'X-API-Key': key } : {},
      body: formData,
      signal: AbortSignal.timeout(30000),
    })

    const text = await resp.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`PicGo 上传失败: 返回非 JSON (${resp.status}) ${text.slice(0, 200)}`)
    }

    // chevereto 标准: 成功 status_code === 200 且含 image.url
    if (data.status_code !== 200 || !data.image?.url) {
      const errMsg = data?.error?.message || data?.status_txt || `HTTP ${resp.status}`
      throw new Error(`PicGo 上传失败: ${errMsg} (status_code=${data.status_code ?? '?'})`)
    }

    const url = data.image.url
    const deleteUrl = data.image.delete_url || ''

    // 记录 URL 缓存 (用于去重与自动清理)
    if (fi.md5 && cfg.recordurl) {
      this._setCache(fi.md5, { url, delete_url: deleteUrl, size: fi.size, ext: fi.ext || '' }).catch(() => {})
    }

    // autoDelete 模式：服务端已通过 expiration 设置自动过期(跨重启生效)，
    // 这里再额外定时删除远端文件 + 清理缓存记录，尽量及时释放
    if (effAutoDelete) {
      const md5 = fi.md5
      setTimeout(async () => {
        if (deleteUrl) {
          try {
            await this._deleteFile(deleteUrl)
            logger.info(`[PicGo] 定时删除: ${url}`)
          } catch { /* 忽略 */ }
        }
        if (md5 && redis) {
          try { await redis.del(PICGO_CACHE_PREFIX + md5) } catch { /* 忽略 */ }
        }
      }, delSec * 1000)
    }

    return url
  }

  /** 删除 PicGo 远端文件 (使用 chevereto 返回的 delete_url) */
  async _deleteFile(target) {
    if (!target) return
    try {
      // chevereto 的 delete_url 直接访问(GET)即删除；带 X-API-Key 以满足自建部署的鉴权要求
      const headers = {}
      const key = this.config.key || ''
      if (key) headers['X-API-Key'] = key
      const resp = await fetch(target, { method: 'GET', headers, signal: AbortSignal.timeout(15000) })
      if (resp.status >= 400) {
        logger.debug(`[PicGo] 删除返回状态码 ${resp.status}`)
      }
    } catch (e) {
      logger.debug(`[PicGo] 删除异常: ${e?.message || e}`)
    }
  }

  async isUrlAvailable(url) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ImgCheck/1.0)',
          'Range': 'bytes=0-0',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      })
      return res.status >= 200 && res.status < 400
    } catch {
      return false
    }
  }

  async _getCache(md5) {
    if (!redis) return null
    const key = PICGO_CACHE_PREFIX + md5
    const d = await redis.hGetAll(key)
    if (!d?.url) return null
    // 默认校验链接连通性 (缓存命中但已失效则重新上传)
    if (this.config.checkUrlAlive !== false) {
      const ok = await this.isUrlAvailable(d.url).catch(() => false)
      if (!ok) {
        await redis.del(key)
        return null
      }
    }
    await redis.hSet(key, 'lastUsed', Date.now())
    return d.url
  }

  async _setCache(md5, data) {
    if (!redis) return
    const key = PICGO_CACHE_PREFIX + md5
    const fields = {
      url: String(data.url || ''),
      delete_url: String(data.delete_url || ''),
      size: String(data.size || 0),
      ext: String(data.ext || ''),
      createdAt: String(Date.now()),
      lastUsed: String(Date.now()),
    }
    for (const [field, value] of Object.entries(fields)) {
      await redis.hSet(key, field, value)
    }
  }

  async cleanExpiredCache() {
    if (!redis) return 0
    const expireMs = (this.config.cache_expire_days || 7) * 24 * 60 * 60 * 1000
    const keys = await redis.keys(PICGO_CACHE_PREFIX + '*')
    let cleaned = 0
    for (const key of keys) {
      const d = await redis.hGetAll(key)
      if (!d?.delete_url || !d.lastUsed || Date.now() - Number(d.lastUsed) <= expireMs) continue
      try {
        await this._deleteFile(d.delete_url)
        await redis.del(key)
        cleaned++
      } catch { /* skip */ }
    }
    if (cleaned) logger.info(`[PicGo] 清理 ${cleaned} 张过期缓存`)
    return cleaned
  }
}
