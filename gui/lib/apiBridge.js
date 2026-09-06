/**
 * 上游 Control API 桥接模块（方案 C：进程管理交给上游 scripts/api/server.js）
 *
 * 职责：
 *   1. 惰性拉起/探测上游 Control API（127.0.0.1:API_PORT，默认 3010）
 *   2. 把 GUI 的任务接口转发为上游 /start /stop /status /logs
 *   3. GUI 退出时收尾自己拉起的上游 API 子进程
 *
 * 设计决策：
 *   - 仅进程管理走桥接；配置读写/账号/日志文件仍由 GUI 本地实现（上游 /logs 是内存
 *     环形缓冲重启即丢，GUI 收益统计依赖 logs/ 持久化文件；config 写转发会让测试
 *     体系伤筋动骨），GUI 与上游的耦合面收敛到一个子进程。
 *   - 惰性启动：首次任务相关请求才探测/拉起，server.js 的 require 阶段零副作用
 *     （测试沙箱整体加载 server.js，不能在 require 时 spawn 真实子进程）。
 *   - GUI_API_BRIDGE=off 时全部方法走降级分支（测试环境隔离真实子进程）。
 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

let apiProcess = null        // 本模块 spawn 的上游 API 子进程（外部启动的不接管）
let ensurePromise = null     // 并发 ensureApi 复用同一次探测/启动

function bridgeDisabled() {
    return process.env.GUI_API_BRIDGE === 'off'
}

function resolveApiPort() {
    const env = Number(process.env.GUI_API_PORT)
    if (Number.isInteger(env) && env >= 1024 && env <= 65535) return env
    try {
        const s = require('./config').readGuiSettings()
        if (s && Number.isInteger(s.apiPort) && s.apiPort >= 1024 && s.apiPort <= 65535) return s.apiPort
    } catch {}
    return 3010
}

function apiRequest(method, urlPath, body, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body)
        const req = http.request({
            host: '127.0.0.1',
            port: resolveApiPort(),
            path: urlPath,
            method,
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                : {},
            timeout: timeoutMs
        }, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => {
                let json = null
                try { json = data ? JSON.parse(data) : null } catch {}
                resolve({ status: res.statusCode, json })
            })
        })
        req.on('timeout', () => { req.destroy(new Error(`上游 API 请求超时: ${method} ${urlPath}`)) })
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

/** 探测上游 API /health（2xx 即存活） */
async function isApiAlive() {
    try {
        const res = await apiRequest('GET', '/health', undefined, 1500)
        return res.status >= 200 && res.status < 300
    } catch {
        return false
    }
}

/**
 * 确保上游 API 可用：存活则直接返回；未存活且非本模块拉起的则 spawn。
 * 返回 { ok: boolean, error?: string }
 */
async function ensureApi() {
    if (bridgeDisabled()) return { ok: false, error: 'API 桥接已禁用（GUI_API_BRIDGE=off）' }
    if (await isApiAlive()) return { ok: true }

    if (!apiProcess) {
        const { ROOT } = require('./config')
        const entry = path.join(ROOT, 'scripts', 'api', 'server.js')
        try {
            apiProcess = spawn(process.execPath, [entry], {
                cwd: ROOT,
                env: { ...process.env, API_HOST: '127.0.0.1', API_PORT: String(resolveApiPort()) },
                stdio: 'ignore',
                windowsHide: true
            })
            apiProcess.on('exit', () => { apiProcess = null })
            apiProcess.on('error', () => { apiProcess = null })
        } catch (e) {
            apiProcess = null
            return { ok: false, error: `无法启动控制 API 子进程: ${e.message}` }
        }
    }
    // 等待就绪（上游 API 启动通常 < 1s，超时 6s）
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
        if (await isApiAlive()) return { ok: true }
        await new Promise(r => setTimeout(r, 200))
    }
    return { ok: false, error: `控制 API 未在预期时间内就绪（127.0.0.1:${resolveApiPort()}），请检查 dist 是否已构建` }
}

/** POST /start（透传 accountIndex/excludedAccountIndexes 选号参数） */
async function startTask(body = {}) {
    const ensured = await ensureApi()
    if (!ensured.ok) return { success: false, error: ensured.error }
    try {
        const res = await apiRequest('POST', '/start', body)
        if (res.status === 202) return { success: true, message: '任务已启动' }
        return { success: false, error: (res.json && res.json.error) || `上游 API 返回 ${res.status}` }
    } catch (e) {
        return { success: false, error: `控制 API 通信失败: ${e.message}` }
    }
}

/** POST /stop */
async function stopTask() {
    const ensured = await ensureApi()
    if (!ensured.ok) return { success: false, error: ensured.error }
    try {
        const res = await apiRequest('POST', '/stop', {})
        if (res.status >= 200 && res.status < 300) return { success: true, message: '停止信号已发送' }
        return { success: false, error: (res.json && res.json.error) || `上游 API 返回 ${res.status}` }
    } catch (e) {
        return { success: false, error: `控制 API 通信失败: ${e.message}` }
    }
}

/**
 * GET /status + /logs → v3 GUI 契约 {running, pid, startedAt, log:[{time,line}]}
 * 上游不可用时降级为空状态 + 一条诊断日志，不抛异常（前端轮询依赖稳定的 200）。
 */
async function getTaskStatus() {
    if (bridgeDisabled()) {
        return { running: false, pid: null, startedAt: null, log: [] }
    }
    const ensured = await ensureApi()
    if (!ensured.ok) {
        return {
            running: false, pid: null, startedAt: null,
            log: [{ time: new Date().toISOString(), line: `[GUI] 控制API未运行: ${ensured.error}` }]
        }
    }
    try {
        const [status, logs] = await Promise.all([
            apiRequest('GET', '/status'),
            apiRequest('GET', '/logs?limit=100')
        ])
        if (status.status !== 200 || logs.status !== 200) {
            throw new Error(`上游 API 返回 status=${status.status} logs=${logs.status}`)
        }
        const s = status.json || {}
        const entries = (logs.json && logs.json.logs) || []
        return {
            running: s.state !== undefined ? s.state !== 'idle' : Boolean(s.running),
            pid: s.pid ?? null,
            startedAt: s.startedAt ?? null,
            log: entries.map(e => ({
                time: e.receivedAt || e.ts || new Date(0).toISOString(),
                line: e.raw ?? e.message ?? ''
            }))
        }
    } catch (e) {
        return {
            running: false, pid: null, startedAt: null,
            log: [{ time: new Date().toISOString(), line: `[GUI] 控制 API 通信失败: ${e.message}` }]
        }
    }
}

/** GUI 退出时收尾自己拉起的上游 API 子进程（外部启动的不接管） */
function shutdownBridge() {
    if (apiProcess) {
        try { apiProcess.kill() } catch {}
        apiProcess = null
    }
}

module.exports = { startTask, stopTask, getTaskStatus, ensureApi, shutdownBridge }
