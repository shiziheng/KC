const express = require('express');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const axios = require('axios');
const store = require('./mysql-store');
const { createBusinessAdminRouter } = require('./business/admin-routes');
const { createBusinessStorefrontRouter } = require('./business/storefront-routes');
const { createRequireStorefrontUser } = require('./business/user-auth');
const runtimeLog = require('./runtime-log');
const { REGION_CONFIG, isSupportedRegion, getPlanTypeLabel } = require('./region-config');
const taxFreeAddress = require('./tax-free-address');
const { testProxyUrl, normalizeProxyLines } = require('./proxy-pool');
const { extractSessionPreview, extractAccessTokenFromRaw, parseSessionJson, extractEmailFromSession } = require('./session-auth');
const { notifyTelegramEvent, notifyAdminSecurityEvent, sendTelegramLoginCode, sendTelegramTest, isCardPoolExhaustedIssue } = require('./telegram-notify');
const adminAuth = require('./admin-auth');
const { buildAdminLoginUrl, buildAdminPanelUrl } = require('./admin-paths');
const { buildHcaptchaEnvFromConfig } = require('./hcaptcha-runtime');
const { checkHcaptchaSolverHealth, testVlmConnectivity, listSolverLogFiles, readSolverLogTail } = require('./hcaptcha-solver');
const { testCaptchaPlatformConnectivity, normalizeCaptchaPlatformApiUrl, resolveCaptchaPlatformCredentials } = require('./captcha-platform');
const browserPool = require('./browser-pool');
const { buildWorkerRuntimeEnv } = require('./browser-runtime');
const { querySubscriptionBySession, validateSessionTokenForQuery, cancelAutoRenew, resumeAutoRenew } = require('./subscription-check');
// 第三方 GPT 代充 API 客户端：默认对接 ZovoCard / SpaceXCard OpenAPI（/openapi/v1）。
// 旧 broker（kc.vpss.eu.cc）实现保留在 gpt-api-client.js，需要时改回 require 即可。
const gptApi = require('./zovocard-client');
const supplierHealth = require('./supplier-health');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN_TTL_MS = adminAuth.ADMIN_TOKEN_TTL_MS;
const ADMIN_REFRESH_AFTER_MS = adminAuth.ADMIN_REFRESH_AFTER_MS;
const PROCESS_IDLE_TIMEOUT_MS = Number(process.env.PROCESS_IDLE_TIMEOUT_MS) || (3 * 60 * 1000);
const MAX_PROCESS_ATTEMPTS = Number(process.env.MAX_PROCESS_ATTEMPTS) || 1;
const WS_HEARTBEAT_PING_TYPE = 'ping';
const WS_HEARTBEAT_PONG_TYPE = 'pong';
const ACCESS_DEACTIVATED_MESSAGES_URL = '';
const ACCESS_DEACTIVATED_SYNC_KEY = '';
const ACCESS_DEACTIVATED_SYNC_COOLDOWN_MS = 30 * 1000;
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || adminAuth.resolveAdminTokenSecret();

// 追踪活跃的子进程，防止产生僵尸进程
const activeProcesses = new Set();
function cleanupProcesses() {
    if (activeProcesses.size > 0) {
        console.log(`清理 ${activeProcesses.size} 个活跃子进程...`);
        for (const child of activeProcesses) {
            try { child.kill('SIGKILL'); } catch (e) { }
        }
        activeProcesses.clear();
    }
    browserPool.shutdownBrowserPool().catch((error) => {
        console.warn(`[BrowserPool] 关闭失败: ${error.message}`);
    });
}

// WebSocket 客户端映射: jobKey -> Set<WebSocket>
const taskClients = new Map();
const TERMINAL_TASK_STATUSES = new Set(['success', 'failed', 'maintenance']);
const activeForegroundJobs = new Set();

let systemMetricsCache = {
    ts: 0,
    data: null,
    promise: null
};

function reserveForegroundSlot(slotKey) {
    activeForegroundJobs.add(String(slotKey));
}

function releaseForegroundSlot(slotKey) {
    activeForegroundJobs.delete(String(slotKey));
}

function getTotalActiveJobs() {
    return activeForegroundJobs.size;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSystemMetrics() {
    const now = Date.now();
    if (systemMetricsCache.data && now - systemMetricsCache.ts < 3000) {
        return systemMetricsCache.data;
    }
    if (systemMetricsCache.promise) {
        return systemMetricsCache.promise;
    }

    systemMetricsCache.promise = (async () => {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const cpuCount = Math.max(1, (os.cpus() || []).length);
        const load = Number(os.loadavg()[0] || 0);
        const cpuPercent = Math.min(100, Math.round((load / cpuCount) * 100));

        let disk = {
            percent: 0,
            usedText: '0.0G',
            totalText: '0.0G',
            drive: '/'
        };
        try {
            const dfOut = execFileSync('df', ['-kP', '/'], { encoding: 'utf8' });
            const lines = dfOut.trim().split('\n');
            if (lines.length >= 2) {
                const parts = lines[1].trim().split(/\s+/);
                const total = Number(parts[1] || 0) * 1024;
                const used = Number(parts[2] || 0) * 1024;
                disk = {
                    percent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
                    usedText: `${(used / (1024 ** 3)).toFixed(1)}G`,
                    totalText: `${(total / (1024 ** 3)).toFixed(1)}G`,
                    drive: parts[5] || '/'
                };
            }
        } catch (_) { /* ignore */ }

        const data = {
            cpu: {
                percent: cpuPercent,
                text: `负载 ${load.toFixed(2)} / ${cpuCount} 核`
            },
            memory: {
                percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
                text: `${(usedMem / (1024 ** 3)).toFixed(1)}G/${(totalMem / (1024 ** 3)).toFixed(1)}G`
            },
            disk,
            uptime: { seconds: Math.floor(os.uptime()) }
        };
        systemMetricsCache.data = data;
        systemMetricsCache.ts = Date.now();
        systemMetricsCache.promise = null;
        return data;
    })().catch((error) => {
        systemMetricsCache.promise = null;
        throw error;
    });

    return systemMetricsCache.promise;
}

function getClientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').trim();
    const rawIp = forwarded ? forwarded.split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || '');
    return String(rawIp || '')
        .replace(/^::ffff:/, '')
        .replace(/^::1$/, '127.0.0.1')
        .trim();
}

function getRemainingCooldownMinutes(cooldownUntil) {
    if (!cooldownUntil) {
        return 0;
    }
    const cooldownDate = new Date(cooldownUntil);
    if (!(cooldownDate instanceof Date) || Number.isNaN(cooldownDate.getTime()) || cooldownDate <= new Date()) {
        return 0;
    }
    return Math.ceil((cooldownDate - new Date()) / 60000);
}

function isNoActivationEligibilityMessage(message) {
    return String(message || '').includes('无激活权限');
}

function parseFlexibleTimestamp(value) {
    if (value == null || value === '') {
        return null;
    }

    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value > 1e12) {
            return Math.trunc(value);
        }
        if (value > 1e9) {
            return Math.trunc(value * 1000);
        }
        return null;
    }

    const normalized = String(value).trim();
    if (!normalized) {
        return null;
    }

    if (/^\d{13}$/.test(normalized)) {
        return Number(normalized);
    }
    if (/^\d{10}$/.test(normalized)) {
        return Number(normalized) * 1000;
    }

    const candidate = normalized.includes('T')
        ? normalized
        : normalized.replace(' ', 'T');
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
        return parsed;
    }

    return null;
}


function broadcastToTask(jobKey, data) {
    const clients = taskClients.get(jobKey);
    if (clients) {
        const message = JSON.stringify(data);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    }
}

function unsubscribeTaskClient(jobKey, ws) {
    if (!jobKey || !taskClients.has(jobKey)) {
        return;
    }
    const clients = taskClients.get(jobKey);
    clients.delete(ws);
    if (clients.size === 0) {
        taskClients.delete(jobKey);
    }
}

async function sendTaskSnapshot(ws, jobKey) {
    const task = await store.getTaskStatus(jobKey);
    if (!task || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    let storedMedia = { screenshots: [], videos: [] };
    if (task.failure_screenshots) {
        try {
            const parsed = JSON.parse(task.failure_screenshots);
            storedMedia = splitTaskMediaPaths(Array.isArray(parsed) ? parsed : []);
        } catch (_) { /* ignore */ }
    }
    const media = extractTaskMediaFromOutput(task.raw_output || '');

    ws.send(JSON.stringify({
        type: 'snapshot',
        jobKey,
        status: task.status,
        message: task.message,
        progress: Number(task.progress || 0),
        cdkCode: task.cdk_code || null,
        phone: task.phone || null,
        cardLast4: task.card_last4 || null,
        screenshots: [...new Set([...storedMedia.screenshots, ...media.screenshots])],
        videos: [...new Set([...storedMedia.videos, ...media.videos])],
        isTerminal: TERMINAL_TASK_STATUSES.has(task.status)
    }));
}

function logTask(jobKey, message, level = 'log') {
    runtimeLog.push({
        jobKey,
        level,
        source: 'task',
        text: String(message || '')
    });
    const logger = console[level] || console.log;
    logger(`[Task ${jobKey}] ${message}`);
}

function logTaskChunk(jobKey, attempt, source, chunk) {
    const text = String(chunk || '');
    if (!text) {
        return;
    }

    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        runtimeLog.push({
            jobKey,
            level: line.includes('CAPTCHA_LOG:') || line.includes('[Captcha/')
                ? 'captcha'
                : (source === 'stderr' ? 'stderr' : 'stdout'),
            source: line.includes('CAPTCHA_LOG:') || line.includes('[Captcha/')
                ? 'captcha'
                : `spawn/a${attempt}/${source}`,
            text: line.replace(/^CAPTCHA_LOG:\s*/, '')
        });
        console.log(`[Task ${jobKey}][Attempt ${attempt}][${source}] ${line}`);
    }
}

process.on('SIGINT', () => { cleanupProcesses(); process.exit(0); });
process.on('SIGTERM', () => { cleanupProcesses(); process.exit(0); });
process.on('exit', () => cleanupProcesses());

let storeReadyPromise = null;

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '15mb';
app.use(express.json({ limit: JSON_BODY_LIMIT, verify: function (req, res, buf) { try { req.rawBody = buf; } catch (e) { /* ignore */ } } }));

let cachedAdminPaths = null;

async function getCachedAdminPaths() {
    if (cachedAdminPaths) {
        return cachedAdminPaths;
    }
    await ensureStoreReady();
    cachedAdminPaths = await store.getAdminPaths();
    return cachedAdminPaths;
}

function invalidateAdminPathsCache() {
    cachedAdminPaths = null;
}

function normalizeRequestPathname(pathname) {
    return String(pathname || '/').replace(/\/+$/, '') || '/';
}

async function attachAdminPaths(payload) {
    const paths = await getCachedAdminPaths();
    return {
        ...payload,
        loginPath: buildAdminLoginUrl(paths),
        panelPath: buildAdminPanelUrl(paths)
    };
}

app.use((req, res, next) => {
    if (req.method === 'GET' && ['/admin.html', '/admin-login.html'].includes(req.path)) {
        return res.status(404).type('text/plain').send('Not Found');
    }
    next();
});

app.use(async (req, res, next) => {
    if (req.method !== 'GET') {
        return next();
    }
    try {
        const paths = await getCachedAdminPaths();
        const current = normalizeRequestPathname(req.path);
        const loginUrl = normalizeRequestPathname(buildAdminLoginUrl(paths));
        const panelUrl = normalizeRequestPathname(buildAdminPanelUrl(paths));
        if (current === loginUrl) {
            return res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
        }
        if (current === panelUrl) {
            return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
        }
    } catch (_) {
        // DB 尚未就绪时交给后续路由处理
    }
    return next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/business-admin', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'business-admin.html'));
});

function ensureStoreReady() {
    if (!storeReadyPromise) {
        storeReadyPromise = store.ensureReady().catch((error) => {
            storeReadyPromise = null;
            throw error;
        });
    }
    return storeReadyPromise;
}

function decodeJwtPart(part) {
    const normalized = String(part || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function normalizeSessionToken(raw) {
    return extractAccessTokenFromRaw(raw);
}

function normalizeSessionRaw(raw) {
    const content = String(raw || '').trim();
    if (!content.startsWith('{')) {
        return '';
    }
    try {
        const data = JSON.parse(content);
        if (data?.accessToken || data?.access_token || data?.user) {
            return content;
        }
    } catch (_) {
        return '';
    }
    return '';
}

function buildStoredSessionPayload(rawSession, sessionJson, token) {
    if (sessionJson) {
        return normalizeSessionRaw(rawSession) || JSON.stringify(sessionJson);
    }
    if (rawSession.startsWith('{')) {
        return rawSession;
    }
    if (token) {
        return JSON.stringify({
            accessToken: token,
            user: null,
            expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
    }
    return rawSession;
}

function validateAccessToken(token) {
    const value = String(token || '').trim();
    if (!value) {
        return { valid: false, message: '缺少 AccessToken' };
    }

    const parts = value.split('.');
    if (parts.length !== 3 || parts.some((item) => !item)) {
        return { valid: false, message: '该 Token 不合法：格式错误' };
    }

    let header;
    let payload;
    try {
        header = decodeJwtPart(parts[0]);
        payload = decodeJwtPart(parts[1]);
    } catch (_) {
        return { valid: false, message: '该 Token 不合法：无法解析' };
    }

    if (header.typ !== 'JWT') {
        return { valid: false, message: '该 Token 不合法：类型错误' };
    }

    if (header.alg !== 'RS256') {
        return { valid: false, message: '该 Token 不合法：算法错误' };
    }

    if (payload.iss !== 'https://auth.openai.com') {
        return { valid: false, message: '该 Token 不合法：签发方错误' };
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
    if (!audiences.includes('https://api.openai.com/v1')) {
        return { valid: false, message: '该 Token 不合法：aud 不匹配' };
    }

    const authInfo = payload['https://api.openai.com/auth'];
    if (!authInfo || !authInfo.chatgpt_account_id || !authInfo.chatgpt_user_id) {
        return { valid: false, message: '该 Token 不合法：缺少账户信息' };
    }

    const scopes = Array.isArray(payload.scp) ? payload.scp : [];
    if (!scopes.includes('model.request')) {
        return { valid: false, message: '该 Token 不合法：缺少 model.request 权限' };
    }

    const exp = Number(payload.exp || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!exp || !Number.isFinite(exp)) {
        return { valid: false, message: '该 Token 不合法：缺少过期时间' };
    }
    if (exp <= now) {
        return { valid: false, message: '该 Token 已过期' };
    }

    return { valid: true };
}

const verifyPassword = adminAuth.verifyPassword;
const issueAdminToken = adminAuth.issueAdminToken;
const verifyAdminToken = adminAuth.verifyAdminToken;
const requireSecondaryAuth = adminAuth.createRequireSecondaryAuth(store, ensureStoreReady);

async function logAdminSecurityEvent(event, meta = {}) {
    try {
        await ensureStoreReady();
        await store.insertAdminLoginLog({
            event,
            adminEmail: meta.email || '',
            ip: meta.ip || '',
            userAgent: meta.userAgent || '',
            fingerprint: meta.fingerprint || '',
            detail: meta.detail || ''
        });
    } catch (error) {
        console.warn(`[AdminAuth] 登录日志写入失败: ${error.message}`);
    }
}

async function fireAdminSecurityNotification(event, payload = {}) {
    notifyAdminSecurityEvent(store, event, payload).catch((error) => {
        console.warn(`[AdminAuth] Telegram 通知失败: ${error.message}`);
    });
}

function getBearerToken(req) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) {
        return token.trim();
    }
    return (req.query?.token || '').trim() || null;
}

async function authenticateAdmin(req, res, next) {
    const token = getBearerToken(req);
    const payload = verifyAdminToken(token);
    if (!payload) {
        return res.status(401).json({ success: false, message: '未授权，请重新登录' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (Number(payload.pv || 0) !== authConfig.passwordVersion) {
            return res.status(401).json({ success: false, message: '登录状态已失效，请重新登录' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    req.admin = payload;
    req.adminToken = token;
    return next();
}

const CDK_PREFIX = 'KC-';
const CDK_RANDOM_LENGTH = 15; // KC- + 15 = 18 位
const CDK_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆 0/O/1/I/L

function randomCdkSuffix(length = CDK_RANDOM_LENGTH) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += CDK_CHARSET[bytes[i] % CDK_CHARSET.length];
    }
    return out;
}

function createCdks(count) {
    const results = new Set();
    const target = Math.max(1, Math.min(Number(count) || 1, 100));

    while (results.size < target) {
        results.add(`${CDK_PREFIX}${randomCdkSuffix()}`);
    }

    return [...results];
}

function extractScreenshotsFromOutput(output) {
    const paths = new Set();
    const text = String(output || '');
    const patterns = [
        /FAILURE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /SUCCESS_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /LIVE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /截图已保存:\s*([^\s\n]+\.png)/g
    ];
    for (const pattern of patterns) {
        let match = pattern.exec(text);
        while (match) {
            paths.add(match[1]);
            match = pattern.exec(text);
        }
    }
    return normalizeMediaPaths([...paths]);
}

function extractVideosFromOutput(output) {
    const paths = new Set();
    const text = String(output || '');
    const pattern = /VIDEO_FILE:\s*([^\s\n]+\.webm)/g;
    let match = pattern.exec(text);
    while (match) {
        paths.add(match[1]);
        match = pattern.exec(text);
    }
    return normalizeMediaPaths([...paths]);
}

function normalizeMediaPaths(paths) {
    return paths.map((filePath) => {
        const normalized = String(filePath).replace(/\\/g, '/');
        const marker = 'debug_screenshots/';
        const idx = normalized.indexOf(marker);
        if (idx >= 0) {
            return normalized.slice(idx + marker.length);
        }
        return path.basename(normalized);
    });
}

function extractTaskMediaFromOutput(output) {
    return {
        screenshots: extractScreenshotsFromOutput(output),
        videos: extractVideosFromOutput(output)
    };
}

function splitTaskMediaPaths(items) {
    const list = Array.isArray(items) ? items : [];
    const screenshots = [];
    const videos = [];
    for (const item of list) {
        const rel = String(item || '').replace(/\\/g, '/');
        if (!rel) continue;
        if (/\.webm$/i.test(rel)) {
            videos.push(rel);
        } else {
            screenshots.push(rel);
        }
    }
    return { screenshots, videos };
}

function extractCheckoutUrlFromOutput(output) {
    const match = String(output || '').match(/CHECKOUT_URL:\s*(https?\S+)/);
    return match ? match[1].trim() : '';
}

function analyzeCheckoutDebugOutput(output, timedOut) {
    const normalized = String(output || '');
    const runtimeError = extractRuntimeErrorMessage(normalized);

    if (normalized.includes('CHECKOUT_DEBUG_SUCCESS')) {
        const checkoutUrl = extractCheckoutUrlFromOutput(normalized);
        return {
            status: 'success',
            message: checkoutUrl ? `支付链接已生成: ${checkoutUrl}` : '支付链接调试成功',
            checkoutUrl,
            reachedPayment: Boolean(checkoutUrl),
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    const base = analyzeProcessOutput(output, timedOut);
    if (base.status === 'retry') {
        return {
            ...base,
            status: 'failed',
            message: String(base.message || runtimeError || '支付链接调试失败').replace('，准备重试', '')
        };
    }
    if (base.status === 'success') {
        return {
            status: 'failed',
            message: runtimeError || '调试流程异常结束（未输出 CHECKOUT_DEBUG_SUCCESS）',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }
    return base;
}

function extractCardLast4FromOutput(output) {
    const text = String(output || '');
    const reserved = text.match(/已预留卡片:\s*\.\.\.(\d{4})/);
    if (reserved) {
        return reserved[1];
    }
    const attempt = text.match(/ATTEMPT \d+ \| CARD (\d{4})/);
    if (attempt) {
        return attempt[1];
    }
    return null;
}

function buildRuntimeFailure(message, code, status = 'failed', extra = {}) {
    return {
        success: false,
        message,
        code,
        status,
        ...extra
    };
}

function extractRuntimeErrorMessage(output) {
    const normalized = String(output || '');
    const match = normalized.match(/❌ \[运行时错误\]:\s*(.+)/);
    if (match) {
        return match[1].trim();
    }
    const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].startsWith('Error:')) {
            return lines[i].replace(/^Error:\s*/, '');
        }
    }
    return '';
}

function analyzeProcessOutput(output, timedOut) {
    const normalized = String(output || '');
    const runtimeError = extractRuntimeErrorMessage(normalized);
    const reachedPayment = normalized.includes('[Stripe] Step')
        || normalized.includes('正在使用 Stripe 信用卡')
        || normalized.includes('Checkout 页面已打开')
        || normalized.includes('chatgpt.com/checkout')
        || normalized.includes('配置套餐')
        || normalized.includes('定价页')
        || normalized.includes('#pricing');
    const success = normalized.includes('PAYMENT_SUCCESS') || normalized.includes('最终校验：支付成功') || normalized.includes('支付成功');

    if (success) {
        return {
            status: 'success',
            message: '激活成功',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('金额校验失败')) {
        return {
            status: 'failed',
            message: '支付金额校验失败，请检查账单地区与币种配置',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('Session 未生效')
        || normalized.includes('Google 登录')
        || normalized.includes('Sign in with Google')) {
        return {
            status: 'failed',
            message: runtimeError || 'Session 未在浏览器中生效，请粘贴完整 Session JSON（从 chatgpt.com/api/auth/session 全选复制）',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('Session 无效')
        || normalized.includes('Session 登录失败')
        || normalized.includes('Session 响应异常')
        || normalized.includes('缺少 AccessToken')) {
        return {
            status: 'failed',
            message: runtimeError || 'Session 无效或已过期，请重新获取完整 Session JSON 后重试',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('无法将定价页切换到目标地区')) {
        return {
            status: 'failed',
            message: runtimeError || '定价页地区切换失败，已尝试 API Checkout；若仍失败请检查后台账单地区',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('未找到') && normalized.includes('升级按钮')) {
        return {
            status: 'failed',
            message: runtimeError || '定价页未找到对应套餐升级按钮，请确认账号可升级',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('等待 Checkout 页面超时')) {
        return {
            status: 'failed',
            message: runtimeError || '点击升级后未跳转到 Checkout 页面',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('无法获取支付链接')
        || normalized.includes('API 创建 Checkout 失败')
        || normalized.includes('createCheckoutSession 失败')
        || normalized.includes('无法打开 Checkout 页面')
        || normalized.includes('订单创建失败')) {
        return {
            status: 'failed',
            message: runtimeError || '无法创建官方 Checkout 订单，请检查账号是否已订阅、账单地区与币种是否匹配',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('该账号无激活权限')
        || normalized.includes('not_eligible')
        || normalized.includes('Offer not found')) {
        return {
            status: 'failed',
            message: '该账号不符合订阅条件（可能已订阅或地区不支持），请更换账号或调整后台账单地区',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('Browser does not support socks5 proxy authentication')
        || normalized.includes('socks5 proxy authentication')) {
        return {
            status: 'failed',
            message: '代理配置错误：Playwright 不支持带账号密码的 SOCKS5，系统已自动中继；若仍失败请检查代理 URL 或改用 HTTP 代理',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理认证失败') || normalized.includes('代理响应异常') || normalized.includes('账号余额')) {
        return {
            status: 'failed',
            message: '系统维护中,请联系管理员修复',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理连接失败') || normalized.includes('代理响应异常')) {
        return {
            status: 'maintenance',
            message: '系统维护中,请联系管理员修复',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('监测到致命拦截文字')
        || normalized.includes('监测到致命拦截')
        || normalized.includes('You have been blocked')) {
        return {
            status: 'retry',
            message: '监测到致命拦截文字，准备重试',
            reachedPayment: true,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('手机号被拒绝或系统拦截')) {
        return {
            status: 'retry',
            message: '手机号不可用，准备重试',
            reachedPayment,
            shouldRetry: true,
            deletePhone: true,
            deleteCard: false
        };
    }

    if (normalized.includes('短信验证码超时')
        || normalized.includes('该手机号无验证码')
        || normalized.includes('手机号短信验证异常')) {
        return {
            status: 'retry',
            message: '短信异常：手机号不可用，已禁用该号，准备重试',
            reachedPayment,
            shouldRetry: true,
            deletePhone: true,
            deleteCard: false
        };
    }

    if (normalized.includes('银行卡被拒绝')
        || normalized.includes('stripe_card_declined')
        || normalized.includes('支付失败 (stripe_redirect_failed)')
        || normalized.includes('支付失败 (stripe_redirect_canceled)')
        || normalized.includes('支付失败 (stripe_card_declined)')) {
        return {
            status: 'manual',
            message: '银行卡被拒绝或 Stripe 驳回，请查看截图后人工处理',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: true
        };
    }

    if (normalized.includes('支付结果检测失败')
        || normalized.includes('支付结果等待超时')) {
        return {
            status: 'manual',
            message: '支付结果未确认，请查看截图后人工处理',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('需要人工验证：触发 Cloudflare')
        || normalized.includes('captcha_challenge_required')) {
        return {
            status: 'manual',
            message: '触发 Cloudflare 人机验证（需勾选验证框），自动化无法可靠通过。请换住宅代理 IP，或 HEADFUL=1 有头模式人工勾选',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('支付失败 (manual_intervention)')
        || normalized.includes('manual_intervention')
        || normalized.includes('需要人工操作')
        || normalized.includes('人机验证')
        || normalized.includes('Cloudflare/人机验证')
        || normalized.includes('captcha_challenge')) {
        return {
            status: 'manual',
            message: runtimeError || '需要人工操作：支付自动化失败，请查看失败截图',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('支付失败 (payment_failed)')
        || normalized.includes('支付失败 (card_pool_exhausted)')) {
        return {
            status: 'manual',
            message: runtimeError || '支付失败，请查看运行日志与截图',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    // 已进入 Stripe/Checkout 支付流程后，任何失败都不再整单重试
    if (reachedPayment && (
        normalized.includes('支付失败')
        || normalized.includes('❌ [支付失败]')
        || normalized.includes('FAILURE_SCREENSHOT')
        || normalized.includes('billing_address_not_filled')
        || normalized.includes('账单地址未完整')
    )) {
        return {
            status: 'manual',
            message: runtimeError || '支付流程失败，请查看失败截图后人工处理',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理或网络持续超时')
        || normalized.includes('浏览器连接被代理多次关闭')) {
        return {
            status: 'retry',
            message: '当前代理超时严重，已切换代理重试',
            reachedPayment: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('OpenAI 鉴权服务异常')
        || normalized.includes('/auth/error?error=undefined')
        || normalized.includes('chatgpt.com/auth/error')) {
        return {
            status: 'retry',
            message: 'OpenAI 鉴权风控 (auth/error)，换代理 IP 重试',
            reachedPayment: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('user_already_exists')
        || normalized.includes('该邮箱已被注册')) {
        return {
            status: 'retry',
            message: '邮箱已被注册，自动换下一个邮箱重试',
            reachedPayment: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('该账号无激活权限,请更换账号重试')) {
        return {
            status: 'failed',
            message: '该账号不符合订阅条件（可能已订阅或地区不支持），请更换账号或调整后台账单地区',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('❌ [运行时错误]') || runtimeError) {
        return {
            status: 'failed',
            message: runtimeError || '自动化执行失败，请查看运行日志',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (!reachedPayment) {
        const deepCheckoutFlow =
            normalized.includes('Stripe')
            || normalized.includes('pay.openai.com')
            || normalized.includes('Checkout')
            || normalized.includes('正在打开 Stripe');
        if (deepCheckoutFlow) {
            return {
                status: 'retry',
                message: '已进入支付流程但未完成，准备重试',
                reachedPayment: false,
                shouldRetry: true,
                deletePhone: false,
                deleteCard: false
            };
        }
        return {
            status: 'failed',
            message: runtimeError || '开通失败，请查看运行日志排查 Session、账单地区或卡池配置',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (timedOut || normalized.includes("运行时错误")) {
        return {
            status: reachedPayment ? 'manual' : 'failed',
            message: reachedPayment
                ? '支付流程超时或中断，请查看失败截图后人工处理'
                : '激活失败',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    return {
        status: reachedPayment ? 'manual' : 'failed',
        message: reachedPayment
            ? (runtimeError || '支付流程未完成，请查看失败截图后人工处理')
            : (runtimeError || '开通失败，请查看运行日志'),
        reachedPayment,
        shouldRetry: false,
        deletePhone: false,
        deleteCard: false
    };
}

function getCheckoutProgress(output, status = 'running') {
    const text = String(output || '');
    const markers = [
        ['正在检查代理连通性', 2],
        ['代理连接成功! 代理公网 IP', 5],
        ['[1] 准备自助充值', 8],
        ['Session 登录成功', 12],
        ['正在通过 API 创建 Checkout', 20],
        ['Checkout 页面已打开', 35],
        ['CHECKOUT_DEBUG_SUCCESS', 100],
        ['CHECKOUT_URL:', 95],
        ['已打开 ChatGPT 定价页', 15],
        ['[Stripe] Step 1', 45],
        ['[Stripe] Step 6', 60],
        ['[Stripe] Step 9', 80],
        ['[Stripe] Step 10', 90],
        ['正在使用 Stripe 信用卡卡池支付流程', 40],
        ['最终校验：支付成功!', 100],
        ['PAYMENT_SUCCESS', 100]
    ];

    let progress = 0;
    for (const [marker, value] of markers) {
        if (text.includes(marker)) {
            progress = Math.max(progress, value);
        }
    }

    if (status === 'success') return 100;
    return Math.min(progress, 99);
}

function normalizeTaskProgress(progress, status = 'running', previous = 0) {
    const numericProgress = Number(progress);
    const safeProgress = Number.isFinite(numericProgress) ? Math.max(0, Math.round(numericProgress)) : 0;
    const cappedProgress = status === 'success' ? Math.min(safeProgress, 100) : Math.min(safeProgress, 99);
    return Math.max(Math.max(0, Number(previous) || 0), cappedProgress);
}

function runCheckoutScript(jobKey, scriptPath, env, attempt = 1, onProgress = null) {
    return new Promise((resolve) => {
        logTask(jobKey, `启动子进程 attempt=${attempt} script=${scriptPath}`);
        const child = spawn('node', [scriptPath], {
            env,
            windowsHide: true
        });

        let output = '';
        let idleTimer = null;
        let finished = false;
        let timedOut = false;

        activeProcesses.add(child);
        const cleanup = () => {
            activeProcesses.delete(child);
            if (idleTimer) clearTimeout(idleTimer);
        };

        const finish = (result) => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            resolve({ attempt, ...result });
        };

        const resetIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(() => {
                timedOut = true;
                output += '\n[TIMEOUT] 超过 3 分钟没有打印，任务终止。\n';
                logTask(jobKey, `attempt=${attempt} 超过 ${PROCESS_IDLE_TIMEOUT_MS / 1000} 秒无输出，终止子进程`, 'warn');
                child.kill();
            }, PROCESS_IDLE_TIMEOUT_MS);
        };

        const appendChunk = (source, chunk) => {
            const text = chunk.toString();
            output += text;
            logTaskChunk(jobKey, attempt, source, text);
            if (onProgress) {
                onProgress(getCheckoutProgress(output), output).catch((error) => console.error('[Progress Update Error]', error));
            }
            resetIdleTimer();
        };

        resetIdleTimer();
        child.stdout.on('data', (chunk) => appendChunk('stdout', chunk));
        child.stderr.on('data', (chunk) => appendChunk('stderr', chunk));
        child.on('error', (error) => {
            output += `\n[SPAWN_ERROR] ${error.message}\n`;
            logTask(jobKey, `attempt=${attempt} 子进程启动失败: ${error.message}`, 'error');
        });
        child.on('close', (code, signal) => {
            cleanup();
            logTask(jobKey, `attempt=${attempt} 子进程退出 code=${code} signal=${signal || 'none'} timedOut=${timedOut}`);
            finish({
                code,
                signal,
                timedOut,
                output,
                analysis: analyzeProcessOutput(output, timedOut)
            });
        });
    });
}

app.get('/admin', (req, res) => {
    res.status(404).type('text/plain').send('Not Found');
});

app.get(['/admin-login', '/admin-login/', '/admin-login.html'], (req, res) => {
    res.status(404).type('text/plain').send('Not Found');
});

app.post('/api/admin/login', async (req, res) => {
    const email = adminAuth.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const clientMeta = adminAuth.getClientMeta(req);

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '请输入管理员邮箱和密码' });
    }

    const rate = adminAuth.checkLoginRateLimit(clientMeta.ip);
    if (!rate.allowed) {
        return res.status(429).json({
            success: false,
            message: `登录尝试过多，请 ${rate.retryAfterSec} 秒后再试`
        });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const emailOk = email === adminAuth.normalizeEmail(authConfig.email);
        const passwordOk = verifyPassword(password, authConfig.passwordHash);

        if (!emailOk || !passwordOk) {
            adminAuth.recordLoginFailure(rate.key, rate.entry);
            await logAdminSecurityEvent('login_failed', {
                ...clientMeta,
                email,
                detail: '邮箱或密码错误'
            });
            fireAdminSecurityNotification('admin_login_failed', {
                email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                message: '邮箱或密码错误'
            });
            return res.status(401).json({ success: false, message: '邮箱或密码错误' });
        }

        adminAuth.clearLoginAttempts(rate.key);

        const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
        if (!adminAuth.is2faRequired(authConfig, telegramSettings)) {
            const { token, payload } = issueAdminToken(authConfig.passwordVersion, authConfig.email);
            await logAdminSecurityEvent('login_success', {
                ...clientMeta,
                email: authConfig.email,
                detail: '密码登录（未启用二次验证）'
            });
            fireAdminSecurityNotification('admin_login_success', {
                email: authConfig.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                method: 'password_only',
                message: '后台登录成功（尚未启用 2FA）'
            });
            return res.json(await attachAdminPaths({
                success: true,
                token,
                expiresAt: payload.exp,
                issuedAt: payload.iat,
                permissions: payload.permissions,
                email: authConfig.email,
                requires2fa: false,
                setupRequired: true
            }));
        }

        const challenge = adminAuth.issueLoginChallenge({
            email: authConfig.email,
            passwordVersion: authConfig.passwordVersion,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint
        });

        return res.json({
            success: true,
            requires2fa: true,
            challengeToken: challenge.token,
            methods,
            defaultMethod: adminAuth.pickDefaultLogin2faMethod(methods, authConfig.login2faMode === 'either' ? '' : authConfig.login2faMode),
            login2faMode: authConfig.login2faMode,
            email: authConfig.email,
            expiresAt: challenge.payload.exp
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/login/send-tg-code', async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || '').trim();
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);
    if (!challenge) {
        return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
    }

    try {
        await ensureStoreReady();
        const code = adminAuth.generateTelegramLoginCode();
        adminAuth.storeTelegramLoginCode(challenge.cid, code);
        const clientMeta = adminAuth.getClientMeta(req);
        const sendResult = await sendTelegramLoginCode(store, code, {
            email: challenge.email,
            ip: clientMeta.ip || challenge.ip
        });
        if (!sendResult.ok) {
            return res.status(400).json({ success: false, message: sendResult.error || 'Telegram 验证码发送失败' });
        }
        return res.json({ success: true, message: '验证码已发送到管理员 Telegram' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/login/verify-2fa', async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || '').trim();
    const method = String(req.body?.method || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const clientMeta = adminAuth.getClientMeta(req);
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);

    if (!challenge) {
        return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
    }

    if (!code) {
        return res.status(400).json({ success: false, message: '请输入验证码' });
    }

    const rate = adminAuth.checkLoginRateLimit(`${clientMeta.ip}:2fa`);
    if (!rate.allowed) {
        return res.status(429).json({
            success: false,
            message: `验证尝试过多，请 ${rate.retryAfterSec} 秒后再试`
        });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
        if (!methods.includes(method)) {
            return res.status(400).json({ success: false, message: '不支持的验证方式' });
        }

        let verified = false;
        if (method === 'totp') {
            verified = adminAuth.verifyTotpCode(authConfig.totpSecret, code);
        } else if (method === 'telegram') {
            const tgResult = adminAuth.verifyTelegramLoginCode(challenge.cid, code);
            verified = tgResult.ok;
            if (!verified) {
                adminAuth.recordLoginFailure(rate.key, rate.entry);
                await logAdminSecurityEvent('2fa_failed', {
                    ...clientMeta,
                    email: challenge.email,
                    detail: `Telegram 验证码错误 (${tgResult.reason || 'invalid'})`
                });
                fireAdminSecurityNotification('admin_2fa_failed', {
                    email: challenge.email,
                    ip: clientMeta.ip,
                    fingerprint: clientMeta.fingerprint,
                    userAgent: clientMeta.userAgent,
                    method: 'telegram',
                    message: 'Telegram 验证码错误'
                });
                const message = tgResult.reason === 'expired'
                    ? '验证码已过期，请重新获取'
                    : 'Telegram 验证码错误';
                return res.status(401).json({ success: false, message });
            }
        }

        if (!verified) {
            adminAuth.recordLoginFailure(rate.key, rate.entry);
            await logAdminSecurityEvent('2fa_failed', {
                ...clientMeta,
                email: challenge.email,
                detail: `${method} 验证码错误`
            });
            fireAdminSecurityNotification('admin_2fa_failed', {
                email: challenge.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                method,
                message: '二次验证失败'
            });
            return res.status(401).json({ success: false, message: '验证码错误' });
        }

        adminAuth.clearLoginAttempts(rate.key);
        const { token, payload } = issueAdminToken(authConfig.passwordVersion, authConfig.email);
        await logAdminSecurityEvent('login_success', {
            ...clientMeta,
            email: authConfig.email,
            detail: `二次验证成功 (${method})`
        });
        fireAdminSecurityNotification('admin_login_success', {
            email: authConfig.email,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint,
            userAgent: clientMeta.userAgent,
            method,
            message: '后台登录成功'
        });

        return res.json(await attachAdminPaths({
            success: true,
            token,
            expiresAt: payload.exp,
            issuedAt: payload.iat,
            permissions: payload.permissions,
            email: authConfig.email
        }));
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

/** 运行日志：必须挂在 app.use('/api/admin', authenticateAdmin) 之前，并为每条路由单独鉴权，否则部分环境下会 404 */
app.get('/api/admin/runtime-logs', authenticateAdmin, (req, res) => {
    try {
        const wantTail = String(req.query.tail || '') === '1' || String(req.query.tail || '') === 'true';
        const after = Math.max(0, parseInt(String(req.query.after || '0'), 10) || 0);
        let limit = parseInt(String(req.query.limit || '500'), 10) || 500;
        limit = Math.min(2000, Math.max(1, limit));

        const entries = wantTail ? runtimeLog.tail(limit) : runtimeLog.after(after, limit);
        const nextAfter = entries.length ? entries[entries.length - 1].id : after;
        res.json({ success: true, entries, nextAfter });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/runtime-logs/clear', authenticateAdmin, (req, res) => {
    try {
        runtimeLog.clear();
        runtimeLog.push({ jobKey: '', level: 'system', source: 'server', text: '🧹 运行日志已手动清空' });
        res.json({ success: true, message: '运行日志已清空' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


/** 代理批量测试：支持临时 URL 或已保存代理 ID；检测后可选写回 proxy_assets。 */
app.post('/api/admin/proxy/test', authenticateAdmin, async (req, res) => {
    try {
        await ensureStoreReady();
        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map((id) => Number(id)).filter((id) => id > 0)
            : [];
        const rawProxies = normalizeProxyLines(req.body?.proxies || []);
        const persist = req.body?.persist !== false;

        let targets = [];
        if (ids.length) {
            const saved = await store.listProxyAssets();
            const map = new Map(saved.map((item) => [item.id, item]));
            targets = ids.map((id) => {
                const row = map.get(id);
                return row ? { id, proxy_url: row.proxy_url } : null;
            }).filter(Boolean);
        } else {
            targets = rawProxies.map((proxy_url) => ({ id: null, proxy_url }));
        }

        if (!targets.length) {
            return res.status(400).json({ success: false, message: '未提供代理 URL 或 ID' });
        }
        if (targets.length > 50) {
            return res.status(400).json({ success: false, message: '一次最多测试 50 条代理' });
        }

        const results = await Promise.all(targets.map(async (target) => {
            const result = await testProxyUrl(target.proxy_url);
            if (persist && target.id) {
                await store.updateProxyAssetCheck(target.id, result);
            }
            return {
                id: target.id,
                proxy_url: target.proxy_url,
                ...result
            };
        }));

        return res.json({ success: true, results });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});


// ─── External Card Pool Webhook (X-API-Key auth) ────────────────────────────
app.post('/api/external/cards/push', async (req, res) => {
    try {
        await ensureStoreReady();
        const apiKey = String(req.headers['x-api-key'] || '').trim();
        if (!apiKey) {
            return res.status(401).json({ success: false, error: 'API Key 无效或缺失' });
        }
        const expectedKey = await store.getAppConfigValue('external_card_api_key', '');
        if (!expectedKey || apiKey !== expectedKey) {
            return res.status(401).json({ success: false, error: 'API Key 无效或缺失' });
        }

        const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
        if (cards.length === 0) {
            return res.status(400).json({ success: false, error: '缺少 cards 数组或为空' });
        }
        if (cards.length > 500) {
            return res.status(400).json({ success: false, error: '单次导入上限 500 条' });
        }

        const result = await store.importCards(cards);
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.message === '单次导入上限 500 条') {
            return res.status(400).json({ success: false, error: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

/** 公开 API：必须挂在 app.use('/api/admin', authenticateAdmin) 之前，否则部分环境下会 404 */
app.get('/api/public/admin-paths', async (req, res) => {
    try {
        await ensureStoreReady();
        const paths = await store.getAdminPaths();
        return res.json({
            success: true,
            loginPath: paths.loginPath,
            panelPath: paths.panelPath,
            loginUrl: buildAdminLoginUrl(paths),
            panelUrl: buildAdminPanelUrl(paths)
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/public/subscription/check', async (req, res) => {
    try {
        const rawSession = String(req.body?.session || req.body?.token || '').trim().replace(/^\uFEFF/, '');
        if (!rawSession) {
            return res.status(400).json({ success: false, message: '请粘贴 Session JSON 或 AccessToken' });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await querySubscriptionBySession(token, {
            timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                ? timezoneOffsetMin
                : -new Date().getTimezoneOffset(),
            email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
        });

        if (!result.ok) {
            return res.status(result.statusCode || 502).json({
                success: false,
                message: result.error || '查询订阅失败'
            });
        }

        return res.json({ success: true, data: result.data });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.use('/api/public/business', createBusinessStorefrontRouter(createRequireStorefrontUser()));
app.use('/api/admin/business', createBusinessAdminRouter(authenticateAdmin));
app.use('/api/admin', authenticateAdmin);

app.get('/subscription', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'subscription.html'));
});

app.get('/api/public/payment-region', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = await store.getPaymentRegion();
        const config = REGION_CONFIG[regionCode] || REGION_CONFIG.PH;
        return res.json({
            success: true,
            region: regionCode,
            currency: config.currency,
            label: config.label
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/public/runtime', async (req, res) => {
    try {
        await ensureStoreReady();
        const maxConcurrentActivations = await store.getMaxConcurrentActivations();
        return res.json({
            success: true,
            runtime: {
                active_foreground_jobs: activeForegroundJobs.size,
                max_foreground_jobs: Math.max(1, Number(maxConcurrentActivations || 1))
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ===== v1.31 站点配置（品牌/定价/文案）=====
const SITE_CONFIG_DEFAULT = {
    brand: { name: 'KC 直供', badge: 'KC', sub: 'GPT 代充 · 批发价', slogan: '一个人也算批发' },
    packs: [
        { key: 'light', name: '轻享包', fee: 15, times: 5, tagline: '给还没验证市场的你' },
        { key: 'pro', name: '畅享包', fee: 99, times: 50, tagline: '给已经稳定出货的你' }
    ],
    building: { name: '建站支持套餐', fee: 399, unit: '月' },
    plans: [],
    copy: {
        marketLabel: '市场行情',
        thresholdTitle: '拿这个价，不用先押几千美元',
        oldSideTitle: '行业常见做法',
        newSideTitle: '我们',
        thresholdNote: '「行业常见做法」指传统批发型发卡平台的普遍门槛，仅供参考。'
    }
};

function cloneJson(x) { return JSON.parse(JSON.stringify(x)); }

async function readSiteConfig() {
    const base = cloneJson(SITE_CONFIG_DEFAULT);
    try {
        const raw = await store.getAppConfigValue('site_config', '');
        if (!raw) return base;
        const saved = JSON.parse(raw);
        return {
            brand: Object.assign(base.brand, saved.brand || {}),
            packs: (Array.isArray(saved.packs) && saved.packs.length) ? saved.packs : base.packs,
            building: Object.assign(base.building, saved.building || {}),
            plans: Array.isArray(saved.plans) ? saved.plans : base.plans,
            copy: Object.assign(base.copy, saved.copy || {})
        };
    } catch (e) {
        return base;
    }
}

app.get('/api/public/site-config', async (req, res) => {
    // 前台商城与 KC 不同源（端口/域名不同），公开配置允许跨域读取
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    try {
        await ensureStoreReady();
        return res.json({ success: true, config: await readSiteConfig() });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/site-config', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        return res.json({ success: true, config: await readSiteConfig() });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/site-config', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const cur = await readSiteConfig();
        const next = {
            brand: Object.assign({}, cur.brand, body.brand || {}),
            packs: (Array.isArray(body.packs) && body.packs.length) ? body.packs : cur.packs,
            building: Object.assign({}, cur.building, body.building || {}),
            plans: Array.isArray(body.plans) ? body.plans : cur.plans,
            copy: Object.assign({}, cur.copy, body.copy || {})
        };
        await store.setAppConfigValue('site_config', JSON.stringify(next));

        let siteNameSynced = false;
        const brandName = String((next.brand && next.brand.name) || '').trim();
        if (brandName) {
            try {
                await store.runQuery(
                    "UPDATE `xboard`.`v2_settings` SET value = ?, updated_at = NOW() WHERE name = 'app_name'",
                    [brandName]
                );
                siteNameSynced = true;
            } catch (e) {
                siteNameSynced = false;
            }
        }
        return res.json({
            success: true,
            message: siteNameSynced
                ? '站点配置已保存。若前台浏览器标题未变，请执行一次 Xboard 缓存清理（optimize:clear）。'
                : '站点配置已保存（站点名跨库同步失败，请检查 KC 对 xboard 库的写权限）。',
            site_name_synced: siteNameSynced,
            config: next
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/session', (req, res) => {
    const age = Date.now() - Number(req.admin.iat || 0);
    const shouldRefresh = age >= ADMIN_REFRESH_AFTER_MS;
    let refreshedToken = null;
    let payload = req.admin;

    if (shouldRefresh) {
        const refreshed = issueAdminToken(req.admin.pv, req.admin.email);
        refreshedToken = refreshed.token;
        payload = refreshed.payload;
    }

    return res.json({
        success: true,
        refreshed: shouldRefresh,
        token: refreshedToken,
        expiresAt: payload.exp,
        issuedAt: payload.iat,
        permissions: payload.permissions,
        email: payload.email || ''
    });
});

app.get('/api/admin/security/status', async (req, res) => {
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const paths = await store.getAdminPaths();
        res.json({
            success: true,
            email: authConfig.email,
            totpEnabled: authConfig.totpEnabled,
            login2faMode: authConfig.login2faMode,
            availableMethods: adminAuth.getAvailable2faMethods(authConfig, telegramSettings),
            methods: adminAuth.resolveLogin2faMethods(authConfig, telegramSettings),
            notifyAdminLogin: authConfig.notifyAdminLogin,
            loginPath: paths.loginPath,
            panelPath: paths.panelPath,
            loginUrl: buildAdminLoginUrl(paths),
            panelUrl: buildAdminPanelUrl(paths)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/login-logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Number(req.query.limit) || 100;
        const offset = Number(req.query.offset) || 0;
        res.json({ success: true, ...(await store.listAdminLoginLogs(limit, offset)) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/secondary/session', (req, res) => {
    const token = String(req.headers['x-admin-secondary-token'] || '').trim();
    const payload = adminAuth.verifySecondaryToken(token);
    if (!payload) {
        return res.json({ success: true, verified: false });
    }
    return res.json({
        success: true,
        verified: true,
        expiresAt: payload.exp
    });
});

app.post('/api/admin/verify-secondary', async (req, res) => {
    const password = String(req.body?.password || '');
    const clientMeta = adminAuth.getClientMeta(req);
    if (!password) {
        return res.status(400).json({ success: false, message: '请输入二级密码' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(password, authConfig.secondaryPasswordHash)) {
            await logAdminSecurityEvent('secondary_failed', {
                ...clientMeta,
                email: req.admin?.email || authConfig.email,
                detail: '二级密码错误'
            });
            return res.status(401).json({ success: false, message: '二级密码错误' });
        }

        const { token, payload } = adminAuth.issueSecondaryToken(
            authConfig.secondaryPasswordVersion,
            clientMeta.ip
        );
        await logAdminSecurityEvent('secondary_success', {
            ...clientMeta,
            email: req.admin?.email || authConfig.email,
            detail: '敏感模块解锁'
        });
        fireAdminSecurityNotification('admin_secondary_success', {
            email: req.admin?.email || authConfig.email,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint,
            userAgent: clientMeta.userAgent,
            message: '银行卡池/CDK/Session 模块已解锁'
        });
        return res.json({
            success: true,
            secondaryToken: token,
            expiresAt: payload.exp
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/security/2fa-mode', async (req, res) => {
    const mode = String(req.body?.mode || '').trim().toLowerCase();
    try {
        await ensureStoreReady();
        const saved = await store.saveAdmin2faLoginMode(mode);
        res.json({ success: true, login2faMode: saved, message: '登录验证方式已保存' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/security/paths', async (req, res) => {
    try {
        await ensureStoreReady();
        const saved = await store.saveAdminPaths({
            loginPath: req.body?.loginPath,
            panelPath: req.body?.panelPath
        });
        invalidateAdminPathsCache();
        cachedAdminPaths = saved;
        return res.json({
            success: true,
            loginPath: saved.loginPath,
            panelPath: saved.panelPath,
            loginUrl: buildAdminLoginUrl(saved),
            panelUrl: buildAdminPanelUrl(saved),
            message: '入口路径已更新，请使用新地址访问并收藏'
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/2fa/setup', async (req, res) => {
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        let secret = String(authConfig.totpSecret || '').trim();
        if (!secret || authConfig.totpEnabled) {
            secret = adminAuth.generateTotpSecret();
            await store.saveAdminTotpConfig({ secret, enabled: false });
        }
        const otpauthUrl = adminAuth.getTotpUri(authConfig.email, secret);
        res.json({
            success: true,
            secret,
            otpauthUrl,
            qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(otpauthUrl)}`,
            message: '请使用 Google Authenticator 扫码后输入验证码确认启用'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/2fa/confirm', async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) {
        return res.status(400).json({ success: false, message: '请输入 Authenticator 验证码' });
    }
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!authConfig.totpSecret) {
            return res.status(400).json({ success: false, message: '请先发起 2FA 绑定' });
        }
        if (!adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
            return res.status(400).json({ success: false, message: '验证码错误，请重试' });
        }
        await store.saveAdminTotpConfig({ secret: authConfig.totpSecret, enabled: true });
        res.json({ success: true, message: 'Google Authenticator 已启用' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/2fa/disable', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const code = String(req.body?.code || '').trim();
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '登录密码错误' });
        }
        if (authConfig.totpEnabled && !adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
            return res.status(400).json({ success: false, message: 'Authenticator 验证码错误' });
        }
        await store.saveAdminTotpConfig({ secret: '', enabled: false });
        res.json({ success: true, message: 'Google Authenticator 已关闭' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/change-secondary-password', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '').trim();
    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入当前二级密码' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '新二级密码至少 6 位' });
    }
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.secondaryPasswordHash)) {
            return res.status(400).json({ success: false, message: '当前二级密码错误' });
        }
        await store.updateAdminSecondaryPassword(newPassword);
        res.json({ success: true, message: '二级密码已更新，敏感模块需重新验证' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/task-logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        const tasks = await store.listAdminTaskLogs(limit);
        res.json({ success: true, tasks });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        await ensureStoreReady();
        const data = await store.getAdminData();
        const system = await getSystemMetrics();
        data.runtime = {
            active_activation_jobs: getTotalActiveJobs(),
            active_foreground_jobs: activeForegroundJobs.size,
            system,
            browser_pool: browserPool.getStats()
        };
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/browser-pool', async (req, res) => {
    try {
        await ensureStoreReady();
        const modeEnabled = await store.getBrowserPoolEnabled();
        const system = await getSystemMetrics();
        const memText = String(system?.memory?.text || '');
        const memMatch = memText.match(/([\d.]+)G\/([\d.]+)G/);
        const hostMemory = memMatch
            ? { usedGb: Number(memMatch[1]), totalGb: Number(memMatch[2]) }
            : null;
        const pool = await browserPool.getDetailedStats(hostMemory);
        res.json({
            success: true,
            pool,
            mode: {
                enabled: modeEnabled,
                runtime: browserPool.getRuntimeEnabled(),
                workerMode: modeEnabled ? 'pool' : 'standalone'
            },
            system,
            foreground: {
                activeJobs: getTotalActiveJobs(),
                activeForegroundJobs: activeForegroundJobs.size
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/browser-pool/mode', async (req, res) => {
    try {
        await ensureStoreReady();
        const enabled = req.body?.enabled === true
            || req.body?.enabled === 1
            || String(req.body?.enabled || '').trim() === '1';
        await store.setBrowserPoolEnabled(enabled);
        const info = await syncBrowserPoolModeFromStore();
        res.json({
            success: true,
            message: enabled
                ? `已切换为浏览器池模式（${info.size || 0} 个槽位）`
                : '已切换为独立浏览器模式（每任务冷启动 Chromium）',
            mode: {
                enabled,
                runtime: browserPool.getRuntimeEnabled(),
                workerMode: enabled ? 'pool' : 'standalone'
            },
            pool: browserPool.getStats()
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/browser-pool/reload', async (req, res) => {
    try {
        await ensureStoreReady();
        const requestedSize = req.body?.size;
        if (requestedSize != null) {
            browserPool.setRuntimePoolSize(requestedSize);
        }
        const result = await browserPool.reloadBrowserPool(requestedSize);
        res.json({
            success: true,
            message: `浏览器池已重载，当前 ${result.size} 个槽位`,
            pool: browserPool.getStats()
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/sessions', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        res.json(await store.listSessions({ limit }));
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/sessions/:jobKey', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const session = await store.getSessionByJobKey(req.params.jobKey);
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session 记录不存在' });
        }
        res.json({ success: true, session });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/subscription/cancel-auto-renew', async (req, res) => {
    try {
        const rawSession = String(req.body?.session || req.body?.token || '').trim().replace(/^\uFEFF/, '');
        if (!rawSession) {
            return res.status(400).json({ success: false, message: '请粘贴 Session JSON 或 AccessToken' });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await cancelAutoRenew(token, {
            timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                ? timezoneOffsetMin
                : -new Date().getTimezoneOffset(),
            email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
        });

        if (!result.ok) {
            return res.status(result.statusCode || 502).json({
                success: false,
                message: result.error || '取消自动续费失败'
            });
        }

        return res.json({ success: true, data: result.data });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/subscription/enable-auto-renew', async (req, res) => {
    try {
        const rawSession = String(req.body?.session || req.body?.token || '').trim().replace(/^\uFEFF/, '');
        if (!rawSession) {
            return res.status(400).json({ success: false, message: '请粘贴 Session JSON 或 AccessToken' });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await resumeAutoRenew(token, {
            timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                ? timezoneOffsetMin
                : -new Date().getTimezoneOffset(),
            email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
        });

        if (!result.ok) {
            return res.status(result.statusCode || 502).json({
                success: false,
                message: result.error || '开启自动续费失败'
            });
        }

        return res.json({ success: true, data: result.data });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/subscription/batch-renewal-status', async (req, res) => {
    try {
        await ensureStoreReady();
        const jobKeys = Array.isArray(req.body?.job_keys)
            ? req.body.job_keys.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50)
            : [];
        if (!jobKeys.length) {
            return res.json({ success: true, data: {} });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const offset = Number.isFinite(timezoneOffsetMin)
            ? timezoneOffsetMin
            : -new Date().getTimezoneOffset();
        const concurrency = 3;
        const results = {};
        let cursor = 0;

        async function queryJobRenewalStatus(jobKey) {
            const session = await store.getSessionByJobKey(jobKey);
            if (!session?.session_payload) {
                results[jobKey] = { ok: false, error: '无完整 Session' };
                return;
            }

            const rawSession = String(session.session_payload || '').trim();
            const token = normalizeSessionToken(rawSession);
            const tokenCheck = validateSessionTokenForQuery(token);
            if (!tokenCheck.valid) {
                results[jobKey] = { ok: false, error: tokenCheck.message };
                return;
            }

            const queryResult = await querySubscriptionBySession(token, {
                timezoneOffsetMin: offset,
                email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
            });
            if (!queryResult.ok) {
                results[jobKey] = { ok: false, error: queryResult.error || '查询失败' };
                return;
            }

            const data = queryResult.data || {};
            results[jobKey] = {
                ok: true,
                email: data.email || '',
                autoRenew: data.autoRenew || '—',
                autoRenewRaw: data.autoRenewRaw,
                hasActiveSubscription: Boolean(data.hasActiveSubscription),
                subscriptionChannel: data.subscriptionChannel || ''
            };
        }

        async function worker() {
            while (cursor < jobKeys.length) {
                const index = cursor;
                cursor += 1;
                await queryJobRenewalStatus(jobKeys[index]);
            }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, jobKeys.length) }, () => worker()));
        return res.json({ success: true, data: results });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/screenshots', async (req, res) => {
    try {
        const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel || rel.includes('..') || !rel.endsWith('.png')) {
            return res.status(400).json({ success: false, message: '无效的截图路径' });
        }
        const root = path.join(__dirname, 'debug_screenshots');
        let fullPath = path.join(root, rel);
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            if (rel.startsWith('激活/')) {
                const altPath = path.join(root, 'activation', rel.slice('激活/'.length));
                if (altPath.startsWith(root) && fs.existsSync(altPath)) {
                    fullPath = altPath;
                }
            }
        }
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: '截图不存在' });
        }
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(fullPath);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/video', async (req, res) => {
    try {
        const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel || rel.includes('..') || !rel.endsWith('.webm')) {
            return res.status(400).json({ success: false, message: '无效的录像路径' });
        }
        const root = path.join(__dirname, 'debug_screenshots');
        const fullPath = path.join(root, rel);
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: '录像不存在' });
        }
        res.setHeader('Content-Type', 'video/webm');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(fullPath);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/screenshots/:subdir/:filename', async (req, res) => {
    try {
        const subdir = path.basename(String(req.params.subdir || ''));
        const filename = path.basename(String(req.params.filename || ''));
        if (!subdir || !filename || !filename.endsWith('.png')) {
            return res.status(400).json({ success: false, message: '无效的截图路径' });
        }
        const fullPath = path.join(__dirname, 'debug_screenshots', subdir, filename);
        const root = path.join(__dirname, 'debug_screenshots');
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: '截图不存在' });
        }
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(fullPath);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/task-logs/:jobKey', async (req, res) => {
    try {
        await ensureStoreReady();
        const jobKey = decodeURIComponent(String(req.params.jobKey || '').trim());
        if (!jobKey) {
            return res.status(400).json({ success: false, message: '缺少任务标识' });
        }
        const { deleted, mediaDeleted } = await store.deleteTaskLogByJobKey(jobKey);
        if (!deleted) {
            return res.status(404).json({ success: false, message: '未找到该任务记录' });
        }
        return res.json({
            success: true,
            message: mediaDeleted > 0
                ? `任务记录已删除，并清理 ${mediaDeleted} 个截图/录像文件`
                : '任务记录已删除'
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

function fireTelegramNotification(event, payload) {
    notifyTelegramEvent(store, event, payload).catch((error) => {
        console.error(`[Telegram] ${event} 通知失败:`, error.message);
    });
}

function notifyTaskOutcome({ event, email, cdk, jobKey, message }) {
    fireTelegramNotification(event, { email, cdk, jobKey, message });
}

app.post('/api/admin/telegram', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveTelegramConfig({
            bot_token: body.bot_token,
            admin_chat_id: body.admin_chat_id,
            group_chat_id: body.group_chat_id,
            notify_admin: Boolean(body.notify_admin),
            notify_group: Boolean(body.notify_group),
            on_success: Boolean(body.on_success),
            on_failure: Boolean(body.on_failure),
            on_card_pool_empty: Boolean(body.on_card_pool_empty)
        });
        res.json({ success: true, message: 'Telegram 通知配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/telegram/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await sendTelegramTest(store, req.body || {});
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: result.message });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveHcaptchaConfig({
            enabled: Boolean(body.enabled),
            vlm_api_key: body.vlm_api_key,
            vlm_base_url: body.vlm_base_url,
            vlm_model: body.vlm_model,
            vlm_timeout: body.vlm_timeout,
            solver_timeout: body.solver_timeout,
            no_vlm: Boolean(body.no_vlm),
            cdp_port: body.cdp_port,
            captcha_platform_api_key: body.captcha_platform_api_key,
            captcha_platform_api_url: body.captcha_platform_api_url,
            captcha_platform_timeout: body.captcha_platform_timeout
        });
        res.json({ success: true, message: 'hCaptcha 求解器配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getHcaptchaConfig();
        const { env } = buildHcaptchaEnvFromConfig(cfg);
        const prevEnv = {};
        for (const [key, value] of Object.entries(env)) {
            prevEnv[key] = process.env[key];
            process.env[key] = value;
        }
        try {
            const status = await checkHcaptchaSolverHealth(cfg);
            if (!status.ready) {
                return res.status(400).json({ success: false, message: status.message, status });
            }
            res.json({ success: true, message: status.message, status });
        } finally {
            for (const [key, value] of Object.entries(prevEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha/test-vlm', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const cfg = await store.getHcaptchaConfig();
        const merged = {
            ...cfg,
            vlm_api_key: String(body.vlm_api_key || '').trim() || cfg.vlm_api_key,
            vlm_base_url: String(body.vlm_base_url || '').trim() || cfg.vlm_base_url,
            vlm_model: String(body.vlm_model || '').trim() || cfg.vlm_model,
            vlm_timeout: body.vlm_timeout ?? cfg.vlm_timeout
        };
        const result = await testVlmConnectivity(merged);
        if (!result.ok) {
            return res.status(400).json({ success: false, ...result });
        }
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha/test-captcha-platform', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const cfg = await store.getHcaptchaConfig();
        const merged = {
            captcha_platform_api_key: String(body.captcha_platform_api_key || '').trim() || cfg.captcha_platform_api_key,
            captcha_platform_api_url: String(body.captcha_platform_api_url || '').trim() || cfg.captcha_platform_api_url,
            captcha_platform_timeout: body.captcha_platform_timeout ?? cfg.captcha_platform_timeout
        };
        const resolved = resolveCaptchaPlatformCredentials(
            merged.captcha_platform_api_key,
            merged.captcha_platform_api_url
        );
        merged.captcha_platform_api_url = resolved.apiUrl;
        if (resolved.apiKey) {
            await store.saveHcaptchaConfig({
                ...cfg,
                captcha_platform_api_key: resolved.apiKey,
                captcha_platform_api_url: resolved.apiUrl,
                captcha_platform_timeout: merged.captcha_platform_timeout
            });
        }
        const result = await testCaptchaPlatformConnectivity({
            apiKey: merged.captcha_platform_api_key,
            apiUrl: merged.captcha_platform_api_url,
            timeoutSec: merged.captcha_platform_timeout
        });
        if (!result.ok) {
            return res.status(400).json({ success: false, ...result });
        }
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/hcaptcha/logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
        const listing = listSolverLogFiles(limit);
        const file = String(req.query.file || '').trim();
        if (file) {
            const safeName = path.basename(file);
            const target = listing.files.find((item) => item.name === safeName);
            if (!target) {
                return res.status(404).json({ success: false, message: '日志文件不存在' });
            }
            const lines = readSolverLogTail(target.path, 120);
            return res.json({ success: true, file: safeName, lines, ...listing });
        }
        const captchaRuntime = runtimeLog.tail(200).filter((e) => e.source === 'captcha' || e.level === 'captcha');
        res.json({ success: true, runtime: captchaRuntime.slice(-80), ...listing });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── 第三方 GPT 代充 API 配置 ──────────────────────────────────────────────

app.get('/api/admin/gpt-api', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getGptApiConfig();
        const masked = gptApi.maskApiKey(cfg.api_key);
        res.json({
            success: true,
            config: {
                enabled: cfg.enabled,
                base_url: cfg.base_url,
                api_key_saved: Boolean(cfg.api_key),
                api_key_preview: masked,
                plan_key: cfg.plan_key,
                country: cfg.country,
                currency: cfg.currency,
                mock: cfg.mock
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/gpt-api', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveGptApiConfig({
            enabled: Boolean(body.enabled),
            mock: Boolean(body.mock),
            base_url: body.base_url,
            api_key: body.api_key,
            plan_key: body.plan_key,
            country: body.country,
            currency: body.currency
        });
        res.json({ success: true, message: '第三方代充 API 配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/gpt-api/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const saved = await store.getGptApiConfig();
        const merged = {
            base_url: String(body.base_url || '').trim() || saved.base_url,
            api_key: String(body.api_key || '').trim() || saved.api_key
        };
        const result = await gptApi.testConnection(merged);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.error || '连接失败' });
        }
        res.json({ success: true, message: result.message, plans: result.plans, balance: result.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/gpt-api/status', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getGptApiConfig();
        if (!cfg.api_key) {
            return res.status(400).json({ success: false, message: '尚未配置第三方代充 API Key' });
        }
        const [plansResult, balanceResult, recentOrders] = await Promise.all([
            gptApi.fetchPlans(cfg),
            gptApi.queryBalance(cfg),
            store.listRecentGptApiOrders(10)
        ]);
        if (!plansResult.success) {
            return res.status(400).json({ success: false, message: `套餐查询失败: ${plansResult.error || '未知错误'}` });
        }
        const orders = recentOrders.map((order) => ({
            job_key: order.job_key,
            cdk_code: order.cdk_code,
            status: order.status,
            message: order.message,
            updated_at: order.updated_at,
            order_id: order.gpt_api_order_id,
            task_id: order.gpt_api_task_id,
            topup_code: order.gpt_api_topup_code || null
        }));
        res.json({
            success: true,
            gpt_plans: plansResult.gptPlans,
            credit_plans: plansResult.creditPlans,
            balance: balanceResult.success ? balanceResult.data : null,
            balance_error: balanceResult.success ? null : balanceResult.error,
            recent_orders: orders
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/config', async (req, res) => {
    try {
        await ensureStoreReady();
        const nextConfig = { ...(req.body || {}) };
        if (nextConfig.maintenance_mode) {
            nextConfig.maintenance_mode_drain = getTotalActiveJobs() > 0;
        } else {
            nextConfig.maintenance_mode_drain = false;
        }
        await store.saveConfig(nextConfig);
        res.json({ success: true, message: '所有资产配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Region Selector API ────────────────────────────────────────────────────

app.get('/api/admin/region', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = await store.getPaymentRegion();
        const config = REGION_CONFIG[regionCode];
        res.json({
            success: true,
            region: regionCode,
            currency: config.currency,
            label: config.label,
            supported: REGION_CONFIG
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/region', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = String(req.body?.region || '').toUpperCase();
        if (!isSupportedRegion(regionCode)) {
            return res.status(400).json({ success: false, error: '不支持的地区代码' });
        }
        const result = await store.setPaymentRegion(regionCode);
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }
        const config = REGION_CONFIG[regionCode];
        res.json({
            success: true,
            region: regionCode,
            currency: config.currency,
            label: config.label
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Checkout Link Debug API ────────────────────────────────────────────────

app.get('/api/admin/checkout/plans', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = await store.getPaymentRegion();
        const config = REGION_CONFIG[regionCode] || REGION_CONFIG.PH;
        res.json({
            success: true,
            plans: store.PLAN_NAME_MAP,
            resolved: {
                plus: store.resolvePlanName('plus'),
                pro_5x: store.resolvePlanName('pro_5x'),
                pro_20x: store.resolvePlanName('pro_20x')
            },
            region: regionCode,
            currency: config.currency,
            label: config.label
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/checkout/generate', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const rawSession = String(body.session || '').trim();
        if (!rawSession) {
            return res.status(400).json({ success: false, error: '请提供 Session JSON' });
        }

        const sessionJson = parseSessionJson(rawSession);
        const token = normalizeSessionToken(rawSession);
        if (!token) {
            return res.status(400).json({ success: false, error: 'Session 无效，无法提取 accessToken' });
        }
        const tokenCheck = validateAccessToken(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, error: tokenCheck.message });
        }

        const planType = String(body.plan_type || 'plus').trim();
        const planNameOverride = body.plan_name ? String(body.plan_name).trim() : '';
        const resolvedPlanName = planNameOverride || store.resolvePlanName(planType);
        const regionCode = String(body.country || body.region || await store.getPaymentRegion()).toUpperCase();
        if (!isSupportedRegion(regionCode)) {
            return res.status(400).json({ success: false, error: `不支持的地区: ${regionCode}` });
        }

        const storedSession = buildStoredSessionPayload(rawSession, sessionJson, token);
        const email = extractEmailFromSession(sessionJson);
        const task = await store.createTaskLog({
            tokenPreview: extractSessionPreview(storedSession),
            sessionPayload: storedSession,
            cdkCode: '[checkout-debug]',
            phone: null,
            cardLast4: null,
            status: 'running',
            progress: 5
        });

        await store.updateTaskLog(task.jobKey, {
            status: 'running',
            message: `支付链接调试：${planType} / ${regionCode}`,
            progress: 5
        });

        logTask(task.jobKey, `支付链接调试任务已创建 plan=${planType} plan_name=${resolvedPlanName} region=${regionCode} email=${email || '-'}`);
        spawnCheckoutDebugWorker({
            task,
            token,
            sessionRaw: storedSession,
            planType,
            region: regionCode,
            planNameOverride: resolvedPlanName,
            email
        });

        return res.json({
            success: true,
            jobKey: task.jobKey,
            email: email || null,
            message: '浏览器调试任务已启动，请查看下方运行日志'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/checkout/status/:jobKey', async (req, res) => {
    try {
        await ensureStoreReady();
        const jobKey = decodeURIComponent(String(req.params.jobKey || '').trim());
        if (!jobKey) {
            return res.status(400).json({ success: false, error: '缺少 jobKey' });
        }
        const task = await store.getTaskStatus(jobKey);
        if (!task) {
            return res.status(404).json({ success: false, error: '任务不存在' });
        }
        const checkoutUrl = extractCheckoutUrlFromOutput(task.raw_output || '');
        let screenshots = [];
        if (task.failure_screenshots) {
            try {
                const parsed = JSON.parse(task.failure_screenshots);
                if (Array.isArray(parsed)) screenshots = parsed;
            } catch (_) { /* ignore */ }
        }
        if (!screenshots.length) {
            screenshots = extractScreenshotsFromOutput(task.raw_output || '');
        }
        const videos = extractVideosFromOutput(task.raw_output || '');
        res.json({
            success: true,
            jobKey,
            status: task.status,
            message: task.message,
            progress: Number(task.progress || 0),
            checkout_url: checkoutUrl || null,
            screenshots,
            videos
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Card Pool Management API ───────────────────────────────────────────────

app.get('/api/admin/cards', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery(
            `SELECT id, card_number, card_expiry, card_cvc, card_holder,
                    payment_holder_name, payment_address_line1, payment_address_city,
                    payment_address_state, payment_address_postal, payment_address_id,
                    is_active, usage_count, last_used_at, status, cooldown_until
             FROM card_assets
             ORDER BY sort_order ASC, id ASC`
        );
        const cards = rows.map((row) => ({
            id: row.id,
            card_number: row.card_number || '',
            card_expiry: row.card_expiry || '',
            card_cvc: row.card_cvc || '',
            last4: String(row.card_number || '').slice(-4),
            card_holder: row.card_holder || '',
            payment_holder_name: row.payment_holder_name || '',
            payment_address_line1: row.payment_address_line1 || '',
            payment_address_city: row.payment_address_city || '',
            payment_address_state: row.payment_address_state || '',
            payment_address_postal: row.payment_address_postal || '',
            payment_address_id: row.payment_address_id || null,
            is_active: Number(row.is_active || 0),
            usage_count: Number(row.usage_count || 0),
            last_used_at: row.last_used_at || null,
            status: row.status || '正常',
            cooldown_until: row.cooldown_until || null
        }));
        res.json({ success: true, cards });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cards/import', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
        if (cards.length === 0) {
            return res.status(400).json({ success: false, error: '缺少 cards 数组或为空' });
        }
        if (cards.length > 500) {
            return res.status(400).json({ success: false, error: '单次导入上限 500 条' });
        }

        const result = await store.importCards(cards);
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.message === '单次导入上限 500 条') {
            return res.status(400).json({ success: false, error: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/cards/:id', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const cardId = Number(req.params.id);
        if (!cardId || !Number.isFinite(cardId)) {
            return res.status(400).json({ success: false, error: '无效的卡片 ID' });
        }
        const result = await store.runExecute(
            `DELETE FROM card_assets WHERE id = ?`,
            [cardId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: '卡片不存在' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Proxy Pool CRUD API ────────────────────────────────────────────────────

app.get('/api/admin/proxies', async (req, res) => {
    try {
        await ensureStoreReady();
        const proxies = await store.listProxyAssets();
        res.json({ success: true, proxies });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/proxies', async (req, res) => {
    try {
        await ensureStoreReady();
        const input = req.body?.proxies ?? req.body?.proxy_url ?? req.body?.proxy ?? '';
        const result = await store.addProxyAssets(input);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/proxies/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = req.params.id;
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'is_active')) {
            const result = await store.setProxyAssetActive(id, Boolean(req.body.is_active));
            if (!result.success) {
                return res.status(404).json(result);
            }
            return res.json(result);
        }
        return res.status(400).json({ success: false, error: '缺少可更新字段' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/proxies/:id/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const row = await store.getProxyAssetById(req.params.id);
        if (!row) {
            return res.status(404).json({ success: false, error: '代理不存在' });
        }
        const result = await testProxyUrl(row.proxy_url);
        await store.updateProxyAssetCheck(row.id, result);
        res.json({ success: true, id: row.id, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/proxies/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await store.deleteProxyAsset(req.params.id);
        if (!result.success) {
            return res.status(404).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Tax-Free Address CRUD API ──────────────────────────────────────────────

app.get('/api/admin/addresses', async (req, res) => {
    try {
        await ensureStoreReady();
        const region = String(req.query?.region || '').toUpperCase();
        if (!region) {
            return res.status(400).json({ success: false, error: '缺少 region 参数' });
        }
        const addresses = await taxFreeAddress.listAddresses(region);
        res.json({ success: true, addresses });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/addresses', async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await taxFreeAddress.createAddress(req.body);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/addresses/generate-random-us', async (req, res) => {
    try {
        await ensureStoreReady();
        const count = Number(req.body?.count) || 10;
        const result = await taxFreeAddress.batchGenerateUsAddresses(count);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/addresses/unbound', async (req, res) => {
    try {
        await ensureStoreReady();
        const region = String(req.query?.region || 'US').toUpperCase();
        const result = await taxFreeAddress.clearUnboundAddresses(region);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/addresses/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = req.params.id;
        const result = await taxFreeAddress.updateAddress(id, req.body);
        if (!result.success) {
            const status = result.error === '地址模板不存在' ? 404 : 400;
            return res.status(status).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/addresses/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = req.params.id;
        const result = await taxFreeAddress.deleteAddress(id);
        if (!result.success) {
            return res.status(404).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/change-password', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '').trim();

    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入原密码' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();

        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '原密码错误' });
        }

        if (verifyPassword(newPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '新密码不能与原密码相同' });
        }

        await store.updateAdminPassword(newPassword);
        await logAdminSecurityEvent('password_changed', {
            ...adminAuth.getClientMeta(req),
            email: req.admin?.email || authConfig.email,
            detail: '登录密码已修改'
        });
        return res.json({ success: true, message: '密码修改成功，请重新登录' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/cdks', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        res.json(await store.listCdks());
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cdks/generate', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const count = req.body?.count;
        const planType = req.body?.plan_type || 'plus';
        const newCdks = createCdks(count);
        const result = await store.insertCdks(newCdks, { type: '自助', plan_type: planType });
        res.json({
            success: true,
            message: `成功生成 ${result.insertedCount} 个自助 CDK`,
            cdks: newCdks,
            insertedCount: result.insertedCount,
            plan_type: planType
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cdks/import', requireSecondaryAuth, async (req, res) => {
    const cdks = Array.isArray(req.body?.cdks) ? req.body.cdks : [];
    if (cdks.length === 0) {
        return res.status(400).json({ success: false, message: '请提供要导入的卡密' });
    }

    try {
        await ensureStoreReady();
        const planType = req.body?.plan_type || 'plus';
        const summary = await store.insertCdks(cdks, { plan_type: planType });
        res.json({
            success: true,
            message: `导入完成，新增 ${summary.insertedCount} 个，重复 ${summary.duplicateCount} 个`,
            ...summary
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cdks/:cdk/ship', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const updated = await store.markCdkShipped(req.params.cdk);
        if (!updated) {
            return res.status(404).json({ success: false, message: 'CDK 不存在' });
        }
        res.json({ success: true, message: 'CDK 已标记出库' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/cdks/:cdk', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        await store.deleteCdk(req.params.cdk);
        res.json({ success: true, message: 'CDK 已删除' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Billing Records API ─────────────────────────────────────────────────────

app.get('/api/admin/billing', async (req, res) => {
    try {
        await ensureStoreReady();
        const filters = {};
        if (req.query.start_date) filters.startDate = req.query.start_date;
        if (req.query.end_date) filters.endDate = req.query.end_date;
        if (req.query.card_last4) filters.cardLast4 = req.query.card_last4;
        if (req.query.plan_type) filters.planType = req.query.plan_type;
        if (req.query.status) filters.status = req.query.status;
        const page = Math.max(1, Number(req.query.page) || 1);
        const result = await store.listBillingRecords(filters, page, 20);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/billing/export', async (req, res) => {
    try {
        await ensureStoreReady();
        const filters = {};
        if (req.query.start_date) filters.startDate = req.query.start_date;
        if (req.query.end_date) filters.endDate = req.query.end_date;
        if (req.query.card_last4) filters.cardLast4 = req.query.card_last4;
        if (req.query.plan_type) filters.planType = req.query.plan_type;
        if (req.query.status) filters.status = req.query.status;
        const csv = await store.exportBillingRecordsCSV(filters);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="billing_export.csv"');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/billing/summary/:cardLast4', async (req, res) => {
    try {
        await ensureStoreReady();
        const cardLast4 = String(req.params.cardLast4 || '');
        const summary = await store.getCardBillingSummary(cardLast4);
        res.json({ success: true, ...summary });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/billing/failed', async (req, res) => {
    try {
        await ensureStoreReady();
        const deleted = await store.deleteFailedBillingRecords();
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/billing/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = Number(req.params.id);
        if (!id) {
            return res.status(400).json({ success: false, message: '无效的记录 ID' });
        }
        const ok = await store.deleteBillingRecord(id);
        if (!ok) {
            return res.status(404).json({ success: false, message: '账单记录不存在' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


async function syncBrowserPoolModeFromStore() {
    const enabled = await store.getBrowserPoolEnabled();
    browserPool.setRuntimeEnabled(enabled);
    if (!enabled) {
        await browserPool.shutdownBrowserPool().catch(() => {});
        return { enabled: false, initialized: false, size: 0, mode: 'standalone' };
    }
    const info = await browserPool.initBrowserPool();
    return { ...info, mode: 'pool' };
}

async function spawnWorkerWithBrowser({ jobKey, runtimeEnv, runScript }) {
    const poolEnabled = browserPool.getRuntimeEnabled();
    if (!poolEnabled) {
        logTask(jobKey, '浏览器模式: 独立启动（后台已关闭浏览器池）');
        return runScript(buildWorkerRuntimeEnv(runtimeEnv, null, 'standalone'));
    }
    return browserPool.withBrowserSlot(jobKey, async (poolSlot) => {
        if (poolSlot) {
            logTask(jobKey, `浏览器模式: 池 slot=${poolSlot.slotId} ${poolSlot.cdpUrl}`);
        } else {
            logTask(jobKey, '浏览器模式: 池未就绪，回退独立启动');
        }
        const mode = poolSlot ? 'pool' : 'standalone';
        return runScript(buildWorkerRuntimeEnv(runtimeEnv, poolSlot, mode));
    });
}

function spawnCheckoutDebugWorker({ task, token, sessionRaw, planType, region, planNameOverride, email }) {
    (async () => {
        const checkoutScript = path.join(__dirname, 'index.js');
        try {
            const proxy = await store.getActiveProxy();
            const hcaptchaCfg = await store.getHcaptchaConfig();
            const { env: hcaptchaEnv } = buildHcaptchaEnvFromConfig(hcaptchaCfg);
            const runtimeEnv = {
                ...process.env,
                ...hcaptchaEnv,
                CHECKOUT_DEBUG_ONLY: '1',
                CHECKOUT_MODE: 'api',
                CHATGPT_TOKEN: token,
                CHATGPT_SESSION_JSON: String(sessionRaw || '').startsWith('{') ? sessionRaw : '',
                CDK_PLAN_TYPE: planType,
                PAYMENT_REGION_OVERRIDE: region,
                PLAN_NAME_OVERRIDE: planNameOverride || '',
                CDK_CODE: '',
                ACTIVATION_EMAIL: email || '',
                PROXY: proxy
            };

            logTask(task.jobKey, `启动 Playwright 浏览器 proxy=${proxy ? 'yes' : 'no'}`);
            const run = await spawnWorkerWithBrowser({
                jobKey: task.jobKey,
                runtimeEnv,
                runScript: (workerEnv) => runCheckoutScript(task.jobKey, checkoutScript, workerEnv, 1, async (progress) => {
                    if (progress > 0) {
                        await store.updateTaskLog(task.jobKey, {
                            status: 'running',
                            message: '浏览器调试进行中...',
                            progress: Math.min(progress, 99)
                        });
                    }
                })
            });

            const analysis = analyzeCheckoutDebugOutput(run.output, run.timedOut);
            const checkoutUrl = analysis.checkoutUrl || extractCheckoutUrlFromOutput(run.output);
            const failureScreenshots = extractScreenshotsFromOutput(run.output);
            const finalStatus = analysis.status || 'failed';
            const finalProgress = finalStatus === 'success' ? 100 : Math.min(getCheckoutProgress(run.output, finalStatus), 99);
            const finalMessage = finalStatus === 'success' && checkoutUrl
                ? `支付链接: ${checkoutUrl}`
                : (analysis.message || '支付链接调试失败');

            await store.updateTaskLog(task.jobKey, {
                status: finalStatus,
                message: finalMessage,
                rawOutput: run.output,
                progress: finalProgress,
                failureScreenshots
            });

            logTask(
                task.jobKey,
                `调试结束 status=${finalStatus} url=${checkoutUrl ? 'yes' : 'no'} screenshots=${failureScreenshots.length}`
            );
        } catch (error) {
            console.error(`[Checkout Debug] ${task.jobKey}:`, error);
            logTask(task.jobKey, `调试任务异常: ${error.message}`, 'error');
            await store.updateTaskLog(task.jobKey, {
                status: 'failed',
                message: error.message,
                progress: 0
            });
        }
    })();
}

/**
 * 第三方 GPT 代充 API 任务 Worker（协议见 协议api.md）
 *
 * 流程：
 * 1. 读取后台配置（base_url / api_key / plan_key / country / currency / enabled）
 * 2. 从银行卡池预留一张卡作为 new_card（可选，失败则跳过）
 * 3. POST /pay 提交代充（带 Idempotency-Key = `cdk-${cdk}`）
 * 4. 轮询订单/任务状态，直到终态（success / failed）
 * 5. 将结果写回 task_logs（含 gpt_api_order_id / gpt_api_task_id / gpt_api_raw）
 */
// 第三方代充 plan 映射：ZovoCard GPT 计划 key 为 plus / pro_5x / pro_20x（带下划线）。
// 旧 broker 用 pro5x / pro20x（无下划线），切换时注意区分。
const GPT_API_PLAN_MAP = Object.freeze({ plus: 'plus', pro_5x: 'pro_5x', pro_20x: 'pro_20x' });

function mapGptApiPlanKey(planType) {
    return GPT_API_PLAN_MAP[String(planType || '').trim()] || 'plus';
}

function parseCardExpiry(value) {
    const match = String(value || '').trim().match(/^(0?[1-9]|1[0-2])\s*\/?\s*(\d{2}|\d{4})$/);
    if (!match) throw new Error('银行卡有效期格式错误，应为 MMYY、MM/YY 或 MM/YYYY');
    const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    return { month: Number(match[1]), year };
}

async function runGptApiWorker({ task, token, session, cdk, planType }) {
    const { jobKey } = task;
    const sessionPayload = session && typeof session === 'object'
        ? session
        : { access_token: token };
    const accountEmail = task.tokenPreview || '';
    let shouldRollbackCdk = true;
    let reservedCard = null;

    const setProgress = async (status, progress, message, extra = {}) => {
        await store.updateTaskLog(jobKey, { status, progress, message, ...extra });
        broadcastToTask(jobKey, {
            type: status === 'running' ? 'progress' : 'status',
            jobKey,
            status,
            progress,
            message,
            cdkCode: cdk
        });
    };

    try {
        const cfg = await store.getGptApiConfig();
        if (!cfg.enabled) {
            throw new Error('第三方代充 API 未启用，请在后台「系统配置」中开启并填写 API 地址与 Key');
        }
        if (!cfg.api_key && !cfg.mock) {
            throw new Error('第三方代充 API Key 未配置');
        }
        if (cfg.mock) {
            logTask(jobKey, 'MOCK 模式：本次代充为模拟执行，不会真实调用 ZovoCard，不会产生任何扣费');
        }

        const apiPlanKey = mapGptApiPlanKey(planType);
        await setProgress('running', 10, '正在检查 Session 格式...');
        const inspect = await gptApi.inspectPay(cfg, {
            planKey: apiPlanKey,
            session: sessionPayload
        });
        if (!inspect.success) {
            const statusText = inspect.status ? ` (HTTP ${inspect.status})` : '';
            const detail = [inspect.error, inspect.reason, inspect.upstreamStatus ? `upstream ${inspect.upstreamStatus}` : ''].filter(Boolean).join(' / ');
            throw new Error(`Session 格式或有效期检查失败${statusText}: ${detail || 'session_invalid'}`);
        }
        logTask(jobKey, 'Session 本機格式／有效期檢查通過；上游將於代充任務中驗證登入狀態');

        const proxy = await store.getActiveProxy();
        logTask(jobKey, proxy
            ? `第三方 API 协议代理 ${maskProxyForLog(proxy)}`
            : '第三方 API 使用平台启用代理池');

        // 本機检查通过后才从卡池预留一张卡，避免无效 Session 占用资产。
        // ZovoCard / SpaceXCard 模式：卡由平台提供，不依赖本地银行卡池，跳过取卡。
        const useZovocard = /zovocard|openapi\/v1/i.test(cfg.base_url || '');
        let newCard = null;
        reservedCard = null;
        if (!useZovocard) {
            reservedCard = await store.reserveCard(`gptapi_${jobKey}`);
            if (!reservedCard) {
                throw new Error('银行卡池暂无可用卡片，请在后台「银行卡池」导入银行卡后再试');
            }
            const expiry = parseCardExpiry(reservedCard.card_expiry);
            newCard = {
                number: reservedCard.card_number,
                exp_month: expiry.month,
                exp_year: expiry.year,
                cvc: reservedCard.card_cvc,
                name: reservedCard.card_holder || 'API User',
                country: cfg.country || 'PH'
            };
            logTask(jobKey, `第三方 API 使用卡池预留卡 ...${String(reservedCard.card_number || '').slice(-4)}`);
        } else {
            logTask(jobKey, 'ZovoCard 模式：使用平台托管卡片，跳过本地银行卡池');
        }

        // 套餐从 CDK 的 plan_type 同步；国家币种使用协议默认值（PH / PHP）
        await setProgress('running', 20, '正在提交代充订单...');
        const idempotencyKey = `cdk-${cdk}`;
        const submit = await gptApi.submitPay(cfg, {
            planKey: apiPlanKey,
            session: sessionPayload,
            country: cfg.country,
            currency: cfg.currency,
            newCard,
            proxy,
            clientRef: `kc-cdk-${cdk}-${jobKey}`,
            idempotencyKey
        });

        if (!submit.success) {
            const statusText = submit.status ? ` (HTTP ${submit.status})` : '';
            const detail = submit.error
                || (submit.data && typeof submit.data === 'object' ? JSON.stringify(submit.data).slice(0, 300) : '');
            throw new Error(`代充提交失败${statusText}: ${detail || '未知错误'}`);
        }

        const orderId = submit.orderId || submit.taskId || submit.id;
        const taskId = submit.taskId || null;
        if (!orderId) {
            throw new Error(`代充提交成功但未返回订单号: ${JSON.stringify(submit.data).slice(0, 300)}`);
        }

        await setProgress('running', 35, `代充订单已创建 ${orderId}，正在等待上游处理...`, {
            gptApiOrderId: orderId,
            gptApiTaskId: taskId,
            gptApiRaw: JSON.stringify(submit.data),
            gptApiTopupCode: submit.topupCode
        });

        // 轮询状态
        let finalStatus = 'running';
        let finalMessage = '第三方代充进行中';
        let lastRaw = submit.data;
        const maxPolls = Number(process.env.GPT_API_MAX_POLLS || 120);
        const pollIntervalMs = Number(process.env.GPT_API_POLL_INTERVAL_MS || 5000);

        for (let poll = 1; poll <= maxPolls; poll += 1) {
            await sleep(pollIntervalMs);

            let queryRes = null;
            if (taskId) {
                queryRes = await gptApi.queryTask(cfg, taskId);
            }
            if (!queryRes || !queryRes.success || !queryRes.rawStatus) {
                queryRes = await gptApi.queryOrder(cfg, orderId);
            }

            if (!queryRes || !queryRes.success) {
                logTask(jobKey, `状态轮询第 ${poll} 次失败: ${queryRes?.error || '未知错误'}`, 'warn');
                continue;
            }

            lastRaw = queryRes.data;
            const rawStatus = String(queryRes.rawStatus || '').toLowerCase();
            const progress = Math.min(95, 40 + poll);

            if (isTerminalGptApiStatus(rawStatus)) {
                const businessResult = lastRaw && typeof lastRaw.result === 'object' ? lastRaw.result : {};
                const succeeded = businessResult.ok === false ? false : isSuccessGptApiStatus(rawStatus);
                const failureDetail = businessResult.error || lastRaw?.error || businessResult.status || rawStatus || 'unknown';
                finalStatus = succeeded ? 'success' : 'failed';
                finalMessage = succeeded ? '第三方代充开通成功' : `第三方代充失败: ${failureDetail}`;
                await setProgress(
                    finalStatus,
                    succeeded ? 100 : 99,
                    finalMessage,
                    {
                        gptApiRaw: JSON.stringify(lastRaw),
                        gptApiTopupCode: gptApi.extractTopupCode(lastRaw)
                    }
                );
                break;
            }

            await setProgress('running', progress, `上游处理中 (${rawStatus || 'pending'})...`);
        }

        if (finalStatus === 'running') {
            finalStatus = 'failed';
            finalMessage = '第三方代充超时未完成，请稍后在第三方平台查询订单状态';
            await setProgress(finalStatus, 99, finalMessage, {
                gptApiRaw: JSON.stringify(lastRaw),
                gptApiTopupCode: gptApi.extractTopupCode(lastRaw)
            });
        }

        if (finalStatus === 'success') {
            shouldRollbackCdk = false;
            await store.resetCdkFailure(cdk);
            await store.recordCardUsage(reservedCard?.id);
            await store.releaseCard(reservedCard?.id).catch(() => { });
            notifyTaskOutcome({ event: 'success', email: accountEmail, cdk, jobKey, message: finalMessage });
        } else {
            await store.releaseCard(reservedCard?.id).catch(() => { });
            notifyTaskOutcome({ event: 'failure', email: accountEmail, cdk, jobKey, message: finalMessage });
        }
    } catch (error) {
        console.error(`[GPT API Task Error] ${jobKey}:`, error);
        logTask(jobKey, `第三方代充任务异常: ${error.message}`, 'error');
        await store.releaseCard(reservedCard?.id).catch(() => { });
        await store.updateTaskLog(jobKey, {
            status: 'failed',
            message: error.message,
            progress: 0,
            cdkCode: cdk
        });
        broadcastToTask(jobKey, {
            type: 'status',
            jobKey,
            status: 'failed',
            message: error.message,
            cdkCode: cdk,
            progress: 0
        });
        notifyTaskOutcome({ event: 'failure', email: accountEmail, cdk, jobKey, message: error.message });
    } finally {
        releaseForegroundSlot(jobKey);
        if (shouldRollbackCdk) {
            await store.markCdkUnused(cdk).catch(() => { });
            logTask(jobKey, `CDK ${cdk} 已回滚为未使用`);
        }
        if (getTotalActiveJobs() === 0) {
            const maintenanceModeState = await store.getMaintenanceModeState();
            if (maintenanceModeState.enabled && maintenanceModeState.drain) {
                await store.setMaintenanceModeState(true, false);
            }
        }
    }
}

function maskProxyForLog(proxyUrl) {
    const raw = String(proxyUrl || '');
    try {
        const masked = raw.replace(/\/\/([^@/]+)@/, '//***:***@');
        return masked || '(空)';
    } catch (_) {
        return '(已配置)';
    }
}

const GPT_API_TERMINAL_SUCCESS = new Set(['success', 'succeeded', 'completed', 'paid', 'active', '开通成功', '成功']);
const GPT_API_TERMINAL_FAILED = new Set(['failed', 'declined', 'canceled', 'cancelled', 'error', 'expired', 'rejected', '失败', '取消']);

function isSuccessGptApiStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase().trim();
    return [...GPT_API_TERMINAL_SUCCESS].some((kw) => s.includes(kw.toLowerCase()));
}

function isTerminalGptApiStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase().trim();
    if (!s) return false;
    if (isSuccessGptApiStatus(s)) return true;
    return [...GPT_API_TERMINAL_FAILED].some((kw) => s.includes(kw.toLowerCase()));
}

function spawnActivationWorker({ task, token, sessionRaw, cdk, cdkDetails, clientIp }) {
    (async () => {
        const checkoutScript = path.join(__dirname, 'index.js');
        let finalRun = null;
        const allOutputs = [];
        let shouldRollbackCdk = true;
        let lastProgress = 0;
        const accountEmail = extractEmailFromSession(sessionRaw) || task.tokenPreview || '';

        try {
            for (let attempt = 1; attempt <= MAX_PROCESS_ATTEMPTS; attempt += 1) {
                logTask(task.jobKey, `开始第 ${attempt}/${MAX_PROCESS_ATTEMPTS} 次尝试`);

                const attemptProgress = normalizeTaskProgress(attempt > 1 ? 1 : 3, 'running', lastProgress);
                broadcastToTask(task.jobKey, {
                    type: 'progress',
                    jobKey: task.jobKey,
                    progress: attemptProgress,
                    status: 'running',
                    message: `正在进行第 ${attempt} 次尝试...`,
                    cdkCode: cdk
                });

                const proxy = await store.getActiveProxy();
                const hcaptchaCfg = await store.getHcaptchaConfig();
                const { env: hcaptchaEnv } = buildHcaptchaEnvFromConfig(hcaptchaCfg);
                const runtimeEnv = {
                    ...process.env,
                    ...hcaptchaEnv,
                    JOB_KEY: task.jobKey,
                    CHATGPT_TOKEN: token,
                    CHATGPT_SESSION_JSON: String(sessionRaw || '').startsWith('{') ? sessionRaw : '',
                    CDK_CODE: cdk,
                    CDK_PLAN_TYPE: cdkDetails.plan_type || 'plus',
                    PROXY: proxy
                };

                logTask(task.jobKey, `尝试 ${attempt} 启动自动化 proxy=${proxy ? 'yes' : 'no'}`);

                const run = await spawnWorkerWithBrowser({
                    jobKey: task.jobKey,
                    runtimeEnv,
                    runScript: (workerEnv) => runCheckoutScript(task.jobKey, checkoutScript, workerEnv, attempt, async (progress, liveOutput) => {
                        if (progress > 0) {
                            const runningProgress = normalizeTaskProgress(progress, 'running', lastProgress);
                            lastProgress = runningProgress;
                            const updatePayload = {
                                status: 'running',
                                message: '正在开通中',
                                rawOutput: null,
                                cdkCode: cdk,
                                progress: runningProgress
                            };
                            if (liveOutput) {
                                const liveMedia = extractTaskMediaFromOutput(liveOutput);
                                const combined = [...liveMedia.screenshots, ...liveMedia.videos];
                                if (combined.length) {
                                    updatePayload.failureScreenshots = combined;
                                }
                            }
                            await store.updateTaskLog(task.jobKey, updatePayload);
                            broadcastToTask(task.jobKey, {
                                type: 'progress',
                                jobKey: task.jobKey,
                                progress: runningProgress,
                                status: 'running',
                                message: '正在开通中',
                                cdkCode: cdk,
                                screenshots: liveOutput ? extractTaskMediaFromOutput(liveOutput).screenshots : undefined,
                                videos: liveOutput ? extractTaskMediaFromOutput(liveOutput).videos : undefined
                            });
                        }
                    })
                });

                const cardLast4 = extractCardLast4FromOutput(run.output);
                allOutputs.push(`===== ATTEMPT ${attempt}${cardLast4 ? ` | CARD ${cardLast4}` : ''} =====\n${run.output}`);
                finalRun = { ...run, output: allOutputs.join('\n\n') };

                const currentStatus = run.analysis.status === 'success' ? 'success' : 'running';
                const currentProgress = normalizeTaskProgress(
                    getCheckoutProgress(run.output, currentStatus),
                    currentStatus,
                    lastProgress
                );
                lastProgress = currentProgress;
                await store.updateTaskLog(task.jobKey, {
                    status: currentStatus,
                    message: currentStatus === 'success' ? '激活成功' : '正在开通中',
                    rawOutput: finalRun.output,
                    progress: currentProgress,
                    cdkCode: cdk,
                    cardLast4
                });

                broadcastToTask(task.jobKey, {
                    type: 'progress',
                    jobKey: task.jobKey,
                    progress: currentProgress,
                    status: currentStatus,
                    message: currentStatus === 'success' ? '激活成功' : '正在开通中',
                    cdkCode: cdk,
                    cardLast4
                });

                if (!run.analysis.shouldRetry || attempt >= MAX_PROCESS_ATTEMPTS) {
                    logTask(task.jobKey, `尝试 ${attempt} 结束，status=${run.analysis.status} shouldRetry=${run.analysis.shouldRetry}`);
                    break;
                }
                logTask(task.jobKey, `尝试 ${attempt} 失败，准备重试`, 'warn');
            }

            const rawOutput = finalRun?.output || '';
            const normalizedAnalysis = finalRun?.analysis?.status === 'retry'
                ? { ...finalRun.analysis, status: 'failed', message: String(finalRun.analysis.message || '激活失败').replace('，准备重试', '') }
                : finalRun?.analysis;
            const finalStatus = normalizedAnalysis?.status || 'failed';

            const finalProgress = normalizeTaskProgress(finalStatus === 'success' ? 100 : lastProgress, finalStatus, lastProgress);
            const taskMedia = extractTaskMediaFromOutput(rawOutput);
            const failureScreenshots = [...taskMedia.screenshots, ...taskMedia.videos];
            await store.updateTaskLog(task.jobKey, {
                status: finalStatus,
                message: normalizedAnalysis?.message || null,
                rawOutput,
                cdkCode: cdk,
                progress: finalProgress,
                failureScreenshots
            });

            broadcastToTask(task.jobKey, {
                type: 'status',
                jobKey: task.jobKey,
                status: finalStatus,
                message: normalizedAnalysis?.message,
                cdkCode: cdk,
                progress: finalProgress,
                screenshots: taskMedia.screenshots,
                videos: taskMedia.videos
            });

            logTask(
                task.jobKey,
                `任务结束 status=${finalStatus} progress=${finalProgress} message=${normalizedAnalysis?.message || ''}`
            );

            if (finalStatus === 'success') {
                shouldRollbackCdk = false;
                await store.resetCdkFailure(cdk);
                if (clientIp) {
                    await store.resetActivationAttemptFailure('ip', clientIp);
                }
                notifyTaskOutcome({
                    event: 'success',
                    email: accountEmail,
                    cdk,
                    jobKey: task.jobKey,
                    message: normalizedAnalysis?.message || '激活成功'
                });
            } else if (isCardPoolExhaustedIssue(rawOutput, normalizedAnalysis)) {
                notifyTaskOutcome({
                    event: 'card_pool_empty',
                    email: accountEmail,
                    cdk,
                    jobKey: task.jobKey,
                    message: normalizedAnalysis?.message || '卡池资产枯竭'
                });
            } else if (finalStatus === 'failed' || finalStatus === 'manual') {
                notifyTaskOutcome({
                    event: 'failure',
                    email: accountEmail,
                    cdk,
                    jobKey: task.jobKey,
                    message: normalizedAnalysis?.message || '激活失败'
                });
            }

            if (finalStatus !== 'success') {
                await store.markCdkUnused(cdk);
                logTask(task.jobKey, `CDK ${cdk} 已回滚为未使用`);
            }

            if (isNoActivationEligibilityMessage(normalizedAnalysis?.message)) {
                const cdkCooledDown = await store.recordCdkFailure(cdk);
                const ipCooledDown = clientIp
                    ? await store.recordActivationAttemptFailure('ip', clientIp)
                    : false;

                if (cdkCooledDown || ipCooledDown) {
                    const cooldownParts = [];
                    if (cdkCooledDown) {
                        cooldownParts.push('该 CDK 已冷却 10 分钟');
                        logTask(task.jobKey, `CDK ${cdk} 因连续无资格提交进入 10 分钟冷却`, 'warn');
                    }
                    if (ipCooledDown) {
                        cooldownParts.push(`IP ${clientIp} 已冷却 10 分钟`);
                        logTask(task.jobKey, `IP ${clientIp} 因连续无资格提交进入 10 分钟冷却`, 'warn');
                    }
                    const cooldownMessage = `${normalizedAnalysis?.message || '该账号无激活权限,请更换账号重试'}（${cooldownParts.join('，')}）`;
                    await store.updateTaskLog(task.jobKey, {
                        status: finalStatus,
                        message: cooldownMessage,
                        rawOutput,
                        cdkCode: cdk,
                        progress: finalProgress
                    });
                    broadcastToTask(task.jobKey, {
                        type: 'status',
                        jobKey: task.jobKey,
                        status: finalStatus,
                        message: cooldownMessage,
                        cdkCode: cdk,
                        progress: finalProgress
                    });
                }
            }
        } catch (bgError) {
            console.error(`[Background Task Error] ${task.jobKey}:`, bgError);
            logTask(task.jobKey, `后台任务异常: ${bgError.message}`, 'error');
            await store.updateTaskLog(task.jobKey, {
                status: 'failed',
                message: bgError.message,
                rawOutput: bgError.message,
                cdkCode: cdk,
                progress: normalizeTaskProgress(lastProgress, 'failed', lastProgress)
            });
            broadcastToTask(task.jobKey, {
                type: 'status',
                jobKey: task.jobKey,
                status: 'failed',
                message: bgError.message,
                cdkCode: cdk,
                progress: normalizeTaskProgress(lastProgress, 'failed', lastProgress)
            });
            notifyTaskOutcome({
                event: 'failure',
                email: accountEmail,
                cdk,
                jobKey: task.jobKey,
                message: bgError.message
            });
            if (shouldRollbackCdk) {
                await store.markCdkUnused(cdk);
                logTask(task.jobKey, `CDK ${cdk} 已回滚为未使用`);
            }
        } finally {
            releaseForegroundSlot(task.jobKey);
            if (getTotalActiveJobs() === 0) {
                const maintenanceModeState = await store.getMaintenanceModeState();
                if (maintenanceModeState.enabled && maintenanceModeState.drain) {
                    await store.setMaintenanceModeState(true, false);
                }
            }
        }
    })();
}

// KC-PATCH（阶段二 · 卡密有效期）：发卡后 180 天内有效（可按业务调整此常量）
const CDK_VALID_DAYS = 180;

function isCdkExpired(cdkDetails) {
    if (!cdkDetails || !cdkDetails.created_at) return false;
    const created = new Date(cdkDetails.created_at).getTime();
    if (!isFinite(created)) return false;
    return Date.now() > created + CDK_VALID_DAYS * 86400 * 1000;
}

async function handleActivationRequest(req, res) {
    const rawSession = String(req.body?.session || req.body?.token || '').trim();
    const sessionJson = parseSessionJson(rawSession);
    const token = normalizeSessionToken(rawSession);
    const cdk = String(req.body?.cdk || '').trim();
    const clientIp = getClientIp(req);
    console.log(`[Activation] 收到开通请求 path=${req.path} cdk=${cdk} session_json=${Boolean(sessionJson)} token_len=${token.length}`);
    if (!token) {
        return res.status(400).json({ success: false, message: '缺少 Session JSON 或 AccessToken' });
    }
    if (!cdk) {
        return res.status(400).json({ success: false, message: '缺少 CDK' });
    }
    const tokenCheck = validateAccessToken(token);
    if (!tokenCheck.valid) {
        return res.status(400).json({ success: false, message: tokenCheck.message });
    }

    try {
        await ensureStoreReady();
        const maintenanceModeState = await store.getMaintenanceModeState();
        if (maintenanceModeState.enabled) {
            return res.status(503).json({ success: false, message: '系统维护中，请稍后再试' });
        }
        const maxConcurrentActivations = await store.getMaxConcurrentActivations();
        if (activeForegroundJobs.size >= maxConcurrentActivations) {
            return res.status(429).json({ success: false, message: '当前任务过多，请稍后再试' });
        }

        const cdkDetails = await store.verifyCdkDetails(cdk);
        const runningTask = cdkDetails ? await store.getRunningTaskByCdk(cdk) : null;
        if (runningTask) {
            return res.json({
                success: true,
                jobKey: runningTask.job_key,
                message: runningTask.message || '该 CDK 正在开通中，已为您恢复等待进度'
            });
        }
        if (!cdkDetails || cdkDetails.used_at || cdkDetails.type !== '自助') {
            return res.status(403).json({ success: false, message: 'CDK 无效、已使用或非自助激活码' });
        }
        // KC-PATCH（阶段二 · 卡密有效期）：发卡后 180 天内有效，超期拒绝兑换
        if (isCdkExpired(cdkDetails)) {
            return res.status(403).json({
                success: false,
                message: '该卡密已超过有效期（发放后 180 天内有效）。如需帮助请联系客服'
            });
        }

        const cdkCooldownMinutes = getRemainingCooldownMinutes(cdkDetails.cooldown_until);
        if (cdkCooldownMinutes > 0) {
            return res.status(403).json({
                success: false,
                message: `该卡密连续无资格尝试过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`
            });
        }

        if (clientIp) {
            const ipAttemptLimit = await store.getActivationAttemptLimit('ip', clientIp);
            const ipCooldownMinutes = getRemainingCooldownMinutes(ipAttemptLimit?.cooldown_until);
            if (ipCooldownMinutes > 0) {
                return res.status(403).json({
                    success: false,
                    message: `当前 IP 连续无资格尝试过多，请冷静 ${ipCooldownMinutes} 分钟后再试`
                });
            }
        }

        // 判断是否走第三方代充 API 模式（后台「系统配置」开启后生效）
        const gptApiConfig = await store.getGptApiConfig();
        const useGptApi = gptApiConfig.enabled && Boolean(gptApiConfig.api_key);

        if (!useGptApi) {
            const hasCard = await store.hasAvailableCard();
            if (!hasCard) {
                const poolEmail = extractEmailFromSession(rawSession);
                fireTelegramNotification('card_pool_empty', {
                    email: poolEmail,
                    cdk,
                    message: '银行卡池暂无可用卡片，任务未启动'
                });
                return res.status(503).json({
                    success: false,
                    message: '银行卡池暂无可用卡片，请先在后台「银行卡池」导入银行卡后再试'
                });
            }
        }

        const lockSuccess = await store.markCdkUsed(cdk);
        if (!lockSuccess) {
            return res.status(403).json({ success: false, message: 'CDK 不可用或正在被他人使用' });
        }

        const storedSession = buildStoredSessionPayload(rawSession, sessionJson, token);
        const task = await store.createTaskLog({
            tokenPreview: extractSessionPreview(storedSession),
            sessionPayload: storedSession,
            cdkCode: cdk,
            phone: null,
            cardLast4: null,
            status: 'running',
            progress: 3
        });

        logTask(task.jobKey, `任务已创建，CDK=${cdk} mode=${useGptApi ? 'gpt-api' : 'local'}`);
        reserveForegroundSlot(task.jobKey);

        if (useGptApi) {
            runGptApiWorker({ task, token, session: JSON.parse(storedSession), cdk, planType: cdkDetails.plan_type || 'plus' }).catch((error) => {
                console.error(`[GPT API Worker] ${task.jobKey}:`, error);
            });
        } else {
            spawnActivationWorker({ task, token, sessionRaw: storedSession, cdk, cdkDetails, clientIp });
        }

        return res.json({
            success: true,
            jobKey: task.jobKey,
            message: '任务已启动，正在为您开通中...'
        });
    } catch (error) {
        try { await store.markCdkUnused(cdk); } catch (_) { }
        return res.status(500).json({ success: false, message: error.message });
    }
}

app.post('/api/run-process', handleActivationRequest);

app.post('/api/admin/trigger-activation', handleActivationRequest);

app.post('/api/verify-cdk', async (req, res) => {
    const cdk = String(req.body?.cdk || '').trim();
    const clientIp = getClientIp(req);
    if (!cdk) {
        return res.status(400).json({ success: false, message: '请输入 CDK' });
    }

    try {
        await ensureStoreReady();
        const cdkData = await store.verifyCdkDetails(cdk);
        const runningTask = cdkData ? await store.getRunningTaskByCdk(cdk) : null;
        if (cdkData && runningTask) {
            return res.json({
                success: true,
                data: {
                    type: cdkData.type || '自助',
                    plan_type: cdkData.plan_type || 'plus',
                    plan_label: getPlanTypeLabel(cdkData.plan_type || 'plus'),
                    status: 'processing',
                    jobKey: runningTask.job_key,
                    message: runningTask.message || '当前 CDK 正在开通中'
                }
            });
        }
        // KC-PATCH（阶段二 · 卡密有效期）：verify 同样拒绝超期卡密
        if (cdkData && isCdkExpired(cdkData)) {
            return res.status(403).json({
                success: false,
                message: '该卡密已超过有效期（发放后 180 天内有效）。如需帮助请联系客服'
            });
        }
        if (cdkData && !cdkData.used_at) {
            if (cdkData.type === '自助') {
                const cdkCooldownMinutes = getRemainingCooldownMinutes(cdkData.cooldown_until);
                if (cdkCooldownMinutes > 0) {
                    return res.status(403).json({
                        success: false,
                        message: `该卡密连续无资格尝试过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`
                    });
                }
                if (clientIp) {
                    const ipAttemptLimit = await store.getActivationAttemptLimit('ip', clientIp);
                    const ipCooldownMinutes = getRemainingCooldownMinutes(ipAttemptLimit?.cooldown_until);
                    if (ipCooldownMinutes > 0) {
                        return res.status(403).json({
                            success: false,
                            message: `当前 IP 连续无资格尝试过多，请冷静 ${ipCooldownMinutes} 分钟后再试`
                        });
                    }
                }
            }
            return res.json({
                success: true,
                data: {
                    type: cdkData.type || '自助',
                    plan_type: cdkData.plan_type || 'plus',
                    plan_label: getPlanTypeLabel(cdkData.plan_type || 'plus')
                }
            });
        }

        return res.status(403).json({ success: false, message: cdkData?.used_at ? '该 CDK 已使用' : '无效 CDK' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/cdk/query', async (req, res) => {
    const cdk = String(req.query.cdk || '').trim();
    if (!cdk) {
        return res.status(400).json({ success: false, message: '请输入查询激活码' });
    }

    try {
        await ensureStoreReady();
        const cdkData = await store.verifyCdkDetails(cdk);
        if (!cdkData) {
            return res.status(404).json({ success: false, message: '未找到该激活码记录' });
        }

        const runningTask = await store.getRunningTaskByCdk(cdk);
        const cdkStatus = runningTask
            ? '开通中'
            : (cdkData.used_at ? '已使用' : '未使用');

        res.json({
            success: true,
            data: {
                status: cdkStatus,
                type: cdkData.type || '自助',
                createdAt: cdkData.created_at,
                jobKey: runningTask?.job_key || null,
                usedAt: cdkData.used_at
                    ? new Date(cdkData.used_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
                    : null
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/cdk/download', async (req, res) => {
    return res.status(410).send('成品号下载功能已移除，仅支持自助开通');
});

// ─── 对外集成接口（供 Xboard 等前台商城调用）─────────────────────────────────

function timingSafeEqualString(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length || bufA.length === 0) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

async function requireIntegrationAuth(req, res, next) {
    try {
        await ensureStoreReady();
        const cfg = await store.getIntegrationConfig();
        if (!cfg.enabled) {
            return res.status(403).json({ success: false, message: '集成接口未启用' });
        }
        if (!cfg.integration_key) {
            return res.status(403).json({ success: false, message: '集成接口未配置密钥' });
        }

        const provided = String(
            req.headers['x-integration-key']
            || req.headers['x-api-key']
            || req.body?.integration_key
            || ''
        ).trim();

        if (!provided || !timingSafeEqualString(provided, cfg.integration_key)) {
            return res.status(401).json({ success: false, message: '集成密钥校验失败' });
        }
        return next();
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

app.post('/api/integration/cdk/issue', requireIntegrationAuth, async (req, res) => {
    try {
        const body = req.body || {};
        const ref = String(body.ref || body.trade_no || '').trim();
        if (!ref) {
            return res.status(400).json({ success: false, message: '缺少 ref（幂等键）' });
        }
        if (ref.length > 64) {
            return res.status(400).json({ success: false, message: 'ref 长度不能超过 64' });
        }

        const planType = String(body.plan_type || 'plus').trim();
        if (!GPT_API_PLAN_MAP[planType]) {
            return res.status(400).json({
                success: false,
                message: `不支持的 plan_type：${planType}，可选 ${Object.keys(GPT_API_PLAN_MAP).join(' / ')}`
            });
        }

        const result = await store.issueCdkByRef(ref, {
            planType,
            source: String(body.source || 'xboard').trim() || 'xboard',
            orderId: body.order_id,
            userRef: body.user_ref,
            createCdks
        });

        return res.json({
            success: true,
            message: result.reused ? '该订单已发放过 CDK' : 'CDK 发放成功',
            data: {
                ref: result.ref,
                cdk: result.cdk,
                plan_type: result.planType,
                reused: result.reused
            }
        });
    } catch (error) {
        console.error('[集成] 发放 CDK 失败:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/integration/cdk/issue', requireIntegrationAuth, async (req, res) => {
    try {
        const ref = String(req.query.ref || '').trim();
        if (!ref) {
            return res.status(400).json({ success: false, message: '缺少 ref' });
        }
        const record = await store.getIntegrationIssueByRef(ref);
        if (!record) {
            return res.status(404).json({ success: false, message: '未找到该 ref 的发放记录' });
        }
        return res.json({
            success: true,
            data: {
                ref: record.ref,
                cdk: record.cdk_code,
                plan_type: record.plan_type,
                source: record.source,
                order_id: record.order_id,
                user_ref: record.user_ref,
                created_at: record.created_at
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ─── S8 供应商健康摘要（履约前置门槛：商城按此判定可售）─────────────────────
const SUPPLIER_HEALTH_KEY = 'supplier_health_state';

async function readSupplierHealthState() {
    try {
        const raw = await store.getAppConfigValue(SUPPLIER_HEALTH_KEY, '');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

/**
 * 刷新供应商健康摘要并持久化。
 *
 * 安全约束：仅 Mock 模式执行 —— 用本地模拟的套餐/余额结果评估，
 * 不产生任何真实上游调用。真实模式的「上游只读验通」需用户批准后另行开启，
 * 当前非 Mock 直接跳过（保持 fail-closed，商城侧不可售）。
 */
async function refreshSupplierHealth() {
    await ensureStoreReady();
    const cfg = await store.getGptApiConfig();
    if (!gptApi.isMockMode(cfg)) {
        return null;
    }
    const [plansResult, balanceResult] = await Promise.all([
        gptApi.fetchPlans(cfg),
        gptApi.queryBalance(cfg)
    ]);
    const previous = (await readSupplierHealthState()) || supplierHealth.baseState();
    const next = supplierHealth.evaluateSupplierHealth({
        previous,
        plansResult,
        balanceResult,
        now: new Date().toISOString(),
        mock: true
    });
    await store.setAppConfigValue(SUPPLIER_HEALTH_KEY, JSON.stringify(next));
    await appendSupplierHealthHistory(next);
    return next;
}

/** 追加一条健康快照历史（运维参考；截断保留最近 48 条） */
async function appendSupplierHealthHistory(state) {
    try {
        const raw = await store.getAppConfigValue(SUPPLIER_HEALTH_HISTORY_KEY, '');
        let list = [];
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) list = parsed;
            } catch (_) { /* 历史解析失败则重建 */ }
        }
        list.push({
            status: state.status,
            sellable: state.sellable === true,
            reason_code: state.reason_code,
            checked_at: state.checked_at,
            last_probe_status: state.last_probe_status || null,
            last_probe_reason_code: state.last_probe_reason_code || null,
            recovery_ready: state.recovery_ready === true,
            failure_count: Number(state.failure_count) || 0,
            balance: state.balance,
            plans: (Array.isArray(state.plans) ? state.plans : []).map((p) => ({ key: p.key, available: p.available === true })),
            mock: state.mock === true
        });
        if (list.length > SUPPLIER_HEALTH_HISTORY_MAX) {
            list = list.slice(list.length - SUPPLIER_HEALTH_HISTORY_MAX);
        }
        await store.setAppConfigValue(SUPPLIER_HEALTH_HISTORY_KEY, JSON.stringify(list));
    } catch (_) {
        // 历史仅作运维参考，失败绝不影响主流程
    }
}

app.get('/api/integration/health', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getIntegrationConfig();
        const state = (await readSupplierHealthState()) || supplierHealth.baseState();
        return res.json({
            success: true,
            data: {
                enabled: cfg.enabled,
                key_configured: Boolean(cfg.integration_key),
                supplier_health: supplierHealth.toPublic(state)
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 手动触发一次健康摘要刷新（联调/运维用；刷新逻辑内部仅 Mock 模式做实事）
app.post('/api/integration/health/refresh', requireIntegrationAuth, async (req, res) => {
    try {
        const next = await refreshSupplierHealth();
        const state = next || (await readSupplierHealthState()) || supplierHealth.baseState();
        return res.json({
            success: true,
            data: {
                supplier_health: supplierHealth.toPublic(state)
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 段C5：精确任务状态（真实进度百分比 + 失败原因）
//
// 为什么单独开一个接口，而不是扩展 /api/cdk/query：
//   /api/cdk/query 是**公开无鉴权**接口（KC 前台兑卡页依赖它），
//   往里加 message 会把上游错误原文暴露给任何知道卡密的人 → 信息泄露。
//   本接口带 X-Integration-Key，只有对接方服务端能调。
//
// ⚠️ 语义差异（务必注意）：失败时 KC 会回滚卡密状态，
//   因此 /api/cdk/query 会显示「未使用」，而本接口以**任务记录**为准
//   返回 taskStatus='failed'。前台要显示失败态必须走本接口。

/** 敏感词过滤：命中即替换为通用文案，避免泄露内部细节 */
const TASK_MESSAGE_REDACT = /(access_token|refresh_token|session|password|passwd|bearer|sk-|卡号|card\s*last)/i;

function sanitizeTaskMessage(message, status) {
    const text = String(message || '').trim();
    if (!text) {
        return String(status) === 'success' ? '开通成功' : '正在开通中';
    }
    if (TASK_MESSAGE_REDACT.test(text)) {
        return '开通遇到问题，详情请联系客服';
    }
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

app.get('/api/integration/task/status', requireIntegrationAuth, async (req, res) => {
    try {
        const cdk = String(req.query.cdk || '').trim();
        if (!cdk) {
            return res.status(400).json({ success: false, message: '缺少 cdk' });
        }

        await ensureStoreReady();
        const cdkData = await store.verifyCdkDetails(cdk);
        if (!cdkData) {
            return res.status(404).json({ success: false, message: '未找到该激活码记录' });
        }

        const task = await store.getLatestTaskByCdk(cdk);
        if (!task) {
            // 卡密存在但从未发起开通 → 与 /api/cdk/query 的「未使用」对齐
            return res.json({
                success: true,
                data: {
                    cdk,
                    status: '未使用',
                    taskStatus: null,
                    progress: 0,
                    message: '尚未发起开通',
                    hasTask: false,
                    updatedAt: null
                }
            });
        }

        // 任务态 → 三态中文（与 /api/cdk/query 的取值域保持一致）
        const taskStatus = String(task.status || '');
        const statusCn = taskStatus === 'running'
            ? '开通中'
            : (taskStatus === 'success' ? '已使用' : '未使用');

        return res.json({
            success: true,
            data: {
                cdk,
                status: statusCn,
                taskStatus,
                progress: Number(task.progress || 0),
                message: sanitizeTaskMessage(task.message, taskStatus),
                hasTask: true,
                updatedAt: task.updated_at || null
            }
        });
    } catch (error) {
        console.error('[集成] 查询任务状态失败:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// v1.19.0 · 权益高级·插件协作自动发权益 + 退款回补（SP §R5）
// ============================================================
// 触发场景：插件 KcIntegration 发卡成功（order.open.after 调完 cdk/issue 返回 ok 后）回调本端点
// 按 plan_code 查找 status='active' 且 source='purchase' 且 trigger_plan_code=plan_code 的规则，
// 给下单 user 自动下发 grant（幂等：同 user × 同 rule × active 唯一）
// Body: { user_id, plan_code, trade_no, cdk? }
app.post('/api/integration/entitlement/issue-after-cdk', requireIntegrationAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const user_id = parseInt(req.body && req.body.user_id, 10);
        const plan_code = String((req.body && req.body.plan_code) || '').trim();
        const trade_no = String((req.body && req.body.trade_no) || '').trim().slice(0, 64);
        const cdk = String((req.body && req.body.cdk) || '').trim().slice(0, 64);
        if (!user_id) return res.status(400).json({ success: false, message: 'user_id 必填' });
        if (!plan_code) return res.status(400).json({ success: false, message: 'plan_code 必填' });
        if (!trade_no) return res.status(400).json({ success: false, message: 'trade_no 必填' });
        // 查找触发规则（purchase 源 + trigger_plan_code 匹配 + active）
        const rules = await store.runQuery(
            "SELECT * FROM kc_entitlement_rules WHERE status='active' AND source='purchase' AND trigger_plan_code=? ORDER BY priority DESC, id DESC",
            [plan_code]
        );
        if (!rules.length) return res.json({ success: true, data: { granted: [], note: '该 plan 未配置触发权益规则' } });
        const granted = [];
        for (const r of rules) {
            // 校验 plan_scope 是否包含 plan_code
            let scope = [];
            try { scope = typeof r.plan_scope === 'string' ? JSON.parse(r.plan_scope) : (r.plan_scope || []); } catch (e) { scope = []; }
            if (Array.isArray(scope) && scope.length && !scope.includes(plan_code)) continue;
            const source_ref = 'order:' + trade_no + (cdk ? ':' + cdk : '');
            const out = await entitlementGrantIssue(user_id, r.code, 'purchase', source_ref, 'plugin auto-issue after cdk');
            granted.push({ rule_code: r.code, ...out });
        }
        res.json({ success: true, data: { granted } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 集成端点：查询某用户的生效权益（grants），供 Xboard 插件代理给前台「权益包」页展示。
// 只返回展示所需字段，不返回内部审计信息。
// Query: ?user_id=123  ｜ Header: X-Integration-Key
app.get('/api/integration/entitlement/grants', requireIntegrationAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const user_id = parseInt((req.query && req.query.user_id) || 0, 10);
        if (!user_id) return res.status(400).json({ success: false, message: 'user_id 必填' });
        const rows = await store.runQuery(
            "SELECT g.id, g.rule_code, g.remaining_uses, g.total_uses, g.expires_at, g.status, g.source, g.created_at, " +
            "r.display_name, r.discount_type, r.discount_value, r.min_order_cents, r.plan_scope " +
            "FROM kc_entitlement_grants g JOIN kc_entitlement_rules r ON r.code = g.rule_code " +
            "WHERE g.user_id = ? AND g.status = 'active' ORDER BY g.created_at DESC LIMIT 50",
            [user_id]
        );
        const grants = rows.map(r => ({
            id: Number(r.id),
            rule_code: r.rule_code,
            display_name: r.display_name,
            remaining_uses: Number(r.remaining_uses),
            total_uses: Number(r.total_uses),
            expires_at: r.expires_at ? String(r.expires_at).slice(0, 10) : null,
            discount_type: r.discount_type,
            discount_value: Number(r.discount_value),
            min_order_cents: Number(r.min_order_cents || 0),
        }));
        res.json({ success: true, data: { grants } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 退款/失败回补：按 order_trade_no 回滚一次扣次（grant_id 可选）
// Body: { user_id?, grant_id?, order_trade_no }
//   —— 只传 order_trade_no 时，自动按该单的扣次流水找到 grant（Step 7：插件端无需知道 grant_id）
// 幂等：uk_grant_order 重复调用不重复回补；如 grant 已 revoked/expired 也不再回补
app.post('/api/integration/entitlement/refund', requireIntegrationAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const grant_id = parseInt(req.body && req.body.grant_id, 10) || 0;
        const order_trade_no = String((req.body && req.body.order_trade_no) || '').trim().slice(0, 64);
        if (!order_trade_no) return res.status(400).json({ success: false, message: 'order_trade_no 必填' });
        // 查 use 记录是否存在（用于幂等回滚）；
        // 只给 trade_no 时按单反查 grant（同单多次扣次取最新一条未回补的）
        const uses = grant_id
            ? await store.runQuery('SELECT id, grant_id, rule_code FROM kc_entitlement_uses WHERE grant_id=? AND order_trade_no=? LIMIT 1', [grant_id, order_trade_no])
            : await store.runQuery("SELECT id, grant_id, rule_code FROM kc_entitlement_uses WHERE order_trade_no=? AND note NOT LIKE '%REFUNDED%' ORDER BY id DESC LIMIT 1", [order_trade_no]);
        if (!uses.length) return res.json({ success: true, data: { refunded: false, note: '无对应扣次流水，无需回补' } });
        const use = uses[0];
        const useGrantId = Number(use.grant_id);
        // 标记 use 行为 refunded（在原行 note 加后缀；不删除流水以保留审计）
        await store.runExecute("UPDATE kc_entitlement_uses SET note=CONCAT(note, ' | REFUNDED') WHERE id=?", [use.id]);
        // 回补 grant.remaining_uses + 1，把已 exhausted 的改回 active
        await store.runExecute(
            "UPDATE kc_entitlement_grants SET remaining_uses = remaining_uses + 1, status = CASE WHEN status='exhausted' THEN 'active' ELSE status END WHERE id=? AND status IN ('active','exhausted')",
            [useGrantId]
        );
        res.json({ success: true, data: { refunded: true, grant_id: useGrantId, rule_code: use.rule_code, order_trade_no } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================================
// v1.34.0 · Step 7：代充按「用户权益价」结算（结算层接线）
// ============================================================
// 缺口：代充商品价格以 Xboard v2_plan.prices 为准（kc_pricing_rules 不参与），
//       因此「买权益包 → 代充更便宜」原先只停留在展示层。这里补两个集成端点把
//       「用户手里的 grant」折算进 Xboard 的订单金额：
//         quote   —— 下单前按 base_cents 折算权益价（并落盘 snapshot 记住用了哪个 grant）
//         consume —— 交付成功后按 trade_no 幂等扣次（失败/退款走已有的 /refund）
// v1.35.0 · 权益定价口径：一律取自「权益报价」表 kc_entitlement_prices（权益包 × 商品 一口价），
//   与 /api/pricing/quote 的权益分支共用同一 helper（pickBestEntitlementPrice）；
//   未配置该商品报价 → 不优惠（按原价）。旧的规则级统一折扣（percent/fixed）已废弃。

// 取某用户当前「生效中」的权益 grant。查询失败返回空数组，不阻塞报价。
// v1.35.0：定价不再读规则级折扣字段，故 SELECT 只取 grant 侧字段（r.status 仍在 JOIN 条件里过滤）。
async function entitlementActiveGrants(user_id) {
    try {
        return await store.runQuery(
            'SELECT g.id, g.rule_code, g.remaining_uses, g.expires_at ' +
            'FROM kc_entitlement_grants g JOIN kc_entitlement_rules r ON r.code=g.rule_code ' +
            'WHERE g.user_id=? AND g.status=? AND r.status=?',
            [user_id, 'active', 'active']
        );
    } catch (e) {
        return [];
    }
}

// 批量读取「权益报价」（权益包 × 商品 一口价），返回索引 { [rule_code]: { [plan_code]: price_cents } }。
// 查询失败返回空索引（= 全部按原价），不阻塞报价。
async function loadEntitlementPrices(ruleCodes) {
    const codes = Array.from(new Set((ruleCodes || []).map(c => String(c || '').trim()).filter(Boolean)));
    const index = {};
    if (!codes.length) return index;
    try {
        const placeholders = codes.map(() => '?').join(',');
        const rows = await store.runQuery(
            'SELECT rule_code, plan_code, price_cents FROM kc_entitlement_prices WHERE status=? AND rule_code IN (' + placeholders + ')',
            ['active', ...codes]
        );
        for (const r of rows) {
            const rc = String(r.rule_code);
            if (!index[rc]) index[rc] = {};
            index[rc][String(r.plan_code)] = Number(r.price_cents);
        }
    } catch (e) { /* 查询失败 → 空索引（按原价） */ }
    return index;
}

// 从 grants 中挑出对 (baseCents, planCode) 最优（报价最低）的一条。
// v1.35.0 · 每商品单独报价：定价一律取自 kc_entitlement_prices（权益包 × 商品 一口价）；
//   过期 / 次数用尽的 grant 跳过；**未配置该商品报价 → 该 grant 不产生优惠（按原价）**。
function pickBestEntitlementPrice(grants, priceIndex, baseCents, planCode, now) {
    let best = null;
    for (const g of grants) {
        if (g.expires_at && new Date(g.expires_at) < now) continue;
        if (Number(g.remaining_uses) <= 0) continue;
        const byPlan = priceIndex ? priceIndex[g.rule_code] : null;
        if (!byPlan) continue;
        const raw = byPlan[planCode];
        if (raw == null) continue;                       // 未配置该商品 → 不优惠
        const price = Math.max(0, Math.floor(Number(raw)));
        if (!(price < baseCents)) continue;              // 报价不低于原价 → 无优惠意义
        if (best == null || price < best.cents) {
            best = { cents: price, rule_code: g.rule_code, grant_id: Number(g.id) };
        }
    }
    return best;
}

// 集成端点：按用户权益折算金额。
// 入参：{ user_id, items:[{ plan_code, base_cents, qty?, trade_no? }] }
//      或单条简写 { user_id, plan_code, base_cents, qty?, trade_no? }
// 出参：{ success:true, data:{ quotes:[{ plan_code, base_cents, final_cents, applied_source,
//         applied_grant_id, applied_rule_code, discount_cents }] } }
// 当 trade_no 存在且真的用上了权益价时，落一条 kc_order_pricing_snapshot 记住 grant，
// 供后续 consume 按 trade_no 反查（无需 Xboard 侧新增任何列）。
app.post('/api/integration/entitlement/quote', requireIntegrationAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const user_id = parseInt(body.user_id, 10);
        if (!user_id) return res.status(400).json({ success: false, message: 'user_id 必填' });
        let items = Array.isArray(body.items) ? body.items : null;
        if (!items) {
            if (!body.plan_code) return res.status(400).json({ success: false, message: 'items 或 plan_code 必填' });
            items = [{ plan_code: body.plan_code, base_cents: body.base_cents, qty: body.qty, trade_no: body.trade_no }];
        }
        if (!items.length) return res.status(400).json({ success: false, message: 'items 不能为空' });
        if (items.length > 50) return res.status(400).json({ success: false, message: 'items 最多 50 条' });

        const now = new Date();
        const grants = await entitlementActiveGrants(user_id);
        const priceIndex = await loadEntitlementPrices(grants.map(g => g.rule_code));
        const quotes = [];
        for (const it of items) {
            const planCode = String(it.plan_code || '').trim().slice(0, 64);
            const baseCents = Math.max(0, Math.floor(Number(it.base_cents) || 0));
            const qtyN = Math.max(1, Math.floor(Number(it.qty) || 1));
            const tradeNo = String(it.trade_no || '').trim().slice(0, 64);
            if (!planCode || baseCents <= 0) {
                quotes.push({ plan_code: planCode, base_cents: baseCents, final_cents: baseCents, applied_source: 'none', applied_grant_id: null, applied_rule_code: null, discount_cents: 0 });
                continue;
            }
            const best = pickBestEntitlementPrice(grants, priceIndex, baseCents, planCode, now);
            const useEnt = best != null && best.cents < baseCents;
            const finalCents = useEnt ? (best.cents * qtyN) : (baseCents * qtyN);
            if (useEnt && tradeNo) {
                // plan_id：从 xplan_<id> 反解 Xboard 套餐 id（解析不到记 0；该列 NOT NULL 无默认）
                const pid = Number(String(planCode).replace(/^xplan_/, '')) || 0;
                try {
                    await store.runExecute(
                        'INSERT INTO kc_order_pricing_snapshot (trade_no, plan_id, base_price_cents, final_price_cents, applied_source, applied_rule_id, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                        'ON DUPLICATE KEY UPDATE plan_id=VALUES(plan_id), base_price_cents=VALUES(base_price_cents), final_price_cents=VALUES(final_price_cents), applied_source=VALUES(applied_source), applied_rule_id=VALUES(applied_rule_id), snapshot_json=VALUES(snapshot_json)',
                        // applied_rule_id 列为 bigint：规则以 code（字符串）标识，故此处存 NULL，
                        // 规则 code 完整保存在 snapshot_json.entitlement 中（避免字符串写入整型列报错）
                        [tradeNo, pid, baseCents, finalCents, 'entitlement', null, JSON.stringify({
                            plan_code: planCode,
                            qty: qtyN,
                            entitlement: { grant_id: best.grant_id, rule_code: best.rule_code, base_cents: baseCents, final_cents: best.cents }
                        })]
                    );
                } catch (e) { /* snapshot 失败不阻塞报价 */ }
            }
            quotes.push({
                plan_code: planCode,
                base_cents: baseCents,
                final_cents: finalCents,
                applied_source: useEnt ? 'entitlement' : 'none',
                applied_grant_id: useEnt ? best.grant_id : null,
                applied_rule_code: useEnt ? best.rule_code : null,
                discount_cents: Math.max(0, baseCents * qtyN - finalCents)
            });
        }
        return res.json({ success: true, data: { quotes } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 集成端点：交付成功后按 trade_no 幂等扣次。
// 入参：{ order_trade_no, grant_id?, plan_code?, original_cents?, final_cents? }
//   —— 未传 grant_id 时回读 kc_order_pricing_snapshot（即 quote 阶段落盘的 grant）；
//      查不到权益快照即视为「本单未使用权益价」→ consumed:false，不报错。
// 幂等：entitlementConsume 以 (grant_id, order_trade_no) 唯一键 + INSERT IGNORE 保证不重复扣。
app.post('/api/integration/entitlement/consume', requireIntegrationAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const order_trade_no = String(body.order_trade_no || '').trim().slice(0, 64);
        if (!order_trade_no) return res.status(400).json({ success: false, message: 'order_trade_no 必填' });
        let grant_id = parseInt(body.grant_id, 10) || 0;
        let planCode = String(body.plan_code || '').trim().slice(0, 64);
        let originalCents = Math.max(0, Math.floor(Number(body.original_cents) || 0));
        let finalCents = Math.max(0, Math.floor(Number(body.final_cents) || 0));
        if (!grant_id) {
            const rows = await store.runQuery(
                'SELECT plan_id, base_price_cents, final_price_cents, snapshot_json FROM kc_order_pricing_snapshot WHERE trade_no=? LIMIT 1',
                [order_trade_no]
            );
            if (!rows.length) return res.json({ success: true, data: { consumed: false, note: '无报价记录' } });
            const row = rows[0];
            let snap = {};
            try { snap = typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) : (row.snapshot_json || {}); } catch (e) { snap = {}; }
            const ent = snap && snap.entitlement ? snap.entitlement : null;
            if (!ent || !ent.grant_id) return res.json({ success: true, data: { consumed: false, note: '本单未使用权益价' } });
            grant_id = Number(ent.grant_id);
            planCode = planCode || String(snap.plan_code || '');
            originalCents = originalCents || Number(ent.base_cents || row.base_price_cents || 0);
            finalCents = finalCents || Number(ent.final_cents || row.final_price_cents || 0);
        }
        const out = await entitlementConsume({ grant_id, user_id: 0, order_trade_no, plan_code: planCode, original_cents: originalCents, final_cents: finalCents });
        return res.json({ success: true, data: { consumed: true, reused: !!out.reused, grant_id, plan_code: planCode, original_cents: originalCents, final_cents: finalCents } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================================
// v1.20.0 · 权益·事件型 + 动作钩子（SP §R6）
// ============================================================
// 内置 handler 列表（演示用，复杂场景留 v1.21+）
const ENT_HANDLERS = {
    audit_log: async (ctx) => {
        // 仅写动作流水（status=success，result=OK）
        await store.runExecute(
            'INSERT INTO kc_entitlement_actions (user_id, rule_code, action_code, handler, target_plan_code, params_json, status, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [ctx.user_id, ctx.rule_code, ctx.action_code, 'audit_log', ctx.target_plan_code || '', JSON.stringify(ctx.params || {}), 'success', JSON.stringify({ ok: true, ts: Date.now() })]
        );
        return { ok: true, action: 'audit_log' };
    },
    plan_switch: async (ctx) => {
        // Demo：写动作流水 + result_json 描述"计划切换到 target_plan_code"
        // 真切换订阅留 v1.21+，避免越权（涉及订阅档位生命周期）
        await store.runExecute(
            'INSERT INTO kc_entitlement_actions (user_id, rule_code, action_code, handler, target_plan_code, params_json, status, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [ctx.user_id, ctx.rule_code, ctx.action_code, 'plan_switch', ctx.target_plan_code || '', JSON.stringify(ctx.params || {}), 'skipped', JSON.stringify({ note: 'plan_switch demo：v1.20.0 仅记录计划，不实际切换；实切换留 v1.21+' })]
        );
        return { ok: true, action: 'plan_switch', target: ctx.target_plan_code, status: 'skipped' };
    }
};

// 集成端点：plugin 上报事件（如"用户购买了某 plan"、"用户首次登录"）→ 匹配 source='event' 规则 → 执行 handler
// Body: { user_id, event_code, target_plan_code?, params? }
app.post('/api/integration/entitlement/event', requireIntegrationAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const user_id = parseInt(req.body && req.body.user_id, 10);
        const event_code = String((req.body && req.body.event_code) || '').trim().slice(0, 64);
        const target_plan_code = String((req.body && req.body.target_plan_code) || '').trim().slice(0, 64);
        const params = (req.body && req.body.params && typeof req.body.params === 'object') ? req.body.params : {};
        if (!user_id) return res.status(400).json({ success: false, message: 'user_id 必填' });
        if (!event_code) return res.status(400).json({ success: false, message: 'event_code 必填' });
        // 查规则：source='event' AND trigger_plan_code=event_code OR trigger_plan_code IS NULL（任意事件触发）
        // MVP：先精确匹配 event_code，再回退到 '*' 通配
        let rules = await store.runQuery(
            "SELECT * FROM kc_entitlement_rules WHERE status='active' AND source='event' AND trigger_plan_code=? ORDER BY priority DESC, id DESC",
            [event_code]
        );
        if (!rules.length) {
            rules = await store.runQuery(
                "SELECT * FROM kc_entitlement_rules WHERE status='active' AND source='event' AND trigger_plan_code='*' ORDER BY priority DESC, id DESC"
            );
        }
        if (!rules.length) return res.json({ success: true, data: { executed: [], note: '无匹配的事件型权益规则' } });
        const executed = [];
        for (const r of rules) {
            // 优先取规则配置的 handler（用 note 字段解析 key:value，简单实用）
            let handlerName = 'audit_log';
            try {
                const m = (r.note || '').match(/handler=(\w+)/);
                if (m && ENT_HANDLERS[m[1]]) handlerName = m[1];
            } catch (e) {}
            const handler = ENT_HANDLERS[handlerName];
            if (!handler) continue;
            const ctx = { user_id, rule_code: r.code, action_code: event_code, target_plan_code: target_plan_code || (r.note.match(/target=(\w+)/)?.[1] || ''), params };
            try {
                const result = await handler(ctx);
                executed.push({ rule_code: r.code, handler: handlerName, ...result });
            } catch (e) {
                await store.runExecute(
                    "INSERT INTO kc_entitlement_actions (user_id, rule_code, action_code, handler, target_plan_code, params_json, status, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [user_id, r.code, event_code, handlerName, target_plan_code || '', JSON.stringify(params), 'failed', JSON.stringify({ error: e.message })]
                );
                executed.push({ rule_code: r.code, handler: handlerName, ok: false, error: e.message });
            }
        }
        res.json({ success: true, data: { executed } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 后台：查 user 动作流水
app.get('/api/admin/entitlements/actions', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const user_id = parseInt(req.query.user_id, 10);
        if (!user_id) return res.status(400).json({ success: false, message: 'user_id 必填' });
        const rows = await store.runQuery("SELECT * FROM kc_entitlement_actions WHERE user_id=? ORDER BY created_at DESC LIMIT 200", [user_id]);
        res.json({ success: true, data: rows });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================================
// v1.21.0 · R7 数据健康诊断（SP §R7 老字段下掉评估）
// 比对 xboard.v2_plan 老字段 vs plus_papay.kc_* 新表字段
// ============================================================
const V2_KC_PERIOD_MAP = { monthly: 'month', onetime: 'once', quarterly: 'quarter', yearly: 'year' };
async function diagnoseLegacyFields() {
    const out = { ts: new Date().toISOString(), legacy_v2_plan_count: 0, kc_plans_count: 0, plans: [], summary: { matches: 0, mismatches: 0, kc_only: 0, legacy_only: 0 } };
    const legacyRows = await store.runQuery('SELECT id, name, prices, kc_card, kc_is_topup, kc_topup_amount FROM xboard.v2_plan ORDER BY id');
    out.legacy_v2_plan_count = legacyRows.length;
    const kcRows = await store.runQuery('SELECT * FROM kc_plans ORDER BY id');
    out.kc_plans_count = kcRows.length;
    const ruleRows = await store.runQuery("SELECT plan_id, period, amount_cents FROM kc_pricing_rules WHERE source='manual' AND enabled=1");
    const ruleMap = {}; for (const r of ruleRows) { (ruleMap[r.plan_id] = ruleMap[r.plan_id] || {})[r.period] = Number(r.amount_cents); }
    const cardRows = await store.runQuery('SELECT plan_id, listing_state, is_visible FROM kc_listing_cards');
    const cardMap = {}; for (const r of cardRows) { cardMap[r.plan_id] = r; }

    for (const v of legacyRows) {
        const code = 'xplan_' + v.id;
        const kc = kcRows.find(k => k.code === code);
        const item = { v2_plan_id: v.id, name: v.name, code, kc_plan_id: kc && kc.id, mismatches: [] };
        if (!kc) {
            item.mismatches.push('KC 侧无对应 plan（kc_plans.code=' + code + ' 不存在）');
            out.summary.legacy_only++;
        } else {
            let vPrices = {};
            try { vPrices = typeof v.prices === 'string' ? JSON.parse(v.prices) : (v.prices || {}); } catch (e) { vPrices = {}; }
            const kcPrices = ruleMap[kc.id] || {};
            for (const [vKey, vVal] of Object.entries(vPrices)) {
                const kKey = V2_KC_PERIOD_MAP[vKey] || vKey;
                const kVal = kcPrices[kKey];
                if (kVal == null) { item.mismatches.push('KC 侧缺价 period=' + kKey); continue; }
                const vCents = Math.round(Number(vVal) * 100);
                if (vCents !== kVal) item.mismatches.push('价不一致：v2_plan.' + vKey + '=' + vCents + 'c ≠ kc_pricing_rules.' + kKey + '=' + kVal + 'c');
            }
            if (Number(v.kc_is_topup) === 1 && kc.kc_type !== 'recharge') item.mismatches.push('kc_type≠recharge（v2_plan.kc_is_topup=1）');
            let vCard = null;
            try { vCard = typeof v.kc_card === 'string' ? JSON.parse(v.kc_card) : (v.kc_card || null); } catch (e) {}
            const kcCard = cardMap[kc.id];
            if (!kcCard && vCard && Object.keys(vCard).length) item.mismatches.push('kc_listing_cards 缺失（v2_plan.kc_card 非空）');
            else if (kcCard && Number(v.kc_is_topup) === 0 && kcCard.is_visible === 0) item.mismatches.push('is_visible=0 但 v2_plan.kc_is_topup=0（v1.17.0 回填可能未对齐）');
            if (item.mismatches.length) out.summary.mismatches++; else out.summary.matches++;
        }
        out.plans.push(item);
    }
    for (const k of kcRows) {
        const id = Number(String(k.code).replace('xplan_', ''));
        if (!legacyRows.find(v => v.id === id)) { out.summary.kc_only++; out.plans.push({ code: k.code, kc_plan_id: k.id, mismatches: ['v2_plan 缺失（KC 侧孤儿 plan）'] }); }
    }
    out.ready_to_drop_legacy = (out.summary.mismatches === 0 && out.summary.legacy_only === 0 && out.summary.kc_only === 0);
    return out;
}

app.get('/api/admin/diag/legacy-fields', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const r = await diagnoseLegacyFields();
        res.json({ success: true, data: r });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ─── 后台：集成配置管理 ─────────────────────────────────────────────────────

// ============================================================
// FEAT-006：商品卡片配置（后台可配 · 读写 Xboard v2_plan.kc_card）
// ============================================================
const XBOARD_DB_NAME = process.env.XBOARD_DB_NAME || 'xboard';

const CARD_STATES = ['onsale', 'featured', 'recommend', 'soon'];
const CARD_BTN_STYLES = ['solid', 'outline', 'ghost'];

function cardDefault() {
    return {
        state: 'onsale',
        badge: { text: '', pos: 'left', color: 'brand' },
        title: '',
        subtitle: '',
        price: { mode: 'auto', value: null, unit: '/月', tag: '' },
        promo: { enabled: true, strike: '', text: '' },
        type: { text: '', color: 'brand' },
        features: [],
        guarantees: [],
        tip: '',
        button: { text: '立即订阅', style: 'solid' },
        chips: []
    };
}

function cardStr(v, max) {
    return String(v == null ? '' : v).trim().slice(0, max);
}

function cardNorm(input) {
    const d = cardDefault();
    const c = (input && typeof input === 'object') ? input : {};
    const badge = (c.badge && typeof c.badge === 'object') ? c.badge : {};
    const price = (c.price && typeof c.price === 'object') ? c.price : {};
    const promo = (c.promo && typeof c.promo === 'object') ? c.promo : {};
    const button = (c.button && typeof c.button === 'object') ? c.button : {};
    const type = (c.type && typeof c.type === 'object') ? c.type : {};
    const arr = (v, max, len) => Array.isArray(v) ? v.map(x => cardStr(x, len)).filter(Boolean).slice(0, max) : [];
    const mode = price.mode === 'manual' ? 'manual' : 'auto';
    const valueNum = Number(price.value);
    const chips = Array.isArray(c.chips) ? c.chips.map((x) => ({
        text: cardStr(x && x.text, 10),
        href: cardStr(x && x.href, 120)
    })).filter((x) => x.text).slice(0, 4) : [];
    const rulesIn = (c.rules && typeof c.rules === 'object') ? c.rules : null;
    return {
        category: categoryKeyNorm(c.category) || 'recharge',
        state: CARD_STATES.includes(c.state) ? c.state : d.state,
        badge: {
            text: cardStr(badge.text, 12),
            pos: badge.pos === 'right' ? 'right' : 'left',
            color: ['brand', 'green', 'amber', 'gray'].includes(badge.color) ? badge.color : 'brand'
        },
        title: cardStr(c.title, 40),
        subtitle: cardStr(c.subtitle, 60),
        price: {
            mode,
            value: (mode === 'manual' && Number.isFinite(valueNum) && valueNum >= 0) ? Math.round(valueNum * 100) / 100 : null,
            unit: cardStr(price.unit || d.price.unit, 8),
            tag: cardStr(price.tag, 10)
        },
        promo: { enabled: promo.enabled !== false, strike: cardStr(promo.strike, 20), text: cardStr(promo.text, 40) },
        type: {
            text: cardStr(type.text, 8),
            color: ['brand', 'green', 'amber', 'gray'].includes(type.color) ? type.color : 'brand'
        },
        features: arr(c.features, 8, 60),
        guarantees: arr(c.guarantees, 4, 20),
        tip: cardStr(c.tip, 60),
        button: {
            text: cardStr(button.text || d.button.text, 12),
            style: CARD_BTN_STYLES.includes(button.style) ? button.style : 'solid'
        },
        chips,
        rules: rulesIn ? {
            account: cardStr(rulesIn.account, 80),
            fulfillment: cardStr(rulesIn.fulfillment, 120),
            restrictions: Array.isArray(rulesIn.restrictions)
                ? rulesIn.restrictions.map((x) => cardStr(x, 100)).filter(Boolean).slice(0, 4)
                : [],
            failure: cardStr(rulesIn.failure, 160)
        } : null
    };
}

function cardParse(raw) {
    if (!raw) { return null; }
    try { return cardNorm(JSON.parse(raw)); } catch (e) { return null; }
}

// ============================================================
// FEAT-009：服务分类 + 商品页常见问题（存 xboard.v2_settings，key-value）
// ============================================================
const CARD_CATEGORIES_DEFAULT = [
    { key: 'recharge', name: '代充', nav: true },
    { key: 'account', name: '成品号', nav: true },
    { key: 'website', name: '建站服务', nav: true }
];
const KC_SETTING_CATEGORIES = 'kc_plan_categories';
const KC_SETTING_FAQ = 'kc_plan_faq';
const KC_SETTING_PROMO_ROW = 'kc_promo_row';

function categoryKeyNorm(v) {
    return String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
}

function categoriesNorm(input) {
    const arr = Array.isArray(input) ? input : [];
    const seen = {};
    const out = [];
    arr.forEach(function (c) {
        if (!c || typeof c !== 'object') { return; }
        const key = categoryKeyNorm(c.key || c.name);
        const name = cardStr(c.name, 12);
        if (!key || !name || seen[key]) { return; }
        seen[key] = 1;
        out.push({ key: key, name: name, nav: c.nav !== false });
    });
    if (!out.length) { return CARD_CATEGORIES_DEFAULT.slice(); }
    // 「代充」为主体业务：始终存在且排最前
    if (!seen['recharge']) { out.unshift({ key: 'recharge', name: '代充', nav: true }); }
    return out.slice(0, 8);
}

function faqNorm(input) {
    const arr = Array.isArray(input) ? input : [];
    return arr.map(function (it) {
        if (!it || typeof it !== 'object') { return null; }
        const q = cardStr(it.q, 60);
        const a = cardStr(it.a, 500);
        if (!q || !a) { return null; }
        return { q: q, a: a };
    }).filter(Boolean).slice(0, 12);
}

async function readKcSetting(name) {
    try {
        const rows = await store.runQuery(
            'SELECT `value` FROM `' + XBOARD_DB_NAME + '`.v2_settings WHERE `name` = ? LIMIT 1', [name]
        );
        if (!rows.length) { return null; }
        return JSON.parse(rows[0].value);
    } catch (e) { return null; }
}

async function writeKcSetting(name, value) {
    const json = JSON.stringify(value);
    // 注意：v2_settings 的 created_at/updated_at 是 DATETIME 类型（不是 unix 时间戳），必须用 NOW()
    const rows = await store.runQuery(
        'SELECT id FROM `' + XBOARD_DB_NAME + '`.v2_settings WHERE `name` = ? LIMIT 1', [name]
    );
    if (rows.length) {
        await store.runExecute(
            'UPDATE `' + XBOARD_DB_NAME + '`.v2_settings SET `value` = ?, updated_at = NOW() WHERE id = ?',
            [json, rows[0].id]
        );
    } else {
        await store.runExecute(
            'INSERT INTO `' + XBOARD_DB_NAME + '`.v2_settings (`group`, `type`, `name`, `value`, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
            ['kc', 'string', name, json]
        );
    }
}

// v1.14.0：优惠行「全局开关」——一次关闭，全站（商品页 + 游客落地页套餐区）优惠行全部隐藏；
// 单卡开关（card.promo.enabled）保留，两者为「与」关系；默认开启，存 v2_settings 即时生效。
function promoRowNorm(input) {
    const o = (input && typeof input === 'object') ? input : {};
    return { enabled: o.enabled !== false };
}

// 保存优惠行全局开关
app.post('/api/admin/card-config/promo-row', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const val = promoRowNorm(req.body && req.body.promo_row);
        await writeKcSetting(KC_SETTING_PROMO_ROW, val);
        res.json({ success: true, message: val.enabled ? '优惠行已开启，前台刷新即生效' : '优惠行已全局关闭，前台刷新即生效', promo_row: val });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 保存分类列表
app.post('/api/admin/card-config/categories', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const list = categoriesNorm(req.body && req.body.categories);
        await writeKcSetting(KC_SETTING_CATEGORIES, list);
        res.json({ success: true, message: '分类已保存，前台刷新即生效', categories: list });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// v1.15.0 · 上游管理层（独立于 v2_plan，SP-2026-10-11-v1.0.1 §4.1）
// ============================================================
// 归一化：code 仅小写字母/数字/下划线，≤32
function upstreamCodeNorm(v) {
    return String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
}
function upstreamStatusNorm(v) {
    return ['active', 'paused', 'archived'].includes(v) ? v : 'active';
}
function upstreamProtocolNorm(v) {
    return ['mock', 'rest', 'custom'].includes(v) ? v : 'mock';
}
function upstreamRow(r) {
    return {
        code: r.code,
        display_name: r.display_name,
        protocol: r.protocol,
        status: r.status,
        base_url: r.base_url || '',
        api_key_ref: r.api_key_ref || '',
        config_json: r.config_json ? (() => { try { return JSON.parse(r.config_json); } catch (e) { return null; } })() : null,
        note: r.note || '',
        created_at: r.created_at,
        updated_at: r.updated_at
    };
}
function upstreamPlanRow(r) {
    return {
        upstream_code: r.upstream_code,
        upstream_plan_key: r.upstream_plan_key,
        display_name: r.display_name,
        sku_type: r.sku_type,
        period: r.period,
        upstream_price_cents: r.upstream_price_cents,
        currency: r.currency,
        is_credit: !!Number(r.is_credit),
        requires_active_subscription: !!Number(r.requires_active_subscription),
        enabled: !!Number(r.enabled),
        note: r.note || '',
        updated_at: r.updated_at
    };
}
async function loadUpstreamHealthMap() {
    try {
        const rows = await store.runQuery(
            'SELECT upstream_code, state, reason, failure_count, last_probe_status, manual_override, mock, checked_at ' +
            'FROM kc_upstream_health_snapshots WHERE id IN (SELECT MAX(id) FROM kc_upstream_health_snapshots GROUP BY upstream_code)'
        );
        const m = {};
        rows.forEach(r => { m[r.upstream_code] = { state: r.state, reason: r.reason || '', failure_count: Number(r.failure_count || 0), last_probe_status: r.last_probe_status || '', manual_override: !!Number(r.manual_override), mock: !!Number(r.mock), checked_at: r.checked_at }; });
        return m;
    } catch (e) { return {}; }
}

// ① 列出所有上游（带最近健康快照）
app.get('/api/admin/upstreams', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery('SELECT * FROM kc_upstreams ORDER BY status ASC, code ASC');
        const healthMap = await loadUpstreamHealthMap();
        const list = rows.map(r => Object.assign(upstreamRow(r), { health: healthMap[r.code] || null }));
        // 配套：每个上游的 plan 数（一次聚合）
        try {
            const counts = await store.runQuery('SELECT upstream_code, COUNT(*) AS cnt FROM kc_upstream_plans GROUP BY upstream_code');
            const cmap = {};
            counts.forEach(c => { cmap[c.upstream_code] = Number(c.cnt); });
            list.forEach(x => { x.plan_count = cmap[x.code] || 0; });
        } catch (e) { /* plan 表未建时不阻塞 */ }
        res.json({ success: true, upstreams: list });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ② 新建上游
app.post('/api/admin/upstreams', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const code = upstreamCodeNorm(body.code);
        const display_name = cardStr(body.display_name, 64);
        if (!code) return res.status(400).json({ success: false, message: 'code 必填，且仅含小写字母/数字/下划线' });
        if (!display_name) return res.status(400).json({ success: false, message: 'display_name 必填' });
        const protocol = upstreamProtocolNorm(body.protocol);
        const status = upstreamStatusNorm(body.status);
        const base_url = cardStr(body.base_url, 255);
        const api_key_ref = cardStr(body.api_key_ref, 64);
        const note = cardStr(body.note, 255);
        const config_json = body.config_json && typeof body.config_json === 'object' ? JSON.stringify(body.config_json) : null;
        await store.runExecute(
            'INSERT INTO kc_upstreams (code, display_name, protocol, status, base_url, api_key_ref, config_json, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [code, display_name, protocol, status, base_url, api_key_ref, config_json, note]
        );
        res.json({ success: true, message: '上游已创建（code=' + code + '）' });
    } catch (error) {
        if (String(error.code) === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'code 已存在' });
        res.status(500).json({ success: false, message: error.message });
    }
});

// ③ 更新上游（暂停 / 启用 / 改配置）
app.patch('/api/admin/upstreams/:code', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const code = upstreamCodeNorm(req.params.code);
        if (!code) return res.status(400).json({ success: false, message: 'code 非法' });
        const body = req.body || {};
        const sets = [];
        const args = [];
        const fields = [
            ['display_name', v => cardStr(v, 64)],
            ['protocol', v => upstreamProtocolNorm(v)],
            ['status', v => upstreamStatusNorm(v)],
            ['base_url', v => cardStr(v, 255)],
            ['api_key_ref', v => cardStr(v, 64)],
            ['note', v => cardStr(v, 255)]
        ];
        fields.forEach(([k, norm]) => { if (Object.prototype.hasOwnProperty.call(body, k)) { sets.push('`' + k + '` = ?'); args.push(norm(body[k])); } });
        if (Object.prototype.hasOwnProperty.call(body, 'config_json')) {
            sets.push('config_json = ?');
            args.push(body.config_json && typeof body.config_json === 'object' ? JSON.stringify(body.config_json) : null);
        }
        if (!sets.length) return res.json({ success: true, message: '无需变更' });
        args.push(code);
        const r = await store.runExecute('UPDATE kc_upstreams SET ' + sets.join(', ') + ' WHERE code = ?', args);
        if (!r || (r.affectedRows != null && r.affectedRows === 0)) return res.status(404).json({ success: false, message: '上游不存在' });
        res.json({ success: true, message: '已更新', code });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ④ 某上游的目录列表
app.get('/api/admin/upstreams/:code/plans', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const code = upstreamCodeNorm(req.params.code);
        if (!code) return res.status(400).json({ success: false, message: 'code 非法' });
        const rows = await store.runQuery(
            'SELECT * FROM kc_upstream_plans WHERE upstream_code = ? ORDER BY sku_type ASC, period ASC, upstream_plan_key ASC',
            [code]
        );
        res.json({ success: true, plans: rows.map(upstreamPlanRow) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ⑤ 手动导入上游目录（CSV 行 或 JSON 数组），幂等 upsert
app.post('/api/admin/upstreams/:code/plans/import', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const code = upstreamCodeNorm(req.params.code);
        if (!code) return res.status(400).json({ success: false, message: 'code 非法' });
        const exists = await store.runQuery('SELECT code FROM kc_upstreams WHERE code = ? LIMIT 1', [code]);
        if (!exists.length) return res.status(404).json({ success: false, message: '上游不存在' });
        const items = Array.isArray(req.body && req.body.plans) ? req.body.plans : [];
        if (!items.length) return res.status(400).json({ success: false, message: 'plans 必填且非空数组' });
        let inserted = 0, updated = 0;
        for (const it of items) {
            if (!it || typeof it !== 'object') continue;
            const k = String(it.upstream_plan_key || '').trim();
            if (!k) continue;
            const sku_type = ['subscription', 'topup', 'credit'].includes(it.sku_type) ? it.sku_type : 'subscription';
            const period = ['once', 'month', 'quarter', 'half_year', 'year', 'two_year', 'three_year'].includes(it.period) ? it.period : 'month';
            const row = [
                code,
                k,
                cardStr(it.display_name, 64) || k,
                sku_type,
                period,
                Math.max(0, Math.floor(Number(it.upstream_price_cents) || 0)),
                cardStr(it.currency, 3) || 'USD',
                it.is_credit ? 1 : 0,
                it.requires_active_subscription ? 1 : 0,
                it.enabled === false ? 0 : 1,
                cardStr(it.note, 255)
            ];
            // 幂等 INSERT ... ON DUPLICATE KEY UPDATE（仅本版本使用，R2 资费层改 R1 推荐约定）
            await store.runExecute(
                'INSERT INTO kc_upstream_plans (upstream_code, upstream_plan_key, display_name, sku_type, period, upstream_price_cents, currency, is_credit, requires_active_subscription, enabled, note) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), sku_type = VALUES(sku_type), period = VALUES(period), ' +
                'upstream_price_cents = VALUES(upstream_price_cents), currency = VALUES(currency), is_credit = VALUES(is_credit), ' +
                'requires_active_subscription = VALUES(requires_active_subscription), enabled = VALUES(enabled), note = VALUES(note)',
                row
            );
            inserted++;
        }
        res.json({ success: true, message: '导入完成', processed: inserted, inserted, updated });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ⑥ 手动刷健康（Mock：状态机读 snapshot 写新 snapshot；不调真实上游）
app.post('/api/admin/upstreams/:code/health/refresh', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const code = upstreamCodeNorm(req.params.code);
        if (!code) return res.status(400).json({ success: false, message: 'code 非法' });
        const exists = await store.runQuery('SELECT code, status FROM kc_upstreams WHERE code = ? LIMIT 1', [code]);
        if (!exists.length) return res.status(404).json({ success: false, message: '上游不存在' });
        // Mock 探活：上游 status=paused/archived 时直接健康=paused/archived；否则 healthy
        let state = 'healthy';
        let reason = '';
        if (exists[0].status === 'paused') { state = 'paused'; reason = '上游已暂停（人工）'; }
        else if (exists[0].status === 'archived') { state = 'archived'; reason = '上游已归档（人工）'; }
        await store.runExecute(
            'INSERT INTO kc_upstream_health_snapshots (upstream_code, state, reason, failure_count, last_probe_status, last_probe_reason_code, manual_override, mock) ' +
            'VALUES (?, ?, ?, 0, ?, ?, 0, 1)',
            [code, state, reason, 'mock_probe', 'mock_' + state]
        );
        res.json({ success: true, message: '已刷新（Mock 探活，未真实调用上游）', upstream_code: code, state, reason });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// v1.16.0 · 资费层（独立于 v2_plan.prices，SP-2026-10-11-v1.0.1 §4.2）
// ============================================================
function planCodeNorm(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64); }
function planTypeNorm(v) { return ['recharge', 'account', 'entitlement'].includes(v) ? v : 'recharge'; }
function planStatusNorm(v) { return ['active', 'paused', 'archived'].includes(v) ? v : 'active'; }
function pricingPeriodNorm(v) { return ['once', 'month', 'quarter', 'half_year', 'year', 'two_year', 'three_year'].includes(v) ? v : 'month'; }
function pricingSourceNorm(v) { return ['manual', 'promotion', 'entitlement'].includes(v) ? v : 'manual'; }
function planRow(r, ruleCount) {
    return {
        id: r.id, code: r.code, kc_type: r.kc_type, display_name: r.display_name,
        upstream_code: r.upstream_code || '', upstream_plan_key: r.upstream_plan_key || '',
        status: r.status, note: r.note || '', rule_count: ruleCount || 0,
        created_at: r.created_at, updated_at: r.updated_at
    };
}
function pricingRuleRow(r) {
    return {
        id: r.id, plan_id: r.plan_id, source: r.source, period: r.period,
        amount_cents: r.amount_cents, priority: r.priority,
        valid_from: r.valid_from, valid_until: r.valid_until,
        enabled: !!Number(r.enabled), note: r.note || '',
        created_at: r.created_at, updated_at: r.updated_at
    };
}

// ① 列出所有 KC 视图 SKU（含当前生效价）
app.get('/api/admin/plans', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery('SELECT * FROM kc_plans ORDER BY status ASC, code ASC');
        const counts = await store.runQuery('SELECT plan_id, COUNT(*) AS cnt FROM kc_pricing_rules GROUP BY plan_id');
        const cmap = {}; counts.forEach(c => { cmap[c.plan_id] = Number(c.cnt); });
        res.json({ items: rows.map(r => planRow(r, cmap[r.id] || 0)) });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ② 新建 SKU（须先存在上游目录项，否则提示）
app.post('/api/admin/plans', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const code = planCodeNorm(body.code);
        const kc_type = planTypeNorm(body.kc_type);
        const display_name = cardStr(body.display_name, 64);
        const upstream_code = String(body.upstream_code || '').trim().slice(0, 32);
        const upstream_plan_key = String(body.upstream_plan_key || '').trim().slice(0, 64);
        const status = planStatusNorm(body.status);
        const note = cardStr(body.note, 255);
        if (!code) return res.status(400).json({ success: false, message: 'code 必填（小写字母/数字/下划线）' });
        if (!display_name) return res.status(400).json({ success: false, message: 'display_name 必填' });
        if (upstream_code || upstream_plan_key) {
            const up = await store.runQuery(
                'SELECT 1 FROM kc_upstream_plans WHERE upstream_code=? AND upstream_plan_key=? LIMIT 1',
                [upstream_code, upstream_plan_key]
            );
            if (!up.length) return res.status(400).json({ success: false, message: '上游套餐键不存在（请先在「上游管理」维护目录）' });
        }
        await store.runExecute(
            'INSERT INTO kc_plans (code, kc_type, display_name, upstream_code, upstream_plan_key, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [code, kc_type, display_name, upstream_code, upstream_plan_key, status, note]
        );
        res.json({ success: true, message: 'SKU 已创建：' + code });
    } catch (error) {
        if (String(error.code) === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'code 已存在' });
        res.status(500).json({ success: false, message: error.message });
    }
});

// ③ 更新 SKU
app.patch('/api/admin/plans/:id', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: 'id 非法' });
        const body = req.body || {};
        const sets = [], args = [];
        const fields = [
            ['kc_type', v => planTypeNorm(v)],
            ['display_name', v => cardStr(v, 64)],
            ['upstream_code', v => String(v == null ? '' : v).trim().slice(0, 32)],
            ['upstream_plan_key', v => String(v == null ? '' : v).trim().slice(0, 64)],
            ['status', v => planStatusNorm(v)],
            ['note', v => cardStr(v, 255)]
        ];
        fields.forEach(([k, norm]) => { if (Object.prototype.hasOwnProperty.call(body, k)) { sets.push('`' + k + '` = ?'); args.push(norm(body[k])); } });
        if (sets.length) {
            // 校验上游键
            let needCheck = false, uc = '', uk = '';
            if (Object.prototype.hasOwnProperty.call(body, 'upstream_code')) { needCheck = true; uc = String(body.upstream_code || '').trim().slice(0, 32); }
            if (Object.prototype.hasOwnProperty.call(body, 'upstream_plan_key')) { needCheck = true; uk = String(body.upstream_plan_key || '').trim().slice(0, 64); }
            if (needCheck && (uc || uk)) {
                const up = await store.runQuery('SELECT 1 FROM kc_upstream_plans WHERE upstream_code=? AND upstream_plan_key=? LIMIT 1', [uc, uk]);
                if (!up.length) return res.status(400).json({ success: false, message: '上游套餐键不存在' });
            }
            args.push(id);
            await store.runExecute('UPDATE kc_plans SET ' + sets.join(', ') + ' WHERE id = ?', args);
        }
        res.json({ success: true, message: '已更新' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ④ 该 SKU 的资费规则列表
app.get('/api/admin/plans/:id/pricing', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: 'id 非法' });
        const rows = await store.runQuery('SELECT * FROM kc_pricing_rules WHERE plan_id=? ORDER BY source DESC, priority DESC, period ASC', [id]);
        res.json({ items: rows.map(pricingRuleRow) });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ⑤ 整体替换（先删后插；保留历史快照不受替换影响）
app.put('/api/admin/plans/:id/pricing', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: 'id 非法' });
        const plan = await store.runQuery('SELECT id, code FROM kc_plans WHERE id=? LIMIT 1', [id]);
        if (!plan.length) return res.status(404).json({ success: false, message: 'SKU 不存在' });
        const items = Array.isArray(req.body && req.body.rules) ? req.body.rules : [];
        // 基本校验：amount_cents 必须 > 0；权益价由 R4 校验，这里只允许 manual/promotion
        for (const it of items) {
            const source = pricingSourceNorm(it.source);
            if (source === 'entitlement') return res.status(400).json({ success: false, message: 'R4 起开放 entitlement 价；当前仅 manual/promotion' });
            const ac = Math.floor(Number(it.amount_cents) || 0);
            if (ac <= 0) return res.status(400).json({ success: false, message: 'amount_cents 必须 > 0' });
        }
        // 事务替代：先删后插
        await store.runExecute('DELETE FROM kc_pricing_rules WHERE plan_id=?', [id]);
        for (const it of items) {
            await store.runExecute(
                'INSERT INTO kc_pricing_rules (plan_id, source, period, amount_cents, priority, valid_from, valid_until, enabled, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    id,
                    pricingSourceNorm(it.source),
                    pricingPeriodNorm(it.period),
                    Math.floor(Number(it.amount_cents) || 0),
                    Math.floor(Number(it.priority) || 0),
                    it.valid_from || null,
                    it.valid_until || null,
                    it.enabled === false ? 0 : 1,
                    cardStr(it.note, 255)
                ]
            );
        }
        res.json({ success: true, message: '资费已替换（' + items.length + ' 条）' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ⑥ 价格预览（不影响 DB；返回「按当前规则 + 用户入参」算出的价）
app.post('/api/admin/plans/:id/pricing/preview', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: 'id 非法' });
        const plan = await store.runQuery('SELECT id, code, kc_type FROM kc_plans WHERE id=? LIMIT 1', [id]);
        if (!plan.length) return res.status(404).json({ success: false, message: 'SKU 不存在' });
        const rules = await store.runQuery('SELECT * FROM kc_pricing_rules WHERE plan_id=?', [id]);
        const breakdown = rules.map(r => ({ source: r.source, period: r.period, amount_cents: r.amount_cents, priority: r.priority, enabled: !!Number(r.enabled), valid_from: r.valid_from, valid_until: r.valid_until }));
        // 计算：取最高 priority + enabled 的 manual 价作为最终
        const candidates = rules.filter(r => Number(r.enabled) && pricingSourceNorm(r.source) !== 'entitlement');
        candidates.sort((a, b) => Number(b.priority) - Number(a.priority));
        const picked = candidates[0] || null;
        res.json({
            success: true,
            plan_id: id,
            plan_code: plan[0].code,
            final: picked ? { source: picked.source, period: picked.period, amount_cents: picked.amount_cents } : null,
            breakdown
        });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ⑦ 价格引擎 quote —— 公共给 Xboard 插件通过 BFF 代理调用（本期 Xboard 暂不改读，按 SP §9 阶段 3）
// 入参 {plan_code, user_id?, qty=1}；权益分支 R4 上；R2 仅 manual/promotion
async function priceQuote({ plan_code, user_id = null, qty = 1, trade_no = null }) {
    const plan = await store.runQuery('SELECT * FROM kc_plans WHERE code=? LIMIT 1', [plan_code]);
    if (!plan.length) return { success: false, message: 'plan_code 不存在：' + plan_code };
    const p = plan[0];
    const rules = await store.runQuery('SELECT * FROM kc_pricing_rules WHERE plan_id=? AND enabled=1', [p.id]);
    // 过滤有效期
    const now = new Date();
    const inWindow = r => (!r.valid_from || new Date(r.valid_from) <= now) && (!r.valid_until || new Date(r.valid_until) >= now);
    const candidates = rules.filter(inWindow);
    // 排序：priority DESC，再 manual 优先
    candidates.sort((a, b) => {
        if (Number(b.priority) !== Number(a.priority)) return Number(b.priority) - Number(a.priority);
        // 同 priority：manual > promotion > entitlement
        const rank = { manual: 0, promotion: 1, entitlement: 2 };
        return (rank[a.source] || 9) - (rank[b.source] || 9);
    });
    if (!candidates.length) return { success: false, message: '无可用资费规则' };
    const picked = candidates[0];
    const base = candidates.find(r => r.source === 'manual') || picked;
    const qtyN = Math.max(1, Number(qty) || 1);

    // v1.18.0 起 · 权益分支（R4）；v1.35.0 起改为读「权益报价」表（权益包 × 商品 一口价），
    // 与集成 quote 端点共用同一 helper；未配置该商品报价 → 不优惠（按原价）
    let bestEntCents = null;
    let bestEntRuleId = null;
    let bestEntGrantId = null;
    if (user_id) {
        try {
            const grants = await entitlementActiveGrants(user_id);
            const priceIndex = await loadEntitlementPrices(grants.map(g => g.rule_code));
            const bestEnt = pickBestEntitlementPrice(grants, priceIndex, Number(base.amount_cents), p.code, now);
            if (bestEnt != null) {
                bestEntCents = bestEnt.cents;
                bestEntRuleId = bestEnt.rule_code;
                bestEntGrantId = bestEnt.grant_id;
            }
        } catch (e) { /* 权益查询失败不阻塞 manual/promotion */ }
    }

    // 选最终价：manual/promotion 候选 picked 与 entitlement 候选比，价低者优
    let finalCents = Number(picked.amount_cents) * qtyN;
    let appliedSource = picked.source;
    let appliedRuleId = picked.id;
    let appliedGrantId = null;
    if (bestEntCents != null && bestEntCents < finalCents) {
        finalCents = bestEntCents * qtyN;
        appliedSource = 'entitlement';
        appliedRuleId = bestEntRuleId;
        appliedGrantId = bestEntGrantId;
    } else {
        finalCents = finalCents;
    }
    finalCents = Math.max(0, finalCents);
    // 落库 snapshot（如有 trade_no）
    if (trade_no) {
        try {
            await store.runExecute(
                'INSERT INTO kc_order_pricing_snapshot (trade_no, plan_id, base_price_cents, final_price_cents, applied_source, applied_rule_id, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE plan_id=VALUES(plan_id), base_price_cents=VALUES(base_price_cents), final_price_cents=VALUES(final_price_cents), applied_source=VALUES(applied_source), applied_rule_id=VALUES(applied_rule_id), snapshot_json=VALUES(snapshot_json)',
                [trade_no, p.id, Number(base.amount_cents), finalCents, appliedSource, appliedRuleId, JSON.stringify({
                    breakdown: candidates.map(r => ({ source: r.source, period: r.period, amount_cents: r.amount_cents, priority: r.priority })),
                    entitlement: appliedGrantId ? { grant_id: appliedGrantId, rule_code: appliedRuleId, base_cents: Number(base.amount_cents), final_cents: bestEntCents } : null
                })]
            );
        } catch (e) { /* snapshot 失败不阻塞报价 */ }
    }
    return {
        success: true,
        plan_id: p.id,
        plan_code: p.code,
        base_cents: Number(base.amount_cents),
        final_cents: finalCents,
        applied_source: appliedSource,
        applied_rule_id: appliedRuleId,
        applied_grant_id: appliedGrantId,
        qty: qtyN,
        breakdown: candidates.map(r => ({ source: r.source, period: r.period, amount_cents: r.amount_cents, priority: r.priority, picked: r.id === picked.id && appliedSource === r.source }))
    };
}
app.post('/api/pricing/quote', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const { plan_code, user_id, qty, trade_no } = req.body || {};
        if (!plan_code) return res.status(400).json({ success: false, message: 'plan_code 必填' });
        const out = await priceQuote({ plan_code, user_id, qty, trade_no });
        if (!out.success) return res.status(404).json(out);
        res.json(out);
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================================
// v1.18.0 · 权益 MVP（价格型，SP-2026-10-11-v1.0.1 §4.4 §R4）
// 路由：/api/admin/entitlements/...
// 入参归一化与 grant 生命周期函数；不直接修改积分
// ============================================================
function ruleCodeNorm(v) {
    if (!v) return null;
    return String(v).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
}
function ruleStatusNorm(v) { return ['draft', 'active', 'paused', 'expired'].includes(v) ? v : 'draft'; }
function discountTypeNorm(v) { return ['percent', 'fixed_cents', 'fixed_price_cents'].includes(v) ? v : 'percent'; }

function ruleNorm(body) {
    const code = ruleCodeNorm(body.code);
    if (!code) return { error: 'code 必填，且仅允许 a-z0-9_（最长 64）' };
    const display_name = String(body.display_name || code).slice(0, 128);
    let plan_scope = [];
    if (Array.isArray(body.plan_scope)) plan_scope = body.plan_scope.map(s => String(s)).filter(Boolean);
    else if (typeof body.plan_scope === 'string') {
        try { plan_scope = JSON.parse(body.plan_scope); } catch (e) { return { error: 'plan_scope 非法 JSON' }; }
    }
    const discount_type = discountTypeNorm(body.discount_type);
    const discount_value = Math.max(0, parseInt(body.discount_value, 10) || 0);
    const min_order_cents = Math.max(0, parseInt(body.min_order_cents, 10) || 0);
    const grant_uses = Math.max(0, parseInt(body.grant_uses, 10) || 1);
    const grant_period_days = Math.max(0, parseInt(body.grant_period_days, 10) || 30);
    const priority = parseInt(body.priority, 10) || 100;
    const status = ruleStatusNorm(body.status);
    const source = ['manual', 'purchase', 'event'].includes(body.source) ? body.source : 'manual';
    const trigger_plan_code = body.trigger_plan_code ? String(body.trigger_plan_code).slice(0, 64) : null;
    const valid_from = body.valid_from || null;
    const valid_until = body.valid_until || null;
    const note = String(body.note || '').slice(0, 255);
    if (discount_type === 'percent' && (discount_value < 0 || discount_value > 100)) return { error: 'percent 范围 0-100' };
    return { code, display_name, plan_scope: JSON.stringify(plan_scope), discount_type, discount_value, min_order_cents, grant_uses, grant_period_days, priority, status, source, trigger_plan_code, valid_from, valid_until, note };
}

// 列出规则
app.get('/api/admin/entitlements/rules', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const status = req.query.status;
        const rows = status
            ? await store.runQuery('SELECT * FROM kc_entitlement_rules WHERE status=? ORDER BY priority DESC, id DESC', [status])
            : await store.runQuery('SELECT * FROM kc_entitlement_rules ORDER BY priority DESC, id DESC');
        const out = rows.map(r => {
            let plan_scope = [];
            try { plan_scope = typeof r.plan_scope === 'string' ? JSON.parse(r.plan_scope) : (r.plan_scope || []); } catch (e) { plan_scope = []; }
            return { ...r, plan_scope };
        });
        res.json({ success: true, data: out });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 新建规则
app.post('/api/admin/entitlements/rules', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const n = ruleNorm(req.body || {});
        if (n.error) return res.status(400).json({ success: false, message: n.error });
        try {
            const result = await store.runExecute(
                'INSERT INTO kc_entitlement_rules (code, display_name, plan_scope, discount_type, discount_value, min_order_cents, grant_uses, grant_period_days, priority, status, source, trigger_plan_code, valid_from, valid_until, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [n.code, n.display_name, n.plan_scope, n.discount_type, n.discount_value, n.min_order_cents, n.grant_uses, n.grant_period_days, n.priority, n.status, n.source, n.trigger_plan_code, n.valid_from, n.valid_until, n.note]
            );
            res.json({ success: true, data: { id: result.insertId, code: n.code } });
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'code 已存在' });
            throw e;
        }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 编辑规则
app.patch('/api/admin/entitlements/rules/:code', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const code = req.params.code;
        const n = ruleNorm({ ...(req.body || {}), code });
        if (n.error) return res.status(400).json({ success: false, message: n.error });
        await store.runExecute(
            'UPDATE kc_entitlement_rules SET display_name=?, plan_scope=?, discount_type=?, discount_value=?, min_order_cents=?, grant_uses=?, grant_period_days=?, priority=?, status=?, source=?, trigger_plan_code=?, valid_from=?, valid_until=?, note=? WHERE code=?',
            [n.display_name, n.plan_scope, n.discount_type, n.discount_value, n.min_order_cents, n.grant_uses, n.grant_period_days, n.priority, n.status, n.source, n.trigger_plan_code, n.valid_from, n.valid_until, n.note, code]
        );
        res.json({ success: true, data: { code } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================================
// v1.35.0 · 权益报价（权益包 × 商品 一口价）—— Step 8 后台维护入口
// 路由：/api/admin/entitlements/prices
// 语义：每个权益包对每个商品可配置独立一口价；未配置 = 按原价（不优惠）
// ============================================================
// 取商品「我方原价」（分）：与前台 #/plan / 首页同口径 —— 按周期顺序取第一个 >0 的价 ×100
// 注意：v2_plan.prices 存的是「主单位」（如 {"monthly":15} = $15），Xboard 出 API 时 ×100 转成分
const EP_PERIOD_ORDER = ['monthly', 'quarterly', 'half_yearly', 'yearly', 'two_yearly', 'three_yearly', 'onetime'];
function entitlementListPriceCents(pricesRaw) {
    try {
        const p = typeof pricesRaw === 'string' ? JSON.parse(pricesRaw) : pricesRaw;
        if (!p || typeof p !== 'object' || Array.isArray(p)) return 0;
        for (const k of EP_PERIOD_ORDER) { const v = Number(p[k]); if (v > 0) return Math.round(v * 100); }
    } catch (e) { /* ignore */ }
    return 0;
}

app.get('/api/admin/entitlements/prices', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rule_code = String(req.query.rule_code || '').trim().slice(0, 64);
        const packs = await store.runQuery('SELECT code, display_name FROM kc_entitlement_rules WHERE status=? ORDER BY priority DESC, id DESC', ['active']);
        const priceMap = {};
        if (rule_code) {
            const cur = await store.runQuery('SELECT plan_code, price_cents FROM kc_entitlement_prices WHERE rule_code=? AND status=?', [rule_code, 'active']);
            cur.forEach(r => { priceMap[String(r.plan_code)] = Number(r.price_cents); });
        }
        const rows = await store.runQuery(
            'SELECT k.code AS plan_code, COALESCE(NULLIF(p.name, ""), k.display_name, k.code) AS name, p.prices AS prices ' +
            'FROM kc_plans k LEFT JOIN xboard.v2_plan p ON p.id = CAST(SUBSTRING(k.code, 7) AS UNSIGNED) ' +
            'WHERE k.code REGEXP "^xplan_[0-9]+$" AND (k.status IS NULL OR k.status <> ?) ORDER BY k.code ASC',
            ['archived']
        );
        const products = rows.map(r => {
            const pc = priceMap[String(r.plan_code)];
            return { plan_code: String(r.plan_code), name: String(r.name || r.plan_code), list_price_cents: entitlementListPriceCents(r.prices), price_cents: pc != null ? pc : null };
        });
        res.json({ success: true, data: { rule_code, packs: packs.map(p => ({ code: p.code, display_name: p.display_name || p.code })), products } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 批量保存某权益包的逐商品报价：price_cents 为空/null → 删除该行（= 未配置 = 原价）
app.post('/api/admin/entitlements/prices', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const rule_code = String(body.rule_code || '').trim().slice(0, 64);
        if (!rule_code) return res.status(400).json({ success: false, message: 'rule_code 必填' });
        const ruleRows = await store.runQuery('SELECT code FROM kc_entitlement_rules WHERE code=? LIMIT 1', [rule_code]);
        if (!ruleRows.length) return res.status(400).json({ success: false, message: '权益包不存在：' + rule_code });
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) return res.status(400).json({ success: false, message: 'items 不能为空' });
        if (items.length > 200) return res.status(400).json({ success: false, message: 'items 最多 200 条' });
        let saved = 0, cleared = 0;
        for (const it of items) {
            const planCode = String(it.plan_code || '').trim().slice(0, 64);
            if (!/^xplan_[0-9]+$/.test(planCode)) return res.status(400).json({ success: false, message: '非法 plan_code：' + planCode });
            const raw = it.price_cents;
            if (raw == null || raw === '') {
                await store.runExecute('DELETE FROM kc_entitlement_prices WHERE rule_code=? AND plan_code=?', [rule_code, planCode]);
                cleared++;
                continue;
            }
            const cents = Math.floor(Number(raw));
            if (!(cents > 0)) return res.status(400).json({ success: false, message: '报价必须为正数：' + planCode });
            await store.runExecute(
                'INSERT INTO kc_entitlement_prices (rule_code, plan_code, price_cents, status) VALUES (?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE price_cents=VALUES(price_cents), status=VALUES(status)',
                [rule_code, planCode, cents, 'active']
            );
            saved++;
        }
        res.json({ success: true, data: { rule_code, saved, cleared } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 给 user 授权（手动或自动发权益共用入口）
async function entitlementGrantIssue(user_id, rule_code, source = 'manual', source_ref = '', note = '') {
    await ensureStoreReady();
    const ruleRows = await store.runQuery('SELECT * FROM kc_entitlement_rules WHERE code=? AND status=? LIMIT 1', [rule_code, 'active']);
    if (!ruleRows.length) return { success: false, message: '规则不存在或未启用：' + rule_code };
    const rule = ruleRows[0];
    const total_uses = rule.grant_uses;
    const expires_at = rule.grant_period_days > 0 ? new Date(Date.now() + rule.grant_period_days * 86400000) : null;
    // INSERT IGNORE 防并发同 user 同规则同 status 多发
    const r = await store.runExecute(
        'INSERT IGNORE INTO kc_entitlement_grants (user_id, rule_code, source, source_ref, remaining_uses, total_uses, expires_at, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [user_id, rule_code, source, source_ref, total_uses, total_uses, expires_at, 'active', note]
    );
    // 同 status 已有则 reused
    if (r.affectedRows === 0) {
        return { success: true, reused: true, rule_code, user_id };
    }
    return { success: true, reused: false, grant_id: r.insertId, rule_code, user_id, total_uses, expires_at };
}

app.post('/api/admin/entitlements/rules/:code/issue', requireSecondaryAuth, async (req, res) => {
    try {
        const { user_id, source_ref, note } = req.body || {};
        if (!user_id) return res.status(400).json({ success: false, message: 'user_id 必填' });
        const out = await entitlementGrantIssue(parseInt(user_id, 10), req.params.code, 'manual', source_ref || '', note || '');
        res.json(out);
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 撤销 grant（管理员手动）
app.post('/api/admin/entitlements/grants/:id/revoke', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, message: 'id 必填' });
        await store.runExecute("UPDATE kc_entitlement_grants SET status='revoked' WHERE id=? AND status='active'", [id]);
        res.json({ success: true, data: { id } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 查某 user 的 grants
// v1.28.2 · 邮箱 → Xboard user_id 查询（运营不记得数字 ID，权益查询/发放按邮箱定位用户）
app.get('/api/admin/entitlements/user-lookup', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const email = String(req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ success: false, message: 'email 必填' });
        const rows = await store.runQuery(
            'SELECT id, email FROM xboard.v2_user WHERE LOWER(email)=? ORDER BY id ASC LIMIT 5',
            [email]
        );
        res.json({ success: true, data: rows.map(r => ({ user_id: r.id, email: r.email })) });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/admin/entitlements/grants', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const user_id = parseInt(req.query.user_id, 10);
        if (!user_id) return res.status(400).json({ success: false, message: 'user_id 必填' });
        const rows = await store.runQuery(
            "SELECT g.*, r.display_name, r.discount_type, r.discount_value, r.min_order_cents, r.priority, r.plan_scope FROM kc_entitlement_grants g JOIN kc_entitlement_rules r ON r.code=g.rule_code WHERE g.user_id=? ORDER BY g.created_at DESC",
            [user_id]
        );
        const out = rows.map(g => {
            let plan_scope = [];
            try { plan_scope = typeof g.plan_scope === 'string' ? JSON.parse(g.plan_scope) : (g.plan_scope || []); } catch (e) { plan_scope = []; }
            return { ...g, plan_scope };
        });
        res.json({ success: true, data: out });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 扣次（订单用：R4 阶段手动触发，R5 改为集成回调自动）
async function entitlementConsume({ grant_id, user_id, order_trade_no, plan_code, original_cents, final_cents }) {
    await ensureStoreReady();
    const discount_cents = Math.max(0, original_cents - final_cents);
    // 幂等：同 grant 同 trade_no 不重复扣
    const r = await store.runExecute(
        'INSERT IGNORE INTO kc_entitlement_uses (grant_id, user_id, rule_code, order_trade_no, plan_code, original_cents, final_cents, discount_cents) SELECT id, user_id, rule_code, ?, ?, ?, ?, ? FROM kc_entitlement_grants WHERE id=? AND status=? LIMIT 1',
        [order_trade_no, plan_code, original_cents, final_cents, discount_cents, grant_id, 'active']
    );
    if (r.affectedRows === 0) return { success: true, reused: true };
    // 扣剩余次数（0=无限则不扣）
    await store.runExecute('UPDATE kc_entitlement_grants SET remaining_uses = CASE WHEN remaining_uses > 0 THEN remaining_uses - 1 ELSE remaining_uses END WHERE id=?', [grant_id]);
    // 扣到 0 标记 exhausted
    await store.runExecute("UPDATE kc_entitlement_grants SET status='exhausted' WHERE id=? AND remaining_uses=0 AND status='active'", [grant_id]);
    return { success: true, reused: false };
}

// ============================================================
// v1.17.0 · 商品展示层（独立于 v2_plan.kc_card，SP-2026-10-11-v1.0.1 §4.3）
// ============================================================
function listingStateNorm(v) { return ['onsale', 'featured', 'soon', 'soldout', 'manual'].includes(v) ? v : 'onsale'; }
function listingCardRow(c, plan) {
    let parsed = {};
    try { parsed = typeof c.card_json === 'string' ? JSON.parse(c.card_json) : (c.card_json || {}); } catch (e) { parsed = {}; }
    return {
        plan_id: c.plan_id,
        plan_code: plan && plan.code,
        plan_name: plan && plan.display_name,
        is_visible: !!Number(c.is_visible),
        listing_state: c.listing_state,
        sort: c.sort,
        card: parsed,
        updated_at: c.updated_at
    };
}

// ① 列出所有 SKU 的展示卡（用 kc_plans 视角，无卡显示默认）
app.get('/api/admin/listing-cards', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const plans = await store.runQuery('SELECT id, code, display_name, kc_type FROM kc_plans ORDER BY status ASC, code ASC');
        const cards = await store.runQuery('SELECT * FROM kc_listing_cards');
        const cmap = {}; cards.forEach(c => { cmap[c.plan_id] = c; });
        res.json({
            items: plans.map(p => listingCardRow(cmap[p.id] || {
                plan_id: p.id, card_json: JSON.stringify(cardDefault()),
                is_visible: 1, listing_state: 'onsale', sort: 0
            }, p))
        });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ② 保存（upsert by plan_id）
app.put('/api/admin/listing-cards/:plan_id', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const pid = Number(req.params.plan_id);
        if (!pid) return res.status(400).json({ success: false, message: 'plan_id 非法' });
        const plan = await store.runQuery('SELECT id FROM kc_plans WHERE id=? LIMIT 1', [pid]);
        if (!plan.length) return res.status(404).json({ success: false, message: 'SKU 不存在' });
        const body = req.body || {};
        const card = cardNorm(body.card || {});
        const card_json = JSON.stringify(card);
        const is_visible = body.is_visible === false ? 0 : 1;
        const listing_state = listingStateNorm(body.listing_state);
        const sort = Math.floor(Number(body.sort) || 0);
        // INSERT ... ON DUPLICATE KEY UPDATE 幂等
        await store.runExecute(
            'INSERT INTO kc_listing_cards (plan_id, card_json, is_visible, listing_state, sort) VALUES (?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE card_json=VALUES(card_json), is_visible=VALUES(is_visible), listing_state=VALUES(listing_state), sort=VALUES(sort)',
            [pid, card_json, is_visible, listing_state, sort]
        );
        res.json({ success: true, message: '已保存（前台刷新即生效；双轨期内可 sync 到 v2_plan.kc_card）', card });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ③ 可见性开关（独立于卡片内容）
app.post('/api/admin/listing-cards/:plan_id/visibility', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const pid = Number(req.params.plan_id);
        if (!pid) return res.status(400).json({ success: false, message: 'plan_id 非法' });
        const body = req.body || {};
        const is_visible = body.is_visible === false ? 0 : 1;
        const r = await store.runExecute(
            'UPDATE kc_listing_cards SET is_visible=? WHERE plan_id=?', [is_visible, pid]
        );
        if (!r || (r.affectedRows === 0)) {
            await store.runExecute(
                'INSERT INTO kc_listing_cards (plan_id, card_json, is_visible, listing_state, sort) VALUES (?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE is_visible=VALUES(is_visible)',
                [pid, JSON.stringify(cardDefault()), is_visible, 'onsale', 0]
            );
        }
        res.json({ success: true, message: '可见性已切换' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ④ 反向同步到 v2_plan.kc_card（双轨兜底：让插件立即读到新配置；R3 终极方案是改插件读法）
// ─── v1.24.0 · 商品管理 MVP（SP-2026-10-13 精简执行：一个页面配商品，保存即同步商城）───
// 数据口径：商城主数据在 xboard.v2_plan（name/prices/show/sell/kc_card/content）；
// KC 侧 kc_plans 承载货源绑定与 API 分销配置（配置存储，对外接口 v2 启用）。
const PRODUCT_UPSTREAM_KEY_WHITELIST = ['plus', 'pro_5x', 'pro_20x']; // 与插件自动发卡白名单一致

function productParsePrices(pricesRaw) {
    try {
        const p = typeof pricesRaw === 'string' ? JSON.parse(pricesRaw) : pricesRaw;
        if (p && typeof p === 'object' && !Array.isArray(p)) {
            if (p.monthly != null) return { period: 'monthly', price: Number(p.monthly) || 0 };
            if (p.onetime != null) return { period: 'onetime', price: Number(p.onetime) || 0 };
            const keys = Object.keys(p);
            if (keys.length) return { period: String(keys[0]), price: Number(p[keys[0]]) || 0 };
        }
    } catch (e) { /* ignore */ }
    return { period: 'monthly', price: 0 };
}
function productCardOf(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { return null; } }
    return typeof raw === 'object' ? raw : null;
}

// 商品列表（v2_plan 主 + kc_plans 关联）
app.get('/api/admin/products', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery(
            'SELECT p.id, p.name, p.prices, p.`show`, p.sell, p.sort, p.content, p.kc_card, p.kc_is_topup, p.kc_topup_amount, ' +
            '       k.upstream_code, k.upstream_plan_key, k.status AS kc_status, k.api_enabled, k.api_markup_percent ' +
            'FROM xboard.v2_plan p ' +
            "LEFT JOIN kc_plans k ON k.code = CONCAT('xplan_', p.id) " +
            'ORDER BY (p.sort IS NULL) ASC, p.sort ASC, p.id ASC'
        );
        const list = rows.map(function (r) {
            const pp = productParsePrices(r.prices);
            const card = productCardOf(r.kc_card) || {};
            return {
                plan_id: r.id,
                name: r.name,
                period: pp.period,
                price: pp.price,
                show: Number(r.show) === 1,
                sell: Number(r.sell) === 1,
                sort: r.sort == null ? null : Number(r.sort),
                content: r.content || '',
                subtitle: card.subtitle || '',
                is_topup: Number(r.kc_is_topup) === 1,
                upstream_code: r.upstream_code || '',
                upstream_plan_key: r.upstream_plan_key || '',
                api_enabled: Number(r.api_enabled) === 1,
                api_markup_percent: Number(r.api_markup_percent) || 0
            };
        });
        res.json({ success: true, data: list });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 商品保存（聚合）：v2_plan + kc_plans + 资费规则 + 卡片 + 插件映射 —— 保存即同步商城
app.post('/api/admin/products/save', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const b = req.body || {};
        const name = String(b.name || '').trim();
        if (!name) return res.status(400).json({ success: false, message: '商品名称必填' });
        const period = b.period === 'onetime' ? 'onetime' : 'monthly';
        const price = Number(b.price);
        if (!(price > 0)) return res.status(400).json({ success: false, message: '售价必须大于 0' });
        const show = b.show ? 1 : 0;
        const sell = b.sell ? 1 : 0;
        const content = String(b.content || '').trim();
        const subtitle = String(b.subtitle || '').trim();
        const sortIn = Number(b.sort);
        const sort = Number.isFinite(sortIn) ? sortIn : 999;
        const upstreamCode = String(b.upstream_code || '').trim();
        const upstreamKey = String(b.upstream_plan_key || '').trim();
        if (upstreamKey && PRODUCT_UPSTREAM_KEY_WHITELIST.indexOf(upstreamKey) < 0) {
            return res.status(400).json({ success: false, message: '货源仅支持 ' + PRODUCT_UPSTREAM_KEY_WHITELIST.join(' / ') + '（与自动发卡白名单一致）' });
        }
        const apiEnabled = b.api_enabled ? 1 : 0;
        const apiMarkup = Math.max(0, Math.min(500, Number(b.api_markup_percent) || 0));

        const pricesJson = JSON.stringify(period === 'onetime' ? { onetime: price } : { monthly: price });
        const nowSec = Math.floor(Date.now() / 1000);
        let planId = parseInt(b.plan_id, 10) || 0;
        const isTopup = !upstreamKey && Number(b.is_topup) === 1;

        if (planId > 0) {
            const rows = await store.runQuery('SELECT id, kc_card, kc_is_topup, kc_topup_amount FROM xboard.v2_plan WHERE id=? LIMIT 1', [planId]);
            if (!rows.length) return res.status(404).json({ success: false, message: '商品不存在：' + planId });
            const cur = rows[0];
            const card = productCardOf(cur.kc_card) || {};
            card.subtitle = subtitle;
            const curTopup = Number(cur.kc_is_topup) === 1;
            await store.runExecute(
                'UPDATE xboard.v2_plan SET name=?, prices=?, `show`=?, sell=?, sort=?, content=?, kc_card=?, kc_topup_amount=?, updated_at=? WHERE id=?',
                [name, pricesJson, show, sell, sort, content, JSON.stringify(card),
                 curTopup ? Math.round(price * 100) : (Number(cur.kc_topup_amount) || 0), nowSec, planId]
            );
        } else {
            const card = {
                state: show ? 'onsale' : 'soon',
                badge: { text: '', pos: 'left', color: 'brand' },
                title: '', subtitle: subtitle,
                price: { mode: 'auto', value: null, unit: period === 'onetime' ? '' : '/月', tag: '' },
                promo: { strike: '', text: '' },
                features: [], guarantees: [], tip: '',
                button: { text: '立即办理', style: 'solid' },
                category: 'recharge'
            };
            const result = await store.runExecute(
                'INSERT INTO xboard.v2_plan (name, prices, `show`, sell, sort, group_id, transfer_enable, renew, kc_is_topup, kc_topup_amount, kc_card, content, created_at, updated_at) ' +
                'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
                [name, pricesJson, show, sell, sort, isTopup ? 0 : 100, isTopup ? 0 : 1,
                 isTopup ? 1 : 0, isTopup ? Math.round(price * 100) : 0, JSON.stringify(card), content, nowSec, nowSec]
            );
            planId = result && result.insertId ? Number(result.insertId) : 0;
            if (!planId) return res.status(500).json({ success: false, message: '创建商品失败（未取得 insertId）' });
        }

        // KC 侧：kc_plans（货源与 API 配置）
        await store.runExecute(
            'INSERT INTO kc_plans (code, kc_type, display_name, upstream_code, upstream_plan_key, status, api_enabled, api_markup_percent, note) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), upstream_code=VALUES(upstream_code), upstream_plan_key=VALUES(upstream_plan_key), ' +
            'status=VALUES(status), api_enabled=VALUES(api_enabled), api_markup_percent=VALUES(api_markup_percent), updated_at=CURRENT_TIMESTAMP',
            ['xplan_' + planId, 'recharge', name, upstreamCode, upstreamKey, sell ? 'active' : 'paused', apiEnabled, apiMarkup, 'v1.24.0 商品管理保存']
        );

        // KC 侧：manual 资费规则整体替换
        const kcRows = await store.runQuery('SELECT id FROM kc_plans WHERE code=? LIMIT 1', ['xplan_' + planId]);
        if (kcRows.length) {
            const kcPlanId = kcRows[0].id;
            await store.runExecute("DELETE FROM kc_pricing_rules WHERE plan_id=? AND source='manual'", [kcPlanId]);
            await store.runExecute(
                'INSERT INTO kc_pricing_rules (plan_id, source, period, amount_cents, priority, enabled, note) VALUES (?, ?, ?, ?, 0, 1, ?)',
                [kcPlanId, 'manual', period === 'onetime' ? 'onetime' : 'month', Math.round(price * 100), 'v1.24.0 商品管理保存']
            );
        }

        // KC 侧：listing_cards（仅更新已存在行）
        try {
            const cardRows = await store.runQuery('SELECT kc_card FROM xboard.v2_plan WHERE id=? LIMIT 1', [planId]);
            const cardJson = cardRows.length ? (productCardOf(cardRows[0].kc_card) || {}) : {};
            await store.runExecute('UPDATE kc_listing_cards SET card_json=?, updated_at=CURRENT_TIMESTAMP WHERE plan_id=?', [JSON.stringify(cardJson), planId]);
        } catch (e) { /* 卡片行不存在时忽略 */ }

        // Xboard 插件映射（packages）：订阅类商品确保 plan_id → plan_type 可自动发卡
        if (upstreamKey) {
            try {
                const plugins = await store.runQuery("SELECT id, config FROM xboard.v2_plugins WHERE code='kc_integration' LIMIT 1");
                if (plugins.length) {
                    let cfg = plugins[0].config;
                    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (e) { cfg = {}; } }
                    cfg = cfg && typeof cfg === 'object' ? cfg : {};
                    let pk = cfg.packages;
                    if (typeof pk === 'string') { try { pk = JSON.parse(pk); } catch (e) { pk = {}; } }
                    pk = pk && typeof pk === 'object' ? pk : {};
                    pk[String(planId)] = upstreamKey;
                    cfg.packages = JSON.stringify(pk);
                    await store.runExecute('UPDATE xboard.v2_plugins SET config=?, updated_at=NOW() WHERE id=?', [JSON.stringify(cfg), plugins[0].id]);
                }
            } catch (e) { /* 映射写失败不阻塞商品保存 */ }
        }

        res.json({ success: true, message: '已保存并同步商城', data: { plan_id: planId } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ─── v1.25.0 · 对外分销 API + API 客户管理（UX-5/6，SP-2026-10-13-API-v1.0.0 精简执行）──
// 对外面：/api/open/v1/*（下游客户，API Key + HMAC 签名 + 时间戳 + 限流 + 预充值余额）
// 管理面：/api/admin/api-clients/*（运营，requireSecondaryAuth）
// 履约：复用 store.issueCdkByRef（Zovo Mock 发卡），ref=内部单号；下单同步返回卡密。

const OPEN_API_RATE_WINDOW_MS = 60 * 1000;
const OPEN_API_DEFAULT_LIMIT = Number(process.env.OPEN_API_RATE_LIMIT || 120);
const OPEN_API_TS_WINDOW_SEC = 300;
const OPEN_API_QUOTE_TTL_MS = 60 * 1000;
const OPEN_API_PRICE_DRIFT_TOLERANCE = 0.03;
const openApiRateBuckets = new Map(); // clientId -> { windowStart, count }

function openApiSign(secret, method, path, timestamp, rawBody) {
    const bodyHash = crypto.createHash('sha256').update(rawBody || Buffer.alloc(0)).digest('hex');
    const canonical = String(method).toUpperCase() + '\n' + path + '\n' + String(timestamp) + '\n' + bodyHash;
    return crypto.createHmac('sha256', String(secret)).update(canonical).digest('hex');
}
function openApiSafeEq(a, b) {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
async function requireOpenApiAuth(req, res, next) {
    try {
        await ensureStoreReady();
        const key = String(req.headers['x-api-key'] || '').trim();
        const ts = String(req.headers['x-timestamp'] || '').trim();
        const sig = String(req.headers['x-signature'] || '').trim().toLowerCase();
        if (!key || !ts || !sig) {
            return res.status(401).json({ success: false, code: 'INVALID_SIGNATURE', message: '缺少鉴权头（X-Api-Key / X-Timestamp / X-Signature）' });
        }
        const tsNum = Number(ts);
        if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > OPEN_API_TS_WINDOW_SEC) {
            return res.status(401).json({ success: false, code: 'TIMESTAMP_EXPIRED', message: '时间戳超出 5 分钟窗口（防重放）' });
        }
        const rows = await store.runQuery('SELECT * FROM kc_api_clients WHERE api_key=? LIMIT 1', [key]);
        if (!rows.length) {
            return res.status(401).json({ success: false, code: 'INVALID_KEY', message: 'API Key 无效' });
        }
        const client = rows[0];
        if (client.status !== 'active') {
            return res.status(403).json({ success: false, code: 'CLIENT_DISABLED', message: '客户已停用' });
        }
        const expect = openApiSign(client.api_secret, req.method, req.path, ts, req.rawBody);
        if (!openApiSafeEq(expect, sig)) {
            return res.status(401).json({ success: false, code: 'INVALID_SIGNATURE', message: '签名校验失败' });
        }
        const nowMs = Date.now();
        let bucket = openApiRateBuckets.get(client.id);
        if (!bucket || nowMs - bucket.windowStart > OPEN_API_RATE_WINDOW_MS) {
            bucket = { windowStart: nowMs, count: 0 };
            openApiRateBuckets.set(client.id, bucket);
        }
        bucket.count += 1;
        const limit = Number(client.rate_limit) > 0 ? Number(client.rate_limit) : OPEN_API_DEFAULT_LIMIT;
        if (bucket.count > limit) {
            return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: '请求过于频繁（' + limit + ' 次/分钟）' });
        }
        req.openApiClient = client;
        next();
    } catch (error) {
        res.status(500).json({ success: false, code: 'INTERNAL', message: error.message });
    }
}

function openApiQuotePrice(costCents, markupPercent) {
    const pct = Number(markupPercent) || 0;
    return Math.max(0, Math.round(Number(costCents) || 0) * (100 + pct) / 100);
}
async function openApiFindSku(sku) {
    const rows = await store.runQuery(
        'SELECT k.*, u.upstream_price_cents FROM kc_plans k ' +
        'LEFT JOIN kc_upstream_plans u ON u.upstream_code = k.upstream_code AND u.upstream_plan_key = k.upstream_plan_key ' +
        'WHERE k.code = ? LIMIT 1', [sku]
    );
    return rows.length ? rows[0] : null;
}
function openApiSkuAvailable(plan, costCents) {
    return Number(plan.api_enabled) === 1 &&
        !!plan.upstream_plan_key &&
        PRODUCT_UPSTREAM_KEY_WHITELIST.indexOf(String(plan.upstream_plan_key)) >= 0 &&
        (Number(costCents) || 0) > 0;
}
function openApiUsd(cents) { return Number(((Number(cents) || 0) / 100).toFixed(2)); }

// 1) 商品目录（含当前报价）
app.get('/api/open/v1/catalog', requireOpenApiAuth, async (req, res) => {
    try {
        const rows = await store.runQuery(
            'SELECT k.code, k.display_name, k.upstream_code, k.upstream_plan_key, k.api_enabled, k.api_markup_percent, u.upstream_price_cents ' +
            'FROM kc_plans k LEFT JOIN kc_upstream_plans u ON u.upstream_code = k.upstream_code AND u.upstream_plan_key = k.upstream_plan_key ' +
            'WHERE k.api_enabled = 1 ORDER BY k.id'
        );
        const items = rows.map(function (r) {
            const cost = Number(r.upstream_price_cents) || 0;
            const avail = openApiSkuAvailable(r, cost);
            return {
                sku: r.code,
                name: r.display_name,
                currency: 'USD',
                deliver: 'card',
                available: avail,
                price: avail ? openApiUsd(openApiQuotePrice(cost, r.api_markup_percent)) : null
            };
        });
        res.json({ success: true, data: items });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// 2) 报价（锁价 60 秒）
app.post('/api/open/v1/quote', requireOpenApiAuth, async (req, res) => {
    try {
        const sku = String((req.body || {}).sku || '').trim();
        const qty = Math.max(1, Math.min(100, parseInt((req.body || {}).qty, 10) || 1));
        if (!sku) return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: '缺少 sku' });
        const plan = await openApiFindSku(sku);
        if (!plan) return res.status(404).json({ success: false, code: 'SKU_NOT_FOUND', message: '商品不存在：' + sku });
        const cost = Number(plan.upstream_price_cents) || 0;
        if (!openApiSkuAvailable(plan, cost)) {
            return res.status(409).json({ success: false, code: 'SKU_UNAVAILABLE', message: '该商品当前不可售（未开启 API 分销或上游成本未配置）' });
        }
        const unit = openApiQuotePrice(cost, plan.api_markup_percent);
        const total = unit * qty;
        const quoteId = 'q_' + crypto.randomBytes(8).toString('hex');
        const expiresAt = new Date(Date.now() + OPEN_API_QUOTE_TTL_MS);
        await store.runExecute(
            'INSERT INTO kc_api_quote_logs (client_id, quote_id, sku_code, cost_cents, markup_percent, unit_price_cents, qty, total_cents, expires_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [req.openApiClient.id, quoteId, sku, cost, Number(plan.api_markup_percent) || 0, unit, qty, total, expiresAt]
        );
        res.json({
            success: true,
            data: {
                quote_id: quoteId, sku: sku, qty: qty,
                unit_price: openApiUsd(unit), total: openApiUsd(total), currency: 'USD',
                cost_basis: openApiUsd(cost),
                expires_at: expiresAt.toISOString(), expires_in: 60
            }
        });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// 3) 下单（幂等 + 锁价校验 + 余额原子扣减 + 履约同步发卡）
app.post('/api/open/v1/orders', requireOpenApiAuth, async (req, res) => {
    try {
        const b = req.body || {};
        const clientOrderNo = String(b.client_order_no || '').trim();
        const quoteId = String(b.quote_id || '').trim();
        if (!clientOrderNo || clientOrderNo.length > 64) {
            return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: 'client_order_no 必填且 ≤64 字符（幂等键）' });
        }
        if (!quoteId) return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: '缺少 quote_id' });

        // 幂等：同客户同单号直接回原单
        const dup = await store.runQuery('SELECT * FROM kc_api_orders WHERE client_id=? AND client_order_no=? LIMIT 1', [req.openApiClient.id, clientOrderNo]);
        if (dup.length) {
            const d = dup[0];
            return res.json({
                success: true,
                data: { order_id: d.our_order_no, status: d.status, amount: openApiUsd(d.amount_cents), currency: 'USD', cdk: d.cdk || null, reused: true }
            });
        }

        const qRows = await store.runQuery('SELECT * FROM kc_api_quote_logs WHERE quote_id=? AND client_id=? LIMIT 1', [quoteId, req.openApiClient.id]);
        if (!qRows.length) return res.status(404).json({ success: false, code: 'QUOTE_NOT_FOUND', message: '报价不存在' });
        const q = qRows[0];
        if (q.consumed_order_id) return res.status(409).json({ success: false, code: 'QUOTE_CONSUMED', message: '报价已被使用' });
        if (new Date(q.expires_at).getTime() < Date.now()) {
            return res.status(409).json({ success: false, code: 'QUOTE_EXPIRED', message: '报价已过期（60 秒），请重新报价' });
        }

        // 成本变动容忍（3%）
        const plan = await openApiFindSku(q.sku_code);
        const curCost = plan ? (Number(plan.upstream_price_cents) || 0) : 0;
        const baseCost = Number(q.cost_cents) || 0;
        const drift = baseCost > 0 ? Math.abs(curCost - baseCost) / baseCost : 1;
        if (drift > OPEN_API_PRICE_DRIFT_TOLERANCE || !plan || !openApiSkuAvailable(plan, curCost)) {
            const newUnit = plan && curCost > 0 ? openApiQuotePrice(curCost, plan.api_markup_percent) : null;
            return res.status(409).json({
                success: false, code: 'PRICE_CHANGED',
                message: '价格已更新（成本自报价后变动 ' + (drift * 100).toFixed(1) + '% > 3%），请重新报价',
                data: { new_unit_price: newUnit === null ? null : openApiUsd(newUnit) }
            });
        }

        const amount = Number(q.total_cents) || 0;
        const deducted = await store.runExecute(
            'UPDATE kc_api_clients SET balance_cents = balance_cents - ? WHERE id=? AND balance_cents >= ?',
            [amount, req.openApiClient.id, amount]
        );
        if (!deducted || Number(deducted.affectedRows) === 0) {
            return res.status(402).json({ success: false, code: 'INSUFFICIENT_BALANCE', message: '预充值余额不足' });
        }

        const ourOrderNo = 'api_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
        try {
            const [balRow] = await store.runQuery('SELECT balance_cents FROM kc_api_clients WHERE id=? LIMIT 1', [req.openApiClient.id]);
            if (balRow) {
                await store.runExecute(
                    'INSERT INTO kc_api_balance_ledger (client_id, change_cents, balance_after_cents, type, ref, note) VALUES (?, ?, ?, ?, ?, ?)',
                    [req.openApiClient.id, -amount, balRow.balance_cents, 'consume', ourOrderNo, '下单 ' + clientOrderNo]
                );
            }
        } catch (le) { /* 流水失败不阻塞订单 */ }
        let cdk = '';
        let status = 'created';
        let failReason = '';
        try {
            const result = await store.issueCdkByRef(ourOrderNo, {
                planType: String(plan.upstream_plan_key),
                source: 'open_api',
                orderId: null,
                userRef: 'client:' + req.openApiClient.code,
                createCdks: createCdks
            });
            cdk = result && result.cdk ? String(result.cdk) : '';
            status = cdk ? 'delivered' : 'failed';
        } catch (e) {
            status = 'failed';
            failReason = String((e && e.message) || e).slice(0, 200);
            await store.runExecute('UPDATE kc_api_clients SET balance_cents = balance_cents + ? WHERE id=?', [amount, req.openApiClient.id]).catch(function () { });
            try {
                const [balRow2] = await store.runQuery('SELECT balance_cents FROM kc_api_clients WHERE id=? LIMIT 1', [req.openApiClient.id]);
                if (balRow2) {
                    await store.runExecute(
                        'INSERT INTO kc_api_balance_ledger (client_id, change_cents, balance_after_cents, type, ref, note) VALUES (?, ?, ?, ?, ?, ?)',
                        [req.openApiClient.id, amount, balRow2.balance_cents, 'refund', ourOrderNo, '履约失败退回 ' + clientOrderNo]
                    );
                }
            } catch (le2) { /* 流水失败不阻塞回滚 */ }
        }

        const ins = await store.runExecute(
            'INSERT INTO kc_api_orders (client_id, client_order_no, our_order_no, sku_code, qty, quote_id, cost_cents, unit_price_cents, amount_cents, status, cdk, fail_reason) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [req.openApiClient.id, clientOrderNo, ourOrderNo, q.sku_code, q.qty, quoteId, curCost, q.unit_price_cents, amount, status, cdk, failReason]
        );
        await store.runExecute('UPDATE kc_api_quote_logs SET consumed_order_id=? WHERE id=?', [ins.insertId, q.id]);

        if (status !== 'delivered') {
            return res.status(502).json({ success: false, code: 'FULFILL_FAILED', message: '履约失败（余额已退回）：' + failReason });
        }
        res.json({
            success: true,
            data: { order_id: ourOrderNo, status: status, amount: openApiUsd(amount), currency: 'USD', cdk: cdk }
        });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// 4) 查单（含交付物）
app.get('/api/open/v1/orders/:orderNo', requireOpenApiAuth, async (req, res) => {
    try {
        const rows = await store.runQuery('SELECT * FROM kc_api_orders WHERE our_order_no=? AND client_id=? LIMIT 1', [String(req.params.orderNo || ''), req.openApiClient.id]);
        if (!rows.length) return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: '订单不存在' });
        const o = rows[0];
        res.json({
            success: true,
            data: {
                order_id: o.our_order_no, client_order_no: o.client_order_no, sku: o.sku_code, qty: o.qty,
                status: o.status, amount: openApiUsd(o.amount_cents), currency: 'USD', cdk: o.cdk || null, created_at: o.created_at
            }
        });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// ─── 管理面：API 客户 ────────────────────────────────────────────────────────
app.get('/api/admin/api-clients', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery(
            'SELECT c.id, c.code, c.name, c.api_key, c.balance_cents, c.status, c.rate_limit, c.callback_url, c.note, c.created_at, ' +
            '(SELECT COUNT(*) FROM kc_api_orders o WHERE o.client_id = c.id) AS orders_total, ' +
            '(SELECT COUNT(*) FROM kc_api_orders o WHERE o.client_id = c.id AND o.status = \'delivered\') AS orders_delivered, ' +
            '(SELECT COALESCE(SUM(o.amount_cents), 0) FROM kc_api_orders o WHERE o.client_id = c.id AND o.status = \'delivered\') AS gmv_cents ' +
            'FROM kc_api_clients c ORDER BY c.id DESC'
        );
        res.json({ success: true, data: rows });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/api-clients', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const name = String((req.body || {}).name || '').trim();
        if (!name) return res.status(400).json({ success: false, message: '客户名称必填' });
        const code = 'cli_' + crypto.randomBytes(3).toString('hex');
        const apiKey = 'ak_live_' + crypto.randomBytes(12).toString('hex');
        const apiSecret = crypto.randomBytes(24).toString('hex');
        await store.runExecute(
            'INSERT INTO kc_api_clients (code, name, api_key, api_secret, balance_cents, status, rate_limit, note) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
            [code, name, apiKey, apiSecret, 'active', OPEN_API_DEFAULT_LIMIT, 'v1.25.0 创建']
        );
        res.json({ success: true, message: '已创建（密钥仅本次返回，请立即保存；丢失可在详情页重置）', data: { code, name, api_key: apiKey, api_secret: apiSecret } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/api-clients/:id/recharge', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = parseInt(req.params.id, 10) || 0;
        const amount = Number((req.body || {}).amount);
        if (!(amount > 0) || amount > 1000000) return res.status(400).json({ success: false, message: '充值金额必须大于 0' });
        const cents = Math.round(amount * 100);
        const r = await store.runExecute('UPDATE kc_api_clients SET balance_cents = balance_cents + ? WHERE id=?', [cents, id]);
        if (!r || Number(r.affectedRows) === 0) return res.status(404).json({ success: false, message: '客户不存在' });
        const [rows] = await store.runQuery('SELECT balance_cents FROM kc_api_clients WHERE id=? LIMIT 1', [id]);
        await store.runExecute(
            'INSERT INTO kc_api_balance_ledger (client_id, change_cents, balance_after_cents, type, ref, note) VALUES (?, ?, ?, ?, ?, ?)',
            [id, cents, rows.balance_cents, 'recharge', '', '后台充值 $' + amount.toFixed(2)]
        );
        res.json({ success: true, message: '已充值 $' + amount.toFixed(2), data: { balance_cents: rows.balance_cents, balance: openApiUsd(rows.balance_cents) } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/api-clients/:id/status', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = parseInt(req.params.id, 10) || 0;
        const status = String((req.body || {}).status || '') === 'active' ? 'active' : 'disabled';
        const r = await store.runExecute('UPDATE kc_api_clients SET status=? WHERE id=?', [status, id]);
        if (!r || Number(r.affectedRows) === 0) return res.status(404).json({ success: false, message: '客户不存在' });
        res.json({ success: true, message: status === 'active' ? '已启用' : '已停用' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/admin/api-clients/:id/credential', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const id = parseInt(req.params.id, 10) || 0;
        const rows = await store.runQuery('SELECT code, name, api_key, api_secret, rate_limit FROM kc_api_clients WHERE id=? LIMIT 1', [id]);
        if (!rows.length) return res.status(404).json({ success: false, message: '客户不存在' });
        res.json({ success: true, data: rows[0] });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ─── v1.26.0 · API 客户自助门户（SP-2026-10-13-PORTAL-v1.0.0）────────────────────
// 门户面 /api/portal/*（客户登录态=portal token，Bearer 鉴权，client_id 只来自 token）
// 与开放 API /api/open/v1/*（程序调用，Key+签名）鉴权体系完全独立、互不继承。
// 开关：app_config.api_portal_enabled（后台「API 客户」页顶部 Switch 控制）。

const PORTAL_TOKEN_TTL_SEC = 24 * 3600;
const portalLoginBuckets = new Map();

function portalTokenSecret() {
    return String(process.env.PORTAL_TOKEN_SECRET || 'kc_portal_dev_secret_change_me');
}
function portalSign(data) {
    return crypto.createHmac('sha256', portalTokenSecret()).update(String(data)).digest('base64url');
}
function portalIssueToken(clientId) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ cid: Number(clientId), iat: now, exp: now + PORTAL_TOKEN_TTL_SEC })).toString('base64url');
    return header + '.' + payload + '.' + portalSign(header + '.' + payload);
}
function portalVerifyToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        const expect = portalSign(parts[0] + '.' + parts[1]);
        if (!openApiSafeEq(expect, parts[2])) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload || !payload.cid || !payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch (e) { return null; }
}
async function getPortalEnabled() {
    try {
        const v = await store.getAppConfigValue('api_portal_enabled', '1');
        return String(v) !== '0';
    } catch (e) { return true; }
}
async function requirePortalAuth(req, res, next) {
    try {
        await ensureStoreReady();
        if (!(await getPortalEnabled())) {
            return res.status(403).json({ success: false, code: 'PORTAL_DISABLED', message: '门户维护中，暂不可访问' });
        }
        const auth = String(req.headers.authorization || '');
        const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
        const payload = portalVerifyToken(token);
        if (!payload) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: '登录已过期，请重新登录' });
        const rows = await store.runQuery('SELECT * FROM kc_api_clients WHERE id=? LIMIT 1', [payload.cid]);
        if (!rows.length || rows[0].status !== 'active') {
            return res.status(403).json({ success: false, code: 'CLIENT_DISABLED', message: '账户已停用，请联系运营' });
        }
        req.portalClient = rows[0];
        next();
    } catch (error) {
        res.status(500).json({ success: false, code: 'INTERNAL', message: error.message });
    }
}

// 门户静态页（独立 SPA）
app.get(['/api-portal', '/api-portal/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'api-portal.html'));
});

// 登录（API Key + Secret；统一报"凭证不正确"，不区分是 key 错还是 secret 错）
app.post('/api/portal/login', async (req, res) => {
    try {
        await ensureStoreReady();
        if (!(await getPortalEnabled())) {
            return res.status(403).json({ success: false, code: 'PORTAL_DISABLED', message: '门户维护中，暂不可登录' });
        }
        const key = String((req.body || {}).api_key || '').trim();
        const secret = String((req.body || {}).api_secret || '').trim();
        if (!key || !secret) return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: '请输入 API Key 与 Secret' });
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown');
        const nowMs = Date.now();
        let bucket = portalLoginBuckets.get(ip);
        if (!bucket || nowMs - bucket.start > 60000) { bucket = { start: nowMs, count: 0 }; portalLoginBuckets.set(ip, bucket); }
        bucket.count += 1;
        if (bucket.count > 10) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: '尝试过于频繁，请 1 分钟后再试' });
        const rows = await store.runQuery('SELECT * FROM kc_api_clients WHERE api_key=? LIMIT 1', [key]);
        if (!rows.length || rows[0].status !== 'active' || !openApiSafeEq(rows[0].api_secret || '', secret)) {
            return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'API Key 或 Secret 不正确' });
        }
        const c = rows[0];
        res.json({
            success: true, message: '登录成功',
            data: { portal_token: portalIssueToken(c.id), client: { name: c.name, code: c.code, status: c.status } }
        });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 概览（客户信息 + 余额 + 统计）
app.get('/api/portal/me', requirePortalAuth, async (req, res) => {
    try {
        const cid = req.portalClient.id;
        const statRows = await store.runQuery(
            "SELECT " +
            "(SELECT COUNT(*) FROM kc_api_quote_logs WHERE client_id=? AND created_at >= CURDATE()) AS quotes_today, " +
            "(SELECT COUNT(*) FROM kc_api_orders WHERE client_id=? AND created_at >= CURDATE()) AS orders_today, " +
            "(SELECT COUNT(*) FROM kc_api_quote_logs WHERE client_id=? AND created_at >= DATE_FORMAT(NOW(),'%Y-%m-01')) AS quotes_month, " +
            "(SELECT COUNT(*) FROM kc_api_orders WHERE client_id=? AND created_at >= DATE_FORMAT(NOW(),'%Y-%m-01')) AS orders_month, " +
            "(SELECT COUNT(*) FROM kc_api_orders WHERE client_id=? AND status='delivered') AS orders_delivered, " +
            "(SELECT COALESCE(SUM(amount_cents),0) FROM kc_api_orders WHERE client_id=? AND status='delivered') AS gmv_cents",
            [cid, cid, cid, cid, cid, cid]
        );
        const stat = (statRows && statRows[0]) || {};
        res.json({
            success: true,
            data: {
                client: { name: req.portalClient.name, code: req.portalClient.code, status: req.portalClient.status },
                balance: openApiUsd(req.portalClient.balance_cents),
                stats: {
                    quotes_today: Number(stat.quotes_today) || 0,
                    orders_today: Number(stat.orders_today) || 0,
                    quotes_month: Number(stat.quotes_month) || 0,
                    orders_month: Number(stat.orders_month) || 0,
                    orders_delivered: Number(stat.orders_delivered) || 0,
                    gmv: openApiUsd(stat.gmv_cents)
                }
            }
        });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// 查看凭证（API Key 明文；Secret 不返回，掩码展示，重置走 reset-secret）
app.get('/api/portal/credentials', requirePortalAuth, async (req, res) => {
    try {
        res.json({ success: true, data: { api_key: req.portalClient.api_key, client_code: req.portalClient.code } });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// 重置 Secret（旧值立即失效，新值一次性返回）
app.post('/api/portal/credentials/reset-secret', requirePortalAuth, async (req, res) => {
    try {
        const newSecret = crypto.randomBytes(24).toString('hex');
        await store.runExecute('UPDATE kc_api_clients SET api_secret=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [newSecret, req.portalClient.id]);
        res.json({ success: true, message: 'Secret 已重置（旧 Secret 立即失效，请立即保存新 Secret）', data: { api_secret: newSecret } });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// 我的订单（仅本客户；卡密仅 delivered 返回）
app.get('/api/portal/orders', requirePortalAuth, async (req, res) => {
    try {
        const rangeRaw = String(req.query.range || '30');
        const range = rangeRaw === '7' ? 7 : (rangeRaw === 'all' ? 3650 : 30);
        const statusRaw = String(req.query.status || '');
        const status = ['delivered', 'failed', 'created'].indexOf(statusRaw) >= 0 ? statusRaw : 'all';
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = 20;
        const offset = (page - 1) * limit;
        const where = ['client_id=?', 'created_at >= (NOW() - INTERVAL ? DAY)'];
        const params = [req.portalClient.id, range];
        if (status !== 'all') { where.push('status=?'); params.push(status); }
        const [countRows, rows] = await Promise.all([
            store.runQuery('SELECT COUNT(*) AS n FROM kc_api_orders WHERE ' + where.join(' AND '), params),
            store.runQuery(
                'SELECT our_order_no, client_order_no, sku_code, qty, amount_cents, status, cdk, created_at ' +
                'FROM kc_api_orders WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ? OFFSET ?',
                params.concat([limit, offset])
            )
        ]);
        res.json({
            success: true,
            data: {
                total: Number(countRows[0].n) || 0, page: page, limit: limit,
                items: rows.map(function (o) {
                    return {
                        order_id: o.our_order_no, client_order_no: o.client_order_no,
                        sku: o.sku_code, qty: o.qty, amount: openApiUsd(o.amount_cents),
                        status: o.status, cdk: o.status === 'delivered' ? (o.cdk || '') : '',
                        created_at: o.created_at
                    };
                })
            }
        });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// 余额与消费（流水）
app.get('/api/portal/billing', requirePortalAuth, async (req, res) => {
    try {
        const cid = req.portalClient.id;
        const ledgerRows = await store.runQuery(
            'SELECT change_cents, balance_after_cents, type, ref, note, created_at FROM kc_api_balance_ledger WHERE client_id=? ORDER BY id DESC LIMIT 100',
            [cid]
        );
        res.json({
            success: true,
            data: {
                balance: openApiUsd(req.portalClient.balance_cents),
                ledger: (ledgerRows || []).map(function (l) {
                    return {
                        type: l.type, change: openApiUsd(l.change_cents), balance_after: openApiUsd(l.balance_after_cents),
                        ref: l.ref, note: l.note, created_at: l.created_at
                    };
                }),
                recharge_hint: '充值请联系运营（对公转账后由运营在后台确认到账）'
            }
        });
    } catch (error) { res.status(500).json({ success: false, code: 'INTERNAL', message: error.message }); }
});

// ─── 管理面：门户总开关 ────────────────────────────────────────────────────
app.get('/api/admin/api-portal/setting', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const enabled = await getPortalEnabled();
        res.json({ success: true, data: { api_portal_enabled: enabled } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});
app.post('/api/admin/api-portal/setting', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const raw = (req.body || {}).enabled;
        const enabled = !(raw === false || String(raw) === 'false' || String(raw) === '0');
        await store.setAppConfigValue('api_portal_enabled', enabled ? '1' : '0');
        res.json({ success: true, message: enabled ? '门户已开放' : '门户已关闭（客户登录将看到维护中，API 调用不受影响）', data: { api_portal_enabled: enabled } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 上游目录成本（API 加价的成本来源；MVP 手填，真实上游同步后续版本）
app.post('/api/admin/upstreams/:code/plans/:key/price', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const code = String(req.params.code || '').trim();
        const key = String(req.params.key || '').trim();
        const price = Number((req.body || {}).price);
        if (!(price >= 0) || price > 1000000) return res.status(400).json({ success: false, message: '成本价必须 ≥ 0（美元）' });
        const cents = Math.round(price * 100);
        const r = await store.runExecute('UPDATE kc_upstream_plans SET upstream_price_cents=? WHERE upstream_code=? AND upstream_plan_key=?', [cents, code, key]);
        if (!r || Number(r.affectedRows) === 0) return res.status(404).json({ success: false, message: '上游目录项不存在' });
        res.json({ success: true, message: '成本已更新为 $' + price.toFixed(2), data: { upstream_price_cents: cents } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/listing-cards/sync-to-v2', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery('SELECT c.*, p.code AS plan_code FROM kc_listing_cards c LEFT JOIN kc_plans p ON p.id = c.plan_id');
        if (!rows.length) return res.json({ success: true, message: '无卡片可同步', synced: 0 });
        let synced = 0, skipped = 0;
        for (const r of rows) {
            // 约定：migrate-pricing 生成 kc_plans.code='xplan_<v2id>'，从 code 解析 v2_plan.id
            const m = String(r.plan_code || '').match(/^xplan_(\d+)$/);
            if (!m) { skipped++; continue; }
            const v2id = Number(m[1]);
            await store.runExecute(
                'UPDATE xboard.v2_plan SET kc_card=? WHERE id=?',
                [r.card_json, v2id]
            );
            synced++;
        }
        res.json({ success: true, message: '已反向同步 ' + synced + ' 张卡片（跳过 ' + skipped + ' 张无映射）', synced, skipped });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 保存商品页常见问题
app.post('/api/admin/card-config/faq', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const list = faqNorm(req.body && req.body.faq);
        await writeKcSetting(KC_SETTING_FAQ, list);
        res.json({ success: true, message: '常见问题已保存，前台刷新即生效', faq: list });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 商品卡片配置：套餐列表（含充值套餐过滤）
app.get('/api/admin/card-config/list', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery(
            'SELECT id, name, content, prices, kc_card, `show`, sell, sort FROM `' + XBOARD_DB_NAME + '`.v2_plan ' +
            'WHERE (kc_is_topup IS NULL OR kc_is_topup = 0) ORDER BY sort ASC, id ASC'
        );
        const plans = rows.map((r) => {
            let prices = {};
            try { prices = JSON.parse(r.prices || '{}'); } catch (e) { prices = {}; }
            return {
                id: r.id,
                name: r.name,
                content: r.content || '',
                show: Boolean(r.show),
                sell: Boolean(r.sell),
                prices,
                configured: Boolean(r.kc_card),
                card: cardParse(r.kc_card) || cardDefault()
            };
        });
        res.json({
            success: true,
            plans,
            categories: categoriesNorm(await readKcSetting(KC_SETTING_CATEGORIES)),
            faq: faqNorm(await readKcSetting(KC_SETTING_FAQ)),
            promo_row: promoRowNorm(await readKcSetting(KC_SETTING_PROMO_ROW))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 商品卡片配置：保存
app.post('/api/admin/card-config/save', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const planId = Number(req.body && req.body.plan_id);
        if (!planId) { return res.status(400).json({ success: false, message: '缺少 plan_id' }); }
        const card = cardNorm(req.body && req.body.card);
        // 兼容：后台表单暂不编辑 rules（购买须知），保存时保留库中已有值，避免被白名单清洗丢弃
        if (!card.rules) {
            try {
                const rows = await store.runQuery(
                    'SELECT kc_card FROM `' + XBOARD_DB_NAME + '`.v2_plan WHERE id = ? LIMIT 1', [planId]
                );
                const old = rows.length ? cardParse(rows[0].kc_card) : null;
                if (old && old.rules) { card.rules = old.rules; }
            } catch (e) { /* 读取失败不阻塞保存 */ }
        }
        await store.runExecute(
            'UPDATE `' + XBOARD_DB_NAME + '`.v2_plan SET kc_card = ? WHERE id = ?',
            [JSON.stringify(card), planId]
        );
        res.json({ success: true, message: '已保存，前台刷新即生效', card });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 商品卡片配置：重置为未配置（前台走兜底默认模板）
app.post('/api/admin/card-config/reset', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const planId = Number(req.body && req.body.plan_id);
        if (!planId) { return res.status(400).json({ success: false, message: '缺少 plan_id' }); }
        await store.runExecute(
            'UPDATE `' + XBOARD_DB_NAME + '`.v2_plan SET kc_card = NULL WHERE id = ?',
            [planId]
        );
        res.json({ success: true, message: '已重置为未配置（前台使用默认模板）' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/integration', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getIntegrationConfig();
        const issues = await store.listIntegrationIssues(20);
        res.json({
            success: true,
            config: {
                enabled: cfg.enabled,
                key_saved: Boolean(cfg.integration_key),
                key_preview: cfg.integration_key
                    ? `${cfg.integration_key.slice(0, 4)}${'*'.repeat(Math.max(0, Math.min(12, cfg.integration_key.length - 8)))}${cfg.integration_key.slice(-4)}`
                    : ''
            },
            recent_issues: issues.map((row) => ({
                ref: row.ref,
                cdk: row.cdk_code,
                plan_type: row.plan_type,
                source: row.source,
                created_at: row.created_at
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/integration', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveIntegrationConfig({
            enabled: Boolean(body.enabled),
            integration_key: body.integration_key
        });
        res.json({ success: true, message: '集成配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/integration/generate-key', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const newKey = `ik_${crypto.randomBytes(24).toString('hex')}`;
        await store.saveIntegrationConfig({ enabled: true, integration_key: newKey });
        res.json({
            success: true,
            message: '已生成新的集成密钥（原密钥立即失效）',
            integration_key: newKey
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

async function start() {
    await ensureStoreReady();

    try {
        const poolInfo = await syncBrowserPoolModeFromStore();
        if (poolInfo.enabled && poolInfo.initialized !== false) {
            runtimeLog.push({
                jobKey: '',
                level: 'system',
                source: 'server',
                text: `[BrowserPool] 已预热 ${poolInfo.size} 个浏览器槽位`
            });
        } else if (!poolInfo.enabled) {
            runtimeLog.push({
                jobKey: '',
                level: 'system',
                source: 'server',
                text: '[Browser] 独立启动模式（后台已关闭浏览器池）'
            });
        }
    } catch (error) {
        console.error(`[BrowserPool] 初始化失败: ${error.message}`);
    }

    // 启动时把所有遗留的 in_use 锁清空（避免上次崩溃残留的锁卡死整个池）
    try {
        await store.resetAllAssetLocks();
        console.log('🔓 [资产锁] 启动时已重置所有 in_use 标记');
    } catch (error) {
        console.error(`❌ [资产锁] 启动重置失败: ${error.message}`);
    }

    // 每 60 秒兜底回收一次"超过 15 分钟仍未释放"的锁（防进程崩溃）
    setInterval(async () => {
        try {
            const released = await store.releaseStaleAssetLocks();
            if (released.phoneReleased > 0 || released.cardReleased > 0 || released.poolReleased > 0) {
                console.log(`🧹 [资产锁] 兜底回收  phone=${released.phoneReleased}  card=${released.cardReleased}  pool_emails=${released.poolReleased}`);
            }
        } catch (error) {
            console.warn(`⚠️  [资产锁] 周期清理失败: ${error.message}`);
        }
    }, 60 * 1000).unref();

    // ── KC-PATCH（阶段二 · 未兑卡提醒 / 阶段三 · 异常告警）──
    // 每 6 小时检查一次：
    //   ① 发卡超 24h 未兑换的自助卡密 → Telegram 提醒管理员（主动触达用户）
    //   ② 超 30 分钟仍在 processing 的任务 → Telegram 告警（疑似卡住）
    // 状态存在内存里，重启后重新计（首次运行如无新告警则静默）。
    let lastUnredeemedAlertAt = 0;
    const alertedStuckJobs = new Set();
    setInterval(async () => {
        try {
            if (Date.now() - lastUnredeemedAlertAt < 6 * 3600 * 1000) return;
            lastUnredeemedAlertAt = Date.now();

            // ① 未兑卡提醒（发卡超 24 小时未兑换）
            const unredeemed = await store.getUnredeemedCards(24 * 3600);
            if (unredeemed && unredeemed.length > 0) {
                fireTelegramNotification('unredeemed_cards', { cards: unredeemed });
            }

            // ② 卡住任务告警（超 30 分钟仍 processing）
            const stuck = await store.getStuckTasks(30 * 60);
            for (const t of stuck || []) {
                if (alertedStuckJobs.has(t.job_key)) continue;
                alertedStuckJobs.add(t.job_key);
                fireTelegramNotification('task_stuck', { jobKey: t.job_key, cdk: t.cdk, message: `任务 ${t.job_key} 超过 30 分钟仍在处理中，请检查` });
            }
        } catch (error) {
            console.warn(`⚠️ [兑卡提醒] 周期检查失败: ${error.message}`);
        }
    }, 60 * 1000).unref();

    // ── S8：供应商健康摘要 —— 启动即刷新一次，此后每 60 秒一次（仅 Mock 模式做实事）──
    refreshSupplierHealth().catch((error) => console.warn(`⚠️ [健康摘要] 启动刷新失败: ${error.message}`));
    setInterval(async () => {
        try {
            await refreshSupplierHealth();
        } catch (error) {
            console.warn(`⚠️ [健康摘要] 周期刷新失败: ${error.message}`);
        }
    }, 60 * 1000).unref();

    const server = app.listen(PORT, () => {
        const conn = store.connectionInfo;
        runtimeLog.push({
            jobKey: '',
            level: 'system',
            source: 'server',
            text: `✅ 服务就绪  http://localhost:${PORT}  ·  MySQL ${conn.user}@${conn.host}:${conn.port}/${conn.database}  ·  PID=${process.pid}`
        });
        console.log('数据库表检查完成');
        console.log(`http://localhost:${PORT}`);
        console.log(`MySQL => ${conn.user}@${conn.host}:${conn.port}/${conn.database}`);
    });

    // WebSocket Server Setup
    const wss = new WebSocket.Server({ server });
    wss.on('connection', (ws) => {
        let currentJobKey = null;

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                if (data.type === WS_HEARTBEAT_PING_TYPE) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: WS_HEARTBEAT_PONG_TYPE,
                            ts: Number(data.ts) || Date.now()
                        }));
                    }
                    return;
                }
                if (data.type === 'subscribe' && data.jobKey) {
                    if (currentJobKey && currentJobKey !== data.jobKey) {
                        unsubscribeTaskClient(currentJobKey, ws);
                    }
                    currentJobKey = data.jobKey;
                    if (!taskClients.has(currentJobKey)) {
                        taskClients.set(currentJobKey, new Set());
                    }
                    taskClients.get(currentJobKey).add(ws);
                    console.log(`Client subscribed to task: ${currentJobKey}`);
                    await sendTaskSnapshot(ws, currentJobKey);
                }
            } catch (e) {
                console.error('WebSocket message error:', e);
            }
        });

        ws.on('close', () => {
            unsubscribeTaskClient(currentJobKey, ws);
        });
    });
}

if (process.env.IS_PRODUCT_FLOW === 'true') {
    console.log('[系统] 检测到成品子流程环境，跳过 Web 服务监听。');
} else {
    start().catch((error) => {
        console.error('服务启动失败:', error.message);

        if (error && /ECONNREFUSED|connect/i.test(String(error.message || error))) {
            const conn = store.connectionInfo;
            console.error(
                `MySQL 连接配置 => ${conn.user}@${conn.host}:${conn.port}/${conn.database}`
            );
            console.error('排查建议:');
            console.error('1. 确认本机或远程 MySQL 已启动，并且监听了对应 host/port。');
            console.error(`2. 如果不是本机默认库，请先设置环境变量后再启动，例如:`);
            console.error(
                `   $env:DB_HOST='127.0.0.1'; $env:DB_PORT='3306'; $env:DB_USER='root'; $env:DB_PASSWORD='你的密码'; $env:DB_NAME='gpt'; node server.js`
            );
            console.error('3. 首次建库时，请先在 MySQL 中创建数据库，再启动服务自动建表。');
        }

        process.exit(1);
    });
}
