'use strict';
/**
 * tools/xboard-patch-checks.js — Xboard 容器补丁核查的共享定义（可被 CLI / 部署 / CI 复用）
 *
 * 背景：Xboard 容器内的内核补丁不进镜像，容器重建后会静默丢失：
 *   P1  PlanService       —— kc_is_topup 豁免 show 校验
 *   P1b PlanService       —— 权益包豁免
 *   P3  OrderService      —— 充值套餐不产生佣金
 *   P7  OrderService      —— 权益包短路开通
 *   P8  OrderService      —— 代充按用户权益价结算
 *   P4  CheckCommission   —— 返利以「货交付」为前提
 *   P2  TopupController   —— show=0 套餐可复用（插件侧）
 *   P5  OrderService      —— 允许多笔未支付/处理中订单并存
 *   P6  V1 OrderController —— 允许多笔未支付/处理中订单并存
 *
 * 本模块只做「定义 + 核查」，不做重打；重打逻辑留在 tools/xboard-patch-check.js。
 *
 * ⚠️ 退役（v2.0.0 · Stage 3.9）：Xboard 已退场，主站改由 KC 原生前台承载（`GET /`）。
 *    下述 9 处补丁与注入链仅为历史参考（只读），不再核查、不再重打、不再触发告警。
 */
const RETIRED = {
    retired: true,
    since: 'v2.0.0',
    at: '2026-10-16',
    reason: 'Stage 3.9：Xboard 退场，主站已由 KC 原生前台承载（GET /）。补丁/注入链仅作历史参考（只读）。',
};

const CHECKS = [
  { name: 'P1 PlanService（kc_is_topup 豁免）', file: '/www/app/Services/PlanService.php', pattern: 'kc_is_topup', min: 1 },
  { name: 'P1b PlanService（权益包豁免）', file: '/www/app/Services/PlanService.php', pattern: 'kc_entitlement_pack', min: 1 },
  { name: 'P3 OrderService（充值不返佣）', file: '/www/app/Services/OrderService.php', pattern: 'kc_is_topup', min: 2 },
  { name: 'P7 OrderService（权益包短路开通）', file: '/www/app/Services/OrderService.php', pattern: 'ENTITLEMENT-PACK', min: 1 },
  { name: 'P8 OrderService（代充按用户权益价结算）', file: '/www/app/Services/OrderService.php', pattern: 'ENTITLEMENT-PRICE', min: 2 },
  { name: 'P4 CheckCommission（交付才结算）', file: '/www/app/Console/Commands/CheckCommission.php', pattern: 'kcHasCardTable', min: 2 },
  { name: 'P2 TopupController（show=0 复用）', file: '/www/plugins/KcIntegration/Controllers/TopupController.php', pattern: 'KC-PATCH2', min: 2 },
  { name: 'P5 OrderService（允许多笔未支付单）', file: '/www/app/Services/OrderService.php', pattern: 'ALLOW-CONCURRENT-ORDERS', min: 1 },
  { name: 'P6 V1 OrderController（允许多笔未支付单）', file: '/www/app/Http/Controllers/V1/User/OrderController.php', pattern: 'ALLOW-CONCURRENT-ORDERS', min: 1 },
];

/** 在目标容器内统计某模式命中次数；异常一律按 0 计（视为缺失） */
function countViaDocker(dockerFn, check) {
    try {
        const out = dockerFn(['exec', 'xboard', 'sh', '-c', `grep -c ${check.pattern} ${check.file}`]);
        const m = String(out || '').match(/\d+/);
        return m ? parseInt(m[0], 10) : 0;
    } catch (e) {
        return 0;
    }
}

/** 逐项核查，返回结构化结果（不打印、不落盘） */
function checkPatches(dockerFn) {
    const items = CHECKS.map((c) => {
        const got = countViaDocker(dockerFn, c);
        return { name: c.name, file: c.file, pattern: c.pattern, got, min: c.min, ok: got >= c.min };
    });
    const passed = items.filter((i) => i.ok).length;
    return { ok: items.every((i) => i.ok), retired: RETIRED.retired, total: items.length, passed, items };
}

module.exports = { CHECKS, RETIRED, countViaDocker, checkPatches };
