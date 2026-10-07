<?php
// FEAT-006 段1：为 xboard.v2_plan 增加商品卡片配置字段（幂等）
require '/www/vendor/autoload.php';
$app = require '/www/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$has = DB::select("SHOW COLUMNS FROM v2_plan LIKE 'kc_card'");
if ($has) {
    echo "kc_card 字段已存在，跳过\n";
} else {
    DB::statement("ALTER TABLE v2_plan ADD COLUMN kc_card TEXT NULL COMMENT 'FEAT-006 商品卡片配置(JSON)' AFTER renew");
    echo "已添加 kc_card 字段\n";
}
$cols = array_map(function ($c) { return $c->Field; }, DB::select('SHOW COLUMNS FROM v2_plan'));
echo '当前字段: ' . implode(',', $cols) . "\n";
