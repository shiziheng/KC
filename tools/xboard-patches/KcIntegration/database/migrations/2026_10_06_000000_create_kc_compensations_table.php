<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FEAT-018 S4：代充失败补偿台账。
 *
 * Xboard 的 v2_order.status 继续表示支付/原生履约状态，不拿来伪装退款状态。
 * 每个 trade_no 只允许一条补偿记录，数据库唯一键是重复状态查询和并发请求的
 * 最终裁决边界。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('v2_plugin_kc_compensations')) {
            return;
        }

        Schema::create('v2_plugin_kc_compensations', function (Blueprint $table) {
            $table->id();
            $table->string('trade_no', 36)->unique()->comment('Xboard 订单号，业务幂等键');
            $table->string('idempotency_key', 96)->unique()->comment('补偿幂等键');
            $table->unsignedBigInteger('order_id')->default(0);
            $table->unsignedBigInteger('user_id')->default(0);
            $table->string('compensation_type', 24)->default('review')
                ->comment('balance / external / mixed / review');
            $table->string('status', 48)->default('processing')
                ->comment('processing / balance_refunded / manual_pending / partial_refunded_manual_pending / manual_done / review_pending / failed');
            $table->unsignedInteger('amount')->default(0)->comment('待补偿本金合计，单位分');
            $table->unsignedInteger('balance_amount')->default(0)->comment('原订单余额抵扣部分，单位分');
            $table->unsignedInteger('external_amount')->default(0)->comment('外部支付本金，单位分');
            $table->unsignedInteger('handling_amount')->default(0)->comment('支付手续费，仅供人工核对');
            $table->unsignedInteger('balance_before')->default(0);
            $table->unsignedInteger('balance_after')->default(0);
            $table->string('reason_code', 64)->default('kc_task_failed');
            $table->string('reason', 255)->default('')->comment('脱敏后的内部原因');
            $table->string('operator_ref', 191)->default('system');
            $table->string('note', 500)->default('');
            $table->unsignedInteger('attempts')->default(1);
            $table->timestamp('balance_refunded_at')->nullable();
            $table->timestamp('processed_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'created_at']);
            $table->index(['status', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('v2_plugin_kc_compensations');
    }
};
