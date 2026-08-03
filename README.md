# ImageBed-Plugin

Yunzai Bot 统一图床插件 —— 为机器人提供多图床优先级链式的图片/文件上传服务，支持自动 fallback、统计记录与 Web 可视化管理。

## 功能特性

- **多图床优先级链**：按配置的优先级顺序依次尝试上报，失败自动切换下一个
- **统一 API**：注入 `Bot.imageToUrl(file, opts)`，一行调用即可将图片上行至图床并返回直链
- **自动 Fallback**：所有图床均失败时回退到 `Bot.fileToUrl`（本地临时存储）
- **Redis 统计**：记录每次上传的成功/失败、耗时、文件大小等数据
- **Web 管理面板**：可视化界面管理所有图床配置与全局设置
- **自动配置补全**：新增图床自动追加到优先级末尾，缺失字段自动补写
- **Cookie 自动获取**：QQ 空间 / QQ 群作业图床无需手动填写 Cookie

## 支持图床（13个）

| 图床 | configKey | 类型 | 需要配置 |
|------|-----------|------|----------|
| CNB | `cnb` | 对象存储 | token + 仓库 |
| 库街区 | `kurobbs` | 论坛图床 | token |
| Nature | `nature` | COS 直传 | 无（内置密钥） |
| QQBot 分片上传 | `qqbot` | 官方机器人 | bot_qq + target_openid |
| QQ 空间 | `qzone` | QQ 空间相册 | 无（Cookie 自动获取） |
| QQ 群作业 | `homework` | QQ 群作业 | 无（Cookie 自动获取） |
| ChatGLM | `chatglm` | 免费图床 | 无 |
| Ukaka | `ukaka` | 免费图床 | 无 |
| 星野 | `xingye` | 免费图床 | 无 |
| 腾讯云 COS | `cos` | 对象存储 | SecretId/Key + 桶 |
| B 站 | `bilibili` | 图床 | Cookie |
| QQ 频道 | `qq_channel` | QQ 频道 | bot_qq + channel_id |
| 兔小巢 | `txc` | 兔小巢 | cookie |

## 快速开始

### 安装

在Yunzai根目录执行以下指令拉取插件：

```bash
git clone https://gitee.com/wind-trace-typ/ImageBed-Plugin.git ./plugins/ImageBed-Plugin
```

然后在执行以下指令安装依赖：

```bash
pnpm i
```

### 配置

首次启动后会在 `plugins/ImageBed-Plugin/config/` 下生成各图床的 `.yaml` 配置文件，按需填入对应凭证。

全局设置位于 `config/settings.yaml`：

```yaml
# 上传优先级（越靠前越优先，缺失的图床启动时自动补到末尾）
priority:
  - cnb
  - kurobbs
  - nature

# 统计数据
stats:
  enabled: true       # 是否启用 Redis 上传统计
  max_days: 30        # 数据保留天数

# 功能开关
apps:
  test: true          # 是否启用 #测试图床 命令
  stats: true         # 是否启用 #图床状态 等命令
```

### 代码调用

插件自动向 `Bot` 注入 `imageToUrl` 方法，其他插件可直接调用：

```js
// 上传图片 Buffer
const url = await Bot.imageToUrl(imageBuffer, { imagebed: 'cnb' })

// 不指定图床则按优先级自动选择
const url = await Bot.imageToUrl(imageBuffer)
```

若是使用此版本[🔗QQBot-Plugin](https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin)qqbot适配器，适配器会自动调用此图床插件转换图片url做markdown图片

## 命令一览

> 所有命令仅限 **master** 权限用户，且受 `apps.test` / `apps.stats` 开关控制。

| 命令 | 功能 |
|------|------|
| `#测试图床` | 生成随机 PNG 测试文件，对所有已启用图床进行逐一上传测试 |
| `#图床` | 使用消息附带或引用的图片进行上传测试 |
| `#图床状态` | 查看所有已启用图床近 1 天的统计数据 |
| `#图床状态 cnb` | 查看指定图床近 1 天的详细统计 |
| `#图床状态7天` | 查看近 7 天的统计数据 |
| `#图床状态30天` | 查看近 30 天的统计数据 |
| `#图床失败原因` | 查看近 1 天所有图床的失败原因汇总（Top 15） |
| `#图床失败原因 cnb` | 查看指定图床的失败原因 |
| `#图床失败原因30天` | 查看近 30 天的失败原因 |
| `#清空CNB图床` | 一键清空 CNB 仓库的所有远端资源 + 本地缓存 |

## Web 管理面板

- 当前可以配合[🔗qqbot-web-adapter插件](https://gitee.com/wind-trace-typ/QQBot-Web-Adapter)直接在网页端快捷设置，具体参考下图：
![alt text](./webadapter/webadapter.png)

## CNB 特殊功能

- **URL 缓存去重**：基于文件 MD5 缓存，相同文件跳过重复上传
- **自动删除**：支持上传后 N 秒自动删除远端文件（`autodelete` 配置项）
- **定时清理**：每 3 小时自动清理过期缓存条目
- **一键清空**：`#清空CNB图床` 批量删除所有远端资源

## QQBot 分片上传

- 支持 `image` / `video` / `voice` 三种文件类型
- 最大支持 **200MB** 文件
- 使用官方 QQ 机器人 SDK 分片上传流程
- 需配置 `bot_qq`、`target_type`（group/user）、`target_openid`、`file_type`（auto/image/video/voice）

## 依赖

| 依赖 | 用途 |
|------|------|
| `cos-nodejs-sdk-v5` | 腾讯云 COS SDK |
| `file-type` | 检测文件 MIME 类型 |
| `image-size` | 获取图片尺寸（COS 图床用） |
| `node-schedule` | CNB 缓存定时清理（可选） |

## 目录结构

```
ImageBed-Plugin/
├── index.js                 # 插件入口
├── apps/
│   ├── stats.js             # 状态 / 失败原因查询
│   └── testHosting.js       # 图床测试
├── config/                  # 各图床配置文件 (YAML)
├── lib/
│   ├── base.js              # 基类 / 工具 / 配置加载 / 统计
│   └── *.js                 # 各图床实现
└── webadapter/
    ├── index.js             # Web 管理后台 API
    └── setting.html         # Web 管理面板前端
```

## 问题反馈

- [🔗内部交流群 1095352740](https://qm.qq.com/q/JxYAlbKRGy)反馈
- 邮箱459521475@qq.com反馈
- 直接提issue反馈(可能不会及时看到)