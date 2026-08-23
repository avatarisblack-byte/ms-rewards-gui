        // ===== 全局状态 =====
        let accountsCache = { accounts: [], logSummary: [] };
        let configCache = null;
        let statsCache = null; // /api/stats 缓存（今日收益/总收益/每日趋势），30s 轮询刷新
        let guiSettingsCache = { port: 3000 }; // /api/gui-settings 缓存（GUI 专属配置：端口等）
        let authToken = null; // 本地访问令牌：页面加载时从 /api/auth/token 获取，所有请求自动携带
        // 首次打开"环境安装"提示弹窗：localStorage 持久化"不再提示"状态（存在即不再弹出）
        const ENV_SETUP_DISMISS_KEY = 'gui-env-setup-dismissed';

        // ===== 工具函数 =====
        function emailUser(email) {
            return email ? email.split('@')[0] : 'unknown';
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // 页面加载时获取并缓存访问令牌（服务每次启动都会重新生成）
        async function fetchAuthToken() {
            const res = await fetch('/api/auth/token');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            authToken = data.token;
        }

        // 统一 API 请求封装：自动携带 X-Auth-Token；401 时提示并刷新页面
        async function apiFetch(url, options = {}) {
            const headers = { ...(options.headers || {}) };
            if (authToken) headers['X-Auth-Token'] = authToken;
            const res = await fetch(url, { ...options, headers });
            if (res.status === 401) {
                alert('本地访问令牌已失效（服务可能已重启），页面即将刷新');
                location.reload();
                throw new Error('HTTP 401 未授权');
            }
            return res;
        }

        // 15s 超时（2026-08-21）：断网或服务端无响应时 fetch 永不 settle，
        // 界面会停留在加载态且轮询持续堆积；超时后请求被主动 abort 并抛出错误
        async function fetchJson(url) {
            const res = await apiFetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
            return res.json();
        }

        // 根据邮箱前缀匹配日志摘要
        function findLogStatus(email) {
            const userName = emailUser(email);
            return (accountsCache.logSummary || []).find(s => s.account === userName) || null;
        }

        function formatDuration(seconds) {
            if (!seconds && seconds !== 0) return '--';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) return `${h}h ${m}m`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        }

        function formatTime(isoStr) {
            if (!isoStr) return '--';
            try {
                const d = new Date(isoStr);
                return d.toLocaleString('zh-CN', { hour12: false });
            } catch {
                return isoStr;
            }
        }

        // ===== 任务控制 =====
        let taskRunning = false;

        function setTaskUI(running) {
            taskRunning = Boolean(running);
            const startBtn = document.getElementById('task-start-btn');
            const stopBtn = document.getElementById('task-stop-btn');
            const dot = document.getElementById('task-status-dot');
            const ping = document.getElementById('task-status-ping');
            const text = document.getElementById('task-status-text');

            if (startBtn) startBtn.classList.toggle('hidden', running);
            if (stopBtn) stopBtn.classList.toggle('hidden', !running);
            if (text) text.innerText = running ? '脚本运行中' : '脚本空闲中';
            if (dot) {
                dot.className = `relative inline-flex rounded-full h-3 w-3 ${running ? 'bg-green-500' : 'bg-gray-400'}`;
            }
            if (ping) {
                // 仅运行中保留涟漪扩散动画（animate-ping）；空闲时完全静止：
                // 移除动画类并隐藏扩散圈（opacity-0），只留静止的纯灰色圆点
                ping.className = running
                    ? 'animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75'
                    : 'absolute inline-flex h-full w-full rounded-full bg-gray-400 opacity-0';
            }
        }

        async function taskStart() {
            try {
                const res = await apiFetch('/api/start', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    alert(`❌ 启动失败: ${data.error || '未知错误'}`);
                    return;
                }
                setTaskUI(true);
                pollTaskStatus(); // 立即拉取一次状态和日志
                alert(`✅ ${data.message || '任务已启动'}`);
            } catch (e) {
                alert(`❌ 启动失败: ${e.message}`);
            }
        }

        async function taskStop() {
            try {
                const res = await apiFetch('/api/stop', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    alert(`❌ 停止失败: ${data.error || '未知错误'}`);
                    return;
                }
                alert(`⏹ ${data.message || '停止信号已发送'}`);
                pollTaskStatus();
            } catch (e) {
                alert(`❌ 停止失败: ${e.message}`);
            }
        }

        // 更新 header 状态 + 页面上的任务日志区域
        function renderTaskLog(log) {
            const logBox = document.getElementById('task-log-box');
            if (!logBox) return;
            if (!log || !log.length) {
                logBox.innerHTML = '<p class="text-gray-400 text-xs">暂无任务日志。点击"启动任务"开始运行。</p>';
                return;
            }
            logBox.innerHTML = log.map(entry => {
                const ts = entry.time ? new Date(entry.time).toLocaleString('zh-CN', { hour12: false }) : '';
                // 里程碑行（ACCOUNT-END / RUN-END）使用主色加粗（2026-08-21）：
                // 让任务收尾节点在实时流中一眼可辨，便于确认每个账号（含最后一个）的完成标识
                const isMilestone = /ACCOUNT-END|RUN-END/.test(entry.line || '');
                return `<div class="text-[11px] leading-tight ${/ERROR|失败/i.test(entry.line) ? 'text-red-500' : /WARN/i.test(entry.line) ? 'text-yellow-600' : /DEBUG/i.test(entry.line) ? 'text-gray-400' : 'text-gray-600'}"><span class="text-gray-300 mr-2">${ts || ''}</span><span class="${isMilestone ? 'key-point font-semibold' : ''}">${escapeHtml(entry.line)}</span></div>`;
            }).join('');
            // 仅当用户接近底部时才自动滚动，避免打断向上翻阅历史日志
            const nearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
            if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
        }

        async function pollTaskStatus() {
            try {
                const res = await fetchJson('/api/task');
                setTaskUI(res.running);
                renderTaskLog(res.log || []);
                return true; // 供轮询调度器判断成功/失败（决定退避节奏）
            } catch (e) {
                console.error('任务状态拉取失败:', e);
                return false;
            }
        }

        // ===== 数据加载 =====
        async function loadData() {
            try {
                // 并行拉取账号、配置、统计与 GUI 专属设置（统计用于首页"今日收益/总收益"实时卡片）
                const results = await Promise.allSettled([
                    fetchJson('/api/accounts'),
                    fetchJson('/api/config'),
                    fetchJson('/api/stats'),
                    fetchJson('/api/gui-settings')
                ]);
                accountsCache = results[0].status === 'fulfilled' ? results[0].value : accountsCache;
                configCache = results[1].status === 'fulfilled' ? results[1].value : configCache;
                if (results[2].status === 'fulfilled') statsCache = results[2].value;
                if (results[3].status === 'fulfilled') guiSettingsCache = results[3].value;
                renderAll();
                // 至少一个接口成功即视为服务存活（供轮询调度器重置退避）
                return results.some(r => r.status === 'fulfilled');
            } catch (error) {
                console.error('加载数据失败:', error);
                document.getElementById('home-total-accounts-sub').innerText = '加载失败，请确认已运行 node gui/server.js';
                return false;
            }
        }

        // ===== 账户动态组件（状态 Tag / 事件徽章，仪表盘与账户管理共用） =====
        // 统一状态判定：运行中 / 已完成 / 异常 / 暂无记录
        function getAccountStatus(log) {
            if (!log) return { type: 'idle', label: '暂无记录' };
            if (log.lastEvent === 'ACCOUNT-START' && !log.collectedPoints) return { type: 'running', label: '运行中' };
            if (log.lastLevel === 'ERROR') return { type: 'error', label: '异常' };
            return { type: 'done', label: '已完成' };
        }

        // 解析 ACCOUNT-END 消息中的关键字段（总计/原始→新值/持续时间），
        // 供「最新动态」完整状态块渲染——所有账号（含最后一个）走同一渲染路径，
        // 只要日志中存在 ACCOUNT-END 行，就严格按与前序账号一致的格式呈现。
        function parseAccountEnd(log) {
            if (!log || log.lastEvent !== 'ACCOUNT-END' || !log.lastMessage) return null;
            const m = log.lastMessage;
            const total = (m.match(/总计:\s*\+(\d+)/) || [])[1];
            const initial = (m.match(/原始:\s*(\d+)\s*→/) || [])[1];
            const final = (m.match(/→\s*新值:\s*(\d+)/) || [])[1];
            const durSec = (m.match(/持续时间:\s*([\d.]+)\s*秒/) || [])[1];
            if (total == null && initial == null && final == null && durSec == null) return null;
            return {
                total: total != null ? parseInt(total, 10) : null,
                initial: initial != null ? parseInt(initial, 10) : null,
                final: final != null ? parseInt(final, 10) : null,
                durationSeconds: durSec != null ? parseFloat(durSec) : null
            };
        }

        // 状态 Tag：指示点/图标 + 彩色徽章（运行中绿点呼吸、已完成灰勾、异常红叉、空闲灰点）
        function statusTagHtml(status) {
            const map = {
                running: { cls: 'bg-green-100 text-green-700 border-green-200', mark: '<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block"></span>' },
                done:    { cls: 'bg-gray-100 text-gray-600 border-gray-200',   mark: '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' },
                error:   { cls: 'bg-red-100 text-red-700 border-red-200',      mark: '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"></path></svg>' },
                idle:    { cls: 'bg-gray-50 text-gray-400 border-gray-200',    mark: '<span class="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block"></span>' }
            };
            const s = map[status.type] || map.idle;
            return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium border text-[11px] ${s.cls}">${s.mark}${escapeHtml(status.label)}</span>`;
        }

        // 事件徽章：日志事件类型 → 彩色小徽章（类型可读、一眼区分）
        function eventBadgeHtml(event) {
            const map = {
                'ACCOUNT-END': 'bg-emerald-50 text-emerald-700 border-emerald-200',
                'ACCOUNT-START': 'bg-blue-50 text-blue-700 border-blue-200',
                'URL-REWARD': 'bg-indigo-50 text-indigo-700 border-indigo-200',
                'SEARCH-BING': 'bg-cyan-50 text-cyan-700 border-cyan-200',
                'DAILY-CHECK-IN': 'bg-amber-50 text-amber-700 border-amber-200',
                'ERROR': 'bg-red-50 text-red-700 border-red-200',
                'WARN': 'bg-yellow-50 text-yellow-700 border-yellow-200'
            };
            const cls = map[event] || 'bg-gray-100 text-gray-500 border-gray-200';
            return `<span class="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold tracking-wide ${cls}">${escapeHtml(event || '')}</span>`;
        }

        // ===== 渲染：Home 面板 =====
        function renderHome() {
            const accounts = accountsCache.accounts || [];
            const cards = document.getElementById('home-account-cards');
            const totalCollectedEl = document.getElementById('home-total-collected');
            const totalBalanceEl = document.getElementById('home-total-balance');
            const totalAccountsEl = document.getElementById('home-total-accounts');
            const totalSubEl = document.getElementById('home-total-accounts-sub');
            const balanceSubEl = document.getElementById('home-total-balance-sub');

            totalAccountsEl.innerText = accounts.length;
            totalSubEl.innerText = `已配置 ${accounts.length} 个账号`;

            // 顶部收益卡：直接从 /api/stats 缓存取「今日收益 / 总收益」（脚本执行带来的收益，非账户余额）
            const todayTotal = (statsCache && statsCache.todayTotal) || 0;
            const grandTotal = (statsCache && statsCache.grandTotal) || 0;
            totalCollectedEl.innerText = todayTotal;
            totalBalanceEl.innerText = grandTotal;
            balanceSubEl.innerText = '今日收益 / 累计总收益（日志解析：各账号运行段累计，含未配置账号、多次运行与未完成兜底）';

            // 今日各账号收益映射（用于账号卡片"今日收益"，取当日累计收益而非最近一次运行）
            const todayAccountsMap = {};
            const nowD = new Date();
            const todayKey = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
            const todayEntry = (statsCache && statsCache.daily || []).find(d => d.date === todayKey);
            if (todayEntry) {
                (todayEntry.accounts || []).forEach(a => { todayAccountsMap[a.account] = a.points; });
            }

            if (accounts.length === 0) {
                cards.innerHTML = `
                    <div class="bg-white p-12 rounded-2xl border border-gray-100 card-shadow text-center">
                        <p class="text-gray-500 font-medium">暂无账号</p>
                        <p class="text-sm text-gray-400 mt-1">请先在 accounts.json 中配置账号</p>
                    </div>`;
                return;
            }

            // 今日收益最大值（渐变条宽度参照，至少 1 避免除零）
            const todayPtsList = accounts.map(acc => todayAccountsMap[emailUser(acc.email)] || 0);
            const maxToday = Math.max(...todayPtsList, 1);

            cards.innerHTML = accounts.map((acc, idx) => {
                const log = findLogStatus(acc.email);
                const status = getAccountStatus(log);
                const todayPts = todayAccountsMap[emailUser(acc.email)] || 0;
                const collected = todayPts > 0 ? `+${todayPts}` : '--';

                // 最新动态状态块（2026-08-21 增强）：
                // 运行中 → 脉冲动画；ACCOUNT-END → 高对比边框 + 微渐变背景 + 胶囊标签 + 关键字段加粗主色；
                // 其余事件走基础样式。所有账号走同一渲染路径，保证格式严格对齐。
                const endInfo = parseAccountEnd(log);
                const latestBlock = !log
                    ? `<div class="bg-blue-50/50 p-4 rounded-xl border border-blue-50 min-w-0">
                            <p class="text-xs text-blue-500 mb-1">最新动态</p>
                            <p class="text-sm font-semibold text-gray-700">暂无运行记录</p>
                        </div>`
                    : status.type === 'running'
                        ? `<div class="latest-running p-4 rounded-xl border min-w-0">
                                <p class="text-xs text-blue-500 mb-1">最新动态</p>
                                <div class="mb-1">${eventBadgeHtml(log.lastEvent)}</div>
                                <p class="text-sm font-semibold text-gray-700 line-clamp-2">${escapeHtml(log.lastMessage || '')}</p>
                            </div>`
                        : endInfo
                            ? `<div class="latest-done p-4 rounded-xl border min-w-0">
                                    <div class="flex items-center justify-between gap-2 mb-2">
                                        <span class="account-end-pill">ACCOUNT-END</span>
                                        <span class="text-xs text-gray-400">${formatTime(log.lastTime)}</span>
                                    </div>
                                    <p class="text-sm text-gray-700 mb-1 line-clamp-2">${escapeHtml(log.lastMessage || '')}</p>
                                    <p class="text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                                        ${endInfo.total != null ? `<span class="key-point">+${endInfo.total} pts</span>` : ''}
                                        ${endInfo.initial != null && endInfo.final != null ? `<span class="text-gray-500">原始 ${endInfo.initial} → 新值 ${endInfo.final}</span>` : ''}
                                        ${endInfo.durationSeconds != null ? `<span class="text-gray-500">总运行时间: <span class="key-point">${(endInfo.durationSeconds / 60).toFixed(2)}</span> 分钟</span>` : ''}
                                    </p>
                                </div>`
                            : `<div class="bg-blue-50/50 p-4 rounded-xl border border-blue-50 min-w-0">
                                    <p class="text-xs text-blue-500 mb-1">最新动态</p>
                                    <div class="mb-1">${eventBadgeHtml(log.lastEvent)}</div>
                                    <p class="text-sm font-semibold text-gray-700 line-clamp-2">${escapeHtml(log.lastMessage || '')}</p>
                                </div>`;

                return `
                <div class="bg-white p-6 rounded-2xl border border-gray-100 card-shadow space-y-5 min-w-0">
                    <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center gap-4 min-w-0 flex-1">
                            <span class="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-lg flex-shrink-0">${idx + 1}</span>
                            <div class="min-w-0">
                                <h3 class="font-bold text-gray-900 text-lg truncate">${escapeHtml(acc.email)}</h3>
                                <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                                    ${statusTagHtml(status)}
                                    <span class="text-xs text-gray-400">${escapeHtml(log ? '日志条目: ' + log.entries : '无日志')}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="bg-gray-50/80 p-4 rounded-xl border border-gray-100 min-w-0">
                            <p class="text-xs text-gray-500 mb-1">今日收益</p>
                            <p class="text-2xl font-bold ${collected === '--' ? 'text-gray-400' : 'text-blue-700'}">${collected} pts</p>
                            ${todayPts > 0 ? `<div class="mt-2 h-1.5 bg-gray-200 rounded-full overflow-hidden"><div class="stats-grad-bar h-full rounded-full" style="width:${Math.max(4, todayPts / maxToday * 100)}%"></div></div>` : ''}
                        </div>
                        ${latestBlock}
                    </div>
                    ${log ? `<p class="text-[11px] text-gray-400">最近活动: ${formatTime(log.lastTime)} · ${escapeHtml(log.lastEvent || '')}</p>` : ''}
                </div>`;
            }).join('');
        }

        // ===== 渲染：Accounts 面板 =====
        function renderAccountsPanel() {
            const accounts = accountsCache.accounts || [];
            const list = document.getElementById('accounts-list');
            const empty = document.getElementById('accounts-empty');

            if (accounts.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }
            empty.classList.add('hidden');

            // 配置字段 → 完整中文文案（语言环境 / 语言代码映射，用于弱化的配置摘要行）
            const localeName = { auto: '自动', us: '美国', gb: '英国', cn: '中国' };
            const langName = { zh: '中文', en: '英文' };

            list.innerHTML = accounts.map((acc, idx) => {
                const log = findLogStatus(acc.email);
                const status = getAccountStatus(log);
                const proxyEnabled = acc.proxy && acc.proxy.proxyAxios;

                // 共性配置摘要（次要信息，弱化展示）：saveFingerprint / geoLocale / langCode 均为
                // 账号配置属性（新增时后端默认填充），并非运行记录；不再以彩色徽章展示，
                // 改为完整中文文案的灰色小字，避免与运行状态混淆、降低视觉噪音
                const localeKey = String(acc.geoLocale || 'auto').toLowerCase();
                const langKey = String(acc.langCode || 'zh').toLowerCase();
                const fp = acc.saveFingerprint || {};
                const fpParts = [];
                if (fp.desktop) fpParts.push('桌面端');
                if (fp.mobile) fpParts.push('移动端');
                const configBits = [
                    `语言环境：${escapeHtml(localeName[localeKey] || String(acc.geoLocale || 'auto').toUpperCase())}`,
                    `语言：${escapeHtml(langName[langKey] || acc.langCode || 'zh')}`,
                    `指纹：${fpParts.length ? fpParts.join(' + ') : '不保留'}`
                ];

                return `
                <div class="bg-white p-5 rounded-2xl border border-gray-100 card-shadow flex items-center justify-between gap-4 group">
                    <div class="flex items-center gap-4 flex-1">
                        <span class="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl font-bold">${idx + 1}</span>
                        <div>
                            <h3 class="font-bold text-gray-900 text-lg">${escapeHtml(acc.email)}</h3>
                            <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                                ${statusTagHtml(status)}
                                ${proxyEnabled ? '<span class="text-[11px] px-2 py-0.5 bg-green-50 text-green-600 rounded-md font-medium border border-green-100">代理</span>' : ''}
                            </div>
                            <p class="text-[11px] text-gray-400 mt-1.5">${configBits.join(' · ')}</p>
                            <div class="mt-1.5 flex items-start gap-1.5">
                                ${log ? eventBadgeHtml(log.lastEvent) : ''}
                                <p class="text-xs text-gray-500 break-words flex-1 min-w-0">
                                    ${log ? escapeHtml(log.lastMessage || '') : '暂无运行记录，启动任务后自动显示状态'}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-2 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                        <button type="button" data-action="settings" data-email="${escapeHtml(acc.email)}" class="btn-icon btn-icon-primary" title="详细设置">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                        </button>
                        <button type="button" data-action="delete" data-email="${escapeHtml(acc.email)}" class="btn-icon btn-icon-danger" title="删除">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </div>
                </div>`;
            }).join('');

            // 事件委托（2026-08-20）：替代原 onclick="fn('${email}')" 内联拼接。
            // HTML 属性值会先做实体解码、再作为 JS 源码解析，所以把 ' 转成 &#39; 并不能阻止注入，
            // 必须彻底避免把用户数据拼进内联脚本。用 onclick 直接赋值（而非 addEventListener）
            // 保证每次重渲染不会叠加监听器。
            list.onclick = e => {
                const btn = e.target.closest('button[data-action][data-email]');
                if (!btn) return;
                const email = btn.dataset.email;
                if (btn.dataset.action === 'settings') openAccountSettings(email);
                else if (btn.dataset.action === 'delete') deleteAccount(email);
            };
        }

        // ===== 渲染：Stats 面板（Chart.js 趋势图） =====
        let statsChart = null; // Chart.js 实例缓存（防止重复创建）

        async function renderStats() {
            const barsEl = document.getElementById('stats-account-bars');
            const chartCtx = document.getElementById('stats-trend-chart');

            // 安全兜底（元素不存在时跳过）
            if (!chartCtx && !barsEl) return;

            // 优先使用 loadData 缓存的 statsCache（每 30s 轮询刷新），缺失时（如首次进入统计页）再单独拉取
            let statsData = statsCache;
            if (!statsData) {
                try {
                    statsData = await fetchJson('/api/stats');
                } catch (e) {
                    console.error('加载统计失败:', e);
                    if (document.getElementById('stats-stats-info')) {
                        document.getElementById('stats-stats-info').innerText = '加载失败，请确认已运行 node gui/server.js';
                    }
                    return;
                }
            }

            // 顶部三张摘要卡
            const grandTotal = statsData.grandTotal || 0;
            const dailyArr = statsData.daily || [];
            // 今日收益优先用后端 todayTotal（本地时区、多账号多运行累计），缺失时回退 daily 最后一天
            const todayPoints = statsData.todayTotal || (dailyArr.length > 0 ? dailyArr[dailyArr.length - 1].total : 0);
            const activeDays = dailyArr.length;

            if (document.getElementById('stats-grand-total')) {
                document.getElementById('stats-grand-total').innerText = `${grandTotal} pts`;
            }
            if (document.getElementById('stats-today-points')) {
                document.getElementById('stats-today-points').innerText = `${todayPoints} pts`;
            }
            if (document.getElementById('stats-active-days')) {
                document.getElementById('stats-active-days').innerText = String(activeDays);
            }
            if (document.getElementById('stats-stats-info')) {
                const generatedAt = statsData.generatedAt ? new Date(statsData.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
                document.getElementById('stats-stats-info').innerText = `解析时间: ${generatedAt || '--'}`;
            }

            // === Chart.js 每日趋势堆叠图 ===
            // 惰性创建：Chart 只在统计面板可见时才创建（隐藏容器尺寸 0×0 会导致 scale 布局异常，动画起点错乱）
            const statsPanel = document.getElementById('panel-stats');
            const isStatsVisible = statsPanel && !statsPanel.classList.contains('hidden');
            if (chartCtx && typeof Chart !== 'undefined') {
                // 构建每个账号的时间序列数据
                const dates = dailyArr.map(d => d.date);
                // 收集所有账号名称（仅保留有收益的账户，零收益不显示在图例/堆叠柱中）
                const allAccounts = new Set();
                dailyArr.forEach(d => {
                    (d.accounts || []).forEach(a => {
                        if (a.points > 0) allAccounts.add(a.account);
                    });
                });

                // 调色板（支持最多 12 个账号）
                const PALETTE = [
                    'rgba(59, 130, 246, 0.8)',   // blue-500
                    'rgba(16, 185, 129, 0.8)',   // emerald-500
                    'rgba(249, 115, 22, 0.8)',   // orange-500
                    'rgba(168, 85, 247, 0.8)',   // purple-500
                    'rgba(236, 72, 153, 0.8)',   // pink-500
                    'rgba(14, 165, 233, 0.8)',   // sky-500
                    'rgba(245, 158, 11, 0.8)',   // amber-500
                    'rgba(34, 197, 94, 0.8)',    // green-500
                    'rgba(99, 102, 241, 0.8)',   // indigo-500
                    'rgba(234, 88, 12, 0.8)',    // orange-600
                    'rgba(20, 184, 166, 0.8)',   // teal-500
                    'rgba(190, 24, 93, 0.8)'     // pink-700
                ];

                // 每个账号的每日积分（按日期对齐）
                const datasets = Array.from(allAccounts).map((account, idx) => {
                    const color = PALETTE[idx % PALETTE.length];
                    return {
                        label: emailUser(account),
                        data: dates.map(date => {
                            const day = dailyArr.find(d => d.date === date);
                            const accEntry = day && day.accounts ? day.accounts.find(a => a.account === account) : null;
                            return accEntry ? accEntry.points : 0;
                        }),
                        backgroundColor: color,
                        borderColor: color.replace('0.8', '1'),
                        borderWidth: 1,
                        fill: true,
                        tension: 0.3
                    };
                });

                // 已有实例：用 animator.js 的平滑更新（保留当前显示高度过渡到新值，不归零重飞）
                if (statsChart) {
                    smoothUpdateChart(statsChart, dates, datasets);
                } else if (isStatsVisible) {
                    // 首次创建（仅面板可见时）：合并 animator.js 的动画配置（x 锚定 + y 从 0 竖直生长）
                    statsChart = new Chart(chartCtx, {
                        type: 'bar',
                        data: {
                            labels: dates,
                            datasets: datasets
                        },
                        options: {
                            animations: false,
                            responsive: true,
                            maintainAspectRatio: false,
                            interaction: { mode: 'index', intersect: false },
                            plugins: {
                                legend: {
                                    position: 'bottom',
                                    labels: { usePointStyle: true, padding: 16, boxWidth: 10, font: { size: 11 } }
                                },
                                tooltip: {
                                    callbacks: {
                                        label: function (context) {
                                            return `${context.dataset.label}: +${context.raw} pts`;
                                        }
                                    }
                                }
                            },
                            scales: {
                                x: { stacked: true, grid: { display: false } },
                                y: {
                                    stacked: true,
                                    beginAtZero: true,
                                    title: { display: true, text: '积分', font: { size: 11 } }
                                }
                            }
                        }
                    });
                }
            }

            // === 各账号累计收益条 ===
            // 过滤掉累计收益为零的账户（不显示在列表中）
            const accountTotals = (statsData.accountTotals || []).filter(a => a.totalPoints > 0);
            const maxAccPoints = Math.max(...accountTotals.map(a => a.totalPoints), 1);
            // DOM diff 更新：复用已有节点以触发 scaleX 过渡（30s 轮询时从旧值平滑过渡，而非瞬跳）
            renderAccountBars(barsEl, accountTotals, maxAccPoints);
        }

        // ===== 渲染：各账号累计收益条（DOM diff 更新，让过渡真正生效） =====
        // 原实现用 innerHTML 全量重绘：新 DOM 直接落在目标宽度，CSS transition 永不播放，每次轮询宽度瞬跳。
        // 改为按账号复用/增删行，仅更新 transform: scaleX，配合 .stats-bar-fill 的 400ms ease-out 从旧值平滑过渡。
        function renderAccountBars(container, accountTotals, maxAccPoints) {
            if (!container) return;
            if (!accountTotals.length) {
                container.innerHTML = '<p class="text-gray-400">暂无账号统计数据</p>';
                return;
            }
            const byAccount = new Map(accountTotals.map(a => [a.account, a]));
            // 清理容器内的非数据行：既包括"暂无账号统计数据"占位提示（无 data-account 属性，
            // 数据由空转有时若不清除会与真实进度条并存），也包括已从数据源移除的账号行。
            // 保证"空状态提示"与"累计收益进度条"严格互斥显示
            [...container.children].forEach(row => {
                const name = row.getAttribute('data-account');
                if (!name || !byAccount.has(name)) row.remove();
            });
            accountTotals.forEach((acc, i) => {
                const width = Math.max(4, (acc.totalPoints / maxAccPoints) * 100);
                let row = [...container.children].find(r => r.getAttribute('data-account') === acc.account);
                if (!row) {
                    row = document.createElement('div');
                    row.className = 'flex items-center gap-3';
                    row.setAttribute('data-account', acc.account);
                    row.innerHTML = `
                <span class="w-40 flex-shrink-0 text-xs text-gray-600 truncate text-right"></span>
                <div class="flex-1 min-w-0 bg-gray-100 rounded-full h-5 overflow-hidden">
                    <div class="stats-bar-fill bg-blue-500 h-full rounded-full" style="transform: scaleX(0)"></div>
                </div>
                <span class="w-24 flex-shrink-0 text-xs font-bold text-blue-700 text-left"></span>
                <span class="w-14 flex-shrink-0 text-[11px] text-gray-400 text-left"></span>`;
                }
                // 排序（按总积分）变化时移动到正确位置
                if (container.children[i] !== row) {
                    container.insertBefore(row, container.children[i] || null);
                }
                row.children[0].textContent = acc.account;
                row.querySelector('.stats-bar-fill').style.transform = `scaleX(${width / 100})`;
                row.children[2].textContent = `+${acc.totalPoints} pts`;
                row.children[3].textContent = `${acc.activeDays} 天`;
            });
        }

        // ===== 导出日志压缩包 =====
        async function exportLogs() {
            const btn = document.getElementById('logs-export-btn');
            if (btn) {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            }

            try {
                const res = await apiFetch('/api/logs/export');
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 从 Content-Disposition 解析文件名
                const cd = res.headers.get('Content-Disposition') || '';
                const m = cd.match(/filename="?([^"]+)"?/);
                const filename = m ? m[1] : 'logs.zip';

                // Blob 触发浏览器下载
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert(`❌ 导出失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50');
                }
            }
        }

        // ===== 导入日志压缩包 =====
        async function importLogs(fileInput) {
            const file = fileInput && fileInput.files && fileInput.files[0];
            // 重置 input，允许重复选择同一文件
            if (fileInput) fileInput.value = '';
            if (!file) return;

            const btn = document.getElementById('logs-import-btn');
            if (btn) {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            }

            try {
                // FileReader → Base64（去掉 data:...;base64, 前缀）
                const dataBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result;
                        if (typeof result === 'string') {
                            resolve(result.split(',')[1]);
                        } else {
                            reject(new Error('文件读取失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsDataURL(file);
                });

                const res = await apiFetch('/api/logs/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, dataBase64 })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                const details = (data.files || []).map(f => `  ${f}`).join('\n');
                alert(`✅ ${data.message}\n\n${details}\n\n目标目录: ${data.target || ''}`);
                // 日志是统计数据源，导入后刷新统计卡/图表
                await loadData();
            } catch (error) {
                alert(`❌ 导入失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50');
                }
            }
        }

        // ===== 一键导出全部本地数据（sessions + logs + accounts + config） =====
        async function exportAllData() {
            const btn = document.getElementById('data-export-btn');
            if (btn) {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            }

            try {
                const res = await apiFetch('/api/data/export');
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 从 Content-Disposition 解析文件名
                const cd = res.headers.get('Content-Disposition') || '';
                const m = cd.match(/filename="?([^"]+)"?/);
                const filename = m ? m[1] : 'gui-data.zip';

                // Blob 触发浏览器下载
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert(`❌ 导出失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50');
                }
            }
        }

        // ===== 一键导入全部本地数据 zip =====
        async function importAllData(fileInput) {
            const file = fileInput && fileInput.files && fileInput.files[0];
            // 重置 input，允许重复选择同一文件
            if (fileInput) fileInput.value = '';
            if (!file) return;

            // 导入会覆盖当前数据，提示确认
            if (!confirm('导入将覆盖当前账号/配置/会话/日志数据（原数据会自动备份为 .bak）。\n确定继续吗？')) {
                return;
            }

            const btn = document.getElementById('data-import-btn');
            if (btn) {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            }

            try {
                // FileReader → Base64（去掉 data:...;base64, 前缀）
                const dataBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result;
                        if (typeof result === 'string') {
                            resolve(result.split(',')[1]);
                        } else {
                            reject(new Error('文件读取失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsDataURL(file);
                });

                const res = await apiFetch('/api/data/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, dataBase64 })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                const imp = data.imported || {};
                alert(`✅ ${data.message}\n\nSession: ${imp.sessions || 0}\n日志: ${imp.logs || 0}\n账号: ${imp.accounts || 0}\n配置: ${imp.config || 0}`);
                // 数据被覆盖，刷新面板
                await loadData();
            } catch (error) {
                alert(`❌ 导入失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50');
                }
            }
        }

        // ===== 导出 Session 压缩包 =====
        async function exportSessions() {
            const btn = document.getElementById('session-export-btn');
            if (btn) {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            }

            try {
                const res = await apiFetch('/api/sessions/export');
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 从 Content-Disposition 解析文件名
                const cd = res.headers.get('Content-Disposition') || '';
                const m = cd.match(/filename="?([^"]+)"?/);
                const filename = m ? m[1] : 'sessions.zip';

                // Blob 触发浏览器下载
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert(`❌ 导出失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50');
                }
            }
        }

        // ===== 关闭服务 =====
        let isShuttingDown = false; // 防重入：双击/连点会连弹两次 confirm

        async function shutdownServer() {
            if (isShuttingDown) return;
            if (!confirm('确定要停止服务并退出吗？')) {
                return;
            }
            isShuttingDown = true; // 确认后锁定，避免第二次点击再触发 confirm

            try {
                const res = await apiFetch('/api/shutdown', { method: 'POST' });
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 停止轮询，避免服务退出后的失败请求刷 console
                const overlays = document.getElementById('shutdown-overlay');
                try {
                    // 尝试关闭当前浏览器页面（若被浏览器拦截则显示遮罩）
                    window.close();
                    setTimeout(() => {
                        // window.close() 被拦截时页面仍在，显示"服务已关闭"遮罩
                        if (overlays) overlays.classList.remove('hidden');
                    }, 500);
                } catch {
                    if (overlays) overlays.classList.remove('hidden');
                }
            } catch (error) {
                alert(`❌ 关闭失败: ${error.message || error}`);
                isShuttingDown = false; // 失败后复位，允许重试
            }
        }

        // ===== 安装环境（运行根目录 setup 程序） =====
        // 冲突防护：任务运行中时，setup 的构建步骤（rimraf dist + npm i）可能中断任务子进程，明确警告；
        // 异步非阻塞：后端以独立最小化窗口执行（detached + unref），HTTP 立即返回，GUI 不卡顿
        async function setupEnvironment() {
            const warning = taskRunning
                ? '⚠️ 当前有任务正在运行中！\n\n安装环境（setup 会执行构建，可能删除 dist/ 并重装依赖）\n可能中断正在运行的任务，建议先停止任务再继续。\n\n确定要继续吗？'
                : '将运行项目根目录的 setup 程序（安装依赖并构建环境）。\n\n该过程可能耗时数分钟，将在独立最小化窗口中执行，GUI 可继续使用。\n\n确定要继续吗？';
            if (!confirm(warning)) return;

            try {
                const res = await apiFetch('/api/setup', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                alert(`✅ ${data.message}\n\n请在独立窗口观察进度，完成前请勿重复点击。`);
            } catch (e) {
                alert(`❌ 启动失败: ${e.message}`);
            }
        }

        // ===== 导入 Session 压缩包 =====
        async function importSessionFile(fileInput) {
            const file = fileInput && fileInput.files && fileInput.files[0];
            // 重置 input，允许重复选择同一文件
            if (fileInput) fileInput.value = '';
            if (!file) return;

            const btn = document.getElementById('session-import-btn');
            if (btn) {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            }

            try {
                // FileReader → Base64（去掉 data:...;base64, 前缀）
                const dataBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result;
                        if (typeof result === 'string') {
                            resolve(result.split(',')[1]);
                        } else {
                            reject(new Error('文件读取失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsDataURL(file);
                });

                const res = await apiFetch('/api/sessions/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, dataBase64 })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                const details = (data.accounts || []).map(a => `  ${a.email} (${a.files.length} 个文件)`).join('\n');
                alert(`✅ ${data.message}\n\n${details}\n\n目标目录: ${data.target || ''}`);
            } catch (error) {
                alert(`❌ 导入失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50');
                }
            }
        }

        // ===== 渲染：Settings 面板（从 configCache 回显全局配置） =====
        function renderSettings() {
            const cfg = configCache || {};
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el && val !== undefined && val !== null) {
                    if (el.type === 'checkbox') {
                        el.checked = Boolean(val);
                    } else {
                        el.value = String(val);
                    }
                }
            };

            // 基础参数
            set('cfg-baseURL', cfg.baseURL);
            set('cfg-globalTimeout', cfg.globalTimeout);
            set('gui-port-input', guiSettingsCache.port);
            set('cfg-headless', cfg.headless);
            set('cfg-ensureStreakProtection', cfg.ensureStreakProtection);
            set('cfg-errorDiagnostics', cfg.errorDiagnostics);
            set('cfg-debugLogs', cfg.debugLogs);
            set('cfg-searchOnBingLocalQueries', cfg.searchOnBingLocalQueries);

            // 任务开关 (workers)
            const w = cfg.workers || {};
            set('cfg-workers-doDailySet', w.doDailySet);
            set('cfg-workers-doClaimBonusPoints', w.doClaimBonusPoints);
            set('cfg-workers-doSpecialPromotions', w.doSpecialPromotions);
            set('cfg-workers-doMorePromotions', w.doMorePromotions);
            set('cfg-workers-doPunchCards', w.doPunchCards);
            set('cfg-workers-doAppPromotions', w.doAppPromotions);
            set('cfg-workers-doDesktopSearch', w.doDesktopSearch);
            set('cfg-workers-doMobileSearch', w.doMobileSearch);
            set('cfg-workers-doDailyCheckIn', w.doDailyCheckIn);
            set('cfg-workers-doReadToEarn', w.doReadToEarn);

            // 低风险新增项
            const px = cfg.proxy || {};
            set('cfg-proxy-queryEngine', px.queryEngine);
            const clf = cfg.consoleLogFilter || {};
            set('cfg-consoleLogFilter-enabled', clf.enabled);

            // 搜索与延迟
            const ss = cfg.searchSettings || {};
            set('cfg-scrollRandomResults', ss.scrollRandomResults);
            set('cfg-clickRandomResults', ss.clickRandomResults);
            set('cfg-searchResultVisitTime', ss.searchResultVisitTime);
            const delay = ss.searchDelay || {};
            set('cfg-searchDelayMin', delay.min);
            set('cfg-searchDelayMax', delay.max);
            const readDelay = ss.readDelay || {};
            set('cfg-readDelayMin', readDelay.min);
            set('cfg-readDelayMax', readDelay.max);
            const ca = ss.chinaApi || {};
            set('cfg-chinaApi-appkey', ca.appkey);

            // 只读配置回显（不参与保存）
            set('ro-sessionPath', cfg.sessionPath);
            set('ro-clusters', cfg.clusters);
            set('ro-queryEngines', ss.queryEngines ? ss.queryEngines.join(', ') : '');
            const clfDetail = cfg.consoleLogFilter || {};
            set('ro-consoleLogFilter', JSON.stringify({
                mode: clfDetail.mode,
                levels: clfDetail.levels,
                keywords: clfDetail.keywords,
                regexPatterns: clfDetail.regexPatterns
            }));
            set('ro-webhook', JSON.stringify(cfg.webhook || {}));
        }

        // ===== 全局配置即时保存 =====
        // 字段映射表：控件 id → config 嵌套路径（用于增量提交，后端为合并写回）
        const CONFIG_FIELD_MAP = {
            'cfg-baseURL': ['baseURL'],
            'cfg-globalTimeout': ['globalTimeout'],
            'cfg-headless': ['headless'],
            'cfg-ensureStreakProtection': ['ensureStreakProtection'],
            'cfg-errorDiagnostics': ['errorDiagnostics'],
            'cfg-debugLogs': ['debugLogs'],
            'cfg-searchOnBingLocalQueries': ['searchOnBingLocalQueries'],
            'cfg-proxy-queryEngine': ['proxy', 'queryEngine'],
            'cfg-consoleLogFilter-enabled': ['consoleLogFilter', 'enabled'],
            'cfg-workers-doDailySet': ['workers', 'doDailySet'],
            'cfg-workers-doClaimBonusPoints': ['workers', 'doClaimBonusPoints'],
            'cfg-workers-doSpecialPromotions': ['workers', 'doSpecialPromotions'],
            'cfg-workers-doMorePromotions': ['workers', 'doMorePromotions'],
            'cfg-workers-doPunchCards': ['workers', 'doPunchCards'],
            'cfg-workers-doAppPromotions': ['workers', 'doAppPromotions'],
            'cfg-workers-doDesktopSearch': ['workers', 'doDesktopSearch'],
            'cfg-workers-doMobileSearch': ['workers', 'doMobileSearch'],
            'cfg-workers-doDailyCheckIn': ['workers', 'doDailyCheckIn'],
            'cfg-workers-doReadToEarn': ['workers', 'doReadToEarn'],
            'cfg-scrollRandomResults': ['searchSettings', 'scrollRandomResults'],
            'cfg-clickRandomResults': ['searchSettings', 'clickRandomResults'],
            'cfg-searchResultVisitTime': ['searchSettings', 'searchResultVisitTime'],
            'cfg-chinaApi-appkey': ['searchSettings', 'chinaApi', 'appkey'],
            'cfg-searchDelayMin': ['searchSettings', 'searchDelay', 'min'],
            'cfg-searchDelayMax': ['searchSettings', 'searchDelay', 'max'],
            'cfg-readDelayMin': ['searchSettings', 'readDelay', 'min'],
            'cfg-readDelayMax': ['searchSettings', 'readDelay', 'max']
        };

        function debounce(fn, ms) {
            let timer = null;
            return function (...args) {
                clearTimeout(timer);
                timer = setTimeout(() => fn.apply(this, args), ms);
            };
        }

        // 串行保存链：快速连续修改时按顺序写盘，避免并发 PUT 乱序
        let configSaveChain = Promise.resolve();

        // 保存状态提示（Toast：右下角浮动卡片，圆底图标 + 边框颜色区分成功/失败，2.5s 后自动消失）
        let configSaveStatusTimer = null;
        const TOAST_ICONS = {
            success: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
            error: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
        };
        function setConfigSaveStatus(text, isError) {
            const toast = document.getElementById('save-toast');
            if (!toast) return;
            const type = isError ? 'error' : 'success';
            toast.setAttribute('data-type', type);
            const icon = toast.querySelector('.toast-icon');
            if (icon) icon.innerHTML = TOAST_ICONS[type];
            const textEl = toast.querySelector('.toast-text');
            if (textEl) textEl.textContent = text;
            clearTimeout(configSaveStatusTimer);
            toast.setAttribute('data-visible', 'true'); // 200ms ease-out 进入
            configSaveStatusTimer = setTimeout(() => {
                toast.removeAttribute('data-visible'); // 200ms ease-out 退出
            }, 2500);
        }

        // 静默保存：增量提交单个字段，成功后用后端合并结果更新 configCache（不重渲染表单，避免打断输入）
        function saveConfigSilent(payload) {
            configSaveChain = configSaveChain.then(async () => {
                try {
                    const res = await apiFetch('/api/config', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    if (!res.ok) {
                        throw new Error(data.error || `HTTP ${res.status}`);
                    }
                    // 更新缓存，30 秒自动重渲染时回显刚保存的值，不会被旧值覆盖
                    if (data.config) configCache = data.config;
                    setConfigSaveStatus('✓ 已自动保存', false);
                } catch (error) {
                    console.error('配置自动保存失败:', error);
                    setConfigSaveStatus('✗ 保存失败', true);
                }
            });
            return configSaveChain;
        }

        // 从控件当前值构建增量 payload：{ searchSettings: { searchDelay: { min: '5min' } } }
        function buildIncrementalPayload(id) {
            const fieldPath = CONFIG_FIELD_MAP[id];
            if (!fieldPath) return null;
            const el = document.getElementById(id);
            if (!el) return null;
            const value = el.type === 'checkbox' ? el.checked : el.value;
            const payload = {};
            let cursor = payload;
            for (let i = 0; i < fieldPath.length - 1; i++) {
                cursor[fieldPath[i]] = {};
                cursor = cursor[fieldPath[i]];
            }
            cursor[fieldPath[fieldPath.length - 1]] = value;
            return payload;
        }

        // 保存 GUI 专属设置（端口等）：独立接口 /api/gui-settings，不混入脚本 config.json
        function saveGuiSettingSilent(payload) {
            return apiFetch('/api/gui-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(res => res.json())
            .then(data => {
                if (!data || !data.success) throw new Error((data && data.error) || '保存失败');
                guiSettingsCache = { ...guiSettingsCache, ...payload };
                setConfigSaveStatus('✓ 端口已保存（重启后生效）', false);
            })
            .catch(error => {
                console.error('GUI 设置保存失败:', error);
                setConfigSaveStatus(`✗ 保存失败: ${error.message}`, true);
            });
        }

        // 端口输入校验：1024-65535 整数，非法红框提示且不写入；合法即改即存
        function saveGuiPort() {
            const el = document.getElementById('gui-port-input');
            if (!el) return;
            const value = parseInt(el.value, 10);
            const valid = Number.isInteger(value) && value >= 1024 && value <= 65535;
            el.classList.toggle('border-red-500', !valid);
            if (!valid) {
                setConfigSaveStatus('✗ 端口需为 1024-65535 的整数', true);
                return;
            }
            saveGuiSettingSilent({ port: value });
        }

        // 绑定自动保存事件：checkbox 立即保存；text 输入 500ms 防抖 + 失焦兜底
        function bindAutoSaveSettings() {
            const panel = document.getElementById('panel-settings');
            if (!panel) return;

            panel.querySelectorAll('input[type="checkbox"][id^="cfg-"]').forEach(input => {
                input.addEventListener('change', () => {
                    const payload = buildIncrementalPayload(input.id);
                    if (payload) saveConfigSilent(payload);
                });
            });

            panel.querySelectorAll('input:not([type="checkbox"])[id^="cfg-"]').forEach(input => {
                // 跳过只读字段（cfg-baseURL 为高风险，锁定）
                if (input.readOnly) return;
                const debouncedSave = debounce(() => {
                    const payload = buildIncrementalPayload(input.id);
                    if (payload) saveConfigSilent(payload);
                }, 500);
                input.addEventListener('input', debouncedSave);
                input.addEventListener('change', () => {
                    const payload = buildIncrementalPayload(input.id);
                    if (payload) saveConfigSilent(payload);
                });
            });

            // GUI 本地端口（id 不带 cfg- 前缀，独立走 /api/gui-settings）：
            // input 与 change 共用同一防抖函数——输入后失焦/回车时两个事件只会合并触发一次保存，
            // 避免对 /api/gui-settings 重复 PUT（后端重复打印"端口已保存"）
            const portInput = panel.querySelector('#gui-port-input');
            if (portInput) {
                const debouncedPortSave = debounce(saveGuiPort, 500);
                portInput.addEventListener('input', debouncedPortSave);
                portInput.addEventListener('change', debouncedPortSave);
            }
        }

        // ===== 打开配置文件 =====
        async function openConfigFile() {
            const btn = document.getElementById('config-open-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '打开中...';
            }

            try {
                const res = await apiFetch('/api/config/open', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}\n文件路径: ${data.path || ''}`);
            } catch (error) {
                alert(`❌ 打开失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 重置全局配置为默认 =====
        async function resetConfig() {
            if (!confirm('确定要将所有设置重置为默认值吗？\n此操作将用 config.example.json 覆盖当前 config.json，且不可撤销。')) {
                return;
            }

            const btn = document.querySelector('#panel-settings .btn-danger-ghost');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '重置中...';
            }

            try {
                const res = await apiFetch('/api/config/reset', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}\n备份文件: ${data.backup || 'N/A'}`);
                // 刷新 configCache 回显（所有开关恢复默认）
                await loadData();
            } catch (error) {
                alert(`❌ 重置失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 渲染全部 =====
        function renderAll() {
            renderHome();
            renderAccountsPanel();
            renderStats();
            renderSettings();
        }

        // ===== 删除账号 =====
        async function deleteAccount(email) {
            if (!email) return;
            // 二次确认，防止误删
            if (!confirm(`确定要删除账号 ${email} 吗？\n此操作将立即从 accounts 配置中移除，且不可撤销。`)) {
                return;
            }

            try {
                const res = await apiFetch(`/api/accounts/${encodeURIComponent(email)}`, {
                    method: 'DELETE'
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}`);
                // 刷新面板数据
                await loadData();
            } catch (error) {
                alert(`❌ 删除失败: ${error.message || error}`);
            }
        }

        // ===== 新增账号 =====
        async function submitAddAccount() {
            const emailInput = document.getElementById('add-account-email');
            const passwordInput = document.getElementById('add-account-password');
            const totpInput = document.getElementById('add-account-totp');
            const recoveryInput = document.getElementById('add-account-recovery');
            if (!emailInput || !passwordInput) return;

            const email = emailInput.value.trim();
            const password = passwordInput.value;
            const totpSecret = totpInput ? totpInput.value.trim() : '';
            const recoveryEmail = recoveryInput ? recoveryInput.value.trim() : '';

            // 前端快速校验
            if (!email || !email.includes('@')) {
                alert('❌ 请输入有效的登录邮箱');
                return;
            }
            if (!password) {
                alert('❌ 请输入密码');
                return;
            }

            const btn = document.querySelector('#modal-add-account .btn-primary');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '添加中...';
            }

            try {
                const res = await apiFetch('/api/accounts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email,
                        password,
                        totpSecret,
                        recoveryEmail
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}`);
                closeModal('modal-add-account');
                // 清空表单
                emailInput.value = '';
                passwordInput.value = '';
                if (totpInput) totpInput.value = '';
                if (recoveryInput) recoveryInput.value = '';
                // 刷新面板数据
                await loadData();
            } catch (error) {
                alert(`❌ 添加失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 账号设置弹窗 =====
        let currentEditingEmail = null; // 当前正在编辑的账号邮箱

        function applyProxyFieldsVisibility() {
            const enabled = document.getElementById('settings-proxy-enabled');
            const fields = document.getElementById('settings-proxy-fields');
            if (!enabled || !fields) return;
            if (enabled.checked) {
                fields.classList.remove('opacity-50', 'pointer-events-none');
            } else {
                fields.classList.add('opacity-50', 'pointer-events-none');
            }
        }

        function openAccountSettings(email) {
            const acc = (accountsCache.accounts || []).find(a => a.email === email);
            if (!acc) return;
            currentEditingEmail = email;

            const modal = document.getElementById('modal-account-settings');
            const emailLabel = modal.querySelector('.text-xs.text-gray-500');
            if (emailLabel) emailLabel.innerText = acc.email;

            // === 地理与伪装 ===
            // geoLocale: 处理不在固定选项中的国家代码（动态添加）
            const geoSelect = document.getElementById('settings-geoLocale');
            const EXISTING_VALUES = ['auto', 'us', 'gb', 'cn'];
            for (let i = geoSelect.options.length - 1; i >= 0; i--) {
                if (!EXISTING_VALUES.includes(geoSelect.options[i].value)) {
                    geoSelect.remove(i);
                }
            }
            const geoValue = (acc.geoLocale || 'auto').toLowerCase();
            let found = false;
            for (let i = 0; i < geoSelect.options.length; i++) {
                if (geoSelect.options[i].value === geoValue) {
                    geoSelect.selectedIndex = i;
                    found = true;
                    break;
                }
            }
            if (!found) {
                const opt = document.createElement('option');
                opt.value = geoValue;
                opt.textContent = `${geoValue.toUpperCase()} (自定义)`;
                geoSelect.appendChild(opt);
                geoSelect.value = geoValue;
            }

            // langCode
            document.getElementById('settings-langCode').value = acc.langCode || 'zh';

            // 指纹
            const fp = acc.saveFingerprint || { desktop: true, mobile: true };
            document.getElementById('settings-fp-desktop').checked = Boolean(fp.desktop);
            document.getElementById('settings-fp-mobile').checked = Boolean(fp.mobile);

            // === 网络代理 ===
            const proxy = acc.proxy || { proxyAxios: false, url: '', port: 0, username: '', password: '' };
            document.getElementById('settings-proxy-enabled').checked = Boolean(proxy.proxyAxios);
            document.getElementById('settings-proxy-url').value = proxy.url || '';
            document.getElementById('settings-proxy-port').value = proxy.port || 0;
            document.getElementById('settings-proxy-username').value = proxy.username || '';
            document.getElementById('settings-proxy-password').value = proxy.password || '';
            applyProxyFieldsVisibility();

            openModal('modal-account-settings');
        }

        // ===== 保存账号设置 =====
        async function saveAccountSettings() {
            if (!currentEditingEmail) return;
            const acc = (accountsCache.accounts || []).find(a => a.email === currentEditingEmail);
            if (!acc) return;

            // 从表单收集值
            const proxyEnabled = document.getElementById('settings-proxy-enabled').checked;
            const updatedAccount = {
                // 保留原有核心字段
                email: acc.email,
                password: acc.password,
                totpSecret: acc.totpSecret,      // 未在弹窗中编辑，原样保留
                recoveryEmail: acc.recoveryEmail, // 未在弹窗中编辑，原样保留
                // 表单字段
                geoLocale: document.getElementById('settings-geoLocale').value,
                langCode: document.getElementById('settings-langCode').value || 'zh',
                saveFingerprint: {
                    desktop: document.getElementById('settings-fp-desktop').checked,
                    mobile: document.getElementById('settings-fp-mobile').checked
                },
                proxy: {
                    proxyAxios: proxyEnabled,
                    url: document.getElementById('settings-proxy-url').value || '',
                    port: parseInt(document.getElementById('settings-proxy-port').value, 10) || 0,
                    username: document.getElementById('settings-proxy-username').value || '',
                    password: document.getElementById('settings-proxy-password').value || ''
                }
            };

            // 保存按钮状态反馈
            const saveBtn = document.querySelector('#modal-account-settings .btn-primary');
            const originalText = saveBtn.innerText;
            saveBtn.disabled = true;
            saveBtn.innerText = '保存中...';

            try {
                const res = await apiFetch(`/api/accounts/${encodeURIComponent(currentEditingEmail)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updatedAccount)
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}\n备份文件: ${data.backup || 'N/A'}`);
                closeModal('modal-account-settings');
                // 刷新数据
                await loadData();
            } catch (error) {
                alert(`❌ 保存失败: ${error.message || error}`);
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerText = originalText;
            }
        }

        // ===== 弹窗 =====
        // 进入：移除 hidden → 双 rAF 后挂 data-open，触发 opacity/scale 过渡（替代脆弱的 10ms setTimeout）
        function openModal(modalId) {
            const modal = document.getElementById(modalId);
            if (!modal) return;
            if (modal._closeTimer) { clearTimeout(modal._closeTimer); modal._closeTimer = null; }
            modal._closing = false; // 取消挂起的关闭（防止快速开关的竞态）
            modal.classList.remove('hidden');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => modal.setAttribute('data-open', 'true'));
            });
        }

        // 退出：移除 data-open 播放 250ms 退出动画，transitionend 后再 display:none（与进入路径对称）
        function closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (!modal || modal.classList.contains('hidden') || modal._closing) return;
            modal._closing = true;
            modal.removeAttribute('data-open');
            const finish = () => {
                if (!modal._closing) return; // 已被重新打开，不隐藏
                modal._closing = false;
                modal.classList.add('hidden');
            };
            modal.addEventListener('transitionend', finish, { once: true });
            modal._closeTimer = setTimeout(finish, 300); // 兜底（reduced-motion 下过渡为 200ms）
        }

        // ===== 初始化 =====
        document.addEventListener('DOMContentLoaded', async () => {
            const navItems = document.querySelectorAll('.nav-item');
            const panels = document.querySelectorAll('.content-panel');
            const contentPanels = document.getElementById('contentPanels');

            navItems.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    const targetTab = item.getAttribute('data-tab');

                    navItems.forEach(ni => {
                        ni.classList.remove('bg-blue-50', '!text-blue-700');
                    });
                    item.classList.add('bg-blue-50', '!text-blue-700');

                    panels.forEach(p => p.classList.add('hidden'));
                    document.getElementById(`panel-${targetTab}`).classList.remove('hidden');

                    // 切换面板时重置滚动位置：避免从长页面底部切走后残留滚动，
                    // 保证每个页面都从顶部安全边距开始展示（四个页面顶部结构一致）
                    if (contentPanels) contentPanels.scrollTop = 0;

                    // 切到统计页时若图表尚未创建（面板刚变为可见），补建一次以触发正确的从 0 生长动画
                    if (targetTab === 'stats' && !statsChart) renderStats();
                });
            });

            // 先获取本地访问令牌：后续所有 /api/* 请求与 SSE 保活都依赖它。
            // 获取失败说明本地服务未就绪，直接提示并停止初始化（避免页面停留在无限加载态）
            try {
                await fetchAuthToken();
            } catch (error) {
                alert(`❌ 无法连接本地服务: ${error.message}`);
                return;
            }

            // 加载真实数据
            loadData();

            // 绑定全局配置即时保存（checkbox 立即保存 + text 防抖保存）
            bindAutoSaveSettings();

            // 首次打开弹窗：环境安装提示（"不再提示"勾选即写入 localStorage，取消勾选则移除标记）
            const envSetupCheck = document.getElementById('env-setup-dismiss');
            if (envSetupCheck) {
                envSetupCheck.addEventListener('change', () => {
                    if (envSetupCheck.checked) localStorage.setItem(ENV_SETUP_DISMISS_KEY, '1');
                    else localStorage.removeItem(ENV_SETUP_DISMISS_KEY);
                });
            }
            if (!localStorage.getItem(ENV_SETUP_DISMISS_KEY)) {
                openModal('modal-env-setup');
            }

            // 初始化时拉取任务状态（若服务端已有子进程在跑则显示运行中）
            pollTaskStatus();

            // ===== 网页长连接保活（手动退避重连，2026-08-21） =====
            // EventSource 无法自定义请求头，令牌改走 ?token= 查询参数（后端同样校验）。
            // 标准 EventSource 构造器没有 reconnect 选项，禁用浏览器内置自动重连
            // （间隔固定约 2~3s，服务关闭时会疯狂重连刷屏）的唯一方式是在 onerror 中
            // 第一时间 close()：close 会把 readyState 置为 CLOSED 并取消浏览器已安排的
            // 内置重连计时器。随后改用手动 setTimeout 指数退避
            // （5s→10s→20s→40s→60s 封顶），onopen 成功时重置计数。
            // 页面刷新场景：DOMContentLoaded 重新执行立即建立新连接（首次无延迟）。
            // 服务常驻（2026-08-23 起）：SSE 断开不再影响服务存活（后端不再有 5s 静默期自杀），
            // 此处的退避重连仅用于页面被冻结/网络波动后恢复时尽快重新建立保活连接。
            let keepaliveFailCount = 0;
            let keepaliveSource = null;
            const KEEPALIVE_BASE_MS = 5000;
            const KEEPALIVE_MAX_MS = 60000;

            function scheduleKeepalive(delay = KEEPALIVE_BASE_MS) {
                setTimeout(() => {
                    // 重建前强制销毁旧实例（双保险）：即使上次 onerror 未触发 close，
                    // 也不让残留实例继续其内置的固定间隔自动重连
                    if (keepaliveSource) {
                        keepaliveSource.close();
                        keepaliveSource = null;
                    }
                    keepaliveSource = new EventSource(`/api/keepalive?token=${encodeURIComponent(authToken)}`);
                    keepaliveSource.onopen = () => {
                        keepaliveFailCount = 0; // 连接成功，重置退避计数
                    };
                    keepaliveSource.onerror = () => {
                        // 第一时间 close：阻止浏览器默认的 ~2.35s 固定间隔自动重连，
                        // 重连改由下方手动退避调度（失败计数驱动延迟翻倍）
                        keepaliveSource.close();
                        keepaliveSource = null;
                        keepaliveFailCount += 1;
                        scheduleKeepalive(Math.min(KEEPALIVE_BASE_MS * Math.pow(2, keepaliveFailCount), KEEPALIVE_MAX_MS));
                    };
                }, delay);
            }

            scheduleKeepalive(0); // 首次立即连接（等同旧行为：页面加载即建立 SSE）

            // ===== 轮询调度（setTimeout 递归 + in-flight 锁 + 失败计数退避，2026-08-21） =====
            // 原先固定间隔 setInterval：断网/服务关闭时慢请求会无限叠加、Console 疯狂刷屏。
            // 现改为自调度 setTimeout：上一轮未完成则跳过本轮；连续失败按指数退避
            // 5s→10s→20s→40s→60s 封顶，成功立即重置失败计数回到 5s。
            let taskPollInFlight = false;
            let taskPollFailCount = 0;
            const TASK_POLL_BASE_MS = 5000;
            const TASK_POLL_MAX_MS = 60000;

            function scheduleTaskPoll() {
                // 在调用 setTimeout 之前按当前失败计数计算本次延迟：
                // 0 次失败→5s；1→10s；2→20s；3→40s；4 次及以上→60s 封顶
                const delay = taskPollFailCount === 0
                    ? TASK_POLL_BASE_MS
                    : Math.min(TASK_POLL_BASE_MS * Math.pow(2, taskPollFailCount), TASK_POLL_MAX_MS);
                setTimeout(async () => {
                    if (!taskPollInFlight) {
                        taskPollInFlight = true;
                        try {
                            const ok = await pollTaskStatus();
                            if (ok) taskPollFailCount = 0; // 成功：重置计数
                            else taskPollFailCount += 1;   // 失败：计数 +1，延迟翻倍
                        } finally {
                            taskPollInFlight = false;      // 锁必须在 finally 释放，保证下一轮可触发
                        }
                    }
                    scheduleTaskPoll();                    // 递归调度，永不中断链路
                }, delay);
            }

            let dataPollInFlight = false;
            let dataPollFailCount = 0;
            const DATA_POLL_BASE_MS = 30000;
            const DATA_POLL_MAX_MS = 120000;

            function scheduleDataPoll() {
                const delay = dataPollFailCount === 0
                    ? DATA_POLL_BASE_MS
                    : Math.min(DATA_POLL_BASE_MS * Math.pow(2, dataPollFailCount), DATA_POLL_MAX_MS);
                setTimeout(async () => {
                    if (!dataPollInFlight) {
                        dataPollInFlight = true;
                        try {
                            const ok = await loadData();
                            if (ok) dataPollFailCount = 0;
                            else dataPollFailCount += 1;
                        } finally {
                            dataPollInFlight = false;
                        }
                    }
                    scheduleDataPoll();
                }, delay);
            }

            scheduleTaskPoll();
            scheduleDataPoll();
        });