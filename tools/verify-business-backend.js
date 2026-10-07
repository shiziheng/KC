'use strict';

/**
 * 独立业务后台只读验收脚本。
 * 只调用 GET 接口，不创建测试商品、订单、充值记录或流水。
 * 需要由操作者显式提供已有管理员令牌，脚本不会读取/创建管理员凭据。
 */
const base = String(process.env.BUSINESS_VERIFY_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const token = String(process.env.BUSINESS_VERIFY_TOKEN || '').trim();

async function request(path) {
    const response = await fetch(`${base}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(`GET ${path} -> ${response.status}: ${payload.message || 'request failed'}`);
    }
    return payload.data;
}

async function main() {
    if (!token) {
        console.error('缺少 BUSINESS_VERIFY_TOKEN。请提供现有管理员令牌；本脚本不会生成令牌或写入验收数据。');
        process.exitCode = 2;
        return;
    }

    const [health, summary, products, orders, topups, wallets, ledger] = await Promise.all([
        request('/api/admin/business/health'),
        request('/api/admin/business/summary'),
        request('/api/admin/business/products'),
        request('/api/admin/business/orders'),
        request('/api/admin/business/topups'),
        request('/api/admin/business/wallets'),
        request('/api/admin/business/ledger')
    ]);

    console.log(JSON.stringify({
        ok: health?.ready === true && health?.mode === 'MOCK',
        mode: health?.mode || 'unknown',
        ready: health?.ready === true,
        endpoints: {
            products: Array.isArray(products) ? products.length : null,
            orders: Array.isArray(orders) ? orders.length : null,
            mockTopups: Array.isArray(topups) ? topups.length : null,
            wallets: Array.isArray(wallets) ? wallets.length : null,
            ledgerEntries: Array.isArray(ledger) ? ledger.length : null
        },
        summary
    }, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, message: error.message }));
    process.exitCode = 1;
});
