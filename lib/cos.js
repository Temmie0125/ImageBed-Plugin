/**
 * 腾讯云 COS 图床
 */

import path from 'path'
import { BaseHosting } from './base.js'
import { imageSize as sizeOf } from 'image-size'

const DIM = /_(\d+)x(\d+)\.[^.]+$/

export class CosHosting extends BaseHosting {
  get configKey() { return 'cos' }
  get defaults() {
    return {
      enabled: false, name: 'COS',
      region: 'ap-guangzhou', secret_id: '', secret_key: '',
      bucket_name: '', domain: '', upload_path_prefix: 'windtrace/',
      max_file_size: 104857600,
    }
  }
  get configTemplate() { return `# ========== 腾讯云 COS 对象存储 ==========\n\n# 是否启用\nenabled: false\n# 图床名称\nname: "COS"\n# COS 地域，如 ap-guangzhou / ap-shanghai\nregion: "ap-guangzhou"\n# 腾讯云 SecretId\nsecret_id: ""\n# 腾讯云 SecretKey\nsecret_key: ""\n# COS 存储桶名称\nbucket_name: ""\n# 自定义域名 (留空则使用 COS 默认域名)\ndomain: ""\n# 上传路径前缀\nupload_path_prefix: "windtrace/"\n# 最大文件大小 (字节)\nmax_file_size: 104857600\n` }
  get autoDelete() { return 0 }
  _client = null

  async _getClient() {
    if (this._client) return this._client
    const c = this.config
    if (!c.secret_id || !c.secret_key || !c.bucket_name || !c.region) throw new Error('COS 配置不完整')
    const COS = (await import('cos-nodejs-sdk-v5')).default
    this._client = new COS({ SecretId: c.secret_id, SecretKey: c.secret_key, Protocol: 'https:' })
    return this._client
  }

  async upload(fileBuffer, fileName, opts = {}) {
    const c = this.config
    if (fileBuffer.length > (c.max_file_size || 104857600)) throw new Error(`过大: ${fileBuffer.length}B`)

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
    await client.putObject({
      Bucket: c.bucket_name, Region: c.region, Key: key,
      Body: fileBuffer, ContentType: guessCt(fileName),
    })
    const baseUrl = c.domain ? `https://${c.domain}` : `https://${c.bucket_name}.cos.${c.region}.myqcloud.com`
    return `${baseUrl}/${key}`
  }

  async deleteFile(cosKey) {
    const c = this.config
    const client = await this._getClient()
    await client.deleteObject({ Bucket: c.bucket_name, Region: c.region, Key: cosKey })
  }
}

function guessCt(fn) {
  const m = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp' }
  return m[path.extname(fn).toLowerCase()] || 'application/octet-stream'
}
