/**
 * 任务路由（POST /api/start、POST /api/stop、GET /api/task）
 * 签名：(req, res, pathname, ctx) => boolean
 */

function handleTasks(req, res, pathname, ctx) {
    const { http, taskManager } = ctx

    // 方法校验（2026-08-20）：原先只判断 pathname，GET 即可拉起/停止脚本子进程，
    // 浏览器预取、<img>/<iframe>、爬虫与跨站页面（CORS 为 *）都能造成误触发
    // POST /api/start
    if (pathname === '/api/start') {
        if (req.method !== 'POST') {
            http.sendJson(res, 405, { error: '仅支持 POST /api/start' })
            return true
        }
        const result = taskManager.startTask()
        http.sendJson(res, result.success ? 200 : 400, result)
        return true
    }

    // POST /api/stop
    if (pathname === '/api/stop') {
        if (req.method !== 'POST') {
            http.sendJson(res, 405, { error: '仅支持 POST /api/stop' })
            return true
        }
        const result = taskManager.stopTask()
        http.sendJson(res, result.success ? 200 : 400, result)
        return true
    }

    // GET /api/task
    if (pathname === '/api/task') {
        if (req.method !== 'GET') {
            http.sendJson(res, 405, { error: '仅支持 GET /api/task' })
            return true
        }
        http.sendJson(res, 200, taskManager.getTaskStatus())
        return true
    }

    return false
}

module.exports = handleTasks