'use strict';

const express = require('express');
const repository = require('./repository');
const { BusinessError } = require('./validation');
const { assertSchemaReady, businessDbInfo } = require('../business-infra/business-db');
const { readZovoCatalog } = require('./zovo-catalog');

function createBusinessAdminRouter(requireAdmin) {
    const router = express.Router();
    if (typeof requireAdmin === 'function') router.use(requireAdmin);

    router.get('/health', async (_req, res) => {
        try {
            await assertSchemaReady();
            return res.json({ success: true, data: { ready: true, mode: 'MOCK', database: businessDbInfo().database } });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/summary', async (_req, res) => run(res, () => repository.dashboardSummary()));
    router.get('/products', async (_req, res) => run(res, () => repository.listProducts()));
    router.get('/upstream-catalog', async (_req, res) => run(res, readZovoCatalog));
    router.post('/products', async (req, res) => run(res, () => repository.createProduct(req.body, actor(req))));
    router.put('/products/:id', async (req, res) => run(res, () => repository.updateProduct(req.params.id, req.body, actor(req))));
    router.get('/orders', async (req, res) => run(res, () => repository.listOrders(req.query.q)));
    router.post('/orders/:orderRef/after-sales', async (req, res) => run(res, () => repository.updateAfterSalesStatus(
        req.params.orderRef,
        req.body,
        actor(req)
    )));
    router.post('/orders/mock', async (req, res) => run(res, () => repository.createMockOrder(
        req.body,
        req.get('Idempotency-Key'),
        actor(req)
    )));
    router.get('/topups', async (req, res) => run(res, () => repository.listTopups(req.query.q)));
    router.post('/topups/mock', async (req, res) => run(res, () => repository.createMockTopup(
        req.body,
        req.get('Idempotency-Key'),
        actor(req)
    )));
    router.post('/topups/:paymentRef/reconcile', async (req, res) => run(res, () => repository.reconcileMockTopup(
        req.params.paymentRef,
        req.body,
        actor(req)
    )));
    router.get('/wallets', async (req, res) => run(res, () => repository.listWallets(req.query.q)));
    router.get('/ledger', async (req, res) => run(res, () => repository.listLedger(req.query.q)));
    router.get('/exceptions', async (_req, res) => run(res, () => repository.listExceptions()));
    router.get('/reconciliation', async (req, res) => run(res, () => repository.readOnlyReconciliation(req.query)));
    router.post('/exceptions/:resourceType/:resourceRef/review', async (req, res) => run(res, () => repository.recordExceptionReview(
        req.params.resourceType,
        req.params.resourceRef,
        req.body,
        actor(req)
    )));

    return router;
}

function actor(req) {
    return String(req.admin?.email || 'admin').trim().toLowerCase().slice(0, 128);
}

async function run(res, callback) {
    try {
        const data = await callback();
        return res.json({ success: true, data });
    } catch (error) {
        return sendError(res, error);
    }
}

function sendError(res, error) {
    if (error instanceof BusinessError) {
        return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    if (error?.code === 'BUSINESS_SCHEMA_NOT_READY' || error?.code === 'BUSINESS_DATABASE_NOT_ISOLATED') {
        return res.status(503).json({ success: false, code: error.code, message: '业务数据服务未就绪，请联系管理员检查业务库配置' });
    }
    if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, code: 'DUPLICATE_VALUE', message: '编号已存在，请检查后重试' });
    }
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT' || error?.code === 'ENOTFOUND') {
        return res.status(503).json({ success: false, code: 'BUSINESS_DATABASE_UNAVAILABLE', message: '业务数据服务暂不可用，请稍后重试' });
    }
    console.warn(`[BusinessAdmin] request failed: ${String(error?.code || error?.name || 'unknown')}`);
    return res.status(500).json({ success: false, code: 'BUSINESS_OPERATION_FAILED', message: '操作未完成，请稍后重试' });
}

module.exports = { createBusinessAdminRouter };
