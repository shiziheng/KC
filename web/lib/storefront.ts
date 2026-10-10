import { readToken } from '@/lib/api';

export type StorefrontProduct = {
  id: number;
  productCode: string;
  name: string;
  planCode: string;
  upstreamProductName?: string;
  isCredit?: boolean;
  requiresActiveSubscription?: boolean;
  currency: 'USD' | 'USDT';
  faceAmount: string;
  sellingAmount: string;
  availability: 'onsale';
  updatedAt?: string;
};

export type StorefrontOrder = {
  orderRef: string;
  productName: string;
  amount: string;
  currency: 'USD' | 'USDT';
  paymentStatus: 'unpaid' | 'paid' | 'manual_review' | 'failed';
  fulfillmentStatus: 'pending' | 'running' | 'completed' | 'failed' | 'manual' | 'not_required';
  afterSalesStatus: 'none' | 'pending' | 'reviewing' | 'approved' | 'rejected' | 'completed';
  createdAt: string;
  completedAt?: string | null;
  receiptKind: 'mock_transaction_receipt';
};

type Result<T> = { ok: boolean; data?: T; message: string; status: number };

async function request<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, idempotencyKey?: string): Promise<Result<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = readToken();
  if (token) headers.Authorization = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  try {
    const response = await fetch('/api/storefront' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok && payload.success === true,
      data: payload.data as T | undefined,
      message: String(payload.message || ''),
      status: response.status,
    };
  } catch {
    return { ok: false, message: '网络异常，请稍后重试', status: 0 };
  }
}

export async function fetchStorefrontProducts(): Promise<Result<StorefrontProduct[]>> {
  return request<StorefrontProduct[]>('/products');
}

export async function fetchStorefrontOrders(): Promise<Result<StorefrontOrder[]>> {
  return request<StorefrontOrder[]>('/orders');
}

export async function createMockOrder(productId: number): Promise<Result<{ orderRef: string; reused: boolean }>> {
  const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return request('/orders', 'POST', { productId }, idempotencyKey);
}

export async function simulateMockPayment(orderRef: string) {
  return request<{ orderRef: string; reused: boolean; message: string }>(`/orders/${encodeURIComponent(orderRef)}/mock-payment`, 'POST');
}

export async function simulateMockFulfillment(orderRef: string) {
  return request<{ orderRef: string; reused: boolean; message: string }>(`/orders/${encodeURIComponent(orderRef)}/mock-fulfillment`, 'POST');
}

export async function submitAfterSales(orderRef: string, reason: string) {
  return request<{ orderRef: string; reused: boolean; message: string }>(`/orders/${encodeURIComponent(orderRef)}/after-sales`, 'POST', { reason });
}
