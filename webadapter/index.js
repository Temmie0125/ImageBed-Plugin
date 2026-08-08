/**
 * ImageBed-Plugin Web 设置页面 - 后端 API
 *
 * 提供 GET/POST /imagebed-config  接口读取/保存图床配置与全局设置
 */

import fs from "node:fs"
import zlib from "node:zlib"
import path from "node:path"
import yaml from "yaml"

// ==================== 配置读写 ====================

function loadYaml(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return yaml.parse(fs.readFileSync(filePath, "utf8")) || {}
    }
  } catch {}
  return {}
}

/**
 * 原地更新 YAML 文件，保留原有注释
 * - 标量值 (string/number/boolean)：直接修改节点值，注释不丢
 * - 新键或复杂值 (map/seq)：使用 doc.set() 添加/替换
 */
function updateYaml(filePath, updates) {
  let doc
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8")
    doc = yaml.parseDocument(raw)
  } else {
    doc = new yaml.Document()
  }

  for (const [key, value] of Object.entries(updates)) {
    const node = doc.get(key, true)
    if (node instanceof yaml.Scalar) {
      // 标量节点原地改值，保留下行/同行注释
      node.value = value
    } else {
      doc.set(key, value)
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, doc.toString(), "utf8")
}

// ==================== 敏感字段遮蔽 ====================

const MASKED = "••••••••"

function maskSecret(val) {
  return (val && String(val).trim()) ? MASKED : ""
}

function isMasked(val) {
  return String(val) === MASKED
}

// ==================== 图床字段元数据 ====================

const HOSTING_META = {
  kurobbs: {
    name: "库街区",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "token", type: "text", label: "Token", placeholder: "库街区登录Token", secret: true, desc: "库街区网页端登录后获取的 access_token" },
    ],
  },
  txc: {
    name: "兔小巢",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "upload_node", type: "text", label: "上传节点", desc: "兔小巢图片上传接口地址" },
      { key: "cookie", type: "text", label: "Cookie", secret: true, desc: "兔小巢登录后的 Cookie，用于鉴权上传" },
    ],
  },
  qzone: {
    name: "QQ空间",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "bot_uin", type: "text", label: "Bot QQ号", placeholder: "留空自动选择", desc: "上传到哪个 QQ 号的空间相册，留空则自动选择可用的 Bot" },
    ],
  },
  homework: {
    name: "QQ群作业",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "bot_uin", type: "text", label: "Bot QQ号", placeholder: "留空自动选择", desc: "使用哪个 QQ 号上传，留空则自动选择可用的 Bot" },
    ],
  },
  cnb: {
    name: "CNB",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "baseUrl", type: "text", label: "API 地址", placeholder: "https://api.cnb.cool", desc: "CNB 开放 API 的基础地址" },
      { key: "token", type: "text", label: "Token", secret: true, desc: "CNB 个人访问令牌，在个人设置中生成" },
      { key: "defaultRepo", type: "text", label: "默认仓库", placeholder: "用户名/仓库名", desc: "默认上传到的仓库，格式为 用户名/仓库名" },
      { key: "autodelete", type: "number", label: "自动删除(秒)", desc: "上传多少秒后自动删除文件，设为 0 则不自动删除" },
      { key: "recordurl", type: "bool", label: "记录 URL 缓存", desc: "将已上传成功的文件 URL 缓存下来，避免重复上传相同文件" },
      { key: "cache_expire_days", type: "number", label: "缓存过期天数", desc: "URL 缓存的有效天数，过期后重新上传" },
    ],
  },
  nature: {
    name: "王者图床",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选（无需额外配置）" },
    ],
  },
  chatglm: {
    name: "ChatGLM",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选（无需额外配置）" },
    ],
  },
  ukaka: {
    name: "Ukaka",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选（无需额外配置）" },
    ],
  },
  xingye: {
    name: "星野",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选（无需额外配置）" },
    ],
  },
  cos: {
    name: "COS",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "region", type: "text", label: "地域", placeholder: "ap-guangzhou", desc: "COS 存储桶所在地域，如 ap-guangzhou、ap-shanghai 等" },
      { key: "secret_id", type: "text", label: "SecretId", secret: true, desc: "腾讯云 API 密钥 SecretId，在访问管理控制台获取" },
      { key: "secret_key", type: "text", label: "SecretKey", secret: true, desc: "腾讯云 API 密钥 SecretKey，与 SecretId 配对使用" },
      { key: "bucket_name", type: "text", label: "存储桶名称", desc: "COS 存储桶名称，格式为 BucketName-APPID" },
      { key: "domain", type: "text", label: "自定义域名", desc: "自定义 CDN 加速域名，留空则使用 COS 默认访问域名" },
      { key: "upload_path_prefix", type: "text", label: "上传路径前缀", desc: "上传到存储桶中的目录前缀，如 images/，留空则上传到根目录" },
      { key: "max_file_size", type: "number", label: "最大文件大小(字节)", desc: "允许上传的最大文件大小（字节），设为 0 则不限制" },
      { key: "internal", type: "bool", label: "内网模式", desc: "服务器与 COS 同地域内网时开启，使用 HTTP 内网域名省去 TLS 开销" },
      { key: "chunk_parallel", type: "number", label: "分片并发数", desc: "内网分片上传并发数，内网带宽充足可调大(如 5~10)" },
      { key: "autodelete", type: "number", label: "自动删除(秒)", desc: "不记录 URL 时，上传后多少秒自动删除对象，0 表示不删除" },
      { key: "recordurl", type: "bool", label: "记录URL缓存", desc: "将 URL 记录到 Redis，相同文件命中缓存时跳过重复上传" },
      { key: "cache_expire_days", type: "number", label: "缓存过期天数", desc: "缓存超过该天数未使用则清理远端对象与缓存记录" },
    ],
  },
  bilibili: {
    name: "B站",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "csrf_token", type: "text", label: "csrf_token", secret: true, desc: "B站登录后 Cookie 中的 bili_jct 字段值" },
      { key: "sessdata", type: "text", label: "SESSDATA", secret: true, desc: "B站登录后 Cookie 中的 SESSDATA 字段值" },
      { key: "bucket", type: "text", label: "上传分区", placeholder: "openplatform", desc: "B站图床上传分区标识，默认 openplatform" },
    ],
  },
  qq_channel: {
    name: "QQ频道",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "bot_qq", type: "text", label: "Bot QQ号", placeholder: "留空自动选择", desc: "用于上传的 Bot QQ 号，留空则自动选择可用 Bot" },
      { key: "channel_id", type: "text", label: "频道ID", desc: "上传图片的目标 QQ 频道 ID" },
    ],
  },
  qqbot: {
    name: "QQBot分片上传",
    fields: [
      { key: "enabled", type: "bool", label: "启用", desc: "开启后该图床将在上传时被候选" },
      { key: "bot_qq", type: "text", label: "Bot QQ号", desc: "用于分片上传的 Bot QQ 号" },
      { key: "target_type", type: "select", label: "目标类型", options: ["group", "user"], desc: "上传目标类型，group 表示群聊，user 表示私聊" },
      { key: "target_openid", type: "text", label: "目标 OpenID", desc: "上传目标群或用户的 OpenID，用于接收分片文件" },
      { key: "file_type", type: "select", label: "文件类型", options: ["auto", "image", "video", "voice"], desc: "分片上传的文件类型，auto 表示自动识别" },
      { key: "internal", type: "bool", label: "内网上传", desc: "开启后将加速域名替换为广州地域域名提速(服务器需在广州地域)，Host 保留原加速域名通过预签名校验" },
      { key: "chunk_parallel", type: "number", label: "分片并发数", desc: "分片上传并发连接数，内网可调大提速，公网酌情调小避免被限速 (默认 5)" },
    ],
  },
}

// ==================== 导出入口 ====================

export function init(ctx) {
  const configDir = path.join(ctx.pluginDir, "config")

  ctx.registerPage({
    id: "imagebed-setting",
    title: "图床设置",
    icon: "🖼",
    src: "setting.html",
  })

  /**
   * GET /imagebed-config — 读取所有图床配置 + 全局设置
   */
  ctx.registerApi("get", "/imagebed-config", (_req, res) => {
    try {
      const settings = loadYaml(path.join(configDir, "settings.yaml"))
      const hostings = Object.entries(HOSTING_META).map(([key, meta]) => {
        const cfg = loadYaml(path.join(configDir, `${key}.yaml`))
        // 遮蔽敏感字段，防止 token/secret 等通过 API 泄露
        const fields = {}
        for (const fi of meta.fields) {
          const raw = cfg[fi.key] ?? ""
          fields[fi.key] = fi.secret ? maskSecret(raw) : raw
        }
        return {
          key,
          name: meta.name,
          enabled: cfg.enabled !== false,
          fields,
        }
      })

      res.json({ ok: true, settings, hostings, meta: HOSTING_META })
    } catch (e) {
      res.json({ ok: false, error: e.message })
    }
  })

  /**
   * POST /imagebed-config — 保存图床配置或全局设置
   * body: { type: "hosting", key: "cnb", fields: {...} }
   * body: { type: "settings", settings: {...} }
   */
  ctx.registerApi("post", "/imagebed-config", (req, res) => {
    try {
      const { type, key, fields, settings } = req.body || {}

      if (type === "settings") {
        // 保存全局设置（保留注释）
        updateYaml(path.join(configDir, "settings.yaml"), settings)
        // 同步到内存
        if (Bot._hostingCfg) Object.assign(Bot._hostingCfg, settings)
        if (Bot._hostingSettings) Object.assign(Bot._hostingSettings, settings)
        return res.json({ ok: true })
      }

      if (type === "hosting" && key && HOSTING_META[key]) {
        // 过滤掉未修改的敏感字段（值为遮蔽占位符），防止掩码值覆盖真实密钥
        const cleaned = { ...fields }
        const meta = HOSTING_META[key]
        for (const fi of meta.fields) {
          if (fi.secret && isMasked(cleaned[fi.key])) {
            delete cleaned[fi.key]
          }
        }
        // 保存图床配置（保留注释）
        updateYaml(path.join(configDir, `${key}.yaml`), cleaned)
        // 清除实例缓存，下次访问 config 时自动重新加载
        const inst = Bot.getHosting?.(key)
        if (inst) inst._config = undefined
        return res.json({ ok: true })
      }

      res.json({ ok: false, error: "无效的请求" })
    } catch (e) {
      res.json({ ok: false, error: e.message })
    }
  })

  /**
   * 测试任务内存存储 (进程内)，避免长连接被反向代理超时切断
   * taskId -> { status, size, total, done, results, error }
   */
  const testTasks = new Map()
  const genTaskId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

  /**
   * POST /imagebed-test — 网页端测试图床：立即返回 taskId，后台异步执行上传测试
   * body: { size_mb: 5, hosting: "all" | "cos" | "cnb" | ..., auto_delete: 0 }
   */
  ctx.registerApi("post", "/imagebed-test", async (req, res) => {
    let sizeMb = Number(req.body?.size_mb) || 5
    sizeMb = Math.min(Math.max(sizeMb, 1), 50)
    const hostingKey = typeof req.body?.hosting === 'string' ? req.body.hosting : 'all'
    let autoDelete = Number(req.body?.auto_delete)
    autoDelete = Number.isFinite(autoDelete) && autoDelete > 0 ? Math.floor(autoDelete) : 0

    let hostings = (Bot._hostings || []).filter(h => h.enabled)
    if (hostingKey && hostingKey !== 'all') {
      hostings = hostings.filter(h => h.configKey === hostingKey)
    }
    if (hostings.length === 0) {
      return res.json({ ok: false, error: "没有已开启的图床" })
    }

    const taskId = genTaskId()
    const task = {
      status: "running",
      size: 0,
      total: hostings.length,
      done: 0,
      results: [],
      error: null,
    }
    testTasks.set(taskId, task)

    // 后台异步执行，立即返回 taskId
    ;(async () => {
      try {
        const testBuf = generateTestPng(sizeMb)
        task.size = testBuf.length
        // 串行上传 (避免并发占用带宽影响测速准确性)
        for (const h of hostings) {
          const start = Date.now()
          const r = { name: h.name, key: h.configKey, size: testBuf.length }
          try {
            const opts = autoDelete > 0 ? { autoDelete } : {}
            r.url = await h.uploadWithStats(testBuf, `test_${sizeMb}mb.png`, opts)
            r.cost = Date.now() - start
            r.success = true
          } catch (e) {
            r.cost = Date.now() - start
            r.success = false
            r.error = e.message?.slice(0, 200) || "未知错误"
          }
          task.results.push(r)
          task.done++
        }
        task.results.sort((a, b) => (b.success - a.success) || (a.cost - b.cost))
        task.status = "done"
      } catch (e) {
        task.status = "error"
        task.error = e.message
      }
      // 1 小时后自动清理
      setTimeout(() => testTasks.delete(taskId), 3600 * 1000)
    })().catch(() => {})

    res.json({ ok: true, taskId })
  })

  /**
   * GET /imagebed-test-status?task=xxx — 轮询测试任务进度与结果
   */
  ctx.registerApi("get", "/imagebed-test-status", (req, res) => {
    const taskId = req.query?.task
    const task = taskId && testTasks.get(taskId)
    if (!task) return res.json({ ok: false, error: "任务不存在或已过期" })
    res.json({
      ok: true,
      status: task.status,
      size: task.size,
      total: task.total,
      done: task.done,
      results: task.status === "done" ? task.results : [],
      error: task.error,
    })
  })
}

// ==================== 测试图片生成 ====================

/** 生成精确约 sizeMb MB 的测试 PNG（纯 Node，无需 canvas）。
 *  先估算像素生成基础图，再用 level:0 (不压缩) 让 raw 体积≈PNG 体积，循环逼近目标体积 */
function generateTestPng(sizeMb = 5) {
  const targetBytes = Math.floor(sizeMb * 1024 * 1024)
  // 固定边宽，避免单行过大；高度按需调整使体积逼近目标
  const w = 2000
  // 估算初始高度：每像素 3 字节 + 每行 1 字节过滤头 + 头部约 60 字节
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
    // level:0 不压缩，raw 体积≈deflate 后体积，便于精确控制
    const deflated = zlib.deflateSync(raw, { level: 0 })
    return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflated), chunk("IEND", Buffer.alloc(0))])
  }

  let buf = build(h)
  // 逼近：不足则加行，超出则减行（每次按缺口估算行数）
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
