/**
 * 图床基类 - 公共工具 / 配置加载 / 统计
 */

import fs from 'fs'
import path from 'path'
import yaml from 'yaml'
import crypto from 'crypto'
import { fileTypeFromBuffer } from 'file-type'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = path.resolve(__dirname, '../config')

// ==================== 配置加载 ====================

/**
 * 从插件 config 目录加载指定图床的配置文件
 * @param {string} key - 配置文件名 (不含 .yaml)
 * @param {object} defaults - 默认值
 * @param {string|null} template - 带注释的 YAML 模板 (文件不存在时写入)
 * @returns {object}
 */
export function loadHostingConfig(key, defaults = {}, template = null) {
  const filePath = path.join(CONFIG_DIR, `${key}.yaml`)
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = yaml.parse(raw)
      if (parsed && typeof parsed === 'object') {
        return { ...defaults, ...parsed }
      }
    }
    // 不存在则写入配置模板 (优先用带注释的 template)
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      const content = template || yaml.stringify(defaults)
      fs.writeFileSync(filePath, content, 'utf8')
    } catch { /* 只读环境 */ }
    return { ...defaults }
  } catch (e) {
    logger.warn(`[图床] 加载配置 ${key}.yaml 失败: ${e.message}`)
    return { ...defaults }
  }
}

/**
 * 加载 settings.yaml (全局设置)
 * 已有文件缺少默认字段时自动补写
 */
export function loadSettings(defaults = {}, template = null) {
  const result = loadHostingConfig('settings', defaults, template)

  // 已有文件但缺少默认字段 → 补写到文件末尾
  const filePath = path.join(CONFIG_DIR, 'settings.yaml')
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = yaml.parse(raw) || {}
      const missing = {}
      for (const key of Object.keys(defaults)) {
        if (!(key in parsed)) missing[key] = defaults[key]
      }
      if (Object.keys(missing).length > 0) {
        fs.appendFileSync(filePath, '\n' + yaml.stringify(missing), 'utf8')
      }
    }
  } catch { /* 只读环境跳过 */ }

  return result
}

// ==================== 工具函数 ====================

export function toInt(n, d = 0) {
  const v = Number(n)
  return Number.isFinite(v) ? v : d
}

export function formatBytes(bytes = 0) {
  bytes = toInt(bytes, 0)
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

export function formatMs(ms = 0) {
  ms = toInt(ms, 0)
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function speedLevel(avgCost) {
  if (!avgCost || avgCost <= 0) return '—'
  if (avgCost <= 600) return '⚡ 很快'
  if (avgCost <= 1500) return '🚀 良好'
  if (avgCost <= 3000) return '🟡 一般'
  return '🐢 偏慢'
}

export function percent(num, den) {
  if (!den) return '0.00%'
  return `${((num / den) * 100).toFixed(2)}%`
}

// ==================== Cookie 辅助 (参考 adapter/OneBotv11.js) ====================

/**
 * 解析 Cookie 字符串为对象
 */
export function parseCookie(cookie = '') {
  const obj = {}
  for (const pair of String(cookie).split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const k = pair.slice(0, idx).trim()
    const v = pair.slice(idx + 1).trim()
    if (k) obj[k] = v
  }
  return obj
}

/**
 * 计算 QQ bkn (g_tk)
 */
export function getBkn(skey = '') {
  let t = 5381
  for (const ch of String(skey)) t += (t << 5) + ch.charCodeAt(0)
  return t & 0x7fffffff
}

/**
 * 解析出用于获取 Cookie 的机器人实例
 * @param {string} [uin] - 指定机器人 uin，留空取第一个已登录机器人
 */
export function resolveBot(uin) {
  if (uin && Bot[uin]) return Bot[uin]
  if (!Array.isArray(Bot.uin)) return null
  // 留空时取第一个"野生 QQ 机器人"：拥有 sendApi 且已初始化 cookies 的 OneBot 实例，
  // 避免误选其他适配器实例 (缺方法导致 cookie 获取失败)
  for (const u of Bot.uin) {
    const b = Bot[u]
    if (b && typeof b.sendApi === 'function' && b.cookies) return b
  }
  // 兜底：没有任何野生实例时，退而返回第一个（保持不崩）
  const first = Bot.uin[0]
  return (first && Bot[first]) || null
}

/**
 * 从已登录机器人获取指定域名的 Cookie
 * (由 OneBotv11 适配器在连接时通过 sendApi("get_cookies") 写入)
 * @param {string} domain - 如 'qzone.qq.com' / 'qun.qq.com'
 * @param {string} [uin] - 机器人 uin，留空取第一个
 */
export async function getBotCookie(domain, uin) {
  const bot = resolveBot(uin)
  if (!bot) {
    logger.debug(`[ImageBed] 未找到机器人 uin=${uin || '(空)'} （Bot.uin=${Array.isArray(Bot.uin) ? Bot.uin.join(',') : '无'}）`)
    return ''
  }
  let ck = bot.cookies?.[domain] || ''
  // 缓存缺失时按需向客户端实时拉取 (避免刚开机时 cookie 尚未抓完的竞态)
    if (!ck && typeof bot.sendApi === 'function') {
      try {
        const r = await bot.sendApi('get_cookies', { domain })
      const ok = r?.status === 'ok' || r?.retcode === 0
      ck = ok ? (r?.data?.cookies || r?.cookies || '').toString() : ''
      if (ck) {
        bot.cookies = bot.cookies || {}
        bot.cookies[domain] = ck
        logger.debug(`[ImageBed] 按需拉取 ${domain} 成功 (长度 ${ck.length})`)
      } else {
        logger.debug(`[ImageBed] 按需拉取 ${domain} 返回非成功: ${JSON.stringify(r)?.slice(0, 120)}`)
      }
    } catch (e) {
      logger.debug(`[ImageBed] 按需拉取 ${domain} 失败: ${e?.message || e}`)
    }
  }
  if (!ck) {
    const keys = Object.keys(bot.cookies || {})
    logger.debug(`[ImageBed] 未获取到 Cookie domain=${domain}。可用 domain(${keys.length}): ${keys.join(', ')}`)
  }
  return ck
}

/**
 * 从已登录机器人获取 bkn (csrf token)
 */
export function getBotBkn(uin) {
  return resolveBot(uin)?.bkn || 0
}

/**
 * 取 set-cookie 数组 (兼容不同 fetch 实现)
 */
export function getSetCookies(headers) {
  try {
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie() || []
    const raw = headers.get('set-cookie')
    if (Array.isArray(raw)) return raw
    return raw ? [raw] : []
  } catch { return [] }
}


// ==================== 文件信息 ====================

export async function getFileInfo(data, name) {
  const file = { name }
  if (Buffer.isBuffer(data)) {
    file.buffer = data
  } else if (typeof data === 'string') {
    file.buffer = await Bot.Buffer(data, { size: undefined })
  } else {
    file.buffer = data?.buffer || data?.file || data
  }
  if (Buffer.isBuffer(file.buffer)) {
    const ft = (await fileTypeFromBuffer(file.buffer)) || {}
    file.type = ft.mime || 'application/octet-stream'
    file.ext = ft.ext || 'bin'
    file.md5 = crypto.createHash('md5').update(file.buffer).digest('hex')
    file.name = file.name || `${Date.now().toString(36)}.${file.md5.slice(0, 8)}.${file.ext}`
    file.size = file.buffer.length
  }
  return file
}

// ==================== 统计记录 (Redis) ====================

const DAY_MS = 24 * 60 * 60 * 1000

export async function recordStats(hostingName, { size = 0, cost = 0, success = true, failReason = '' }) {
  try {
    if (!redis) return
    const settings = Bot._hostingSettings || {}
    if (!settings.stats?.enabled) return
    const maxDays = toInt(settings.stats?.max_days, 30)

    const now = Date.now()
    const key = `imagebed:stats:${hostingName}`
    const record = JSON.stringify({
      ts: now, size: toInt(size, 0), cost: toInt(cost, 0),
      success: !!success, failReason: success ? '' : String(failReason),
    })
    const multi = redis.multi()
    multi.zAdd(key, { score: now, value: record })
    if (Math.random() < 0.1) multi.zRemRangeByScore(key, 0, now - maxDays * DAY_MS)
    await multi.exec()
  } catch { /* 统计失败不影响 */ }
}

export async function getStats(hostingName, days = 1) {
  if (!redis) return null
  const settings = Bot._hostingSettings || {}
  const maxDays = toInt(settings.stats?.max_days, 30)
  days = Math.max(1, Math.min(maxDays, toInt(days, 1)))
  const now = Date.now()
  const key = `imagebed:stats:${hostingName}`

  await redis.zRemRangeByScore(key, 0, now - maxDays * DAY_MS)
  const records = await redis.zRangeByScore(key, now - days * DAY_MS, now)
  if (!records?.length) return null

  const parsed = records.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  const ok = parsed.filter(r => r.success)
  const fail = parsed.length - ok.length
  const costs = ok.map(r => toInt(r.cost, 0)).filter(v => v >= 0)
  const sizes = ok.map(r => toInt(r.size, 0)).filter(v => v >= 0)

  return {
    days, count: ok.length, fail,
    totalSize: ok.reduce((s, r) => s + toInt(r.size, 0), 0),
    avgCost: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length) : 0,
    minCost: costs.length ? Math.min(...costs) : 0,
    maxCost: costs.length ? Math.max(...costs) : 0,
    minSize: sizes.length ? Math.min(...sizes) : 0,
    maxSize: sizes.length ? Math.max(...sizes) : 0,
  }
}

export async function getFailReasons(hostingName, days = 1) {
  if (!redis) return { days, total: 0, reasons: [] }
  const settings = Bot._hostingSettings || {}
  const maxDays = toInt(settings.stats?.max_days, 30)
  days = Math.max(1, Math.min(maxDays, toInt(days, 1)))
  const now = Date.now()
  const key = `imagebed:stats:${hostingName}`

  await redis.zRemRangeByScore(key, 0, now - maxDays * DAY_MS)
  const records = await redis.zRangeByScore(key, now - days * DAY_MS, now)

  const fails = {}
  for (const s of records || []) {
    try {
      const r = JSON.parse(s)
      if (!r.success && r.failReason) fails[r.failReason] = (fails[r.failReason] || 0) + 1
    } catch { /* skip */ }
  }
  const reasons = Object.entries(fails)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([reason, count]) => ({ reason, count }))
  return { days, total: Object.values(fails).reduce((a, b) => a + b, 0), reasons }
}

// ==================== 基类 ====================

export class BaseHosting {
  /** 配置文件名 (不含 .yaml) */
  get configKey() { return '' }

  /** 默认配置 */
  get defaults() { return {} }

  /** 带注释的 YAML 模板 (文件首次生成时使用) */
  get configTemplate() { return null }

  /** 缓存的配置 */
  get config() {
    if (!this._config) this._config = loadHostingConfig(this.configKey, this.defaults, this.configTemplate)
    return this._config
  }

  /** 图床名称 */
  get name() { return this.config.name || this.configKey }

  /** 是否启用 */
  get enabled() { return !!this.config.enabled }

  /** 自动删除时间(秒), 0 = 不删除 */
  get autoDelete() { return 0 }

  /**
   * 上传文件 (子类实现)
   * @returns {Promise<string>} URL
   */
  async upload(fileBuffer, fileName, opts = {}) {
    throw new Error('子类必须实现 upload 方法')
  }

  /**
   * 带统计计时的上传包装
   */
  async uploadWithStats(fileBuffer, fileName, opts = {}) {
    const start = Date.now()
    try {
      const url = await this.upload(fileBuffer, fileName, opts)
      const cost = Date.now() - start
      recordStats(this.configKey, { size: fileBuffer.length, cost, success: true }).catch(() => {})
      return url
    } catch (e) {
      const cost = Date.now() - start
      recordStats(this.configKey, {
        size: fileBuffer.length, cost, success: false,
        failReason: e.message?.slice(0, 200) || 'unknown',
      }).catch(() => {})
      throw e
    }
  }

  /**
   * 上传并自动删除 (如果配置了 autoDelete)
   */
  async uploadAndScheduleDelete(fileBuffer, fileName, opts = {}) {
    const url = await this.uploadWithStats(fileBuffer, fileName, opts)
    const delSec = opts.autoDelete ?? this.autoDelete
    if (delSec > 0 && this._deleteFile) {
      setTimeout(async () => {
        try {
          await this._deleteFile(path, fileBuffer, fileName)
        } catch { /* 忽略删除错误 */ }
      }, delSec * 1000)
    }
    return url
  }
}
