/**
 * GUI 日志解析与读取模块
 * 依赖：lib/config.js（LOGS_DIR）
 */
const fs = require('fs')
const path = require('path')
const { LOGS_DIR } = require('./config')

function parseLogLine(line) {
    if (!line) return null
    // 行尾归一化（2026-08-20）：JS 正则的 `.` 不匹配 \r，含 CRLF 行尾的日志（Windows 记事本、
    // 第三方导出的 zip）按 split('\n') 切分后每行残留 \r，会导致下方整行匹配失败被丢弃、统计归零
    const clean = line.replace(/\r+$/, '')
    if (clean.trim() === '') return null
    // v3 行（双时间戳）：UTC-ISO [本地时间] [账户] [级别] 平台 [事件] 消息
    const m3 = clean.match(
        /^(\d{4}-\d{2}-\d{2}T\S+)\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(\S+)\s+\[([^\]]+)\]\s+(.*)$/
    )
    if (m3) {
        return { utcTime: m3[1], localTime: m3[2], account: m3[3], level: m3[4], platform: m3[5], event: m3[6], message: m3[7] }
    }
    // v4 行（单时间戳，2026-09-06 适配 V4-china）：[本地时间] [账户] [级别] 平台 [事件] 消息
    // v4 Logger 只打一个 toLocaleString 本地时间戳；账户字段主进程为 MAIN、平台为 MAIN/MOBILE/DESKTOP。
    // 无 UTC 时间戳时 utcTime=null，日期归属由 summary 的文件名（本地日期）兜底。
    const m4 = clean.match(
        /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(\S+)\s+\[([^\]]+)\]\s+(.*)$/
    )
    if (m4) {
        return { utcTime: null, localTime: m4[1], account: m4[2], level: m4[3], platform: m4[4], event: m4[5], message: m4[6] }
    }
    return null
}

function listLogFiles() {
    try {
        if (!fs.existsSync(LOGS_DIR)) return []
        return fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log')).sort().reverse()
    } catch {
        return []
    }
}

function readLogFile(dateStr, limit = 0) {
    // 文件名解析（2026-08-20）：
    //   ① 补 .log 后缀——GET /api/logs/:date 传入的是不带后缀的日期串（如 2026-03-03），
    //      原实现直接拼路径导致读取必然失败、接口恒返回空 entries；
    //   ② 白名单校验——dateStr 直接参与 path.join，无校验时 '../x.log' 可读取 logs/ 之外的文件
    let fileName
    if (dateStr) {
        if (!/^\d{4}-\d{2}-\d{2}(\.log)?$/.test(dateStr)) {
            return { date: null, entries: [], summary: null }
        }
        fileName = dateStr.endsWith('.log') ? dateStr : `${dateStr}.log`
    } else {
        fileName = listLogFiles()[0]
    }
    if (!fileName) return { date: dateStr || null, entries: [], summary: null }
    const filePath = path.join(LOGS_DIR, fileName)
    try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        const startIndex = limit > 0 ? Math.max(0, lines.length - limit) : 0
        const entries = lines.slice(startIndex).map(parseLogLine).filter(Boolean)
        return { date: fileName.replace('.log', ''), entries, summary: null }
    } catch {
        return { date: dateStr || null, entries: [], summary: null }
    }
}

module.exports = { parseLogLine, listLogFiles, readLogFile, LOGS_DIR }