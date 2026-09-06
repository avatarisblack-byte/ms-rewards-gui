/**
 * Session 文件收集/恢复模块（2026-09-06 新增，gui-v4-api）
 *
 * v3 会话：<根>/dist/browser/sessions/<email>/session_*.json（按账号分目录）
 * v4 会话：<根>/sessions/sessions.db（node:sqlite 单库，含 -wal/-shm 伴生文件；
 *          SessionStore.ts 以 cwd+config.sessionPath 解析，上游 API 亦按同序候选）
 *
 * 供 routes/sessions.js（导入/导出）与 routes/data.js（一键导入/导出）共用，
 * 双格式兼容：优先收集 v4 的 sessions.db 文件集，无库文件时回退扫描 v3 的 json 结构。
 */
const fs = require('fs')
const path = require('path')
const { ROOT } = require('./config')

// v4 sessions.db 及其 WAL 伴生文件（journal_mode=WAL）
const DB_FILES = ['sessions.db', 'sessions.db-wal', 'sessions.db-shm']

// session 目录候选（与上游 sessionStore.js 的解析顺序保持近似：cwd≈根目录）
function sessionDirCandidates() {
    return [
        path.join(ROOT, 'sessions'),
        path.join(ROOT, 'dist', 'sessions'),
        path.join(ROOT, 'dist', 'browser', 'sessions')
    ]
}

/** 返回实际存在的 session 目录；都不存在时返回第一候选（v4 默认 sessions/） */
function getSessionDir() {
    for (const dir of sessionDirCandidates()) {
        if (fs.existsSync(dir)) return dir
    }
    return sessionDirCandidates()[0]
}

/**
 * 列出全部会话文件（相对 session 根目录的 rel + 绝对路径 abs）。
 * 返回 [{ rel, abs }]；v4：sessions.db / sessions.db-wal / sessions.db-shm；
 * v3 回退：<email>/session_*.json。
 */
function listSessionFiles() {
    const dir = getSessionDir()
    const result = []
    if (!fs.existsSync(dir)) return result
    // v4：单库文件集
    for (const name of DB_FILES) {
        const abs = path.join(dir, name)
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) result.push({ rel: name, abs })
    }
    if (result.length) return result
    // v3 回退：按账号子目录扫描 session_*.json
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const emailDir = path.join(dir, entry.name)
            for (const f of fs.readdirSync(emailDir)) {
                if (/^session_.*\.json$/.test(f)) {
                    result.push({ rel: path.join(entry.name, f), abs: path.join(emailDir, f) })
                }
            }
        }
    } catch { /* 目录不可读按空处理 */ }
    return result
}

/**
 * rel → 落盘目标绝对路径（含防穿越校验），fileExists 供调用方做备份判断。
 * 非法（穿越/越界）返回 null。
 */
function resolveSessionTarget(rel) {
    if (typeof rel !== 'string' || !rel) return null
    const dir = getSessionDir()
    const target = path.join(dir, rel)
    if (path.relative(dir, target).startsWith('..') || path.isAbsolute(rel)) return null
    return target
}

module.exports = { DB_FILES, getSessionDir, listSessionFiles, resolveSessionTarget }
