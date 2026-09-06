/**
 * 日志导入 + 分析流程测试
 *
 * 数据源：test/data/logs-20260819-125022/（7 份日志：2026-08-13 ~ 2026-08-19）
 * 被测模块：
 *   - gui/lib/logger.js   (parseLogLine 逐行解析)
 *   - gui/lib/summary.js  (summarizeLogs 单日聚合 / generateSummary 全局统计)
 *
 * 运行：node test/script/run-log-tests.js
 *
 * 说明：
 *   - 零依赖，仅用 Node 内置 assert / fs / path
 *   - 统计期望值来自日志内 ACCOUNT-END 权威总计（跨 RUN-END 交叉验证）+ 独立参考实现计算的活动积分兜底
 *   - 失败时仅报告，不修改任何被测代码
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { parseLogLine } = require('../../gui/lib/logger')
const { summarizeLogs, generateSummary } = require('../../gui/lib/summary')

const DATA_DIR = path.join(__dirname, '..', 'data', 'logs-20260819-125022')

// ---------- 工具 ----------

/** 独立参考实现：仅统计单文件 INFO 级活动积分（与 summary.js activityPoints 口径一致，代码路径独立） */
function referenceActivityPoints(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8')
    let total = 0
    for (const line of content.split('\n')) {
        if (!line || !line.includes(' [INFO] ')) continue
        let m = null
        if (line.includes('完成UrlReward') && line.includes('获得积分=')) {
            m = line.match(/获得积分=(\d+)/)
        } else if (line.includes('完成每日签到') && line.includes('获得积分=')) {
            m = line.match(/获得积分=(\d+)/)
        } else if (line.includes('阅读文章') && line.includes('获得积分=')) {
            m = line.match(/获得积分=(\d+)/)
        } else if (line.includes('[SEARCH-BING]') && line.includes('获得积分=')) {
            m = line.match(/获得积分=(\d+)\s+points/)
        }
        if (m) total += parseInt(m[1], 10)
    }
    return total
}

/**
 * 独立参考实现（与被测 summary.js 完全不同的代码路径）：
 * 按「运行段」聚合（ACCOUNT-START 为段边界）：段内有 ACCOUNT-END 用 END 权威总计，
 * 段内无 END 用段内活动积分兜底；段收益归属段结束日（段内最后一行的本地日期）。
 * 用于动态生成期望值，避免硬编码失误。
 * （2026-08-22 与 generateSummary 的「运行段粒度」口径同步，原按天二选一实现已废弃）
 */
function referenceSummary(dir) {
    const dayAcc = new Map() // date -> Map(account -> points)
    const seg = new Map()    // account -> { endSum, hasEnd, act, lastDate }
    function settle(account) {
        const s = seg.get(account)
        if (!s) return
        const points = s.hasEnd ? s.endSum : s.act
        if (!dayAcc.has(s.lastDate)) dayAcc.set(s.lastDate, new Map())
        const m = dayAcc.get(s.lastDate)
        m.set(account, (m.get(account) || 0) + points)
        seg.delete(account)
    }
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.log')).sort()) {
        for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
            if (!line) continue
            // 独立解析（split 法，不依赖被测 parseLogLine）。
            // 注意本地时间 [2026/8/18 20:09:34] 内含空格，split 后占 sp[1]+sp[2]：
            //   sp[0]=utc  sp[1]='[2026/8/18'  sp[2]='20:09:34]'  sp[3]=[账户]  sp[4]=[级别]  sp[5]=平台  sp[6]=[事件]  sp[7..]=消息
            const sp = line.split(' ')
            if (sp.length < 8) continue
            const utcTime = sp[0]
            const account = (sp[3] || '').replace(/^\[|\]$/g, '')
            const level = (sp[4] || '').replace(/^\[|\]$/g, '')
            const event = (sp[6] || '').replace(/^\[|\]$/g, '')
            const message = sp.slice(7).join(' ')
            if (!account || account === '主进程') continue
            const d = new Date(utcTime)
            if (isNaN(d.getTime())) continue
            const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            if (event === 'ACCOUNT-START') {
                settle(account) // 上一运行段结算
                seg.set(account, { start: true, endSum: 0, hasEnd: false, act: 0, lastDate: dateKey })
                continue
            }
            let s = seg.get(account)
            if (!s) {
                // 兼容无 ACCOUNT-START 的旧格式：惰性开段（跨日切分，避免独立运行误合并）
                seg.set(account, s = { start: false, endSum: 0, hasEnd: false, act: 0, lastDate: dateKey })
            } else if (!s.start && s.lastDate !== dateKey) {
                settle(account)
                seg.set(account, s = { start: false, endSum: 0, hasEnd: false, act: 0, lastDate: dateKey })
            }
            s.lastDate = dateKey
            if (event === 'ACCOUNT-END') {
                const tm = /总计:\s*\+(\d+)/.exec(message)
                if (tm) { s.endSum += parseInt(tm[1], 10); s.hasEnd = true }
            } else if (level === 'INFO') {
                let p = null
                let mm = null
                if (message.includes('完成UrlReward') && message.includes('获得积分=')) mm = /获得积分=(\d+)/.exec(message)
                else if (message.includes('完成每日签到') && message.includes('获得积分=')) mm = /获得积分=(\d+)/.exec(message)
                else if (message.includes('阅读文章') && message.includes('获得积分=')) mm = /获得积分=(\d+)/.exec(message)
                else if (event === 'SEARCH-BING' && message.includes('获得积分=')) mm = /获得积分=(\d+)\s+points/.exec(message)
                if (mm) p = parseInt(mm[1], 10)
                if (p !== null) s.act += p
            }
        }
    }
    for (const account of [...seg.keys()]) settle(account) // 结算残留运行段
    const daily = []
    let grandTotal = 0
    const accTotals = {} // account -> { totalPoints, activeDays }
    for (const [date, m] of [...dayAcc.entries()].sort()) {
        const accounts = []
        for (const [account, points] of [...m.entries()]) {
            accounts.push({ account, points })
            if (!accTotals[account]) accTotals[account] = { totalPoints: 0, activeDays: 0 }
            accTotals[account].totalPoints += points
            accTotals[account].activeDays += 1
        }
        const total = accounts.reduce((s, x) => s + x.points, 0)
        grandTotal += total
        daily.push({ date, total, accounts })
    }
    return {
        daily,
        grandTotal,
        accountTotals: Object.entries(accTotals).map(([account, v]) => ({ account, totalPoints: v.totalPoints, activeDays: v.activeDays })),
    }
}

// ---------- 断言收集器 ----------

const results = []
function check(name, fn) {
    try {
        fn()
        results.push({ name, pass: true })
    } catch (err) {
        results.push({ name, pass: false, err })
    }
}

// ---------- A. 导入日志测试（解析） ----------

function runImportTests() {
    const logFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.log')).sort()
    check('A0 测试目录存在 7 份日志文件', () => {
        assert.strictEqual(logFiles.length, 7)
    })

    // A1 每份文件可读且非空
    const allEntries = {}
    const failedLines = {}
    for (const f of logFiles) {
        const lines = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8').split('\n')
        check(`A1 文件 ${f} 可读且非空`, () => {
            assert.ok(lines.length > 1, '文件内容为空')
        })
        // 解析全部行
        const entries = []
        const nullLines = []
        for (const line of lines) {
            if (!line) continue // 跳过文件尾空行，不算异常
            const e = parseLogLine(line)
            if (e) entries.push(e)
            else nullLines.push(line)
        }
        allEntries[f] = entries
        failedLines[f] = nullLines
    }

    // A2 字段映射完整性：每条 entry 的 7 个核心字段均非空
    check('A2 字段映射完整（utcTime/localTime/account/level/platform/event/message 均非空）', () => {
        let total = 0
        for (const f of logFiles) {
            for (const e of allEntries[f]) {
                for (const key of ['utcTime', 'localTime', 'account', 'level', 'platform', 'event', 'message']) {
                    assert.ok(e[key] !== undefined && e[key] !== null && e[key] !== '', `字段 ${key} 为空: ${JSON.stringify(e)}`)
                }
                total++
            }
        }
        assert.ok(total > 0, '没有任何可解析条目')
    })

    // A3 时间戳字段：utcTime 符合 ISO 格式
    check('A3 utcTime 符合 ISO-8601 格式', () => {
        const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
        for (const f of logFiles) {
            for (const e of allEntries[f]) {
                assert.match(e.utcTime, isoRe, `非法 utcTime: ${e.utcTime}`)
            }
        }
    })

    // A4 典型行解析正确（取 08-19 第一条 ACCOUNT-START）
    check('A4 ACCOUNT-START 典型行解析字段值正确', () => {
        const line = '2026-08-19T03:06:26.213Z [2026/8/19 11:06:26] [avatar.is.black] [INFO] 主进程 [ACCOUNT-START] 开始处理账户: avatar.is.black@gmail.com | 地理位置: auto'
        const e = parseLogLine(line)
        assert.strictEqual(e.utcTime, '2026-08-19T03:06:26.213Z')
        assert.strictEqual(e.localTime, '2026/8/19 11:06:26')
        assert.strictEqual(e.account, 'avatar.is.black')
        assert.strictEqual(e.level, 'INFO')
        assert.strictEqual(e.platform, '主进程')
        assert.strictEqual(e.event, 'ACCOUNT-START')
        assert.ok(e.message.includes('开始处理账户: avatar.is.black@gmail.com'))
    })

    // A5 长 JSON 行（BROWSER-FINGERPRINT）message 完整保留
    check('A5 长 JSON 行 message 完整保留（BROWSER-FINGERPRINT）', () => {
        const line = '2026-08-19T03:06:27.940Z [2026/8/19 11:06:27] [avatar.is.black] [INFO] 移动端 [BROWSER] 创建浏览器，用户代理: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 EdgA/151.0.4129.70"'
        const e = parseLogLine(line)
        assert.strictEqual(e.event, 'BROWSER')
        assert.ok(e.message.startsWith('创建浏览器，用户代理'), 'message 被截断')
    })

    // A6 异常数据兜底：空行/空白/缩进列表/乱码/残缺行 → parseLogLine 返回 null（不崩溃）
    check('A6 异常行（空行/缩进列表/乱码/残缺）解析兜底返回 null', () => {
        const abnormal = [
            '',
            '   ',
            '  ✓ "尚公主" (建议=8, 相关=11)',
            '乱码行 not matching any pattern',
            '2026-08-19T03:06:26.212Z [不完整',
        ]
        for (const l of abnormal) {
            assert.strictEqual(parseLogLine(l), null, `应返回 null: ${JSON.stringify(l)}`)
        }
    })

    // A7 真实日志中 QUERY-MANAGER 缩进列表行确实被过滤（不计入条目）
    check('A7 QUERY-MANAGER 缩进列表行被解析过滤', () => {
        const f = '2026-08-19.log'
        const lines = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8').split('\n')
        const indentLines = lines.filter(l => l.startsWith('  ✓ ') || l.startsWith('  ✗ '))
        assert.ok(indentLines.length > 0, '测试数据中未找到缩进列表行，无法验证兜底')
        for (const l of indentLines) {
            assert.strictEqual(parseLogLine(l), null)
        }
    })

    // A8 积分字段提取：各类积分打在真实行上的解析
    check('A8 ACCOUNT-END 积分字段（总计/原始/新值）可提取', () => {
        const line = '2026-08-13T07:17:29.820Z [2026/8/13 15:17:29] [1206336074] [INFO] 主进程 [ACCOUNT-END] 已完成账户: 1206336074@qq.com | 总计: +204 | 原始: 722 → 新值: 926 | 持续时间: 10013.0秒'
        const e = parseLogLine(line)
        assert.strictEqual(e.event, 'ACCOUNT-END')
        assert.match(e.message, /总计:\s*\+204/)
        assert.match(e.message, /原始:\s*722\s*→/)
        assert.match(e.message, /→\s*新值:\s*926/)
    })

    check('A9 活动积分行（UrlReward/签到/阅读/搜索）可提取', () => {
        const samples = [
            '2026-08-19T03:09:53.591Z [2026/8/19 11:09:53] [avatar.is.black] [INFO] 移动端 [URL-REWARD] 完成UrlReward | offerId=Gamification_DailySet_ZHCN_20260819_Child1 | 状态=200 | 获得积分=10 | 新余额=498',
            '2026-08-19T03:10:53.334Z [2026/8/19 11:10:53] [avatar.is.black] [INFO] 移动端 [DAILY-CHECK-IN] 完成每日签到 | 类型=101 | 获得积分=15 | 原始余额=518 | 新余额=533',
            '2026-08-19T03:10:53.616Z [2026/8/19 11:10:53] [avatar.is.black] [INFO] 移动端 [READ-TO-EARN] 阅读文章 1/10 | 状态=200 | 获得积分=3 | 新余额=536',
            '2026-08-19T04:40:06.235Z [2026/8/19 12:40:06] [avatar.is.black] [INFO] 桌面端 [SEARCH-BING] 获得积分=3 points | query="孟子义李昀锐白天避嫌晚上营业" | remaining=24',
        ]
        const expects = [
            { event: 'URL-REWARD', msg: '获得积分=10' },
            { event: 'DAILY-CHECK-IN', msg: '获得积分=15' },
            { event: 'READ-TO-EARN', msg: '获得积分=3' },
            { event: 'SEARCH-BING', msg: '获得积分=3' },
        ]
        samples.forEach((line, i) => {
            const e = parseLogLine(line)
            assert.strictEqual(e.event, expects[i].event)
            assert.ok(e.message.includes(expects[i].msg), `缺失 ${expects[i].msg}: ${e.message}`)
        })
    })

    // A10 解析统计汇总（信息性）
    let totalParsed = 0
    let totalNull = 0
    for (const f of logFiles) {
        totalParsed += allEntries[f].length
        totalNull += failedLines[f].length
    }
    console.log(`  [信息] 总计解析成功 ${totalParsed} 行，格式异常被过滤 ${totalNull} 行`)

    return { allEntries, logFiles }
}

// ---------- B. 分析日志测试（统计） ----------

function runAnalysisTests() {
    // 独立参考实现生成期望值（避免硬编码失误：08-15/08-16 各有未完成运行的账户走活动积分兜底）
    const ref = referenceSummary(DATA_DIR)
    const refDaily = {}
    const refAcc = {}
    for (const d of ref.daily) refDaily[d.date] = d.total
    for (const a of ref.accountTotals) refAcc[a.account] = a.totalPoints

    const summary = generateSummary(DATA_DIR)
    const dailyMap = {}
    for (const d of summary.daily) dailyMap[d.date] = d.total

    // B0 daily 共 7 天（08-13 ~ 08-19）
    check('B0 daily 共 7 天', () => {
        assert.strictEqual(summary.daily.length, 7)
        assert.deepStrictEqual(summary.daily.map(d => d.date), [
            '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19',
        ])
    })

    // B1 每日 totals：ACCOUNT-END 优先（权威总计，跨 RUN-END 交叉验证）
    check('B1 08-13 每日收益 = 204（ACCOUNT-END 权威总计）', () => assert.strictEqual(dailyMap['2026-08-13'], 204))
    check('B2 08-14 每日收益 = 113（同一天两次运行 86+27 累加，验证 2026-08-19 修复）', () => assert.strictEqual(dailyMap['2026-08-14'], 113))
    check(`B3 08-15 每日收益 = ${refDaily['2026-08-15']}（1206336074 权威 132 + avatar.is.black 未完成运行走活动积分兜底 ${refDaily['2026-08-15'] - 132}）`, () => {
        assert.strictEqual(dailyMap['2026-08-15'], refDaily['2026-08-15'])
    })
    check(`B4 08-16 每日收益 = ${refDaily['2026-08-16']}（avatar.is.black 权威 77 + 1206336074 未完成运行走活动积分兜底 ${refDaily['2026-08-16'] - 77}）`, () => {
        assert.strictEqual(dailyMap['2026-08-16'], refDaily['2026-08-16'])
    })
    check('B5 08-17 每日收益 = 142（两账户 52+90）', () => assert.strictEqual(dailyMap['2026-08-17'], 142))
    // B6 08-18 段粒度：avatar.is.black 多次 ACCOUNT-START（部分运行无 END）时，
    // 收益 = 无 END 段活动积分 + 末段 ACCOUNT-END 权威（2026-08-22 修复验证点）
    check(`B6 08-18 每日收益 = ${refDaily['2026-08-18']}（与段粒度参考一致）`, () => {
        assert.strictEqual(dailyMap['2026-08-18'], refDaily['2026-08-18'])
    })

    // B7 08-19 无 ACCOUNT-END（运行中截断）→ 走活动积分兜底，不崩溃且 > 0
    const ref0819 = referenceActivityPoints(path.join(DATA_DIR, '2026-08-19.log'))
    check(`B7 08-19 无 ACCOUNT-END 走活动积分兜底（参考值 ${ref0819}）`, () => {
        assert.strictEqual(dailyMap['2026-08-19'], ref0819)
        assert.ok(ref0819 > 0, '参考兜底值应为正')
    })

    // B8 grandTotal 与 Σ daily.total 一致
    check('B8 grandTotal 与每日之和一致', () => {
        const sum = summary.daily.reduce((s, d) => s + d.total, 0)
        assert.strictEqual(summary.grandTotal, sum)
    })

    // B9 accountTotals 与独立参考实现逐账户比对
    check('B9 accountTotals 与独立参考实现完全一致', () => {
        assert.deepStrictEqual(
            [...summary.accountTotals].sort((a, b) => a.account.localeCompare(b.account)),
            [...ref.accountTotals].sort((a, b) => a.account.localeCompare(b.account))
        )
    })
    check('B10 accountTotals: LuMuggle116 = 272', () => assert.strictEqual(refAcc['LuMuggle116'], 272))
    check(`B11 accountTotals: avatar.is.black = ${refAcc['avatar.is.black']}（77+52+33+08-15兜底101+08-18多次运行92+08-19兜底${ref0819}）与被测一致`, () => {
        const uut = summary.accountTotals.find(a => a.account === 'avatar.is.black')
        assert.strictEqual(uut.totalPoints, refAcc['avatar.is.black'])
    })

    // B10 空目录兜底
    check('B12 generateSummary 对不存在的目录返回空结构（不崩溃）', () => {
        const empty = generateSummary(path.join(__dirname, '..', 'no-such-dir'))
        assert.strictEqual(empty.daily.length, 0)
        assert.strictEqual(empty.grandTotal, 0)
        assert.strictEqual(empty.accountTotals.length, 0)
    })

    // B11 summarizeLogs 单日聚合（08-14 两次运行累加）
    check('B13 summarizeLogs: 08-14 同一账号两次运行 collectedPoints=113 / initialPoints=944 / finalPoints=1060', () => {
        const lines = fs.readFileSync(path.join(DATA_DIR, '2026-08-14.log'), 'utf-8').split('\n')
        const entries = lines.map(parseLogLine).filter(Boolean)
        const accs = summarizeLogs(entries)
        const acc = accs.find(a => a.account === '1206336074')
        assert.ok(acc, '未找到 1206336074')
        assert.strictEqual(acc.collectedPoints, 113)
        assert.strictEqual(acc.initialPoints, 944)
        assert.strictEqual(acc.finalPoints, 1060)
    })

    // B12 summarizeLogs 08-18 三账户
    check('B14 summarizeLogs: 08-18 三账户 collectedPoints 33/142/272，finalPoints 488/1584/317', () => {
        const lines = fs.readFileSync(path.join(DATA_DIR, '2026-08-18.log'), 'utf-8').split('\n')
        const entries = lines.map(parseLogLine).filter(Boolean)
        const accs = summarizeLogs(entries)
        const m = Object.fromEntries(accs.map(a => [a.account, a]))
        assert.strictEqual(m['avatar.is.black'].collectedPoints, 33)
        assert.strictEqual(m['avatar.is.black'].finalPoints, 488)
        assert.strictEqual(m['1206336074'].collectedPoints, 142)
        assert.strictEqual(m['1206336074'].finalPoints, 1584)
        assert.strictEqual(m['LuMuggle116'].collectedPoints, 272)
        assert.strictEqual(m['LuMuggle116'].finalPoints, 317)
    })
}

// ---------- 主流程 ----------

function main() {
    console.log('=== 日志导入/解析测试 ===')
    runImportTests()
    console.log('=== 日志分析/统计测试 ===')
    runAnalysisTests()

    const passed = results.filter(r => r.pass).length
    const failed = results.filter(r => !r.pass)

    console.log('\n========================================')
    console.log(`断言结果：${passed} 通过 / ${results.length} 总`)
    if (failed.length === 0) {
        console.log('全部通过 ✓')
        for (const r of results) console.log(`  ✓ ${r.name}`)
    } else {
        console.log(`失败 ${failed.length} 项 ✗`)
        for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`)
    }
    console.log('========================================\n')

    if (failed.length > 0) {
        console.error('--- 失败明细 ---')
        for (const r of failed) {
            console.error(`\n✗ ${r.name}`)
            console.error(`  报错: ${r.err.message}`)
            console.error(`  堆栈:\n${r.err.stack.split('\n').slice(0, 5).join('\n')}`)
        }
        process.exit(1)
    }
}

main()