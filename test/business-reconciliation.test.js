'use strict';

const { BusinessError } = require('../business/validation');
const { normalizeRange, createReadOnlyReconciliation } = require('../business/reconciliation');

describe('read-only legacy reconciliation', () => {
    it('normalizes inclusive UTC dates to a bounded exclusive query range', () => {
        const range = normalizeRange({ from: '2026-10-01', to: '2026-10-07' });
        expect(range.from).toBe('2026-10-01');
        expect(range.to).toBe('2026-10-07');
        expect(range.legacyEnd - range.legacyStart).toBe(7 * 86400);
        expect(range.businessStart).toBe('2026-10-01 00:00:00');
        expect(range.businessEnd).toBe('2026-10-08 00:00:00');
    });

    it.each([
        [{ from: '2026-02-30', to: '2026-03-01' }, 'INVALID_RECONCILIATION_RANGE'],
        [{ from: '2026-10-02', to: '2026-10-01' }, 'INVALID_RECONCILIATION_RANGE'],
        [{ from: '2026-09-01', to: '2026-10-07' }, 'INVALID_RECONCILIATION_RANGE']
    ])('rejects invalid or excessive date ranges %#', async (range, code) => {
        const reader = createReadOnlyReconciliation({
            assertReady: vi.fn(),
            getPool: vi.fn(),
            businessDbName: 'kc_business',
            legacyDbName: 'xboard'
        });
        await expect(reader(range)).rejects.toMatchObject({ code });
    });

    it('uses a read-only transaction, returns aggregates only, and always rolls back', async () => {
        const statements = [];
        const connection = {
            query: vi.fn(async (sql) => {
                const statement = String(sql).trim();
                statements.push(statement);
                if (statement.startsWith('START TRANSACTION')) return [[]];
                if (statement.includes('SUM(total_amount)')) return [[{ row_count: 4, usd_minor_total: '8800' }]];
                if (statement.includes('AS without_legacy_ref')) return [[{
                    row_count: 2, usd_minor_total: '2500', usdt_minor_total: '0', without_legacy_ref: 2
                }]];
                if (statement.includes('AS ambiguous_count')) return [[{
                    linked_count: 1, ambiguous_count: 0, amount_mismatch_count: 1,
                    absolute_amount_difference_minor: '500'
                }]];
                if (statement.includes('AS mapped_user_count')) return [[{
                    mapped_user_count: 3, ambiguous_mapping_count: 0, comparable_wallet_count: 1,
                    missing_wallet_count: 2, ambiguous_wallet_count: 0, mismatch_count: 1,
                    xboard_balance_minor: '500', business_balance_minor: '1000',
                    absolute_balance_difference_minor: '500'
                }]];
                throw new Error(`Unexpected read-only query: ${statement.slice(0, 80)}`);
            }),
            rollback: vi.fn(async () => { statements.push('ROLLBACK'); }),
            release: vi.fn()
        };
        const reader = createReadOnlyReconciliation({
            assertReady: vi.fn(async () => true),
            getPool: () => ({ getConnection: async () => connection }),
            businessDbName: 'kc_business',
            legacyDbName: 'xboard'
        });

        const report = await reader({ from: '2026-10-01', to: '2026-10-07' });

        expect(report.readOnly).toBe(true);
        expect(report.writesPerformed).toBe(false);
        expect(report.orders.explicitLinkedCount).toBe(1);
        expect(report.orders.amountMismatchCount).toBe(1);
        expect(report.orders.absoluteAmountDifferenceUsdMinor).toBe('500');
        expect(report.balances.missingWalletCount).toBe(2);
        expect(report.matchingRules.action).toContain('不自动补单');
        expect(statements[0]).toBe('START TRANSACTION READ ONLY');
        expect(statements.at(-1)).toBe('ROLLBACK');
        expect(statements.filter((sql) => sql.startsWith('START TRANSACTION') || sql === 'ROLLBACK').length).toBe(2);
        expect(statements.filter((sql) => !sql.startsWith('START TRANSACTION') && sql !== 'ROLLBACK')
            .every((sql) => /\bSELECT\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(sql))).toBe(true);
        expect(connection.rollback).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
    });

    it('fails closed and releases the connection when a legacy table is unavailable', async () => {
        const connection = {
            query: vi.fn(async (sql) => {
                if (String(sql).startsWith('START TRANSACTION')) return [[]];
                const error = new Error('table missing');
                error.code = 'ER_NO_SUCH_TABLE';
                throw error;
            }),
            rollback: vi.fn(async () => {}),
            release: vi.fn()
        };
        const reader = createReadOnlyReconciliation({
            assertReady: vi.fn(async () => true),
            getPool: () => ({ getConnection: async () => connection }),
            businessDbName: 'kc_business',
            legacyDbName: 'xboard'
        });
        await expect(reader({ from: '2026-10-01', to: '2026-10-01' })).rejects.toMatchObject({
            code: 'RECONCILIATION_SOURCE_UNAVAILABLE',
            status: 503
        });
        expect(connection.rollback).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
    });

    it('rejects identical legacy and business databases before opening a connection', async () => {
        const getPool = vi.fn();
        const reader = createReadOnlyReconciliation({
            assertReady: vi.fn(async () => true),
            getPool,
            businessDbName: 'xboard',
            legacyDbName: 'xboard'
        });
        await expect(reader({ from: '2026-10-01', to: '2026-10-01' })).rejects.toBeInstanceOf(BusinessError);
        expect(getPool).not.toHaveBeenCalled();
    });
});
