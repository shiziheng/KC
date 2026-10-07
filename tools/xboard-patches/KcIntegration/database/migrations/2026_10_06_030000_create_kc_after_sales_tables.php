<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** FEAT-018 S9：用户订单售后申请与处理记录。 */
return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_after_sales')) {
            Schema::create('v2_plugin_kc_after_sales', function (Blueprint $table) {
                $table->id();
                $table->string('request_no', 32)->unique()->comment('售后申请号');
                $table->string('trade_no', 36)->unique()->comment('每个订单最多一条主售后申请');
                $table->unsignedBigInteger('order_id')->default(0);
                $table->unsignedBigInteger('user_id')->default(0);
                $table->string('request_type', 24)->default('other')->comment('failed/timeout/refund/other');
                $table->string('status', 24)->default('pending')->comment('pending/reviewing/approved/rejected/resolved/cancelled');
                $table->string('user_message', 1000)->default('');
                $table->string('admin_note', 500)->default('');
                $table->string('resolution', 500)->default('');
                $table->string('operator_ref', 191)->default('');
                $table->timestamp('processed_at')->nullable();
                $table->timestamps();

                $table->index(['user_id', 'created_at']);
                $table->index(['status', 'created_at']);
            });
        }

        if (!Schema::hasTable('v2_plugin_kc_after_sales_messages')) {
            Schema::create('v2_plugin_kc_after_sales_messages', function (Blueprint $table) {
                $table->id();
                $table->unsignedBigInteger('after_sales_id');
                $table->string('sender_type', 16)->default('user')->comment('user/admin/system');
                $table->string('sender_ref', 191)->default('');
                $table->string('content', 1000)->default('');
                $table->timestamp('created_at')->useCurrent();

                $table->index(['after_sales_id', 'created_at'], 'kc_after_sales_msg_idx');
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('v2_plugin_kc_after_sales_messages');
        Schema::dropIfExists('v2_plugin_kc_after_sales');
    }
};
