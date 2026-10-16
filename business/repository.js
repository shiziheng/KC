'use strict';

const crypto = require('crypto');
const {
    BusinessError,
    normalizeProduct,
    normalizeEmail,
    maskEmail,
    accountFingerprint,
    makeRef,
    normalizeIdempotencyKey,
    normalizeReason,
    parseMoney,
    formatMoney
} = require('./validation');
const { getBusinessPool, assertSchemaReady, withBusinessTransaction } = require('../business-infra/business-db');
const { createReadOnlyReconciliation } = require('./reconciliation');
const { assertPurchasableZovoPlan, buildMockUpstreamOrderMapping } = require('./zovo-catalog');

const USDT_RANDOM_CODE_LOCK = 'kc-business:mock-usdt-random-code:v1';
const USDT_BASE_LIMIT = 50_000_000_000; // 50,000 USDT，USDT 按 6 位小数保存
const USD_CREDIT_LIMIT = 5_000_000_000; // 50,000 USD，USD 按 2 位小数保存
const readOnlyReconciliation = createReadOnlyReconciliation();

function parseJson(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function safeMinorOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const minor = Number(value);
    return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

function publicProduct(row) {
    const config = parseJson(row.config);
    return {
        id: Number(row.id),
        productCode: row.product_code,
        name: row.name,
        planCode: row.plan_code,
        providerId: row.provider_id || 'mock',
        providerProductRef: row.provider_product_ref || row.plan_code,
        upstreamProductName: config.upstream_product_name || row.plan_code,
        upstreamCatalogSource: config.catalog_source || 'legacy_mapping',
        upstreamCatalogVersion: config.catalog_version ?? null,
        upstreamServiceFeeUsdMinor: safeMinorOrNull(config.upstream_service_fee_usd_minor),
        isCredit: config.is_credit === true,
        requiresActiveSubscription: config.requires_active_subscription === true,
        currency: row.currency,
        faceAmount: formatMoney(row.face_amount_minor, row.currency),
        sellingAmount: formatMoney(row.selling_amount_minor, row.currency),
        costAmount: row.cost_amount_minor == null ? '' : formatMoney(row.cost_amount_minor, row.currency),
        availability: row.availability,
        version: Number(row.version_no || 1),
        updatedAt: row.updated_at
    };
}

function publicOrder(row) {
    const snapshot = parseJson(row.product_snapshot);
    const upstream = snapshot.upstream && typeof snapshot.upstream === 'object' ? snapshot.upstream : {};
    return {
        orderRef: row.order_ref,
        productName: snapshot.name || row.product_name || '余额充值',
        productCode: row.product_code || '',
        amount: formatMoney(row.amount_minor, row.currency),
        currency: row.currency,
        paymentStatus: row.payment_status,
        fulfillmentStatus: row.fulfillment_status,
        afterSalesStatus: row.after_sales_status,
        account: row.account_email_masked || '',
        executionMode: snapshot.execution_mode || 'mock',
        upstreamProvider: upstream.provider || 'zovocard',
        upstreamProductRef: upstream.product_ref || snapshot.plan_code || '',
        upstreamProductName: upstream.product_name || '',
        upstreamCatalogVersion: upstream.catalog_version ?? null,
        upstreamServiceFeeUsdMinor: safeMinorOrNull(upstream.service_fee_usd_minor),
        upstreamOrderRef: upstream.order_ref || '',
        createdAt: row.created_at,
        completedAt: row.completed_at
    };
}

function publicTopup(row) {
    const metadata = parseJson(row.metadata);
    return {
        paymentRef: row.payment_ref,
        orderRef: row.order_ref,
        account: row.account_email_masked || '',
        expectedUsdt: formatMoney(row.expected_amount_minor, 'USDT'),
        receivedUsdt: formatMoney(row.received_amount_minor, 'USDT'),
        creditUsd: formatMoney(metadata.credit_amount_minor || 0, 'USD'),
        randomCode: row.random_code || '',
        status: row.status,
        transactionRef: row.provider_tx_ref || '',
        createdAt: row.created_at,
        paidAt: row.paid_at
    };
}

async function listProducts() {
    await assertSchemaReady();
    const [rows] = await getBusinessPool().query(
        `SELECT id, product_code, name, plan_code, currency, face_amount_minor,
                selling_amount_minor, cost_amount_minor, availability, version_no, updated_at,
                provider_id, provider_product_ref, config
           FROM biz_products
          ORDER BY updated_at DESC, id DESC
          LIMIT 200`
    );
    return rows.map(publicProduct);
}

async function listStorefrontProducts() {
    await assertSchemaReady();
    const [rows] = await getBusinessPool().query(
        `SELECT id, product_code, name, plan_code, currency, face_amount_minor,
                selling_amount_minor, availability, updated_at, provider_product_ref, config
           FROM biz_products
          WHERE availability = 'onsale'
          ORDER BY updated_at DESC, id DESC
          LIMIT 100`
    );
    return rows.map((row) => {
        const config = parseJson(row.config);
        return {
            id: Number(row.id),
            productCode: row.product_code,
            name: row.name,
            planCode: row.plan_code,
            upstreamProductName: config.upstream_product_name || row.plan_code,
            isCredit: config.is_credit === true,
            requiresActiveSubscription: config.requires_active_subscription === true,
            currency: row.currency,
            faceAmount: formatMoney(row.face_amount_minor, row.currency),
            sellingAmount: formatMoney(row.selling_amount_minor, row.currency),
            availability: row.availability,
            updatedAt: row.updated_at
        };
    });
}

async function getOrCreateStorefrontUser(connection, user) {
    const userId = String(user.id || '').trim();
    if (!/^\d{1,20}$/.test(userId)) throw new BusinessError(401, 'USER_AUTH_INVALID', '登录状态无效，请重新登录');
    const email = normalizeEmail(user.email);
    const emailFingerprint = accountFingerprint(email);
    const businessUserRef = `usr_${accountFingerprint(`storefront:${userId}`).slice(0, 48)}`;
    await connection.execute(
        `INSERT IGNORE INTO biz_user_mappings
            (business_user_ref, legacy_system, legacy_user_ref, account_email_masked,
             account_fingerprint, status, source_channel)
         VALUES (?, 'storefront', ?, ?, ?, 'active', 'storefront_mock')`,
        [businessUserRef, userId, maskEmail(email), emailFingerprint]
    );
    const [rows] = await connection.execute(
        `SELECT id, business_user_ref, status FROM biz_user_mappings
          WHERE legacy_system = 'storefront' AND legacy_user_ref = ? LIMIT 1 FOR UPDATE`,
        [userId]
    );
    const mapped = rows[0];
    if (!mapped || mapped.status !== 'active') throw new BusinessError(403, 'USER_MAPPING_INACTIVE', '当前账号暂不可下单');
    return { id: Number(mapped.id), businessUserRef: mapped.business_user_ref, email, emailFingerprint };
}

async function createStorefrontMockOrder(input, idempotencyRaw, user) {
    await assertSchemaReady();
    const { assertPlainObject } = require('./validation');
    assertPlainObject(input);
    const productId = Number(input.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) throw new BusinessError(400, 'INVALID_PRODUCT_ID', '商品编号无效');
    const idempotencyKey = normalizeIdempotencyKey(idempotencyRaw);
    const orderRef = makeRef('ORD');
    const userId = String(user?.id || '').trim();

    const result = await withBusinessTransaction(async (connection) => {
        const mappedUser = await getOrCreateStorefrontUser(connection, user);
        const [existing] = await connection.execute(
            `SELECT order_ref, user_mapping_id, product_id
               FROM biz_recharge_orders
              WHERE source_channel = 'storefront_mock' AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
            [idempotencyKey]
        );
        if (existing.length) {
            if (Number(existing[0].user_mapping_id) !== mappedUser.id || Number(existing[0].product_id) !== productId) {
                throw new BusinessError(409, 'IDEMPOTENCY_CONFLICT', '请求编号已用于其他订单');
            }
            return { orderRef: existing[0].order_ref, reused: true };
        }

        const [products] = await connection.execute(
            `SELECT id, product_code, name, plan_code, currency, selling_amount_minor, availability,
                    provider_id, provider_product_ref, config
               FROM biz_products WHERE id = ? FOR UPDATE`,
            [productId]
        );
        const product = products[0];
        if (!product) throw new BusinessError(404, 'PRODUCT_NOT_FOUND', '商品不存在');
        if (product.availability !== 'onsale') throw new BusinessError(409, 'PRODUCT_NOT_ONSALE', '商品当前未上架');
        const productConfig = parseJson(product.config);
        const snapshot = {
            kind: 'mock_recharge',
            product_code: product.product_code,
            name: product.name,
            plan_code: product.plan_code,
            upstream: buildMockUpstreamOrderMapping({
                orderRef,
                productRef: product.provider_product_ref || product.plan_code,
                productName: productConfig.upstream_product_name || product.provider_product_ref || product.plan_code,
                catalogSource: productConfig.catalog_source,
                catalogVersion: productConfig.catalog_version,
                serviceFeeUsdMinor: safeMinorOrNull(productConfig.upstream_service_fee_usd_minor),
                isCredit: productConfig.is_credit,
                requiresActiveSubscription: productConfig.requires_active_subscription
            }),
            currency: product.currency,
            amount_minor: Number(product.selling_amount_minor),
            execution_mode: 'mock'
        };
        await connection.execute(
            `INSERT INTO biz_recharge_orders
                (order_ref, idempotency_key, user_mapping_id, product_id, product_snapshot,
                 currency, amount_minor, payment_status, fulfillment_status, compensation_status,
                 after_sales_status, account_email_masked, account_fingerprint, source_channel)
             VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, 'unpaid', 'pending', 'none',
                     'none', ?, ?, 'storefront_mock')`,
            [orderRef, idempotencyKey, mappedUser.id, product.id, JSON.stringify(snapshot), product.currency,
                product.selling_amount_minor, maskEmail(mappedUser.email), mappedUser.emailFingerprint]
        );
        await insertAuditAs(connection, 'user', `storefront:${userId}`, 'customer', 'order.mock_created',
            'order', orderRef, 'MOCK_ORDER_CREATED', { product_id: productId, execution_mode: 'mock' });
        return { orderRef, reused: false };
    });
    return result;
}

async function listStorefrontOrders(user) {
    await assertSchemaReady();
    const userId = String(user?.id || '').trim();
    if (!/^\d{1,20}$/.test(userId)) throw new BusinessError(401, 'USER_AUTH_INVALID', '登录状态无效，请重新登录');
    const [mappings] = await getBusinessPool().execute(
        `SELECT id FROM biz_user_mappings WHERE legacy_system = 'storefront' AND legacy_user_ref = ? LIMIT 1`,
        [userId]
    );
    if (!mappings.length) return [];
    const [rows] = await getBusinessPool().execute(
        `SELECT o.order_ref, o.product_snapshot, o.currency, o.amount_minor,
                o.payment_status, o.fulfillment_status, o.after_sales_status,
                o.created_at, o.completed_at, p.name AS product_name
           FROM biz_recharge_orders o
           LEFT JOIN biz_products p ON p.id = o.product_id
          WHERE o.user_mapping_id = ? AND o.source_channel = 'storefront_mock'
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT 100`,
        [mappings[0].id]
    );
    return rows.map((row) => ({
        orderRef: row.order_ref,
        productName: row.product_name || parseJson(row.product_snapshot).name || '代充商品',
        amount: formatMoney(row.amount_minor, row.currency),
        currency: row.currency,
        paymentStatus: row.payment_status,
        fulfillmentStatus: row.fulfillment_status,
        afterSalesStatus: row.after_sales_status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        receiptKind: 'mock_transaction_receipt'
    }));
}

async function updateStorefrontMockOrder(orderRefRaw, action, user) {
    await assertSchemaReady();
    const orderRef = String(orderRefRaw || '').trim();
    const userId = String(user?.id || '').trim();
    if (!/^ORD-[A-F0-9]{24}$/.test(orderRef) || !/^\d{1,20}$/.test(userId)) {
        throw new BusinessError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    return withBusinessTransaction(async (connection) => {
        const [mappings] = await connection.execute(
            `SELECT id FROM biz_user_mappings WHERE legacy_system = 'storefront' AND legacy_user_ref = ? LIMIT 1`,
            [userId]
        );
        if (!mappings.length) throw new BusinessError(404, 'ORDER_NOT_FOUND', '订单不存在');
        const [rows] = await connection.execute(
            `SELECT order_ref, user_mapping_id, payment_status, fulfillment_status, after_sales_status
               FROM biz_recharge_orders
              WHERE order_ref = ? AND source_channel = 'storefront_mock' LIMIT 1 FOR UPDATE`,
            [orderRef]
        );
        const order = rows[0];
        if (!order || Number(order.user_mapping_id) !== Number(mappings[0].id)) {
            throw new BusinessError(404, 'ORDER_NOT_FOUND', '订单不存在');
        }

        if (action.type === 'payment') {
            if (order.payment_status === 'paid') return { orderRef, reused: true, message: '该模拟订单已标记为已支付' };
            if (order.payment_status !== 'unpaid') throw new BusinessError(409, 'ORDER_STATE_CONFLICT', '当前订单状态不能模拟支付');
            await connection.execute(
                `UPDATE biz_recharge_orders SET payment_status = 'paid', updated_at = CURRENT_TIMESTAMP(3) WHERE order_ref = ?`,
                [orderRef]
            );
            await insertAuditAs(connection, 'user', `storefront:${userId}`, 'customer', 'order.mock_paid', 'order', orderRef,
                'MOCK_PAYMENT_CONFIRMED', { execution_mode: 'mock', no_money_moved: true });
            return { orderRef, reused: false, message: '模拟支付已确认；没有收款或余额变动' };
        }

        if (action.type === 'fulfillment') {
            if (order.fulfillment_status === 'completed') return { orderRef, reused: true, message: '模拟履约已完成' };
            if (order.payment_status !== 'paid' || !['pending', 'running'].includes(order.fulfillment_status)) {
                throw new BusinessError(409, 'ORDER_STATE_CONFLICT', '请先完成模拟支付');
            }
            await connection.execute(
                `UPDATE biz_recharge_orders SET fulfillment_status = 'completed', completed_at = CURRENT_TIMESTAMP(3),
                    updated_at = CURRENT_TIMESTAMP(3) WHERE order_ref = ?`,
                [orderRef]
            );
            await insertAuditAs(connection, 'user', `storefront:${userId}`, 'customer', 'order.mock_fulfilled', 'order', orderRef,
                'MOCK_FULFILLMENT_COMPLETED', { execution_mode: 'mock', external_call: false });
            return { orderRef, reused: false, message: '模拟履约已完成；没有调用 ZovoCard 或其他上游' };
        }

        if (action.type === 'after-sales') {
            if (order.after_sales_status !== 'none') throw new BusinessError(409, 'AFTER_SALES_EXISTS', '该订单已有售后申请');
            if (!['unpaid', 'paid'].includes(order.payment_status)) throw new BusinessError(409, 'ORDER_STATE_CONFLICT', '当前订单不能申请售后');
            const reason = normalizeReason(action.reason);
            await connection.execute(
                `UPDATE biz_recharge_orders SET after_sales_status = 'pending', updated_at = CURRENT_TIMESTAMP(3) WHERE order_ref = ?`,
                [orderRef]
            );
            await insertAuditAs(connection, 'user', `storefront:${userId}`, 'customer', 'after_sales.requested', 'order', orderRef,
                'AFTER_SALES_REQUESTED', { reason, refund_executed: false });
            return { orderRef, reused: false, message: '售后申请已提交，等待运营处理；不会自动退款' };
        }
        throw new BusinessError(400, 'INVALID_ORDER_ACTION', '模拟订单操作无效');
    });
}

async function createProduct(input, actorRef) {
    await assertSchemaReady();
    const { catalog, plan } = await assertPurchasableZovoPlan(String(input?.planCode || '').trim().toLowerCase());
    const product = normalizeProduct(input, {
        allowedPlanCodes: new Set(catalog.plans.filter((item) => item.enabled && item.purchasable && !item.renewalOnly).map((item) => item.key))
    });
    const productId = await withBusinessTransaction(async (connection) => {
        const [result] = await connection.execute(
            `INSERT INTO biz_products
                (product_code, name, plan_code, currency, face_amount_minor,
                 selling_amount_minor, cost_amount_minor, availability,
                 provider_id, provider_product_ref, source_channel, version_no, config)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mock', ?, 'admin', 1, ?)` ,
            [
                product.productCode,
                product.name,
                product.planCode,
                product.currency,
                product.faceAmountMinor,
                product.sellingAmountMinor,
                product.costAmountMinor,
                product.availability,
                product.planCode,
                JSON.stringify({
                    execution_mode: 'mock',
                    catalog_source: catalog.mode === 'MOCK' ? 'zovocard_mock_catalog' : 'zovocard_registry',
                    upstream_product_name: plan.name,
                    upstream_product_ref: plan.key,
                    acc_plan_key: plan.accPlanKey,
                    catalog_version: catalog.catalogVersion,
                    upstream_service_fee_usd_minor: plan.serviceFeeUsdMinor,
                    is_credit: plan.isCredit,
                    requires_active_subscription: plan.requiresActiveSubscription
                })
            ]
        );
        await insertAudit(connection, actorRef, 'product.created', 'product', String(result.insertId), 'PRODUCT_CREATED');
        return Number(result.insertId);
    });
    return getProduct(productId);
}

async function updateProduct(id, input, actorRef) {
    await assertSchemaReady();
    const productId = Number(id);
    if (!Number.isSafeInteger(productId) || productId < 1) {
        throw new BusinessError(400, 'INVALID_PRODUCT_ID', '商品编号无效');
    }
    const { catalog, plan } = await assertPurchasableZovoPlan(String(input?.planCode || '').trim().toLowerCase());
    const product = normalizeProduct(input, {
        allowedPlanCodes: new Set(catalog.plans.filter((item) => item.enabled && item.purchasable && !item.renewalOnly).map((item) => item.key))
    });
    await withBusinessTransaction(async (connection) => {
        const [rows] = await connection.execute('SELECT id, config FROM biz_products WHERE id = ? FOR UPDATE', [productId]);
        if (!rows.length) throw new BusinessError(404, 'PRODUCT_NOT_FOUND', '商品不存在');
        const nextConfig = {
            ...parseJson(rows[0].config),
            execution_mode: 'mock',
            catalog_source: catalog.mode === 'MOCK' ? 'zovocard_mock_catalog' : 'zovocard_registry',
            upstream_product_name: plan.name,
            upstream_product_ref: plan.key,
            acc_plan_key: plan.accPlanKey,
            catalog_version: catalog.catalogVersion,
            upstream_service_fee_usd_minor: plan.serviceFeeUsdMinor,
            is_credit: plan.isCredit,
            requires_active_subscription: plan.requiresActiveSubscription
        };
        await connection.execute(
            `UPDATE biz_products
                SET product_code = ?, name = ?, plan_code = ?, currency = ?,
                    face_amount_minor = ?, selling_amount_minor = ?, cost_amount_minor = ?,
                    availability = ?, provider_id = 'mock', provider_product_ref = ?,
                    source_channel = 'admin', version_no = version_no + 1,
                    config = CAST(? AS JSON),
                    updated_at = CURRENT_TIMESTAMP(3)
              WHERE id = ?`,
            [
                product.productCode,
                product.name,
                product.planCode,
                product.currency,
                product.faceAmountMinor,
                product.sellingAmountMinor,
                product.costAmountMinor,
                product.availability,
                product.planCode,
                JSON.stringify(nextConfig),
                productId
            ]
        );
        await insertAudit(connection, actorRef, 'product.updated', 'product', String(productId), 'PRODUCT_UPDATED');
    });
    return getProduct(productId);
}

async function getProduct(id) {
    const [rows] = await getBusinessPool().execute(
        `SELECT id, product_code, name, plan_code, currency, face_amount_minor,
                selling_amount_minor, cost_amount_minor, availability, version_no, updated_at,
                provider_id, provider_product_ref, config
           FROM biz_products WHERE id = ? LIMIT 1`,
        [Number(id)]
    );
    if (!rows.length) throw new BusinessError(404, 'PRODUCT_NOT_FOUND', '商品不存在');
    return publicProduct(rows[0]);
}

async function createMockOrder(input, idempotencyRaw, actorRef) {
    await assertSchemaReady();
    const { assertPlainObject } = require('./validation');
    assertPlainObject(input);
    const productId = Number(input.productId);
    const email = normalizeEmail(input.accountEmail);
    const fingerprint = accountFingerprint(email);
    const maskedEmail = maskEmail(email);
    const idempotencyKey = normalizeIdempotencyKey(idempotencyRaw);
    const orderRef = makeRef('ORD');

    const result = await withBusinessTransaction(async (connection) => {
        const [existing] = await connection.execute(
            `SELECT order_ref, product_id, account_fingerprint
               FROM biz_recharge_orders
              WHERE source_channel = 'admin_mock' AND idempotency_key = ? LIMIT 1`,
            [idempotencyKey]
        );
        if (existing.length) {
            if (existing[0].account_fingerprint !== fingerprint || Number(existing[0].product_id) !== productId) {
                throw new BusinessError(409, 'IDEMPOTENCY_CONFLICT', '请求编号已用于其他账号或商品');
            }
            return { orderRef: existing[0].order_ref, reused: true };
        }

        const [products] = await connection.execute(
            `SELECT id, product_code, name, plan_code, currency, selling_amount_minor, availability,
                    provider_id, provider_product_ref, config
               FROM biz_products WHERE id = ? FOR UPDATE`,
            [productId]
        );
        const product = products[0];
        if (!product) throw new BusinessError(404, 'PRODUCT_NOT_FOUND', '商品不存在');
        if (product.availability !== 'onsale') throw new BusinessError(409, 'PRODUCT_NOT_ONSALE', '商品当前未上架');
        const productConfig = parseJson(product.config);
        const snapshot = {
            kind: 'mock_recharge',
            product_code: product.product_code,
            name: product.name,
            plan_code: product.plan_code,
            upstream: buildMockUpstreamOrderMapping({
                orderRef,
                productRef: product.provider_product_ref || product.plan_code,
                productName: productConfig.upstream_product_name || product.provider_product_ref || product.plan_code,
                catalogSource: productConfig.catalog_source,
                catalogVersion: productConfig.catalog_version,
                serviceFeeUsdMinor: safeMinorOrNull(productConfig.upstream_service_fee_usd_minor),
                isCredit: productConfig.is_credit,
                requiresActiveSubscription: productConfig.requires_active_subscription
            }),
            currency: product.currency,
            amount_minor: Number(product.selling_amount_minor),
            execution_mode: 'mock'
        };
        const [inserted] = await connection.execute(
            `INSERT INTO biz_recharge_orders
                (order_ref, idempotency_key, user_mapping_id, product_id, product_snapshot,
                 currency, amount_minor, payment_status, fulfillment_status, compensation_status,
                 after_sales_status, account_email_masked, account_fingerprint,
                 source_channel)
             VALUES (?, ?, NULL, ?, CAST(? AS JSON), ?, ?, 'unpaid', 'pending', 'none', 'none', ?, ?, 'admin_mock')`,
            [orderRef, idempotencyKey, product.id, JSON.stringify(snapshot), product.currency,
                product.selling_amount_minor, maskedEmail, fingerprint]
        );
        await insertAudit(connection, actorRef, 'order.mock_created', 'order', orderRef, 'MOCK_ORDER_CREATED', {
            product_id: productId,
            amount_minor: Number(product.selling_amount_minor),
            currency: product.currency
        });
        return { orderRef, reused: false, id: Number(inserted.insertId) };
    });
    return result;
}

async function listOrders(search = '') {
    await assertSchemaReady();
    const term = String(search || '').trim().slice(0, 80);
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const [rows] = await getBusinessPool().execute(
        `SELECT o.order_ref, o.product_snapshot, o.currency, o.amount_minor,
                o.payment_status, o.fulfillment_status, o.after_sales_status,
                o.account_email_masked, o.created_at, o.completed_at,
                p.name AS product_name, p.product_code
           FROM biz_recharge_orders o
           LEFT JOIN biz_products p ON p.id = o.product_id
          WHERE (? = '' OR o.order_ref LIKE ? OR o.account_email_masked LIKE ? OR p.name LIKE ?)
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT 100`,
        [term, like, like, like]
    );
    return rows.map(publicOrder);
}

async function ensureUserAndWallet(connection, email) {
    const fingerprint = accountFingerprint(email);
    const userRef = `usr_${fingerprint.slice(0, 48)}`;
    await connection.execute(
        `INSERT IGNORE INTO biz_user_mappings
            (business_user_ref, legacy_system, legacy_user_ref, account_email_masked,
             account_fingerprint, status, source_channel)
         VALUES (?, 'business_admin_mock', ?, ?, ?, 'active', 'admin_mock')`,
        [userRef, fingerprint, maskEmail(email), fingerprint]
    );
    const [users] = await connection.execute(
        `SELECT id, business_user_ref FROM biz_user_mappings
          WHERE legacy_system = 'business_admin_mock' AND legacy_user_ref = ? LIMIT 1`,
        [fingerprint]
    );
    if (!users.length) throw new BusinessError(500, 'USER_MAPPING_FAILED', '无法建立账号映射');
    const user = users[0];
    await connection.execute(
        `INSERT IGNORE INTO biz_wallet_accounts
            (wallet_ref, owner_type, owner_ref, currency, available_balance_minor,
             reserved_balance_minor, status, source_channel)
         VALUES (?, 'user', ?, 'USD', 0, 0, 'active', 'admin_mock')`,
        [makeRef('WAL'), user.business_user_ref]
    );
    const [wallets] = await connection.execute(
        `SELECT id, wallet_ref, available_balance_minor, reserved_balance_minor, currency, status
           FROM biz_wallet_accounts
          WHERE owner_type = 'user' AND owner_ref = ? AND currency = 'USD' LIMIT 1 FOR UPDATE`,
        [user.business_user_ref]
    );
    if (!wallets.length) throw new BusinessError(500, 'WALLET_NOT_FOUND', '无法建立余额账户');
    return { user, wallet: wallets[0], fingerprint };
}

function parseUsdtBase(raw) {
    const value = String(raw ?? '').trim();
    if (!/^(0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) {
        throw new BusinessError(400, 'INVALID_USDT_BASE', '基础收款金额需为 USDT，最多两位小数');
    }
    return parseMoney(value, 'USDT', { minMinor: 10_000, maxMinor: USDT_BASE_LIMIT });
}

async function allocateRandomCode(connection, baseAmountMinor) {
    const [usedRows] = await connection.execute(
        `SELECT random_code, expected_amount_minor
           FROM biz_payment_transactions
          WHERE payment_channel = 'mock_usdt'
            AND currency = 'USDT'
            AND status IN ('pending', 'manual_review')
          FOR UPDATE`
    );
    const usedAmounts = new Set(usedRows.map((row) => String(row.expected_amount_minor)));
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const randomCode = String(crypto.randomInt(1, 10000)).padStart(4, '0');
        const expected = baseAmountMinor + Number(randomCode) * 100; // 随机尾数 0.0001 USDT
        if (!usedAmounts.has(String(expected))) return { randomCode, expected };
    }
    throw new BusinessError(409, 'RANDOM_CODE_EXHAUSTED', '暂时无法分配唯一收款识别码，请稍后重试');
}

async function createMockTopup(input, idempotencyRaw, actorRef) {
    await assertSchemaReady();
    const { assertPlainObject } = require('./validation');
    assertPlainObject(input);
    const email = normalizeEmail(input.accountEmail);
    const fingerprint = accountFingerprint(email);
    const expectedBaseMinor = parseUsdtBase(input.baseUsdt);
    const creditUsdMinor = parseMoney(input.creditUsd, 'USD', { minMinor: 1, maxMinor: USD_CREDIT_LIMIT });
    const reason = normalizeReason(input.reason);
    const idempotencyKey = normalizeIdempotencyKey(idempotencyRaw);
    const pool = getBusinessPool();
    const connection = await pool.getConnection();
    let namedLock = false;
    try {
        const [lockRows] = await connection.query('SELECT GET_LOCK(?, 5) AS acquired', [USDT_RANDOM_CODE_LOCK]);
        namedLock = Number(lockRows[0]?.acquired) === 1;
        if (!namedLock) throw new BusinessError(503, 'RANDOM_CODE_LOCK_BUSY', '收款识别码正在分配，请稍后重试');

        await connection.beginTransaction();
        const [existing] = await connection.execute(
            `SELECT p.payment_ref, p.order_ref, p.user_mapping_id, p.expected_amount_minor, p.metadata,
                    o.account_fingerprint
               FROM biz_payment_transactions p
               LEFT JOIN biz_recharge_orders o ON o.order_ref = p.order_ref
              WHERE p.payment_channel = 'mock_usdt' AND p.idempotency_key = ? LIMIT 1 FOR UPDATE`,
            [idempotencyKey]
        );
        if (existing.length) {
            const row = existing[0];
            const previous = parseJson(row.metadata);
            if (row.account_fingerprint !== fingerprint
                || Number(previous.base_usdt_minor) !== expectedBaseMinor
                || Number(previous.credit_amount_minor) !== creditUsdMinor) {
                throw new BusinessError(409, 'IDEMPOTENCY_CONFLICT', '请求编号已用于其他充值');
            }
            await connection.commit();
            return { paymentRef: row.payment_ref, orderRef: row.order_ref, reused: true };
        }

        const { user } = await ensureUserAndWallet(connection, email);
        const { randomCode, expected } = await allocateRandomCode(connection, expectedBaseMinor);
        const orderRef = makeRef('TOP');
        const paymentRef = makeRef('PAY');
        const creditRate = (creditUsdMinor / 100) / (expected / 1_000_000);
        const metadata = {
            mode: 'mock',
            base_usdt_minor: expectedBaseMinor,
            random_code: randomCode,
            credit_amount_minor: creditUsdMinor,
            credit_currency: 'USD',
            display_fx_rate: Number(creditRate.toFixed(8)),
            operator_reason: reason
        };
        const snapshot = {
            kind: 'wallet_topup',
            payment_currency: 'USDT',
            expected_amount_minor: expected,
            credit_currency: 'USD',
            credit_amount_minor: creditUsdMinor,
            execution_mode: 'mock'
        };
        await connection.execute(
            `INSERT INTO biz_recharge_orders
                (order_ref, idempotency_key, user_mapping_id, product_id, product_snapshot,
                 currency, amount_minor, payment_status, fulfillment_status, compensation_status,
                 after_sales_status, account_email_masked, account_fingerprint, source_channel)
             VALUES (?, ?, ?, NULL, CAST(? AS JSON), 'USD', ?, 'unpaid', 'not_required', 'none',
                     'none', ?, ?, 'admin_mock')`,
            [orderRef, idempotencyKey, user.id, JSON.stringify(snapshot), creditUsdMinor,
                maskEmail(email), fingerprint]
        );
        await connection.execute(
            `INSERT INTO biz_payment_transactions
                (payment_ref, order_ref, user_mapping_id, payment_channel, idempotency_key,
                 currency, expected_amount_minor, received_amount_minor, random_code, status,
                 source_channel, metadata)
             VALUES (?, ?, ?, 'mock_usdt', ?, 'USDT', ?, 0, ?, 'pending', 'admin_mock', CAST(? AS JSON))`,
            [paymentRef, orderRef, user.id, idempotencyKey, expected, randomCode, JSON.stringify(metadata)]
        );
        await insertAudit(connection, actorRef, 'topup.mock_created', 'payment', paymentRef, 'MOCK_TOPUP_CREATED', {
            order_ref: orderRef,
            expected_usdt_minor: expected,
            credit_usd_minor: creditUsdMinor,
            reason
        });
        await connection.commit();
        return { paymentRef, orderRef, randomCode, expectedUsdt: formatMoney(expected, 'USDT'), creditUsd: formatMoney(creditUsdMinor, 'USD'), reused: false };
    } catch (error) {
        try { await connection.rollback(); } catch (_) { /* connection may not have started a transaction */ }
        if (error && error.code === 'ER_DUP_ENTRY') {
            throw new BusinessError(409, 'DUPLICATE_REQUEST', '充值请求重复，请刷新列表确认结果');
        }
        throw error;
    } finally {
        if (namedLock) {
            try { await connection.query('SELECT RELEASE_LOCK(?)', [USDT_RANDOM_CODE_LOCK]); } catch (_) { /* release on close */ }
        }
        connection.release();
    }
}

async function listTopups(search = '') {
    await assertSchemaReady();
    const term = String(search || '').trim().slice(0, 80);
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const [rows] = await getBusinessPool().execute(
        `SELECT p.payment_ref, p.order_ref, p.expected_amount_minor, p.received_amount_minor,
                p.random_code, p.status, p.provider_tx_ref, p.metadata, p.created_at, p.paid_at,
                o.account_email_masked
           FROM biz_payment_transactions p
           LEFT JOIN biz_recharge_orders o ON o.order_ref = p.order_ref
          WHERE p.payment_channel = 'mock_usdt'
            AND (? = '' OR p.payment_ref LIKE ? OR p.order_ref LIKE ? OR o.account_email_masked LIKE ?)
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT 100`,
        [term, like, like, like]
    );
    return rows.map(publicTopup);
}

async function reconcileMockTopup(paymentRefRaw, input, actorRef) {
    await assertSchemaReady();
    const { assertPlainObject } = require('./validation');
    assertPlainObject(input);
    const paymentRef = String(paymentRefRaw || '').trim();
    if (!/^PAY-[A-F0-9]{24}$/.test(paymentRef)) {
        throw new BusinessError(400, 'INVALID_PAYMENT_REF', '充值编号格式无效');
    }
    const transactionRef = String(input.transactionRef || '').trim().toUpperCase();
    if (!/^MOCK-[A-F0-9]{16}$/.test(transactionRef)) {
        throw new BusinessError(400, 'MOCK_TRANSACTION_REF_REQUIRED', '模拟补单凭证需使用 MOCK- 加 16 位十六进制编号');
    }
    const receivedMinor = parseMoney(input.receivedUsdt, 'USDT', { minMinor: 0, maxMinor: USDT_BASE_LIMIT });
    const reason = normalizeReason(input.reason);

    return withBusinessTransaction(async (connection) => {
        const [payments] = await connection.execute(
            `SELECT payment_ref, order_ref, user_mapping_id, payment_channel, currency,
                    expected_amount_minor, received_amount_minor, status, metadata
               FROM biz_payment_transactions WHERE payment_ref = ? FOR UPDATE`,
            [paymentRef]
        );
        const payment = payments[0];
        if (!payment) throw new BusinessError(404, 'PAYMENT_NOT_FOUND', '充值记录不存在');
        if (payment.payment_channel !== 'mock_usdt' || payment.currency !== 'USDT') {
            throw new BusinessError(409, 'MOCK_ONLY', '该操作只允许用于 USDT 模拟充值记录');
        }
        const eventKey = `mock-topup-credit:${paymentRef}`;
        const [existingLedger] = await connection.execute(
            `SELECT id, available_balance_after_minor FROM biz_wallet_ledger_entries WHERE event_key = ? LIMIT 1`,
            [eventKey]
        );
        if (payment.status === 'paid' && existingLedger.length) {
            if (payment.provider_tx_ref !== transactionRef) {
                throw new BusinessError(409, 'PAYMENT_ALREADY_RECONCILED', '该充值已核验入账，不能替换原凭证');
            }
            await connection.commit();
            return {
                status: 'paid',
                credited: false,
                balanceAfterUsd: formatMoney(existingLedger[0].available_balance_after_minor, 'USD'),
                message: '该笔余额流水已存在，没有重复入账'
            };
        }
        const metadata = parseJson(payment.metadata);
        const creditUsdMinor = Number(metadata.credit_amount_minor);
        if (!Number.isSafeInteger(creditUsdMinor) || creditUsdMinor < 1) {
            throw new BusinessError(409, 'CREDIT_AMOUNT_MISSING', '充值记录缺少有效的平台余额入账金额');
        }
        const [duplicates] = await connection.execute(
            `SELECT payment_ref FROM biz_payment_transactions
              WHERE provider_tx_ref = ? AND payment_ref <> ? LIMIT 1`,
            [transactionRef, paymentRef]
        );
        if (duplicates.length) throw new BusinessError(409, 'TRANSACTION_ALREADY_USED', '该模拟凭证已关联其他充值');

        const [orders] = await connection.execute(
            `SELECT order_ref, user_mapping_id, account_email_masked, account_fingerprint, payment_status
               FROM biz_recharge_orders WHERE order_ref = ? FOR UPDATE`,
            [payment.order_ref]
        );
        const order = orders[0];
        if (!order || !payment.user_mapping_id || Number(order.user_mapping_id) !== Number(payment.user_mapping_id)) {
            throw new BusinessError(409, 'ORDER_MAPPING_MISSING', '充值与用户订单映射不完整，未入账');
        }
        const expectedMinor = Number(payment.expected_amount_minor);
        const matches = receivedMinor === expectedMinor;
        if (!matches) {
            const reviewMetadata = {
                ...metadata,
                last_mock_reconciliation: {
                    result: 'mismatch',
                    received_usdt_minor: receivedMinor,
                    reason,
                    actor_ref: actorRef,
                    at: new Date().toISOString()
                }
            };
            await connection.execute(
                `UPDATE biz_payment_transactions
                    SET received_amount_minor = ?, provider_tx_ref = ?, status = 'manual_review',
                        metadata = CAST(? AS JSON), updated_at = CURRENT_TIMESTAMP(3)
                  WHERE payment_ref = ?`,
                [receivedMinor, transactionRef, JSON.stringify(reviewMetadata), paymentRef]
            );
            await connection.execute(
                `UPDATE biz_recharge_orders SET payment_status = 'manual_review', updated_at = CURRENT_TIMESTAMP(3)
                  WHERE order_ref = ?`,
                [payment.order_ref]
            );
            await insertAudit(connection, actorRef, 'topup.mock_mismatch', 'payment', paymentRef, 'AMOUNT_MISMATCH', {
                expected_usdt_minor: expectedMinor,
                received_usdt_minor: receivedMinor,
                reason
            });
            return { status: 'manual_review', credited: false, message: '到账金额不匹配，未增加平台余额' };
        }

        const [mappings] = await connection.execute(
            `SELECT business_user_ref FROM biz_user_mappings WHERE id = ? LIMIT 1`,
            [payment.user_mapping_id]
        );
        if (!mappings.length) throw new BusinessError(409, 'USER_MAPPING_MISSING', '充值用户映射不存在，未入账');
        const [walletRows] = await connection.execute(
            `SELECT id, available_balance_minor, reserved_balance_minor, currency, status
               FROM biz_wallet_accounts
              WHERE owner_type = 'user' AND owner_ref = ? AND currency = 'USD'
              LIMIT 1 FOR UPDATE`,
            [mappings[0].business_user_ref]
        );
        const wallet = walletRows[0];
        if (!wallet || wallet.status !== 'active') throw new BusinessError(409, 'WALLET_NOT_ACTIVE', '余额账户不可用，未入账');

        let credited = false;
        let balanceAfter = Number(wallet.available_balance_minor);
        if (!existingLedger.length) {
            balanceAfter += creditUsdMinor;
            const reservedAfter = Number(wallet.reserved_balance_minor);
            await connection.execute(
                `UPDATE biz_wallet_accounts
                    SET available_balance_minor = ?, updated_at = CURRENT_TIMESTAMP(3)
                  WHERE id = ?`,
                [balanceAfter, wallet.id]
            );
            await connection.execute(
                `INSERT INTO biz_wallet_ledger_entries
                    (wallet_id, event_key, entry_type, available_delta_minor, reserved_delta_minor,
                     available_balance_after_minor, reserved_balance_after_minor, currency,
                     order_ref, payment_ref, actor_ref, reason_code, source_channel, metadata)
                 VALUES (?, ?, 'credit', ?, 0, ?, ?, 'USD', ?, ?, ?, 'MOCK_TOPUP_RECONCILE',
                         'admin_mock', CAST(? AS JSON))`,
                [wallet.id, eventKey, creditUsdMinor, balanceAfter, reservedAfter, payment.order_ref,
                    paymentRef, actorRef, JSON.stringify({ mode: 'mock', reason })]
            );
            credited = true;
        } else {
            balanceAfter = Number(existingLedger[0].available_balance_after_minor);
        }

        const paidMetadata = {
            ...metadata,
            last_mock_reconciliation: {
                result: 'matched',
                received_usdt_minor: receivedMinor,
                reason,
                actor_ref: actorRef,
                at: new Date().toISOString()
            }
        };
        await connection.execute(
            `UPDATE biz_payment_transactions
                SET received_amount_minor = ?, provider_tx_ref = ?, status = 'paid',
                    paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP(3)), metadata = CAST(? AS JSON),
                    updated_at = CURRENT_TIMESTAMP(3)
              WHERE payment_ref = ?`,
            [receivedMinor, transactionRef, JSON.stringify(paidMetadata), paymentRef]
        );
        await connection.execute(
            `UPDATE biz_recharge_orders SET payment_status = 'paid', updated_at = CURRENT_TIMESTAMP(3)
              WHERE order_ref = ?`,
            [payment.order_ref]
        );
        await insertAudit(connection, actorRef, 'topup.mock_reconciled', 'payment', paymentRef,
            credited ? 'MOCK_BALANCE_CREDITED' : 'MOCK_CREDIT_ALREADY_POSTED', {
                order_ref: payment.order_ref,
                received_usdt_minor: receivedMinor,
                credited_usd_minor: credited ? creditUsdMinor : 0,
                balance_after_usd_minor: balanceAfter,
                reason
            });
        return {
            status: 'paid',
            credited,
            balanceAfterUsd: formatMoney(balanceAfter, 'USD'),
            message: credited ? '模拟到账已核对，余额流水已补记' : '该笔余额流水已存在，没有重复入账'
        };
    });
}

async function listWallets(search = '') {
    await assertSchemaReady();
    const term = String(search || '').trim().slice(0, 80);
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const [rows] = await getBusinessPool().execute(
        `SELECT w.wallet_ref, w.owner_ref, w.currency, w.available_balance_minor,
                w.reserved_balance_minor, w.status, w.updated_at, u.account_email_masked
           FROM biz_wallet_accounts w
           LEFT JOIN biz_user_mappings u ON u.business_user_ref = w.owner_ref
          WHERE w.owner_type = 'user'
            AND (? = '' OR w.wallet_ref LIKE ? OR w.owner_ref LIKE ? OR u.account_email_masked LIKE ?)
          ORDER BY w.updated_at DESC, w.id DESC
          LIMIT 100`,
        [term, like, like, like]
    );
    return rows.map((row) => ({
        walletRef: row.wallet_ref,
        account: row.account_email_masked || '—',
        currency: row.currency,
        available: formatMoney(row.available_balance_minor, row.currency),
        reserved: formatMoney(row.reserved_balance_minor, row.currency),
        status: row.status,
        updatedAt: row.updated_at
    }));
}

async function listLedger(search = '') {
    await assertSchemaReady();
    const term = String(search || '').trim().slice(0, 80);
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const [rows] = await getBusinessPool().execute(
        `SELECT l.event_key, l.entry_type, l.available_delta_minor,
                l.available_balance_after_minor, l.currency, l.order_ref, l.payment_ref,
                l.reason_code, l.source_channel, l.created_at, u.account_email_masked
           FROM biz_wallet_ledger_entries l
           INNER JOIN biz_wallet_accounts w ON w.id = l.wallet_id
           LEFT JOIN biz_user_mappings u ON u.business_user_ref = w.owner_ref
          WHERE w.owner_type = 'user'
            AND (? = '' OR l.event_key LIKE ? OR l.order_ref LIKE ? OR l.payment_ref LIKE ? OR u.account_email_masked LIKE ?)
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT 100`,
        [term, like, like, like, like]
    );
    return rows.map((row) => ({
        eventKey: row.event_key,
        entryType: row.entry_type,
        delta: formatMoney(row.available_delta_minor, row.currency),
        balanceAfter: formatMoney(row.available_balance_after_minor, row.currency),
        currency: row.currency,
        orderRef: row.order_ref || '',
        paymentRef: row.payment_ref || '',
        account: row.account_email_masked || '—',
        reasonCode: row.reason_code || '',
        source: row.source_channel,
        createdAt: row.created_at
    }));
}

async function listExceptions() {
    const [orders, topups] = await Promise.all([listOrders(), listTopups()]);
    const exceptions = [];
    for (const order of orders) {
        const reasons = [];
        if (['manual_review', 'failed'].includes(order.paymentStatus)) reasons.push('支付异常');
        if (['failed', 'manual'].includes(order.fulfillmentStatus)) reasons.push('履约异常');
        if (['pending', 'reviewing', 'approved'].includes(order.afterSalesStatus)) reasons.push('售后待处理');
        if (reasons.length) exceptions.push({
            resourceType: 'order', resourceRef: order.orderRef, orderRef: order.orderRef,
            title: order.productName, account: order.account, amount: `${order.amount} ${order.currency}`,
            statuses: `${order.paymentStatus} / ${order.fulfillmentStatus} / ${order.afterSalesStatus}`,
            reason: reasons.join('、'), createdAt: order.createdAt
        });
    }
    for (const topup of topups) {
        if (!['manual_review', 'failed'].includes(topup.status)) continue;
        exceptions.push({
            resourceType: 'payment', resourceRef: topup.paymentRef, orderRef: topup.orderRef,
            title: '模拟 USDT 充值', account: topup.account, amount: `${topup.receivedUsdt} / ${topup.expectedUsdt} USDT`,
            statuses: topup.status, reason: topup.status === 'manual_review' ? '到账金额待人工核验' : '充值处理失败',
            createdAt: topup.createdAt
        });
    }
    exceptions.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
    const [reviewRows] = await getBusinessPool().execute(
        `SELECT resource_type, resource_ref, action, metadata, created_at
           FROM biz_audit_logs
          WHERE action IN ('exception.reviewed', 'after_sales.requested', 'after_sales.status_changed')
          ORDER BY created_at DESC, id DESC LIMIT 200`
    );
    const reviewed = new Map();
    const afterSalesMessages = new Map();
    for (const row of reviewRows) {
        const key = `${row.resource_type}:${row.resource_ref}`;
        if (row.action === 'exception.reviewed' && !reviewed.has(key)) reviewed.set(key, row.created_at);
        if (row.action === 'after_sales.requested' && !afterSalesMessages.has(key)) {
            afterSalesMessages.set(key, parseJson(row.metadata).reason || '用户已提交售后留言');
        }
    }
    return exceptions.slice(0, 200).map((entry) => ({
        ...entry,
        lastReviewedAt: reviewed.get(`${entry.resourceType}:${entry.resourceRef}`) || null,
        afterSalesMessage: afterSalesMessages.get(`${entry.resourceType}:${entry.resourceRef}`) || ''
    }));
}

async function recordExceptionReview(resourceTypeRaw, resourceRefRaw, input, actorRef) {
    await assertSchemaReady();
    const { assertPlainObject } = require('./validation');
    assertPlainObject(input);
    const resourceType = String(resourceTypeRaw || '').trim();
    const resourceRef = String(resourceRefRaw || '').trim();
    if (!['order', 'payment'].includes(resourceType) || !/^[A-Z0-9-]{8,64}$/.test(resourceRef)) {
        throw new BusinessError(400, 'INVALID_EXCEPTION_REF', '异常编号无效');
    }
    const table = resourceType === 'order' ? 'biz_recharge_orders' : 'biz_payment_transactions';
    const column = resourceType === 'order' ? 'order_ref' : 'payment_ref';
    const [rows] = await getBusinessPool().execute(
        `SELECT ${column} AS resource_ref FROM ${table} WHERE ${column} = ? LIMIT 1`,
        [resourceRef]
    );
    if (!rows.length) throw new BusinessError(404, 'EXCEPTION_NOT_FOUND', '异常记录不存在');
    const reason = normalizeReason(input.reason);
    await withBusinessTransaction(async (connection) => {
        await insertAudit(connection, actorRef, 'exception.reviewed', resourceType, resourceRef,
            'EXCEPTION_REVIEWED', { reason, status_changed: false });
    });
    return { resourceType, resourceRef, recorded: true };
}

async function updateAfterSalesStatus(orderRefRaw, input, actorRef) {
    await assertSchemaReady();
    const { assertPlainObject } = require('./validation');
    assertPlainObject(input);
    const orderRef = String(orderRefRaw || '').trim();
    const nextStatus = String(input.status || '').trim().toLowerCase();
    if (!/^ORD-[A-F0-9]{24}$/.test(orderRef)) throw new BusinessError(400, 'INVALID_ORDER_REF', '订单编号无效');
    if (!['reviewing', 'approved', 'rejected', 'completed'].includes(nextStatus)) {
        throw new BusinessError(400, 'INVALID_AFTER_SALES_STATUS', '售后状态无效');
    }
    const reason = normalizeReason(input.reason);
    const transitions = {
        pending: new Set(['reviewing', 'rejected']),
        reviewing: new Set(['approved', 'rejected']),
        approved: new Set(['completed']),
        rejected: new Set(),
        completed: new Set()
    };
    return withBusinessTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT after_sales_status FROM biz_recharge_orders WHERE order_ref = ? LIMIT 1 FOR UPDATE`,
            [orderRef]
        );
        if (!rows.length) throw new BusinessError(404, 'ORDER_NOT_FOUND', '订单不存在');
        const current = String(rows[0].after_sales_status || 'none');
        if (current === nextStatus) return { orderRef, status: current, reused: true };
        if (!transitions[current]?.has(nextStatus)) throw new BusinessError(409, 'AFTER_SALES_STATE_CONFLICT', '该售后状态不能按此步骤变更');
        await connection.execute(
            `UPDATE biz_recharge_orders SET after_sales_status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE order_ref = ?`,
            [nextStatus, orderRef]
        );
        await insertAudit(connection, actorRef, 'after_sales.status_changed', 'order', orderRef,
            'AFTER_SALES_STATUS_CHANGED', { from: current, to: nextStatus, reason, refund_executed: false });
        return { orderRef, status: nextStatus, reused: false, refundExecuted: false };
    });
}

async function dashboardSummary() {
    await assertSchemaReady();
    const [rows] = await getBusinessPool().query(
        `SELECT
            (SELECT COUNT(*) FROM biz_products WHERE availability = 'onsale') AS on_sale_products,
            (SELECT COUNT(*) FROM biz_recharge_orders WHERE payment_status IN ('unpaid', 'manual_review')) AS orders_need_attention,
            (SELECT COUNT(*) FROM biz_payment_transactions WHERE payment_channel = 'mock_usdt' AND status IN ('pending', 'manual_review')) AS topups_need_attention,
            (SELECT COUNT(*) FROM biz_wallet_ledger_entries WHERE source_channel = 'admin_mock') AS mock_ledger_entries`
    );
    const row = rows[0] || {};
    return {
        onSaleProducts: Number(row.on_sale_products || 0),
        ordersNeedAttention: Number(row.orders_need_attention || 0),
        topupsNeedAttention: Number(row.topups_need_attention || 0),
        mockLedgerEntries: Number(row.mock_ledger_entries || 0),
        mode: 'MOCK'
    };
}

async function insertAudit(connection, actorRef, action, resourceType, resourceRef, reasonCode, metadata = {}) {
    return insertAuditAs(connection, 'admin', actorRef, 'admin', action, resourceType, resourceRef, reasonCode, metadata);
}

async function insertAuditAs(connection, actorType, actorRef, actorRole, action, resourceType, resourceRef, reasonCode, metadata = {}) {
    await connection.execute(
        `INSERT INTO biz_audit_logs
            (event_ref, actor_type, actor_ref, actor_role, action, resource_type,
             resource_ref, result, reason_code, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, CAST(? AS JSON))`,
        [makeRef('AUD'), actorType, String(actorRef || actorType).slice(0, 128), actorRole, action, resourceType,
            String(resourceRef || '').slice(0, 128), reasonCode, JSON.stringify(metadata)]
    );
}

module.exports = {
    listProducts,
    listStorefrontProducts,
    createProduct,
    updateProduct,
    createMockOrder,
    createStorefrontMockOrder,
    listStorefrontOrders,
    updateStorefrontMockOrder,
    listOrders,
    createMockTopup,
    listTopups,
    reconcileMockTopup,
    listWallets,
    listLedger,
    listExceptions,
    recordExceptionReview,
    updateAfterSalesStatus,
    dashboardSummary,
    readOnlyReconciliation
};
