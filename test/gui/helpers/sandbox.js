/**
 * GUI 测试沙箱与公共夹具
 *
 * 设计目标：
 *   1. 完全隔离——所有被测读写都发生在 os.tmpdir() 下的沙箱副本内，
 *      仓库内的 config.json / src/*.example.json / logs/ 零改动。
 *   2. 零依赖——仅使用 Node 内置模块（node:test / assert / fs / http）。
 *   3. 沙箱结构与真实仓库一致，因为 gui/lib/config.js 用 __dirname 推导路径：
 *        <sandbox>/gui/**            gui 目录副本（被测代码）
 *        <sandbox>/config.json       脚本配置
 *        <sandbox>/accounts.json     账号文件
 *        <sandbox>/logs/*.log        日志夹具
 *        <sandbox>/src/*.example.json  回退模板（reset 用）
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const GUI_SRC = path.join(REPO_ROOT, 'gui')

let seq = 0

// ---------- 夹具数据 ----------

function fixtureConfig() {
    return {
        baseURL: 'https://rewards.bing.com',
        sessionPath: 'sessions',
        headless: false,
        ensureStreakProtection: true,
        errorDiagnostics: false,
        debugLogs: false,
        globalTimeout: '30s',
        searchOnBingLocalQueries: false,
        workers: { doDailySet: true, doMorePromotions: true, doPunchCards: false },
        proxy: { queryEngine: false },
        consoleLogFilter: { enabled: false, levels: [] },
        searchSettings: {
            useGeoLocaleQueries: false,
            scrollRandomResults: true,
            clickRandomResults: true,
            searchResultVisitTime: '5s',
            searchDelay: { min: '3min', max: '5min' },
            readDelay: { min: '10s', max: '20s' },
            chinaApi: { appkey: '' },
        },
    }
}

function fixtureAccount(email = 'tester.a@example.com') {
    return {
        email,
        password: 'Passw0rd!',
        totpSecret: '',
        recoveryEmail: '',
        geoLocale: 'auto',
        langCode: 'zh',
        proxy: { proxyAxios: false, url: '', port: 0, username: '', password: '' },
        saveFingerprint: { mobile: true, desktop: true },
    }
}

/** 单行日志构造（格式：utc [local] [account] [level] platform [event] message） */
function logLine(utc, account, level, platform, event, message) {
    const d = new Date(utc)
    const local = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    return `${utc} [${local}] [${account}] [${level}] ${platform} [${event}] ${message}`
}

/**
 * 日志夹具（3 个 UTC 日，各文件仅含单一 UTC 时刻 04:00Z，
 * 保证在任意本地时区下都归属 3 个不同的本地日期 → 断言与时区无关）。
 *
 * 期望统计口径：
 *   day1 tester.a：ACCOUNT-END 权威 +100
 *   day2 tester.a：同日两次运行 +30/+20 累加 = 50；tester.b：+70
 *   day3 tester.b：无 ACCOUNT-END → 活动积分兜底 10+15+3+3 = 31
 *   grandTotal = 100 + 120 + 31 = 251
 */
const FIXTURE_EXPECT = {
    days: 3,
    grandTotal: 251,
    accountTotals: { 'tester.a': 150, 'tester.b': 101 },
    day2: { account: 'tester.a', collectedPoints: 50, initialPoints: 600, finalPoints: 650 },
    day3ActivityPoints: 31,
}

function writeLogFixtures(logsDir) {
    fs.mkdirSync(logsDir, { recursive: true })

    const d1 = '2026-03-02T04:00:00.000Z'
    const day1 = [
        logLine(d1, '主进程', 'INFO', '主进程', 'RUN-START', '开始运行 | 账号数: 2'),
        logLine(d1, 'tester.a', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: tester.a@example.com | 地理位置: auto'),
        logLine(d1, 'tester.a', 'INFO', '桌面端', 'SEARCH-BING', '获得积分=3 points | query="测试关键词" | remaining=24'),
        logLine(d1, 'tester.a', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: tester.a@example.com | 总计: +100 | 原始: 500 → 新值: 600 | 持续时间: 900.0秒'),
    ].join('\n') + '\n'

    const d2 = '2026-03-03T04:00:00.000Z'
    const day2 = [
        // 注意：真实日志每次运行必有 ACCOUNT-START（运行段边界）。此处显式写出两次 START，
        // 与 generateSummary 的「运行段粒度」统计口径保持一致（2026-08-22）
        logLine(d2, 'tester.a', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: tester.a@example.com | 地理位置: auto'),
        logLine(d2, 'tester.a', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: tester.a@example.com | 总计: +30 | 原始: 600 → 新值: 630 | 持续时间: 300.0秒'),
        logLine(d2, 'tester.a', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: tester.a@example.com | 地理位置: auto'),
        logLine(d2, 'tester.a', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: tester.a@example.com | 总计: +20 | 原始: 630 → 新值: 650 | 持续时间: 200.0秒'),
        logLine(d2, 'tester.b', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: tester.b@example.com | 地理位置: auto'),
        logLine(d2, 'tester.b', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: tester.b@example.com | 总计: +70 | 原始: 100 → 新值: 170 | 持续时间: 500.0秒'),
    ].join('\n') + '\n'

    const d3 = '2026-03-04T04:00:00.000Z'
    const day3 = [
        logLine(d3, 'tester.b', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: tester.b@example.com | 地理位置: auto'),
        logLine(d3, 'tester.b', 'INFO', '移动端', 'URL-REWARD', '完成UrlReward | offerId=Gamification_DailySet_Child1 | 状态=200 | 获得积分=10 | 新余额=180'),
        logLine(d3, 'tester.b', 'INFO', '移动端', 'DAILY-CHECK-IN', '完成每日签到 | 类型=101 | 获得积分=15 | 原始余额=180 | 新余额=195'),
        logLine(d3, 'tester.b', 'INFO', '移动端', 'READ-TO-EARN', '阅读文章 1/10 | 状态=200 | 获得积分=3 | 新余额=198'),
        logLine(d3, 'tester.b', 'INFO', '桌面端', 'SEARCH-BING', '获得积分=3 points | query="测试关键词2" | remaining=20'),
        logLine(d3, 'tester.b', 'WARN', '桌面端', 'SEARCH-BING', '未获得积分 | query="无效" | remaining=19'),
        logLine(d3, '主进程', 'INFO', '主进程', 'RUN-END', '运行结束 | 总计: +999'),
        '  ✓ "缩进列表行" (建议=8, 相关=11)',
        '乱码行 not matching any pattern',
        '',
    ].join('\n') + '\n'

    fs.writeFileSync(path.join(logsDir, '2026-03-02.log'), day1, 'utf-8')
    fs.writeFileSync(path.join(logsDir, '2026-03-03.log'), day2, 'utf-8')
    fs.writeFileSync(path.join(logsDir, '2026-03-04.log'), day3, 'utf-8')
}

// ---------- 沙箱 ----------

/** 创建隔离沙箱，返回沙箱根目录绝对路径 */
function createSandbox(tag) {
    const root = path.join(os.tmpdir(), `gui-test-${tag}-${process.pid}-${Date.now()}-${seq++}`)
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })

    // 复制 gui/ 副本（跳过 cache 与 .bak/.bak.<时间戳> 历史备份，避免带入宿主机运行时残留）
    fs.cpSync(GUI_SRC, path.join(root, 'gui'), {
        recursive: true,
        filter: src => !src.includes(`${path.sep}cache`) && !path.basename(src).includes('.bak'),
    })
    fs.writeFileSync(path.join(root, 'gui', 'gui-settings.json'), JSON.stringify({ port: 3000 }, null, 4) + '\n', 'utf-8')

    const cfg = fixtureConfig()
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 4) + '\n', 'utf-8')
    fs.writeFileSync(path.join(root, 'src', 'config.example.json'), JSON.stringify(cfg, null, 4) + '\n', 'utf-8')

    const accounts = [fixtureAccount()]
    fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify(accounts, null, 4) + '\n', 'utf-8')
    fs.writeFileSync(path.join(root, 'src', 'accounts.example.json'), JSON.stringify(accounts, null, 4) + '\n', 'utf-8')

    writeLogFixtures(path.join(root, 'logs'))
    return root
}

function removeSandbox(root) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响测试结论 */ }
}

/** 加载沙箱内的 gui 模块（每个沙箱路径不同 → require 缓存天然隔离） */
function loadGuiModule(root, relative) {
    return require(path.join(root, 'gui', relative))
}

/**
 * 在当前进程内启动沙箱 GUI 服务。
 * 通过临时劫持 http.createServer 捕获 server 实例，以便测试结束后可靠关闭
 * （server.js 未导出实例，否则句柄泄漏会导致测试进程无法退出）。
 */
function startServerInProcess(root, port) {
    const prevPort = process.env.PORT
    process.env.PORT = String(port)
    const originalCreate = http.createServer
    let captured = null
    http.createServer = function patched(...args) {
        captured = originalCreate.apply(this, args)
        return captured
    }
    try {
        require(path.join(root, 'gui', 'server.js'))
    } finally {
        http.createServer = originalCreate
        if (prevPort === undefined) delete process.env.PORT
        else process.env.PORT = prevPort
    }
    if (!captured) throw new Error('未捕获到 http server 实例')
    return {
        server: captured,
        base: `http://127.0.0.1:${port}`,
        async close() {
            captured.closeAllConnections?.()
            await new Promise(resolve => captured.close(resolve))
        },
    }
}

function pickPort() {
    return 20000 + Math.floor(Math.random() * 30000)
}

// ---------- 鉴权令牌（2026-08-21 引入本地 Token 鉴权后） ----------
// 按 base 缓存令牌：同一进程内多个测试文件各自启动沙箱服务，令牌必须与服务实例一一对应；
// 首次请求时惰性获取，并发请求共享同一 Promise 避免重复请求。
const tokenCache = new Map()

function getAuthToken(base) {
    if (!tokenCache.has(base)) {
        tokenCache.set(base, fetch(`${base}/api/auth/token`).then(async res => {
            if (!res.ok) throw new Error(`获取测试令牌失败: HTTP ${res.status}`)
            return (await res.json()).token
        }))
    }
    return tokenCache.get(base)
}

async function waitForServer(base, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    let lastErr = null
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${base}/api/auth/token`)
            if (res.ok) { await res.arrayBuffer(); return true }
        } catch (e) { lastErr = e }
        await new Promise(r => setTimeout(r, 100))
    }
    throw new Error(`服务未在 ${timeoutMs}ms 内就绪: ${lastErr && lastErr.message}`)
}

// ---------- HTTP 请求助手 ----------

/**
 * 发送请求并归一化返回 { status, json, buffer, headers }
 * options: { method, json（自动序列化）, raw（原样发送的字符串/Buffer）, headers, signal,
 *            auth（false 时不自动携带 X-Auth-Token，用于鉴权失败用例） }
 */
async function request(base, urlPath, options = {}) {
    const { method = 'GET', json, raw, headers = {}, signal, timeoutMs = 20000, auth = true } = options
    const init = { method, headers: { ...headers }, signal: signal ?? AbortSignal.timeout(timeoutMs) }
    if (auth) {
        init.headers['X-Auth-Token'] = await getAuthToken(base)
    }
    if (raw !== undefined) {
        init.body = raw
        init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json'
    } else if (json !== undefined) {
        init.body = JSON.stringify(json)
        init.headers['Content-Type'] = 'application/json'
    }
    const res = await fetch(`${base}${urlPath}`, init)
    const buffer = Buffer.from(await res.arrayBuffer())
    let parsed = null
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('json')) {
        try { parsed = JSON.parse(buffer.toString('utf-8')) } catch { parsed = null }
    }
    return { status: res.status, json: parsed, buffer, headers: res.headers, text: () => buffer.toString('utf-8') }
}

// ---------- 最小 zip 生成器（store 模式，供导入接口测试） ----------

const CRC_TABLE = (() => {
    const table = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
        let c = i
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[i] = c
    }
    return table
})()

function crc32(buf) {
    let c = 0 ^ -1
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
    return (c ^ -1) >>> 0
}

/** entries: [{ name, data: string|Buffer }] → Buffer（无压缩 zip） */
function makeZip(entries) {
    const locals = []
    const centrals = []
    let offset = 0
    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf-8')
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf-8')
        const crc = crc32(data)

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)   // version needed
        local.writeUInt16LE(0, 6)    // flags
        local.writeUInt16LE(0, 8)    // method = store
        local.writeUInt16LE(0, 10)   // time
        local.writeUInt16LE(0x21, 12) // date（1996-01-01，任意合法值）
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(nameBuf.length, 26)
        local.writeUInt16LE(0, 28)
        locals.push(local, nameBuf, data)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(0, 8)
        central.writeUInt16LE(0, 10)
        central.writeUInt16LE(0, 12)
        central.writeUInt16LE(0x21, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(data.length, 20)
        central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(nameBuf.length, 28)
        central.writeUInt16LE(0, 30)
        central.writeUInt16LE(0, 32)
        central.writeUInt16LE(0, 34)
        central.writeUInt16LE(0, 36)
        central.writeUInt32LE(0, 38)
        central.writeUInt32LE(offset, 42)
        centrals.push(central, nameBuf)

        offset += local.length + nameBuf.length + data.length
    }
    const centralBuf = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)
    return Buffer.concat([Buffer.concat(locals), centralBuf, eocd])
}

module.exports = {
    REPO_ROOT,
    GUI_SRC,
    FIXTURE_EXPECT,
    fixtureConfig,
    fixtureAccount,
    logLine,
    writeLogFixtures,
    createSandbox,
    removeSandbox,
    loadGuiModule,
    startServerInProcess,
    pickPort,
    waitForServer,
    getAuthToken,
    request,
    makeZip,
    crc32,
}
