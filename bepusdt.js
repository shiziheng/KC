// ============================================================
// bepusdt.js · BEpusdt（USDT 收款网关）接入层
// v2.11.0：把「模拟收款」升级为「网关下单 + notify 服务端验签入账」。
//
// 铁律：
//   1. 未配置 BEPUSDT_API_URL + BEPUSDT_API_TOKEN 时 isEnabled()=false，
//      业务侧必须完全回落到原有「模拟收款」路径，不得改变现状。
//   2. 签名算法（已对真实 BEpusdt 验签通过，见 tools/_v2110_*.js）：
//      取所有非空参数（剔除 signature）→ 参数名 ASCII 字典序 → 拼 "k=v&k=v"
//      → 末尾拼 api_auth_token → MD5 → 转小写 32 位。
//   3. notify 只证明「来源可信」，业务侧仍必须校验本地订单、金额、状态，并做幂等入账。
//
// 协议（对真实网关实测确认）：
//   POST {api_url}/api/v1/order/create-transaction  JSON
//     body: {order_id, amount, fiat:'USD', notify_url, redirect_url, trade_type?, signature}
//     resp: {status_code:200, data:{trade_id, order_id, amount, actual_amount, fiat,
//            token(收款地址), trade_type, payment_url, expiration_time(秒), status}}
//   notify（网关 → notify_url）: JSON POST，字段含 trade_id / order_id / amount /
//     actual_amount / status / block_transaction_id(txid) / signature。
// ============================================================
const crypto = require('crypto');
const axios = require('axios');

const DEFAULT_TRADE_TYPE = 'usdt.trc20';
const CREATE_TIMEOUT_MS = 15000;
const QUERY_TIMEOUT_MS = 10000;

function readConfig() {
  const apiUrl = String(process.env.BEPUSDT_API_URL || '').trim().replace(/\/+$/, '');
  const apiToken = String(process.env.BEPUSDT_API_TOKEN || '').trim();
  const tradeType = String(process.env.BEPUSDT_TRADE_TYPE || '').trim() || DEFAULT_TRADE_TYPE;
  const publicBaseUrl = String(process.env.KC_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return { apiUrl, apiToken, tradeType, publicBaseUrl };
}

function isEnabled() {
  const { apiUrl, apiToken } = readConfig();
  return !!(apiUrl && apiToken);
}

// 参与签名的参数：剔除 signature，且只保留「非空」值（与 BEpusdt 一致：空值不参与）
function signableEntries(params) {
  const out = [];
  Object.keys(params || {}).forEach((k) => {
    if (k === 'signature') return;
    const v = params[k];
    if (v === undefined || v === null || String(v) === '') return;
    out.push([k, String(v)]);
  });
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** 计算 signature：md5(字典序 "k=v&…" + api_auth_token)，小写 32 位 */
function sign(params, token) {
  const q = signableEntries(params).map((e) => e[0] + '=' + e[1]).join('&');
  return crypto.createHash('md5').update(q + String(token || '')).digest('hex').toLowerCase();
}

/** 由单号派生「法币金额尾数」（1..99 分），用于让同一时刻的订单金额互不相同（认单） */
function fiatTailCents(orderId) {
  const h = crypto.createHash('sha1').update(String(orderId)).digest();
  return (h.readUInt16BE(0) % 99) + 1;
}

/** 发起充值时要发给网关的法币金额（美元，2 位小数 = 基础金额 + 认单尾数） */
function fiatAmountUsd(orderId, amountCents) {
  const base = Number(amountCents) || 0;
  return ((base + fiatTailCents(orderId)) / 100).toFixed(2);
}

/**
 * 校验 notify 签名（纯函数，可单测）。
 * @returns {{ok:boolean, reason?:string}}
 */
function verifyNotify(payload, token) {
  if (!token) return { ok: false, reason: 'GATEWAY_NOT_CONFIGURED' };
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'EMPTY_PAYLOAD' };
  const signature = String(payload.signature || '').trim();
  if (!signature) return { ok: false, reason: 'MISSING_SIGNATURE' };
  const expected = sign(payload, token);
  if (expected !== signature.toLowerCase()) return { ok: false, reason: 'BAD_SIGNATURE' };
  return { ok: true };
}

/** 网关侧「支付成功」的状态判定（BEpusdt: 2=成功） */
function isPaidStatus(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase();
  return s === '2' || s === 'success' || s === 'paid' || s === 'completed';
}

/**
 * 调用网关创建交易。
 * @returns {{ok:boolean, statusCode?:number, message?:string, data?:object}}
 */
async function createTransaction({ orderId, amountUsd, notifyUrl, redirectUrl }) {
  const { apiUrl, apiToken, tradeType } = readConfig();
  if (!apiUrl || !apiToken) return { ok: false, message: '网关未配置' };
  const params = {
    order_id: String(orderId),
    // 铁律：amount 必须是 JSON number（真实网关按 Go float64 反序列化，传字符串会报
    //        "cannot unmarshal string into ... type float64"）；签名仍按 String(v) 计算。
    amount: Number(amountUsd),
    fiat: 'USD', // 铁律：KC 金额口径为美元；不声明则按 CNY 折算，会少收款（历史资损）
    notify_url: String(notifyUrl || ''),
    redirect_url: String(redirectUrl || ''),
    trade_type: tradeType
  };
  const body = Object.assign({}, params, { signature: sign(params, apiToken) });
  try {
    const resp = await axios.post(apiUrl + '/api/v1/order/create-transaction', body, {
      timeout: CREATE_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true
    });
    const json = resp.data || {};
    if (Number(json.status_code) !== 200 || !json.data) {
      return { ok: false, statusCode: Number(json.status_code) || resp.status, message: String(json.message || '网关下单失败') };
    }
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, message: '网关连接失败：' + (e && e.message ? e.message : 'unknown') };
  }
}

/**
 * 主动查单（调度兜底对账用）。
 * 网关公开接口 POST /api/v1/pay/info {trade_id} → data.status: 1=待支付 / 2=成功 / 3=过期。
 * 该接口无需签名（网关收银台自身也用它轮询），故不能作为「可信到账」的唯一依据；
 * 业务侧仍必须复核本地订单、金额并幂等入账。
 * @returns {{ok:boolean, statusCode?:number, message?:string, data?:object}}
 */
async function queryTransaction(tradeId) {
  const { apiUrl } = readConfig();
  if (!apiUrl) return { ok: false, message: '网关未配置' };
  try {
    const resp = await axios.post(apiUrl + '/api/v1/pay/info', { trade_id: String(tradeId) }, {
      timeout: QUERY_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true
    });
    const json = resp.data || {};
    if (Number(json.status_code) !== 200 || !json.data) {
      return { ok: false, statusCode: Number(json.status_code) || resp.status, message: String(json.message || '查单失败') };
    }
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, message: '网关连接失败：' + (e && e.message ? e.message : 'unknown') };
  }
}

module.exports = {
  DEFAULT_TRADE_TYPE,
  readConfig,
  isEnabled,
  sign,
  signableEntries,
  fiatTailCents,
  fiatAmountUsd,
  verifyNotify,
  isPaidStatus,
  createTransaction,
  queryTransaction
};
