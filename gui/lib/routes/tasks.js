/**
 * 任务路由（POST /api/start、POST /api/stop、GET /api/task）
 * 方案 C：进程管理转发上游 Control API（见 lib/apiBridge.js）
 * 签名：(req, res, pathname, ctx) => boolean
 */

function handleTasks(req, res, pathname, ctx) {
    const { http, apiBridge } = ctx

    // 方法校验（2026-08-20）：原先只判断 pathname，GET 即可拉起/停止脚本子进程，
    // 浏览器预取、<img>/<iframe>、爬虫与跨站页面（CORS 为 *）都能造成误触发
    // POST /api/start
    if (pathname === '/api/start') {
        if (req.method !== 'POST') {
            http.sendJson(res, 405, { error: '仅支持 POST /api/start' })
            return true
        }
        return (async () => {
            try {
                await http.readBody(req) // 选号参数暂不透传（GUI 尚无对应 UI），仅消费请求体
                const result = await apiBridge.startTask()
                http.sendJson(res, result.success ? 200 : 400, result)
            } catch (error) {
                http.sendJson(res, 500, { error: error.message || '启动失败' })
            }
        })()
    }

    // POST /api/stop
    if (pathname === '/api/stop') {
        if (req.method !== 'POST') {
            http.sendJson(res, 405, { error: '仅支持 POST /api/stop' })
            return true
        }
        return (async () => {
            try {
                const result = await apiBridge.stopTask()
                http.sendJson(res, result.success ? 200 : 400, result)
            } catch (error) {
                http.sendJson(res, 500, { error: error.message || '停止失败' })
            }
        })()
    }

    // GET /api/task
    if (pathname === '/api/task') {
        if (req.method !== 'GET') {
            http.sendJson(res, 405, { error: '仅支持 GET /api/task' })
            return true
        }
        return (async () => {
            try {
                http.sendJson(res, 200, await apiBridge.getTaskStatus())
            } catch (error) {
                http.sendJson(res, 500, { error: error.message || '状态获取失败' })
            }
        })()
    }

    return false
}

module.exports = handleTasks
