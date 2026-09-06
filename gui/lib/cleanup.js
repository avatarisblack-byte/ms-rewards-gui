/**
 * GUI 备份轮转与缓存清理模块（2026-08-21）
 *
 * 背景：.bak 固定文件名会被每次写入覆盖，中间态备份无法追溯；cache/ 与 .bak 无轮转会无限堆积。
 * 策略：
 *   - 备份轮转：写前把旧 .bak 复制为 .bak.<UTC时间戳>（历史备份），每类文件保留最近 5 个；
 *   - 缓存清理：删除缓存目录中超过 7 天的文件（generateCache 成功后惰性触发）。
 * 容错原则：清理/轮转失败只告警，绝不影响主流程（备份与写入的正确性优先）。
 */
const fs = require('fs')
const path = require('path')

const BACKUP_KEEP = 5
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 把目标文件现有的 .bak 轮转为 .bak.<UTC时间戳>，并只保留最近 BACKUP_KEEP 个历史备份。
 * 调用时机：在「copy 当前文件 → .bak」之前，保证 .bak 始终是最新备份、历史可追溯。
 */
function rotateBackup(targetPath) {
    const bakPath = targetPath + '.bak'
    if (!fs.existsSync(bakPath)) return
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        fs.copyFileSync(bakPath, `${bakPath}.${stamp}`)
    } catch (e) {
        console.warn(`[GUI] 备份轮转失败（不影响写入）: ${e.message}`)
    }
    try {
        const dir = path.dirname(targetPath)
        const prefix = path.basename(targetPath) + '.bak.'
        const history = fs.readdirSync(dir)
            .filter(f => f.startsWith(prefix))
            .sort() // 时间戳字典序即时间序
        for (const f of history.slice(0, Math.max(0, history.length - BACKUP_KEEP))) {
            try { fs.rmSync(path.join(dir, f), { force: true }) } catch {}
        }
    } catch (e) {
        console.warn(`[GUI] 历史备份清理失败（不影响写入）: ${e.message}`)
    }
}

/** 删除缓存目录中 mtime 超过 maxAgeMs 的文件（默认 7 天） */
function pruneOldCache(cacheDir, maxAgeMs = CACHE_MAX_AGE_MS) {
    try {
        if (!fs.existsSync(cacheDir) || !fs.statSync(cacheDir).isDirectory()) return
        const cutoff = Date.now() - maxAgeMs
        for (const f of fs.readdirSync(cacheDir)) {
            const full = path.join(cacheDir, f)
            try {
                if (fs.statSync(full).isFile() && fs.statSync(full).mtimeMs < cutoff) {
                    fs.rmSync(full, { force: true })
                }
            } catch {}
        }
    } catch (e) {
        console.warn(`[GUI] 缓存清理失败（不影响主流程）: ${e.message}`)
    }
}

module.exports = { rotateBackup, pruneOldCache, BACKUP_KEEP }
