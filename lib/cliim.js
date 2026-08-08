/**
 * CliIm 图床 —— 仿 QqbotHosting 风格实现的 cli.im 适配器
 * 对应 chun_bai_ling(qiancao) 中 qt/global.cpp 的 uploadToMhimg()
 *
 * 接口: POST https://upload.api.cli.im/upload.php?kid=cliim
 * 表单字段: Filedata ; 文件名 = buffer 的 MD5 + 原扩展名
 * 响应: { status: "1", data: { path: "<图片URL>" } }
 */

import crypto from 'node:crypto'
import { BaseHosting } from './base.js'

const UPLOAD_URL = 'https://upload.api.cli.im/upload.php?kid=cliim'

export class CliImHosting extends BaseHosting {
  get configKey() { return 'cliim' }

  get defaults() {
    return {
      enabled: false,
      name: 'CliIm',
      timeout: 30000, // 与 C++ 的 30s 超时一致
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }

  get configTemplate() {
    return `# ========== CliIm 图床 (cli.im 免费图床, 无需配置) ==========

# 是否启用
enabled: false
# 图床名称
name: "CliIm"
# 上传超时 (毫秒)
timeout: 30000
`
  }

  get autoDelete() { return 0 }

  // buffer 的 MD5(十六进制),用作 cli.im 的文件名
  _md5(buf) {
    return crypto.createHash('md5').update(buf).digest('hex')
  }

  // 从原始文件名推断扩展名(缺省 .jpg)
  _ext(name) {
    if (!name) return '.jpg'
    const i = name.lastIndexOf('.')
    return i >= 0 ? name.slice(i).toLowerCase() : '.jpg'
  }

  // 生成 multipart 边界(仿 Chrome: ----WebKitFormBoundary + 16 位随机)
  _boundary() {
    return '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex')
  }

  /**
   * 上传图片 buffer 到 cli.im
   * @param {Buffer} fileBuffer 图片二进制
   * @param {string} [fileName=''] 可选原始文件名(仅用于取扩展名)
   * @returns {Promise<string>} 图片直链
   */
  async upload(fileBuffer, fileName = '') {
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
      throw new Error('CliIm: 图片数据为空')
    }

    const boundary = this._boundary()
    const name = this._md5(fileBuffer) + this._ext(fileName)
    const c = this.config

    // 拼装 multipart/form-data 请求体(与 C++ 字节级一致)
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="Filedata"; filename="${name}"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`,
      'utf8'
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    const body = Buffer.concat([head, fileBuffer, tail])

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), c.timeout)
    try {
      const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'User-Agent': c.userAgent,
          Accept: '*/*',
          Origin: 'https://cli.im',
          Referer: 'https://cli.im/deqr/',
          'Sec-Fetch-Site': 'same-site',
          'Sec-Fetch-Mode': 'cors',
        },
        body,
        signal: controller.signal,
      })

      const data = await res.text()
      if (res.status !== 200) {
        throw new Error(`CliIm HTTP ${res.status}: ${data}`)
      }

      let json
      try {
        json = JSON.parse(data)
      } catch (e) {
        throw new Error('CliIm 返回非 JSON: ' + data)
      }
      if (json.status !== '1') {
        throw new Error(`CliIm 上传失败 status=${json.status} msg=${json.msg}`)
      }
      const path = json.data && json.data.path
      if (!path) {
        throw new Error('CliIm 响应缺少 data.path')
      }
      // 与 C++ 一致: 直接返回 data.path
      return path
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error('CliIm 上传超时')
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}
