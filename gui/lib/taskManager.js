/**
 * GUI 任务子进程管理模块
 * 依赖：lib/config.js（ROOT）+ child_process
 * 方案 A: spawn('node', [dist/index.js])，cwd=项目根目录
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { ROOT } = require('./config')

let taskProcess = null
let starting = false            // 启动中标志：覆盖 spawn 同步期间的互斥
let lastStartAt = 0             // 上次启动时刻：节流短时间内的重复启动
const START_THROTTLE_MS = 3000  // 3s 内不允许重复启动（防重复点击 / 并发请求同时拉起多个进程）
const taskLogBuffer = []
const MAX_TASK_LOG_LINES = 500
const RUN_SCRIPT = process.platform === 'win32' ? 'node.exe' : 'node'

// 进程是否真正存活（2026-08-20）：
// killed 仅表示"信号已发出"，SIGTERM 后进程最多可能再存活 10s（见 stopTask 的 SIGKILL 兜底），
// 用 killed 判定会把仍在运行的任务误报为未运行，并允许在旧进程还活着时再启动一个
function isRunning() {
    return Boolean(taskProcess) && taskProcess.exitCode === null && taskProcess.signalCode === null
}

function appendTaskLog(line) {
    if (!line) return
    taskLogBuffer.push({ time: new Date().toISOString(), line })
    if (taskLogBuffer.length > MAX_TASK_LOG_LINES) {
        taskLogBuffer.splice(0, taskLogBuffer.length - MAX_TASK_LOG_LINES)
    }
}

// 子进程入口：优先 dist/index.js，否则 ts-node 跑 src/index.ts（开发模式）
function resolveEntryFile() {
    const distEntry = path.join(ROOT, 'dist', 'index.js')
    if (fs.existsSync(distEntry)) return distEntry
    const tsNodeBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node')
    if (fs.existsSync(tsNodeBin)) {
        return null
    }
    return distEntry
}

function startTask() {
    // 并发互斥（2026-08-20）：原先只判断 taskProcess/killed，子进程若快速退出（exit 回调把
    // taskProcess 置 null），并发请求就能在极短时间内先后拉起多个脚本进程
    if (starting) {
        return { success: false, error: '任务正在启动中' }
    }
    if (isRunning()) {
        return { success: false, error: '任务已在运行中' }
    }
    if (Date.now() - lastStartAt < START_THROTTLE_MS) {
        return { success: false, error: '启动过于频繁，请稍候再试' }
    }
    starting = true

    const entryFile = resolveEntryFile()
    let args
    if (entryFile) {
        args = [entryFile]
    } else {
        const tsNodeBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node')
        args = [tsNodeBin, path.join(ROOT, 'src', 'index.ts')]
    }

    appendTaskLog(`[GUI] 启动任务: node ${args.join(' ')}`)
    console.log(`[GUI] 启动任务: node ${args.join(' ')}`)

    try {
        taskProcess = spawn(RUN_SCRIPT, args, {
            cwd: ROOT,
            env: { ...process.env },
            windowsHide: false,
            stdio: ['pipe', 'pipe', 'pipe']
        })
    } catch (error) {
        starting = false
        appendTaskLog(`[GUI] 启动失败: ${error.message}`)
        return { success: false, error: `启动失败: ${error.message}` }
    }

    taskProcess.stdout.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => appendTaskLog(line))
    })
    taskProcess.stderr.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => appendTaskLog(line))
    })
    taskProcess.on('exit', (code, signal) => {
        appendTaskLog(`[GUI] 任务进程退出 | code=${code ?? 'n/a'} signal=${signal ?? 'n/a'}`)
        console.log(`[GUI] 任务进程退出 | code=${code ?? 'n/a'} signal=${signal ?? 'n/a'}`)
        taskProcess = null
        // 任务结束 2s 后主动重建日志摘要缓存（延迟等待 stdout/stderr 落盘完成，
        // 之后 /api/accounts、/api/stats 直接命中新鲜缓存，无需惰性全量解析）
        setTimeout(() => {
            try {
                const { generateCache } = require('./logCache')
                generateCache()
                console.log('[GUI] 日志摘要缓存已重建')
            } catch (e) {
                console.warn(`[GUI] 日志摘要缓存重建失败: ${e.message}`)
            }
        }, 2000).unref()
    })
    taskProcess.on('error', error => {
        appendTaskLog(`[GUI] 任务进程错误: ${error.message}`)
        console.error(`[GUI] 任务进程错误:`, error)
        taskProcess = null
    })

    starting = false
    lastStartAt = Date.now()
    return { success: true, message: '任务已启动' }
}

function stopTask() {
    if (!isRunning()) {
        return { success: false, error: '没有正在运行的任务' }
    }

    appendTaskLog('[GUI] 发送停止信号 (SIGTERM)...')
    console.log('[GUI] 发送停止信号 (SIGTERM)...')

    try {
        taskProcess.kill('SIGTERM')

        // 10 秒后仍未退出则强制 SIGKILL
        setTimeout(() => {
            if (isRunning()) {
                appendTaskLog('[GUI] 10秒内未正常退出，强制 SIGKILL')
                console.warn('[GUI] 10秒内未正常退出，强制 SIGKILL')
                taskProcess.kill('SIGKILL')
            }
        }, 10000).unref()

        // 显式停止是用户明确意图：重置启动节流，允许立即重新启动
        lastStartAt = 0
        return { success: true, message: '停止信号已发送' }
    } catch (error) {
        return { success: false, error: `停止失败: ${error.message}` }
    }
}

function getTaskStatus() {
    return {
        running: isRunning(),
        pid: taskProcess ? taskProcess.pid : null,
        startedAt: null,
        log: taskLogBuffer.slice(-100)
    }
}

module.exports = { startTask, stopTask, getTaskStatus }