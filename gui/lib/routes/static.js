/**
 * 静态资源路由（/、/index.html、/css/*、/js/*）
 * 签名：(req, res, pathname, ctx) => boolean  true=已处理
 */
const fs = require('fs')
const path = require('path')

function handleStatic(req, res, pathname, ctx) {
    const { GUI_DIR, HTML_FILE } = ctx.config

    // 静态页面
    if (pathname === '/' || pathname === '/index.html') {
        if (!fs.existsSync(HTML_FILE)) {
            ctx.http.sendText(res, 404, 'GUI 文件不存在: gui/design-reference.html')
            return true
        }
        ctx.http.sendText(res, 200, fs.readFileSync(HTML_FILE, 'utf-8'), 'text/html; charset=utf-8')
        return true
    }

    // 静态资源：/css/* 与 /js/*（映射到 gui 目录，带路径穿越防护）
    const staticMatch = pathname.match(/^\/(css|js)\/([^/]+)$/)
    if (staticMatch && req.method === 'GET') {
        const subDir = staticMatch[1]
        const fileName = staticMatch[2]
        if (fileName.includes('..') || fileName.includes('\\') || fileName.includes('/')) {
            ctx.http.sendJson(res, 400, { error: '非法文件路径' })
            return true
        }
        const filePath = path.join(GUI_DIR, subDir, fileName)
        try {
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                ctx.http.sendJson(res, 404, { error: `静态文件不存在: /${subDir}/${fileName}` })
                return true
            }
            const mime = fileName.endsWith('.css')
                ? 'text/css; charset=utf-8'
                : 'application/javascript; charset=utf-8'
            ctx.http.sendText(res, 200, fs.readFileSync(filePath, 'utf-8'), mime)
            return true
        } catch (e) {
            ctx.http.sendJson(res, 500, { error: `读取静态文件失败: ${e.message}` })
            return true
        }
    }

    return false
}

module.exports = handleStatic