/**
 * Session 路由（POST /api/sessions/import、GET /api/sessions/export）
 * 方案 C / v4 适配（2026-09-06）：v4 会话为 <根>/sessions/sessions.db（SQLite 单库 + WAL 伴生），
 * 保留 v3 <email>/session_*.json 旧格式兼容（经 lib/sessionFiles.js 双格式收集/恢复）。
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')
const sessionFiles = require('../sessionFiles')
const sessionMigrate = require('../sessionMigrate')

// 允许导入的会话文件名：v4 单库（含 WAL 伴生）+ v3 按账号的 json（旧格式包兼容）
const IMPORT_NAME_RE = /^(sessions\.db(-wal|-shm)?|session_.*\.json)$/

function handleSessions(req, res, pathname, ctx) {
    const { http, archive } = ctx

    // POST /api/sessions/import
    if (pathname === '/api/sessions/import' && req.method === 'POST') {
        return (async () => {
            let tmpRoot = null
            try {
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object') return http.sendJson(res, 400, { error: '请求体必须包含 filename 和 dataBase64' })
                if (typeof body.filename !== 'string' || !/\.zip$/i.test(body.filename)) return http.sendJson(res, 400, { error: '仅支持 .zip 压缩包' })
                if (typeof body.dataBase64 !== 'string' || !body.dataBase64) return http.sendJson(res, 400, { error: '缺少压缩包数据 (dataBase64)' })

                tmpRoot = archive.makeTmpRoot('gui-session-import')
                const zipPath = path.join(tmpRoot, 'import.zip')
                const extractDir = path.join(tmpRoot, 'extracted')
                fs.mkdirSync(extractDir, { recursive: true })
                fs.writeFileSync(zipPath, Buffer.from(body.dataBase64, 'base64'))
                await archive.unzipToDir(zipPath, extractDir)

                const imported = []
                const scanDir = dir => {
                    if (!fs.existsSync(dir)) return
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const full = path.join(dir, entry.name)
                        const rel = path.relative(extractDir, full)
                        if (rel.startsWith('..') || path.isAbsolute(rel)) continue
                        if (entry.isDirectory()) { scanDir(full); continue }
                        // 白名单按文件名判断；zip 内路径可能是 sessions/ 前缀（gui-data 导出格式），剥掉后归一到 session 根
                        if (!IMPORT_NAME_RE.test(entry.name)) continue
                        const relParts = rel.split(path.sep).filter(p => p && p !== '.' && p !== 'sessions')
                        const target = sessionFiles.resolveSessionTarget(relParts.join(path.sep))
                        if (!target) continue
                        fs.mkdirSync(path.dirname(target), { recursive: true })
                        if (fs.existsSync(target)) { try { fs.copyFileSync(target, target + '.bak') } catch {} }
                        fs.copyFileSync(full, target)
                        imported.push(entry.name)
                    }
                }
                scanDir(extractDir)
                if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} ; tmpRoot = null }

                if (!imported.length) return http.sendJson(res, 400, { error: '压缩包内未找到会话文件（v4: sessions.db*；v3: session_*.json），导入失败' })
                // v3 json 会话迁移进 v4 sessions.db（v4 只读 db，不迁移则仍会走密码登录）
                let migrateNote = ''
                try {
                    const { migrated } = sessionMigrate.migrateV3JsonToDb()
                    if (migrated) migrateNote = `，已迁移 ${migrated} 条会话到 v4 会话库（sessions.db）`
                } catch (e) {
                    migrateNote = `（v4 会话库迁移失败: ${e.message}）`
                }
                console.log(`[GUI] 已导入 ${imported.length} 个会话文件 → ${sessionFiles.getSessionDir()}${migrateNote}`)
                return http.sendJson(res, 200, {
                    success: true,
                    message: `已导入 ${imported.length} 个会话文件${migrateNote}`,
                    files: imported,
                    target: sessionFiles.getSessionDir()
                })
            } catch (error) {
                if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} }
                return http.sendJson(res, 400, { error: error.message || '导入失败' })
            }
        })()
    }

    // GET /api/sessions/export
    if (pathname === '/api/sessions/export' && req.method === 'GET') {
        return (async () => {
            let zipPath = null
            try {
                const sessions = sessionFiles.listSessionFiles()
                if (!sessions.length) {
                    return http.sendJson(res, 400, { error: '没有可导出的会话（sessions/ 下无 sessions.db，且无 v3 格式 session_*.json）' })
                }

                const tmpRoot = archive.makeTmpRoot('gui-session-export')
                const stageDir = path.join(tmpRoot, 'export')
                for (const s of sessions) {
                    const dir = path.join(stageDir, path.dirname(s.rel))
                    fs.mkdirSync(dir, { recursive: true })
                    fs.copyFileSync(s.abs, path.join(dir, path.basename(s.rel)))
                }
                zipPath = path.join(tmpRoot, 'sessions.zip')
                await archive.zipDir(stageDir, zipPath)

                const now = new Date()
                const pad = n => String(n).padStart(2, '0')
                const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
                const fileData = fs.readFileSync(zipPath)
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="sessions-${stamp}.zip"`,
                    'Content-Length': fileData.length
                })
                res.end(fileData)
                try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
                zipPath = null
            } catch (error) {
                if (zipPath) { try { fs.rmSync(path.dirname(zipPath), { recursive: true, force: true }) } catch {} }
                return http.sendJson(res, 400, { error: error.message || '导出失败' })
            }
        })()
    }

    return false
}

module.exports = handleSessions
