/**
 * 账号路由（GET/POST /api/accounts、PUT/DELETE /api/accounts/:email）
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')
const cleanup = require('../cleanup')

function buildNewAccount(body) {
    return {
        email: body.email,
        password: body.password,
        totpSecret: typeof body.totpSecret === 'string' ? body.totpSecret : '',
        recoveryEmail: typeof body.recoveryEmail === 'string' ? body.recoveryEmail : '',
        geoLocale: typeof body.geoLocale === 'string' ? body.geoLocale : 'auto',
        langCode: typeof body.langCode === 'string' ? body.langCode : 'zh',
        proxy: body.proxy && typeof body.proxy === 'object' && !Array.isArray(body.proxy)
            ? body.proxy
            : { proxyAxios: false, url: '', port: 0, username: '', password: '' },
        saveFingerprint: body.saveFingerprint && typeof body.saveFingerprint === 'object' && !Array.isArray(body.saveFingerprint)
            ? body.saveFingerprint
            : { mobile: true, desktop: true }
    }
}

// 备份 .bak → 写回；失败自动恢复
// 备份轮转（2026-08-21）：写前把旧 .bak 轮转为带时间戳的历史备份（保留最近 5 个）
function backupAndWrite(accountsPath, nextAccounts, res, http, onOk) {
    const backupPath = accountsPath + '.bak'
    cleanup.rotateBackup(accountsPath)
    try { fs.copyFileSync(accountsPath, backupPath) } catch (e) {
        http.sendJson(res, 500, { error: `备份 accounts.json 失败: ${e.message}` }); return
    }
    try {
        fs.writeFileSync(accountsPath, JSON.stringify(nextAccounts, null, 4) + '\n', 'utf-8')
    } catch (e) {
        try { fs.copyFileSync(backupPath, accountsPath) } catch {}
        http.sendJson(res, 500, { error: `写入 accounts.json 失败: ${e.message}` }); return
    }
    http.sendJson(res, 200, onOk(backupPath))
}

function handleAccounts(req, res, pathname, ctx) {
    const { config, http, validator } = ctx
    const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/)

    // GET /api/accounts（关联日志摘要：从预生成缓存读取，避免每次全量扫描原始日志）
    if (pathname === '/api/accounts' && req.method === 'GET') {
        const accounts = config.readJson(config.resolveAccountsPath())
        if (!accounts) { http.sendJson(res, 500, { error: '无法读取 accounts.json' }); return true }
        // 脏数据防御（2026-08-20）：非数组内容、缺失/非字符串 email 曾使下方 map 抛 TypeError，
        // 异常逃逸到 server 分发层会终止整个 GUI 进程
        if (!Array.isArray(accounts)) {
            http.sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' }); return true
        }
        const logSummary = ctx.logCache.getCachedData().accountSummary
        const logMap = {}
        for (const s of logSummary) logMap[s.account] = s
        // 凭据脱敏（2026-08-21）：password/totpSecret 原样下发会让任意能访问本机的进程/网页
        // 读走全部账号凭据；列表渲染只需要邮箱与运行状态，密码一律显示为 ******。
        const enriched = accounts.map(a => {
            const user = (typeof a?.email === 'string' ? a.email : '').split('@')[0]
            return {
                ...a,
                password: '******',
                totpSecret: '******',
                status: logMap[user] || { account: user, entries: 0 }
            }
        })
        http.sendJson(res, 200, { accounts: enriched, logSummary })
        return true
    }

    // POST /api/accounts（新增）
    if (pathname === '/api/accounts' && req.method === 'POST') {
        return (async () => {
            try {
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return http.sendJson(res, 400, { error: '请求体必须是一个账号对象' })
                }
                if (!body.email || typeof body.email !== 'string' || !body.email.includes('@')) {
                    return http.sendJson(res, 400, { error: 'email 必须是非空邮箱字符串' })
                }
                if (!body.password || typeof body.password !== 'string') {
                    return http.sendJson(res, 400, { error: 'password 必填且必须是字符串' })
                }
                const newAccount = buildNewAccount(body)
                const validationError = validator.validateAccountShape(newAccount)
                if (validationError) {
                    return http.sendJson(res, 400, { error: `账号格式校验失败: ${validationError}` })
                }
                const accountsPath = config.resolveAccountsPath()
                const accounts = config.readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return http.sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }
                if (accounts.some(a => a.email === newAccount.email)) {
                    return http.sendJson(res, 400, { error: `账号已存在: ${newAccount.email}` })
                }
                accounts.push(newAccount)
                backupAndWrite(accountsPath, accounts, res, http, backupPath => ({
                    success: true, message: `账号 ${newAccount.email} 已添加`, backup: path.basename(backupPath), account: newAccount
                }))
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // DELETE /api/accounts/:email
    if (accMatch && req.method === 'DELETE') {
        return (async () => {
            try {
                const targetEmail = decodeURIComponent(accMatch[1])
                const accountsPath = config.resolveAccountsPath()
                const accounts = config.readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return http.sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }
                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) { return http.sendJson(res, 404, { error: `未找到账号: ${targetEmail}` }) }
                const removed = accounts[idx]
                accounts.splice(idx, 1)
                backupAndWrite(accountsPath, accounts, res, http, backupPath => ({
                    success: true, message: `账号 ${targetEmail} 已删除`, backup: path.basename(backupPath), account: removed
                }))
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // PUT /api/accounts/:email（合并更新）
    if (accMatch && req.method === 'PUT') {
        return (async () => {
            try {
                const targetEmail = decodeURIComponent(accMatch[1])
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return http.sendJson(res, 400, { error: '请求体必须是一个账号对象' })
                }
                if (!body.email || String(body.email) !== targetEmail) {
                    return http.sendJson(res, 400, { error: '请求体中的 email 与目标账号不匹配' })
                }
                const validationError = validator.validateAccountShape(body)
                if (validationError) {
                    return http.sendJson(res, 400, { error: `账号格式校验失败: ${validationError}` })
                }
                const accountsPath = config.resolveAccountsPath()
                const accounts = config.readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return http.sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }
                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) { return http.sendJson(res, 404, { error: `未找到账号: ${targetEmail}` }) }
                // 脱敏占位保护（2026-08-21）：GET 返回的 password/totpSecret 是 '******'，
                // 前端编辑其他字段时若原样回传该占位符，会覆盖磁盘上的真实凭据。
                // 占位值视为「未修改」，从合并体剔除后保留磁盘原值。
                const mergedBody = { ...body }
                if (mergedBody.password === '******') delete mergedBody.password
                if (mergedBody.totpSecret === '******') delete mergedBody.totpSecret
                accounts[idx] = { ...accounts[idx], ...mergedBody }
                backupAndWrite(accountsPath, accounts, res, http, backupPath => ({
                    success: true, message: `账号 ${targetEmail} 配置已保存`, backup: path.basename(backupPath), account: accounts[idx]
                }))
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    return false
}

module.exports = handleAccounts