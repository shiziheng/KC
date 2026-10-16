<?php
// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。
// KC 补丁 P1b：权益包商品（v2_plan.kc_card.category='entitlement'）同样以 show=0 隐藏自商品页，
// 但前台「权益包」独立页（#/pack）按 plan_id 建单需要放行 —— 与 P1（kc_is_topup 豁免）同因不同物。
// 位置：PlanService::validatePlanAvailability。必须在 P1 之后执行（P1 命中即退出）。
$f = '/www/app/Services/PlanService.php';
$s = file_get_contents($f);

if (strpos($s, 'kc_entitlement_pack') !== false) { echo "ALREADY PATCHED\n"; exit(0); }

$anchor = "        // KC 补丁：充值套餐 show=0 仅隐藏自商品页，面板按 plan_id 建单需放行\n" .
    "        if (\$this->plan->kc_is_topup) {\n" .
    "            return;\n" .
    "        }\n";
if (strpos($s, $anchor) === false) { echo "ANCHOR NOT FOUND（请先打 P1） - ABORT\n"; exit(1); }

$patch = $anchor .
    "\n" .
    "        // KC 补丁：权益包商品（kc_card.category='entitlement'）同样 show=0 仅隐藏自商品页，\n" .
    "        // 由前台「权益包」独立页按 plan_id 建单，需放行。\n" .
    "        if ((\$__kc_card = json_decode((string) \$this->plan->kc_card, true)) && is_array(\$__kc_card)\n" .
    "            && (\$__kc_card['category'] ?? '') === 'entitlement') { // kc_entitlement_pack\n" .
    "            return;\n" .
    "        }\n";

$s = str_replace($anchor, $patch, $s);
file_put_contents($f, $s);
echo "PATCHED\n";
