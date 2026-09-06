/**
 * Session 路由（POST /api/sessions/import、GET /api/sessions/export）
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')

function handleSessions(req, res, pathname, ctx) {
    const { config, http, archive } = ctx
    const SESSIONS_ROOT = path.join(config.ROOT, 'dist', 'browser', 'sessions')

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

                const imported = {}
                const scanDir = dir => {
                    if (!fs.existsSync(dir)) return
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const full = path.join(dir, entry.name)
                        const rel = path.relative(extractDir, full)
                        if (rel.startsWith('..') || path.isAbsolute(rel)) continue
                        if (entry.isDirectory()) { scanDir(full); continue }
                        if (!/^session_.*\.json$/.test(entry.name)) continue
                        const relParts = rel.split(path.sep)
                        if (relParts.length < 2) continue
                        const emailDir = relParts.slice(0, -1).join(path.sep)
                        const targetDir = path.join(SESSIONS_ROOT, emailDir)
                        if (path.relative(SESSIONS_ROOT, targetDir).startsWith('..')) continue
                        fs.mkdirSync(targetDir, { recursive: true })
                        const targetFile = path.join(targetDir, entry.name)
                        if (fs.existsSync(targetFile)) { try { fs.copyFileSync(targetFile, targetFile + '.bak') } catch {} }
                        fs.copyFileSync(full, targetFile)
                        if (!imported[emailDir]) imported[emailDir] = []
                        imported[emailDir].push(entry.name)
                    }
                }
                scanDir(extractDir)
                if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} ; tmpRoot = null }

                const emails = Object.keys(imported)
                if (!emails.length) return http.sendJson(res, 400, { error: '压缩包内未找到 session_*.json 文件，导入失败' })
                console.log(`[GUI] 已导入 ${emails.length} 个账号的 Session → ${SESSIONS_ROOT}`)
                return http.sendJson(res, 200, {
                    success: true,
                    message: `已导入 ${emails.length} 个账号的 Session`,
                    accounts: emails.map(e => ({ email: e, files: imported[e] })),
                    target: SESSIONS_ROOT
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
                if (!fs.existsSync(SESSIONS_ROOT)) return http.sendJson(res, 400, { error: 'No session directory found: dist/browser/sessions/' })
                const accountDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
                const sessions = []
                for (const emailDir of accountDirs) {
                    const dirPath = path.join(SESSIONS_ROOT, emailDir)
                    if (!fs.existsSync(dirPath)) continue
                    const files = fs.readdirSync(dirPath).filter(f => /^session_.*\.json$/.test(f))
                    for (const fileName of files) sessions.push({ emailDir, fileName, fullPath: path.join(dirPath, fileName) })
                }
                if (!sessions.length) return http.sendJson(res, 400, { error: '没有可导出的 Session（dist/browser/sessions/ 下无 session_*.json）' })

                const tmpRoot = archive.makeTmpRoot('gui-session-export')
                const stageDir = path.join(tmpRoot, 'export')
                for (const s of sessions) {
                    const dir = path.join(stageDir, s.emailDir)
                    fs.mkdirSync(dir, { recursive: true })
                    fs.copyFileSync(s.fullPath, path.join(dir, s.fileName))
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
                    'Content-Length': fileData.length,
                    'Access-Control-Allow-Origin': '*'
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