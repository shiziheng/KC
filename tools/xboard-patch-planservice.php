<?php
// KC 补丁：充值套餐（kc_is_topup=1）隐藏自商品页（show=0），但面板建单需放行。
// 位置：PlanService::validatePlanAvailability —— show=0 && renew=0 会被「已售罄」拒绝。
$f = '/www/app/Services/PlanService.php';
$s = file_get_contents($f);

if (strpos($s, 'kc_is_topup') !== false) { echo "ALREADY PATCHED\n"; exit(0); }

$needle = "    protected function validatePlanAvailability(User \$user): void\n    {\n";
if (strpos($s, $needle) === false) { echo "NEEDLE NOT FOUND - ABORT\n"; exit(1); }

// 容器内备份（一次性）
if (!file_exists('/www/PlanService.php.orig.bak')) {
    copy($f, '/www/PlanService.php.orig.bak');
    echo "BACKUP: /www/PlanService.php.orig.bak\n";
}

$patch = $needle .
    "        // KC 补丁：充值套餐 show=0 仅隐藏自商品页，面板按 plan_id 建单需放行\n" .
    "        if (\$this->plan->kc_is_topup) {\n" .
    "            return;\n" .
    "        }\n";
$s = str_replace($needle, $patch, $s);
file_put_contents($f, $s);
echo "PATCHED\n";
