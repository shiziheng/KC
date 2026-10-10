'use strict';

const express = require('express');
const repository = require('./repository');
const { BusinessError } = require('./validation');
const { assertSchemaReady } = require('../business-infra/business-db');

function createBusinessStorefrontRouter(requireUser) {
    const router = express.Router();

    router.get('/products', async (_req, res) => run(res, () => repository.listStorefrontProducts()));
    router.get('/orders', requireUser, async (req, res) => run(res, () => repository.listStorefrontOrders(req.storefrontUser)));
    router.post('/orders', requireUser, async (req, res) => run(res, () => repository.createStorefrontMockOrder(
        req.body,
        req.get('Idempotency-Key'),
        req.storefrontUser
    ), 201));
    router.post('/orders/:orderRef/mock-payment', requireUser, async (req, res) => run(res, () => repository.updateStorefrontMockOrder(
        req.params.orderRef,
        { type: 'payment' },
        req.storefrontUser
    )));
    router.post('/orders/:orderRef/mock-fulfillment', requireUser, async (req, res) => run(res, () => repository.updateStorefrontMockOrder(
        req.params.orderRef,
        { type: 'fulfillment' },
        req.storefrontUser
    )));
    router.post('/orders/:orderRef/after-sales', requireUser, async (req, res) => run(res, () => repository.updateStorefrontMockOrder(
        req.params.orderRef,
        { type: 'after-sales', reason: req.body?.reason },
        req.storefrontUser
    ), 201));

    router.get('/health', async (_req, res) => {
        try {
            await assertSchemaReady();
            return res.json({ success: true, data: { ready: true, mode: 'MOCK' } });
        } catch (error) {
            return sendError(res, error);
        }
    });
    return router;
}

async function run(res, callback, successStatus = 200) {
    try {
        const data = await callback();
        return res.status(successStatus).json({ success: true, data });
    } catch (error) {
        return sendError(res, error);
    }
}

function sendError(res, error) {
    if (error instanceof BusinessError) {
        return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    if (error?.code === 'BUSINESS_SCHEMA_NOT_READY' || error?.code === 'BUSINESS_DATABASE_NOT_ISOLATED') {
        return res.status(503).json({ success: false, code: error.code, message: '业务数据服务未就绪，请稍后重试' });
    }
    if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, code: 'DUPLICATE_VALUE', message: '请求重复，请刷新订单列表确认结果' });
    }
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT' || error?.code === 'ENOTFOUND') {
        return res.status(503).json({ success: false, code: 'BUSINESS_DATABASE_UNAVAILABLE', message: '业务数据服务暂不可用，请稍后重试' });
    }
    console.warn(`[BusinessStorefront] request failed: ${String(error?.code || error?.name || 'unknown')}`);
    return res.status(500).json({ success: false, code: 'BUSINESS_OPERATION_FAILED', message: '操作未完成，请稍后重试' });
}

module.exports = { createBusinessStorefrontRouter };
