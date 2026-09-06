/**
 * .env 账号读写模块（2026-09-06 新增，gui-v4-api）
 *
 * 背景：V4-china 架构性移除了 accounts.json 支持——src/ 与 scripts/api/ 均无读取代码，
 * 账号唯一来源是 .env 的 ACCOUNT_N_* 环境变量（src/util/Load.ts 的 loadAccounts 只走 env，
 * ensureEnvLoaded 加载项目根 .env）。GUI 的账号管理与数据导入导出据此从 accounts.json
 * 迁移到 .env，API 响应结构保持 v3 契约（前端零改动）。
 *
 * 键位与 Load.ts 的读取一一对应：
 *   ACCOUNT_N_EMAIL / PASSWORD / TOTP_SECRET / RECOVERY_EMAIL / GEO_LOCALE / LANG_CODE
 *   ACCOUNT_N_PROXY_HTTP / PROXY_URL / PROXY_PORT / PROXY_USERNAME / PROXY_PASSWORD
 *   ACCOUNT_N_SAVE_FINGERPRINT_MOBILE / SAVE_FINGERPRINT_DESKTOP
 */
const fs = require('fs')
const path = require('path')
const { ROOT } = require('./config')

const ACCOUNT_LINE_RE = /^ACCOUNT_(\d+)_([A-Z_]+)=(.*)$/
// GUI 侧账号字段 → .env 键名后缀
const FIELD_KEYS = {
    email: 'EMAIL',
    password: 'PASSWORD',
    totpSecret: 'TOTP_SECRET',
    recoveryEmail: 'RECOVERY_EMAIL',
    geoLocale: 'GEO_LOCALE',
    langCode: 'LANG_CODE',
    proxyHttp: 'PROXY_HTTP',
    proxyUrl: 'PROXY_URL',
    proxyPort: 'PROXY_PORT',
    proxyUsername: 'PROXY_USERNAME',
    proxyPassword: 'PROXY_PASSWORD',
    saveFingerprintMobile: 'SAVE_FINGERPRINT_MOBILE',
    saveFingerprintDesktop: 'SAVE_FINGERPRINT_DESKTOP'
}

function envFilePath() {
    return path.join(ROOT, '.env')
}

/** 剥离可选的成对引号（Load.ts 的 .env 解析同款语义） */
function unquote(value) {
    const v = value.trim()
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
        return v.slice(1, -1)
    }
    return v
}

function parseBool(v) {
    return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase())
}

function serializeValue(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    const s = String(v)
    // 含空白/#/引号的值用双引号包裹（.env 通用约定；Load.ts 支持成对双引号剥离）
    if (/[\s#"']/.test(s)) return `"${s.replace(/"/g, '\\"')}"`
    return s
}

/** 空账号骨架（与 v3 buildNewAccount 的默认值对齐） */
function emptyAccount() {
    return {
        email: '',
        password: '',
        totpSecret: '',
        recoveryEmail: '',
        geoLocale: 'auto',
        langCode: 'zh',
        proxy: { proxyHttp: false, url: '', port: 0, username: '', password: '' },
        saveFingerprint: { mobile: true, desktop: true }
    }
}

/**
 * 解析 .env 文本 → { accounts: [{index, ...account}], otherLines: [原样的非账号行] }
 * 注释行/空行/其他键原样保留；被识别的 ACCOUNT_N_* 键被消费（写入时按账号重建）。
 * 仅解析真实赋值行（# 开头的注释不解析——env.example 中被注释的可选键不会误入）。
 */
function parseEnvAccounts(text) {
    const accounts = new Map()
    const otherLines = []
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim()
        const m = !line.startsWith('#') && ACCOUNT_LINE_RE.exec(line)
        if (!m) { otherLines.push(rawLine); continue }
        const index = m[1]
        const key = m[2]
        const value = unquote(m[3])
        if (!accounts.has(index)) accounts.set(index, { index, ...emptyAccount() })
        const acc = accounts.get(index)
        switch (key) {
            case FIELD_KEYS.email: acc.email = value; break
            case FIELD_KEYS.password: acc.password = value; break
            case FIELD_KEYS.totpSecret: acc.totpSecret = value; break
            case FIELD_KEYS.recoveryEmail: acc.recoveryEmail = value; break
            case FIELD_KEYS.geoLocale: acc.geoLocale = value || 'auto'; break
            case FIELD_KEYS.langCode: acc.langCode = value || 'zh'; break
            case FIELD_KEYS.proxyHttp: acc.proxy.proxyHttp = parseBool(value); break
            case FIELD_KEYS.proxyUrl: acc.proxy.url = value; break
            case FIELD_KEYS.proxyPort: acc.proxy.port = Number.isFinite(parseInt(value, 10)) ? parseInt(value, 10) : 0; break
            case FIELD_KEYS.proxyUsername: acc.proxy.username = value; break
            case FIELD_KEYS.proxyPassword: acc.proxy.password = value; break
            case FIELD_KEYS.saveFingerprintMobile: acc.saveFingerprint.mobile = parseBool(value); break
            case FIELD_KEYS.saveFingerprintDesktop: acc.saveFingerprint.desktop = parseBool(value); break
            default: otherLines.push(rawLine) // 未知 ACCOUNT 键原样保留，不静默丢弃
        }
    }
    // 缺 email 的索引段（残缺/手编残留）不作为有效账号返回，其已消费的行也不回填
    const list = [...accounts.values()]
        .filter(a => a.email)
        .sort((a, b) => Number(a.index) - Number(b.index))
    return { accounts: list, otherLines }
}

/** 读取磁盘 .env → { accounts, otherLines }；文件不存在返回空集 */
function readEnvFile() {
    const file = envFilePath()
    try {
        if (!fs.existsSync(file)) return { accounts: [], otherLines: [] }
        return parseEnvAccounts(fs.readFileSync(file, 'utf-8'))
    } catch {
        return { accounts: [], otherLines: [] }
    }
}

/** 内部条目 → v3 API 契约形状（含 _index 供路由定位） */
function toContractAccount(entry) {
    const { index, email, password, totpSecret, recoveryEmail, geoLocale, langCode, proxy, saveFingerprint } = entry
    return { email, password, totpSecret, recoveryEmail, geoLocale, langCode, proxy, saveFingerprint, _index: index }
}

/** 契约账号数组 → .env 行（index 从 1 连续编号） */
function serializeAccounts(accounts) {
    const lines = []
    accounts.forEach((acc, i) => {
        const n = i + 1
        const p = acc.proxy || {}
        const sf = acc.saveFingerprint || {}
        const kv = [
            [FIELD_KEYS.email, acc.email ?? ''],
            [FIELD_KEYS.password, acc.password ?? ''],
            [FIELD_KEYS.totpSecret, acc.totpSecret ?? ''],
            [FIELD_KEYS.recoveryEmail, acc.recoveryEmail ?? ''],
            [FIELD_KEYS.geoLocale, acc.geoLocale ?? 'auto'],
            [FIELD_KEYS.langCode, acc.langCode ?? 'zh'],
            [FIELD_KEYS.proxyHttp, Boolean(p.proxyHttp)],
            [FIELD_KEYS.proxyUrl, p.url ?? ''],
            [FIELD_KEYS.proxyPort, Number.isInteger(p.port) ? p.port : 0],
            [FIELD_KEYS.proxyUsername, p.username ?? ''],
            [FIELD_KEYS.proxyPassword, p.password ?? ''],
            [FIELD_KEYS.saveFingerprintMobile, sf.mobile !== false],
            [FIELD_KEYS.saveFingerprintDesktop, sf.desktop !== false]
        ]
        lines.push(`# ===== 账号 ${n}（由 GUI 账号管理维护；字段含义见 env.example） =====`)
        for (const [key, value] of kv) lines.push(`ACCOUNT_${n}_${key}=${serializeValue(value)}`)
    })
    return lines.join('\n')
}

/**
 * 写回 .env：保留非账号行（其他配置），账号段整体重建。写入前保证结尾换行。
 * 文件不存在则创建（v4 的 .env 可从零开始，不再依赖 accounts.json）。
 */
function writeEnvAccounts(accounts, otherLines = []) {
    const file = envFilePath()
    const kept = otherLines.filter(l => l.trim() !== '')
    const parts = []
    if (kept.length) parts.push(kept.join('\n').replace(/\n+$/, ''))
    const body = serializeAccounts(accounts)
    if (body) parts.push(body)
    const content = parts.length ? parts.join('\n\n') + '\n' : ''
    fs.writeFileSync(file, content, 'utf-8')
    return file
}

/**
 * v3 accounts.json 文本 → 契约账号数组（旧数据包迁移用；兼容 proxyAxios → proxyHttp）
 * 非数组/缺 email 的条目跳过。
 */
function accountsJsonToContract(jsonText) {
    let arr
    try { arr = JSON.parse(jsonText) } catch { return [] }
    if (!Array.isArray(arr)) return []
    return arr
        .filter(a => a && typeof a.email === 'string' && a.email.includes('@'))
        .map(a => {
            const proxy = a.proxy && typeof a.proxy === 'object' ? a.proxy : {}
            return {
                email: a.email,
                password: typeof a.password === 'string' ? a.password : '',
                totpSecret: typeof a.totpSecret === 'string' ? a.totpSecret : '',
                recoveryEmail: typeof a.recoveryEmail === 'string' ? a.recoveryEmail : '',
                geoLocale: typeof a.geoLocale === 'string' ? a.geoLocale : 'auto',
                langCode: typeof a.langCode === 'string' ? a.langCode : 'zh',
                proxy: {
                    proxyHttp: typeof proxy.proxyHttp === 'boolean' ? proxy.proxyHttp : proxy.proxyAxios === true,
                    url: typeof proxy.url === 'string' ? proxy.url : '',
                    port: Number.isInteger(proxy.port) ? proxy.port : 0,
                    username: typeof proxy.username === 'string' ? proxy.username : '',
                    password: typeof proxy.password === 'string' ? proxy.password : ''
                },
                saveFingerprint: {
                    mobile: a.saveFingerprint?.mobile !== false,
                    desktop: a.saveFingerprint?.desktop !== false
                }
            }
        })
}

module.exports = {
    envFilePath, parseEnvAccounts, readEnvFile, toContractAccount,
    serializeAccounts, writeEnvAccounts, accountsJsonToContract, emptyAccount
}
