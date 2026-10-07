<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** FEAT-018 S6：余额与代充资金变动的最小可核对流水。 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('v2_plugin_kc_ledger')) {
            return;
        }

        Schema::create('v2_plugin_kc_ledger', function (Blueprint $table) {
            $table->id();
            $table->string('event_key', 128)->unique()->comment('业务幂等键');
            $table->unsignedBigInteger('user_id')->default(0);
            $table->unsignedBigInteger('order_id')->nullable();
            $table->string('trade_no', 36)->nullable();
            $table->string('type', 32)->comment('topup / order_debit / compensation_credit / manual_adjustment');
            $table->bigInteger('amount')->comment('余额变动，单位分；收入为正、扣款为负');
            $table->bigInteger('balance_before')->default(0);
            $table->bigInteger('balance_after')->default(0);
            $table->string('source', 64)->default('system');
            $table->string('operator_ref', 191)->default('system');
            $table->json('metadata')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'created_at']);
            $table->index(['trade_no', 'type']);
            $table->index(['type', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('v2_plugin_kc_ledger');
    }
};
