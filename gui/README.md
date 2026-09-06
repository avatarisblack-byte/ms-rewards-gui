# Microsoft Rewards 脚本 — GUI 控制面板

> 不用碰 JSON 和命令行，在浏览器里点一点即可完成账号管理、配置调整、统计查看与任务启停的可视化控制面板。

本项目是 [Microsoft-Rewards-Script](../README.md)（TypeScript 积分自动化脚本）的配套 Web 控制台，运行在本机 `127.0.0.1`，数据不联网、零外部依赖。

---

## 📖 文档定位

| 维度 | 本文档（`gui/README.md`） | 根目录 `README.md` |
|------|--------------------------|--------------------|
| 读者 | 使用 GUI 面板操作的用户 | 项目总览：GUI 快速上手摘要 + 脚本部署/配置用户 |
| 入口 | 双击 `gui/start-gui.bat` → 浏览器打开面板 | GUI 快速开始 → 脚本 `npm start` / `run.bat` / Docker |
| 核心 | 面板功能、界面操作、数据安全策略的**完整细节** | GUI 能力与安全设计摘要 + 脚本自动化能力、配置项、部署方式 |
| 配置 | 浏览器里点开关 / 填表单（高风险字段锁定） | GUI 面板或手改 `accounts.json` / `config.json` / 环境变量 |
| 内容边界 | 不重复讲脚本内部逻辑、查询引擎细节 | GUI 细节引用本文档，不重复展开 |

---

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🚫 **零依赖** | 后端只用 Node.js 内置模块（http / fs / child_process），无需 `npm install`，`node gui/server.js` 直接运行 |
| 🔒 **本地运行** | 仅监听 `127.0.0.1`，数据不出本机；**服务常驻**——关闭页面/标签页不会关闭服务，只有手动停止（面板「关闭服务」/ `stop-gui.bat` / Ctrl+C）才会退出 |
| 🖥 **四大面板** | 仪表盘总览 / 账号管理 / 数据统计 / 全局设置，左侧导航一键切换（160ms 轻量过渡） |
| 🔄 **实时轮询** | 任务状态 5 秒刷新（日志实时滚动），面板数据 30 秒自动刷新（日志解析走**预生成缓存**，轮询零全量扫描） |
| 👤 **账号可视化** | 增删改查、独立代理、2FA 密钥、指纹保留，全部浏览器内完成 |
| 📦 **Session 导入导出** | 压缩包一键备份 / 恢复登录会话（`session_*.json` 白名单） |
| 📜 **日志管理** | 查看、导入、导出、按日期解析、一键统计 |
| 🛡 **风险保护** | 高危配置字段锁定、写操作自动 `.bak` 备份 + 失败回滚、导入白名单 + 防路径穿越 |
| 🎬 **动效规范** | 按钮按压反馈、弹窗进出对称动画、开关过渡均遵循 emil-design-eng 交互标准，并完整支持系统"减少动态"偏好 |
| 🛎 **首次引导** | 首次打开自动弹出"环境安装"提示弹窗（复用弹窗动效规范）；勾选"不再提示"后状态写入浏览器 localStorage，下次打开不再打扰 |

---

## 🚀 快速开始

### 1. 启动

**方式一：普通窗口启动（能看到服务日志）**

```bat
双击 gui/start-gui.bat
```

**方式二：静默后台启动（无 CMD 黑框，推荐日常使用）**

```bat
双击 gui/start-gui-silent.vbs
```

VBS 会以隐藏窗口形式调用 `start-gui.bat`（零窗口、零 PowerShell），服务后台运行并自动唤起浏览器打开面板。

> ⚠️ 静默模式隐藏了窗口，无法用 Ctrl+C 停止服务；服务**常驻后台**，请使用 `stop-gui.bat` 或面板右上角「关闭服务」停止。
>
> 💡 **开机自启（可选）**：服务常驻 ≠ 开机自启。想让电脑开机后 GUI 自动静默运行，把 `start-gui-silent.vbs` 的快捷方式放进启动文件夹（`Win+R` 输入 `shell:startup` 回车后粘贴快捷方式）即可，无需任何配置。

启动日志中会显示：

```
Microsoft-Rewards-Script 控制台已启动: http://localhost:3000
账号文件: ...\dist\accounts.json
配置来源: ...\src\config.example.json
日志目录: ...\logs
```

> 💡 **首次打开会弹出「环境安装提示」**：提醒先安装环境再操作。勾选弹窗内的"不再提示"并关闭后，浏览器会记住该选择（localStorage），下次打开不再弹出；未勾选直接关闭则每次打开都会提醒。

### 2. 更换端口

默认端口为 `3000`。在「全局设置 → 基础与运行参数 → **GUI 本地端口**」中修改（范围 1024-65535，即改即存），**重启 GUI 后生效**：

```bat
# 关闭当前服务后重新启动即可应用新端口
双击 gui/stop-gui.bat    （或面板右上角「关闭服务」）
双击 gui/start-gui.bat   （自动读取新端口并打开浏览器）
```

端口保存在 `gui/gui-settings.json`（GUI 专属配置，不影响脚本核心 `config.json`）；`start-gui.bat` / `stop-gui.bat` 会动态读取该文件，无需手动编辑。

> 💡 **改端口后的正确停止方式**：请优先使用面板右上角「关闭服务」按钮（直接通知当前服务退出，无端口匹配问题）。若使用 `stop-gui.bat`，它按「配置文件里的新端口」清理，而正在运行的服务还在「旧端口」——此时旧服务可能残留。`stop-gui.bat` 已增加默认端口 3000 的兜底清理；若旧服务在其它自定义端口，请改用「关闭服务」按钮停止后再重启。

### 3. 停止服务

| 方式 | 说明 |
|------|------|
| 面板右上角「关闭服务」 | 服务端延迟 500ms 优雅退出 |
| 双击 `gui/stop-gui.bat` | 按端口精准查找 PID 并强制结束，**不会误杀其他 Node 脚本** |
| 边栏底部「安装环境」 | 异步调用根目录 `setup.bat`（安装依赖/构建，独立最小化窗口，不阻塞 GUI；任务运行中会先警告） |
| 关闭 `start-gui.bat` 的 CMD 窗口 | 仅普通启动方式适用 |

> 💡 **服务常驻（2026-08-23 起）**：GUI 是常驻本地服务，浏览器页面只是它的遥控器。**关闭页面、切走标签页、关闭浏览器都不会关闭服务**——Edge 的「睡眠标签页 / 内存节省器」冻结后台页面时，即使 SSE 保活连接断开，服务也继续运行，回到页面秒开、任务状态不丢。只有上述四种方式才会真正停止服务。

---

## 🖥 界面指南

### ① 仪表盘总览（Home）

左右结构：左侧导航 + 右侧内容区，任务控制（状态指示灯 / 启动 / 停止 / 关闭服务 / 安装环境）位于左侧边栏底部。

- **账户总数**：已配置账号数量
- **今日收益 / 总收益**：
  - 今日收益：本次运行各账号 `ACCOUNT-END` 收集积分之和（同一天多次运行自动累加，按本地时区计算）
  - 总收益：脚本执行带来的累计收益（非账户余额）
- **启动 / 停止任务**：一键启停脚本子进程（`spawn node dist/index.js`）
- **任务实时日志**：最近 100 行子进程 stdout/stderr，按 ERROR/WARN/DEBUG 着色；智能滚动——仅在您接近底部时自动跟随，向上翻阅历史不会被强制拉回
- **账户卡片**：彩色状态 Tag（绿点呼吸=运行中 / 灰勾=已完成 / 红叉=异常 / 灰点=暂无记录）+ 日志事件徽章（ACCOUNT-END / URL-REWARD 等分色）+ 渐变收益条（相对当日最高收益）
- **导出 / 导入数据**：一键打包或恢复全部本地数据（Session + 日志 + 账号 + 配置）

> **为什么总积分会显示 0？** 检查 `dist\accounts.json` 中是否配置了有收益日志的账号，或日志中是否有该账号的 `ACCOUNT-END` / `URL-REWARD` 记录。详见下方 FAQ。

### ② 账号管理（Accounts）

- **添加账户**：输入邮箱 / 密码，可选 TOTP 2FA 密钥、恢复邮箱；后端自动补全默认字段
- **账户卡片**：显示状态 Tag（运行中/已完成/异常/暂无记录）、代理、配置摘要（语言环境/语言/指纹）、最近事件徽章 + 完整动态消息（状态经邮箱前缀与全量日志摘要关联）
- **编辑与删除**：弹窗内修改 `geoLocale`、`langCode`、桌面/移动指纹、独立代理；删除有二次确认
- **导出 / 导入 Session**：将 `dist/browser/sessions/` 下登录会话打包 zip 导出，或导入 zip 恢复登录状态（白名单只接受 `session_*.json`）

### ③ 数据统计（Stats）

- **历史总收益 / 今日收益 / 累计活跃天数**：基于 `logs/` 日志实时解析（统计口径与仪表盘一致）
- **每日积分趋势图**：Chart.js 堆叠柱状图，按日期 × 账号展示每日收益
  - 收益为零的账户自动隐藏（图例与堆叠柱均不显示）
  - 动画：首次进入静态呈现（避免隐藏容器尺寸错乱）；30 秒刷新时从上次高度平滑过渡（400ms，不归零重飞）
- **各账号累计收益**：按总积分排序的进度条列表（同样过滤零收益账户），数据更新时进度条从旧宽度平滑过渡

### ④ 全局设置（Settings）

- **基础参数**：无头模式、连续签到保护、错误诊断、调试日志等开关，以及 **GUI 本地端口**（1024-65535，即改即存、重启后生效）
- **任务开关**：每日任务、额外奖励、特别活动、集点卡、App 任务、桌面/移动搜索、每日签到、阅读奖励
- **搜索行为**：随机滚动 / 点击、中国区 API Key、搜索间隔、阅读延迟、网页停留时间
- **只读配置区**：`sessionPath`、`clusters`、`queryEngines`、`webhook` 等复杂 / 高风险字段**只读**，如需修改点击「打开配置文件」用系统编辑器手动改
- **即时自动保存**：每个开关/输入框修改后自动保存（checkbox 立即提交、文本 500ms 防抖），右下角浮动 **Toast 提示**（圆底图标 + 边框颜色区分成功/失败，2.5s 自动消失，遵循 emil-design-eng 动效规范），无需手动点保存
- **操作按钮**：打开配置文件 / 重置默认（以 `src/config.example.json` 为模板覆盖，自动备份）

---

## 🛡 安全与保护

| 机制 | 说明 |
|------|------|
| **本地 Token 鉴权** | 服务每次启动生成 256 位随机令牌；页面加载时经 `GET /api/auth/token` 领取，所有 `/api/*` 请求必须携带 `X-Auth-Token`（SSE 保活走 `?token=` 查询参数），否则返回 401 |
| **CORS 收紧** | 响应不再携带 `Access-Control-Allow-Origin: *`——跨站网页既读不到令牌接口的响应，也调不动任何接口 |
| **凭据脱敏** | `GET /api/accounts` 对 `password`/`totpSecret` 返回 `******`；编辑其他字段时回传的脱敏占位符视为"未修改"，不会覆盖磁盘上的真实凭据 |
| **配置写互斥锁** | `PUT /api/config` 写入期间并发请求返回 409「系统正忙，请稍后重试」，杜绝多标签页并发保存"最后写入者胜"的静默覆盖 |
| **进程级单实例保护** | 项目根 `.gui.pid` 存活检测，检测到已有实例运行则友好提示退出，防止多开实例并发写坏配置文件 |
| **高风险字段锁定** | `searchSettings.parallelSearching`（并行搜索）被服务端强制忽略，不允许通过 GUI 写入——避免制造异常流量模式、增加封号风险 |
| **写操作自动备份** | 所有写操作（账号增删改、配置保存/重置、数据导入）先 `copyFileSync` 备份 `.bak`，写入失败自动回滚 |
| **导入白名单 + 防路径穿越** | Session 只收 `session_*.json`、日志只收 `*.log`；双重相对路径检查确保文件落点在目标目录内 |
| **请求体限制** | 100MB 上限，防异常大包 |
| **静态资源防护** | 文件名黑名单（`..` / 路径分隔符）防路径穿越 |
| **本机隔离** | 服务只监听 `127.0.0.1:3000`，不对外网开放，数据不联网 |

---

## 🎨 前端技术栈与交互体验

| 技术 | 用途 |
|------|------|
| Tailwind CSS（CDN） | 布局与样式工具类，无需构建步骤 |
| Chart.js v4（CDN） | 每日积分趋势堆叠柱状图 |
| 原生 JavaScript（ES2020+） | 全部交互逻辑（`gui/js/app.js`），无框架依赖 |
| 动效规范 | 遵循 emil-design-eng / review-animations 标准：强 `ease-out` 曲线 token（`--ease-out: cubic-bezier(0.23,1,0.32,1)`）、UI 动画 ≤300ms、只动画 transform/opacity（GPU 合成）、完整 `prefers-reduced-motion` 降级 |

**微交互细节一览：**

- 按钮按压：`scale(0.97)` 160ms 即时反馈（所有可点击元素）
- 弹窗：打开 `opacity + scale(0.96)→1`、关闭对称退出（各 250ms），背板与面板同步过渡
- 开关：滑块 200ms ease-out 位移 + 轨道颜色 150ms 渐变
- 面板切换：160ms 极轻淡入（高频操作克制档，不做夸张动画）
- 收益进度条：`transform: scaleX` GPU 过渡，30s 轮询时平滑增长不瞬跳
- 图表：刷新时从当前高度平滑过渡到新值（400ms），不归零重飞
- 系统开启"减少动态"后：移除位移/缩放动画，仅保留透明度与颜色反馈

---

## 📂 GUI 项目结构

```
gui/
├── design-reference.html      # 前端页面（HTML 结构 + Tailwind/Chart.js CDN）
├── server.js                  # 服务入口：组装 ctx + 路由分发 + --generate-summary CLI
├── start-gui.bat              # 一键启动（常规模式：CMD 日志窗口，node 读端口，CMD start 开浏览器，无 PowerShell）
├── start-gui-silent.vbs       # 静默启动（零窗口，隐藏 CMD 后台运行）
├── stop-gui.bat               # 按端口精准停止
├── gui-settings.json          # GUI 专属设置（端口等，start/stop-gui.bat 动态读取）
├── summary.json               # --generate-summary CLI 产物（日志统计快照）
├── README.md                  # 本文档
├── css/
│   ├── main.css               # 按钮组件类 / 弹窗 / 开关 / 进度条动效 / reduced-motion
│   └── animations.css         # 图表容器辅助样式
├── js/
│   ├── app.js                 # 前端核心交互逻辑
│   └── animator.js            # Chart.js 动画工具（从 0 生长 + 平滑更新）
└── lib/                       # 服务端模块（零依赖，模块化拆分）
    ├── config.js              # 常量与路径解析
    ├── httpUtils.js           # sendJson / sendText / readBody
    ├── validator.js           # 账号结构校验
    ├── logger.js              # 日志解析与读取
    ├── summary.js             # 日志统计摘要（收益口径）
    ├── logCache.js            # 日志分析预生成/缓存（account-summary.json，失效检测+原子写入）
    ├── archive.js             # 跨平台 zip 打包 / 解压
    ├── taskManager.js         # 任务子进程管理
    └── routes/                # 8 个路由模块（统一签名，按序分发）
        ├── static.js          # 页面 + css/js 静态资源
        ├── config.js          # 配置 CRUD / 重置 / 打开
        ├── accounts.js        # 账号 CRUD（.bak 备份 + 回滚）
        ├── logs.js            # 日志列表 / 导入导出 / 按日期
        ├── sessions.js        # Session zip 导入导出
        ├── data.js            # 一键数据导入导出
        ├── tasks.js           # 任务启停与状态
        └── system.js          # 关闭服务 / 统计 / SSE 保活
```

> 接口与实现细节见 [`doc/CODE_MAP.md`](../doc/CODE_MAP.md) 的「GUI 控制面板」章节。

---

## 🔌 接口速查（前端视角）

| 分组 | 接口 |
|------|------|
| 账号 | `GET/POST /api/accounts`、`PUT/DELETE /api/accounts/:email` |
| 配置 | `GET/PUT /api/config`、`POST /api/config/reset`、`POST /api/config/open` |
| 任务 | `POST /api/start`、`POST /api/stop`、`GET /api/task` |
| 日志 | `GET /api/logs`、`GET /api/logs/export`、`POST /api/logs/import`、`GET /api/logs/:date`、`GET /api/logs/summary` |
| Session | `GET /api/sessions/export`、`POST /api/sessions/import` |
| 数据 | `GET /api/data/export`、`POST /api/data/import` |
| 系统 | `POST /api/shutdown`、`GET /api/stats`、`GET /api/keepalive`（SSE） |

---

## ❓ 常见问题

<details>
<summary><b>页面打不开 / 怎么确认服务还在运行？</b></summary>

服务**常驻**，正常情况不会自己退出（2026-08-23 起）。若页面打不开，按顺序排查：
1. 直接访问 `http://localhost:端口`（默认 3000）看是否秒开——能开说明服务一直在，只是页面被 Edge 冻结/关闭了。
2. 打开任务管理器（Ctrl+Shift+Esc）→ 详细信息，查找名为 `node.exe` 且命令行含 `gui/server.js` 的进程——存在即服务在运行。
3. 若服务确实没在跑（重启电脑后不会自动启动），重新双击 `gui/start-gui-silent.vbs` 或 `gui/start-gui.bat` 即可；想开机自启可参考[启动章节](#1-启动)的提示。

</details>

<details>
<summary><b>浏览器没自动打开？</b></summary>

`start-gui.bat` 会先启动服务（node 冷启动约 0.3s），随后用系统默认浏览器打开页面（CMD 原生 `start` 命令，无 PowerShell 窗口）。若未弹出：
手动访问 `http://localhost:3000`，确认命令行窗口输出的端口号一致。

</details>

<details>
<summary><b>端口被占用 / 改不了端口？</b></summary>

在「全局设置 → 基础与运行参数 → **GUI 本地端口**」中修改（范围 1024-65535），保存后**重启 GUI** 生效。不要直接改 `server.js`（端口由 `gui-settings.json` 统一控制，`start/stop-gui.bat` 动态读取）。

</details>

<details>
<summary><b>总积分显示为 0？</b></summary>

按顺序排查：
1. 配置的账号是否真的在 `dist\accounts.json` 中（GUI 读的是这个文件，不是根目录的 `accounts.json`）
2. 该账号在 `logs/` 日志中是否有 `ACCOUNT-END` / `URL-REWARD` 记录
3. 若日志中有收益账号但没配置，可在「账号管理」中添加这些账号，或确认总收益统计已含"日志中的未配置账号"

</details>

<details>
<summary><b>改了代码 / 配置不生效？</b></summary>

浏览器可能缓存了旧版静态文件。按 **Ctrl+F5 强制刷新**（或清除浏览器缓存）再访问。

</details>

<details>
<summary><b>杀毒 / 防火墙提示？</b></summary>

GUI 是本机 Node 服务，仅监听 127.0.0.1:3000，不对外网开放。若防火墙询问，允许 Node 在本机访问即可。

</details>

---

## ⚠️ 免责声明

使用自动化脚本时，您的 Microsoft Rewards 账户可能会被暂停或禁止。本面板仅为该脚本提供可视化管理界面，不承担任何账户风险责任。使用前请阅读[根目录免责声明](../README.md)。
