<?php

namespace App\Console\Commands;

use App\Models\CommissionLog;
use Illuminate\Console\Command;
use App\Models\Order;
use App\Models\User;
use Illuminate\Support\Facades\DB;

class CheckCommission extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'check:commission';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = '返佣服务';

    /**
     * Create a new command instance.
     *
     * @return void
     */
    public function __construct()
    {
        parent::__construct();
    }

    /**
     * Execute the console command.
     *
     * @return mixed
     */
    public function handle()
    {
        $this->autoCheck();
        $this->autoPayCommission();
    }

    public function autoCheck()
    {
        if (!(int)admin_setting('commission_auto_check_enable', 1)) {
            return;
        }

        $query = Order::where('commission_status', 0)
            ->where('invite_user_id', '!=', NULL)
            ->where('status', 3)
            ->where('updated_at', '<=', strtotime('-3 day', time()));

        // ────────────────────────────────────────────────────────────────
        // KC-PATCH（业务决策：返利以「货交付」为前提）
        //
        // 原逻辑只看「订单已完成 + 满 3 天」，但订单在**发凭证（CDK）那一刻**
        // 就已经标记为完成 —— 货其实还没开通。于是出现：
        //   代充全部失败的订单，返利照样发出去（平台没赚到钱却要付佣金）。
        //
        // 这里补一个条件：该订单的卡密必须**已开通成功**（kc_status='completed'）。
        // 表不存在时**降级放行**，不中断原有返利逻辑。
        // ────────────────────────────────────────────────────────────────
        if ($this->kcHasCardTable()) {
            $query->whereExists(function ($q) {
                $q->select(DB::raw(1))
                    ->from('v2_plugin_kc_cards')
                    ->whereColumn('v2_plugin_kc_cards.trade_no', 'v2_order.trade_no')
                    ->where('v2_plugin_kc_cards.kc_status', 'completed');
            });
        }

        $query->update([
            'commission_status' => 1
        ]);
    }

    /** KC-PATCH：卡密表是否存在（不存在则降级为原逻辑，不影响返利） */
    private function kcHasCardTable(): bool
    {
        try {
            return \Illuminate\Support\Facades\Schema::hasTable('v2_plugin_kc_cards');
        } catch (\Throwable $e) {
            return false;
        }
    }

    public function autoPayCommission()
    {
        $orders = Order::where('commission_status', 1)
            ->where('invite_user_id', '!=', NULL)
            ->get();
        foreach ($orders as $order) {
            try{
                DB::beginTransaction();
                if (!$this->payHandle($order->invite_user_id, $order)) {
                    DB::rollBack();
                    continue;
                }
                $order->commission_status = 2;
                if (!$order->save()) {
                    DB::rollBack();
                    continue;
                }
                DB::commit();
            } catch (\Exception $e){
                DB::rollBack();
                throw $e;
            }
        }
    }

    public function payHandle($inviteUserId, Order $order)
    {
        $level = 3;
        if ((int)admin_setting('commission_distribution_enable', 0)) {
            $commissionShareLevels = [
                0 => (int)admin_setting('commission_distribution_l1'),
                1 => (int)admin_setting('commission_distribution_l2'),
                2 => (int)admin_setting('commission_distribution_l3')
            ];
        } else {
            $commissionShareLevels = [
                0 => 100
            ];
        }
        for ($l = 0; $l < $level; $l++) {
            $inviter = User::find($inviteUserId);
            if (!$inviter) continue;
            if (!isset($commissionShareLevels[$l])) continue;
            $commissionBalance = $order->commission_balance * ($commissionShareLevels[$l] / 100);
            if (!$commissionBalance) continue;
            if ((int)admin_setting('withdraw_close_enable', 0)) {
                $inviter->increment('balance', $commissionBalance);
            } else {
                $inviter->increment('commission_balance', $commissionBalance);
            }
            if (!$inviter->save()) {
                DB::rollBack();
                return false;
            }
            CommissionLog::create([
                'invite_user_id' => $inviteUserId,
                'user_id' => $order->user_id,
                'trade_no' => $order->trade_no,
                'order_amount' => $order->total_amount,
                'get_amount' => $commissionBalance
            ]);
            $inviteUserId = $inviter->invite_user_id;
            // update order actual commission balance
            $order->actual_commission_balance = $order->actual_commission_balance + $commissionBalance;
        }
        return true;
    }

}
