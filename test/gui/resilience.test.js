/**
 * GUI 容错性、异常恢复与生命周期测试
 *
 * 运行：node --test --test-isolation=none test/gui/resilience.test.js
 *
 * 两种验证方式：
 *   1. 直调路由处理函数（同步路径）：可精确断言「异常是否逃逸出路由层」。
 *      server.js 的分发循环没有 try/catch，逃逸的异常在真实运行中会成为
 *      未捕获异常并终止整个 GUI 进程，因此 doesNotThrow 是等价的崩溃判定。
 *   2. 真实 HTTP 请求：验证错误场景下的响应码与服务存活。
 *
 * 生命周期用例会劫持 process.exit（记录而不真正退出），劫持不再恢复，
 * 以避免 shutdown 用例的退出调用在测试收尾阶段终止测试进程。
 */
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const H = require('./helpers/sandbox')

let SB = null
let srv = null
let BASE = ''
let ctx = null
let routeAccounts = null
let routeSystem = null

const ACCOUNTS = () => path.join(SB, 'accounts.json')
const CONFIG = () => path.join(SB, 'config.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function mockRes() {
    return {
        statusCode: null,
        headers: null,
        body: null,
        writableEnded: false,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this },
        write() { return true },
        end(body) { this.body = body; this.writableEnded = true; return this },
        on() { return this },
    }
}

before(async () => {
    SB = H.createSandbox('resilience')
    // 注意：gui/lib/config.js 在首次 require 时即固化 PORT，
    // 因此必须先设置 PORT 再加载任何 gui 模块，否则会回落到 gui-settings.json 的 3000 端口。
    const port = H.pickPort()
    process.env.PORT = String(port)
    ctx = {
        config: H.loadGuiModule(SB, 'lib/config'),
        http: H.loadGuiModule(SB, 'lib/httpUtils'),
        validator: H.loadGuiModule(SB, 'lib/validator'),
        logger: H.loadGuiModule(SB, 'lib/logger'),
        summary: H.loadGuiModule(SB, 'lib/summary'),
        archive: H.loadGuiModule(SB, 'lib/archive'),
        apiBridge: H.loadGuiModule(SB, 'lib/apiBridge'),
        logCache: H.loadGuiModule(SB, 'lib/logCache'),
    }
    routeAccounts = H.loadGuiModule(SB, 'lib/routes/accounts')
    routeSystem = H.loadGuiModule(SB, 'lib/routes/system')
    srv = H.startServerInProcess(SB, port)
    BASE = srv.base
    await H.waitForServer(BASE)
})

after(async () => {
    if (srv) await srv.close()
    H.removeSandbox(SB)
})

// ============ 脏数据导致的异常逃逸（等价于进程崩溃） ============
describe('R-X 脏数据下的异常逃逸（逃逸 = 真实运行中 GUI 进程崩溃）', () => {
    const goodAccounts = () => fs.writeFileSync(ACCOUNTS(), JSON.stringify([H.fixtureAccount()], null, 4), 'utf-8')

    test('R-X01 accounts.json 中存在缺少 email 字段的条目时 GET /api/accounts 不得抛出异常', () => {
        fs.writeFileSync(ACCOUNTS(), JSON.stringify([{ password: 'x', geoLocale: 'auto' }], null, 4), 'utf-8')
        const res = mockRes()
        try {
            assert.doesNotThrow(() => routeAccounts({ method: 'GET' }, res, '/api/accounts', ctx))
        } finally {
            goodAccounts()
        }
    })

    test('R-X02 accounts.json 内容为对象（非数组）时 GET /api/accounts 不得抛出异常', () => {
        fs.writeFileSync(ACCOUNTS(), JSON.stringify({ email: 'a@b.com' }, null, 4), 'utf-8')
        const res = mockRes()
        try {
            assert.doesNotThrow(() => routeAccounts({ method: 'GET' }, res, '/api/accounts', ctx))
        } finally {
            goodAccounts()
        }
    })

    test('R-X03 accounts.json 中 email 为非字符串时 GET /api/accounts 不得抛出异常', () => {
        fs.writeFileSync(ACCOUNTS(), JSON.stringify([{ email: 12345, password: 'x' }], null, 4), 'utf-8')
        const res = mockRes()
        try {
            assert.doesNotThrow(() => routeAccounts({ method: 'GET' }, res, '/api/accounts', ctx))
        } finally {
            goodAccounts()
        }
    })

    test('R-X04 accounts.json 为损坏 JSON 时返回 500 且不抛异常（既有容错正确性）', () => {
        fs.writeFileSync(ACCOUNTS(), '{ broken json', 'utf-8')
        const res = mockRes()
        try {
            assert.doesNotThrow(() => routeAccounts({ method: 'GET' }, res, '/api/accounts', ctx))
            assert.strictEqual(res.statusCode, 500)
        } finally {
            goodAccounts()
        }
    })

    test('R-X05 缓存目录被同名文件占位时 GET /api/stats 不得抛出异常', () => {
        const cacheDir = path.dirname(ctx.logCache.CACHE_FILE)
        fs.rmSync(cacheDir, { recursive: true, force: true })
        fs.writeFileSync(cacheDir, 'occupied', 'utf-8')
        const res = mockRes()
        try {
            assert.doesNotThrow(() => routeSystem({ method: 'GET' }, res, '/api/stats', ctx))
        } finally {
            fs.rmSync(cacheDir, { force: true })
            fs.mkdirSync(cacheDir, { recursive: true })
        }
    })
})

// ============ 服务端错误场景的 HTTP 容错 ============
describe('R-E 服务端错误场景容错', () => {
    test('R-E01 accounts.json 非数组时 POST 返回 500 且服务存活', async () => {
        const backup = fs.readFileSync(ACCOUNTS(), 'utf-8')
        fs.writeFileSync(ACCOUNTS(), JSON.stringify({ not: 'array' }), 'utf-8')
        try {
            const r = await H.request(BASE, '/api/accounts', { method: 'POST', json: { email: 'x@y.com', password: 'p' } })
            assert.strictEqual(r.status, 500)
            assert.match(r.json.error, /格式异常/)
        } finally {
            fs.writeFileSync(ACCOUNTS(), backup, 'utf-8')
        }
    })

    test('R-E02 accounts.json 非数组时 DELETE 返回 500 且服务存活', async () => {
        const backup = fs.readFileSync(ACCOUNTS(), 'utf-8')
        fs.writeFileSync(ACCOUNTS(), JSON.stringify({ not: 'array' }), 'utf-8')
        try {
            const r = await H.request(BASE, '/api/accounts/x%40y.com', { method: 'DELETE' })
            assert.strictEqual(r.status, 500)
        } finally {
            fs.writeFileSync(ACCOUNTS(), backup, 'utf-8')
        }
    })

    test('R-E03 config.json 损坏时 GET /api/config 返回 500', async () => {
        const backup = fs.readFileSync(CONFIG(), 'utf-8')
        fs.writeFileSync(CONFIG(), '{ broken', 'utf-8')
        try {
            const r = await H.request(BASE, '/api/config')
            assert.strictEqual(r.status, 500)
            assert.match(r.json.error, /无法读取/)
        } finally {
            fs.writeFileSync(CONFIG(), backup, 'utf-8')
        }
    })

    test('R-E04 logs 目录整体缺失时日志与统计接口降级为空结果', async () => {
        const logsDir = path.join(SB, 'logs')
        const stash = path.join(SB, 'logs-stash')
        fs.renameSync(logsDir, stash)
        try { fs.rmSync(ctx.logCache.CACHE_FILE, { force: true }) } catch { /* 忽略 */ }
        try {
            const list = await H.request(BASE, '/api/logs')
            assert.strictEqual(list.status, 200)
            assert.deepStrictEqual(list.json.files, [])

            const stats = await H.request(BASE, '/api/stats')
            assert.strictEqual(stats.status, 200)
            assert.strictEqual(stats.json.grandTotal, 0)

            const sum = await H.request(BASE, '/api/logs/summary')
            assert.strictEqual(sum.status, 200)
            assert.deepStrictEqual(sum.json.entries, [])
        } finally {
            fs.rmSync(logsDir, { recursive: true, force: true })
            fs.renameSync(stash, logsDir)
            try { fs.rmSync(ctx.logCache.CACHE_FILE, { force: true }) } catch { /* 忽略 */ }
        }
    })

    test('R-E05 空 accounts.json 数组时 GET /api/accounts 正常返回空列表', async () => {
        const backup = fs.readFileSync(ACCOUNTS(), 'utf-8')
        fs.writeFileSync(ACCOUNTS(), '[]', 'utf-8')
        try {
            const r = await H.request(BASE, '/api/accounts')
            assert.strictEqual(r.status, 200)
            assert.deepStrictEqual(r.json.accounts, [])
        } finally {
            fs.writeFileSync(ACCOUNTS(), backup, 'utf-8')
        }
    })
})

// ============ 前端脚本的行为审查（提取真实函数执行） ============
describe('R-F 前端脚本容错与输出编码', () => {
    const appSource = () => fs.readFileSync(path.join(SB, 'gui', 'js', 'app.js'), 'utf-8')

    function extractFunction(source, name) {
        const start = source.indexOf(`function ${name}(`)
        assert.notStrictEqual(start, -1, `未找到函数 ${name}`)
        const end = source.indexOf('\n        }', start)
        assert.notStrictEqual(end, -1, `未定位到函数 ${name} 的结束位置`)
        const code = source.slice(start, end + '\n        }'.length)
        return new Function(`${code}; return ${name};`)()
    }

    test('R-F01 escapeHtml 必须真正转义 HTML 元字符【期望依据：账号邮箱与日志消息通过 innerHTML 拼接渲染，未转义即存储型 XSS】', () => {
        const escapeHtml = extractFunction(appSource(), 'escapeHtml')
        const out = escapeHtml('<img src=x onerror=alert(1)>')
        assert.ok(!out.includes('<'), `escapeHtml 未转义 <，输出: ${out}`)
        assert.ok(!out.includes('>'), `escapeHtml 未转义 >，输出: ${out}`)
        assert.strictEqual(escapeHtml('a&b'), 'a&amp;b')
        assert.strictEqual(escapeHtml('"q"'), '&quot;q&quot;')
    })

    test('R-F02 escapeHtml 应处理单引号【期望依据：单引号包裹的属性上下文下的深度防御；内联 onclick 拼接已于 2026-08-20 改为事件委托】', () => {
        const escapeHtml = extractFunction(appSource(), 'escapeHtml')
        const out = escapeHtml("a');alert(1);//")
        assert.ok(!out.includes("'"), `单引号未被转义，输出: ${out}`)
    })

    test('R-F03 fetchJson 应具备请求超时/中止保护【期望依据：断网或服务端无响应时 fetch 永不 settle，界面停留在加载态且 30s 轮询持续堆积】', () => {
        const src = appSource()
        const start = src.indexOf('async function fetchJson(')
        const body = src.slice(start, src.indexOf('\n        }', start))
        assert.match(body, /AbortSignal|AbortController|timeout|signal/i, `fetchJson 无超时保护，实现为: ${body.replace(/\s+/g, ' ')}`)
    })

    test('R-F04 轮询应避免请求堆积（失败退避或并发保护）【期望依据：setInterval 固定 5s/30s 触发，慢响应或持续失败时请求会无限叠加】', () => {
        const src = appSource()
        assert.match(src, /clearInterval|inFlight|isLoading|pending|backoff/i, '未发现任何轮询并发保护或退避机制')
    })

    test('R-F05 parseAccountEnd 正确解析 ACCOUNT-END 关键字段【期望依据：末账号状态块渲染依赖解析，所有账号走同一渲染路径，格式须严格对齐】', () => {
        const parseAccountEnd = extractFunction(appSource(), 'parseAccountEnd')
        const ok = parseAccountEnd({
            lastEvent: 'ACCOUNT-END',
            lastMessage: '已完成账户: tester.a@example.com | 总计: +100 | 原始: 500 → 新值: 600 | 持续时间: 900.0秒'
        })
        assert.deepStrictEqual(ok, { total: 100, initial: 500, final: 600, durationSeconds: 900 })
        assert.strictEqual(parseAccountEnd({ lastEvent: 'ACCOUNT-START', lastMessage: '开始处理账户' }), null)
        assert.strictEqual(parseAccountEnd({ lastEvent: 'ACCOUNT-END', lastMessage: null }), null)
        assert.strictEqual(parseAccountEnd(null), null)
    })

    test('R-F06 仪表盘布局遵循「全局摘要 → 实时日志 → 账号列表」动线【期望依据：实时日志须位于今日收益与首个账号之间，修复日志流位置错位】', () => {
        const html = fs.readFileSync(path.join(SB, 'gui', 'design-reference.html'), 'utf-8')
        const summaryPos = html.indexOf('home-total-balance-sub')
        const logPos = html.indexOf('task-log-box')
        const cardsPos = html.indexOf('home-account-cards')
        assert.ok(summaryPos > -1 && logPos > -1 && cardsPos > -1, '关键布局节点缺失')
        assert.ok(summaryPos < logPos && logPos < cardsPos,
            `布局顺序错误: summary=${summaryPos}, log=${logPos}, cards=${cardsPos}`)
    })
})

// ============ 生命周期：keepalive 常驻与 shutdown ============
describe('R-L 生命周期与常驻（劫持 process.exit 观测）', () => {
    let exitCalls = []
    let liveController = null

    before(() => {
        exitCalls = []
        // 劫持后不再恢复：shutdown 用例会调用 process.exit（记录而不真正退出）
        process.exit = code => { exitCalls.push(code === undefined ? 0 : code) }
    })

    test('R-L01 SSE 保活连接可正常建立（携带 X-Auth-Token）', async () => {
        liveController = new AbortController()
        const token = await H.getAuthToken(BASE)
        const res = await fetch(`${BASE}/api/keepalive`, {
            headers: { 'X-Auth-Token': token },
            signal: liveController.signal
        })
        assert.strictEqual(res.status, 200)
        assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
    })

    test('R-L01b 无令牌的 keepalive 请求返回 401 且不建立 SSE', async () => {
        const res = await fetch(`${BASE}/api/keepalive`)
        assert.strictEqual(res.status, 401)
        const body = await res.text()
        assert.match(body, /未授权/)
    })

    test('R-L02 页面刷新（断开后 2s 内重连）不应触发服务退出', async () => {
        liveController.abort()
        await sleep(2000)
        assert.deepStrictEqual(exitCalls, [], `断开期间不应触发退出: ${JSON.stringify(exitCalls)}`)
        liveController = new AbortController()
        const token = await H.getAuthToken(BASE)
        const res = await fetch(`${BASE}/api/keepalive`, {
            headers: { 'X-Auth-Token': token },
            signal: liveController.signal
        })
        assert.strictEqual(res.status, 200)
        await sleep(500)
        assert.deepStrictEqual(exitCalls, [], '重连后仍触发了退出')
    })

    test('R-L03 所有保活连接断开后服务保持存活（常驻模式，不再有静默期自杀）【期望依据：Edge 睡眠标签页冻结页面导致 SSE 断开时页面无法重连，原 5s 静默期自杀会把 GUI 服务清掉；服务存活不得依赖浏览器页面连接】', async () => {
        liveController.abort()
        // 等待超过原 5s 静默期，服务仍不应退出（原行为：exitCalls 应为 [0]）
        await sleep(6500)
        assert.deepStrictEqual(exitCalls, [], `断开超过原静默期后不应退出: ${JSON.stringify(exitCalls)}`)
    })

    test('R-L04 POST /api/shutdown 先响应成功再退出进程', async () => {
        exitCalls = []
        const r = await H.request(BASE, '/api/shutdown', { method: 'POST' })
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.json.success, true)
        await sleep(800)
        assert.deepStrictEqual(exitCalls, [0], '未在响应后触发退出')
    })

    test('R-L05 已有存活实例（pid 文件）时第二个实例应友好退出【期望依据：Windows 上 SO_REUSEADDR 允许重复 bind，端口检测会漏判，需 pid 文件兜底】', () => {
        exitCalls = []
        // 用新沙箱副本绕过 require 缓存；伪造指向存活进程（测试进程自身）的 pid 文件
        const dupSB = H.createSandbox('dup')
        fs.writeFileSync(path.join(dupSB, '.gui.pid'), String(process.pid), 'utf-8')
        // 测试环境的 process.exit 是记录函数（不真正退出），此处临时换成抛异常以中断
        // server.js 的后续执行（否则会继续 listen 泄漏句柄）
        const recordExit = process.exit
        let exitCode = null
        process.exit = code => { exitCode = code; throw new Error('EXIT_CALLED') }
        try {
            assert.throws(() => H.loadGuiModule(dupSB, 'server.js'), /EXIT_CALLED/)
        } finally {
            process.exit = recordExit
            H.removeSandbox(dupSB)
        }
        assert.strictEqual(exitCode, 1, `检测到存活实例未以退出码 1 终止（实际 ${exitCode}）`)
    })

    test('R-L06 pid 文件残留但进程已死时应正常启动（陈旧文件不阻断）', async () => {
        exitCalls = []
        const dupSB = H.createSandbox('dup')
        // 999999999 在 Windows/Linux 上都不是有效存活进程 → 视为陈旧 pid 文件
        fs.writeFileSync(path.join(dupSB, '.gui.pid'), '999999999', 'utf-8')
        // 让副本服务监听独立随机端口（避免与主服务端口冲突触发 EADDRINUSE 兜底），并捕获实例以便关闭
        const prevPort = process.env.PORT
        process.env.PORT = String(H.pickPort())
        const originalCreate = http.createServer
        let dupServer = null
        http.createServer = function (...args) {
            dupServer = originalCreate.apply(this, args)
            return dupServer
        }
        try {
            H.loadGuiModule(dupSB, 'server.js')
            await sleep(100)
            assert.deepStrictEqual(exitCalls, [], `陈旧 pid 文件不应阻断启动: ${JSON.stringify(exitCalls)}`)
        } finally {
            http.createServer = originalCreate
            if (prevPort === undefined) delete process.env.PORT
            else process.env.PORT = prevPort
            if (dupServer) await new Promise(resolve => dupServer.close(resolve))
            H.removeSandbox(dupSB)
        }
    })
})
