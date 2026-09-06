/**
 * 一键数据路由（GET /api/data/export、POST /api/data/import）
 * 签名：(req, res, pathname, ctx) => boolean
 * 打包/恢复 sessions + logs + .env（账号）+ config.json（白名单 + 防穿越 + .bak 回滚）
 * sessions 双格式（2026-09-06）：v4 sessions/sessions.db（+WAL 伴生）；v3 <email>/session_*.json 回退
 * 账号双格式（2026-09-06）：v4 .env（ACCOUNT_N_*）；v3 旧包 accounts.json 导入时自动转换为 .env
 */
const fs = require('fs')
const path = require('path')
const sessionFiles = require('../sessionFiles')
const envAccounts = require('../envAccounts')

function handleData(req, res, pathname, ctx) {
    const { config, http, archive, logCache } = ctx

    // GET /api/data/export
    if (pathname === '/api/data/export' && req.method === 'GET') {
        return (async () => {
            let zipPath = null
            try {
                const tmpRoot = archive.makeTmpRoot('gui-data-export')
                const stageDir = path.join(tmpRoot, 'export')
                fs.mkdirSync(stageDir, { recursive: true })

                for (const s of sessionFiles.listSessionFiles()) {
                    const dir = path.join(stageDir, 'sessions', path.dirname(s.rel))
                    fs.mkdirSync(dir, { recursive: true })
                    fs.copyFileSync(s.abs, path.join(dir, path.basename(s.rel)))
                }

                if (fs.existsSync(config.LOGS_DIR)) {
                    // 先创建目标子目录，避免 copyFileSync 报 ENOENT
                    fs.mkdirSync(path.join(stageDir, 'logs'), { recursive: true })
                    for (const f of fs.readdirSync(config.LOGS_DIR).filter(f => f.endsWith('.log'))) {
                        fs.copyFileSync(path.join(config.LOGS_DIR, f), path.join(stageDir, 'logs', f))
                    }
                }

                // v4 账号来源是 .env（accounts.json 已不被 V4-china 读取）——打包 .env 供恢复/迁移
                const envPath = envAccounts.envFilePath()
                if (fs.existsSync(envPath)) fs.copyFileSync(envPath, path.join(stageDir, '.env'))

                const configPath = config.resolveConfigPath()
                if (fs.existsSync(configPath)) fs.copyFileSync(configPath, path.join(stageDir, 'config.json'))

                zipPath = path.join(tmpRoot, 'gui-data.zip')
                await archive.zipDir(stageDir, zipPath)

                const now = new Date()
                const pad = n => String(n).padStart(2, '0')
                const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
                const fileData = fs.readFileSync(zipPath)
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="gui-data-${stamp}.zip"`,
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

    // POST /api/data/import
    if (pathname === '/api/data/import' && req.method === 'POST') {
        return (async () => {
            let tmpRoot = null
            const backups = []
            try {
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object') return http.sendJson(res, 400, { error: '请求体必须包含 filename 和 dataBase64' })
                if (typeof body.filename !== 'string' || !/\.zip$/i.test(body.filename)) return http.sendJson(res, 400, { error: '仅支持 .zip 压缩包' })
                if (typeof body.dataBase64 !== 'string' || !body.dataBase64) return http.sendJson(res, 400, { error: '缺少压缩包数据 (dataBase64)' })

                tmpRoot = archive.makeTmpRoot('gui-data-import')
                const zipPath = path.join(tmpRoot, 'import.zip')
                const extractDir = path.join(tmpRoot, 'extracted')
                fs.mkdirSync(extractDir, { recursive: true })
                fs.writeFileSync(zipPath, Buffer.from(body.dataBase64, 'base64'))
                await archive.unzipToDir(zipPath, extractDir)

                const backupFile = target => {
                    if (fs.existsSync(target)) { fs.copyFileSync(target, target + '.bak'); backups.push(target) }
                }

                const imported = { sessions: 0, logs: 0, accounts: 0, config: 0 }
                const scanDir = (dir, relPrefix) => {
                    if (!fs.existsSync(dir)) return
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const full = path.join(dir, entry.name)
                        const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name
                        if (rel.split(path.sep).some(p => p === '..')) continue
                        if (entry.isDirectory()) { scanDir(full, rel); continue }
                        const norm = rel.replace(/\\/g, '/')
                        // v4 会话库文件（sessions/sessions.db 及 WAL 伴生；gui-session 导出的裸文件名同样收录）
                        const dbMatch = norm.match(/^(?:sessions\/)?(sessions\.db(?:-wal|-shm)?)$/)
                        if (dbMatch) {
                            const targetFile = sessionFiles.resolveSessionTarget(dbMatch[1])
                            if (!targetFile) continue
                            fs.mkdirSync(path.dirname(targetFile), { recursive: true })
                            backupFile(targetFile)
                            fs.copyFileSync(full, targetFile)
                            imported.sessions++
                            continue
                        }
                        // v3 会话（sessions/<email>/session_*.json，旧格式包兼容）
                        const sessMatch = norm.match(/^sessions\/([^/]+)\/(session_.*\.json)$/)
                        if (sessMatch) {
                            const [, emailDir, fileName] = sessMatch
                            const targetFile = sessionFiles.resolveSessionTarget(path.join(emailDir, fileName))
                            if (!targetFile) continue
                            fs.mkdirSync(path.dirname(targetFile), { recursive: true })
                            backupFile(targetFile)
                            fs.copyFileSync(full, targetFile)
                            imported.sessions++
                            continue
                        }
                        const logMatch = norm.match(/^logs\/([^/]+\.log)$/)
                        if (logMatch) {
                            const targetFile = path.join(config.LOGS_DIR, logMatch[1])
                            if (path.relative(config.LOGS_DIR, targetFile).startsWith('..')) continue
                            fs.mkdirSync(config.LOGS_DIR, { recursive: true })
                            backupFile(targetFile)
                            fs.copyFileSync(full, targetFile)
                            imported.logs++
                            continue
                        }
                        // v4 账号包：.env 整体恢复（覆盖账号段 + 非账号行，与 v3 accounts.json 的覆盖语义一致）
                        if (norm === '.env') {
                            const targetFile = envAccounts.envFilePath()
                            backupFile(targetFile)
                            fs.copyFileSync(full, targetFile)
                            imported.accounts++
                            continue
                        }
                        // v3 旧数据包：accounts.json 转换为 .env 账号段（保留现有 .env 的非账号行）
                        if (norm === 'accounts.json') {
                            const migrated = envAccounts.accountsJsonToContract(
                                fs.readFileSync(full, 'utf-8')
                            )
                            if (migrated.length) {
                                const targetFile = envAccounts.envFilePath()
                                backupFile(targetFile)
                                const current = envAccounts.parseEnvAccounts(
                                    fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf-8') : ''
                                )
                                envAccounts.writeEnvAccounts(
                                    migrated.map(a => ({ index: '', ...a })),
                                    current.otherLines
                                )
                                imported.accounts++
                            }
                            continue
                        }
                        if (norm === 'config.json') {
                            const targetFile = config.resolveConfigPath()
                            backupFile(targetFile)
                            fs.copyFileSync(full, targetFile)
                            imported.config++
                            continue
                        }
                    }
                }
                scanDir(extractDir, '')
                if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} ; tmpRoot = null }

                const total = imported.sessions + imported.logs + imported.accounts + imported.config
                if (!total) return http.sendJson(res, 400, { error: '压缩包内未找到可导入的数据（需为 gui-data 导出格式或含 sessions/logs/.env/config.json，旧包 accounts.json 亦可）' })
                // 日志文件可能已变更：主动失效分析缓存，确保下次请求重建摘要
                if (imported.logs > 0) logCache.invalidateCache()
                console.log(`[GUI] 数据导入完成: sessions=${imported.sessions} logs=${imported.logs} accounts=${imported.accounts} config=${imported.config}`)
                return http.sendJson(res, 200, { success: true, message: '数据导入完成', imported })
            } catch (error) {
                for (const target of backups) { try { fs.copyFileSync(target + '.bak', target) } catch {} }
                if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} }
                return http.sendJson(res, 400, { error: error.message || '导入失败' })
            }
        })()
    }

    return false
}

module.exports = handleData