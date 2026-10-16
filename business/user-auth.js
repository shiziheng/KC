'use strict';

// v2.1.0 · 旧系统退场：前台顾客身份改由 KC 原生签名令牌本地校验（不再外呼旧系统）。
// 旧实现会外呼旧系统 /api/v1/user/info（host.docker.internal:7001）做远端校验——该直连已移除。
const adminAuth = require('../admin-auth');

function createRequireStorefrontUser({
    verifyToken = (token) => adminAuth.verifySignedToken(token, { expectedSub: 'customer' })
} = {}) {
    return async function requireStorefrontUser(req, res, next) {
        const authorization = String(req.headers.authorization || '').trim();
        const match = authorization.match(/^Bearer\s+(.+)$/i);
        const token = match ? match[1].trim() : '';
        if (!token || token.length > 8192 || /[\r\n]/.test(token)) {
            return res.status(401).json({ success: false, code: 'USER_AUTH_REQUIRED', message: '请先登录后继续' });
        }

        const payload = verifyToken(token);
        if (!payload) {
            return res.status(401).json({
                success: false,
                code: 'USER_AUTH_INVALID',
                message: '登录状态无效，请重新登录'
            });
        }

        req.storefrontUser = { id: String(payload.cid || ''), email: String(payload.em || '') };
        return next();
    };
}

module.exports = { createRequireStorefrontUser };
