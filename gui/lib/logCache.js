/**
 * GUI 日志分析预生成/缓存模块
 *
 * 背景：/api/accounts 与 /api/stats 原先每次请求都全量扫描 logs/*.log 并逐行解析，
 *       前端 30s 轮询会重复触发，日志文件增多后响应明显变慢。
 *
 * 方案：将复杂的原始日志解析结果预生成为轻量 JSON 摘要
 *       （gui/cache/account-summary.json，含 accountSummary + summary），
 *       接口层改为直接读取缓存，不再实时解析原始大文件。
 *
 * 失效策略：对比「日志文件集合快照」（文件名 + 大小 + mtime）。
 *       注意：不能用单一"最新 mtime"判定——导入的日志 zip 解压后会保留打包时的旧时间戳，
 *       若旧时间戳早于缓存生成时间，mtime 判定会错误地认为缓存新鲜，导致新导入的日志
 *       永远无法进入缓存（且缓存持久化在磁盘，重启也无法恢复）。
 *       快照对比能识别任何文件的新增/删除/修改，是可靠的新鲜度依据。
 * 写入策略：tmp 文件 + rename 原子替换，避免读到半截内容。
 * 触发时机：请求时惰性重建（isCacheFresh 判定）；任务子进程退出后主动重建（见 taskManager）；
 *           日志/数据导入成功后主动失效（见 routes/logs.js、routes/data.js）。
 */
const fs = require('fs')
const path = require('path')
const { LOGS_DIR, GUI_DIR } = require('./config')
const summary = require('./summary')
const cleanup = require('./cleanup')

const CACHE_DIR = path.join(GUI_DIR, 'cache')
const CACHE_FILE = path.join(CACHE_DIR, 'account-summary.json')

// 日志文件集合快照：[{ name, size, mtimeMs }]，按文件名排序；无日志返回 []
function logFilesSnapshot() {
    try {
        if (!fs.existsSync(LOGS_DIR)) return []
        return fs.readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.log'))
            .map(f => {
                const s = fs.statSync(path.join(LOGS_DIR, f))
                return { name: f, size: s.size, mtimeMs: s.mtimeMs }
            })
            .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
        return []
    }
}

// 缓存是否新鲜：缓存存在，且缓存记录的文件快照与当前 logs/ 完全一致
function isCacheFresh() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return false
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
        return Boolean(cached.generatedAt)
            && JSON.stringify(cached.logFiles) === JSON.stringify(logFilesSnapshot())
    } catch {
        return false
    }
}

// 全量重建缓存（复用现有解析逻辑），原子写入；记录日志文件快照供新鲜度判定
function generateCache() {
    const payload = {
        generatedAt: new Date().toISOString(),
        logFiles: logFilesSnapshot(),
        summary: summary.generateSummary(),
        accountSummary: summary.summarizeAllLogs()
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const tmp = CACHE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, CACHE_FILE)
    // 惰性清理 7 天前的残留缓存文件（2026-08-21）：重建是低频操作，随重建顺带清理不产生额外成本
    cleanup.pruneOldCache(CACHE_DIR)
    return payload
}

// 主动失效缓存（删除缓存文件）：日志/数据导入成功后调用，确保下次请求立即重建
function invalidateCache() {
    try { fs.rmSync(CACHE_FILE, { force: true }) } catch {}
}

// 缓存不可用时的空摘要：结构与 generateCache 的 payload 一致，供接口层降级返回
function emptyPayload() {
    const now = new Date().toISOString()
    return {
        generatedAt: now,
        logFiles: [],
        summary: { generatedAt: now, daily: [], accountTotals: [], grandTotal: 0, todayTotal: 0 },
        accountSummary: []
    }
}

// 接口层统一入口：新鲜则读缓存，否则重建后返回
// 异常兜底（2026-08-20）：缓存是性能优化，不应成为可用性单点。缓存目录被同名文件占位、
// 磁盘写满、权限不足时 mkdir/write/rename 会抛异常；而 /api/stats 与 /api/accounts 是同步调用，
// 异常会逃逸到 server 分发层终止 GUI 进程，故此处降级为空摘要 + 告警。
function getCachedData() {
    try {
        if (isCacheFresh()) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
        }
        return generateCache()
    } catch (e) {
        console.warn(`[GUI] 日志摘要缓存不可用，返回空摘要: ${e.message}`)
        return emptyPayload()
    }
}

module.exports = { getCachedData, generateCache, isCacheFresh, invalidateCache, CACHE_FILE }
