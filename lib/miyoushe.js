/**
 * 米游社图床 (api-takumi.miyoushe.com)
 * 通过米游社 OSS 直传接口上传图片：先使用登录 Cookie 换取阿里云 OSS 直传凭证，
 * 再把图片二进制直传到 OSS，回调后返回官方图床直链。
 *
 * 参考实现: https://gist.github.com/CMHopeSunshine/4173c475b20196b2b033cfd6b2192b80
 *
 * Cookie 获取：
 *   - cookieMode: "fixed"  使用本配置中的固定 cookie
 *   - cookieMode: "auto"   自动读取 Yunzai 中已绑定的米游社 CK
 *     (持久 Cookie 存于 Yunzai 的 SQL 表 MysUsers(字段 ck)，由 MysUserDB 管理。
 *      米游社 Cookie 只在 SQL 持久化，redis 中的 ltuid-ck 是空的历史预留缓存表、从未被写入，不可作为来源)
 *     auto 依次尝试 import 以下模块的 MysUserDB.findAll() 取第一个有效 ck：
 *       1) Yunzai-genshin (../../Yunzai-genshin/model/db/MysUserDB.js)
 *       2) miao-plugin    (../../miao-plugin/models/MysUserDB.js)
 *     两者均基于同一 #miao 底层，接口与返回结构一致，故可无缝互为备选。
 */

import https from 'node:https'
import crypto from 'node:crypto'
import { BaseHosting, getFileInfo } from './base.js'

const API_BASE = 'https://api-takumi.miyoushe.com'
const GET_PARAMS = '/upload/outer/getParamsByAccount'

// 仅允许图片类型上传（米游社图床只接受图片）
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']

// auto 模式下动态加载米游社 CK 存储模块(MysUserDB)的候选路径
// 相对本文件(lib/)解析：../ 指向 ImageBed-Plugin，../../ 才指向上层 plugins 目录
// 两者均基于同一 #miao 底层(BaseModel/SQL 存储)，接口与返回结构一致，可无缝互为备选
const CK_MODULE_CANDIDATES = [
  '../../Yunzai-genshin/model/db/MysUserDB.js', // 1) 优先 Yunzai-genshin
  '../../genshin/model/db/MysUserDB.js', //    备选：同名精简目录
  '../../miao-plugin/models/MysUserDB.js', //   2) 其次 miao-plugin
]

export class MiyousheHosting extends BaseHosting {
  get configKey() { return 'miyoushe' }

  get defaults() {
    return {
      enabled: false,
      name: '米游社',
      // Cookie 获取方式: fixed=使用下方固定 cookie; auto=自动读取 Yunzai-genshin 已绑定的 CK
      cookieMode: 'fixed',
      cookie: '',
    }
  }

  get configTemplate() {
    return `# ========== 米游社图床 (api-takumi.miyoushe.com) ==========
# 米游社社区 OSS 图床：使用登录 Cookie 换取阿里云 OSS 直传凭证后上传
# 是否启用
enabled: false
# 图床名称
name: "米游社"
# Cookie 获取方式
#   fixed = 使用下方固定 Cookie
#   auto  = 自动读取 Yunzai 中已绑定的米游社 CK（优先 Yunzai-genshin，其次 miao-plugin，无需手动抓包）
cookieMode: "fixed"
# 固定 Cookie (cookieMode=fixed 时生效，含 stuid / stoken / ltoken)
#   抓包位置: 米游社网页端/App 任意已登录请求 -> 请求头 -> Cookie
cookie: ""
`
  }

  get autoDelete() { return 0 }

  // 解析当前应使用的米游社 Cookie
  async resolveCookie() {
    const mode = (this.config.cookieMode || 'fixed').toLowerCase()
    if (mode === 'auto') {
      return await this.getAutoCookie()
    }
    return this.config.cookie || ''
  }

  // auto 模式：依次尝试各候选模块(Yunzai-genshin / miao-plugin)的 MysUserDB，
  // 读取第一个有效米游社 CK（持久存于 SQL 表 MysUsers.ck，二者接口一致）。
  // 不额外做 SQL 直连兜底：米游社 Cookie 仅由 MysUserDB 管理，直连 SQL 属重复实现且易碎，
  // 若所有候选模块均不可导入/查询失败，则明确报错交由插件 fallback 链处理。
  async getAutoCookie() {
    const MysUserDB = await this.loadCkModule()
    if (!MysUserDB) {
      throw new Error('自动获取米游社 Cookie 失败：未找到 Yunzai-genshin 或 miao-plugin 模块（需安装其一），或改用 cookieMode: fixed')
    }
    let rows
    try {
      rows = await MysUserDB.findAll()
    } catch (e) {
      throw new Error(`自动获取米游社 Cookie 失败：读取 MysUserDB 出错 - ${e.message}`)
    }
    rows = Array.isArray(rows) ? rows : []
    for (const r of rows) {
      if (r && r.ck) return r.ck
    }
    throw new Error('自动获取米游社 Cookie 失败：Yunzai 中未存储任何米游社 Cookie，请先在米游社插件绑定 CK（如 #绑定ck）')
  }

  // 动态加载候选 CK 存储模块(MysUserDB)，按实例缓存避免重复连接存储后端。
  // 优先 Yunzai-genshin，其次 miao-plugin；任一可导入即返回其 MysUserDB。
  async loadCkModule() {
    if (this._ckMod !== undefined) return this._ckMod

    for (const p of CK_MODULE_CANDIDATES) {
      try {
        const m = await import(p)
        const mod = m.default || m
        if (mod && typeof mod.findAll === 'function') {
          this._ckMod = mod
          return this._ckMod
        }
      } catch {
        // 候选路径不存在或加载失败，继续尝试下一个
      }
    }
    this._ckMod = null
    return null
  }

  async upload(fileBuffer, fileName, opts = {}) {
    const cookie = await this.resolveCookie()
    if (!cookie) throw new Error('米游社 Cookie 未配置，请在 config/miyoushe.yaml 填写固定 Cookie 或设置 cookieMode: auto')

    const fi = await getFileInfo(fileBuffer, fileName || 'image.png')
    if (!Buffer.isBuffer(fi.buffer)) throw new Error('米游社上传失败: 文件数据为空')

    const ext = (fi.ext || '').toLowerCase()
    if (!IMG_EXT.includes(ext)) {
      throw new Error(`米游社上传失败: 不支持的文件类型 .${ext || '未知'} (仅支持图片 ${IMG_EXT.join('/')})`)
    }

    // 1. 获取 OSS 直传凭证 (policy / signature / host / callback)
    const paramsResp = await fetch(`${API_BASE}${GET_PARAMS}`, {
      method: 'POST',
      headers: {
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Content-Type': 'application/json',
        Cookie: cookie,
        Host: 'api-takumi.miyoushe.com',
        Origin: 'https://dby.miyoushe.com',
        Referer: 'https://dby.miyoushe.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        md5: fi.md5,
        ext,
        biz: 'community',
        extra: '{"upload_source":"villa_chat"}',
        support_content_type: true,
        support_extra_form_data: true,
      }),
      signal: AbortSignal.timeout(30000),
    })

    const paramsText = await paramsResp.text()
    let paramsData
    try {
      paramsData = JSON.parse(paramsText)
    } catch {
      throw new Error(`米游社获取上传参数失败: 返回非 JSON (${paramsResp.status}) ${paramsText.slice(0, 200)}`)
    }
    if (paramsData.retcode !== 0) {
      const msg = paramsData.message || ''
      // 米游社/米哈游接口 Cookie 失效通常表现为 retcode=-100 或 message 含登录相关字样
      const loginExpired = paramsData.retcode === -100 || /登录|login|未登录|失效|过期|token|expire/i.test(msg)
      if (loginExpired) {
        throw new Error(`米游社 Cookie 已失效/过期 (retcode=${paramsData.retcode})，请更新米游社登录 Cookie 后重试`)
      }
      throw new Error(`米游社获取上传参数失败: retcode=${paramsData.retcode} ${msg}`)
    }

    const p = paramsData.data
    const o = p?.oss
    if (!o?.host || !p.file_name) {
      throw new Error(`米游社获取上传参数失败: 返回缺少 OSS 信息 (${paramsText.slice(0, 200)})`)
    }

    // 2. 直传阿里云 OSS (multipart/form-data)
    // 解析 policy，收集所有 "eq" 条件要求的表单字段（如 x-oss-forbid-overwrite 等），
    // 避免 Policy Condition failed 导致 403 AccessDenied。
    const requiredFields = {} // field -> value(字符串)
    try {
      const policyJson = JSON.parse(Buffer.from(o.policy, 'base64').toString('utf8'))
      const conditions = Array.isArray(policyJson.conditions) ? policyJson.conditions : []
      for (const cond of conditions) {
        if (Array.isArray(cond) && cond[0] === 'eq' && typeof cond[1] === 'string' && cond.length >= 3) {
          const field = cond[1].startsWith('$') ? cond[1].slice(1) : cond[1]
          requiredFields[field] = String(cond[2])
        }
      }
    } catch (e) {
      logger.error(`米游社解析 OSS policy 失败: ${e?.message || e}; policy原文前200=${(o.policy || '').slice(0, 200)}`)
    }

    // 基础文本字段（与米游社/阿里云 OSS PostObject 规范一致）
    const textFields = {
      name: p.file_name.split('/').pop(),
      key: p.file_name,
      callback: o.callback,
      success_action_status: '200',
      'x:extra': o.callback_var?.['x:extra'] || '',
      'x-oss-content-type': o.x_oss_content_type || '',
      OSSAccessKeyId: o.accessid,
      policy: o.policy,
      signature: o.signature,
      'x-oss-object-acl': o.object_acl || 'default',
    }
    // 将 policy 要求的额外字段合并进来（已显式设置的不会被覆盖）
    for (const [k, v] of Object.entries(requiredFields)) {
      if (!(k in textFields)) textFields[k] = v
    }

    // 手动构造 multipart/form-data 字节流（绕开 undici FormData 序列化，
    // 确保 x-oss-* 等字段被 OSS 正确识别）
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex')
    const chunks = []
    for (const [k, v] of Object.entries(textFields)) {
      chunks.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${k}"\r\n\r\n` +
        String(v) + '\r\n',
        'utf8'
      ))
    }
    // 文件字段
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fi.name}"\r\n` +
        `Content-Type: ${fi.type || 'image/png'}\r\n\r\n`,
      'utf8'
    ))
    chunks.push(fi.buffer)
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
    const body = Buffer.concat(chunks)

    const uploadText = await this._putOssMultipart(o.host, body, boundary)

    let uploadData
    try {
      uploadData = JSON.parse(uploadText)
    } catch {
      throw new Error(`米游社直传 OSS 失败: 返回非 JSON ${uploadText.slice(0, 200)}`)
    }

    const url = uploadData?.data?.url
    if (!url) throw new Error(`米游社直传 OSS 失败: 无图片地址 (${uploadText.slice(0, 200)})`)

    return url
  }

  // 用原生 https 提交 OSS multipart 表单（绕过 undici FormData，确保字段被 OSS 正确解析）
  _putOssMultipart(host, body, boundary) {
    return new Promise((resolve, reject) => {
      const u = new URL(host)
      const req = https.request(
        {
          protocol: u.protocol,
          host: u.host,
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            if (res.statusCode !== 200 && res.statusCode !== 204) {
              return reject(new Error(`(HTTP ${res.statusCode}) ${data}`))
            }
            resolve(data)
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(30000, () => req.destroy(new Error('米游社 OSS 直传超时')))
      req.write(body)
      req.end()
    })
  }
}
