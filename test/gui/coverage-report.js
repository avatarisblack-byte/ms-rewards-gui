/**
 * 覆盖率聚合脚本（基于 NODE_V8_COVERAGE 原始数据）
 *
 * 背景：被测代码运行在 os.tmpdir() 沙箱副本中，Node 内置的
 *      --experimental-test-coverage 默认只统计 cwd 下的文件，因此统计为空。
 *      本脚本直接解析 V8 原始覆盖数据，把沙箱路径映射回仓库内的 gui/ 源文件，
 *      并对多个沙箱（unit/api/resilience）的覆盖结果取并集。
 *
 * 用法：
 *   $env:NODE_V8_COVERAGE="$env:TEMP\gui-cov"
 *   node --test --test-isolation=none test/gui/*.test.js
 *   node test/gui/coverage-report.js "$env:TEMP\gui-cov"
 *
 * 口径说明：行覆盖为近似值——跳过空行、纯注释行与仅含括号的行，
 *          取每行首个非空白字符所在的最内层 V8 range 判定是否执行过。
 */
const fs = require('node:fs')
const path = require('node:path')

const covDir = process.argv[2]
if (!covDir || !fs.existsSync(covDir)) {
    console.error('用法: node test/gui/coverage-report.js <NODE_V8_COVERAGE 目录>')
    process.exit(1)
}

const GUI_DIR = path.join(__dirname, '..', '..', 'gui')
const stats = new Map() // rel → { coveredLines:Set, countableLines:Set, funcs:Map(name→covered) }

function isCountable(line) {
    const t = line.trim()
    if (!t) return false
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) return false
    if (/^[)}\];,]+$/.test(t)) return false
    return true
}

function lineOffsets(src) {
    const offsets = []
    let pos = 0
    for (const line of src.split('\n')) {
        offsets.push({ line, start: pos })
        pos += line.length + 1
    }
    return offsets
}

for (const file of fs.readdirSync(covDir).filter(f => f.endsWith('.json'))) {
    let data
    try { data = JSON.parse(fs.readFileSync(path.join(covDir, file), 'utf-8')) } catch { continue }
    for (const script of data.result || []) {
        if (!script.url || !script.url.startsWith('file://')) continue
        const norm = decodeURIComponent(new URL(script.url).pathname).replace(/^\//, '')
        const idx = norm.lastIndexOf('/gui/')
        if (idx === -1) continue
        const rel = norm.slice(idx + 5)
        if (!rel.endsWith('.js') || rel.startsWith('js/')) continue // 前端脚本不在 Node 中加载

        const srcPath = path.join(GUI_DIR, rel)
        if (!fs.existsSync(srcPath)) continue
        const src = fs.readFileSync(srcPath, 'utf-8')

        if (!stats.has(rel)) stats.set(rel, { coveredLines: new Set(), countableLines: new Set(), funcs: new Map() })
        const entry = stats.get(rel)

        const ranges = []
        for (const fn of script.functions || []) {
            for (const r of fn.ranges || []) ranges.push(r)
            const name = fn.functionName
            if (name) {
                const covered = (fn.ranges[0] && fn.ranges[0].count > 0) || entry.funcs.get(name) === true
                entry.funcs.set(name, Boolean(covered))
            }
        }

        lineOffsets(src).forEach(({ line, start }, i) => {
            if (!isCountable(line)) return
            entry.countableLines.add(i + 1)
            const firstCharOffset = start + (line.length - line.trimStart().length)
            let best = null
            for (const r of ranges) {
                if (firstCharOffset >= r.startOffset && firstCharOffset < r.endOffset) {
                    if (!best || (r.endOffset - r.startOffset) < (best.endOffset - best.startOffset)) best = r
                }
            }
            if (best && best.count > 0) entry.coveredLines.add(i + 1)
        })
    }
}

const rows = [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]))
let totalLines = 0
let totalCovered = 0
let totalFuncs = 0
let totalFuncsCovered = 0

console.log('| 文件 | 可执行行 | 已覆盖行 | 行覆盖率 | 函数覆盖率 |')
console.log('| --- | --- | --- | --- | --- |')
for (const [rel, e] of rows) {
    const lines = e.countableLines.size
    const covered = [...e.coveredLines].length
    const funcs = e.funcs.size
    const funcsCovered = [...e.funcs.values()].filter(Boolean).length
    totalLines += lines
    totalCovered += covered
    totalFuncs += funcs
    totalFuncsCovered += funcsCovered
    const pct = lines ? ((covered / lines) * 100).toFixed(1) : '0.0'
    const fpct = funcs ? ((funcsCovered / funcs) * 100).toFixed(1) : '-'
    console.log(`| gui/${rel} | ${lines} | ${covered} | ${pct}% | ${fpct}% (${funcsCovered}/${funcs}) |`)
}
const totalPct = totalLines ? ((totalCovered / totalLines) * 100).toFixed(1) : '0.0'
const totalFPct = totalFuncs ? ((totalFuncsCovered / totalFuncs) * 100).toFixed(1) : '-'
console.log(`| **合计** | **${totalLines}** | **${totalCovered}** | **${totalPct}%** | **${totalFPct}% (${totalFuncsCovered}/${totalFuncs})** |`)
