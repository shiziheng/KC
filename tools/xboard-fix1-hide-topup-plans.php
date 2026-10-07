<?php
// FIX-1: 商品页脏数据清理
// 1) 所有 KC 充值套餐（kc_is_topup=1）设 show=0 —— 商品页不再展示，但面板建单走 findOrFail 不校验 show，动线不受影响
// 2) id=2 测试套餐改名（去掉「-测试」字样，它是 ¥100 档充值套餐，需保留给面板用）
require '/www/vendor/autoload.php';
$app = require '/www/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$rows = \DB::table('v2_plan')->where('kc_is_topup', 1)->orderBy('id')->get(['id', 'name', 'show', 'prices']);
echo "BEFORE(topup plans): " . json_encode($rows, JSON_UNESCAPED_UNICODE) . "\n";

\DB::table('v2_plan')->where('kc_is_topup', 1)->update(['show' => 0]);
\DB::table('v2_plan')->where('id', 2)->update(['name' => '余额充值 ¥100']);

$rows2 = \DB::table('v2_plan')->orderBy('id')->get(['id', 'name', 'show', 'kc_is_topup', 'kc_topup_amount']);
echo "AFTER(all plans): " . json_encode($rows2, JSON_UNESCAPED_UNICODE) . "\n";

$n = \DB::table('v2_plan')->where('kc_is_topup', 1)->where('show', 1)->count();
echo "REMAINING visible topup plans: " . $n . "\n";
