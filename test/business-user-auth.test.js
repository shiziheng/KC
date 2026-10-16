'use strict';

const { createRequireStorefrontUser } = require('../business/user-auth');

function responseMock() {
    return {
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.payload = value; return this; }
    };
}

describe('storefront user authentication', () => {
    it('rejects missing customer tokens without verifying', async () => {
        const verifyToken = vi.fn();
        const middleware = createRequireStorefrontUser({ verifyToken });
        const req = { headers: {} };
        const res = responseMock();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(res.payload.code).toBe('USER_AUTH_REQUIRED');
        expect(verifyToken).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it('accepts a locally verified customer token and maps payload to req.storefrontUser', async () => {
        const verifyToken = vi.fn(() => ({ sub: 'customer', cid: 42, em: 'buyer@example.com' }));
        const middleware = createRequireStorefrontUser({ verifyToken });
        const req = { headers: { authorization: 'Bearer signed.customer.token' } };
        const res = responseMock();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(verifyToken).toHaveBeenCalledWith('signed.customer.token');
        expect(req.storefrontUser).toEqual({ id: '42', email: 'buyer@example.com' });
        expect(next).toHaveBeenCalledOnce();
        expect(res.payload).toBeNull();
    });

    it('never forwards an invalid identity or leaks the supplied token in the response', async () => {
        const verifyToken = vi.fn(() => null);
        const middleware = createRequireStorefrontUser({ verifyToken });
        const req = { headers: { authorization: 'Bearer do-not-echo-this-token' } };
        const res = responseMock();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(res.payload.code).toBe('USER_AUTH_INVALID');
        expect(JSON.stringify(res.payload)).not.toContain('do-not-echo-this-token');
        expect(req.storefrontUser).toBeUndefined();
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects malformed authorization headers before verification', async () => {
        const verifyToken = vi.fn();
        const middleware = createRequireStorefrontUser({ verifyToken });
        const req = { headers: { authorization: 'Token abc' } };
        const res = responseMock();

        await middleware(req, res, vi.fn());

        expect(res.statusCode).toBe(401);
        expect(res.payload.code).toBe('USER_AUTH_REQUIRED');
        expect(verifyToken).not.toHaveBeenCalled();
    });
});
