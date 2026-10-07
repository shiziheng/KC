<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FEAT-004 · D2：充值套餐标记 + 充值流水表
 *
 * 背景：Xboard 原生**没有"充值"这个概念** ——
 *   - Order::$typeMap 只有 新购/续费/升级/流量重置 四种类型
 *   - 余额被设计成「只能由佣金划转进来、只能花出去」的内部抵扣池
 *     （钱包页文案就是「账户余额(仅消费)」）
 *
 * 本期的做法（方案 B）：把充值做成一个**特殊套餐**，
 *   下单 → 走原生支付链路 → 付款进 order.open.after 钩子 → 插件识别后改为给余额加钱。
 *
 * 因此需要两样东西：
 *   1. 套餐上一个**标记位**，让插件能判断"这是充值套餐"
 *      —— 靠 plan_id 白名单太脆（换套餐要改配置），加列更干净。
 *   2. 一张**充值流水表**，用 trade_no 唯一约束做幂等。
 *      —— 这是防资损的关键：钩子可能重复触发（重试/重复回调），重复加钱 = 直接损失。
 */
return new class extends Migration
{
    public function up(): void
    {
        // ── 1) v2_plan 加充值标记
        if (Schema::hasTable('v2_plan')) {
            Schema::table('v2_plan', function (Blueprint $table) {
                if (!Schema::hasColumn('v2_plan', 'kc_is_topup')) {
                    $table->unsignedTinyInteger('kc_is_topup')
                        ->default(0)
                        ->after('show')
                        ->comment('是否充值套餐：1=是（下单后给余额加钱，不发订阅），0=普通套餐');
                }
                if (!Schema::hasColumn('v2_plan', 'kc_topup_amount')) {
                    $table->unsignedInteger('kc_topup_amount')
                        ->default(0)
                        ->after('kc_is_topup')
                        ->comment('充值到账金额（单位：分）。仅 kc_is_topup=1 时有意义');
                }
            });
        }

        // ── 2) 充值流水表（幂等键 = trade_no）
        if (!Schema::hasTable('v2_plugin_kc_topups')) {
            Schema::create('v2_plugin_kc_topups', function (Blueprint $table) {
                $table->id();
                $table->string('trade_no', 36)->unique()->comment('Xboard 订单号，幂等键');
                $table->unsignedInteger('user_id')->default(0)->comment('充值受益人');
                $table->unsignedInteger('amount')->default(0)->comment('到账金额（分）');
                $table->unsignedInteger('balance_before')->default(0)->comment('充值前余额（分）');
                $table->unsignedInteger('balance_after')->default(0)->comment('充值后余额（分）');
                $table->string('status', 16)->default('pending')
                    ->comment('pending=已占位待处理 / done=已到账 / failed=失败');
                $table->string('error_msg', 500)->default('')->comment('失败原因');
                $table->unsignedInteger('attempts')->default(0)->comment('被触发次数（含重复回调）');
                $table->timestamps();

                $table->index('user_id');
                $table->index('status');
                $table->index('created_at');
            });
        }
    }

    public function down(): void
    {
        if (Schema::hasTable('v2_plan')) {
            Schema::table('v2_plan', function (Blueprint $table) {
                if (Schema::hasColumn('v2_plan', 'kc_topup_amount')) {
                    $table->dropColumn('kc_topup_amount');
                }
                if (Schema::hasColumn('v2_plan', 'kc_is_topup')) {
                    $table->dropColumn('kc_is_topup');
                }
            });
        }

        Schema::dropIfExists('v2_plugin_kc_topups');
    }
};
