/**
 * GUI 单元测试（gui/lib/*）
 *
 * 运行：node --test test/gui/unit.test.js
 * 隔离：全部在 os.tmpdir() 沙箱副本内读写，仓库文件零改动。
 *
 * 断言原则：断言「期望的正确行为」。用例失败即代表一处缺陷或健壮性缺口，
 *          用例名中的【期望依据】说明为何这样断言。
 */
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawnSync } = require('node:child_process')

const H = require('./helpers/sandbox')

let SB = null
let validator, httpUtils, logger, summary, archive, logCache, config

// 探测当前环境能否以 stdio=pipe 方式 spawn 外部压缩工具
// （archive.js 使用默认 pipe；受限执行沙箱下开管道会 EPERM，与被测代码无关）
let archiveSpawnable = false
function detectArchiveSpawn() {
    const r = process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'])
        : spawnSync('sh', ['-c', 'exit 0'])
    return !r.error && r.status === 0
}

before(() => {
    SB = H.createSandbox('unit')
    config = H.loadGuiModule(SB, 'lib/config')
    validator = H.loadGuiModule(SB, 'lib/validator')
    httpUtils = H.loadGuiModule(SB, 'lib/httpUtils')
    logger = H.loadGuiModule(SB, 'lib/logger')
    summary = H.loadGuiModule(SB, 'lib/summary')
    archive = H.loadGuiModule(SB, 'lib/archive')
    logCache = H.loadGuiModule(SB, 'lib/logCache')
    archiveSpawnable = detectArchiveSpawn()
})

after(() => H.removeSandbox(SB))

// ============ validator：异常输入与边界值 ============
describe('U-V validator.validateAccountShape 异常输入与边界值', () => {
    test('U-V01 null 输入返回错误文案而非抛异常', () => {
        assert.strictEqual(typeof validator.validateAccountShape(null), 'string')
    })

    test('U-V02 数组输入被拒绝', () => {
        assert.match(validator.validateAccountShape([]), /必须是一个对象/)
    })

    test('U-V03 空对象列出全部缺失字段', () => {
        const err = validator.validateAccountShape({})
        assert.match(err, /email/)
        assert.match(err, /password/)
        assert.match(err, /proxy/)
    })

    test('U-V04 合法账号通过校验', () => {
        assert.strictEqual(validator.validateAccountShape(H.fixtureAccount()), null)
    })

    test('U-V05 email 缺少 @ 被拒绝', () => {
        const acc = { ...H.fixtureAccount(), email: 'not-an-email' }
        assert.match(validator.validateAccountShape(acc), /email/)
    })

    test('U-V06 proxy 为 null 被拒绝', () => {
        const acc = { ...H.fixtureAccount(), proxy: null }
        assert.match(validator.validateAccountShape(acc), /proxy/)
    })

    test('U-V07 proxy.port 为字符串被拒绝', () => {
        const acc = H.fixtureAccount()
        acc.proxy = { ...acc.proxy, port: '8080' }
        assert.match(validator.validateAccountShape(acc), /proxy\.port/)
    })

    test('U-V08 proxy.port 为 NaN/Infinity 被拒绝', () => {
        const acc = H.fixtureAccount()
        acc.proxy = { ...acc.proxy, port: NaN }
        assert.match(validator.validateAccountShape(acc), /proxy\.port/)
        acc.proxy = { ...acc.proxy, port: Infinity }
        assert.match(validator.validateAccountShape(acc), /proxy\.port/)
    })

    test('U-V09 saveFingerprint 字段类型错误被拒绝', () => {
        const acc = H.fixtureAccount()
        acc.saveFingerprint = { mobile: 'yes', desktop: 1 }
        const err = validator.validateAccountShape(acc)
        assert.match(err, /saveFingerprint\.mobile/)
        assert.match(err, /saveFingerprint\.desktop/)
    })

    test('U-V10 超长 email 被拒绝【期望依据：RFC 5321 邮件地址上限 254 字符，超长值会写入 accounts.json 并被脚本读取】', () => {
        const acc = { ...H.fixtureAccount(), email: 'a'.repeat(5000) + '@example.com' }
        assert.notStrictEqual(validator.validateAccountShape(acc), null)
    })

    test('U-V11 proxy.port 越界（-1 / 70000）被拒绝【期望依据：TCP 端口合法区间 0-65535，越界值会传给代理连接层】', () => {
        const acc = H.fixtureAccount()
        acc.proxy = { ...acc.proxy, port: -1 }
        const errNeg = validator.validateAccountShape(acc)
        acc.proxy = { ...acc.proxy, port: 70000 }
        const errBig = validator.validateAccountShape(acc)
        assert.notStrictEqual(errNeg, null, 'port=-1 应被拒绝')
        assert.notStrictEqual(errBig, null, 'port=70000 应被拒绝')
    })

    test('U-V12 email 含空白/换行被拒绝【期望依据：换行会破坏日志行结构与后续解析】', () => {
        const acc = { ...H.fixtureAccount(), email: 'evil\n@example.com' }
        assert.notStrictEqual(validator.validateAccountShape(acc), null)
    })

    test('U-V13 携带 __proto__ 键的账号不污染 Object 原型', () => {
        const acc = JSON.parse('{"email":"a@b.com","password":"p","geoLocale":"auto","langCode":"zh","__proto__":{"polluted":true},"proxy":{"proxyAxios":false,"url":"","port":0,"username":"","password":""},"saveFingerprint":{"mobile":true,"desktop":true}}')
        validator.validateAccountShape(acc)
        assert.strictEqual({}.polluted, undefined)
    })
})

// ============ httpUtils：请求体解析与容错 ============
describe('U-H httpUtils 请求体解析与容错', () => {
    function mockReq() {
        const req = new EventEmitter()
        req.destroy = () => { req.destroyed = true }
        return req
    }

    test('U-H01 空请求体解析为 null', async () => {
        const req = mockReq()
        const p = httpUtils.readBody(req)
        req.emit('end')
        assert.strictEqual(await p, null)
    })

    test('U-H02 合法 JSON 解析为对象', async () => {
        const req = mockReq()
        const p = httpUtils.readBody(req)
        req.emit('data', '{"a":1}')
        req.emit('end')
        assert.deepStrictEqual(await p, { a: 1 })
    })

    test('U-H03 非法 JSON 以「无效的 JSON 请求体」拒绝', async () => {
        const req = mockReq()
        const p = httpUtils.readBody(req)
        req.emit('data', '{oops')
        req.emit('end')
        await assert.rejects(p, /无效的 JSON 请求体/)
    })

    test('U-H04 顶层数组可被解析（由路由层负责拒绝）', async () => {
        const req = mockReq()
        const p = httpUtils.readBody(req)
        req.emit('data', '[1,2]')
        req.emit('end')
        assert.deepStrictEqual(await p, [1, 2])
    })

    test('U-H05 超过 100MB 的请求体被拒绝并销毁连接', async () => {
        const req = mockReq()
        const p = httpUtils.readBody(req)
        const chunk = 'x'.repeat(50e6)
        req.emit('data', chunk)
        req.emit('data', chunk)
        req.emit('data', chunk)
        await assert.rejects(p, /请求体过大/)
        assert.strictEqual(req.destroyed, true, '超限后应销毁连接')
    })

    test('U-H06 底层连接 error 事件被透传为 reject', async () => {
        const req = mockReq()
        const p = httpUtils.readBody(req)
        req.emit('error', new Error('ECONNRESET'))
        await assert.rejects(p, /ECONNRESET/)
    })

    test('U-H07 客户端中途断开（close 无 end）时 Promise 必须在有限时间内结束【期望依据：断网/超时场景下悬挂的 Promise 会持续持有请求体内存，无超时保护即资源泄漏】', async () => {
        const req = mockReq()
        const p = httpUtils.readBody(req).catch(e => `rejected:${e.message}`)
        req.emit('data', 'x'.repeat(1024))
        req.emit('aborted')
        req.emit('close')
        const timeout = new Promise(r => setTimeout(() => r('PENDING'), 1500))
        const winner = await Promise.race([p, timeout])
        assert.notStrictEqual(winner, 'PENDING', '连接断开后 readBody 仍处于 pending 状态')
    })

    test('U-H08 sendJson 遇到循环引用数据不应抛异常导致请求悬挂【期望依据：JSON.stringify 抛错时 res 永不 end，客户端一直等待】', () => {
        const res = { writeHead() {}, end() {} }
        const cyclic = { name: 'x' }
        cyclic.self = cyclic
        assert.doesNotThrow(() => httpUtils.sendJson(res, 200, cyclic))
    })
})

// ============ logger：日志解析与读取 ============
describe('U-L logger 日志解析与读取', () => {
    test('U-L01 标准行解析出 7 个字段', () => {
        const line = H.logLine('2026-03-02T04:00:00.000Z', 'tester.a', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: tester.a@example.com | 地理位置: auto')
        const e = logger.parseLogLine(line)
        assert.strictEqual(e.utcTime, '2026-03-02T04:00:00.000Z')
        assert.strictEqual(e.account, 'tester.a')
        assert.strictEqual(e.level, 'INFO')
        assert.strictEqual(e.platform, '主进程')
        assert.strictEqual(e.event, 'ACCOUNT-START')
        assert.match(e.message, /开始处理账户/)
    })

    test('U-L02 空行/空白/乱码/残缺/缩进列表行均返回 null', () => {
        for (const bad of ['', '   ', '\t', '乱码 not a log line', '2026-03-02T04:00:00.000Z [不完整', '  ✓ "缩进列表" (建议=8)']) {
            assert.strictEqual(logger.parseLogLine(bad), null, `应返回 null: ${JSON.stringify(bad)}`)
        }
    })

    test('U-L03 512KB 超长 message 完整保留且不崩溃', () => {
        const long = 'A'.repeat(512 * 1024)
        const e = logger.parseLogLine(H.logLine('2026-03-02T04:00:00.000Z', 'tester.a', 'INFO', '桌面端', 'SEARCH-BING', long))
        assert.strictEqual(e.message.length, long.length)
    })

    test('U-L04 CRLF 行尾不应把 \\r 混入 message【期望依据：导入 Windows 生成的日志 zip 时行尾为 CRLF，残留 \\r 会污染积分正则与前端展示】', () => {
        const line = H.logLine('2026-03-02T04:00:00.000Z', 'tester.a', 'INFO', '桌面端', 'SEARCH-BING', '获得积分=3 points') + '\r'
        const e = logger.parseLogLine(line)
        assert.ok(e, '应能解析 CRLF 行')
        assert.ok(!e.message.includes('\r'), `message 残留 \\r: ${JSON.stringify(e.message)}`)
    })

    test('U-L05 listLogFiles 返回 3 个夹具文件且按日期倒序', () => {
        assert.deepStrictEqual(logger.listLogFiles(), ['2026-03-04.log', '2026-03-03.log', '2026-03-02.log'])
    })

    test('U-L06 readLogFile(null) 读取最新日志且 entries 非空', () => {
        const r = logger.readLogFile(null)
        assert.strictEqual(r.date, '2026-03-04')
        assert.ok(r.entries.length > 0)
    })

    test('U-L07 readLogFile("2026-03-03") 应返回该日期日志内容【期望依据：GET /api/logs/:date 传入的正是不带 .log 的日期串，路由要靠它取当日明细】', () => {
        const r = logger.readLogFile('2026-03-03')
        assert.ok(r.entries.length > 0, `按日期查询返回空 entries（实际读取路径缺少 .log 后缀）: ${JSON.stringify(r)}`)
    })

    test('U-L08 readLogFile 不应读取 logs 目录之外的文件【期望依据：dateStr 直接参与 path.join，无白名单校验即存在目录穿越面】', () => {
        const leak = path.join(config.ROOT, 'leak.log')
        fs.writeFileSync(leak, H.logLine('2026-03-05T04:00:00.000Z', 'tester.c', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: leak | 总计: +1 | 原始: 1 → 新值: 2') + '\n', 'utf-8')
        const r = logger.readLogFile('../leak.log')
        assert.strictEqual(r.entries.length, 0, '成功读取到 logs/ 之外的文件内容')
    })

    test('U-L09 读取不存在的日期返回空结构而非抛异常', () => {
        const r = logger.readLogFile('1999-01-01')
        assert.deepStrictEqual(r.entries, [])
    })

    test('U-L10 CRLF 行尾的日志文件统计结果不应为 0【端到端影响：Windows 记事本/第三方导出的日志为 CRLF，split("\\n") 后每行残留 \\r】', () => {
        const crlfDir = path.join(SB, 'logs-crlf')
        fs.mkdirSync(crlfDir, { recursive: true })
        const content = [
            H.logLine('2026-04-01T04:00:00.000Z', 'tester.crlf', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: tester.crlf@example.com | 总计: +88 | 原始: 10 → 新值: 98'),
            '',
        ].join('\r\n')
        fs.writeFileSync(path.join(crlfDir, '2026-04-01.log'), content, 'utf-8')
        const s = summary.generateSummary(crlfDir)
        assert.strictEqual(s.grandTotal, 88, `CRLF 日志被整行丢弃，统计结果为 ${s.grandTotal}（应为 88）`)
    })
})

// ============ summary：统计聚合 ============
describe('U-S summary 统计聚合', () => {
    test('U-S01 不存在的目录返回空结构', () => {
        const s = summary.generateSummary(path.join(SB, 'no-such-dir'))
        assert.strictEqual(s.daily.length, 0)
        assert.strictEqual(s.grandTotal, 0)
        assert.strictEqual(s.accountTotals.length, 0)
    })

    test('U-S02 夹具日志聚合为 3 天、总计 251（ACCOUNT-END 权威 + 活动积分兜底）', () => {
        const s = summary.generateSummary()
        assert.strictEqual(s.daily.length, H.FIXTURE_EXPECT.days)
        assert.strictEqual(s.grandTotal, H.FIXTURE_EXPECT.grandTotal)
        assert.strictEqual(s.grandTotal, s.daily.reduce((n, d) => n + d.total, 0))
    })

    test('U-S03 accountTotals 与预期逐账号一致', () => {
        const s = summary.generateSummary()
        const map = Object.fromEntries(s.accountTotals.map(a => [a.account, a.totalPoints]))
        assert.deepStrictEqual(map, H.FIXTURE_EXPECT.accountTotals)
    })

    test('U-S04 空 entries 返回空数组', () => {
        assert.deepStrictEqual(summary.summarizeLogs([]), [])
    })

    test('U-S05 同日多次运行收益累加、原始取首次、新值取末次', () => {
        const lines = fs.readFileSync(path.join(config.LOGS_DIR, '2026-03-03.log'), 'utf-8').split('\n')
        const entries = lines.map(logger.parseLogLine).filter(Boolean)
        const acc = summary.summarizeLogs(entries).find(a => a.account === H.FIXTURE_EXPECT.day2.account)
        assert.strictEqual(acc.collectedPoints, H.FIXTURE_EXPECT.day2.collectedPoints)
        assert.strictEqual(acc.initialPoints, H.FIXTURE_EXPECT.day2.initialPoints)
        assert.strictEqual(acc.finalPoints, H.FIXTURE_EXPECT.day2.finalPoints)
    })

    test('U-S06 「主进程」伪账号被排除在统计之外', () => {
        const s = summary.generateSummary()
        assert.ok(!s.accountTotals.some(a => a.account === '主进程'))
        const all = summary.summarizeAllLogs()
        assert.ok(!all.some(a => a.account === '主进程'))
    })

    test('U-S07 超大积分值不产生 NaN', () => {
        const entries = [logger.parseLogLine(H.logLine('2026-03-06T04:00:00.000Z', 'tester.x', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: x | 总计: +99999999999999999999 | 原始: 1 → 新值: 2'))]
        const acc = summary.summarizeLogs(entries)[0]
        assert.ok(Number.isFinite(acc.collectedPoints), `collectedPoints 非有限数: ${acc.collectedPoints}`)
    })

    test('U-S08 无 ACCOUNT-END 的当天回退为活动积分合计（10+15+3+3=31）', () => {
        const s = summary.generateSummary()
        const day = s.daily.find(d => d.accounts.length === 1 && d.accounts[0].account === 'tester.b')
        assert.ok(day, '未找到仅含 tester.b 的兜底日')
        assert.strictEqual(day.total, H.FIXTURE_EXPECT.day3ActivityPoints)
    })

    test('U-S09 entry 缺少 message 字段时不应抛异常【期望依据：日志格式演进或第三方导入可能产生残缺条目，统计层应容错】', () => {
        assert.doesNotThrow(() => summary.summarizeLogs([{ account: 'tester.z', level: 'INFO', event: 'ACCOUNT-END', utcTime: '2026-03-02T04:00:00.000Z' }]))
    })

    test('U-S10 写入不可写目标时返回 null 而非抛异常', () => {
        assert.strictEqual(summary.writeSummaryFile({ a: 1 }, config.LOGS_DIR), null)
    })
})

// ============ RUN-END 归属与收益三口径自洽（2026-08-23） ============
// 背景：上游 RUN-END 行的 [账户] 字段被动态 userName 污染成"最后一个账号名"而非"主进程"，
// 若仅按 account 过滤，RUN-END 会覆盖末尾账号卡片的 lastEvent，并在跨天时污染收益段归属。
describe('U-R RUN-END 归属与收益三口径自洽', () => {
    // 取本地今天正午的 UTC 时刻：任何时区下都归属本地今天，断言与时区无关
    function todayNoonUtc() {
        const now = new Date()
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString()
    }

    test('U-R01 末尾 RUN-END 行（[账户]=末尾账号名）不覆盖其 lastEvent=ACCOUNT-END', () => {
        const utc = todayNoonUtc()
        const entries = [
            logger.parseLogLine(H.logLine(utc, 'acct.c', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: acct.c@example.com')),
            logger.parseLogLine(H.logLine(utc, 'acct.c', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: acct.c | 总计: +132 | 原始: 500 → 新值: 632 | 持续时间: 100.0秒')),
            // 上游污染：RUN-END 行的 [账户] = 末尾账号名（非"主进程"）
            logger.parseLogLine(H.logLine(utc, 'acct.c', 'INFO', '主进程', 'RUN-END', '已完成所有账户 | 已处理账户: 1 | 总收集积分: +132')),
        ]
        const acc = summary.summarizeLogs(entries).find(a => a.account === 'acct.c')
        assert.ok(acc, '未找到 acct.c')
        assert.strictEqual(acc.lastEvent, 'ACCOUNT-END', `lastEvent 被 RUN-END 覆盖: ${acc.lastEvent}`)
    })

    test('U-R02 末尾账号 lastMessage 保留 ACCOUNT-END 的「总计」文案', () => {
        const utc = todayNoonUtc()
        const entries = [
            logger.parseLogLine(H.logLine(utc, 'acct.c', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: acct.c | 总计: +132 | 原始: 500 → 新值: 632')),
            logger.parseLogLine(H.logLine(utc, 'acct.c', 'INFO', '主进程', 'RUN-END', '已完成所有账户 | 总收集积分: +132')),
        ]
        const acc = summary.summarizeLogs(entries).find(a => a.account === 'acct.c')
        assert.match(acc.lastMessage, /总计/, `lastMessage 不再是 ACCOUNT-END: ${acc.lastMessage}`)
        assert.strictEqual(acc.collectedPoints, 132)
    })

    test('U-R03 三口径自洽：今日总收益 === 各账号收益之和 === RUN-END 总收集积分', () => {
        const utc = todayNoonUtc()
        const dir = path.join(SB, 'logs-runend')
        fs.mkdirSync(dir, { recursive: true })
        const lines = [
            H.logLine(utc, '主进程', 'INFO', '主进程', 'RUN-START', '启动微软奖励脚本 | 账户数: 3'),
            H.logLine(utc, 'acct.a', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: acct.a@example.com'),
            H.logLine(utc, 'acct.a', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: acct.a | 总计: +100 | 原始: 500 → 新值: 600'),
            H.logLine(utc, 'acct.b', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: acct.b@example.com'),
            H.logLine(utc, 'acct.b', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: acct.b | 总计: +107 | 原始: 718 → 新值: 825'),
            H.logLine(utc, 'acct.c', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: acct.c@example.com'),
            H.logLine(utc, 'acct.c', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: acct.c | 总计: +132 | 原始: 100 → 新值: 232'),
            // RUN-END 的 [账户] 被污染成末尾账号名 acct.c，总收集积分 = 100+107+132 = 339
            H.logLine(utc, 'acct.c', 'INFO', '主进程', 'RUN-END', '已完成所有账户 | 已处理账户: 3 | 总收集积分: +339 | 原始总计: 1318 → 新总计: 1657'),
        ]
        fs.writeFileSync(path.join(dir, 'runend.log'), lines.join('\n') + '\n', 'utf-8')
        const s = summary.generateSummary(dir)

        const runEndEntry = logger.parseLogLine(lines[lines.length - 1])
        const runEndTotal = parseInt((runEndEntry.message.match(/总收集积分:\s*\+(\d+)/) || [])[1], 10)
        const sumOfAccounts = s.daily.reduce((n, d) => n + (d.accounts || []).reduce((m, a) => m + a.points, 0), 0)

        assert.strictEqual(runEndTotal, 339, `RUN-END 总收集积分应为 339，实际 ${runEndTotal}`)
        assert.strictEqual(s.todayTotal, 339, `今日总收益应为 339，实际 ${s.todayTotal}`)
        assert.strictEqual(sumOfAccounts, 339, `各账号收益之和应为 339，实际 ${sumOfAccounts}`)
        assert.strictEqual(s.todayTotal, sumOfAccounts)
        assert.strictEqual(s.todayTotal, runEndTotal)
    })

    test('U-R04 跨天 RUN-END 行不把末尾账号收益拖入次日', () => {
        const now = new Date()
        // 末尾账号今日 23:50 完成，RUN-END 在次日 00:05（其 [账户] 被污染成末尾账号名）
        const endUtc = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 50, 0).toISOString()
        const runEndUtc = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0).toISOString()
        const dir = path.join(SB, 'logs-runend-crossday')
        fs.mkdirSync(dir, { recursive: true })
        const lines = [
            H.logLine(endUtc, 'acct.c', 'INFO', '主进程', 'ACCOUNT-START', '开始处理账户: acct.c@example.com'),
            H.logLine(endUtc, 'acct.c', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: acct.c | 总计: +132 | 原始: 500 → 新值: 632'),
            H.logLine(runEndUtc, 'acct.c', 'INFO', '主进程', 'RUN-END', '已完成所有账户 | 已处理账户: 1 | 总收集积分: +132'),
        ]
        fs.writeFileSync(path.join(dir, 'runend-crossday.log'), lines.join('\n') + '\n', 'utf-8')
        const s = summary.generateSummary(dir)
        assert.strictEqual(s.todayTotal, 132, `末尾账号收益被 RUN-END 拖入次日，今日总收益 ${s.todayTotal}（应为 132）`)
    })
})

// ============ archive：临时目录与压缩 ============
describe('U-A archive 临时目录与压缩', () => {
    test('U-A01 makeTmpRoot 高频调用必须唯一【期望依据：并发导入/导出共用同名临时目录会互相覆盖 zip 并被对方 rmSync 删除】', () => {
        const set = new Set()
        for (let i = 0; i < 2000; i++) set.add(archive.makeTmpRoot('gui-x'))
        assert.strictEqual(set.size, 2000, `2000 次调用仅产生 ${set.size} 个唯一路径（同毫秒碰撞）`)
    })

    test('U-A02 解压不存在的 zip 以明确错误 reject', async t => {
        if (!archiveSpawnable) return t.skip('当前执行环境禁止子进程管道（EPERM），跳过')
        await assert.rejects(archive.unzipToDir(path.join(SB, 'nope.zip'), path.join(SB, 'out1')), /解压/)
    })

    test('U-A03 zip → unzip 往返内容一致', async t => {
        if (!archiveSpawnable) return t.skip('当前执行环境禁止子进程管道（EPERM），跳过')
        const stage = path.join(SB, 'stage')
        fs.mkdirSync(stage, { recursive: true })
        fs.writeFileSync(path.join(stage, 'a.log'), 'hello-archive', 'utf-8')
        const zip = path.join(SB, 'rt.zip')
        await archive.zipDir(stage, zip)
        const out = path.join(SB, 'rt-out')
        await archive.unzipToDir(zip, out)
        assert.strictEqual(fs.readFileSync(path.join(out, 'a.log'), 'utf-8'), 'hello-archive')
    })

    test('U-A04 PowerShell 命令不得拼接路径【期望依据：临时目录含单引号等特殊字符会中断命令或构成注入；路径须经环境变量传递】', () => {
        const src = fs.readFileSync(path.join(SB, 'gui', 'lib', 'archive.js'), 'utf-8')
        assert.ok(!src.includes("-LiteralPath '"), 'unzipToDir 仍把路径拼进 -Command 字符串')
        assert.ok(!src.includes("-Path '"), 'zipDir 仍把路径拼进 -Command 字符串')
        assert.match(src, /GUI_ARCHIVE_SRC/, '未发现环境变量传递路径的实现')
    })
})

// ============ logCache：缓存新鲜度与状态管理 ============
describe('U-C logCache 缓存新鲜度与状态管理', () => {
    test('U-C01 generateCache 生成缓存文件且随即判定为新鲜', () => {
        logCache.generateCache()
        assert.ok(fs.existsSync(logCache.CACHE_FILE))
        assert.strictEqual(logCache.isCacheFresh(), true)
    })

    test('U-C02 日志文件变更后缓存判定失效', () => {
        logCache.generateCache()
        fs.appendFileSync(path.join(config.LOGS_DIR, '2026-03-04.log'), H.logLine('2026-03-04T05:00:00.000Z', 'tester.b', 'INFO', '桌面端', 'SEARCH-BING', '获得积分=5 points | query="new"') + '\n', 'utf-8')
        assert.strictEqual(logCache.isCacheFresh(), false)
    })

    test('U-C03 invalidateCache 后立即判定失效', () => {
        logCache.generateCache()
        logCache.invalidateCache()
        assert.strictEqual(logCache.isCacheFresh(), false)
    })

    test('U-C04 getCachedData 同时返回 summary 与 accountSummary', () => {
        const data = logCache.getCachedData()
        assert.ok(data.summary && Array.isArray(data.summary.daily))
        assert.ok(Array.isArray(data.accountSummary))
    })

    test('U-C05 缓存文件损坏时自动重建而非抛异常', () => {
        fs.writeFileSync(logCache.CACHE_FILE, '{ this is not json', 'utf-8')
        let data = null
        assert.doesNotThrow(() => { data = logCache.getCachedData() })
        assert.ok(data && data.summary)
    })

    test('U-C06 重建缓存时清理 7 天前的残留文件【期望依据：cache/ 无轮转策略会无限堆积】', () => {
        const cacheDir = path.dirname(logCache.CACHE_FILE)
        fs.mkdirSync(cacheDir, { recursive: true })
        const stale = path.join(cacheDir, 'stale-orphan.json')
        const fresh = path.join(cacheDir, 'fresh-orphan.json')
        fs.writeFileSync(stale, '{}', 'utf-8')
        fs.writeFileSync(fresh, '{}', 'utf-8')
        const now = new Date()
        const weekAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000)
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        fs.utimesSync(stale, weekAgo, weekAgo)
        fs.utimesSync(fresh, dayAgo, dayAgo)

        logCache.generateCache()

        assert.ok(!fs.existsSync(stale), '8 天前的残留缓存文件未被清理')
        assert.ok(fs.existsSync(fresh), '1 天前的文件不应被清理')
        assert.ok(fs.existsSync(logCache.CACHE_FILE), '当前缓存文件不应被清理')
    })
})
