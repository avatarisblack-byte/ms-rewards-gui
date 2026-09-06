<div align="center">

# 微软奖励脚本（GUI 版）

[![Version](https://img.shields.io/badge/version-3.1.6.4-blue.svg)](./package.json)
[![GUI](https://img.shields.io/badge/GUI-v2.1.0-green.svg)](./gui/design-reference.html)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-green.svg)](./package.json)
[![Upstream](https://img.shields.io/badge/上游-TheNetsky/Microsoft--Rewards--Script-informational.svg)](https://github.com/TheNetsky/Microsoft-Rewards-Script)

**基于 TypeScript · Playwright · Cheerio 的微软奖励自动化脚本 + 浏览器可视化管理面板（GUI）**

本项目 fork 自 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)，在原脚本的基础上**新增 `gui/` 控制面板**——不用碰 JSON 和命令行，在浏览器里点一点即可完成账号管理、配置调整、统计查看与任务启停。

针对国内用户深度本地化：✅ 中国热搜查询源（百度/头条/抖音/微博/知乎） · ✅ 日志中文化 · ✅ PushPlus 微信推送

</div>

> ℹ️ **分支选择建议**
>
> - **`main` 分支（稳定版，推荐）**：已兼容微软新版 UI，实测未发现明显异常，可放心日常使用。
> - **`V4-china` 分支（尝鲜版）**：架构升级仍在推进中，功能尚未完善，**暂不推荐切换**。如非必要，请继续留在 `main` 分支，待 V4 稳定后再迁移。
>
> 两分支配置文件结构不同，**互不兼容**。

---

## 📑 目录

- [🖥 GUI 控制面板（本仓库新增）](#-gui-控制面板本仓库新增)
  - [快速开始](#1-快速开始)
  - [四大面板功能总览](#2-四大面板功能总览)
  - [安全设计](#3-安全设计)
  - [测试与质量](#4-测试与质量)
- [🤖 自动化脚本（上游核心）](#-自动化脚本上游核心)
- [🚀 脚本部署](#-脚本部署)
  - [Windows 部署](#-windows-部署)
  - [Docker 部署](#-docker-部署)
- [⚙️ 配置参考](#️-配置参考)
- [🔔 通知渠道](#-通知渠道)
- [📚 文档索引](#-文档索引)
- [❓ 常见问题](#-常见问题)
- [⚠️ 注意事项](#️-注意事项)
- [📜 同步与致谢](#-同步与致谢)
- [⚠️ 免责声明](#️-免责声明)

---

## 🖥 GUI 控制面板（本仓库新增）

> 本仓库相对于上游的最大增量：`gui/` 目录下的零依赖 Web 控制台。
> 详细操作手册见 [`gui/README.md`](gui/README.md)，本节为快速上手与安全设计摘要。

### 1. 快速开始

```bat
1. 安装环境：双击 setup.bat（安装依赖 + 构建脚本 + 安装浏览器；GUI 本身零依赖，仅用 Node 内置模块）
2. 启动面板：双击 gui/start-gui.bat
   （或双击 gui/start-gui-silent.vbs 静默后台启动，无 CMD 窗口，日常推荐）
3. 浏览器自动打开 http://localhost:3000，开始管理账号 / 配置 / 任务
```

- **停止服务**：面板右上角「关闭服务」，或双击 `gui/stop-gui.bat`（按端口精准停止，不误杀其他 Node 脚本）
- **更换端口**：「全局设置 → GUI 本地端口」（1024-65535，即改即存，重启后生效；端口存于 `gui/gui-settings.json`，与脚本核心 `config.json` 隔离）
- **页面即生命周期**：SSE 长连接保活——**刷新页面不掉服务**（断开后 5s 静默期优雅降级），真正关闭页面且超时后服务自动退出
- **首次引导**：首次打开自动弹出「环境安装」提示，勾选"不再提示"后不再打扰

### 2. 四大面板功能总览

| 面板 | 能力 |
|------|------|
| 📊 **仪表盘总览** | 账户总数、今日/累计收益（日志口径）、任务启停、最近 100 行实时任务日志（智能滚动）、账户卡片状态 Tag + 收益条、一键导出/导入全部本地数据 |
| 👤 **账号管理** | 账号增删改查（邮箱/密码/2FA 密钥/恢复邮箱）、独立代理、`geoLocale`/`langCode`/指纹设置、Session 登录会话 zip 导入导出（`session_*.json` 白名单） |
| 📈 **数据统计** | 历史总收益/今日收益/累计活跃天数、Chart.js 每日积分堆叠柱状图（零收益账号自动隐藏、平滑过渡动画）、账号累计收益排行 |
| ⚙️ **全局设置** | 无头模式、任务开关、搜索行为、中国区 API Key 等**即改即存**（checkbox 立即提交、文本 500ms 防抖 + Toast 提示）；高风险字段锁定只读；「打开配置文件」/「重置默认」 |

**其他**：日志查看/按日期解析/zip 导入导出、任务子进程启停（`spawn node dist/index.js`，SIGTERM→10s SIGKILL 兜底）、数据统计缓存（30s 轮询零全量扫描）。

### 3. 安全设计

| 机制 | 说明 |
|------|------|
| 🔐 **本地 Token 鉴权** | 服务每次启动生成 256 位随机令牌；所有 `/api/*` 请求必须携带 `X-Auth-Token`（SSE 保活走 `?token=` 查询参数），否则返回 401 |
| 🚫 **CORS 收紧** | 已移除 `Access-Control-Allow-Origin: *`——跨站网页既读不到令牌接口的响应，也调不动任何接口 |
| 🙈 **凭据脱敏** | `GET /api/accounts` 对 `password`/`totpSecret` 返回 `******`；编辑其他字段时回传的占位符自动视为"未修改"，不会覆盖真实凭据 |
| 🔒 **配置写互斥锁** | `PUT /api/config` 加写锁，写入期间并发请求返回 409「系统正忙，请稍后重试」，杜绝多标签页"最后写入者胜"的静默覆盖 |
| 🚧 **单实例保护** | 项目根 `.gui.pid` 存活检测，检测到已有实例运行则友好提示退出，防止多开实例并发写坏配置文件 |
| 💾 **写操作备份回滚** | 账号/配置/导入等全部写操作先备份 `.bak`，写入失败自动回滚 |
| 🧱 **导入白名单 + 防穿越** | Session 只收 `session_*.json`、日志只收 `*.log`；双重相对路径检查防 zip slip |
| 🏠 **本机隔离** | 服务仅监听 `127.0.0.1`，数据不联网；请求体 100MB 上限 |

### 4. 测试与质量

- **自动化测试**：`node --test --test-isolation=none test/gui/*.test.js`（零依赖 `node:test` + tmp 沙箱隔离，仓库文件零改动）——**160 用例**，覆盖 25+ 个接口的正常/边界/异常输入、并发压力、XSS/zip slip/CRLF/脏数据崩溃、鉴权、写锁与生命周期
- **覆盖率**：后端行覆盖 70.9%、函数覆盖 88.7%（`NODE_V8_COVERAGE` + `test/gui/coverage-report.js`）
- **真机验证**：XSS 纯文本渲染、令牌链路、跨站窃取令牌被 CORS 拦截、单实例保护均经浏览器实测
- **人工测试平台**：GUI 的完整人工运行测试仅在 **Windows 平台**执行（macOS / Linux 未对 GUI 做完整人工验证，脚本本体跨平台可用）
- 详细报告见 [`gui/TEST_REPORT.md`](gui/TEST_REPORT.md)，变更历史见 [`gui/CHANGELOG.md`](gui/CHANGELOG.md)

---

## 🤖 自动化脚本（上游核心）

以下为 fork 自上游的自动化脚本能力（TypeScript v3.1.6.4）：

**账户管理**
- ✅ 多账户支持
- ✅ 会话存储与持久化
- ✅ 2FA 支持
- ✅ 无密码登录支持

**自动化与控制**
- ✅ 无头浏览器操作
- ✅ 集群支持（同时多个账户）
- ✅ 可配置任务选择
- ✅ 代理支持
- ✅ 自动调度（Docker）

**搜索与活动**
- ✅ 桌面与移动搜索（Microsoft Edge 模拟）
- ✅ 地理定位搜索查询
- ✅ 模拟滚动与链接点击
- ✅ 每日集 / 促销活动 / 打卡 / 每日签到 / 阅读赚取
- ✅ 连击保护 & 领取 dashboard 奖励积分（新版 UI 走 Server Action）

**搜索词来源（中国地区）**
- ✅ 中国热搜（百度/头条/抖音/微博/知乎，多源聚合 + 限流退避）
- ✅ Bing Suggestions / Related Terms 扩展（日志聚合输出）
- ✅ 本地查询词兜底（`search-queries.json`，392 个标准词）

**测验与互动内容**
- ✅ 测验解答（10 分与 30-40 分变体）
- ✅ 此或彼测验（随机答案）
- ✅ ABC 测验解答
- ✅ 投票完成
- ✅ 点击奖励

**通知与监控**
- ✅ Discord Webhook 集成
- ✅ ntfy 推送支持
- ✅ PushPlus 推送支持（国内微信推送）
- ✅ 全面日志记录（带日志过滤、本地文件持久化）
- ✅ Docker 支持与监控

---

## 🚀 脚本部署

> 💡 **有 GUI 面板后，Windows 用户的账号/配置通常直接在面板里操作即可**；`setup.bat` 装好环境后，日常只需双击 `gui/start-gui.bat`。
> 若偏好纯命令行 / 无 GUI 场景，按以下方式部署脚本本身。

本脚本支持两种部署方式，**按你的场景二选一即可**：

| 维度 | 📦 Windows 直跑 | 🐳 Docker |
|---|---|---|
| **配置方式** | 手动编辑 `accounts.json` + `config.json`（或直接用 GUI 面板） | `.env` + `compose.yaml` 环境变量 |
| **调度** | 手动 / 计划任务 | 内置 cron |
| **headless** | 可选（可见窗口） | 强制 `true`（无显示器） |
| **数据持久化** | `sessions/` 目录 | `./config/` + `./sessions/` 挂载 |
| **升级方式** | `git pull` + `npm run build` | `docker compose up -d --build` |
| **前置要求** | Node.js 24+ | Docker + Docker Compose |

### 📦 Windows 部署

> ⚠️ 本项目所有改动基于 Win11 系统测试，其他系统请参考[原项目](https://github.com/TheNetsky/Microsoft-Rewards-Script)相关配置。

<details>
<summary><b>🔧 自动设置（推荐，一键部署）</b></summary>

1. 下载或克隆源代码
2. Win 系统运行 `setup.bat` 部署环境（若 `setup.bat` 报错，请参考下方手动设置）
3. 在 `dist` 目录的 `accounts.json` 添加你的账户信息（或打开 GUI 面板在「账号管理」中添加）
4. 按照你的喜好修改 `dist` 目录的 `config.json` 文件（或打开 GUI 面板在「全局设置」中调整）
5. 运行 `npm start` 或运行 `run.bat` 启动构建好的脚本

</details>

<details>
<summary><b>🛠 手动设置（自动设置失败时使用）</b></summary>

1. 下载或克隆源代码
2. 下载安装 Node.js 24 和 npm 环境
3. 运行 `npm install` 安装依赖包
4. 若出现 `Error: browserType.launch: Executable doesn't exist` 报错，执行：

   ```bash
   npx patchright install chromium
   ```

5. 将 `accounts.example.json` 重命名为 `accounts.json`，并添加你的账户信息
6. 按照你的喜好修改 `config.json` 文件
7. 运行预构建脚本：

   ```bash
   npm run pre-build
   ```

8. 构建脚本：

   ```bash
   npm run build
   ```

9. 启动：

   ```bash
   npm start
   ```

</details>

### 🐳 Docker 部署

<details>
Docker 下账号和行为配置都通过环境变量传入，容器启动时由 `entrypoint.sh` 自动生成 `accounts.json` 和 `config.json`，**无需手动维护这两个文件**。

### 1. 准备账号文件（.env）

从模板复制并填写：

```bash
cp env.example .env
```

编辑 `.env`，至少填一个账号：

```dotenv
ACCOUNT_1_EMAIL=you@example.com
ACCOUNT_1_PASSWORD=your_password
# 国内账号推荐加：
ACCOUNT_1_GEO_LOCALE=cn
ACCOUNT_1_LANG_CODE=zh
```

> 多账号按 `ACCOUNT_2_*`、`ACCOUNT_3_*` 递增，编号必须连续。完整字段见 `env.example`。

### 2. 编辑 compose.yaml（可选）

默认配置开箱即用，如需调整取消对应行注释即可：

- `TZ`：时区（默认 `Asia/Shanghai`）
- `CRON_SCHEDULE`：调度（默认 `0 7 * * *`，每天 7 点）
- `RUN_ON_START`：容器启动时是否立即跑一次（默认 `true`）
- `CONFIG_QUERY_ENGINES`：查询源，国内推荐 `china,local`
- `CONFIG_CHINA_API_APPKEY`：gmya.net appkey，配合 china 查询源解除免费档限流（留空走免费档）
- `CONFIG_PUSHPLUS_*`：PushPlus 微信推送

> 完整的 `CONFIG_*` 环境变量列表见 `scripts/docker/entrypoint.sh` 顶部注释。

### 3. 关于 headless

无需手动设置。Docker 环境下 `headless` 被容器入口强制设为 `true`（容器内无显示器，无法开窗口模式）。

### 4. 构建并启动

```bash
docker compose up -d --build
```

> **重要**：改了代码或 Dockerfile 后，必须加 `--build` 参数重建镜像，否则跑的还是旧镜像。首次部署也建议带 `--build`。

### 5. 数据持久化

容器挂载了两个目录，重建容器不丢数据：

- `./config/`：配置和账号文件
- `./sessions/`：登录会话（首次登录后 cookie 存这里，后续自动复用）

### 常用命令

```bash
docker compose up -d --build   # 构建+启动
docker compose logs -f          # 查看日志
docker compose down             # 停止并删除容器
docker compose restart          # 重启（不重建）
```

</details>

---

## ⚙️ 配置参考

> 编辑 `src/config.json`（Windows，也可在 GUI「全局设置」面板可视化调整）或通过 `CONFIG_*` 环境变量（Docker）自定义行为。
> 下面按功能分组，**点击各 summary 展开详情**。

<details>
<summary><b>🔵 Core / 核心配置</b></summary>

| 设置 | 描述 | 默认值 |
|----------|-------------|----------|
| `baseURL` | Microsoft Rewards base URL | `https://rewards.bing.com` |
| `sessionPath` | 用于存储浏览器会话的文件夹 | `sessions` |
| `headless` | 在后台运行浏览器 | `false`（可见） |
| `clusters` | 并发账户实例数 | `1` |
| `errorDiagnostics` | 出错时自动截图诊断 | `true` |
| `debugLogs` | 输出 DEBUG 级别日志（也可用 `-dev` 启动参数临时开启） | `false` |

</details>

<details>
<summary><b>👆 Fingerprinting / 指纹识别</b></summary>

| 设置 | 描述 | 默认值 |
|---------|-------------|---------|
| `saveFingerprint.mobile` | 重用移动浏览器指纹 | `false` |
| `saveFingerprint.desktop` | 重用桌面浏览器指纹 | `false` |

</details>

<details>
<summary><b>🗂 Job State / 任务开关</b></summary>

| 设置 | 描述 | 默认值 |
|---------|-------------|---------|
| `workers.doDailySet` | 完成每日集活动 | `true` |
| `workers.doSpecialPromotions` | 完成特殊促销活动 | `true` |
| `workers.doMorePromotions` | 完成促销优惠 | `true` |
| `workers.doClaimBonusPoints` | 领取 dashboard 上的奖励积分（新版 UI 走 Server Action） | `true` |
| `workers.doPunchCards` | 完成打卡活动 | `true` |
| `workers.doAppPromotions` | 完成 App 端活动（ReadToEarn / DailyCheckIn 等） | `true` |
| `workers.doDesktopSearch` | 执行桌面搜索 | `true` |
| `workers.doMobileSearch` | 执行移动搜索 | `true` |
| `workers.doDailyCheckIn` | 完成每日签到 | `true` |
| `workers.doReadToEarn` | 完成阅读赚取活动 | `true` |
| `ensureStreakProtection` | 启用连击保护（账户级配置，新版 UI 走 Server Action） | `true` |

</details>

<details>
<summary><b>🔍 Search / 搜索配置</b></summary>

| 设置 | 描述 | 默认值 |
|---------|-------------|---------|
| `searchOnBingLocalQueries` | 使用本地查询 vs. 获取的查询 | `false` |
| `searchSettings.scrollRandomResults` | 随机滚动搜索结果 | `true` |
| `searchSettings.clickRandomResults` | 点击随机结果链接 | `true` |
| `searchSettings.parallelSearching` | 桌面端/移动端搜索并行执行（GUI 中强制锁定，不允许开启） | `false` |
| `searchSettings.queryEngines` | 查询源及顺序（数组），决定从哪些源获取搜索词 | `['china', 'local']` |
| `searchSettings.searchResultVisitTime` | 访问搜索结果页的停留时间 | `10sec` |
| `searchSettings.searchDelay` | 搜索之间的延迟（最小/最大） | `30sec - 1min` |
| `searchSettings.readDelay` | 阅读赚取活动的阅读间隔（最小/最大） | `30sec - 1min` |
| `searchSettings.chinaApi.appkey` | gmya.net appkey（填入解除免费档限流，留空走免费档） | `''`（空） |

> 📌 **注**：示例配置 `config.example.json` 里 `searchDelay` 为 `6-12min`、`readDelay` 为 `6-11min`、`searchResultVisitTime` 为 `20sec`，比 Validator 默认值更保守，适合长时间挂机场景。

</details>

<details>
<summary><b>🌐 queryEngines 查询源说明（含国内可用性）</b></summary>

`searchSettings.queryEngines` 决定从哪些源获取搜索词，按数组顺序尝试。可选值：

| 值 | 来源 | 国内可用性 |
|---|---|---|
| `china` | 中国热搜（gmya.net：百度/头条/抖音/微博/知乎） | ✅ 直连 |
| `local` | 本地查询词（`search-queries.json`，392 个标准词） | ✅ 离线 |
| `google` | Google Trends | ❌ 需代理（见 `proxy.queryEngine`） |
| `wikipedia` | 维基百科热门 | ❌ 需代理 |
| `reddit` | Reddit 热门帖 | ❌ 需代理 |

**国内推荐配置**：`["china", "local"]`（示例配置默认值），无需代理即可获取丰富搜索词。

#### 查询词来源（中国地区）

当 `queryEngines` 包含 `china` 时，搜索词从中国热搜获取：

- **数据源**：gmya.net 热门词 API（百度/头条/抖音/微博/知乎热搜榜）
- **策略**：随机打乱 5 个源，取前 N 个聚合去重（避免每个账号都用同一个源）。N 由是否配置 `chinaApi.appkey` 决定：有 appkey 取 2 个；免费档取 1 个。首选源全部失败时自动 fallback 到剩余源
- **限流处理**：免费档（无 appkey）对连续请求有频率限制，会触发 403。本脚本在源与源之间插入随机退避（1.2~2.5s），命中限流后指数退避 ×1.5，并将限流错误如实上报（不再误报为"格式异常"）。想彻底避免限流，在 `searchSettings.chinaApi.appkey` 填入 gmya.net appkey
- **扩展**：对每个热搜词调用 Bing Suggestions/Related Terms 扩展查询多样性（命中率取决于词的特性 —— 短词高、长句低），扩展进度采样输出，结尾输出"热搜词使用清单"（INFO 级别）
- **本地兜底**：`src/functions/search-queries.json` 提供 392 个标准查询词作为补充

</details>

<details>
<summary><b>⚙️ 高级设置（超时 / 代理 / 日志过滤）</b></summary>

| 设置 | 描述 | 默认值 |
|---------|-------------|---------|
| `globalTimeout` | 操作超时持续时间 | `30sec` |
| `proxy.queryEngine` | 代理查询引擎请求（google/wikipedia/reddit 等需翻墙的源；china 源走 gmya.net 国内直连，无需开） | `false` |
| `consoleLogFilter` | 控制台日志过滤（按级别/关键词/正则 白名单或黑名单） | 见下方说明 |
| `webhook.webhookLogFilter` | Webhook 推送日志过滤（结构同 consoleLogFilter） | 见下方说明 |

#### 日志过滤结构（consoleLogFilter / webhookLogFilter）

两个字段结构相同，用于过滤输出到控制台 / webhook 的日志：

```json
{
    "enabled": false,
    "mode": "whitelist",
    "levels": ["error", "warn"],
    "keywords": ["starting account"],
    "regexPatterns": []
}
```

- `mode`：`whitelist`（只输出匹配的）或 `blacklist`（排除匹配的）
- `levels`：日志级别筛选（`debug`/`info`/`warn`/`error`）
- `keywords`：日志消息包含这些关键词则命中
- `regexPatterns`：正则匹配

</details>

<details>
<summary><b>🆕 新版 UI 兼容性（Server Action）</b></summary>

微软新版 dashboard（modern UI）改用 Next.js App Router，部分功能不再有对外 REST API，旧版 API（`togglestreakasync`、`claimallpointsasync`）在新版 UI 下因取不到 `requestToken` 会返回 `400 Bad Request`。

| 功能 | 调用方式 | 认证 |
|---|---|---|
| 连击保护 toggle | `POST /dashboard` + `next-action` hash + body `[true]` | Cookie |
| 领取积分 | `POST /dashboard` + `next-action` hash + body `[]` | Cookie |

**版本守卫机制**：`next-action` hash 在编译时生成、绑定到具体部署版本（`dpl`）。脚本启动时从 dashboard HTML 提取当前部署 ID，与脚本内置的支持版本（`20260612-3`）比对：

- ✅ **匹配** → 走 Server Action（新版 UI）
- ⚠️ **不匹配** → 微软可能更新了 dashboard，内置 hash 可能失效，相关功能**自动降级跳过**（不会 400，不影响其他任务）
- 旧版 UI（legacy）→ 仍走原 REST API（需要 `requestToken`）

如果降级跳过频繁出现，说明微软更新了部署，需要重新更新 hash。

</details>

---

## 🔔 通知渠道

本项目支持三种推送渠道（均在 `webhook` 对象下，**可同时开启多个**）：

| 设置 | 描述 | 默认值 |
|---------|-------------|---------|
| `webhook.discord.enabled` | 启用 Discord 推送 | `false` |
| `webhook.discord.url` | Discord webhook URL | `""` |
| `webhook.ntfy.enabled` | 启用 ntfy 推送 | `false` |
| `webhook.ntfy.url` | ntfy 服务器 URL | `""` |
| `webhook.ntfy.topic` | ntfy 主题 | `""` |
| `webhook.ntfy.token` | ntfy 认证 token | `""` |
| `webhook.ntfy.priority` | ntfy 优先级（1-5） | `3` |
| `webhook.pushplus.enabled` | 启用 PushPlus 推送（国内） | `false` |
| `webhook.pushplus.token` | PushPlus token | `""` |
| `webhook.pushplus.template` | PushPlus 模板（`txt`/`html`/`markdown`） | `txt` |

> 💡 **国内推荐**：**PushPlus**（微信推送，无需翻墙）。Discord / ntfy 需要能访问对应服务。

---

## 📚 文档索引

| 文档 | 内容 |
|------|------|
| [`gui/README.md`](gui/README.md) | **GUI 控制面板完整手册**：快速开始、四大面板操作指南、安全策略、前端动效规范、接口速查、FAQ |
| [`doc/CODE_MAP.md`](doc/CODE_MAP.md) | 项目代码地图：GUI 与 src/ 的目录结构、接口清单、关键设计决策、变更记录 |
| [`gui/CHANGELOG.md`](gui/CHANGELOG.md) | GUI 变更历史（含最近的安全加固：Token 鉴权 / CORS 收紧 / 凭据脱敏 / 配置写锁 / 单实例保护） |
| [`gui/TEST_REPORT.md`](gui/TEST_REPORT.md) | GUI 自动化测试报告：用例设计、缺陷修复对照、覆盖率、遗留风险 |
| [`test/README.md`](test/README.md) | 测试目录说明 |

---

## ❓ 常见问题

<details>
<summary><b>GUI 面板打不开 / 浏览器没自动打开？</b></summary>

`start-gui.bat` 会先启动服务，随后用系统默认浏览器打开页面（CMD 原生 `start`，无 PowerShell 窗口）。若未弹出：手动访问 `http://localhost:3000`，确认命令行窗口输出的端口号一致。其余 GUI 问题（端口占用、总积分显示 0、缓存不生效等）见 [`gui/README.md`](gui/README.md) 的 FAQ。

</details>

<details>
<summary><b>报错 <code>Error: browserType.launch: Executable doesn't exist</code> 怎么办？</b></summary>

Chromium 没装上，手动安装：

```bash
npx patchright install chromium
```

</details>

<details>
<summary><b>登录失败 / 卡住 / 每次都要重新登录？</b></summary>

首次运行时请**手动完成网页登录**一次，等待脚本自动接管剩余流程。登录后的 cookie 会保存到 `sessions/` 目录，后续运行会自动复用。

⚠️ `sessions/` 目录**需要多备份**，丢了就要重新登录。

</details>

<details>
<summary><b>Docker 改了配置为什么不生效？</b></summary>

改完 `compose.yaml` 或代码后，必须加 `--build` 重建镜像：

```bash
docker compose up -d --build
```

不加 `--build` 跑的是旧镜像。

</details>

<details>
<summary><b>国内查询词被限流（403）怎么办？</b></summary>

免费档对连续请求有频率限制。解决方法：

到 [gmya.net](https://gmya.net) 申请 appkey，填入 `searchSettings.chinaApi.appkey`（Docker 用 `CONFIG_CHINA_API_APPKEY` 环境变量），即可解除限流。

</details>

<details>
<summary><b>修改 <code>accounts.json</code> / <code>config.json</code> 后怎么生效？</b></summary>

- **GUI 面板**：即改即存（开关即时提交、文本 500ms 防抖），无需手动编辑 JSON
- **Win 环境（手动编辑）**：必须运行 `npm run build` 重新构建脚本
- **Docker 环境**：不要手动改容器内的 config 文件（重启会被 entrypoint 覆盖），改 `.env` 或 `compose.yaml` 后用 `docker compose up -d --build` 生效

</details>

<details>
<summary><b>旧版 <code>accounts.json</code> / <code>config.json</code> 能继续用吗？</b></summary>

不能。之前的版本与当前版本**不兼容**，必须重新基于 `accounts.example.json` / `config.example.json` 生成。

- **Win 环境**：复制或重命名 `src/accounts.example.json` 为 `src/accounts.json` 并添加凭据；同样 `src/config.example.json` → `src/config.json`

</details>

---

## ⚠️ 注意事项

- 如果出现无法自动登录情况，请在代码执行登录过程中**手动完成网页的登录**，等待代码自动完成剩下流程。登录信息保存在 `sessions/` 目录（需要多备份），后续运行根据该目录的会话文件来运行。
- **Win 环境**：复制或重命名 `src/accounts.example.json` 为 `src/accounts.json` 并添加您的凭据（使用 GUI 面板则可在浏览器中直接添加）。
- **Win 环境**：复制或重命名 `src/config.example.json` 为 `src/config.json` 并自定义您的偏好（使用 GUI 面板则可在浏览器中直接调整）。
- 不要跳过配置这一步。之前的 `accounts.json` 和 `config.json` 版本与当前版本不兼容。
- **Win 环境**：手动修改 `accounts.json` 或 `config.json` 后，必须运行 `npm run build` 重新构建脚本。
- **Docker 环境**：账号和行为配置通过 `.env` 和 `compose.yaml` 传入，不要手动改容器内的 config 文件（重启会被 entrypoint 覆盖）。改 compose.yaml 后用 `docker compose up -d --build` 生效。

---

## 📜 同步与致谢

本项目 fork 自 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)，感谢原作者的付出。

本项目不定时同步原项目代码，在原项目基础上新增与完善了以下内容：

- **🖥 GUI 控制面板（`gui/`）**：零依赖 Node 服务 + 原生前端的可视化管理界面，浏览器内完成账号/配置/统计/任务管理，含本地 Token 鉴权、凭据脱敏、配置写锁、单实例保护等安全设计
- 针对国内用户无法访问 Google 等外网的问题，提供中国热搜查询源（百度/头条/抖音/微博/知乎）
- 输出日志的简单中文翻译
- 在原有基础上完善功能

若有侵权请联系删除。

**本项目所有改动基于 Win11 系统和委托他人 Docker 环境测试。其他系统未测试，请根据原项目相关配置设置。**

| 项目 | 信息 |
|---|---|
| 上游仓库 | [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) |
| 当前版本 | 3.1.6.4 |
| GUI 版本 | v2.1.0-GUI |
| 最后同步原项目 | 2026-06-15 |
| License | GPL-3.0-or-later |

---

## ⚠️ 免责声明

**风险自负！** 使用自动化脚本时，您的 Microsoft Rewards 账户可能会被暂停或禁止。

此脚本仅供教育目的。作者对 Microsoft 采取的任何账户操作不承担责任。
