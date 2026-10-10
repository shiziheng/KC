'use strict';

const USER_INFO_PATH = '/api/v1/user/info';

function createRequireStorefrontUser({
    origin = process.env.XBOARD_API_ORIGIN || 'http://host.docker.internal:7001',
    fetchImpl = globalThis.fetch
} = {}) {
    return async function requireStorefrontUser(req, res, next) {
        const authorization = String(req.headers.authorization || '').trim();
        const match = authorization.match(/^Bearer\s+(.+)$/i);
        const token = match ? match[1].trim() : '';
        if (!token || token.length > 8192 || /[\r\n]/.test(token)) {
            return res.status(401).json({ success: false, code: 'USER_AUTH_REQUIRED', message: '请先登录后继续' });
        }

        if (typeof fetchImpl !== 'function') {
            return res.status(503).json({ success: false, code: 'USER_AUTH_UNAVAILABLE', message: '用户认证服务暂不可用' });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const url = new URL(USER_INFO_PATH, origin);
            const upstream = await fetchImpl(url, {
                method: 'GET',
                headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
                signal: controller.signal
            });
            const payload = await upstream.json().catch(() => null);
            const data = payload?.data?.user || payload?.data;
            const userId = String(data?.id ?? '').trim();
            const email = String(data?.email ?? '').trim().toLowerCase();

            if (!upstream.ok || payload?.status !== 'success' || !/^\d{1,20}$/.test(userId) || !email) {
                return res.status(401).json({
                    success: false,
                    code: 'USER_AUTH_INVALID',
                    message: '登录状态无效，请重新登录'
                });
            }

            req.storefrontUser = { id: userId, email };
            return next();
        } catch (error) {
            const code = error?.name === 'AbortError' ? 'USER_AUTH_TIMEOUT' : 'USER_AUTH_UNAVAILABLE';
            return res.status(503).json({
                success: false,
                code,
                message: '用户认证服务暂不可用，请稍后重试'
            });
        } finally {
            clearTimeout(timer);
        }
    };
}

module.exports = { createRequireStorefrontUser };
