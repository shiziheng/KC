<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * KC 发卡记录表
 *
 * trade_no 建唯一索引 —— 这是插件侧的幂等基石：
 * 即使 order.open.after 因任务重试被多次触发，也只会留下一条记录。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('v2_plugin_kc_cards')) {
            return;
        }

        Schema::create('v2_plugin_kc_cards', function (Blueprint $table) {
            $table->id();
            $table->string('trade_no', 36)->unique()->comment('Xboard 订单号，幂等键');
            $table->unsignedBigInteger('plan_id')->default(0)->comment('Xboard 套餐ID');
            $table->string('plan_type', 32)->default('')->comment('KC 档位：plus / pro_5x / pro_20x');
            $table->string('user_ref', 191)->default('-')->comment('传给 KC 的用户标识（邮箱）');
            $table->string('cdk_code', 191)->default('')->comment('KC 发放的卡密');
            $table->string('status', 16)->default('failed')->comment('issued / failed / skipped');
            $table->string('error_msg', 500)->default('')->comment('失败原因');
            $table->unsignedInteger('attempts')->default(0)->comment('申领尝试次数');
            $table->timestamps();

            $table->index('status');
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('v2_plugin_kc_cards');
    }
};
