/**
 * ImageBed-Plugin Web 设置页面 - 后端 API
 *
 * 提供 GET/POST /imagebed-config  接口读取/保存图床配置与全局设置
 */

import fs from "node:fs"
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
    name: "Nature",
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
        return {
          key,
          name: meta.name,
          enabled: cfg.enabled !== false,
          fields: cfg,
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
        // 保存图床配置（保留注释）
        updateYaml(path.join(configDir, `${key}.yaml`), fields)
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
}
