# CODE_MAP

项目核心代码地图。修改代码前请先阅读本文档，修改后请更新对应条目。

## 项目概览

| 模块 | 说明 |
|------|------|
| `src/` | 主脚本（TypeScript v3.1.6.4）：Microsoft Rewards 积分自动化（patchright 浏览器 + 指纹注入 + Cheerio 解析 + 多进程集群） |
| `gui/` | 控制面板（零依赖 Node 服务 + 原生前端）：浏览器可视化管理账号/配置/统计/任务 |
| `scripts/` | 运维脚本：Docker 容器、macOS 启动、浏览器 Session 管理 CLI |
| `test/` | 测试：①日志解析与统计的交叉对拍测试；②GUI 全链路自动化测试（单元/接口/容错，`node:test` 零依赖 + tmp 沙箱隔离） |
| `doc/` | 文档系统（本文件为入口） |

---

## GUI 控制面板（gui/）

### 目录结构

| 文件 | 职责 |
|------|------|
| `gui/design-reference.html` | 控制面板前端页面（HTML 结构 + Tailwind CDN + Chart.js CDN，样式与逻辑已拆分至 css/ js/；含首次打开"环境安装"提示弹窗）；仪表盘布局重构（2026-08-21）：任务实时日志区移至「全局摘要 → 实时日志 → 账号列表」动线中部（今日收益与首个账号之间） |
| `gui/server.js` | 入口（≈59 行）：组装 ctx → 按序调用 lib/routes/ 各路由 → `--generate-summary` CLI → listen（2026-08-18 重构）；分发层包 try/catch 并为异步路由的 Promise 补 catch，路由内逃逸的异常统一转 500，不再成为 uncaughtException 终止进程（2026-08-20 加固）；启动时生成 256 位随机 `AUTH_TOKEN`，新增免鉴权接口 `GET /api/auth/token` 供页面领取，所有 `/api/*` 请求统一校验 `X-Auth-Token`（SSE 的 EventSource 无法自定义请求头，`/api/keepalive` 额外支持 `?token=` 查询参数），不匹配返回 401；进程级单实例保护：项目根 `.gui.pid` 存活检测 + EADDRINUSE 兜底，检测到已有实例时友好提示并退出，防止多开并发写坏配置文件（2026-08-21 安全加固）；HTTP 超时配置 `headersTimeout=20s / requestTimeout=60s / keepAliveTimeout=65s` 防慢速攻击（2026-08-21） |
| `gui/lib/config.js` | 常量（PORT/ROOT/GUI_DIR/HTML_FILE/LOGS_DIR）+ resolveAccountsPath/resolveConfigPath/readJson（2026-08-18 新增）；writeGuiSettings 改为与现有设置合并写入（整体覆盖会清除 gui-settings.json 中的非端口设置）（2026-08-20 修复） |
| `gui/lib/httpUtils.js` | sendJson / sendText / readBody（100MB 上限）（2026-08-18 新增）；readBody 补 aborted/close 监听 + 30s 超时并用 settled 标志只结算一次（客户端断网时原 Promise 永不 settle，请求体内存无法释放），sendJson 的 JSON.stringify 包 try/catch 降级 500（序列化抛错会让 res 永不 end）（2026-08-20 加固）；sendJson 移除 `Access-Control-Allow-Origin: *`（原配置下任意网页可跨域读取本机接口与账号凭据），浏览器仅允许同源访问（2026-08-21 安全加固） |
| `gui/lib/validator.js` | validateAccountShape（账号结构校验，与 src/util/Validator.ts 字段规则对齐）（2026-08-18 新增）；email 补长度 ≤254（RFC 5321）、禁空白/控制字符、禁 `< > " ' \` &`（畸形邮箱会写进 accounts.json、破坏日志行结构并回显前端），proxy.port 收紧为 0-65535 整数（2026-08-20 加固） |
| `gui/lib/logger.js` | parseLogLine / listLogFiles / readLogFile（2026-08-18 新增）；parseLogLine 解析前剥离行尾 `\r`（JS 正则的 `.` 不匹配 `\r`，CRLF 日志会被整行丢弃导致统计归零），readLogFile 以 `YYYY-MM-DD` 白名单校验并自动补 `.log` 后缀（原先按日期查询恒返回空，且 dateStr 可穿越目录）（2026-08-20 修复） |
| `gui/lib/summary.js` | summarizeLogs / summarizeAllLogs / generateSummary / writeSummaryFile；收益口径：ACCOUNT-END 累加 + 本地时区日期键 + todayTotal（2026-08-18/19 新增）；summarizeLogs 取 `e.message \|\| ''` 后再匹配，残缺条目不再抛 TypeError（2026-08-20 加固）；generateSummary 按「运行段」聚合（2026-08-22 修复）：ACCOUNT-START 为段边界，段内有 ACCOUNT-END 用 END 权威总计、无 END 用段内活动积分兜底，段收益归属段结束日——修复同一天多次运行（脚本重启/中断续跑）时仅取最后一次 ACCOUNT-END、丢弃被截断运行收益的漏算（实测 guidata 漏 255 分，grandTotal 2050→2305）；新增 run 级事件黑名单 `RUN_LEVEL_EVENTS` + `isRunLevelEvent`，`summarizeLogs`/`generateSummary` 双处按 event 跳过（2026-08-23 修复）：上游 RUN-END 行 [账户] 字段被动态 userName 污染成末尾账号名，仅按 account 过滤会覆盖末尾账号 lastEvent 并在跨天运行时污染收益段归属 |
| `gui/lib/archive.js` | unzipToDir / zipDir / makeTmpRoot（PowerShell/unzip 跨平台零依赖压缩解压）（2026-08-18 新增）；makeTmpRoot 改用 `fs.mkdtempSync`（原 `Date.now()+pid` 拼接在同毫秒并发下会撞同一目录，导入/导出互相覆盖 zip 并删对方目录）（2026-08-20 修复）；PowerShell 命令不再把路径拼进 `-Command` 字符串，改经环境变量传递（路径含单引号会中断命令或构成注入）（2026-08-21 加固） |
| `gui/lib/taskManager.js` | startTask / stopTask / getTaskStatus（子进程 spawn node dist/index.js，SIGTERM→10s SIGKILL 兜底，500 行环形日志缓冲）（2026-08-18 新增）；运行判定改用 `exitCode/signalCode`（`killed` 仅表示信号已发出，SIGTERM 后进程最多再存活 10s），启动加 `starting` 互斥 + 3s 节流，避免并发请求/重复点击先后拉起多个脚本进程（2026-08-20 加固） |
| `gui/lib/logCache.js` | 日志摘要缓存：getCachedData / generateCache / isCacheFresh / invalidateCache，缓存文件 `gui/cache/account-summary.json`；用「文件名+大小+mtime」集合快照判定新鲜度（导入的 zip 解压会保留旧 mtime，单一"最新 mtime"判定会漏掉新导入日志），tmp+rename 原子写入；读取/重建异常降级为空摘要（缓存是性能优化，不应成为可用性单点）（2026-08-19 新增 / 2026-08-20 补异常兜底）；generateCache 后惰性清理 7 天前残留缓存文件（2026-08-21） |
| `gui/lib/cleanup.js` | 备份轮转与缓存清理（2026-08-21 新增）：`rotateBackup` 把旧 `.bak` 轮转为 `.bak.<UTC时间戳>` 并每类保留最近 5 个（固定 `.bak` 会被每次写入覆盖、无轮转会无限堆积）；`pruneOldCache` 删除缓存目录 7 天前文件。清理/轮转失败仅告警，绝不影响主流程 |
| `gui/lib/routes/static.js` | 静态页 + `/css/*` `/js/*` 分发（防路径穿越黑名单）（2026-08-18 新增） |
| `gui/lib/routes/config.js` | 配置 CRUD：GET/PUT `/api/config`、POST `/api/config/reset`、POST `/api/config/open`（2026-08-18 新增）；合并写回时对 `current.searchSettings` 做空值保护（缺该键时读 `.chinaApi` 会抛 TypeError 使保存整体失败）（2026-08-20 修复）；顶层字段改白名单校验（`ALLOWED_TOP_LEVEL`，来源 src/config.example.json 的 14 个顶层键，新增配置项需同步），未知字段返回 400 而非落盘污染 config.json（2026-08-20 加固）；PUT 加模块级写互斥锁 `isWriting`：写入期间到达的并发请求返回 409「系统正忙，请稍后重试」，`finally` 释放锁；readBody 后 `setImmediate` 让出事件循环，保证同一批并发请求先完成锁检查（本地回环小请求体同包缓冲时若不让出，前一请求会在后一请求回调前完成并释放锁，锁形同虚设）（2026-08-21 修复）；备份前调用 `cleanup.rotateBackup` 轮转历史备份（保留最近 5 个，2026-08-21） |
| `gui/lib/routes/accounts.js` | 账号 CRUD：GET/POST `/api/accounts`、PUT/DELETE `/api/accounts/:email`（.bak 备份+回滚）（2026-08-18 新增）；GET 分支校验数组结构与 email 类型，避免脏 accounts.json 触发 TypeError 终止进程（2026-08-20 加固）；GET 对 `password`/`totpSecret` 脱敏为 `******`（原先原样下发全部账号凭据）；PUT 把回传的脱敏占位符视为「未修改」剔除，防止前端编辑其他字段时把占位符覆盖写入真实凭据（2026-08-21 安全加固）；备份前调用 `cleanup.rotateBackup` 轮转历史备份（2026-08-21） |
| `gui/lib/routes/logs.js` | 日志：GET `/api/logs`、导出/导入 zip、GET `/api/logs/:date`、GET `/api/logs/summary`（2026-08-18 新增）；GET `/api/logs` 校验 req.method 返回 405（2026-08-20 加固）；`/api/logs/summary` 与 `/api/logs/:date` 补同款方法校验（同类未动项）；导出分支移除残留的 `Access-Control-Allow-Origin: *`（CORS 加固收尾）（2026-08-21） |
| `gui/lib/routes/sessions.js` | Session zip 导入/导出（白名单 session_*.json + 防穿越 + .bak）（2026-08-18 新增） |
| `gui/lib/routes/data.js` | 一键数据导入/导出（sessions+logs+accounts.json+config.json 打包恢复）（2026-08-18 新增） |
| `gui/lib/routes/tasks.js` | 任务：POST `/api/start`、POST `/api/stop`、GET `/api/task`（2026-08-18 新增）；三个接口均校验 req.method 并对非法方法返回 405（原先仅判断 pathname，GET 即可启停脚本子进程）（2026-08-20 加固） |
| `gui/lib/routes/system.js` | 系统：POST `/api/shutdown`、GET `/api/stats`/`/api/summary`、GET `/api/keepalive`（SSE 保活）、POST `/api/setup`（2026-08-18 新增）；三个读接口校验 req.method 返回 405（2026-08-20 加固）；`/api/setup` spawn `setup.bat` 前注入剔除 `allow-scripts` 的干净 `NPM_CONFIG_USERCONFIG`，规避用户级 `.npmrc` 的 allow-scripts 在 npm 11.17 嵌套安装下的 EALLOWSCRIPTS，不改动上游非 GUI 文件（2026-08-21）；**服务常驻改造（2026-08-23）**——删除「所有保活连接断开后 5s 静默期自杀（process.exit）」逻辑，keepalive 断开仅记日志「所有页面已断开保活连接，服务继续常驻运行」，停止方式仅剩 `/api/shutdown`/`stop-gui.bat`/Ctrl+C（根因：Edge 睡眠标签页冻结后台页面使 SSE 断开且页面无法重连，静默期走完服务被"清掉"且静默模式无感知） |
| `gui/start-gui.bat` | 一键启动（常规模式）：**纯 ASCII（无中文，避免任何代码页乱码）**：`cd /d %~dp0` → node 读取 `gui-settings.json` 端口注入 `PORT`（失败回退 3000）→ 校验 server.js → ping 延迟 ~1s → CMD 原生 `start "" http://localhost:%PORT%` 开浏览器（**无 PowerShell**）→ 当前窗口前台跑 `node server.js`（日志窗口） |
| `gui/start-gui-silent.vbs` | 静默启动（WScript.Shell 窗口模式 0 隐藏 CMD 后台跑 start-gui.bat，零窗口零 PowerShell）（2026-08-17 新增） |
| `gui/stop-gui.bat` | 按端口（默认 3000）查 PID 并 taskkill /f 停止，避免误杀其他 Node 脚本；端口读取用 node（与 start 一致，无 PowerShell）（2026-08-17 新增） |
| `gui/README.md` | GUI 专属用户文档（2026-08-17 新增；2026-08-20 全面重写） |
| `gui/CHANGELOG.md` | GUI 变更记录（2026-08-20 从 `doc/CODE_MAP.md`「变更记录」章节分离，13 条）：因 GUI 迭代频繁、条目长，混在项目级变更记录中会淹没 src/scripts 的改动；新增 GUI 条目一律写在此处，仓库级/非 GUI 改动仍写 CODE_MAP |
| `gui/TEST_REPORT.md` | GUI 自动化测试与缺陷修复报告（2026-08-20 新增）：记录 `test/gui/` 测试套件的设计决策（tmp 沙箱隔离、直调路由判定崩溃、劫持 process.exit 测生命周期）、三阶段结果对比（109→126→138 通过 / 140）、18 项缺陷的根因与修复对照、逐文件覆盖率、两轮浏览器真机验证结论、遗留风险与后续建议。定位问题时可据此快速判断某模块是否已有回归守护 |
| `gui/css/main.css` | 公共样式：卡片阴影/滚动条/图表占位 + 按钮组件类（.btn 家族）+ 弹窗/开关/进度条动效 + reduced-motion 降级（2026-08-19/20 扩充）；最新动态状态块样式（emil-design-eng 规范，2026-08-21）：`.latest-done` 高对比边框+微渐变（ACCOUNT-END 完成态）、`.latest-running` box-shadow 脉冲（运行态，reduced-motion 降级）、`.account-end-pill` 圆角胶囊标签、`.key-point` 关键字段加粗主色 #0078D4 |
| `gui/css/animations.css` | 图表容器辅助样式（user-select 禁用、加载占位骨架） |
| `gui/js/animator.js` | Chart.js 动画工具：chartAnimOptions（x 锚定 + y 从 0 生长）+ smoothUpdateChart（保留当前高度过渡，显式 400ms，reduced-motion 0ms）（2026-08-20 收敛时长） |
| `gui/js/app.js` | 前端核心交互逻辑（加载/渲染/任务/导入导出/弹窗/SSE 保活/全局配置即时保存/首次打开提示持久化）；escapeHtml 恢复真实 HTML 实体转义（原实现四个 replace 的替换目标与源字符相同 → 等同未转义，配合 innerHTML 渲染构成存储型 XSS），账号卡片按钮改 `data-email` + 事件委托（HTML 属性先实体解码再作 JS 解析，内联 onclick 拼接用户数据无法靠转义防注入）（2026-08-20 安全修复）；本地 Token 集成：页面加载先调 `/api/auth/token` 缓存令牌，新增 `apiFetch` 统一封装（自动携带 `X-Auth-Token`、401 时提示并刷新页面），全部业务请求与 SSE 保活（`?token=` 查询参数）改走令牌通道（2026-08-21 安全加固）；D18 修复：`fetchJson` 加 `AbortSignal.timeout(15000)`；两处固定 `setInterval` 轮询改为自调度 `setTimeout` + in-flight 锁 + 失败计数指数退避（任务 5s→10s→20s→40s→60s 封顶、数据 30s→60s→120s 封顶，成功重置计数；断网/服务关闭时不再请求堆积）；SSE 保活改手动退避重连（`onerror` 主动 `close()` 阻止浏览器内置 ~2.5s 固定间隔自动重连，改 `setTimeout` 5s→10s→20s→40s→60s 退避，`onopen` 重置计数，服务关闭时 eventsource 重连风暴消失）（2026-08-21）；日志呈现增强：新增 `parseAccountEnd` 解析 ACCOUNT-END 消息关键字段（总计/原始→新值/持续时间），账号卡片「最新动态」按状态渲染完整状态块（完成态：ACCOUNT-END 胶囊 + 关键字段加粗主色；运行态：脉冲动画），所有账号走同一渲染路径保证末账号格式严格对齐；实时日志流里程碑行（ACCOUNT-END/RUN-END）主色加粗高亮（2026-08-21） |
| `gui/summary.json` | `--generate-summary` CLI 生成的持久化统计产物（不入库） |
| `gui/gui-settings.json` | GUI 专属设置（端口等，与脚本核心 config.json 隔离）：`/api/gui-settings` 读写、start/stop-gui.bat 启动时动态读取（2026-08-20 纳入 CodeMap） |

### gui/server.js（及 lib/routes/）提供接口

| 接口 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/` | GET | - | 返回 gui/design-reference.html |
| `/api/auth/token` | GET | - | 获取本地访问令牌（每次启动随机生成；免鉴权；除本接口外所有 `/api/*` 均需携带 `X-Auth-Token`，SSE 可用 `?token=`） |
| `/api/accounts` | GET | - | 返回账号列表（经 summarizeAllLogs 关联全量日志摘要） |
| `/api/accounts` | POST | JSON 账号对象 | 新增账号（补全默认字段→重复检查→备份 .bak→写回） |
| `/api/accounts/:email` | PUT | JSON 账号对象 | 更新账号（备份 .bak→校验→合并写回） |
| `/api/accounts/:email` | DELETE | - | 删除账号（备份 .bak→splice→写回，失败回滚） |
| `/api/config` | GET/PUT | JSON 配置对象 | 读取/更新全局配置（宽松校验；强制忽略 parallelSearching；备份 .bak+合并写回） |
| `/api/gui-settings` | GET/PUT | JSON `{port}` | 读取/保存 GUI 专属设置（端口校验 1024-65535 整数；写 gui/gui-settings.json + .bak 备份；重启后生效） |
| `/api/config/reset` | POST | - | 重置为 src/config.example.json 默认 |
| `/api/config/open` | POST | - | 系统默认程序打开实际 config 文件 |
| `/api/sessions/import` | POST | `{filename,dataBase64}` | 导入 Session zip（白名单 session_*.json+防穿越+.bak） |
| `/api/sessions/export` | GET | - | 导出 Session zip |
| `/api/logs` | GET | - | logs/ 文件列表 |
| `/api/logs/export` | GET | - | 导出日志 zip |
| `/api/logs/import` | POST | `{filename,dataBase64}` | 导入日志 zip（白名单 *.log+防穿越+.bak） |
| `/api/logs/:date` | GET | YYYY-MM-DD | 指定日期日志解析 |
| `/api/logs/summary` | GET | - | 最新日志聚合摘要 |
| `/api/data/export` | GET | - | 一键导出全部数据 zip（sessions+logs+accounts.json+config.json） |
| `/api/data/import` | POST | `{filename,dataBase64}` | 一键导入全部数据 zip（白名单+防穿越+.bak+失败回滚） |
| `/api/start` | POST | - | 启动任务子进程（spawn node dist/index.js，开发模式降级 ts-node） |
| `/api/stop` | POST | - | 停止任务（SIGTERM→10s SIGKILL 兜底） |
| `/api/task` | GET | - | 任务状态 + 最近 100 行日志 |
| `/api/shutdown` | POST | - | 关闭服务（延迟 500ms 退出） |
| `/api/stats`/`/api/summary` | GET | - | 日志统计摘要（即时重算） |
| `/api/keepalive` | GET | - | SSE 长连接保活（text/event-stream+keep-alive；断开进入 5s 静默期，期内新连接取消销毁，超时才退出） |
| `--generate-summary` | CLI | - | `node gui/server.js --generate-summary` 生成 gui/summary.json |

### 关键设计决策

- **本地 Token 鉴权 + CORS 收紧（2026-08-21）**：启动时 `crypto.randomBytes(32)` 生成一次性令牌；前端页面加载时调 `GET /api/auth/token` 领取并缓存，所有业务请求经 `apiFetch` 统一携带 `X-Auth-Token`，401 时提示并刷新页面；同时移除全部 JSON 响应的 `Access-Control-Allow-Origin: *`——跨站网页既读不到令牌接口的响应，也调不动任何接口（此前本机任意网页可读走全部账号凭据、启停任务）。安全边界说明：令牌接口本身免鉴权（本机进程可通过 curl 获取），但本机进程本就处于信任边界内（可直接读 accounts.json），鉴权的防御对象是浏览器中的跨站网页。
- **配置写互斥（2026-08-21）**：`PUT /api/config` 加模块级 `isWriting` 锁，写入期间到达的并发请求返回 409「系统正忙，请稍后重试」；readBody 后 `setImmediate` 让出事件循环，使同一批并发请求先完成锁检查（本地回环下小请求体与请求头同包缓冲，若不让出，前一请求会在后一请求的 request 回调前完成并释放锁，20 并发实测仍全部 200）。`POST /api/config/reset` 未纳入互斥（仅手动触发），属已知小面。
- **进程级单实例保护（2026-08-21）**：项目根 `.gui.pid` 记录进程号，启动前检测存活实例则友好提示退出；选 pid 文件而非端口检测的原因——Windows 上 SO_REUSEADDR 语义允许第二个进程重复 bind 同一端口，EADDRINUSE 会漏判（保留作为 Linux/macOS 的兜底）。正常退出时清理 pid 文件，`taskkill /f` 强杀残留由下次启动的存活检测兜底。
- **日志目录固定为项目根目录 `logs/`**（与 Logger.ts 写入位置一致）。
- **账户保存流程**：备份 `.bak` → 校验 → 合并写入 → 4 空格缩进写回，失败自动恢复。
- **请求体限制**：readBody 100MB（session/日志/数据导入共用）。
- **日志关联**：账号卡片状态经邮箱前缀 `email.split('@')[0]` 匹配日志 `[账户]`；`GET /api/accounts` 用 `summarizeAllLogs()` 聚合全部日志（2026-08-19 修复），此前只读最新一天日志导致历史运行过的账号显示"暂无运行记录"。
- **任务启动**：`spawn('node',[dist/index.js])`，cwd=项目根目录，开发模式降级 ts-node。
- **统计防重复**：优先 ACCOUNT-END 权威总计（同日多次运行累加）；无则累加 INFO 级活动积分（跳过 DEBUG 差额行）。
- **前端图表**：Chart.js v4 堆叠柱。首次创建 `animations: false`（隐藏面板时尺寸 0×0 会导致动画起点错乱，惰性创建）；更新走 `smoothUpdateChart`（animator.js）保留当前显示高度过渡、显式 400ms（原 Chart.js 默认 1000ms 偏慢）。
- **Home 总积分兜底与日志账号合并**：latestBalance 优先、finalPoints 兜底；合并"已配置账号 + 日志有收益未配置账号"。（2026-08-17）
- **Stats 零收益过滤**：图例/堆叠柱仅收集 points>0，累计列表仅 totalPoints>0。（2026-08-17）
- **一键导入导出本地数据（2026-08-18）**：仪表盘标题区"导出数据/导入数据"按钮，打包/恢复 sessions+logs+accounts.json+config.json；白名单+防穿越+.bak+回滚。
- **模块化重构（2026-08-18）**：`server.js` 原约 1600 行拆为 `gui/lib/`（7 基础模块）+ `gui/lib/routes/`（8 路由模块），入口精简为组装 ctx+顺序分发。路由签名 `(req,res,pathname,ctx)=>boolean`（true=已处理），ctx 注入 config/http/validator/logger/summary/archive/taskManager 规避循环 require。拆分按依赖递增（config→httpUtils/validator→logger→summary→archive→taskManager→routes→入口）。
- **服务常驻（SSE 保活仅作观测，2026-08-23 起替代「5s 静默期退出」）**：前端 EventSource('/api/keepalive')（手动退避重连，DOMContentLoaded 重建连接）；服务端 text/event-stream+no-cache+keep-alive、不 res.end()。原设计（2026-08-18/20）：断开后进入 5s 静默期倒计时，期内有新连接（用户刷新）则取消销毁、倒计时结束仍无连接才 process.exit。**2026-08-23 改为服务常驻**：Edge 的「睡眠标签页/内存节省器」会整体冻结后台标签页（页面 JS 定时器与网络连接全部挂起），SSE 断开后页面无法执行退避重连，5s 静默期走完服务即被清掉（静默启动模式无窗口、完全无感知）；删除静默期自杀逻辑，keepalive 断开仅记日志，服务存活不再依赖浏览器页面连接，停止方式仅剩 `/api/shutdown`/`stop-gui.bat`/Ctrl+C。连接计数保留用于日志（支持多标签页并行）。前端已移除 beforeunload 弹框（不再打断刷新）。原 /api/heartbeat 短轮询已移除。
- **端口配置（gui-settings.json 统一控制）**：GUI 端口由 `gui/gui-settings.json` 的 `port` 字段统一管理，与脚本核心 config.json 隔离。启动链路：start-gui.bat / stop-gui.bat 启动时用 PowerShell 动态读取该文件并注入 `PORT` 环境变量，`lib/config.js` 的 `resolvePort()` 兜底读取（优先级：环境变量 PORT > gui-settings.json > 默认 3000），server.js 监听 `config.PORT`——命令行显示与监听端口同源，不会出现新旧端口不一致；GUI 设置页「GUI 本地端口」即改即存（`PUT /api/gui-settings`），重启后生效（2026-08-20）。
- **前端响应式**：aside flex-shrink-0 + main min-w-0，防面板撑爆挤瘪侧边栏。（2026-08-16）
- **全局配置即时保存（2026-08-19）**：checkbox 立即提交、text 500ms 防抖 + 失焦兜底；`CONFIG_FIELD_MAP` 字段映射表 + `saveConfigSilent` 增量提交；串行 Promise 链防并发写盘乱序；右上角"已自动保存/保存失败"状态提示（2.5s 后淡出）。
- **前端动效规范（2026-08-20）**：按 emil-design-eng / review-animations 标准落地——按钮按压 `scale(0.97)` 160ms；弹窗进出对称（opacity + scale(0.96)↔1，250ms ease-out，关闭先播退出再 display:none，`data-open` 属性驱动，防快速开关竞态）；开关滑块 `after:transition-transform` + 轨道颜色 150ms ease（消除 `transition: all`）；面板切换 160ms 极轻淡入（tens/天高频克制档）；收益进度条 DOM diff 更新 + `transform: scaleX`（GPU，400ms）；全局 `prefers-reduced-motion` 降级（保留 opacity/颜色、移除位移）。

---

## 主脚本（src/）

### 入口与流程

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口：`MicrosoftRewardsBot` 类。任务流程编排（RUN-START→逐账户 Main 流程→RUN-END）；集群模式（cluster 多进程分片跑账号，主进程聚合统计）；AsyncLocalStorage 执行上下文（isMobile/account）；SIGINT/SIGTERM/uncaughtException 兜底；webhook 摘要发送 |
| `src/constants.ts` | 全局常量：超时、重试次数、魔法数字（TIMEOUTS 等） |
| `src/crontab.template` | crontab 定时运行模板（Docker/服务器部署参考） |
| `src/accounts.example.json` | 账号模板（GUI 回退读取源之一） |
| `src/config.example.json` | 配置模板（GUI 回退读取源 + 重置默认模板） |

### browser/ 浏览器层（patchright + 指纹）

| 文件 | 职责 |
|------|------|
| `src/browser/Browser.ts` | 浏览器工厂：patchright 启动 chromium，fingerprint-injector 注入反检测指纹，会话恢复（cookies+指纹）与保存 |
| `src/browser/BrowserFunc.ts` | 浏览器功能：Dashboard 数据拉取（REST API + 新版 UI Server Actions）、可赚积分、当前余额、Server Action 部署 ID 提取（`extractDeploymentId`）、浏览器关闭清理 |
| `src/browser/BrowserUtils.ts` | 浏览器工具：Cheerio 解析 DOM、ghost-cursor 人类化点击/滚动/输入、页面导航封装 |
| `src/browser/UserAgent.ts` | UA 管理：从 fingerprint-generator 取 Chrome/Edge 版本与 UA，维护可用 UA 池 |
| `src/browser/auth/Login.ts` | 登录编排：选择登录方式、会话恢复/保存、获取 App Access Token |
| `src/browser/auth/methods/EmailLogin.ts` | 邮箱+密码登录 |
| `src/browser/auth/methods/GetACodeLogin.ts` | 代码验证登录（收验证码） |
| `src/browser/auth/methods/MobileAccessLogin.ts` | 移动访问令牌登录（randomBytes 构造授权请求） |
| `src/browser/auth/methods/PasswordlessLogin.ts` | 无密码登录 |
| `src/browser/auth/methods/RecoveryEmailLogin.ts` | 恢复邮箱登录 |
| `src/browser/auth/methods/Totp2FALogin.ts` | TOTP 2FA 登录（otpauth 生成动态码） |
| `src/browser/auth/methods/LoginUtils.ts` | 登录工具：错误/副标题信息提取、readline 交互输入 |

### functions/ 活动层

| 文件 | 职责 |
|------|------|
| `src/functions/Workers.ts` | 活动 worker 基类：封装 Axios 请求、积分获取与通用活动逻辑 |
| `src/functions/Activities.ts` | 活动聚合：连击保护（doStreakProtection）、每日签到（doDailyCheckIn）、阅读奖励（doReadToEarn） |
| `src/functions/SearchManager.ts` | 搜索编排：计算缺失搜索积分，调度移动端+桌面端搜索（独立浏览器会话、指纹轮换） |
| `src/functions/QueryEngine.ts` | 查询引擎：Google/趋势/Reddit/Wikipedia 与中国热搜源（百度/头条/抖音/微博/知乎），限流退避、日志聚合 |
| `src/functions/activities/api/ClaimBonusPoints.ts` | 领取 dashboard 奖励积分（新版 UI Server Action） |
| `src/functions/activities/api/DoubleSearchPoints.ts` | 双倍搜索积分活动 |
| `src/functions/activities/api/FindClippy.ts` | 找 Clippy 活动 |
| `src/functions/activities/api/Quiz.ts` | 测验解答（0 分与 30-40 分变体、此或彼、ABC、投票） |
| `src/functions/activities/api/StreakProtection.ts` | 连击保护 Server Action（toggleStreakProtection） |
| `src/functions/activities/api/UrlReward.ts` | URL 奖励（旧版 REST） |
| `src/functions/activities/api/UrlRewardNew.ts` | URL 奖励（新版 Server Actions，部署 ID 守卫） |
| `src/functions/activities/app/AppReward.ts` | App 奖励（随机 UUID 构造请求） |
| `src/functions/activities/app/DailyCheckIn.ts` | App 每日签到 |
| `src/functions/activities/app/ReadToEarn.ts` | 阅读文章奖励 |
| `src/functions/activities/browser/Search.ts` | 浏览器搜索活动（QueryCore 驱动） |
| `src/functions/activities/browser/SearchOnBing.ts` | Bing 本地化查询（bing.com 搜索） |
| `src/functions/bing-search-activity-queries.json` | Bing 搜索活动查询词库 |
| `src/functions/search-queries.json` | 本地查询词库（标准词，含中国地区热词） |

### interface/ 类型定义

| 文件 | 职责 |
|------|------|
| `src/interface/Account.ts` | 账号结构（含代理、指纹保留、2FA 字段） |
| `src/interface/Config.ts` | 全局配置结构（workers 开关、搜索设置、webhook 等） |
| `src/interface/DashboardData.ts` | Dashboard REST 数据（活动项、计数器、促销类型） |
| `src/interface/AppDashBoardData.ts` / `AppUserData.ts` | App 端 Dashboard / 用户数据 |
| `src/interface/PanelFlyoutData.ts` | 新版 UI 面板弹出数据（Server Actions 用） |
| `src/interface/XboxDashboardData.ts` | Xbox 面板数据 |
| `src/interface/Points.ts` | 可赚取积分结构 |
| `src/interface/QuizData.ts` | 测验数据（题目/选项/完成态） |
| `src/interface/Search.ts` | 搜索源响应类型（Google/趋势/Reddit/Wikipedia） |
| `src/interface/ActivityHandler.ts` | 活动处理器契约 |
| `src/interface/UserAgentUtil.ts` | Chrome/Edge 版本数据结构 |

### logging/ 日志与通知

| 文件 | 职责 |
|------|------|
| `src/logging/Logger.ts` | 日志：控制台着色（chalk）+ 写入 `logs/YYYY-MM-DD.log` + 集群 IPC 转发 + 过滤（LogFilter） |
| `src/logging/Discord.ts` | Discord webhook（p-queue 队列化发送+flush） |
| `src/logging/Ntfy.ts` | ntfy.sh webhook |
| `src/logging/PushPlus.ts` | PushPlus 微信推送（运行摘要） |

### util/ 工具

| 文件 | 职责 |
|------|------|
| `src/util/Load.ts` | 加载 accounts.json / config.json（Zod 校验后缓存），会话（cookies/指纹）读写 |
| `src/util/Validator.ts` | Zod schema：validateAccounts / validateConfig；checkNodeVersion（semver 版本检查） |
| `src/util/Axios.ts` | 带代理的 HTTP 客户端（http/https/socks5 代理，axios-retry 重试） |
| `src/util/ErrorDiagnostic.ts` | 错误诊断：出错时保存页面截图 + DOM 快照到 diagnostics/ |
| `src/util/Utils.ts` | 通用工具：ms 时长解析、chunkArray、wait、邮箱用户名提取、随机延迟 |

---

## 运维脚本（scripts/）

| 文件 | 职责 |
|------|------|
| `scripts/utils.js` | 共享工具（ESM）：路径解析（getDirname/getProjectRoot）、配置/账号加载、参数解析、cookies/指纹加载、代理构造、清理钩子 |
| `scripts/main/browserSession.js` | 浏览器会话管理 CLI（`npm run open-session`）：为指定账号打开浏览器/加载会话/注入指纹 |
| `scripts/main/clearSessions.js` | 清理会话 CLI（`npm run clear-sessions`）：按 config.sessionPath 删除全部账号会话目录 |
| `scripts/docker/entrypoint.sh` | Docker 容器入口：设置 PLAYWRIGHT_BROWSERS_PATH、每日调度 |
| `scripts/docker/run_daily.sh` | Docker 每日运行脚本（TZ 时区、循环调度） |
| `scripts/mac/mac_script.sh` | macOS 启动脚本（随机延迟后 npm start） |
| `scripts/mac/local.npm-start.plist` / `local.npm-start.example.plist` | macOS launchd 开机/定时任务 plist |

## 测试

项目无测试框架依赖（`package.json` 无 `test` 脚本、无 Jest/Vitest）。两套测试均零依赖：

- 日志对拍测试：`node test/script/run-log-tests.js`（**需先准备 `test/data/`，该目录被 .gitignore 排除**）
- GUI 自动化测试：`node --test --test-isolation=none test/gui/unit.test.js test/gui/api.test.js test/gui/resilience.test.js`
  （必须加 `--test-isolation=none`：`node --test` 默认为每个测试文件 spawn 子进程，受限环境会 EPERM；同进程模式亦是覆盖率采集前提）
- 覆盖率：`$env:NODE_V8_COVERAGE="$env:TEMP\gui-cov"` 跑上述命令后 `node test/gui/coverage-report.js "$env:TEMP\gui-cov"`

| 文件 | 职责 |
|------|------|
| `test/script/run-log-tests.js` | 日志导入（解析）+ 分析（统计）测试：`node test/script/run-log-tests.js`，零依赖（node:assert），数据源 `test/data/logs-20260819-125022/`（7 份日志）；含独立参考实现（split 法解析 + 逐账户聚合）与被测 `logger.js`/`summary.js` 交叉对拍，动态生成期望值（2026-08-19 新增；2026-08-22 参考实现升级为「运行段粒度」口径，与 generateSummary 修复同步） |
| `test/gui/helpers/sandbox.js` | GUI 测试基础设施：把 `gui/` 复制到 `os.tmpdir()` 沙箱并伪造 `config.json`/`accounts.json`/`logs/`/`src/*.example.json`（**因 `lib/config.js` 用 `__dirname` 推导 ROOT，只能靠同构目录实现隔离**，从而保证仓库文件零改动）；含跨时区稳定的日志夹具（3 天/251 分）、进程内启服务（劫持 `http.createServer` 捕获实例以便可靠 close）、HTTP 助手、手写 store 模式 zip 生成器（CRC32，用于导入与 zip slip 用例）；复制过滤器排除 cache 与 `.bak`/`.bak.*` 历史备份（2026-08-21 更新）；引入本地 Token 鉴权后按 base 惰性缓存令牌并自动注入请求头（`auth:false` 可关闭），`waitForServer` 探测令牌接口（2026-08-21） |
| `test/gui/unit.test.js` | 49 用例：`validator`（异常输入/边界值）、`httpUtils`（100MB 上限/断连/循环引用）、`logger`（CRLF/超长行/穿越）、`summary`（统计口径/脏数据）、`archive`（tmp 唯一性/压缩往返）、`logCache`（新鲜度快照/损坏重建）；2026-08-21 新增 U-A04（archive 源码不得拼接路径）、U-C06（缓存 7 天清理），共 53 用例 |
| `test/gui/api.test.js` | 73 用例：25 个 HTTP 接口的正常/边界/异常输入 + 方法校验 + zip 导入导出与 zip slip 防护 + 并发压力（50 并发读、20 并发写、10 并发新增账号、客户端中断、8MB 大包）；2026-08-21 起含 I-SEC01~10（Token 鉴权/CORS/脱敏）与 I-P03 写锁确定性占锁用例、I-C16（bak 轮转）、I-L05b（summary/:date 方法校验），共 86 用例 |
| `test/gui/resilience.test.js` | 18 用例：脏数据下的异常逃逸（直调路由判定"是否会终止进程"）、服务端 500 降级、前端 `escapeHtml`/`fetchJson` 提取后实测、SSE 保活与 `/api/shutdown` 生命周期（劫持 `process.exit` 观测，不真正退出）；2026-08-21 起 R-F03/R-F04（前端超时/轮询退避守护网）转绿，另含 R-L01b（无令牌 keepalive 401）、R-L05/R-L06（单实例保护）；2026-08-23 起 R-L03 由「断开超 5s 静默期触发退出」反转为「断开后服务保持存活（常驻模式）」，共 23 用例 |
| `test/gui/coverage-report.js` | 覆盖率聚合：内置 `--experimental-test-coverage` 只统计 cwd 内文件（沙箱在 tmp 下故为空），本脚本解析 `NODE_V8_COVERAGE` 原始数据并把沙箱路径映射回 `gui/` 源文件，多沙箱取并集输出 Markdown 表 |

## 根目录配置

| 文件 | 职责 |
|------|------|
| `package.json` | 主脚本 v3.1.6.4；scripts：build/start/dev/lint/format/clear-sessions/open-session/create-docker；Node ≥24；新增 `test` 脚本（`node --test --test-isolation=none test/gui/*.test.js`，2026-08-21） |
| `tsconfig.json` | TypeScript 编译配置 |
| `eslint.config.mjs` / `.prettierrc` | 代码规范（ESLint 10 + Prettier 3） |
| `Dockerfile` / `compose.yaml` / `.dockerignore` | Docker 构建与编排（`npm run create-docker`） |
| `env.example` | 环境变量示例 |
| `run.bat` / `setup.bat` | Windows 一键安装/运行 |
| `diagnose-cron.sh` | Linux 定时任务诊断脚本 |

## 变更记录

> GUI（`gui/`）相关的变更记录已于 2026-08-20 分离至 **`gui/CHANGELOG.md`**（含启动脚本、前端动效、收益口径、GUI 测试套件等 13 条）。
> 本表仅记录仓库级 / 非 GUI 的改动。

| 日期 | 内容 |
|------|------|
| 2026-08-21 | **`package.json`/`setup.bat` 保持与上游一致，安装问题改由 GUI 侧解决**：npm 11.17 中 `npm run` 嵌套 `npm i` 会因用户级 `.npmrc` 的 `allow-scripts` 配置误报 EALLOWSCRIPTS（上游环境无此配置故 setup.bat 正常）。非 GUI 文件（`package.json`/`setup.bat`）已回滚至上游版本零差异；改为 `gui/lib/routes/system.js` 的 `/api/setup` 在 spawn `setup.bat` 前注入剔除 `allow-scripts` 的干净 `NPM_CONFIG_USERCONFIG`（详见 `gui/CHANGELOG.md` 同日条目） |
| 2026-08-21 | **次要问题收尾：P2 清零 + 工程化补全**（详见 `gui/CHANGELOG.md` 同日条目）：D18 前端超时/轮询退避（R-F03/R-F04 转绿，测试 157 用例全绿）、HTTP 服务超时、日志接口 405 补全、archive 路径拼接注入修复、`package.json` test 脚本、`.bak` 轮转（保留最近 5 个）与 cache 7 天清理 |
| 2026-08-21 | **安全加固：本地 Token 鉴权 + 配置写锁 + 单实例保护**（详见 `gui/CHANGELOG.md` 同日条目） |
| 2026-08-19 | `.gitignore` 再调整（检查报告确认）：①删除 `/.agents` 规则——`.agents/skills/rewards-server-actions/` 技能文件与 `skills-lock.json` 需保留追踪，原忽略规则与现状矛盾；②`Microsoft-Rewards-Script.rar` 改通用 `*.rar`；③新增 `scripts/mac/mac的运行脚本`（中文名说明文件，`git rm --cached` 移出索引，本地保留）、`更新同步原项目.txt`（本地 git 命令备忘，同上）、`test/data/`（测试日志含真实邮箱，不提交） |
