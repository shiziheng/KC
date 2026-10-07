<?php
// KC 补丁 #2：TopupController::prepare 与 show=0 清理的兼容
// 1) 复用 SQL 去掉 AND p.show = 1 —— 充值套餐 show=0 后仍可复用，不再增殖脏套餐
// 2) 新建套餐 'show' => 1 改为 0 —— 新生成的充值套餐默认隐藏自商品页
$f = '/www/plugins/KcIntegration/Controllers/TopupController.php';
$s = file_get_contents($f);

if (strpos($s, 'KC-PATCH2') !== false) { echo "ALREADY PATCHED\n"; exit(0); }

$orig = file_put_contents('/www/TopupController.php.orig.bak', $s) ? 'backup ok' : 'backup FAIL';
echo "BACKUP: $orig\n";

$n1 = 0; $n2 = 0;
// 1) 复用 SQL
$needle1 = "AND p.show = 1";
if (strpos($s, $needle1) !== false) {
    $s = str_replace($needle1, "/* KC-PATCH2: show 不限 */", $s, $n1);
}
// 2) 新建分支 show
$needle2 = "'show'                 => 1,";
if (strpos($s, $needle2) !== false) {
    $s = str_replace($needle2, "'show'                 => 0, // KC-PATCH2: 默认隐藏自商品页", $s, $n2);
}

echo "replace reuse-sql: $n1, new-plan-show: $n2\n";
if ($n1 === 0 && $n2 === 0) { echo "NOTHING REPLACED - ABORT\n"; exit(1); }
file_put_contents($f, $s);
echo "PATCHED\n";
