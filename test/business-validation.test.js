'use strict';

const {
    BusinessError,
    assertPlainObject,
    parseMoney,
    formatMoney,
    normalizeProduct,
    normalizeEmail,
    maskEmail,
    accountFingerprint,
    normalizeReason
} = require('../business/validation');

describe('business validation', () => {
    it('uses currency-specific integer precision without floating point', () => {
        expect(parseMoney('12.34', 'USD')).toBe(1234);
        expect(formatMoney(1234, 'USD')).toBe('12.34');
        expect(parseMoney('12.0034', 'USDT')).toBe(12003400);
        expect(formatMoney(12003400, 'USDT')).toBe('12.003400');
    });

    it('rejects excess precision and out-of-range amounts', () => {
        expect(() => parseMoney('12.345', 'USD')).toThrow(BusinessError);
        expect(() => parseMoney('0', 'USDT')).toThrow(BusinessError);
        expect(() => parseMoney('1e3', 'USD')).toThrow(BusinessError);
    });

    it('validates and normalizes only supported recharge products', () => {
        const product = normalizeProduct({
            productCode: 'plus-monthly',
            name: 'ChatGPT Plus',
            planCode: 'plus',
            currency: 'usd',
            faceAmount: '20',
            sellingAmount: '19.99',
            costAmount: '',
            availability: 'onsale'
        });
        expect(product).toMatchObject({ productCode: 'plus-monthly', planCode: 'plus', currency: 'USD', sellingAmountMinor: 1999 });
        expect(normalizeProduct({
            productCode: 'pro-100x', name: 'Upstream plan', planCode: 'pro_100x', currency: 'USD',
            faceAmount: '1', sellingAmount: '1'
        }, { allowedPlanCodes: new Set(['pro_100x']) })).toMatchObject({ planCode: 'pro_100x' });
        expect(() => normalizeProduct({
            productCode: 'invalid-plan', name: 'Unknown', planCode: 'airtime', currency: 'USD',
            faceAmount: '1', sellingAmount: '1'
        })).toThrow(BusinessError);
    });

    it('rejects session and credential fields at any request depth', () => {
        expect(() => assertPlainObject({ accountEmail: 'a@example.com', extra: { access_token: 'do-not-save' } })).toThrow(BusinessError);
        expect(() => assertPlainObject({ session_payload: 'do-not-save' })).toThrow(BusinessError);
    });

    it('stores only a masked account label and a one-way fingerprint', () => {
        const email = normalizeEmail(' Alice.Example@Example.com ');
        expect(maskEmail(email)).toMatch(/^al\*+@example\.com$/);
        expect(accountFingerprint(email)).not.toContain(email);
        expect(accountFingerprint(email)).toMatch(/^[a-f0-9]{64}$/);
    });

    it('requires an operational note but blocks credential-like text', () => {
        expect(normalizeReason('mock payment reconciliation')).toBe('mock payment reconciliation');
        expect(() => normalizeReason('session token is abcdefghijkl')).toThrow(BusinessError);
    });
});
