// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。
#!/usr/bin/env node

/**
 * S13：只读生成 KC/Xboard 对账报告。
 *
 * 示例：
 *   node tools/reconcile-kc-xboard.js --start-date 2026-10-01 --end-date 2026-10-06
 *   node tools/reconcile-kc-xboard.js --difference-type manual_refund --format csv > report.csv
 *
 * 该脚本只查询，不创建订单、不修改余额、不调用 ZovoCard。
 */
const store = require('../mysql-store');

function parseArgs(argv) {
    const out = { format: 'summary' };
    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i] || '');
        if (!token.startsWith('--')) continue;
        const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const next = argv[i + 1];
        if (next && !String(next).startsWith('--')) {
            out[key] = next;
            i += 1;
        } else {
            out[key] = true;
        }
    }
    return out;
}

function filtersFromArgs(args) {
    return {
        startDate: args.startDate,
        endDate: args.endDate,
        tradeNo: args.tradeNo,
        userId: args.userId,
        orderStatus: args.orderStatus,
        differenceType: args.differenceType
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    try {
        await store.ensureReady();
        const result = await store.queryReconciliationRows(filtersFromArgs(args), 10000);
        if (String(args.format).toLowerCase() === 'csv') {
            process.stdout.write(store.reconciliationCsv(result.rows));
            return;
        }
        process.stdout.write(JSON.stringify({
            filters: result.filters,
            total: result.rows.length,
            summary: store.summarizeReconciliationRows(result.rows),
            rows: result.rows
        }, null, 2) + '\n');
    } finally {
        await store.closeStore();
    }
}

main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
});
