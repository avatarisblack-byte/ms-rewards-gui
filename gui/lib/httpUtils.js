/**
 * GUI HTTP 工具模块（sendJson / sendText / readBody）
 * 零依赖
 */

function sendJson(res, statusCode, data) {
    // 序列化容错（2026-08-20）：JSON.stringify 抛错（循环引用、BigInt 等）时 res 永不 end，
    // 客户端会一直挂起，异常还会冒泡到 server 分发层
    let payload
    try {
        payload = JSON.stringify(data, null, 2)
    } catch (e) {
        statusCode = 500
        payload = JSON.stringify({ error: `响应序列化失败: ${e.message}` })
    }
    // CORS 加固（2026-08-21）：不再返回 Access-Control-Allow-Origin: *。
    // 原配置下任意网页都可跨域读取本机接口（含账号凭据）并伪造请求；
    // 移除后浏览器仅允许同源访问，跨站页面连响应体都读不到。
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8'
    })
    res.end(payload)
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(statusCode, { 'Content-Type': contentType })
    res.end(text)
}

/**
 * 读取请求体（JSON），100MB 上限（session/日志/数据导入共用）。
 * 结束条件收敛（2026-08-20）：原实现只监听 data/end/error，客户端中途断网（aborted/close 无 end）
 * 时 Promise 永不 settle，已接收的请求体内存无法释放；现补 aborted/close 与整体超时，
 * 并用 settled 标志保证只结算一次（正常 end 之后也会触发 close）。
 */
const BODY_LIMIT_BYTES = 100e6
const BODY_TIMEOUT_MS = 30000

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = ''
        let settled = false
        const settle = (fn, arg) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            fn(arg)
        }
        const timer = setTimeout(() => {
            settle(reject, new Error('读取请求体超时'))
            req.destroy()
        }, BODY_TIMEOUT_MS)

        req.on('data', chunk => {
            body += chunk
            if (body.length > BODY_LIMIT_BYTES) {
                settle(reject, new Error('请求体过大'))
                req.destroy()
            }
        })
        req.on('end', () => {
            try {
                settle(resolve, body ? JSON.parse(body) : null)
            } catch {
                settle(reject, new Error('无效的 JSON 请求体'))
            }
        })
        req.on('error', err => settle(reject, err))
        req.on('aborted', () => settle(reject, new Error('客户端中断了请求')))
        req.on('close', () => settle(reject, new Error('连接在请求体接收完成前关闭')))
    })
}

module.exports = { sendJson, sendText, readBody }