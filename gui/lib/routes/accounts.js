/**
 * 账号路由（GET/POST /api/accounts、PUT/DELETE /api/accounts/:email）
 * v4 适配（2026-09-06）：V4-china 不再读 accounts.json，账号唯一来源是 .env 的 ACCOUNT_N_*
 * 环境变量——读写目标改为 lib/envAccounts.js（.env），API 契约（响应结构/脱敏/占位符保护）
 * 与 v3 保持一致，前端零改动。
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')
const cleanup = require('../cleanup')
const envAccounts = require('../envAccounts')

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
            : { proxyHttp: false, url: '', port: 0, username: '', password: '' },
        saveFingerprint: body.saveFingerprint && typeof body.saveFingerprint === 'object' && !Array.isArray(body.saveFingerprint)
            ? body.saveFingerprint
            : { mobile: true, desktop: true }
    }
}

// 备份 .bak → 写回；失败自动恢复
// 备份轮转（2026-08-21）：写前把旧 .bak 轮转为带时间戳的历史备份（保留最近 5 个）
function backupAndWrite(nextAccounts, otherLines, res, http, onOk) {
    const envPath = envAccounts.envFilePath()
    // 文件不存在（首次添加）时无需备份
    if (fs.existsSync(envPath)) {
        cleanup.rotateBackup(envPath)
        try { fs.copyFileSync(envPath, envPath + '.bak') } catch (e) {
            http.sendJson(res, 500, { error: `备份 .env 失败: ${e.message}` }); return
        }
    }
    let written
    try {
        written = envAccounts.writeEnvAccounts(nextAccounts, otherLines)
    } catch (e) {
        const backupPath = envPath + '.bak'
        if (fs.existsSync(backupPath)) { try { fs.copyFileSync(backupPath, envPath) } catch {} }
        http.sendJson(res, 500, { error: `写入 .env 失败: ${e.message}` }); return
    }
    http.sendJson(res, 200, onOk(path.basename(written)))
}

function handleAccounts(req, res, pathname, ctx) {
    const { http, validator } = ctx
    const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/)

    // GET /api/accounts（关联日志摘要：从预生成缓存读取，避免每次全量扫描原始日志）
    if (pathname === '/api/accounts' && req.method === 'GET') {
        const { accounts } = envAccounts.readEnvFile()
        // .env 不存在/无账号返回空列表（v4 可从零开始配置，不再像 accounts.json 时代报 500）
        const logSummary = ctx.logCache.getCachedData().accountSummary
        const logMap = {}
        for (const s of logSummary) logMap[s.account] = s
        // 凭据脱敏（2026-08-21）：password/totpSecret 原样下发会让任意能访问本机的进程/网页
        // 读走全部账号凭据；列表渲染只需要邮箱与运行状态，密码一律显示为 ******。
        const enriched = accounts.map(a => {
            const contract = envAccounts.toContractAccount(a)
            const user = (typeof contract.email === 'string' ? contract.email : '').split('@')[0]
            return {
                ...contract,
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
                const { accounts, otherLines } = envAccounts.readEnvFile()
                if (accounts.some(a => a.email === newAccount.email)) {
                    return http.sendJson(res, 400, { error: `账号已存在: ${newAccount.email}` })
                }
                accounts.push({ index: String(accounts.length + 1), ...newAccount })
                backupAndWrite(accounts, otherLines, res, http, backup => ({
                    success: true, message: `账号 ${newAccount.email} 已添加（写入 .env）`, backup, account: newAccount
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
                const { accounts, otherLines } = envAccounts.readEnvFile()
                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) { return http.sendJson(res, 404, { error: `未找到账号: ${targetEmail}` }) }
                const removed = envAccounts.toContractAccount(accounts[idx])
                delete removed._index
                accounts.splice(idx, 1)
                backupAndWrite(accounts, otherLines, res, http, backup => ({
                    success: true, message: `账号 ${targetEmail} 已删除`, backup, account: removed
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
                const { accounts, otherLines } = envAccounts.readEnvFile()
                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) { return http.sendJson(res, 404, { error: `未找到账号: ${targetEmail}` }) }
                // 脱敏占位保护（2026-08-21）：GET 返回的 password/totpSecret 是 '******'，
                // 前端编辑其他字段时若原样回传该占位符，会覆盖磁盘上的真实凭据。
                // 占位值视为「未修改」，从合并体剔除后保留磁盘原值。
                const mergedBody = { ...body }
                if (mergedBody.password === '******') delete mergedBody.password
                if (mergedBody.totpSecret === '******') delete mergedBody.totpSecret
                const current = envAccounts.toContractAccount(accounts[idx])
                delete current._index
                accounts[idx] = { index: accounts[idx].index, ...current, ...mergedBody }
                backupAndWrite(accounts, otherLines, res, http, backup => ({
                    success: true, message: `账号 ${targetEmail} 配置已保存`, backup, account: envAccounts.toContractAccount(accounts[idx])
                }))
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    return false
}

module.exports = handleAccounts
