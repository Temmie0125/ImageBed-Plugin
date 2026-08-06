/**
 * 腾讯云 COS 图床
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { BaseHosting, toInt, getFileInfo } from './base.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = path.resolve(__dirname, '../temp')
import { imageSize as sizeOf } from 'image-size'

const DIM = /_(\d+)x(\d+)\.[^.]+$/
const IMG_CACHE_PREFIX = 'imagebed:cos:cache:'

export class CosHosting extends BaseHosting {
  get configKey() { return 'cos' }
  get defaults() {
    return {
      enabled: false, name: 'COS',
      region: 'ap-guangzhou', secret_id: '', secret_key: '',
      bucket_name: '', domain: '', upload_path_prefix: 'windtrace/',
      max_file_size: 104857600,
      internal: false, chunk_parallel: 5,
      autodelete: 30, recordurl: true, cache_expire_days: 7,
    }
  }
  get configTemplate() { return `# ========== 腾讯云 COS 对象存储 ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "COS"\n# COS 地域，如 ap-guangzhou / ap-shanghai\nregion: "ap-guangzhou"\n# 腾讯云 SecretId\nsecret_id: ""\n# 腾讯云 SecretKey\nsecret_key: ""\n# COS 存储桶名称\nbucket_name: ""\n# 自定义域名 (留空则使用 COS 默认域名)\ndomain: ""\n# 上传路径前缀\nupload_path_prefix: "windtrace/"\n# 最大文件大小 (字节)\nmax_file_size: 104857600\n# 是否使用内网域名+HTTP (服务器与 COS 同地域内网时开启，省去 TLS 开销)\ninternal: false\n# 分片上传并发数 (内网可开大，如 5~10)\nchunk_parallel: 5\n# 秒，不存 URL 模式下的自动删除时间 (0 表示不自动删除)\nautodelete: 30\n# 是否记录 URL 到 Redis 缓存 (缓存命中时跳过重复上传)\nrecordurl: true\n# 缓存过期天数 (超过则清理远端对象与缓存记录)\ncache_expire_days: 7\n` }
  get autoDelete() {
    return this.config.recordurl ? 0 : (this.config.autodelete || 0)
  }
  _client = null

  async _getClient() {
    if (this._client) return this._client
    const c = this.config
    if (!c.secret_id || !c.secret_key || !c.bucket_name || !c.region) throw new Error('COS 配置不完整')
    const COS = (await import('cos-nodejs-sdk-v5')).default
    // 内网模式：使用 HTTP 协议 + 内网域名，省去 TLS 握手/加密开销 (需服务器与 COS 同地域)
    if (c.internal) {
      const bucket = c.bucket_name.split('.')[0]
      const internalDomain = `${bucket}.cos-internal.${c.region}.tencentcos.cn`
      this._client = new COS({
        SecretId: c.secret_id, SecretKey: c.secret_key,
        Protocol: 'http:',
        Domain: internalDomain,
        ChunkParallelLimit: toInt(c.chunk_parallel, 5),
      })
    } else {
      this._client = new COS({
        SecretId: c.secret_id, SecretKey: c.secret_key,
        Protocol: 'https:',
        ChunkParallelLimit: toInt(c.chunk_parallel, 5),
      })
    }
    return this._client
  }

  async upload(fileBuffer, fileName, opts = {}) {
    const c = this.config
    if (fileBuffer.length > (c.max_file_size || 104857600)) throw new Error(`过大: ${fileBuffer.length}B`)

    // opts 显式传 autoDelete 时按 opts 删除 (不受 recordurl 影响)
    // 未传时：未记录 URL 才读取配置里的 autodelete
    const hasOptAutoDelete = typeof opts.autoDelete === 'number'
    const isAutoDelete = hasOptAutoDelete || (!c.recordurl && this.autoDelete > 0)
    const autoDeleteSec = hasOptAutoDelete ? opts.autoDelete : this.autoDelete
    // 计算文件信息 (含 md5)；autoDelete 模式跳过缓存查询，始终上传新文件
    const fi = await (async () => {
      const info = await getFileInfo(fileBuffer, fileName || `${Date.now().toString(36)}.png`)
      if (info.md5 && c.recordurl && !isAutoDelete) {
        const cached = await this._getCache(info.md5)
        if (cached) return cached
      }
      return info
    })()
    // 缓存命中直接返回
    if (typeof fi === 'string' && fi.startsWith('http')) return fi

    let dim = { width: 300, height: 300 }
    try { const d = sizeOf(fileBuffer); if (d?.width) dim = d } catch {}

    const ext = path.extname(fileName), base = path.basename(fileName, ext)
    let fn = DIM.test(fileName) ? fileName : `${base}_${dim.width}x${dim.height}${ext}`

    let key
    if (opts.custom_path) {
      const cl = opts.custom_path.replace(/\\/g, '/')
      key = cl.includes('/') ? `${cl.split('/').slice(0, -1).join('/')}/${fn}` : fn
    } else {
      const d = new Date(); const p = n => String(n).padStart(2, '0')
      const ts = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      const pf = (c.upload_path_prefix || 'elaina/').replace(/\\/g, '/')
      const up = opts.user_id ? `${opts.user_id}/` : ''
      key = `${pf}${up}${ts}/${fn}`
    }

    const client = await this._getClient()
    const contentType = guessCt(fileName)

    // 内网：纯内存并发分片，多连接打满带宽 (无落盘、无每片 sha1 开销)
    // 非内网大文件：sliceUploadFile 自动分片 (绕开单请求超时)，需落盘
    const useSlice = !c.internal && fileBuffer.length > 20 * 1024 * 1024
    if (c.internal && fileBuffer.length > 1024 * 1024) {
      const sliceSize = 8 * 1024 * 1024
      const parallel = toInt(c.chunk_parallel, 10)
      const parts = []
      const init = await client.multipartInit({
        Bucket: c.bucket_name, Region: c.region, Key: key,
        Headers: { 'Content-Type': contentType },
      })
      const uploadId = init.UploadId
      try {
        const tasks = []
        let partNumber = 0
        for (let offset = 0; offset < fileBuffer.length; offset += sliceSize) {
          const end = Math.min(offset + sliceSize, fileBuffer.length)
          const pn = ++partNumber
          tasks.push(
            client.multipartUpload({
              Bucket: c.bucket_name, Region: c.region, Key: key,
              UploadId: uploadId, PartNumber: pn,
              Body: fileBuffer.subarray(offset, end),
            }).then((d) => { parts.push({ PartNumber: pn, ETag: d.ETag }) })
          )
        }
        for (let k = 0; k < tasks.length; k += parallel) {
          await Promise.all(tasks.slice(k, k + parallel))
        }
        parts.sort((a, b) => a.PartNumber - b.PartNumber)
        await client.multipartComplete({
          Bucket: c.bucket_name, Region: c.region, Key: key,
          UploadId: uploadId, Parts: parts,
        })
      } catch (err) {
        try { await client.multipartAbort({ Bucket: c.bucket_name, Region: c.region, Key: key, UploadId: uploadId }) } catch {}
        throw err
      }
    } else if (useSlice) {
      fs.mkdirSync(TEMP_DIR, { recursive: true })
      const tmp = path.join(TEMP_DIR, `cos_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`)
      fs.writeFileSync(tmp, fileBuffer)
      try {
        await client.sliceUploadFile({
          Bucket: c.bucket_name, Region: c.region, Key: key,
          FilePath: tmp, SliceSize: 5 * 1024 * 1024,
          ContentType: contentType,
        })
      } finally {
        try { fs.unlinkSync(tmp) } catch {}
      }
    } else {
      await client.putObject({
        Bucket: c.bucket_name, Region: c.region, Key: key,
        Body: fileBuffer, ContentType: contentType,
      })
    }

    const baseUrl = c.domain ? `https://${c.domain}` : `https://${c.bucket_name}.cos.${c.region}.myqcloud.com`
    const url = `${baseUrl}/${key}`

    // 记录缓存 (autoDelete 模式也记录，确保重启后 cleanExpiredCache 能兜底清理)
    if (fi?.md5 && c.recordurl) {
      this._setCache(fi.md5, { url, key, size: fi.size, ext: fi.ext || '' }).catch(() => {})
    }

    // autoDelete 模式：定时删除远端对象 + 同步清理缓存记录
    if (isAutoDelete) {
      const cosKey = key
      const md5 = fi?.md5
      setTimeout(async () => {
        try {
          await this.deleteFile(cosKey)
          logger.info(`[COS] 定时删除: ${cosKey}`)
        } catch { /* 忽略 */ }
        if (md5 && redis) {
          try { await redis.del(IMG_CACHE_PREFIX + md5) } catch { /* 忽略 */ }
        }
      }, autoDeleteSec * 1000)
    }

    return url
  }

  async deleteFile(cosKey) {
    const c = this.config
    const client = await this._getClient()
    await client.deleteObject({ Bucket: c.bucket_name, Region: c.region, Key: cosKey })
  }

  async _getCache(md5) {
    if (!redis) return null
    const key = IMG_CACHE_PREFIX + md5
    const d = await redis.hGetAll(key)
    if (!d?.url) return null
    await redis.hSet(key, 'lastUsed', Date.now())
    return d.url
  }

  async _setCache(md5, data) {
    if (!redis) return
    const key = IMG_CACHE_PREFIX + md5
    const fields = {
      url: String(data.url || ''), key: String(data.key || ''),
      size: String(data.size || 0), ext: String(data.ext || ''),
      createdAt: String(Date.now()), lastUsed: String(Date.now()),
    }
    for (const [field, value] of Object.entries(fields)) {
      await redis.hSet(key, field, value)
    }
  }

  async cleanExpiredCache() {
    if (!redis) return 0
    const expireMs = (this.config.cache_expire_days || 7) * 24 * 60 * 60 * 1000
    const keys = await redis.keys(IMG_CACHE_PREFIX + '*')
    let cleaned = 0
    for (const key of keys) {
      const d = await redis.hGetAll(key)
      if (!d?.key || !d.lastUsed || Date.now() - Number(d.lastUsed) <= expireMs) continue
      try {
        await this.deleteFile(d.key)
        await redis.del(key)
        cleaned++
      } catch { /* skip */ }
    }
    if (cleaned) logger.info(`[COS] 清理 ${cleaned} 个过期缓存`)
    return cleaned
  }
}

function guessCt(fn) {
  const m = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp' }
  return m[path.extname(fn).toLowerCase()] || 'application/octet-stream'
}
