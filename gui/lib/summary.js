/**
 * GUI 日志统计摘要模块
 * 依赖：lib/logger.js（parseLogLine）、lib/config.js（LOGS_DIR）
 *
 * 2026-08-19 收益口径修正：
 * - 同一账号同一天多次运行时 ACCOUNT-END 收益改为累加（原为覆盖，导致只统计最后一次运行、漏计收益）
 * - 统计日期按本地时区（由 UTC 时间戳换算），替代直接取 UTC 日期切片，修复跨 UTC 日界的"今日收益"偏差
 * - generateSummary 新增 todayTotal（今日收益，本地时区）
 */
const fs = require('fs')
const path = require('path')
const { parseLogLine } = require('./logger')
const { LOGS_DIR } = require('./config')

// run 级事件（全局/集群/进程级）：这类日志行的 [账户] 字段来自上游动态 userName，
// 循环结束后可能残留"最后一个账号名"而非"主进程"，不能按 account 可靠过滤，
// 必须按 event 跳过，避免污染账号卡片的 lastEvent 与运行段归属（2026-08-23）
const RUN_LEVEL_EVENTS = new Set([
    'RUN-START',
    'RUN-END',
    'CLUSTER-PRIMARY',
    'CLUSTER-WORKER-START',
    'CLUSTER-WORKER-TASK',
    'CLUSTER-WORKER-EXIT',
    'CLUSTER-WORKER-ERROR',
    'CLUSTER-WORKER-DISCONNECT',
    'PROCESS',
    'MAIN-ERROR',
    'UNCAUGHT-EXCEPTION',
    'UNHANDLED-REJECTION',
])

function isRunLevelEvent(event) {
    return RUN_LEVEL_EVENTS.has(event)
}

// 由 UTC ISO 时间戳换算本地日期 YYYY-MM-DD（避免 toLocaleString 系统区域格式差异）
function toLocalDateKey(utcTime, fallback) {
    if (utcTime) {
        const d = new Date(utcTime)
        if (!isNaN(d.getTime())) {
            const y = d.getFullYear()
            const m = String(d.getMonth() + 1).padStart(2, '0')
            const day = String(d.getDate()).padStart(2, '0')
            return `${y}-${m}-${day}`
        }
    }
    return fallback || null
}

function summarizeLogs(entries) {
    const accounts = {}
    for (const e of entries) {
        if (!e || e.account === '主进程' || isRunLevelEvent(e.event)) continue
        if (!accounts[e.account]) {
            accounts[e.account] = { account: e.account, entries: 0, lastEvent: null, lastLevel: null, lastTime: null, lastMessage: null, collectedPoints: null, initialPoints: null, finalPoints: null }
        }
        const acc = accounts[e.account]
        acc.entries++
        acc.lastTime = e.utcTime || e.localTime
        acc.lastEvent = e.event
        acc.lastLevel = e.level
        acc.lastMessage = e.message

        // 容错（2026-08-20）：残缺条目（日志格式演进 / 第三方导入）可能没有 message 字段，
        // 直接调用 e.message.match 会抛 TypeError 并冒泡到接口层
        const msg = e.message || ''

        if (e.event === 'ACCOUNT-END') {
            const t = msg.match(/总计:\s*\+(\d+)/)
            const i = msg.match(/原始:\s*(\d+)\s*→/)
            const f = msg.match(/→\s*新值:\s*(\d+)/)
            // 同一天多次运行：收益累加；原始积分保留第一次，新值保留最后一次
            if (t) acc.collectedPoints = (acc.collectedPoints || 0) + parseInt(t[1], 10)
            if (i && acc.initialPoints === null) acc.initialPoints = parseInt(i[1], 10)
            if (f) acc.finalPoints = parseInt(f[1], 10)
        } else if (e.event === 'URL-REWARD' && msg.includes('完成UrlReward')) {
            const g = msg.match(/获得积分=(\d+)/)
            const n = msg.match(/新余额=(\d+)/)
            if (g) acc.collectedFromLastRun = parseInt(g[1], 10)
            if (n) acc.latestBalance = parseInt(n[1], 10)
        } else if (e.event === 'SEARCH-BING' && msg.includes('获得积分')) {
            const g = msg.match(/获得积分=(\d+)/)
            if (g) acc.searchPoints = (acc.searchPoints || 0) + parseInt(g[1], 10)
        } else if (e.event === 'DAILY-CHECK-IN' && msg.includes('完成每日签到')) {
            const g = msg.match(/获得积分=(\d+)/)
            if (g) acc.checkInPoints = parseInt(g[1], 10)
        }
    }
    return Object.values(accounts)
}

function summarizeAllLogs(logsDir = LOGS_DIR) {
    const entries = []
    let logFiles = []
    try {
        if (fs.existsSync(logsDir)) logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).sort()
    } catch { logFiles = [] }
    for (const file of logFiles) {
        let content
        try { content = fs.readFileSync(path.join(logsDir, file), 'utf-8') } catch { continue }
        for (const line of content.split('\n')) {
            const entry = parseLogLine(line)
            if (entry) entries.push(entry)
        }
    }
    return summarizeLogs(entries)
}

function generateSummary(logsDir = LOGS_DIR) {
    const summary = { generatedAt: new Date().toISOString(), daily: [], accountTotals: [], grandTotal: 0, todayTotal: 0 }
    let logFiles = []
    try {
        if (fs.existsSync(logsDir)) logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).sort()
    } catch { logFiles = [] }
    if (!logFiles.length) return summary

    // 收益口径（2026-08-22 修复）：由「(天, 账号)」二选一升级为「(运行段, 账号)」。
    // 原实现按天判定 hasAccountEnd：同一天同一账号多次运行（脚本重启/中断续跑）时，
    // 只要最后一次运行有 ACCOUNT-END 就只取 END 总计，前面被截断运行的真实收益
    // （仅存在于活动积分行中）被整体丢弃（实测 guidata 日志漏算 255 分）。
    // 现以 ACCOUNT-START 为运行段边界：段内有 ACCOUNT-END 用 END 权威总计（防活动行
    // 与余额差口径不一致），段内无 END 用段内活动积分兜底；段收益归属段结束日
    // （段内最后一行的本地日期）。段状态跨文件保持；兼容无 ACCOUNT-START 的旧日志
    // （惰性段按本地日期切分，避免跨天的独立运行被误并为一段）。
    const segments = {} // account -> { started, endSum, hasEnd, act, lastDateKey }
    const dailyMap = {} // dateKey -> { account -> points }

    function settleSegment(account) {
        const seg = segments[account]
        if (!seg) return
        const points = seg.hasEnd ? seg.endSum : seg.act
        if (!dailyMap[seg.lastDateKey]) dailyMap[seg.lastDateKey] = {}
        dailyMap[seg.lastDateKey][account] = (dailyMap[seg.lastDateKey][account] || 0) + points
        delete segments[account]
    }

    for (const file of logFiles) {
        let content
        try { content = fs.readFileSync(path.join(logsDir, file), 'utf-8') } catch { continue }
        for (const line of content.split('\n')) {
            const entry = parseLogLine(line)
            if (!entry || entry.account === '主进程' || isRunLevelEvent(entry.event)) continue
            const dateKey = toLocalDateKey(entry.utcTime, file.replace('.log', ''))
            if (!dateKey) continue
            if (entry.event === 'ACCOUNT-START') {
                settleSegment(entry.account) // 上一运行段结算（若有）
                segments[entry.account] = { started: true, endSum: 0, hasEnd: false, act: 0, lastDateKey: dateKey }
                continue
            }
            let seg = segments[entry.account]
            if (!seg) {
                // 兼容无 ACCOUNT-START 直接出现 END/活动行的日志（旧格式/测试夹具）：惰性开段
                segments[entry.account] = seg = { started: false, endSum: 0, hasEnd: false, act: 0, lastDateKey: dateKey }
            } else if (!seg.started && seg.lastDateKey !== dateKey) {
                // 惰性段跨本地日期：视为两次独立运行（真实日志总有 START，此分支仅兜底旧数据）
                settleSegment(entry.account)
                segments[entry.account] = seg = { started: false, endSum: 0, hasEnd: false, act: 0, lastDateKey: dateKey }
            }
            seg.lastDateKey = dateKey // 段内最后一行日期 = 段结束日
            if (entry.event === 'ACCOUNT-END') {
                const m = (entry.message || '').match(/总计:\s*\+(\d+)/)
                if (m) {
                    seg.endSum += parseInt(m[1], 10)
                    seg.hasEnd = true
                }
            } else if (entry.level === 'INFO') {
                const msg = entry.message || ''
                let p = null
                if (msg.includes('完成UrlReward') && msg.includes('获得积分')) {
                    const m = msg.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                } else if (msg.includes('完成每日签到') && msg.includes('获得积分')) {
                    const m = msg.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                } else if (msg.includes('阅读文章') && msg.includes('获得积分')) {
                    const m = msg.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                } else if (entry.event === 'SEARCH-BING' && msg.includes('获得积分')) {
                    const m = msg.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                }
                if (p !== null) seg.act += p
            }
        }
    }
    // 遍历结束，结算所有残留运行段
    for (const account of Object.keys(segments)) settleSegment(account)

    const accMap = {}
    const dates = Object.keys(dailyMap).sort()
    const todayKey = toLocalDateKey(new Date().toISOString())
    for (const date of dates) {
        const dayEntries = Object.entries(dailyMap[date]).map(([account, points]) => {
            if (!accMap[account]) accMap[account] = { totalPoints: 0, activeDays: 0 }
            accMap[account].totalPoints += points
            accMap[account].activeDays += 1
            return { account, points }
        })
        const dayTotal = dayEntries.reduce((s, e) => s + e.points, 0)
        summary.daily.push({ date, total: dayTotal, accounts: dayEntries })
        summary.grandTotal += dayTotal
        if (date === todayKey) summary.todayTotal = dayTotal
    }
    summary.accountTotals = Object.entries(accMap)
        .map(([account, v]) => ({ account, totalPoints: v.totalPoints, activeDays: v.activeDays }))
        .sort((a, b) => b.totalPoints - a.totalPoints)
    return summary
}

function writeSummaryFile(summary, target) {
    try {
        fs.writeFileSync(target, JSON.stringify(summary, null, 4) + '\n', 'utf-8')
        return target
    } catch (e) {
        console.error(`[GUI] 写入 summary.json 失败: ${e.message}`)
        return null
    }
}

module.exports = { summarizeLogs, summarizeAllLogs, generateSummary, writeSummaryFile }
