/**
 * GUI 配置与路径解析模块
 * 零依赖：仅 Node 内置 path / fs
 */
const path = require('path')
const fs = require('fs')

const GUI_DIR = path.join(__dirname, '..')
const ROOT = path.join(GUI_DIR, '..')
const HTML_FILE = path.join(GUI_DIR, 'design-reference.html')
const LOGS_DIR = path.join(ROOT, 'logs')
const GUI_SETTINGS_FILE = path.join(GUI_DIR, 'gui-settings.json')

// 端口解析优先级：环境变量 PORT（start-gui.bat 从 gui-settings.json 注入，或手动覆盖）> gui-settings.json > 3000
function resolvePort() {
    const envPort = Number(process.env.PORT)
    if (Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535) return envPort
    const s = readJson(GUI_SETTINGS_FILE)
    if (s && Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535) return s.port
    return 3000
}

const PORT = resolvePort()

// GUI 专属配置读写（端口等）：gui/gui-settings.json，与脚本核心 config.json 隔离
function readGuiSettings() {
    return readJson(GUI_SETTINGS_FILE) || {}
}

// 合并写入（2026-08-20）：调用方只传变更项（如 { port }），原实现整体覆盖文件会静默清除
// gui-settings.json 中的其他设置
function writeGuiSettings(settings) {
    const merged = { ...readGuiSettings(), ...settings }
    // 备份 .bak（文件不存在时忽略）
    try { fs.copyFileSync(GUI_SETTINGS_FILE, GUI_SETTINGS_FILE + '.bak') } catch {}
    fs.writeFileSync(GUI_SETTINGS_FILE, JSON.stringify(merged, null, 4) + '\n', 'utf-8')
    return GUI_SETTINGS_FILE
}

function resolveAccountsPath() {
    const candidates = [
        path.join(ROOT, 'accounts.json'),
        path.join(ROOT, 'dist', 'accounts.json'),
        path.join(ROOT, 'src', 'accounts.example.json')
    ]
    for (const p of candidates) {
        if (fs.existsSync(p)) return p
    }
    return candidates[0]
}

function resolveConfigPath() {
    const candidates = [
        path.join(ROOT, 'config.json'),
        path.join(ROOT, 'dist', 'config.json'),
        path.join(ROOT, 'src', 'config.example.json')
    ]
    for (const p of candidates) {
        if (fs.existsSync(p)) return p
    }
    return candidates[0]
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
        return null
    }
}

module.exports = {
    PORT, ROOT, GUI_DIR, HTML_FILE, LOGS_DIR, GUI_SETTINGS_FILE,
    resolveAccountsPath, resolveConfigPath, readJson, readGuiSettings, writeGuiSettings
}