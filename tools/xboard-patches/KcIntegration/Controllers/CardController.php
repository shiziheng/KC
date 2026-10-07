<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Order;
use Illuminate\Http\Request;
use Plugin\KcIntegration\Models\KcCard;

/**
 * 卡密查询控制器
 *
 * 供前台订单页展示「我这一单拿到的卡密」。
 * 继承 PluginController 以复用 getConfig() 与插件启用态校验。
 */
class CardController extends PluginController
{
    /**
     * 查询单个订单的卡密。
     * GET /api/user/kc/card?trade_no=xxx
     */
    public function query(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate([
            'trade_no' => 'required|string|max:36',
        ]);

        $tradeNo = (string) $request->input('trade_no');
        $userId  = (int) $request->user()->id;

        // 越权防护：订单必须属于当前用户
        $owns = Order::where('trade_no', $tradeNo)->where('user_id', $userId)->exists();
        if (!$owns) {
            return $this->fail([400, '订单不存在或无权访问']);
        }

        $card = KcCard::where('trade_no', $tradeNo)->first();
        if (!$card) {
            return $this->success([
                'status'    => 'pending',
                'status_cn' => '待发放',
                'cdk'       => '',
                'state'     => KcCard::STATE_PENDING,
                'state_cn'  => KcCard::stateLabel(KcCard::STATE_PENDING),
                'terminal'  => false,
                'next_action' => 'wait',
                'message'   => '订单正在发放卡密，请稍候',
            ]);
        }

        $state = $card->canonicalState();
        return $this->success([
            'status'    => $card->status,
            'status_cn' => KcCard::$statusMap[$card->status] ?? $card->status,
            'cdk'       => $card->isIssued() ? $card->cdk_code : '',
            'plan_type' => $card->plan_type,
            // 统一履约状态由 StatusController 提供；此接口只返回兼容的通用文案。
            'kc_status'  => (string) $card->kc_status,
            'kc_message' => KcCard::stateLabel($state),
            'state'      => $state,
            'state_cn'   => KcCard::stateLabel($state),
            'terminal'   => KcCard::stateIsTerminal($state),
            'next_action' => $this->nextAction($state, $card->isIssued()),
            'message'    => $this->stateMessage($state),
        ]);
    }

    /**
     * 查询当前用户的全部卡密。
     * GET /api/user/kc/cards
     */
    public function list(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $userId = (int) $request->user()->id;

        $tradeNos = Order::where('user_id', $userId)->pluck('trade_no')->all();
        if (empty($tradeNos)) {
            return $this->success([]);
        }

        $cards = KcCard::whereIn('trade_no', $tradeNos)
            ->orderBy('created_at', 'desc')
            ->get()
            ->map(function (KcCard $c) {
                $state = $c->canonicalState();
                return [
                    'trade_no'  => $c->trade_no,
                    'status'    => $c->status,
                    'status_cn' => KcCard::$statusMap[$c->status] ?? $c->status,
                    'cdk'       => $c->isIssued() ? $c->cdk_code : '',
                    'plan_type' => $c->plan_type,
                    'created_at' => $c->created_at,
                    'state'     => $state,
                    'state_cn'  => KcCard::stateLabel($state),
                    'terminal'  => KcCard::stateIsTerminal($state),
                    'next_action' => $this->nextAction($state, $c->isIssued()),
                    'message'   => $this->stateMessage($state),
                ];
            });

        return $this->success($cards);
    }

    protected function nextAction(string $state, bool $issued): string
    {
        return match ($state) {
            KcCard::STATE_COMPLETED => 'view_order',
            KcCard::STATE_RUNNING, KcCard::STATE_VALIDATING => $issued ? 'view_progress' : 'wait',
            KcCard::STATE_FAILED, KcCard::STATE_COMPENSATING, KcCard::STATE_MANUAL => 'after_sales',
            KcCard::STATE_PENDING => $issued ? 'redeem' : 'wait',
            default => 'wait',
        };
    }

    protected function stateMessage(string $state): string
    {
        return match ($state) {
            KcCard::STATE_PENDING => '等待系统发放卡密',
            KcCard::STATE_VALIDATING => '正在校验代充任务',
            KcCard::STATE_RUNNING => '开通处理中，请稍候',
            KcCard::STATE_COMPLETED => '开通已完成',
            KcCard::STATE_FAILED => '开通未成功，请联系客服处理',
            KcCard::STATE_COMPENSATING => '代充未完成，正在处理补偿',
            KcCard::STATE_MANUAL => '结果待确认，请联系客服处理',
            default => '处理中',
        };
    }
}
