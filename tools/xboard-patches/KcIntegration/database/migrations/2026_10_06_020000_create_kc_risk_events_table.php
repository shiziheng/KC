<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** FEAT-018 S7：代充/充值风险事件（只保存不可逆指纹，不保存原始请求凭据）。 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('v2_plugin_kc_risk_events')) {
            return;
        }

        Schema::create('v2_plugin_kc_risk_events', function (Blueprint $table) {
            $table->id();
            $table->uuid('event_key')->unique();
            $table->string('endpoint', 32)->comment('redeem / topup');
            $table->string('scope_type', 32)->comment('ip / user / cdk / account');
            $table->char('scope_hash', 64)->comment('HMAC-SHA256 指纹，不可逆');
            $table->string('rule', 64);
            $table->string('action', 16)->comment('allow / challenge / block / manual');
            $table->string('event_type', 16)->default('attempt')->comment('attempt / failure / release');
            $table->unsignedInteger('observed_count')->default(0);
            $table->unsignedInteger('window_seconds')->default(0);
            $table->unsignedInteger('cooldown_seconds')->default(0);
            $table->unsignedBigInteger('user_id')->nullable();
            $table->string('trade_no', 64)->nullable();
            $table->timestamp('expires_at')->nullable();
            $table->timestamp('released_at')->nullable();
            $table->string('released_by', 191)->nullable();
            $table->json('metadata')->nullable()->comment('仅保存非敏感规则上下文');
            $table->timestamps();

            $table->index(['scope_type', 'scope_hash', 'created_at'], 'kc_risk_scope_created_idx');
            $table->index(['endpoint', 'action', 'expires_at'], 'kc_risk_action_expiry_idx');
            $table->index(['event_type', 'created_at'], 'kc_risk_type_created_idx');
            $table->index(['user_id', 'created_at'], 'kc_risk_user_created_idx');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('v2_plugin_kc_risk_events');
    }
};
