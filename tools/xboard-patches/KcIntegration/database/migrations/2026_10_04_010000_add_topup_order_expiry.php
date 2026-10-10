<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FEAT-014 · 充值订单台账增强
 *
 * 背景（用户反馈）：
 *   「充值时有付款或者进行中的订单则不能再发起新订单，这个不合理，应该允许发起新订单，
 *     同时每个充值订单设定有效时间，超过有效时间订单失效。前后台应该设置充值订单功能，
 *     记录不同充值状态的订单。」
 *
 * 本迁移做三件事：
 *   1. v2_plugin_kc_topups 增加 expires_at（订单失效时间戳）—— 到期未支付自动失效
 *   2. 增加 status 的 'expired' 语义（配合 expires_at 使用）
 *   3. 增加索引，加速「我的充值订单」按用户 + 状态 + 时间倒序查询
 *
 * ⚠️ 不新增表：复用既有台账表（v2_plugin_kc_topups 已有 trade_no UNIQUE 幂等约束）。
 *   新增表会与既有幂等逻辑双轨，徒增对账成本。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_topups')) {
            return;
        }

        Schema::table('v2_plugin_kc_topups', function (Blueprint $table) {
            if (!Schema::hasColumn('v2_plugin_kc_topups', 'expires_at')) {
                // 订单失效时间（unix 秒）。NULL = 永不过期（历史数据保持兼容）
                $table->unsignedInteger('expires_at')->nullable()->after('status')
                    ->comment('订单失效时间戳，NULL=不过期');
            }
            if (!Schema::hasColumn('v2_plugin_kc_topups', 'paid_at')) {
                // 实际到账时间（用于台账展示「多久到账」）
                $table->unsignedInteger('paid_at')->nullable()->after('expires_at')
                    ->comment('实际到账时间戳');
            }
            if (!Schema::hasColumn('v2_plugin_kc_topups', 'payment_method')) {
                // 支付方式（usdt / balance），便于对账
                $table->string('payment_method', 32)->nullable()->after('paid_at')
                    ->comment('支付方式：usdt / balance');
            }
        });

        // 索引：我的充值订单列表（user_id + status + created_at desc）
        try {
            \Illuminate\Support\Facades\DB::statement(
                'ALTER TABLE `v2_plugin_kc_topups`
                 ADD INDEX `idx_user_status_created` (`user_id`, `status`, `created_at`)'
            );
        } catch (\Throwable $e) {
            // 索引已存在时忽略
        }
    }

    public function down(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_topups')) {
            return;
        }
        Schema::table('v2_plugin_kc_topups', function (Blueprint $table) {
            foreach (['expires_at', 'paid_at', 'payment_method'] as $col) {
                if (Schema::hasColumn('v2_plugin_kc_topups', $col)) {
                    $table->dropColumn($col);
                }
            }
        });
    }
};
