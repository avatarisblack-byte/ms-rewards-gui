/**
 * v3 → v4 会话迁移模块（2026-09-06 新增，gui-v4-api）
 *
 * 背景：v3 会话是文件 <sessions根>/<email>/session_mobile|desktop.json（纯 Cookie 数组）
 *   与 session_fingerprint_mobile|desktop.json（BrowserFingerprintWithHeaders）；
 * v4（V4-china）改用 SQLite 单库 <sessions根>/sessions.db：
 *   sessions(email, platform['mobile'|'desktop'], storage_state, fingerprint, updated_at)
 *   其中 storage_state 是 Playwright 完整 StorageState {cookies, origins}（Browser.ts 直接
 *   访问 .cookies/.origins 并整体传给 newContext）。仅把 json 落盘而不同步进 db，v4 仍会
 *   视为"未找到已保存的浏览器会话"而走密码登录——故导入 v3 会话后必须执行本迁移。
 *
 * 零第三方依赖：node:sqlite（Node ≥22.5 内置，v4 核心同款）。
 */
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const sessionFiles = require('./sessionFiles')

const COOKIE_FILE_RE = /^session_(mobile|desktop)\.json$/
const FINGERPRINT_FILE_RE = /^session_fingerprint_(mobile|desktop)\.json$/

/**
 * 扫描会话根目录下的 v3 结构，聚合为每账号每平台一条记录。
 * 返回 [{ email, platform, cookies, fingerprint, mtimeMs }]；无可迁移内容返回 []。
 */
function collectV3Sessions() {
    const root = sessionFiles.getSessionDir()
    if (!fs.existsSync(root)) return []
    const entries = []
    for (const dirEntry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue
        const email = dirEntry.name
        const dir = path.join(root, email)
        const byplatform = {}
        for (const f of fs.readdirSync(dir)) {
            const full = path.join(dir, f)
            let stat
            try { stat = fs.statSync(full) } catch { continue }
            if (!stat.isFile()) continue
            let m
            if ((m = COOKIE_FILE_RE.exec(f))) {
                try {
                    const cookies = JSON.parse(fs.readFileSync(full, 'utf-8'))
                    if (Array.isArray(cookies)) {
                        byplatform[m[1]] = byplatform[m[1]] || {}
                        byplatform[m[1]].cookies = cookies
                        byplatform[m[1]].mtimeMs = stat.mtimeMs
                    }
                } catch { /* 损坏文件跳过 */ }
            } else if ((m = FINGERPRINT_FILE_RE.exec(f))) {
                try {
                    byplatform[m[1]] = byplatform[m[1]] || {}
                    byplatform[m[1]].fingerprint = JSON.parse(fs.readFileSync(full, 'utf-8'))
                } catch { /* 指纹损坏视为缺失，v4 会重新生成 */ }
            }
        }
        for (const platform of ['mobile', 'desktop']) {
            const p = byplatform[platform]
            if (p && Array.isArray(p.cookies) && p.cookies.length) {
                entries.push({ email, platform, cookies: p.cookies, fingerprint: p.fingerprint || null, mtimeMs: p.mtimeMs || Date.now() })
            }
        }
    }
    return entries
}

/**
 * 把 v3 会话写入 v4 sessions.db（upsert；库/表不存在时自动创建，结构照抄 SessionStore.ts）。
 * 返回 { dbPath, migrated }；无可迁移内容时返回 { migrated: 0 }。
 */
function migrateV3JsonToDb() {
    const entries = collectV3Sessions()
    if (!entries.length) return { migrated: 0 }
    const dbPath = path.join(sessionFiles.getSessionDir(), 'sessions.db')
    const db = new DatabaseSync(dbPath)
    try {
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('PRAGMA busy_timeout = 5000')
        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                email         TEXT NOT NULL,
                platform      TEXT NOT NULL,
                storage_state TEXT,
                fingerprint   TEXT,
                updated_at    INTEGER NOT NULL,
                PRIMARY KEY (email, platform)
            )
        `)
        const upsert = db.prepare(`
            INSERT INTO sessions (email, platform, storage_state, fingerprint, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(email, platform)
            DO UPDATE SET storage_state = excluded.storage_state,
                          fingerprint = COALESCE(excluded.fingerprint, sessions.fingerprint),
                          updated_at = excluded.updated_at
        `)
        let migrated = 0
        for (const e of entries) {
            // v3 存纯 Cookie 数组；v4 的 storage_state 是完整 StorageState（origins 置空，
            // 仅影响 localStorage 恢复，Cookie 登录态完整保留）
            const storageState = JSON.stringify({ cookies: e.cookies, origins: [] })
            const fingerprint = e.fingerprint ? JSON.stringify(e.fingerprint) : null
            upsert.run(e.email, e.platform, storageState, fingerprint, Math.round(e.mtimeMs))
            migrated++
        }
        return { dbPath, migrated }
    } finally {
        db.close()
    }
}

module.exports = { collectV3Sessions, migrateV3JsonToDb }
