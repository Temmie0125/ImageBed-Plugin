/**
 * 本机公网图床 — 使用 Yunzai 内置 HTTP 服务 (Bot.fileToUrl) 直出图片
 *
 * 不依赖任何第三方服务：图片 buffer 存入 Bot.fs（内存），生成带鉴权参数的
 * /File/<name> URL 后，把主机部分改写为配置的公网地址（域名或 IP:端口），
 * QQ 客户端即可直接拉取并缓存。作为外部图床全部失效时的兜底：
 * 代价是 TTL 内占用本机内存与上行带宽。
 *
 * URL 以内容 md5 命名：同一张图重复上传得到同一 URL（QQ 端按 URL 缓存时
 * 行为正确），不同图片 URL 必不相同，不会触发「同 URL 缓存导致随机图变固定图」。
 */

import crypto from 'node:crypto'
import { BaseHosting, getFileInfo } from './base.js'

export class LocalHosting extends BaseHosting {
  get configKey() { return 'local' }

  get defaults() {
    return {
      enabled: false, name: '本机公网',
      baseUrl: '', ttl: 300,
    }
  }

  get configTemplate() { return `# ========== 本机公网图床 (local) ==========
# 使用 Yunzai 内置 HTTP 服务 (Bot.fileToUrl) 直出图片，
# 将 URL 主机部分改写为公网地址后嵌入 markdown，QQ 客户端直接拉取并缓存。
# 适用作图床全部失效时的兜底：无外部依赖，但 TTL 内占用本机内存与带宽。

# 是否启用
enabled: false
# 图床名称
name: "本机公网"
# 公网访问地址（仅协议+域名/IP+端口，不含路径），如 http://example.com:2536
# 必须与实际对外可达地址一致（防火墙/端口映射需放行），留空则本图床不可用
baseUrl: ""
# 图片保留时长（秒），到期后 URL 失效（访问落回 404 占位图）
ttl: 300
` }

  get autoDelete() { return 0 }

  async upload(fileBuffer, fileName, opts = {}) {
    const cfg = this.config
    const base = String(cfg.baseUrl || '').trim()
    if (!/^https?:\/\//.test(base))
      throw new Error('未配置 baseUrl（对外可达的 http(s)://域名或IP:端口）')
    let target
    try { target = new URL(base) } catch {
      throw new Error(`baseUrl 无效: ${base}`)
    }
    const ttl = Math.max(10, Number(cfg.ttl) || 300)

    // 内容寻址命名：md5 + 真实扩展名
    let name, mime
    try {
      const fi = await getFileInfo(fileBuffer, fileName)
      const md5 = fi.md5 || crypto.createHash('md5').update(fileBuffer).digest('hex')
      name = `ib-${md5}.${fi.ext && fi.ext !== 'bin' ? fi.ext : 'png'}`
      mime = fi.type && fi.type !== 'application/octet-stream' ? fi.type : ''
    } catch {
      name = `ib-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.png`
    }

    // fileToUrl 自动追加 server.auth 鉴权参数，改写主机时原样保留
    const file = { buffer: fileBuffer, name }
    if (mime) file.type = { mime }
    const url = await Bot.fileToUrl(file, { time: ttl * 1000 })
    const u = new URL(url)
    u.protocol = target.protocol
    u.host = target.host
    return u.toString()
  }
}
