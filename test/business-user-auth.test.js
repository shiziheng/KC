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
    it('rejects missing customer tokens without calling Xboard', async () => {
        const fetchImpl = vi.fn();
        const middleware = createRequireStorefrontUser({ fetchImpl, origin: 'http://xboard.test' });
        const req = { headers: {} };
        const res = responseMock();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(res.payload.code).toBe('USER_AUTH_REQUIRED');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it('validates the bearer token against the fixed Xboard identity endpoint', async () => {
        const fetchImpl = vi.fn(async (url, options) => {
            expect(String(url)).toBe('http://xboard.test/api/v1/user/info');
            expect(options.headers.Authorization).toBe('Bearer xboard-user-token');
            return { ok: true, status: 200, json: async () => ({ status: 'success', data: { id: 42, email: 'buyer@example.com' } }) };
        });
        const middleware = createRequireStorefrontUser({ fetchImpl, origin: 'http://xboard.test' });
        const req = { headers: { authorization: 'Bearer xboard-user-token' } };
        const res = responseMock();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(req.storefrontUser).toEqual({ id: '42', email: 'buyer@example.com' });
        expect(next).toHaveBeenCalledOnce();
        expect(res.payload).toBeNull();
    });

    it('never forwards an invalid identity or leaks the supplied token in the response', async () => {
        const middleware = createRequireStorefrontUser({
            origin: 'http://xboard.test',
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'fail', message: 'invalid token' }) })
        });
        const req = { headers: { authorization: 'Bearer do-not-echo-this-token' } };
        const res = responseMock();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(JSON.stringify(res.payload)).not.toContain('do-not-echo-this-token');
        expect(req.storefrontUser).toBeUndefined();
        expect(next).not.toHaveBeenCalled();
    });

    it('fails closed when Xboard cannot be reached', async () => {
        const middleware = createRequireStorefrontUser({ origin: 'http://xboard.test', fetchImpl: async () => { throw new Error('offline'); } });
        const req = { headers: { authorization: 'Bearer valid-shape-token' } };
        const res = responseMock();

        await middleware(req, res, vi.fn());

        expect(res.statusCode).toBe(503);
        expect(res.payload.code).toBe('USER_AUTH_UNAVAILABLE');
    });
});
