/**
 * GUI 压缩/解压公共模块（PowerShell / unzip / zip，保持零依赖）
 * 依赖：os / child_process
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

/**
 * 跨平台：解压 zip 到目标目录（win32 用 PowerShell Expand-Archive，其他用 unzip）。
 * 路径传递（2026-08-21）：不再把路径拼进 -Command 字符串（临时目录含单引号等特殊字符
 * 会中断命令，甚至构成命令注入面），改经环境变量传入，命令字符串为固定字面量。
 */
function unzipToDir(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        const cmd = process.platform === 'win32'
            ? {
                  file: 'powershell.exe',
                  args: ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:GUI_ARCHIVE_SRC -DestinationPath $env:GUI_ARCHIVE_DEST -Force'],
                  env: { ...process.env, GUI_ARCHIVE_SRC: zipPath, GUI_ARCHIVE_DEST: destDir }
              }
            : { file: 'unzip', args: ['-o', zipPath, '-d', destDir], env: process.env }
        const ps = spawn(cmd.file, cmd.args, { env: cmd.env })
        ps.on('error', () => reject(new Error('解压工具不可用 (需要 Windows PowerShell 或 unzip)')))
        ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`解压失败 (code ${code})`)))
    })
}

/** 跨平台：将目录内容打包为 zip（win32 用 PowerShell Compress-Archive，其他用 zip）；路径经环境变量传递（同上） */
function zipDir(stageDir, zipPath) {
    return new Promise((resolve, reject) => {
        const cmd = process.platform === 'win32'
            ? {
                  file: 'powershell.exe',
                  args: ['-NoProfile', '-Command', 'Compress-Archive -Path (Join-Path $env:GUI_ARCHIVE_SRC "*") -DestinationPath $env:GUI_ARCHIVE_DEST -Force'],
                  env: { ...process.env, GUI_ARCHIVE_SRC: stageDir, GUI_ARCHIVE_DEST: zipPath },
                  cwd: undefined
              }
            : { file: 'zip', args: ['-r', '-q', zipPath, '.'], env: process.env, cwd: stageDir }
        const ps = spawn(cmd.file, cmd.args, { env: cmd.env, cwd: cmd.cwd })
        ps.on('error', () => reject(new Error('压缩工具不可用 (需要 Windows PowerShell 或 zip)')))
        ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`压缩失败 (code ${code})`)))
    })
}

/**
 * 创建唯一的临时目录并返回其路径。
 * 唯一性（2026-08-20）：原先按 `${prefix}-${Date.now()}-${pid}` 拼接，同毫秒内的并发调用会拿到
 * 同一路径（实测 2000 次调用仅产生 11 个唯一值），并发导入/导出会互相覆盖 zip 并被对方 rmSync 删除。
 * mkdtempSync 由内核保证唯一，且目录已创建（调用方后续 mkdirSync recursive 仍兼容）。
 */
function makeTmpRoot(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

module.exports = { unzipToDir, zipDir, makeTmpRoot }