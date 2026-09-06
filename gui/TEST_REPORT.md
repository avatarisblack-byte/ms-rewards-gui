# GUI 自动化测试与缺陷修复报告

**报告日期**：2026-08-20
**被测对象**：`gui/`（Microsoft Rewards Script GUI 控制台：零依赖 Node HTTP 服务 + 原生前端）
**测试范围**：`gui/server.js`、`gui/lib/**`（8 个模块 + 8 个路由）、`gui/js/app.js`
**运行环境**：Windows / Node v24.19.0 / npm 11.17.0（`node_modules` 未安装，故 ESLint 未参与）

> 相关文档：目录结构与接口清单见 `doc/CODE_MAP.md`；变更历史见 `gui/CHANGELOG.md`；使用说明见 `gui/README.md`。

---

## 一、结论速览

| 阶段 | 用例总数 | 通过 | 失败 | 行覆盖 | 函数覆盖 |
|------|---------|------|------|--------|---------|
| 初始基线（未改代码） | 140 | 109 | 31 | 82.3% | 94.1% |
| P0 修复后（8 项） | 140 | 126 | 14 | 82.1% | 94.3% |
| **P1 修复后（7 项）** | **140** | **138** | **2** | **82.4%** | **94.4% (51/54)** |

- 定位缺陷 **18 项**，已修 **16 项**（含 1 项顺带闭合的目录穿越面），剩余 **2 项**属前端 P2 未排期。
- 修复涉及 `gui/` 下 **12 个文件**，累计 +282/-84（含文档与测试）。
- 两轮浏览器真机验证均通过（存储型 XSS、事件委托、设置保存链路）。

---

## 二、测试工程

### 2.1 起点：既有测试无法运行

| 项目 | 状况 |
|------|------|
| 声明的测试框架 | **无**（`package.json` 无 `test` 脚本，无 Jest/Vitest/Mocha） |
| 既有测试 | `test/script/run-log-tests.js`（自制断言，零依赖） |
| 执行结果 | **崩溃，0 个用例执行**：`ENOENT: scandir 'test/data/logs-20260819-125022'` |
| 根因 | 数据源目录被 `.gitignore:30` 排除，任何新克隆的仓库都无法运行 |

### 2.2 新建测试套件（`test/gui/`）

选用 Node 24 内置 `node:test`——零新增依赖，且可产出覆盖率。

| 文件 | 用例数 | 覆盖内容 |
|------|-------|---------|
| `test/gui/unit.test.js` | 49 | validator 边界值、httpUtils（100MB 上限/断连/循环引用）、logger（CRLF/超长行/穿越）、summary（统计口径/脏数据）、archive（tmp 唯一性/压缩往返）、logCache（快照新鲜度/损坏重建） |
| `test/gui/api.test.js` | 73 | 25 个 HTTP 接口的正常/边界/异常输入、方法校验、zip 导入导出与 zip slip 防护、并发压力（50 并发读 / 20 并发写 / 10 并发新增账号 / 客户端中断 / 8MB 大包） |
| `test/gui/resilience.test.js` | 18 | 脏数据异常逃逸、服务端 500 降级、前端函数提取实测、SSE 静默期与 shutdown 生命周期 |
| `test/gui/helpers/sandbox.js` | — | 沙箱、日志夹具、HTTP 助手、手写 store 模式 zip 生成器（含 CRC32） |
| `test/gui/coverage-report.js` | — | V8 原始覆盖率聚合（内置工具不统计 cwd 外的沙箱路径） |

### 2.3 三个关键设计决策

1. **沙箱隔离**：`gui/lib/config.js` 用 `__dirname` 推导 `ROOT`，无法用环境变量重定向；且仓库根无 `config.json`/`accounts.json`，写接口会回落到 **`src/*.example.json`**。因此把 `gui/` 复制到 `os.tmpdir()` 并构造同构目录（`config.json`/`accounts.json`/`logs/`/`src/*.example.json`），实现仓库文件零改动——全程 `git status` 仅显示新增文件。
2. **崩溃判定方式**：`server.js` 的分发循环原先没有 `try/catch`，路由内逃逸的异常等价于进程终止。故对同步路径**直调路由函数**并用 `assert.doesNotThrow` 判定，既精确又不会杀掉测试进程。
3. **生命周期可测**：`/api/keepalive` 静默期与 `/api/shutdown` 都会调 `process.exit`。测试中劫持 `process.exit` 为记录函数（且不再恢复，避免残留定时器在收尾阶段终止测试进程），从而完整验证「刷新不掉线 / 5s 后退出 / 先响应再退出」。

### 2.4 运行方式

```powershell
# 全量（必须加 --test-isolation=none：node --test 默认为每个文件 spawn 子进程）
node --test --test-isolation=none test/gui/unit.test.js test/gui/api.test.js test/gui/resilience.test.js

# 覆盖率
$env:NODE_V8_COVERAGE="$env:TEMP\gui-cov"
node --test --test-isolation=none test/gui/unit.test.js test/gui/api.test.js test/gui/resilience.test.js
Remove-Item Env:\NODE_V8_COVERAGE
node test/gui/coverage-report.js "$env:TEMP\gui-cov"
```

---

## 三、缺陷与修复清单

### 3.1 P0：致命 / 严重（8 项方案，覆盖 D01～D09）

| 缺陷 | 级别 | 现象与根因 | 修复 | 验证用例 |
|------|------|-----------|------|---------|
| D01 脏 `accounts.json` 崩溃 | 致命 | `routes/accounts.js` GET 分支 `a.email.split('@')` 无防御、无 `Array.isArray` 校验；`server.js` 分发无 `try/catch`，异常升级为 uncaughtException 终止进程 | 分发层 `try/catch` + 异步路由 Promise 兜底（统一 500）；GET 分支补数组与 email 类型校验 | `R-X01` `R-X02` `R-X03` |
| D02 缓存故障崩溃 | 致命 | `logCache.generateCache` 的 mkdir/write/rename 无异常处理，`/api/stats` 同步调用 → 缓存目录被占位即崩溃 | `getCachedData` 包 `try/catch`，降级空摘要 + 告警 | `R-X05` |
| D03 `escapeHtml` 失效 → 存储型 XSS | 严重 | `app.js` 四个 `replace` 的**替换目标与源字符相同**（HTML 实体被反解析）→ 等同未转义；账号邮箱与日志消息经 `innerHTML` 渲染；`onclick="fn('${email}')"` 拼接用户数据 | 恢复真实实体转义并补 `'`；按钮改 `data-email` + 事件委托（HTML 属性先实体解码再作 JS 解析，实体转义防不住注入） | `R-F01` `R-F02` |
| D04 按日期查日志恒空 | 严重 | `logger.readLogFile` 未补 `.log` 后缀，读取必然失败且被 `catch` 静默吞掉 | 补后缀 + `YYYY-MM-DD` 白名单校验 | `I-L03` `U-L07` |
| D05 CRLF 日志统计归零 | 严重 | 正则末尾 `(.*)$`，**JS 中 `.` 不匹配 `\r`**，导入的 Windows 日志每行残留 `\r` → 整行被丢弃 | 解析前 `line.replace(/\r+$/, '')` | `U-L04` `U-L10` |
| D06 任务启动并发竞态 | 严重 | 互斥仅靠 `taskProcess && !killed`；子进程 `exit` 回调置空后并发请求可再次通过 → 实测 5 并发有 **2 个成功** | `isRunning()` 改用 `exitCode/signalCode`；加 `starting` 互斥 + 3s 节流；`stopTask` 重置节流 | `I-T04` |
| D07 GET 可启停任务 | 严重 | `routes/tasks.js` 仅判断 `pathname` 未校验 `req.method`；配合 CORS `*` 与无鉴权，预取/爬虫/跨站页面均可触发 | start/stop/task 补方法校验返回 405 | `I-T02` `I-T03` |
| D08 读接口无方法校验 | 一般 | `/api/logs`、`/api/stats`、`/api/summary`、`/api/keepalive` 任意方法都命中读取分支 | 四个接口补方法校验 | `I-L05` `I-Y03` |
| D09 配置保存空引用 | 严重 | `routes/config.js` 合并时读 `current.searchSettings.chinaApi`，缺该键即抛 `TypeError`（相邻三行都写了 `\|\| {}`，此处漏掉） | 提取 `curSS = current.searchSettings \|\| {}` | `I-C13` |
| D16 日志读取目录穿越 | 一般 | `readLogFile` 的 `dateStr` 直接进 `path.join`，`'../leak.log'` 可读 `logs/` 外文件 | 由 D04 的白名单校验一并闭合 | `U-L08` |

### 3.2 P1：健壮性与数据安全（7 项方案，覆盖 D10～D17）

| 缺陷 | 级别 | 现象与根因 | 修复 | 验证用例 |
|------|------|-----------|------|---------|
| D12 账号字段无边界 | 一般 | 仅 `typeof` + `includes('@')`；5000 字符邮箱、含 `\n\t` 的邮箱、含 HTML 片段的邮箱、`port=-1/70000` 均可落盘 | email 加 ≤254（RFC 5321）、禁空白/控制字符、禁 `< > " ' \` &`；port 收紧为 0-65535 整数 | `U-V10~12` `I-A06~08` |
| D10 保存端口丢设置 | 一般 | `writeGuiSettings({port})` 整体覆盖文件，清除其他 GUI 设置 | 改为 `{ ...readGuiSettings(), ...settings }` 合并写入 | `I-G05` |
| D11 未知配置字段落盘 | 一般 | 校验是「已知字段类型检查」而非白名单，任意键值经 `{...current, ...body}` 落盘 | 新增 `ALLOWED_TOP_LEVEL`（源自 `src/config.example.json` 的 14 个顶层键），未知字段 400 | `I-C11` |
| D13 `readBody` 无超时 | 一般 | 只监听 `data/end/error`，客户端断网（`aborted`/`close` 无 `end`）时 Promise 永不 settle，请求体内存无法释放 | 补 `aborted`/`close` 监听 + 30s 超时，`settled` 标志保证只结算一次 | `U-H07` |
| D14 `sendJson` 序列化抛错 | 一般 | `JSON.stringify` 抛错时 `res` 永不 `end`，客户端挂起且异常冒泡到分发层 | 包 `try/catch` 并降级 500 | `U-H08` |
| D15 临时目录碰撞 | 一般 | `Date.now()+pid` 拼接，实测 **2000 次调用仅 11 个唯一值**；并发导入/导出互相覆盖 zip 并删除对方目录 | 改用 `fs.mkdtempSync` | `U-A01` |
| D17 统计层缺字段抛错 | 提示 | `summarizeLogs` 直接 `e.message.match(...)`，残缺条目抛 `TypeError` | 取 `const msg = e.message \|\| ''` 后再匹配 | `U-S09` |

### 3.3 未修复（P2，等待排期）

> 更新（2026-08-21）：D18 已修复——`fetchJson` 加 `AbortSignal.timeout(15000)`，两处轮询改自调度 `setTimeout` + in-flight 锁 + 失败计数指数退避（任务 5s→10s→20s→40s→60s、数据 30s→60s→120s 封顶）；SSE 保活改手动退避重连（`onerror` 主动 `close()` 阻止浏览器内置 ~2.5s 固定重连，实测 60s 窗口重连次数从 ~25 次降至 ~3 次）。守护用例 `R-F03`/`R-F04` 已转绿。**P2 清单清零**。

| 缺陷 | 级别 | 位置 | 说明 |
|------|------|------|------|
| ~~D18 前端无超时 / 轮询无退避~~ **已修复（2026-08-21）** | 提示 | `gui/js/app.js:23`（`fetchJson`）、`:1495`/`:1498`（两个 `setInterval`） | 断网时 fetch 永不 settle、界面停留加载态；轮询持续叠加请求。本轮浏览器验证时**实证了该危害**：旧会话（3004 端口，服务已关）每 5s 无限重试并把控制台刷满。对应用例 `R-F03` `R-F04` 曾保持失败状态作为待办守护网，现已转绿 |

---

## 四、修复后覆盖率

| 文件 | 可执行行 | 已覆盖行 | 行覆盖率 | 函数覆盖率 |
|------|---------|---------|---------|-----------|
| `gui/lib/summary.js` | 118 | 117 | 99.2% | 100.0% (5/5) |
| `gui/lib/logCache.js` | 54 | 53 | 98.1% | 100.0% (6/6) |
| `gui/lib/logger.js` | 36 | 35 | 97.2% | 100.0% (3/3) |
| `gui/lib/routes/logs.js` | 101 | 94 | 93.1% | 100.0% (3/3) |
| `gui/lib/httpUtils.js` | 43 | 40 | 93.0% | 100.0% (4/4) |
| `gui/lib/routes/accounts.js` | 111 | 103 | 92.8% | 100.0% (3/3) |
| `gui/lib/validator.js` | 39 | 36 | 92.3% | 100.0% (1/1) |
| `gui/lib/routes/tasks.js` | 24 | 22 | 91.7% | 100.0% (1/1) |
| `gui/lib/archive.js` | 23 | 21 | 91.3% | 100.0% (3/3) |
| `gui/lib/config.js` | 45 | 41 | 91.1% | 100.0% (6/6) |
| `gui/lib/routes/config.js` | 156 | 131 | 84.0% | 100.0% (2/2) |
| `gui/lib/routes/static.js` | 32 | 26 | 81.3% | 100.0% (1/1) |
| `gui/lib/routes/system.js` | 72 | 58 | 80.6% | 100.0% (3/3) |
| `gui/lib/taskManager.js` | 99 | 79 | 79.8% | 100.0% (6/6) |
| `gui/server.js` | 52 | 39 | 75.0% | — |
| `gui/lib/routes/sessions.js` | 92 | 59 | 64.1% | 66.7% (2/3) |
| `gui/lib/routes/data.js` | 120 | 49 | 40.8% | 50.0% (2/4) |
| **合计** | **1217** | **1003** | **82.4%** | **94.4% (51/54)** |

口径说明：基于 `NODE_V8_COVERAGE` 原始数据的近似行覆盖（跳过空行、纯注释、仅含括号的行）。`gui/js/app.js` 无 DOM 运行时未计入，其 `escapeHtml`/`fetchJson` 通过源码提取后实际执行验证。`server.js` 覆盖率下降属预期——新增的异常兜底分支已无异常可触发。

---

## 五、浏览器真机验证

自动化测试无法覆盖 DOM 渲染与事件绑定，故对前端改动做了两轮真机验证（沙箱服务 + 恶意数据）。

### 5.1 P0 验证：XSS 与事件委托

| 验证点 | 结果 |
|--------|------|
| `<img src=x onerror="window.__xss=1">@evil.com` 在首页与账号列表的渲染 | **以纯文本呈现**，未生成 `img` 元素、未触发 `onerror` |
| `quote'inject@evil.com` 的「详细设置」按钮 | **正常打开弹窗且邮箱完整传递**（旧实现下 `onclick` 内单引号闭合会导致 JS 语法错误、按钮彻底失效） |
| 页面 JS 错误 | 零错误 |
| 日志统计链路 | 总收益 251 pts 与夹具一致（CRLF/统计修复无回归） |

### 5.2 P1 验证：设置保存链路（白名单误伤排查）

白名单是本轮唯一可能打断正常功能的改动，做了两层核对：

1. **静态核对**：前端 `CONFIG_FIELD_MAP` 提交的 11 个顶层字段全部在 14 项白名单内；白名单还额外覆盖了原校验函数遗漏的 `clusters` 与 `webhook`。
2. **端到端实测**：切换「无头模式」开关 → 界面出现 **"✓ 已自动保存"**，`config.json` 的 `headless=true` 正确落盘、顶层字段无非法项；端口改为 31500 后 `gui-settings.json` 为 `{"port":31500,"theme":"dark"}`——**`theme` 未丢失**，方案 10 同步确认。

---

## 六、通过项中值得记录的既有优点

- **日志统计口径正确**：ACCOUNT-END 权威总计累加、同日多次运行合并、无 ACCOUNT-END 时回退活动积分、按本地时区归日（夹具 3 天 / 251 分逐账号精确匹配）。
- **zip 安全防护有效**：`../../evil.log` 穿越条目未能写出 `logs/`；Session 导入白名单只放行 `session_*.json`。
- **写操作备份与回滚**：`config.json`/`accounts.json` 写前 `.bak`，校验失败无落盘副作用。
- **并发写一致性**：10 个不同账号并发新增无丢失，同账号并发新增仅 1 次成功。
- **静默期优雅降级**：SSE 断开 2s 内重连不退出、全断开 5s 后退出、`/api/shutdown` 先响应再退出。
- **损坏 JSON 容错**：`config.json`/`accounts.json` 内容损坏均返回 500 而非崩溃。

---

## 七、遗留风险

> 更新（2026-08-21）：风险 #1/#3 已在本轮安全加固中修复并新增回归用例守护（`api.test.js` 的 I-SEC01~10 与改造后的 I-P03、`resilience.test.js` 的 R-L01b/R-L05/R-L06），详见 `gui/CHANGELOG.md` 2026-08-21「安全加固」条目。
> 再更新（2026-08-21）：次要问题全部收尾——风险 #2/#4/#5/#7/#8 亦已修复（详见 `gui/CHANGELOG.md` 同日「次要问题收尾」条目），测试 157 用例 150 通过 0 失败（7 跳过为受限环境压缩用例），**遗留风险清单清零**（剩余 #6 覆盖盲区为持续改进项，非缺陷）。

| # | 风险 | 说明 |
|---|------|------|
| 1 | ~~无鉴权 + 明文凭据暴露（最高）~~ **已修复（2026-08-21）** | 全部接口无鉴权且 `Access-Control-Allow-Origin: *`；`GET /api/accounts` 原样返回 `password` 与 `totpSecret`。本机任意程序或网页即可读取全部账号凭据、启停任务、覆盖配置。现已实现：本地随机 Token 鉴权（`X-Auth-Token`，SSE 走 `?token=`）+ CORS `*` 移除 + 凭据脱敏 + PUT 脱敏占位符防覆盖 |
| 2 | ~~HTTP 服务无超时设置~~ **已修复（2026-08-21）** | 未设 `headersTimeout`/`requestTimeout`/`keepAliveTimeout`，慢速客户端可长期占用连接。现已设 20s/60s/65s |
| 3 | ~~配置写并发无锁~~ **已修复（2026-08-21）** | 20 并发 `PUT /api/config` 全部 200（文件仍合法 JSON），但为「最后写入者胜」，多标签页会静默互相覆盖，`.bak` 也会被中间态覆盖。现已实现：`isWriting` 写互斥锁 + `setImmediate` 事件循环让出，写入期间并发请求返回 409；`POST /api/config/reset` 未纳入互斥（仅手动触发，小面） |
| 4 | ~~外部工具依赖与引号拼接~~ **已修复（2026-08-21）** | 导入导出依赖 `powershell.exe`/`unzip`；`archive.js` 以单引号拼接路径进 PowerShell 命令，临时目录路径含单引号会中断。现改经环境变量传递路径（依赖外部工具本身仍存在，但注入面已闭合） |
| 5 | ~~前端无超时与退避（D18）~~ **已修复（2026-08-21）** | 见 3.3 |
| 6 | 覆盖盲区（持续改进项，非缺陷） | `routes/data.js` 40.8%（一键导入的 accounts/config 分支与失败回滚分支未走到）、`routes/sessions.js` 64.1%；`/api/config/open` 与 `/api/setup` 的 spawn 成功分支（为避免真实弹出外部程序而未测）；`design-reference.html` 内联脚本与全部 DOM 渲染逻辑（2026-08-21 部分收敛：R-F05/R-F06 已守护 parseAccountEnd 解析与布局动线，沙箱双账号浏览器实测状态块渲染） |
| 7 | ~~既有测试仍不可复现~~ **已修复（2026-08-21）** | `test/data/` 被 `.gitignore` 排除，`test/script/run-log-tests.js` 在干净克隆上仍执行 0 用例；`package.json` 仍无 `test` 脚本。现已补 `"test": "node --test --test-isolation=none test/gui/*.test.js"`（`test/data/` 属日志对拍测试数据源，仍被排除，但不影响 GUI 套件可复现） |
| 8 | ~~缓存与备份文件无清理策略~~ **已修复（2026-08-21）** | `gui/cache/*.json`、各处 `*.bak`、导入生成的 `*.log.bak` 均无轮转。现新增 `lib/cleanup.js`：`.bak` 写前轮转 `.bak.<UTC时间戳>` 并每类保留最近 5 个（覆盖 accounts/config 全部写路径）；cache 目录 7 天前文件在 generateCache 后惰性清理 |

---

## 八、后续建议（按优先级）

1. ~~**鉴权与脱敏**~~：**已完成（2026-08-21）**——本地随机 Token 鉴权、CORS `*` 移除、`GET /api/accounts` 凭据脱敏均已落地并有回归用例守护。
2. ~~**前端超时与轮询退避**（D18）~~：**已完成（2026-08-21）**——`fetchJson` 15s 超时 + 轮询 in-flight 锁与指数退避，最后 2 个用例已转绿。
3. ~~**HTTP 超时**~~：**已完成（2026-08-21）**——`headersTimeout=20s / requestTimeout=60s / keepAliveTimeout=65s`。
4. ~~**配置写乐观锁**~~：**已完成（2026-08-21）**——`isWriting` 写互斥锁（写入期间并发请求 409），多客户端静默覆盖已杜绝。
5. ~~**测试可复现**~~：**已完成（2026-08-21）**——`package.json` 增 `"test": "node --test --test-isolation=none test/gui/*.test.js"`。
6. **补齐覆盖盲区**：`routes/data.js` 的一键导入分支与失败回滚、`routes/sessions.js` 导出路径；装好环境后可引入 jsdom/Playwright 覆盖 DOM 层。
7. ~~**`archive.js` 参数传递**~~：**已完成（2026-08-21）**——改用环境变量传递路径，不再引号拼接。
8. ~~**同类未动项**~~：**已完成（2026-08-21）**——`/api/logs/summary` 与 `/api/logs/:date` 已补 405。

---

## 附录：本轮改动文件

| 类别 | 文件 |
|------|------|
| 产品代码（15） | `gui/server.js`、`gui/js/app.js`、`gui/lib/config.js`、`gui/lib/httpUtils.js`、`gui/lib/validator.js`、`gui/lib/logger.js`、`gui/lib/summary.js`、`gui/lib/archive.js`、`gui/lib/logCache.js`、`gui/lib/taskManager.js`、`gui/lib/routes/accounts.js`、`gui/lib/routes/config.js`、`gui/lib/routes/logs.js`、`gui/lib/routes/system.js`、`gui/lib/routes/tasks.js` |
| 新增测试（5） | `test/gui/unit.test.js`、`test/gui/api.test.js`、`test/gui/resilience.test.js`、`test/gui/helpers/sandbox.js`、`test/gui/coverage-report.js` |
| 文档（3） | `doc/CODE_MAP.md`、`gui/CHANGELOG.md`、`gui/TEST_REPORT.md`（本文件） |
