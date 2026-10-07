<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 段C6：为发卡表补「KC 侧进度与提示文案」两列
 *
 * 为什么需要（段C5 的设计盲区）：
 *   StatusController 对**终态**卡密走「短路」分支，不再外呼 KC（省一次往返）。
 *   但 progress / message 此前只存在于 C5 接口的返回值里，一进终态就丢失 ——
 *   表现为：订单页刷新后，失败原因消失、进度条退回状态默认值。
 *   段C5 的目标恰恰是「失败原因可见」，而失败必然是终态 ⇒ 这条路径必须能持久化。
 *
 * 持久化后：
 *   - 终态短路直接从库读，无需再打 KC
 *   - 页面刷新 / KC 暂时不可达时，仍能展示最后一次已知的真实进度与文案
 */
return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_cards')) {
            return;
        }

        Schema::table('v2_plugin_kc_cards', function (Blueprint $table) {
            if (!Schema::hasColumn('v2_plugin_kc_cards', 'kc_progress')) {
                $table->unsignedTinyInteger('kc_progress')
                    ->nullable()
                    ->after('kc_synced_at')
                    ->comment('KC 侧任务进度 0-100，未同步到时为 NULL');
            }
            if (!Schema::hasColumn('v2_plugin_kc_cards', 'kc_message')) {
                $table->string('kc_message', 255)
                    ->nullable()
                    ->after('kc_progress')
                    ->comment('KC 侧提示文案 / 失败原因（已由 KC 侧脱敏）');
            }
        });
    }

    public function down(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_cards')) {
            return;
        }

        Schema::table('v2_plugin_kc_cards', function (Blueprint $table) {
            if (Schema::hasColumn('v2_plugin_kc_cards', 'kc_progress')) {
                $table->dropColumn('kc_progress');
            }
            if (Schema::hasColumn('v2_plugin_kc_cards', 'kc_message')) {
                $table->dropColumn('kc_message');
            }
        });
    }
};
