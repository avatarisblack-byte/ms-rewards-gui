/**
 * GUI 账号结构校验模块
 * 与 src/util/Validator.ts 的 AccountSchema 字段规则保持一致
 * 零依赖
 */

function validateAccountShape(acc) {
    if (!acc || typeof acc !== 'object' || Array.isArray(acc)) {
        return '账号必须是一个对象'
    }

    const errors = []

    // email 边界校验（2026-08-20）：原先只检查类型与是否含 @，超长、含控制字符或 HTML 片段的
    // 邮箱都能落盘 accounts.json，进而被脚本读取、写进日志行（破坏日志解析）并回显到前端
    if (typeof acc.email !== 'string' || !acc.email.includes('@')) {
        errors.push('email 必须是非空邮箱字符串')
    } else if (acc.email.length > 254) {
        errors.push('email 长度不能超过 254 个字符 (RFC 5321)')
    } else if (/[\s\u0000-\u001F\u007F]/.test(acc.email)) {
        errors.push('email 不能包含空白或控制字符')
    } else if (/[<>"'`&]/.test(acc.email)) {
        errors.push('email 不能包含 < > " \' ` & 等特殊字符')
    }
    if (typeof acc.password !== 'string') {
        errors.push('password 必须是字符串')
    }
    if (acc.totpSecret !== undefined && typeof acc.totpSecret !== 'string') {
        errors.push('totpSecret 必须是字符串')
    }
    if (acc.recoveryEmail !== undefined && typeof acc.recoveryEmail !== 'string') {
        errors.push('recoveryEmail 必须是字符串')
    }
    if (typeof acc.geoLocale !== 'string') {
        errors.push('geoLocale 必须是字符串 (如 "auto" / "us" / "cn")')
    }
    if (typeof acc.langCode !== 'string') {
        errors.push('langCode 必须是字符串 (如 "zh" / "en")')
    }

    // proxy 对象校验
    const p = acc.proxy
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push('proxy 必须是一个对象')
    } else {
        if (typeof p.proxyAxios !== 'boolean') errors.push('proxy.proxyAxios 必须是布尔值')
        if (typeof p.url !== 'string') errors.push('proxy.url 必须是字符串')
        if (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 0 || p.port > 65535) errors.push('proxy.port 必须是 0-65535 之间的整数')
        if (typeof p.username !== 'string') errors.push('proxy.username 必须是字符串')
        if (typeof p.password !== 'string') errors.push('proxy.password 必须是字符串')
    }

    // saveFingerprint 对象校验
    const sf = acc.saveFingerprint
    if (!sf || typeof sf !== 'object' || Array.isArray(sf)) {
        errors.push('saveFingerprint 必须是一个对象')
    } else {
        if (typeof sf.mobile !== 'boolean') errors.push('saveFingerprint.mobile 必须是布尔值')
        if (typeof sf.desktop !== 'boolean') errors.push('saveFingerprint.desktop 必须是布尔值')
    }

    return errors.length > 0 ? errors.join('；') : null
}

module.exports = { validateAccountShape }