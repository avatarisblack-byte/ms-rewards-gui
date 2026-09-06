/**
 * 日志路由（GET /api/logs、GET /api/logs/export、POST /api/logs/import、GET /api/logs/:date、GET /api/logs/summary）
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')

function handleLogs(req, res, pathname, ctx) {
    const { config, http, logger, archive, summary, logCache } = ctx

    // GET /api/logs（文件列表）
    // 方法校验（2026-08-20）：原先任意方法都会命中读取分支
    if (pathname === '/api/logs') {
        if (req.method !== 'GET') {
            http.sendJson(res, 405, { error: '仅支持 GET /api/logs' })
            return true
        }
        const files = logger.listLogFiles()
        http.sendJson(res, 200, { files, logsDir: config.LOGS_DIR })
        return true
    }

    // GET /api/logs/export（打包下载）
    if (pathname === '/api/logs/export' && req.method === 'GET') {
        return (async () => {
            let zipPath = null
            try {
                if (!fs.existsSync(config.LOGS_DIR)) {
                    return http.sendJson(res, 400, { error: '没有可导出的日志（logs/ 目录不存在）' })
                }
                const logFiles = fs.readdirSync(config.LOGS_DIR).filter(f => f.endsWith('.log'))
                if (!logFiles.length) {
                    return http.sendJson(res, 400, { error: '没有可导出的日志（logs/ 下无 .log 文件）' })
                }
                const tmpRoot = archive.makeTmpRoot('gui-log-export')
                const stageDir = path.join(tmpRoot, 'export')
                fs.mkdirSync(stageDir, { recursive: true })
                for (const f of logFiles) {
                    fs.copyFileSync(path.join(config.LOGS_DIR, f), path.join(stageDir, f))
                }
                zipPath = path.join(tmpRoot, 'logs.zip')
                await archive.zipDir(stageDir, zipPath)

                const now = new Date()
                const pad = n => String(n).padStart(2, '0')
                const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
                const fileData = fs.readFileSync(zipPath)
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="logs-${stamp}.zip"`,
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

    // POST /api/logs/import（白名单 *_.log + 防穿越 + .bak 备份）
    if (pathname === '/api/logs/import' && req.method === 'POST') {
        return (async () => {
            let tmpRoot = null
            try {
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object') {
                    return http.sendJson(res, 400, { error: '请求体必须包含 filename 和 dataBase64' })
                }
                if (typeof body.filename !== 'string' || !/\.zip$/i.test(body.filename)) {
                    return http.sendJson(res, 400, { error: '仅支持 .zip 压缩包' })
                }
                if (typeof body.dataBase64 !== 'string' || !body.dataBase64) {
                    return http.sendJson(res, 400, { error: '缺少压缩包数据 (dataBase64)' })
                }
                tmpRoot = archive.makeTmpRoot('gui-log-import')
                const zipPath = path.join(tmpRoot, 'import.zip')
                const extractDir = path.join(tmpRoot, 'extracted')
                fs.mkdirSync(extractDir, { recursive: true })
                fs.writeFileSync(zipPath, Buffer.from(body.dataBase64, 'base64'))
                await archive.unzipToDir(zipPath, extractDir)

                const imported = []
                fs.mkdirSync(config.LOGS_DIR, { recursive: true })
                const scanDir = dir => {
                    if (!fs.existsSync(dir)) return
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const full = path.join(dir, entry.name)
                        const rel = path.relative(extractDir, full)
                        if (rel.startsWith('..') || path.isAbsolute(rel)) continue
                        if (entry.isDirectory()) {
                            scanDir(full)
                        } else if (entry.name.endsWith('.log')) {
                            const targetFile = path.join(config.LOGS_DIR, entry.name)
                            if (path.relative(config.LOGS_DIR, targetFile).startsWith('..')) continue
                            if (fs.existsSync(targetFile)) {
                                try { fs.copyFileSync(targetFile, targetFile + '.bak') } catch {}
                            }
                            fs.copyFileSync(full, targetFile)
                            imported.push(entry.name)
                        }
                    }
                }
                scanDir(extractDir)
                if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} ; tmpRoot = null }
                if (!imported.length) {
                    return http.sendJson(res, 400, { error: '压缩包内未找到 .log 文件，导入失败' })
                }
                // 日志文件已变更：主动失效分析缓存，避免下次请求读到旧摘要（zip 解压保留旧 mtime，快照判定无法覆盖）
                logCache.invalidateCache()
                console.log(`[GUI] 已导入 ${imported.length} 个日志文件 → ${config.LOGS_DIR}`)
                return http.sendJson(res, 200, { success: true, message: `已导入 ${imported.length} 个日志文件`, files: imported, target: config.LOGS_DIR })
            } catch (error) {
                if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} }
                return http.sendJson(res, 400, { error: error.message || '导入失败' })
            }
        })()
    }

    // GET /api/logs/summary（最新日志聚合）
    // 方法校验（2026-08-21）：与 /api/logs 同属读接口，任意方法命中读取分支属同类未动项
    if (pathname === '/api/logs/summary') {
        if (req.method !== 'GET') {
            http.sendJson(res, 405, { error: '仅支持 GET /api/logs/summary' })
            return true
        }
        const file = logger.readLogFile(null)
        if (file && file.entries) file.summary = summary.summarizeLogs(file.entries)
        http.sendJson(res, 200, file)
        return true
    }

    // GET /api/logs/:date（方法校验同上，2026-08-21）
    const logMatch = pathname.match(/^\/api\/logs\/(\d{4}-\d{2}-\d{2})$/)
    if (logMatch) {
        if (req.method !== 'GET') {
            http.sendJson(res, 405, { error: `仅支持 GET /api/logs/${logMatch[1]}` })
            return true
        }
        const file = logger.readLogFile(logMatch[1])
        if (file && file.entries) file.summary = summary.summarizeLogs(file.entries)
        http.sendJson(res, 200, file)
        return true
    }

    return false
}

module.exports = handleLogs