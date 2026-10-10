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
        throw new BusinessError(503, 'RECONCILIATION_SOURCE_UNAVAILABLE', '旧系统只读数据源配置不可用');
    }
    return `\`${name}\``;
}

function count(value) { return Number(value || 0); }
function integer(value) { return String(value ?? '0'); }

function createReadOnlyReconciliation({
    assertReady = assertSchemaReady,
    getPool = getBusinessPool,
    businessDbName = businessDbInfo().database,
    legacyDbName = process.env.XBOARD_DB_NAME || 'xboard'
} = {}) {
    return async function readOnlyReconciliation(input = {}) {
        await assertReady();
        if (businessDbName === legacyDbName) {
            throw new BusinessError(503, 'BUSINESS_DATABASE_NOT_ISOLATED', '新旧业务库未隔离，已停止对账');
        }
        const range = normalizeRange(input);
        const legacy = safeIdentifier(legacyDbName);
        const business = safeIdentifier(businessDbName);
        const connection = await getPool().getConnection();
        let transactionStarted = false;
        try {
            await connection.query('START TRANSACTION READ ONLY');
            transactionStarted = true;

            const [legacyOrderRows] = await connection.query(
                `SELECT COUNT(*) AS row_count, COALESCE(SUM(total_amount), 0) AS usd_minor_total
                   FROM ${legacy}.v2_order
                  WHERE created_at >= ? AND created_at < ?`,
                [range.legacyStart, range.legacyEnd]
            );
            const [businessOrderRows] = await connection.query(
                `SELECT COUNT(*) AS row_count,
                        COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount_minor ELSE 0 END), 0) AS usd_minor_total,
                        COALESCE(SUM(CASE WHEN currency = 'USDT' THEN amount_minor ELSE 0 END), 0) AS usdt_minor_total,
                        COALESCE(SUM(CASE WHEN external_order_ref IS NULL OR external_order_ref = '' THEN 1 ELSE 0 END), 0) AS without_legacy_ref
                   FROM ${business}.biz_recharge_orders
                  WHERE source_channel = 'storefront_mock' AND created_at >= ? AND created_at < ?`,
                [range.businessStart, range.businessEnd]
            );
            const [linkedOrderRows] = await connection.query(
                `SELECT COALESCE(SUM(CASE WHEN linked.reference_count = 1 THEN 1 ELSE 0 END), 0) AS linked_count,
                        COALESCE(SUM(CASE WHEN linked.reference_count > 1 THEN 1 ELSE 0 END), 0) AS ambiguous_count,
                        COALESCE(SUM(CASE WHEN linked.reference_count = 1 AND linked.amount_minor <> legacy_order.total_amount THEN 1 ELSE 0 END), 0) AS amount_mismatch_count,
                        COALESCE(SUM(CASE WHEN linked.reference_count = 1 THEN ABS(CAST(linked.amount_minor AS SIGNED) - CAST(legacy_order.total_amount AS SIGNED)) ELSE 0 END), 0) AS absolute_amount_difference_minor
                   FROM ${legacy}.v2_order AS legacy_order
                   INNER JOIN (
                       SELECT external_order_ref, COUNT(*) AS reference_count, MIN(amount_minor) AS amount_minor
                         FROM ${business}.biz_recharge_orders
                        WHERE source_channel = 'storefront_mock' AND currency = 'USD'
                          AND external_order_ref IS NOT NULL AND external_order_ref <> ''
                          AND created_at >= ? AND created_at < ?
                        GROUP BY external_order_ref
                   ) AS linked ON linked.external_order_ref = legacy_order.trade_no
                  WHERE legacy_order.created_at >= ? AND legacy_order.created_at < ?
                    AND legacy_order.trade_no IS NOT NULL AND legacy_order.trade_no <> ''`,
                [range.businessStart, range.businessEnd, range.legacyStart, range.legacyEnd]
            );
            const [balanceRows] = await connection.query(
                `WITH mapped_users AS (
                     SELECT legacy_user_ref, MIN(business_user_ref) AS business_user_ref, COUNT(*) AS mapping_count
                       FROM ${business}.biz_user_mappings
                      WHERE legacy_system = 'xboard' AND status = 'active'
                      GROUP BY legacy_user_ref
                 ), usd_wallets AS (
                     SELECT owner_ref, COUNT(*) AS wallet_count, MAX(available_balance_minor) AS available_balance_minor
                       FROM ${business}.biz_wallet_accounts
                      WHERE owner_type = 'user' AND currency = 'USD'
                      GROUP BY owner_ref
                 )
                 SELECT COUNT(*) AS mapped_user_count,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count > 1 THEN 1 ELSE 0 END), 0) AS ambiguous_mapping_count,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count = 1 AND usd_wallets.wallet_count = 1 THEN 1 ELSE 0 END), 0) AS comparable_wallet_count,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count = 1 AND usd_wallets.wallet_count IS NULL THEN 1 ELSE 0 END), 0) AS missing_wallet_count,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count = 1 AND usd_wallets.wallet_count > 1 THEN 1 ELSE 0 END), 0) AS ambiguous_wallet_count,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count = 1 AND usd_wallets.wallet_count = 1 AND legacy_user.balance <> usd_wallets.available_balance_minor THEN 1 ELSE 0 END), 0) AS mismatch_count,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count = 1 AND usd_wallets.wallet_count = 1 THEN legacy_user.balance ELSE 0 END), 0) AS xboard_balance_minor,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count = 1 AND usd_wallets.wallet_count = 1 THEN usd_wallets.available_balance_minor ELSE 0 END), 0) AS business_balance_minor,
                        COALESCE(SUM(CASE WHEN mapped_users.mapping_count = 1 AND usd_wallets.wallet_count = 1 THEN ABS(CAST(legacy_user.balance AS SIGNED) - CAST(usd_wallets.available_balance_minor AS SIGNED)) ELSE 0 END), 0) AS absolute_balance_difference_minor
                   FROM ${legacy}.v2_user AS legacy_user
                   INNER JOIN mapped_users ON mapped_users.legacy_user_ref =
                       CAST(legacy_user.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
                   LEFT JOIN usd_wallets ON usd_wallets.owner_ref = mapped_users.business_user_ref`
            );

            const oldOrders = legacyOrderRows[0] || {};
            const newOrders = businessOrderRows[0] || {};
            const linked = linkedOrderRows[0] || {};
            const balances = balanceRows[0] || {};
            return {
                period: { from: range.from, to: range.to },
                readOnly: true,
                writesPerformed: false,
                orders: {
                    legacyCount: count(oldOrders.row_count),
                    legacyUsdMinorTotal: integer(oldOrders.usd_minor_total),
                    storefrontCount: count(newOrders.row_count),
                    storefrontUsdMinorTotal: integer(newOrders.usd_minor_total),
                    storefrontUsdtMinorTotal: integer(newOrders.usdt_minor_total),
                    storefrontWithoutLegacyRef: count(newOrders.without_legacy_ref),
                    explicitLinkedCount: count(linked.linked_count),
                    ambiguousLinkCount: count(linked.ambiguous_count),
                    amountMismatchCount: count(linked.amount_mismatch_count),
                    absoluteAmountDifferenceUsdMinor: integer(linked.absolute_amount_difference_minor)
                },
                balances: {
                    mappedUserCount: count(balances.mapped_user_count),
                    ambiguousMappingCount: count(balances.ambiguous_mapping_count),
                    comparableWalletCount: count(balances.comparable_wallet_count),
                    missingWalletCount: count(balances.missing_wallet_count),
                    ambiguousWalletCount: count(balances.ambiguous_wallet_count),
                    mismatchCount: count(balances.mismatch_count),
                    xboardUsdMinorTotal: integer(balances.xboard_balance_minor),
                    businessUsdMinorTotal: integer(balances.business_balance_minor),
                    absoluteDifferenceUsdMinor: integer(balances.absolute_balance_difference_minor)
                },
                matchingRules: {
                    order: '仅按 Xboard trade_no 与新业务 external_order_ref 完全相同的 USD 订单比较；无引用或重复引用不作推断。',
                    balance: '仅比较存在唯一 Xboard 用户映射和唯一 USD 钱包的账号；缺失/重复映射单列，不按零余额处理。',
                    scope: 'Xboard 订单总量仅作旧系统背景值；未匹配记录不代表数据丢失。USDT 不做汇率换算。',
                    action: '报告只读；不保存对账记录、不自动补单、不回写余额、不触发迁移或同步。'
                }
            };
        } catch (error) {
            if (['ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_ACCESS_DENIED_ERROR'].includes(error?.code)) {
                throw new BusinessError(503, 'RECONCILIATION_SOURCE_UNAVAILABLE', '旧系统只读数据源暂不可用；未修改任何数据');
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
