'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { api, pg, readToken } from '@/lib/api';
import { fetchMyCards, fetchOrderStatus } from '@/lib/redeem';
import { normalizeFulfillmentState } from '@/lib/fulfillment';
import { formatDateTime, formatRemain, formatUSD } from '@/lib/format';
import type { AfterSalesRequest, Compensation, FulfillmentStatus, Order, TopupOrder } from '@/lib/types';

type Tab = 'orders' | 'topups';

/** 卡密（用于把订单与「去开通」入口关联起来） */
type CardInfo = {
  trade_no: string; cdk: string; status: string; status_cn: string; plan_type: string;
  state?: string; state_cn?: string; terminal?: boolean; next_action?: string; message?: string;
};
type KcOrderStatus = FulfillmentStatus & { cdk_state?: string; cdk_status_cn?: string; next_action?: string };

/** 订单状态（Xboard 原生定义） */
const ORDER_STATUS: Record<number, { label: string; cls: string }> = {
  0: { label: '待支付', cls: 'kc-tag-warn' },
  1: { label: '支付处理中', cls: 'kc-tag-warn' },
  2: { label: '已取消', cls: 'kc-tag-mute' },
  // 这是 Xboard 支付订单状态，不是 Zovo/KC 代充履约成功。
  3: { label: '支付完成', cls: 'kc-tag-ok' },
  4: { label: '已折抵', cls: 'kc-tag-mute' },
};

const FULFILLMENT_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待处理', cls: 'kc-tag-warn' },
  validating: { label: '校验中', cls: 'kc-tag-warn' },
  running: { label: '开通中', cls: 'kc-tag-warn' },
  completed: { label: '开通完成', cls: 'kc-tag-ok' },
  failed: { label: '开通失败', cls: 'kc-tag-err' },
  compensating: { label: '补偿处理中', cls: 'kc-tag-warn' },
  manual: { label: '待人工处理', cls: 'kc-tag-warn' },
};

/** 充值台账状态（四态） */
const TOPUP_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待支付', cls: 'kc-tag-warn' },
  overdue: { label: '已失效', cls: 'kc-tag-mute' },
  done: { label: '已到账', cls: 'kc-tag-ok' },
  failed: { label: '处理失败', cls: 'kc-tag-err' },
};

const COMPENSATION_STATUS: Record<string, { label: string; cls: string; text: string }> = {
  balance_refunded: { label: '已退回余额', cls: 'kc-tag-ok', text: '代充未完成，余额抵扣部分已退回。' },
  manual_pending: { label: '待人工退款', cls: 'kc-tag-warn', text: '代充未完成，外部支付部分进入人工退款队列。' },
  partial_refunded_manual_pending: { label: '部分已退，待人工退款', cls: 'kc-tag-warn', text: '余额抵扣部分已退回，外部支付部分待人工退款。' },
  manual_done: { label: '人工退款已处理', cls: 'kc-tag-ok', text: '外部支付退款已由客服处理。' },
  review_pending: { label: '结果待确认', cls: 'kc-tag-warn', text: '代充结果暂未确认，请勿重复购买，联系客服处理。' },
  failed: { label: '补偿处理中', cls: 'kc-tag-err', text: '补偿处理遇到问题，请联系客服。' },
  processing: { label: '补偿处理中', cls: 'kc-tag-warn', text: '系统正在处理补偿。' },
};

export default function OrderPage() {
  const { loggedIn, loading: authLoading } = useAuth();

  const [tab, setTab] = useState<Tab>('orders');
  const [orders, setOrders] = useState<Order[]>([]);
  const [topups, setTopups] = useState<TopupOrder[]>([]);
  const [cards, setCards] = useState<Record<string, CardInfo>>({});
  const [fulfillment, setFulfillment] = useState<Record<string, FulfillmentStatus>>({});
  const [compensations, setCompensations] = useState<Record<string, Compensation>>({});
  const [afterSales, setAfterSales] = useState<Record<string, AfterSalesRequest>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');

    const [oRes, tRes, cardList, cRes, aRes] = await Promise.all([
      api.get<Order[] | { data?: Order[] }>('/v1/user/order/fetch'),
      pg.get<{ orders?: TopupOrder[] }>('/user/kc/topup/orders'),
      fetchMyCards(readToken()),
      pg.get<{ compensations?: Compensation[] }>('/user/kc/compensations'),
      pg.get<{ requests?: AfterSalesRequest[] }>('/user/kc/after-sales'),
    ]);

    let orderList: Order[] = [];
    if (oRes.ok) {
      const d = oRes.data as unknown;
      const list = Array.isArray(d)
        ? (d as Order[])
        : d && typeof d === 'object' && Array.isArray((d as { data?: unknown }).data)
          ? ((d as { data: Order[] }).data)
          : [];
      orderList = list;
      setOrders(orderList);
    } else {
      setErr(oRes.message || '订单加载失败');
    }

    if (tRes.ok && tRes.data) {
      setTopups(Array.isArray(tRes.data.orders) ? tRes.data.orders : []);
    }

    // 卡密按订单号建索引，供订单列表显示「去开通 / 已开通」
    const map: Record<string, CardInfo> = {};
    cardList.forEach((c) => { if (c.trade_no) map[c.trade_no] = c; });
    setCards(map);

    // 每个订单单独读取 KC/Zovo 履约状态。即使订单 status=3，也要等这里明确
    // 返回 completed 才能展示“开通完成”；接口不可达时保留空值并显示不可实时更新。
    const statusRows = await Promise.all(orderList.slice(0, 50).map(async (order) => {
      const status = await fetchOrderStatus(readToken(), order.trade_no);
      return [order.trade_no, status] as const;
    }));
    const fulfillmentMap: Record<string, FulfillmentStatus> = {};
    statusRows.forEach(([tradeNo, status]) => { if (status) fulfillmentMap[tradeNo] = status; });
    setFulfillment(fulfillmentMap);

    const compensationMap: Record<string, Compensation> = {};
    if (cRes.ok && cRes.data?.compensations) {
      cRes.data.compensations.forEach((c) => { if (c.trade_no) compensationMap[c.trade_no] = c; });
    }
    setCompensations(compensationMap);

    const afterSalesMap: Record<string, AfterSalesRequest> = {};
    if (aRes.ok && aRes.data?.requests) {
      aRes.data.requests.forEach((item) => { if (item.trade_no) afterSalesMap[item.trade_no] = item; });
    }
    setAfterSales(afterSalesMap);

    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authLoading && loggedIn) void load();
    if (!authLoading && !loggedIn) setLoading(false);
  }, [authLoading, loggedIn, load]);

  // 有待支付充值单时，每秒刷新倒计时
  useEffect(() => {
    const hasPending = topups.some((t) => t.status === 'pending' && t.expires_at);
    if (!hasPending) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [topups]);

  if (!authLoading && !loggedIn) {
    return (
      <div className="kc-container py-12">
        <div className="kc-card mx-auto max-w-md p-8 text-center">
          <h1 className="text-h2 text-t1">登录后查看订单</h1>
          <p className="mt-2 text-body text-t2">登录即可查看你的消费订单与充值记录。</p>
          <Link href="/login?redirect=/order" className="kc-btn kc-btn-primary mt-5">
            登录 / 注册
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="kc-container py-8 md:py-12">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-h1 text-t1">我的订单</h1>
        <button type="button" onClick={() => void load()} disabled={loading} className="kc-btn kc-btn-ghost kc-btn-sm">
          {loading ? '刷新中…' : '刷新'}
        </button>
      </header>

      {/* Tab */}
      <div className="mt-5 flex gap-1 rounded-md bg-page p-1 md:max-w-xs">
        {([
          ['orders', '消费订单'],
          ['topups', '充值记录'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={
              'flex-1 rounded-sm py-2 text-body font-medium transition-colors ' +
              (tab === k ? 'bg-card text-brand shadow-sm' : 'text-t3 hover:text-t1')
            }
          >
            {label}
          </button>
        ))}
      </div>

      {err && <div className="mt-4 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{err}</div>}

      {loading ? (
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="kc-card h-20 animate-pulse" />
          ))}
        </div>
      ) : tab === 'orders' ? (
        <OrderList orders={orders} cards={cards} fulfillment={fulfillment} compensations={compensations} afterSales={afterSales} />
      ) : (
        <TopupList topups={topups} now={now} />
      )}
    </div>
  );
}

/** 卡密打码：KC-2YTVW5P5C39V3BZ → KC-2YTV•••••••• */
function maskCdk(cdk: string): string {
  if (!cdk) return '';
  return cdk.length <= 7 ? cdk : cdk.slice(0, 7) + '••••••••';
}

function OrderList({ orders, cards, fulfillment, compensations, afterSales }: {
  orders: Order[];
  cards: Record<string, CardInfo>;
  fulfillment: Record<string, FulfillmentStatus>;
  compensations: Record<string, Compensation>;
  afterSales: Record<string, AfterSalesRequest>;
}) {
  // 卡密默认打码，用户主动点击才展开（降低截屏外泄的可能）
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState('');

  if (!orders.length) {
    return <Empty text="还没有消费订单" action={<Link href="/plan" className="kc-btn kc-btn-primary kc-btn-sm mt-4">去选购</Link>} />;
  }

  const toggle = (cdk: string) => setRevealed((p) => ({ ...p, [cdk]: !p[cdk] }));

  const copy = async (cdk: string) => {
    try {
      await navigator.clipboard.writeText(cdk);
      setCopied(cdk);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      /* 剪贴板不可用（非 https 等），忽略 */
    }
  };

  return (
    <ul className="mt-4 space-y-2">
      {orders.map((o) => {
        const st = ORDER_STATUS[o.status] || { label: '未知', cls: 'kc-tag-mute' };
        const paidFen = o.balance_amount && o.balance_amount > 0 ? o.balance_amount : o.total_amount;
        const card = cards[o.trade_no];
        const status = fulfillment[o.trade_no];
        const cdkStatus = status as KcOrderStatus | undefined;
        const fulfillmentState = status ? normalizeFulfillmentState(status) : '';
        const cardAction = cdkStatus?.next_action || card?.next_action || (fulfillmentState === 'completed' ? 'view_order' : (card?.cdk ? 'redeem' : 'wait'));
        const fulfillmentView = status ? (FULFILLMENT_STATUS[fulfillmentState] || {
          label: status.status_cn || '处理中', cls: 'kc-tag-warn',
        }) : null;
        const compensation = compensations[o.trade_no];
        const afterSale = afterSales[o.trade_no];
        const compensationView = compensation ? (COMPENSATION_STATUS[compensation.status] || {
          label: compensation.status_cn || '补偿处理中', cls: 'kc-tag-warn', text: '代充未完成，请联系客服处理。',
        }) : null;
        const show = card ? !!revealed[card.cdk] : false;
        return (
          <li key={o.trade_no} className="kc-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-body font-medium text-t1">{o.plan?.name || '商品 #' + o.plan_id}</div>
                <div className="mt-1 text-aux text-t3">
                  订单 <span className="font-mono">{String(o.trade_no).slice(-10)}</span> · {formatDateTime(o.created_at)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-body font-medium text-t1">{formatUSD(paidFen)}</span>
                <span className={'kc-tag ' + st.cls}>{st.label}</span>
                {fulfillmentView && (
                  <span className={'kc-tag ' + fulfillmentView.cls}>
                    代充：{status?.stale ? '最近' : ''}{fulfillmentView.label}
                  </span>
                )}
              </div>
            </div>

            {status?.stale && (
              <div className="mt-2 text-aux text-t3">代充状态暂不可实时更新，页面展示的是最近一次已知状态。</div>
            )}

            {o.balance_amount && o.balance_amount > 0 && (
              <div className="mt-2 text-aux text-t3">余额抵扣 {formatUSD(o.balance_amount)}</div>
            )}

            {compensation && compensationView && (
              <div className="mt-3 rounded-md border border-warn/25 bg-warn/[.07] px-3 py-2.5 text-aux text-t2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={'kc-tag ' + compensationView.cls}>{compensationView.label}</span>
                  <span>{compensationView.text}</span>
                </div>
                {compensation.balance_amount > 0 && (
                  <div className="mt-1 text-t3">余额退回 {formatUSD(compensation.balance_amount)}</div>
                )}
              </div>
            )}

            <AfterSalesBox order={o} request={afterSale} />

            {/* 已发卡后提供开通入口；支付完成不等于代充完成。 */}
            {card && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {card.cdk ? <>
                    <span className="text-aux text-t3">卡密</span>
                    <span className="font-mono text-body text-t1">
                      {show ? card.cdk : maskCdk(card.cdk)}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggle(card.cdk)}
                      className="text-aux text-brand hover:underline"
                    >
                      {show ? '隐藏' : '显示'}
                    </button>
                    {show && (
                      <button type="button" onClick={() => void copy(card.cdk)} className="text-aux text-brand hover:underline">
                        {copied === card.cdk ? '已复制' : '复制'}
                      </button>
                    )}
                  </> : <span className="text-aux text-t3">卡密正在发放</span>}
                  {(cdkStatus?.cdk_status_cn || card.state_cn) && <span className="kc-tag kc-tag-mute">{cdkStatus?.cdk_status_cn || card.state_cn}</span>}
                  {card.cdk && ['redeem', 'view_progress'].includes(String(cardAction)) && (
                    <Link href={'/redeem?cdk=' + encodeURIComponent(card.cdk)} className="kc-btn kc-btn-primary kc-btn-sm ml-auto">
                      {cardAction === 'redeem' ? '去开通 →' : '查看开通进度 →'}
                    </Link>
                  )}
                  {card.cdk && cardAction === 'view_order' && (
                    <Link href={'/redeem?cdk=' + encodeURIComponent(card.cdk)} className="kc-btn kc-btn-ghost kc-btn-sm ml-auto">
                      查看开通状态 →
                    </Link>
                  )}
                  {cardAction === 'after_sales' && (
                    <Link href="/help#after-sales" className="kc-btn kc-btn-ghost kc-btn-sm ml-auto">查看售后说明</Link>
                  )}
                </div>
                <p className="mt-1.5 text-aux text-t3">
                  {cdkStatus?.message || card.message || '卡密等同于提货凭证，谁先兑换算谁的。请勿截图分享——被他人兑换后无法追回。'}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AfterSalesBox({ order, request }: { order: Order; request?: AfterSalesRequest }) {
  const [current, setCurrent] = useState<AfterSalesRequest | undefined>(request);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('failed');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setCurrent(request), [request]);

  const canMessage = Boolean(current && ['pending', 'reviewing', 'approved'].includes(current.status));

  if (order.status === 0 || order.status === 2) return null;

  const submit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    setError('');
    const result = await pg.post<{ request?: AfterSalesRequest }>('/user/kc/after-sales', {
      trade_no: order.trade_no,
      request_type: kind,
      message: message.trim(),
    });
    setBusy(false);
    if (!result.ok || !result.data?.request) {
      setError(result.message || '售后申请提交失败');
      return;
    }
    setCurrent(result.data.request);
    setMessage('');
    setOpen(false);
  };

  const append = async () => {
    if (!current || !message.trim()) return;
    setBusy(true);
    setError('');
    const result = await pg.post<{ request?: AfterSalesRequest }>(
      '/user/kc/after-sales/' + encodeURIComponent(current.request_no) + '/message',
      { message: message.trim() },
    );
    setBusy(false);
    if (!result.ok || !result.data?.request) {
      setError(result.message || '补充说明失败');
      return;
    }
    setCurrent(result.data.request);
    setMessage('');
  };

  const cancel = async () => {
    if (!current) return;
    setBusy(true);
    setError('');
    const result = await pg.post<{ request?: AfterSalesRequest }>(
      '/user/kc/after-sales/' + encodeURIComponent(current.request_no) + '/cancel',
    );
    setBusy(false);
    if (!result.ok || !result.data?.request) {
      setError(result.message || '取消申请失败');
      return;
    }
    setCurrent(result.data.request);
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      {current ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-aux">
            <span className="text-t3">售后申请</span>
            <span className="kc-tag kc-tag-mute">{current.request_type_cn}</span>
            <span className="kc-tag kc-tag-warn">{current.status_cn}</span>
            <span className="text-t3">{current.request_no}</span>
          </div>
          {current.resolution && <p className="mt-2 text-aux text-t2">处理结果：{current.resolution}</p>}
          {canMessage && (
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="需要补充情况时填写"
                maxLength={1000}
                className="kc-input min-w-0 flex-1"
              />
              <button type="button" disabled={busy || !message.trim()} onClick={() => void append()} className="kc-btn kc-btn-ghost kc-btn-sm">
                {busy ? '提交中…' : '补充说明'}
              </button>
              {current.status === 'pending' && (
                <button type="button" disabled={busy} onClick={() => void cancel()} className="kc-btn kc-btn-ghost kc-btn-sm">
                  取消
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {!open ? (
            <button type="button" onClick={() => setOpen(true)} className="text-aux text-brand hover:underline">
              订单有问题？申请售后 →
            </button>
          ) : (
            <div className="rounded-md border border-line bg-page p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-aux font-medium text-t1">申请售后</div>
                <Link href="/help#after-sales" className="text-aux text-brand hover:underline">
                  售后说明
                </Link>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[10rem_1fr]">
                <select value={kind} onChange={(e) => setKind(e.target.value)} className="kc-input">
                  <option value="failed">代充失败</option>
                  <option value="timeout">长时间未完成</option>
                  <option value="refund">退款申请</option>
                  <option value="other">其他订单问题</option>
                </select>
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="请描述遇到的问题"
                  maxLength={1000}
                  className="kc-input"
                />
              </div>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy || !message.trim()} onClick={() => void submit()} className="kc-btn kc-btn-primary kc-btn-sm">
                  {busy ? '提交中…' : '提交申请'}
                </button>
                <button type="button" disabled={busy} onClick={() => setOpen(false)} className="kc-btn kc-btn-ghost kc-btn-sm">取消</button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <p className="mt-2 text-aux text-err">{error}</p>}
    </div>
  );
}

function TopupList({ topups, now }: { topups: TopupOrder[]; now: number }) {
  if (!topups.length) {
    return <Empty text="还没有充值记录" action={<Link href="/topup" className="kc-btn kc-btn-primary kc-btn-sm mt-4">去充值</Link>} />;
  }
  return (
    <ul className="mt-4 space-y-2">
      {topups.map((t) => {
        const st = TOPUP_STATUS[t.status] || { label: t.status, cls: 'kc-tag-mute' };
        const left = t.status === 'pending' && t.expires_at ? Math.max(0, t.expires_at - now) : 0;
        return (
          <li key={t.trade_no} className="kc-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-body font-medium text-t1">{formatUSD(t.amount)}</div>
                <div className="mt-1 text-aux text-t3">
                  订单 <span className="font-mono">{String(t.trade_no).slice(-10)}</span> · 发起 {formatDateTime(t.created_at)}
                  {t.paid_at ? ' · 到账 ' + formatDateTime(t.paid_at) : ''}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className={'kc-tag ' + st.cls}>{st.label}</span>
                {t.status === 'pending' && left > 0 && (
                  <span className="text-aux text-warn">剩余 {formatRemain(left)}</span>
                )}
              </div>
            </div>
            {t.error_msg && <div className="mt-2 text-aux text-err">{t.error_msg}</div>}
            {t.status === 'overdue' && (
              <div className="mt-2 text-aux text-t3">该订单已超时失效，可重新发起充值（不影响后续订单）。</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="kc-card mt-4 p-10 text-center">
      <p className="text-body text-t3">{text}</p>
      {action}
    </div>
  );
}
