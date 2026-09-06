/**
 * Microsoft-Rewards-Script GUI 控制台入口（模块化后）
 * 业务逻辑已拆分至 lib/，本文件仅负责：组装 ctx + 路由分发 + CLI + 启动
 */
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')

// ===== 依赖模块 =====
const config = require('./lib/config')
const httpUtils = require('./lib/httpUtils')
const validator = require('./lib/validator')
const logger = require('./lib/logger')
const summary = require('./lib/summary')
const archive = require('./lib/archive')
const taskManager = require('./lib/taskManager')
const logCache = require('./lib/logCache')

// ===== 路由处理器（统一签名 (req,res,pathname,ctx)=>boolean，true=已处理） =====
const rStatic = require('./lib/routes/static')
const rConfig = require('./lib/routes/config')
const rAccounts = require('./lib/routes/accounts')
const rLogs = require('./lib/routes/logs')
const rSessions = require('./lib/routes/sessions')
const rData = require('./lib/routes/data')
const rTasks = require('./lib/routes/tasks')
const rSystem = require('./lib/routes/system')

// ===== 共享上下文（注入依赖，规避循环 require） =====
const ctx = { config, http: httpUtils, validator, logger, summary, archive, taskManager, logCache }
const routes = [rStatic, rConfig, rAccounts, rSessions, rData, rTasks, rLogs, rSystem]

// ===== 本地 Token 鉴权（2026-08-21） =====
// 每次启动生成一次性随机令牌（256 位 hex）。除 /api/auth/token 外，所有 /api/* 请求
// 必须携带 X-Auth-Token（SSE 的 EventSource 无法自定义请求头，/api/keepalive 额外支持
// ?token= 查询参数）。配合移除 CORS *：跨站网页既读不到 token 接口的响应，也调不动其他接口。
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex')

// ===== HTTP 服务：鉴权 → 按序分发，未命中返回 404 =====
// 异常兜底（2026-08-20）：路由内未捕获的异常若逃逸到这里，会成为进程级 uncaughtException
// 直接终止 GUI 服务（脏 accounts.json、缓存目录被占位等场景均可触发）。统一转 500 响应，服务保持存活。
const server = http.createServer((req, res) => {
    let pathname = req.url
    try {
        const urlObj = new URL(req.url, `http://localhost:${config.PORT}`)
        pathname = urlObj.pathname

        // Token 获取接口：免鉴权（前端页面加载时第一个调用它）
        if (pathname === '/api/auth/token') {
            httpUtils.sendJson(res, 200, { token: AUTH_TOKEN })
            return
        }
        // 鉴权中间件：所有 /api/* 统一校验（静态资源与非 API 路径不受影响）
        if (pathname.startsWith('/api/')) {
            const provided = req.headers['x-auth-token'] || urlObj.searchParams.get('token') || ''
            if (provided !== AUTH_TOKEN) {
                httpUtils.sendJson(res, 401, { error: '未授权：访问令牌缺失或不正确' })
                return
            }
        }

        for (const route of routes) {
            const handled = route(req, res, pathname, ctx)
            if (handled) {
                // 异步路由（async IIFE）返回 Promise：补 reject 兜底，
                // 避免未处理拒绝 + 客户端永久挂起
                if (typeof handled.then === 'function') {
                    handled.catch(err => {
                        console.error(`[GUI] 异步路由异常 ${pathname}:`, err)
                        if (!res.writableEnded) {
                            httpUtils.sendJson(res, 500, { error: `服务器内部错误: ${err.message}` })
                        }
                    })
                }
                return
            }
        }
        // 防御：若某路由已发送响应但返回了 falsy（未遵守「返回 true=已处理」契约），
        // 跳过 404 兜底，避免对已结束的 res 二次 writeHead 抛 ERR_HTTP_HEADERS_SENT 导致进程崩溃
        if (!res.writableEnded) {
            httpUtils.sendJson(res, 404, { error: `未知接口: ${pathname}` })
        }
    } catch (err) {
        console.error(`[GUI] 请求处理异常 ${pathname}:`, err)
        if (!res.writableEnded) {
            httpUtils.sendJson(res, 500, { error: `服务器内部错误: ${err.message}` })
        }
    }
})

// ===== CLI 模式：node gui/server.js --generate-summary =====
if (process.argv.includes('--generate-summary')) {
    const s = summary.generateSummary()
    const target = summary.writeSummaryFile(s, path.join(config.GUI_DIR, 'summary.json'))
    if (target) {
        console.log(`\n统计摘要已写入 ${target}`)
        console.log(`共 ${s.daily.length} 天数据，总计 ${s.grandTotal} 积分`)
        console.log(`账号统计: ${JSON.stringify(s.accountTotals, null, 2)}`)
    }
    process.exit(0)
}

// ===== HTTP 超时配置（2026-08-21）：防慢速攻击 =====
// 未设置时 Node 默认 headersTimeout=60s、无 requestTimeout，慢速客户端可长期占用连接。
// keepAliveTimeout 需大于 headersTimeout；SSE 保活连接处于响应进行中，不受这些超时约束。
server.headersTimeout = 20000
server.requestTimeout = 60000
server.keepAliveTimeout = 65000

// ===== 进程级单实例保护（2026-08-21） =====
// 方案：项目根目录写入 .gui.pid 记录进程号，启动前检测已有存活实例。
// 不依赖 EADDRINUSE：Windows 上 SO_REUSEADDR 语义允许第二个进程重复 bind 同一端口，
// 端口检测会漏判，多开实例并发写同一批文件会造成物理损坏。
const PID_FILE = path.join(config.ROOT, '.gui.pid')

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        return e.code === 'EPERM' // 无权限发信号但进程存在
    }
}

if (fs.existsSync(PID_FILE)) {
    const prevPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10)
    if (isProcessAlive(prevPid)) {
        console.error(`[GUI] 检测到已有 GUI 实例在运行（PID ${prevPid}），为防止配置文件并发损坏，本次启动已取消。`)
        console.error(`[GUI] 如需重启，请先关闭已有实例（运行 stop-gui.bat）；确认无实例后可删除 ${PID_FILE} 重试。`)
        process.exit(1)
    }
    // pid 文件残留（上次被 taskkill /f 强杀，exit 钩子未执行）：进程已死，直接覆盖
}
fs.writeFileSync(PID_FILE, String(process.pid))
// 正常退出时清理 pid 文件；强杀残留由下次启动的存活检测兜底
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch {} })

// EADDRINUSE 兜底（Linux/macOS 等严格 bind 语义的平台）：端口被非 GUI 进程占用时同样友好退出
server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[GUI] 端口 ${config.PORT} 已被占用：GUI 可能已在运行中，请勿重复启动。`)
        console.error(`[GUI] 如需重启，请先关闭已有实例（或运行 stop-gui.bat），或修改 gui/gui-settings.json 的端口。`)
    } else {
        console.error('[GUI] 服务启动失败:', err)
    }
    process.exit(1)
})

// ===== 启动 =====
server.listen(config.PORT, () => {
    console.log(`Microsoft-Rewards-Script 控制台已启动: http://localhost:${config.PORT}`)
    console.log(`账号文件: ${config.resolveAccountsPath()}`)
    console.log(`配置来源: ${config.resolveConfigPath()}`)
    console.log(`日志目录: ${config.LOGS_DIR}`)
})