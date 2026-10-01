/**
 * #测试图床 - 对所有已开启的图床进行上传测试
 */

import zlib from 'zlib'
import plugin from '../../../lib/plugins/plugin.js'

let _testing = false

function formatMs(ms) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s` }
function formatBytes(b) {
  if (b <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${u[i]}`
}

/** 生成精确约 sizeMb MB 的测试 PNG（纯 Node，无需 canvas）。
 *  先估算像素生成基础图，再用 level:0 (不压缩) 让 raw 体积≈PNG 体积，循环逼近目标体积 */
function generateTestPng(sizeMb = 5) {
  const targetBytes = Math.floor(sizeMb * 1024 * 1024)
  const w = 2000
  let h = Math.max(1, Math.floor((targetBytes - 60) / (w * 3 + 1)))

  const crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c }
  const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const tbuf = Buffer.from(type)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tbuf, data])))
    return Buffer.concat([len, tbuf, data, crc])
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const build = (height) => {
    const bpp = 3
    const raw = Buffer.alloc(w * height * bpp + height)
    for (let y = 0; y < height; y++) {
      const rowOff = y * (w * bpp + 1)
      raw[rowOff] = 0
      for (let x = 0; x < w; x++) {
        const off = rowOff + 1 + x * bpp
        const v = (Math.random() * 256) | 0
        raw[off] = v
        raw[off + 1] = (v * 0.7 + 60) | 0
        raw[off + 2] = (v * 0.5 + 100) | 0
      }
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
    const deflated = zlib.deflateSync(raw, { level: 0 })
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))])
  }

  let buf = build(h)
  let guard = 0
  while (Math.abs(buf.length - targetBytes) > targetBytes * 0.01 && guard++ < 50) {
    const diff = targetBytes - buf.length
    if (diff > 0) h += Math.max(1, Math.floor(diff / (w * 3 + 1)))
    else h += Math.min(-1, Math.ceil(diff / (w * 3 + 1)))
    if (h < 1) h = 1
    buf = build(h)
  }
  return buf
}

export class TestHosting extends plugin {
  constructor() {
    super({
      name: '测试图床',
      dsc: '对所有已开启的图床进行上传测试',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#测试图床(\\d+)?$', fnc: 'testHosting', permission: 'master' },
        { reg: '^#图床$', fnc: 'testWithImage', permission: 'master' },
      ],
    })
  }

  async testHosting() {
    if (Bot._hostingSettings?.apps?.test === false) return
    if (this.e.adapter_id !== 'QQBot') return
    if (_testing) { await this.reply('⏳ 测试正在进行中，请稍后再试'); return }
    _testing = true
    try {
      // 解析 #测试图床N 中的 N (MB)，缺省 5MB，仅允许 1~200 整数
      const m = this.e.msg.match(/^#测试图床(\d+)?$/)
      let sizeMb = m && m[1] ? Number(m[1]) : 5
      sizeMb = Math.min(Math.max(sizeMb, 1), 200)

      let testBuf
      try {
        testBuf = generateTestPng(sizeMb)
      } catch (e) {
        await this.reply(`❌ 无法生成测试图片: ${e.message}`)
        return
      }
      await this._runTest(testBuf, `test_${sizeMb}mb.jpg`)
    } finally { _testing = false }
  }

  /**
   * #图床 - 使用当前消息附带/引用的图片作为测试图进行图床测试
   */
  async testWithImage() {
    if (Bot._hostingSettings?.apps?.test === false) return
    if (this.e.adapter_id !== 'QQBot') return
    if (_testing) { await this.reply('⏳ 测试正在进行中，请稍后再试'); return }
    _testing = true
    try {
      const src = await this._extractImageSource(this.e)
      if (!src) {
        await this.reply('⚠️ 未找到图片：请在消息中附带图片，或引用一条含图片的消息')
        return
      }
      let buf
      try {
        buf = await Bot.Buffer(src.url)
      } catch (e) {
        await this.reply(`❌ 获取图片失败: ${e.message?.slice(0, 120) || e}`)
        return
      }
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        await this.reply('❌ 图片数据为空或获取失败')
        return
      }
      await this._runTest(buf, src.fileName)
    } finally { _testing = false }
  }

  /** 执行图床测试并回复结果（testBuf 为待上传的图片 buffer） */
  async _runTest(testBuf, fileName) {
    const hostings = Bot._hostings || []
    const enabled = hostings.filter(h => h.enabled)

    if (enabled.length === 0) {
      await this.reply('⚠️ 没有已开启的图床，请先在 image_hosting 配置中启用')
      return
    }

    await this.reply(`🧪 正在测试 ${enabled.length} 个图床...`)

    const results = []

    for (const h of enabled) {
      const start = Date.now()
      const result = { name: h.name, key: h.configKey, size: testBuf.length }
      logger.info(`正在测试[${h.name}]图床`)
      try {
        // CNB 测试时传 autoDelete:120 跳过缓存，120秒后自动删除
        const opts = h.configKey === 'cnb' ? { autoDelete: 120 } : {}
        const url = await h.uploadWithStats(testBuf, fileName, opts)
        result.url = url
        result.cost = Date.now() - start
        result.success = true
      } catch (e) {
        result.cost = Date.now() - start
        result.success = false
        result.error = e.message?.slice(0, 100) || '未知错误'
      }
      results.push(result)
    }

    // 排序：成功在前，耗时升序
    results.sort((a, b) => (b.success - a.success) || (a.cost - b.cost))

    let msg = '# 🧪 图床测试结果\n'
    msg += `> 测试文件: ${formatBytes(testBuf.length)}\n`
    msg += `\n| 图床 | 状态 | 耗时 | 说明 |`
    msg += `\n|---|---|---|---|`

    for (const r of results) {
      const status = r.success ? '✅' : '❌'
      const cost = formatMs(r.cost)
      const note = r.success
        ? (r.url || '').replace(/\|/g, '\\|')
        : r.error?.replace(/\|/g, '\\|').replace(/\n/g,'\\n').replace(/\r/g,'\\r') || ''
      msg += `\n| ${r.name} | ${status} | ${cost} | ${note} |`
    }

    const ok = results.filter(r => r.success).length
    msg += `\n\n> 共 ${results.length} 个图床，成功 ${ok} 个，失败 ${results.length - ok} 个`

    await this.reply(msg)
  }

  /**
   * 从事件(含引用消息)中提取第一个图片：当前消息用 e.img[0]，
   * 引用消息从 e.msg_elements[].attachments[].url 取。返回 { url, fileName } 或 null
   */
  async _extractImageSource(e) {
    // 1) 当前消息附带图片
    if (Array.isArray(e.img) && e.img[0]) {
      return { url: e.img[0], fileName: this._imageFileName(e.img[0]) }
    }

    // 2) 引用/回复消息中的图片
    try {
      if (Array.isArray(e.msg_elements)) {
        for (const el of e.msg_elements) {
          const atts = el?.attachments
          if (!Array.isArray(atts)) continue
          for (const a of atts) {
            if (a?.url && typeof a.url === 'string') {
              const fn = (typeof a.filename === 'string' && a.filename) || this._imageFileName(a.url)
              return { url: a.url, fileName: fn }
            }
          }
        }
      }
    } catch (err) {
      logger.debug('[图床测试] 获取引用图片失败:', err)
    }
    return null
  }

  /** 从图片源推断文件名(含扩展名) */
  _imageFileName(src) {
    if (typeof src === 'string') {
      const m = src.split('?')[0].match(/\.([\w]{2,5})(?:$|#)/i)
      if (m) return `image.${m[1].toLowerCase()}`
    }
    return 'image.jpg'
  }
}
