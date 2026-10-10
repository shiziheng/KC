<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * USDT 充值识别与异常补单字段。
 *
 * 这些字段只描述「应付/实收/核验」状态，不改变业务到账金额。
 * 余额只有在 TopupService 幂等完成后才会增加。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_topups')) {
            return;
        }

        Schema::table('v2_plugin_kc_topups', function (Blueprint $table) {
            $columns = [
                'payment_reference' => ['string', [32], '支付参考号'],
                'expected_amount' => ['unsignedBigInteger', [], '预计支付金额（最小单位）'],
                'received_amount' => ['unsignedBigInteger', [], '实际到账金额（最小单位）'],
                'chain' => ['string', [32], '区块链网络'],
                'wallet_address' => ['string', [128], '收款钱包地址'],
                'tx_hash' => ['string', [128], '链上交易哈希'],
                'confirmations' => ['unsignedInteger', [], '区块确认数'],
                'match_status' => ['string', [32], '支付匹配状态'],
                'payment_source' => ['string', [32], '回调/钱包扫描/人工'],
                'manual_reason' => ['string', [500], '人工处理原因'],
                'operator_ref' => ['string', [191], '操作人标识'],
            ];

            foreach ($columns as $name => [$type, $args, $comment]) {
                if (Schema::hasColumn('v2_plugin_kc_topups', $name)) {
                    continue;
                }
                if ($type === 'string') {
                    $definition = $table->string($name, (int) ($args[0] ?? 255));
                } elseif ($type === 'unsignedBigInteger') {
                    $definition = $table->unsignedBigInteger($name);
                } else {
                    $definition = $table->unsignedInteger($name);
                }
                $definition = $definition->nullable()->comment($comment);
                if ($name === 'received_amount' || $name === 'expected_amount' || $name === 'confirmations') {
                    $definition->default(0);
                }
                if ($name === 'match_status') {
                    $definition->default('pending');
                }
                if ($name === 'payment_source') {
                    $definition->default('webhook');
                }
            }
        });

        foreach (['payment_reference' => 'idx_kc_topups_payment_reference', 'tx_hash' => 'idx_kc_topups_tx_hash'] as $column => $index) {
            try {
                \Illuminate\Support\Facades\DB::statement(
                    "ALTER TABLE `v2_plugin_kc_topups` ADD UNIQUE INDEX `{$index}` (`{$column}`)"
                );
            } catch (\Throwable $e) {
                // 已存在或历史重复数据时不阻断升级；应用层仍会做重复核验。
            }
        }
    }

    public function down(): void
    {
        if (!Schema::hasTable('v2_plugin_kc_topups')) {
            return;
        }
        foreach (['idx_kc_topups_payment_reference', 'idx_kc_topups_tx_hash'] as $index) {
            try { \Illuminate\Support\Facades\DB::statement("ALTER TABLE `v2_plugin_kc_topups` DROP INDEX `{$index}`"); } catch (\Throwable $e) {}
        }
        Schema::table('v2_plugin_kc_topups', function (Blueprint $table) {
            foreach (['payment_reference', 'expected_amount', 'received_amount', 'chain', 'wallet_address', 'tx_hash', 'confirmations', 'match_status', 'payment_source', 'manual_reason', 'operator_ref'] as $column) {
                if (Schema::hasColumn('v2_plugin_kc_topups', $column)) {
                    $table->dropColumn($column);
                }
            }
        });
    }
};
