/**
 * 系统路由（POST /api/shutdown、GET /api/stats|/api/summary、GET /api/keepalive、POST /api/setup）
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

// ===== 服务常驻（2026-08-23）：不再"页面断开即退出" =====
// 原设计：所有 SSE 保活连接断开后进入 5s 静默期，超时无新连接则 process.exit(0) 自杀。
// 问题：Edge 的「睡眠标签页 / 内存节省器」会整体冻结后台标签页（页面 JS 定时器与网络
// 连接全部挂起），SSE 连接断开后页面无法执行退避重连，5s 静默期走完服务即被"清掉"，
// 且静默启动模式下无窗口、完全无感知。
// 改为：keepalive 断开仅记日志，服务常驻；停止方式仅剩 /api/shutdown、stop-gui.bat、Ctrl+C。
let activeKeepaliveConnections = 0 // 当前活跃的 keepalive 连接数（支持多标签页，仅用于日志）

function handleSystem(req, res, pathname, ctx) {
    const { http, logCache } = ctx

    // POST /api/shutdown（先返回响应，延迟 500ms 退出）
    if (pathname === '/api/shutdown' && req.method === 'POST') {
        console.log('[GUI] 收到关闭请求，500ms 后退出服务...')
        const data = { success: true, message: '服务正在关闭...' }
        http.sendJson(res, 200, data)
        setTimeout(() => {
            console.log('[GUI] 服务已退出')
            process.exit(0)
        }, 500)
        return true
    }

    // POST /api/setup（运行根目录 setup 程序：安装依赖 + 构建环境）
    // 异步非阻塞：cmd /c start /min 开独立最小化窗口，detached + unref 与 GUI 进程解耦，
    // HTTP 立即响应，GUI 界面不会卡顿；stdio:ignore 完全丢弃子进程输出，不污染 GUI。
    // 冲突防护：任务运行中时 setup 的构建步骤（rimraf dist）可能中断任务子进程，
    // 前端已做警告确认（见 app.js setupEnvironment）。
    // 注意：必须「先 sendJson 再 return true」——sendJson 无返回值，
    // 若写成 return http.sendJson(...) 会返回 undefined（falsy），
    // 导致 server.js 路由分发继续走到 404 兜底对已响应 res 二次 writeHead → ERR_HTTP_HEADERS_SENT。
    if (pathname === '/api/setup' && req.method === 'POST') {
        const setupBat = path.join(ctx.config.ROOT, 'setup.bat')
        if (!fs.existsSync(setupBat)) {
            http.sendJson(res, 400, { error: '未找到 setup.bat（项目根目录）' })
            return true
        }
        try {
            // 环境修复（2026-08-21）：本机用户级 ~/.npmrc 若含 allow-scripts 配置（开发环境注入，
            // 上游环境无此配置），setup.bat 内「npm run 嵌套 npm i」会把继承的
            // npm_config_allow_scripts 环境变量误判为 --allow-scripts 标志而报 EALLOWSCRIPTS。
            // 此处 spawn 前剔除 allow-scripts 行、写入临时 userconfig 并注入 NPM_CONFIG_USERCONFIG，
            // 不改动任何上游/仓库文件即可让「安装环境」正常跑通。
            const env = { ...process.env }
            const userNpmrc = path.join(os.homedir(), '.npmrc')
            try {
                if (fs.existsSync(userNpmrc)) {
                    const cleaned = fs.readFileSync(userNpmrc, 'utf-8')
                        .split(/\r?\n/)
                        .filter(line => !/^allow-scripts(\[\]|=)/i.test(line.trim()))
                        .join('\n')
                    const tmpNpmrc = path.join(os.tmpdir(), `gui-setup-npmrc-${process.pid}.npmrc`)
                    fs.writeFileSync(tmpNpmrc, cleaned ? cleaned + '\n' : '', 'utf-8')
                    env.NPM_CONFIG_USERCONFIG = tmpNpmrc
                }
            } catch (e) {
                console.warn(`[GUI] 生成安装用 npm 配置失败（回退默认配置）: ${e.message}`)
            }

            const child = spawn('cmd', ['/c', 'start', '', '/min', 'setup.bat'], {
                cwd: ctx.config.ROOT, // setup.bat 内相对路径（npm/npx）基于项目根目录
                detached: true,
                stdio: 'ignore',
                env
            })
            child.unref() // GUI 进程退出不影响 setup 继续
            console.log('[GUI] 已启动安装环境（setup.bat）')
            http.sendJson(res, 200, { success: true, message: '安装环境已在独立最小化窗口启动，请等待其完成' })
            return true
        } catch (e) {
            http.sendJson(res, 500, { error: `启动 setup 失败: ${e.message}` })
            return true
        }
    }

    // GET /api/stats | /api/summary（日志统计摘要：读预生成缓存，新鲜则零解析成本）
    // 方法校验（2026-08-20）：读接口不应响应写方法
    if (pathname === '/api/stats' || pathname === '/api/summary') {
        if (req.method !== 'GET') {
            http.sendJson(res, 405, { error: `仅支持 GET ${pathname}` })
            return true
        }
        http.sendJson(res, 200, logCache.getCachedData().summary)
        return true
    }

    // GET /api/keepalive（SSE 长连接保活；服务常驻，连接断开不触发退出）
    // 连接计数保留仅用于日志：支持多标签页/刷新时的并行连接，全部断开时提示常驻状态
    if (pathname === '/api/keepalive') {
        if (req.method !== 'GET') {
            http.sendJson(res, 405, { error: '仅支持 GET /api/keepalive' })
            return true
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        })
        res.write(': connected\n\n')
        activeKeepaliveConnections++
        req.on('close', () => {
            activeKeepaliveConnections--
            if (activeKeepaliveConnections <= 0) {
                console.log('[GUI] 所有页面已断开保活连接，服务继续常驻运行')
            }
        })
        return true
    }

    return false
}

module.exports = handleSystem