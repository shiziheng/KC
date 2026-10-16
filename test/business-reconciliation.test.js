'use strict';

const { normalizeRange, createReadOnlyReconciliation } = require('../business/reconciliation');

describe('read-only business reconciliation (legacy retired)', () => {
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
            businessDbName: 'kc_business'
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
                if (statement.includes('AS without_legacy_ref')) return [[{
                    row_count: 2, usd_minor_total: '2500', usdt_minor_total: '100', without_legacy_ref: 2
                }]];
                if (statement.includes('AS mapped_user_count')) return [[{
                    mapped_user_count: 3, comparable_wallet_count: 1,
                    missing_wallet_count: 2, ambiguous_wallet_count: 0, business_balance_minor: '1000'
                }]];
                throw new Error(`Unexpected read-only query: ${statement.slice(0, 80)}`);
            }),
            rollback: vi.fn(async () => { statements.push('ROLLBACK'); }),
            release: vi.fn()
        };
        const reader = createReadOnlyReconciliation({
            assertReady: vi.fn(async () => true),
            getPool: () => ({ getConnection: async () => connection }),
            businessDbName: 'kc_business'
        });

        const report = await reader({ from: '2026-10-01', to: '2026-10-07' });

        expect(report.readOnly).toBe(true);
        expect(report.writesPerformed).toBe(false);
        expect(report.legacySource).toBe('retired');
        expect(report.orders.legacyCount).toBeNull();
        expect(report.orders.storefrontCount).toBe(2);
        expect(report.balances.missingWalletCount).toBe(2);
        expect(report.balances.legacyUsdMinorTotal).toBeNull();
        expect(report.matchingRules.order).toContain('旧系统已退场');
        expect(statements[0]).toBe('START TRANSACTION READ ONLY');
        expect(statements.at(-1)).toBe('ROLLBACK');
        expect(statements.filter((sql) => sql.startsWith('START TRANSACTION') || sql === 'ROLLBACK').length).toBe(2);
        expect(statements.filter((sql) => !sql.startsWith('START TRANSACTION') && sql !== 'ROLLBACK')
            .every((sql) => /\bSELECT\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(sql))).toBe(true);
        expect(connection.rollback).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
    });

    it('fails closed and releases the connection when the business table is unavailable', async () => {
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
            businessDbName: 'kc_business'
        });
        await expect(reader({ from: '2026-10-01', to: '2026-10-01' })).rejects.toMatchObject({
            code: 'RECONCILIATION_SOURCE_UNAVAILABLE',
            status: 503
        });
        expect(connection.rollback).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
    });
});
