'use strict';

const { BusinessError } = require('./validation');
const { assertSchemaReady, getBusinessPool, businessDbInfo } = require('../business-infra/business-db');

function parseDay(value, field) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        throw new BusinessError(400, 'INVALID_RECONCILIATION_RANGE', `${field} 日期格式应为 YYYY-MM-DD`);
    }
    const [year, month, day] = text.split('-').map(Number);
    const epoch = Date.UTC(year, month - 1, day);
    const check = new Date(epoch);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        throw new BusinessError(400, 'INVALID_RECONCILIATION_RANGE', `${field} 日期无效`);
    }
    return { text, epoch };
}

function normalizeRange(input = {}, now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    const defaultTo = parseDay(today, '结束').epoch;
    const to = input.to ? parseDay(input.to, '结束') : { text: today, epoch: defaultTo };
    const defaultFromDate = new Date(to.epoch - 6 * 86400000).toISOString().slice(0, 10);
    const from = input.from ? parseDay(input.from, '开始') : parseDay(defaultFromDate, '开始');
    if (from.epoch > to.epoch) {
        throw new BusinessError(400, 'INVALID_RECONCILIATION_RANGE', '开始日期不能晚于结束日期');
    }
    const dayCount = Math.floor((to.epoch - from.epoch) / 86400000) + 1;
    if (dayCount > 31) {
        throw new BusinessError(400, 'INVALID_RECONCILIATION_RANGE', '单次只读对账最多查询 31 天');
    }
    const endExclusive = to.epoch + 86400000;
    return {
        from: from.text,
        to: to.text,
        legacyStart: Math.floor(from.epoch / 1000),
        legacyEnd: Math.floor(endExclusive / 1000),
        businessStart: new Date(from.epoch).toISOString().slice(0, 19).replace('T', ' '),
        businessEnd: new Date(endExclusive).toISOString().slice(0, 19).replace('T', ' ')
    };
}

function safeIdentifier(value) {
    const name = String(value || '');
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) {
        throw new BusinessError(503, 'RECONCILIATION_SOURCE_UNAVAILABLE', '业务只读数据源配置不可用');
    }
    return `\`${name}\``;
}

function count(value) { return Number(value || 0); }
function integer(value) { return String(value ?? '0'); }

// v2.1.0 · 旧系统退场：对账不再直连旧库，仅统计新业务库口径。
function createReadOnlyReconciliation({
    assertReady = assertSchemaReady,
    getPool = getBusinessPool,
    businessDbName = businessDbInfo().database
} = {}) {
    return async function readOnlyReconciliation(input = {}) {
        await assertReady();
        const range = normalizeRange(input);
        const business = safeIdentifier(businessDbName);
        const connection = await getPool().getConnection();
        let transactionStarted = false;
        try {
            await connection.query('START TRANSACTION READ ONLY');
            transactionStarted = true;

            const [businessOrderRows] = await connection.query(
                `SELECT COUNT(*) AS row_count,
                        COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount_minor ELSE 0 END), 0) AS usd_minor_total,
                        COALESCE(SUM(CASE WHEN currency = 'USDT' THEN amount_minor ELSE 0 END), 0) AS usdt_minor_total,
                        COALESCE(SUM(CASE WHEN external_order_ref IS NULL OR external_order_ref = '' THEN 1 ELSE 0 END), 0) AS without_legacy_ref
                   FROM ${business}.biz_recharge_orders
                  WHERE source_channel = 'storefront_mock' AND created_at >= ? AND created_at < ?`,
                [range.businessStart, range.businessEnd]
            );
            const [balanceRows] = await connection.query(
                `WITH usd_wallets AS (
                     SELECT owner_ref, COUNT(*) AS wallet_count, MAX(available_balance_minor) AS available_balance_minor
                       FROM ${business}.biz_wallet_accounts
                      WHERE owner_type = 'user' AND currency = 'USD'
                      GROUP BY owner_ref
                 )
                 SELECT COUNT(*) AS mapped_user_count,
                        COALESCE(SUM(CASE WHEN usd_wallets.wallet_count = 1 THEN 1 ELSE 0 END), 0) AS comparable_wallet_count,
                        COALESCE(SUM(CASE WHEN usd_wallets.wallet_count IS NULL THEN 1 ELSE 0 END), 0) AS missing_wallet_count,
                        COALESCE(SUM(CASE WHEN usd_wallets.wallet_count > 1 THEN 1 ELSE 0 END), 0) AS ambiguous_wallet_count,
                        COALESCE(SUM(CASE WHEN usd_wallets.wallet_count = 1 THEN usd_wallets.available_balance_minor ELSE 0 END), 0) AS business_balance_minor
                   FROM ${business}.biz_user_mappings AS mapped_users
                   LEFT JOIN usd_wallets ON usd_wallets.owner_ref = mapped_users.business_user_ref
                  WHERE mapped_users.status = 'active'`
            );

            const newOrders = businessOrderRows[0] || {};
            const balances = balanceRows[0] || {};
            return {
                period: { from: range.from, to: range.to },
                readOnly: true,
                writesPerformed: false,
                legacySource: 'retired',
                orders: {
                    legacyCount: null,
                    legacyUsdMinorTotal: null,
                    storefrontCount: count(newOrders.row_count),
                    storefrontUsdMinorTotal: integer(newOrders.usd_minor_total),
                    storefrontUsdtMinorTotal: integer(newOrders.usdt_minor_total),
                    storefrontWithoutLegacyRef: count(newOrders.without_legacy_ref),
                    explicitLinkedCount: 0,
                    ambiguousLinkCount: 0,
                    amountMismatchCount: 0,
                    absoluteAmountDifferenceUsdMinor: '0'
                },
                balances: {
                    mappedUserCount: count(balances.mapped_user_count),
                    ambiguousMappingCount: 0,
                    comparableWalletCount: count(balances.comparable_wallet_count),
                    missingWalletCount: count(balances.missing_wallet_count),
                    ambiguousWalletCount: count(balances.ambiguous_wallet_count),
                    mismatchCount: 0,
                    legacyUsdMinorTotal: null,
                    businessUsdMinorTotal: integer(balances.business_balance_minor),
                    absoluteDifferenceUsdMinor: '0'
                },
                matchingRules: {
                    order: '旧系统已退场，不再直连旧库比对；当前仅统计新业务库 storefront_mock USD/USDT 订单口径。',
                    balance: '仅统计存在唯一 USD 钱包的映射账号；缺失/重复映射单列，不按零余额处理。',
                    scope: '旧系统订单/余额仅作历史背景值，不再读取；未匹配记录不代表数据丢失。USDT 不做汇率换算。',
                    action: '报告只读；不保存对账记录、不自动补单、不回写余额、不触发迁移或同步。'
                }
            };
        } catch (error) {
            if (['ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_ACCESS_DENIED_ERROR'].includes(error?.code)) {
                throw new BusinessError(503, 'RECONCILIATION_SOURCE_UNAVAILABLE', '业务只读数据源暂不可用；未修改任何数据');
            }
            throw error;
        } finally {
            if (transactionStarted) {
                try { await connection.rollback(); } catch (_) { /* rollback best effort */ }
            }
            connection.release();
        }
    };
}

module.exports = { normalizeRange, createReadOnlyReconciliation };
