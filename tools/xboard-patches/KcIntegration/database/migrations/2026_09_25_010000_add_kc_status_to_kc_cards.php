<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 段C4：为发卡表补「KC 侧开通状态」相关列
 *
 * 用途：首次查询 KC 后回写，使订单页打开时能立即渲染上次已知状态，
 *       并在 KC 不可达时提供降级展示（不必等一次失败的往返）。
 *
 * 注意：列名刻意与 KcCard::STATUS_* 区分开 ——
 *       前者是「发卡状态」（issued/failed/skipped，插件侧），
 *       后者是「开通状态」（pending/running/completed/failed，KC 侧）。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_cards')) {
            return;
        }

        Schema::table('v2_plugin_kc_cards', function (Blueprint $table) {
            if (!Schema::hasColumn('v2_plugin_kc_cards', 'kc_status')) {
                $table->string('kc_status', 16)
                    ->default('pending')
                    ->after('status')
                    ->comment('KC 侧开通状态：pending / running / completed / failed');
            }
            if (!Schema::hasColumn('v2_plugin_kc_cards', 'kc_synced_at')) {
                $table->timestamp('kc_synced_at')
                    ->nullable()
                    ->after('kc_status')
                    ->comment('最后一次成功同步 KC 状态的时间');
            }
        });
    }

    public function down(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_cards')) {
            return;
        }

        Schema::table('v2_plugin_kc_cards', function (Blueprint $table) {
            if (Schema::hasColumn('v2_plugin_kc_cards', 'kc_status')) {
                $table->dropColumn('kc_status');
            }
            if (Schema::hasColumn('v2_plugin_kc_cards', 'kc_synced_at')) {
                $table->dropColumn('kc_synced_at');
            }
        });
    }
};
