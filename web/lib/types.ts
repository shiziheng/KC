/** 套餐（来自 Xboard /v1/user/plan/fetch） */
export type Plan = {
  id: number;
  name: string;
  show: boolean;
  sell: boolean;
  month_price: number | null;
  quarter_price: number | null;
  half_year_price: number | null;
  year_price: number | null;
  two_year_price: number | null;
  three_year_price: number | null;
  onetime_price: number | null;
  transfer_enable: number;
  capacity_limit: number | null;
  content?: string;
};

export type AvailabilityState = 'onsale' | 'soon' | 'soldout' | 'manual';

export type PlanRules = {
  account?: string;
  fulfillment?: string;
  restrictions?: string[];
  failure?: string;
};

/** 卡片展示配置（来自 KC 插件 /pg/plan/kc-cards，存于 v2_plan.kc_card） */
export type CardConfig = {
  state?: AvailabilityState | 'featured' | 'recommend';
  badge?: { text: string; pos?: string; color?: string };
  title?: string;
  subtitle?: string;
  price?: { mode?: 'auto' | 'manual'; value?: number | null; unit?: string; tag?: string };
  promo?: { strike?: string; text?: string };
  features?: string[];
  guarantees?: string[];
  tip?: string;
  button?: { text?: string; style?: string };
  category?: string;
  rules?: PlanRules;
};

export type Category = { key: string; name: string; nav: boolean };

export type PlanCardsResp = {
  cards: Record<string, CardConfig | null>;
  /** KC S8：按 Xboard plan_id 返回的可售结果；false 时前台必须禁用购买。 */
  sellable?: Record<string, boolean>;
  supplier_health?: {
    status: string;
    sellable: boolean;
    reason_code?: string;
    reason?: string;
    checked_at?: string | null;
    recovery_ready?: boolean;
    mock?: boolean;
  };
  availability?: Record<string, {
    state: AvailabilityState;
    sellable: boolean;
    reason?: string;
  }>;
  categories: Category[];
  faq: { q: string; a: string }[];
};

/** 把套餐 + 卡片配置合成视图模型 */
export type PlanView = {
  plan: Plan;
  cfg: CardConfig;
  category: string;
  state: AvailabilityState;
  sellable: boolean;
  sellabilityReason?: string;
  rules: Required<PlanRules>;
  title: string;
  subtitle: string;
  priceNum: string;
  priceUnit: string;
  priceTag: string;
  features: string[];
  guarantees: string[];
  badge: string;
  buttonText: string;
  tip: string;
};

/** 订单（来自 Xboard /v1/user/order/fetch） */
export type Order = {
  id: number;
  trade_no: string;
  plan_id: number;
  period: string;
  /** 订单类型：1=新购 2=续费 3=流量重置 4=余额充值（Xboard 原生定义） */
  type?: number;
  total_amount: number;
  balance_amount?: number | null;
  /** 0=待支付 1=处理中 2=已取消 3=已完成 4=已折抵 */
  status: number;
  created_at: number;
  paid_at?: number | null;
  plan?: {
    id: number;
    name: string;
    month_price?: number | null;
    onetime_price?: number | null;
    content?: string;
  } | null;
};

/** 支付方式（来自 /v1/user/order/getPaymentMethod） */
export type PaymentMethod = {
  id: number;
  name: string;
  payment?: string;
  handling_fee_fixed?: number | null;
  handling_fee_percent?: number | null;
};

/** 当前订阅（来自 /v1/user/getSubscribe） */
export type Subscribe = {
  plan_id: number | null;
  expired_at: number | null;
  plan?: { id: number; name: string } | null;
};

/** 充值台账行（来自 KC 插件 /pg/user/kc/topup/orders） */
export type TopupOrder = {
  trade_no: string;
  plan_id: number;
  amount: number;
  status: 'pending' | 'overdue' | 'done' | 'failed';
  balance_after: number;
  error_msg?: string;
  created_at: number;
  paid_at?: number;
  expires_at?: number;
  expired?: boolean;
};

/** 代充失败补偿状态（来自 Xboard 插件 /user/kc/compensations） */
export type Compensation = {
  trade_no: string;
  status: string;
  status_cn: string;
  amount: number;
  balance_amount: number;
  external_amount: number;
  reason_label: string;
  updated_at?: number | null;
};

/** 订单售后申请（来自 Xboard KC 插件 S9）。 */
export type AfterSalesRequest = {
  request_no: string;
  trade_no: string;
  request_type: 'failed' | 'timeout' | 'refund' | 'other' | string;
  request_type_cn: string;
  status: 'pending' | 'reviewing' | 'approved' | 'rejected' | 'resolved' | 'cancelled' | string;
  status_cn: string;
  user_message: string;
  resolution?: string;
  created_at?: number | null;
  updated_at?: number | null;
  processed_at?: number | null;
  messages?: { sender: 'user' | 'admin' | 'system' | string; content: string; created_at?: number | null }[];
};

/**
 * 代充履约的统一状态。
 *
 * Xboard 原生订单 status 只表示支付/订单生命周期，不能代表 Zovo/KC
 * 的实际开通结果；前台展示履约进度时只消费这一组状态。
 */
export type FulfillmentState =
  | 'pending'
  | 'validating'
  | 'running'
  | 'completed'
  | 'failed'
  | 'compensating'
  | 'manual';

export type FulfillmentStatus = {
  trade_no?: string;
  /** 统一状态；保留 string 兼容旧插件响应中的未知扩展状态。 */
  state: FulfillmentState | string;
  /** 与 state 同步的兼容字段，供旧版页面/注入脚本读取。 */
  task_status?: string;
  kc_status?: string;
  status_cn: string;
  terminal: boolean;
  synced: boolean;
  stale?: boolean;
  issued?: boolean;
  progress?: number | null;
  message?: string;
  updated_at?: number | null;
  compensation?: Compensation;
};

/** 余额账务流水（金额单位：分；正数入账，负数扣款）。 */
export type LedgerEntry = {
  id: number;
  trade_no?: string;
  type: string;
  type_cn: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  source?: string;
  created_at: number;
};

export type LedgerReconciliation = {
  status: 'matched' | 'mismatch' | 'not_enough_data' | 'user_missing' | string;
  current_balance: number;
  opening_balance?: number | null;
  total_ledger_amount?: number | null;
  expected_balance?: number | null;
  difference?: number | null;
};
