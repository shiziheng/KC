<?php
/**
 * 权益包商品种子脚本（Xboard 侧）
 *
 * 作用：把「权益包」录入成 Xboard 后台既有商品体系里的普通套餐（独立分类），
 *      不引入任何新表/新体系 —— 这正是「改动 Xboard 代价最小」的落点。
 *
 * 约定（前台 #/pack 独立页与插件履约都按此约定识别）：
 *   v2_plan.kc_card.category = 'entitlement'   → 判定为权益包商品
 *   v2_plan.kc_card.pack_key = 'light' / 'pro' → 档位标识（对应 KC 权益规则）
 *   v2_plan.kc_card.times    = 权益次数（信息展示 + 与 KC 规则对齐）
 *   v2_plan.show = 0（隐藏自商品页，只能从 #/pack 独立页进入）
 *   v2_plan.prices.onetime = 包价（元）；不含其它档位，只支持一次性支付
 *
 * 幂等：按 pack_key 复用既有套餐，重复执行不会新建。
 *
 * 用法（容器内）：
 *   docker cp tools/xboard-pack-seed.php xboard:/www/xboard-pack-seed.php
 *   docker exec xboard php /www/xboard-pack-seed.php          # 建/复用
 *   docker exec xboard php /www/xboard-pack-seed.php --list   # 只列出现状
 */

require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

$listOnly = in_array('--list', $argv, true);

// ── 0. 兜底建列（与 xboard-add-kc-card.php 同源，幂等） ──
foreach ([
    'kc_card'     => "ALTER TABLE `v2_plan` ADD COLUMN `kc_card` JSON NULL COMMENT 'KC 商品卡片配置' AFTER `content`",
    'kc_is_topup' => "ALTER TABLE `v2_plan` ADD COLUMN `kc_is_topup` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'KC 充值套餐标记'",
] as $col => $ddl) {
    try {
        if (!Schema::hasColumn('v2_plan', $col)) {
            DB::statement($ddl);
            echo "COLUMN ADDED: {$col}\n";
        }
    } catch (\Throwable $e) {
        echo "COLUMN SKIP: {$col} ({$e->getMessage()})\n";
    }
}

// ── 1. 现状 ──
echo "== 现有套餐 ==\n";
foreach (DB::table('v2_plan')->orderBy('id')->get() as $p) {
    $card = json_decode((string) ($p->kc_card ?? ''), true);
    printf(
        "%d | %s | show=%s sell=%s topup=%s cat=%s key=%s times=%s prices=%s\n",
        $p->id,
        $p->name,
        $p->show,
        $p->sell,
        $p->kc_is_topup ?? '-',
        is_array($card) ? ($card['category'] ?? '-') : '-',
        is_array($card) ? ($card['pack_key'] ?? '-') : '-',
        is_array($card) ? ($card['times'] ?? '-') : '-',
        substr((string) $p->prices, 0, 60)
    );
}

// ── 2. 权益包定义（与前端 #/pack 展示、KC 权益规则一一对应） ──
// 定价口径：代充市场价 $20/次，权益价 $12/次（= 6 折），包价 = 次数 × $12。
$PACKS = [
    [
        'key' => 'light', 'name' => '轻享权益包', 'times' => 5, 'fee' => 60,
        'tagline' => '5 次权益 · 后续代充按 6 折结算',
        'highlight' => false, 'sort' => 900,
    ],
    [
        'key' => 'pro', 'name' => '尊享权益包', 'times' => 50, 'fee' => 600,
        'tagline' => '50 次权益 · 后续代充按 6 折结算，长期更省',
        'highlight' => true, 'sort' => 901,
    ],
];

if ($listOnly) {
    exit(0);
}

$gid = (int) (DB::table('v2_plan')->orderBy('id')->value('group_id') ?: 1);
$now = time();

echo "\n== 写入权益包 ==\n";
$map = [];
foreach ($PACKS as $pk) {
    $card = [
        'category'  => 'entitlement',
        'pack_key'  => $pk['key'],
        'pack_name' => $pk['name'],
        'times'     => $pk['times'],
        'tagline'   => $pk['tagline'],
        'highlight' => $pk['highlight'],
    ];

    // 幂等：按 pack_key 复用
    $found = null;
    foreach (DB::table('v2_plan')->get(['id', 'kc_card']) as $row) {
        $c = json_decode((string) ($row->kc_card ?? ''), true);
        if (is_array($c) && ($c['pack_key'] ?? '') === $pk['key']) { $found = (int) $row->id; break; }
    }

    $prices = json_encode(['onetime' => $pk['fee']]);
    if ($found) {
        DB::table('v2_plan')->where('id', $found)->update([
            'name'       => $pk['name'],
            'prices'     => $prices,
            'kc_card'    => json_encode($card, JSON_UNESCAPED_UNICODE),
            'show'       => 0,
            'sell'       => 1,
            'renew'      => 0,
            'updated_at' => $now,
        ]);
        echo "REUSED  id={$found} key={$pk['key']}\n";
    } else {
        $found = (int) DB::table('v2_plan')->insertGetId([
            'group_id'             => $gid,
            'transfer_enable'      => 0,
            'name'                 => $pk['name'],
            'prices'               => $prices,
            'sell'                 => 1,
            'show'                 => 0,   // 隐藏自商品页：只能从 #/pack 独立页进入
            'kc_is_topup'          => 0,
            'kc_card'              => json_encode($card, JSON_UNESCAPED_UNICODE),
            'capacity_limit'       => null, // NULL = 不限量（0 会直接判售罄）
            'sort'                 => $pk['sort'],
            'renew'                => 0,
            'content'              => '权益包（系统生成）· 购买后后续代充按权益价结算',
            'reset_traffic_method' => 0,
            'created_at'           => $now,
            'updated_at'           => $now,
        ]);
        echo "CREATED id={$found} key={$pk['key']}\n";
    }
    $map[] = ['key' => $pk['key'], 'plan_id' => $found, 'times' => $pk['times'], 'fee' => $pk['fee']];
}

echo "\n== 结果（供 KC 权益规则使用） ==\n";
foreach ($map as $m) {
    printf("PACK %s plan_id=%d plan_code=xplan_%d times=%d fee=%d\n", $m['key'], $m['plan_id'], $m['plan_id'], $m['times'], $m['fee']);
}
