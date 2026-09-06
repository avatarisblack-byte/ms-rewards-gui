// ===== 图表动画工具（Chart.js v4） =====
// 职责：
//  1. 提供图表动画配置：首次渲染时柱子从坐标轴 0 竖直升起到最新值（禁 x 横向动画，避免"左上角斜飞"）
//  2. 提供平滑更新封装：数据刷新时从上次显示值过渡到最新值（不归零重飞）
// 供 js/app.js 的 renderStats() 引用。
//
// 时长收敛说明（emil-design-eng / review-animations）：
//  - UI 动画预算 <300ms，图表属偶尔查看的数据展示，取 400ms 上限；
//    原 600ms 首次生长偏拖，且 Chart.js update() 默认 1000ms 更慢（30s 轮询刷新时明显迟钝）。
//  - prefers-reduced-motion 下动画时长为 0（数据仍即时更新），保留 opacity/颜色反馈、去掉位移生长。

// 尊重系统"减少动态"偏好
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 首次创建 Chart 实例时的动画选项：
// - animations.x.from → x 方向锚定到柱子最终位置（即便 x 动画执行，柱子也不会横移）
// - animations.y.from → 从 y 轴 0 值对应的像素位置竖直升起（而非斜向飞入）
// - animations.y.duration + easeOutQuart → 竖方向平滑生长到最新值
const chartAnimOptions = {
    animations: {
        // 双保险：x 方向 from 起点 = 柱子最终 x 坐标，几何上不可能发生横向飞行
        x: {
            from: (ctx) => {
                if (ctx.type === 'data' && ctx.chart.scales.x) {
                    return ctx.chart.scales.x.getPixelForValue(ctx.index)
                }
                return undefined
            }
        },
        y: {
            duration: prefersReducedMotion ? 0 : 400,
            easing: 'easeOutQuart',
            from: (ctx) => {
                // 仅数据点生效：让柱子从坐标轴 0 竖直生长到最新值
                if (ctx.type === 'data' && ctx.chart.scales.y) {
                    return ctx.chart.scales.y.getPixelForValue(0)
                }
                return undefined
            }
        }
    }
}

// 平滑更新已有图表：把 labels/datasets 赋给当前实例后 update()，
// Chart.js 会保留旧柱子的当前显示高度，向新值做过渡动画（而非销毁重建归零）。
function smoothUpdateChart(chart, labels, datasets) {
    if (!chart) return
    // 更新前移除 from 起点回调 → Chart.js 从「当前显示值」过渡到新值，不归零重飞
    if (chart.options && chart.options.animations && chart.options.animations.y) {
        delete chart.options.animations.y.from
    }
    chart.data.labels = labels
    chart.data.datasets = datasets
    // 显式指定更新动画时长：Chart.js 默认 1000ms 明显拖沓，收敛到 400ms（reduced-motion 下 0ms）
    chart.update({ duration: prefersReducedMotion ? 0 : 400 })
}

// 全局暴露（app.js 是普通 <script>，非模块，用 window 挂载）
window.chartAnimOptions = chartAnimOptions
window.smoothUpdateChart = smoothUpdateChart
