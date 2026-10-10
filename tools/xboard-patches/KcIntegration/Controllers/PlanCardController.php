<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Plugin\KcIntegration\Support\SupplierHealthClient;

/**
 * 商品页配置（公开接口 · FEAT-006 卡片 / FEAT-009 分类 + 常见问题）
 *
 * 供前台商品页一次读取：
 *   - cards      每个在售套餐的卡片展示配置（未配置为 null，前台走默认模板）
 *   - categories 服务分类列表（代充/成品号/建站服务…，后台可配）
 *   - faq        商品页常见问题（问答对，后台可配）
 *
 * 免登录：属营销展示信息，不含敏感数据。
 * 路由：GET /plan/kc-cards（插件路由无 /api 前缀）
 */
class PlanCardController extends PluginController
{
    /** 前台统一四态；featured/recommend 仅作为旧版角标语义，按在售处理。 */
    protected function normalizeState(?string $state): string
    {
        return in_array($state, ['soon', 'soldout', 'manual'], true) ? $state : 'onsale';
    }

    protected function normalizeRules(?array $rules): array
    {
        $rules = is_array($rules) ? $rules : [];
        $restrictions = [];
        foreach ((array) ($rules['restrictions'] ?? []) as $item) {
            $item = trim((string) $item);
            if ($item !== '' && !in_array($item, $restrictions, true)) {
                $restrictions[] = mb_substr($item, 0, 100);
            }
            if (count($restrictions) >= 4) break;
        }
        return [
            'account' => mb_substr(trim((string) ($rules['account'] ?? '已登录的 ChatGPT 账号')) ?: '已登录的 ChatGPT 账号', 0, 80),
            'fulfillment' => mb_substr(trim((string) ($rules['fulfillment'] ?? '通常 3–5 分钟，具体以订单状态为准')) ?: '通常 3–5 分钟，具体以订单状态为准', 0, 120),
            'restrictions' => $restrictions ?: ['付款前请核对目标账号和套餐', '不要重复创建相同订单'],
            'failure' => mb_substr(trim((string) ($rules['failure'] ?? '开通失败或长时间未完成，请从订单页申请售后，避免重复付款')) ?: '开通失败或长时间未完成，请从订单页申请售后，避免重复付款', 0, 160),
        ];
    }

    protected function stateReason(string $state, string $supplierReason = ''): ?string
    {
        if ($state === 'soon') return '服务即将上线，暂不接受自动办理';
        if ($state === 'manual') return '该商品需要人工确认，请先查看办理规则';
        if ($state === 'soldout') return $supplierReason !== '' ? $supplierReason : '当前商品暂不可售，请稍后重试';
        return null;
    }

    public function index(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        try {
            $rows = DB::table('v2_plan')
                ->where('show', 1)
                ->where(function ($q) {
                    $q->whereNull('kc_is_topup')->orWhere('kc_is_topup', 0);
                })
                ->orderBy('sort')->orderBy('id')
                ->get(['id', 'name', 'kc_card']);

            $cards = [];
            $sellable = [];
            $availability = [];
            $packages = $this->getConfig('packages', []);
            if (is_string($packages)) {
                $packages = json_decode($packages, true) ?: [];
            }
            $healthClient = new SupplierHealthClient(
                (string) $this->getConfig('kc_base_url', ''),
                (string) $this->getConfig('integration_key', ''),
                2,
                1
            );
            $healthResult = $healthClient->fetch();
            foreach ($rows as $r) {
                $card = null;
                if (!empty($r->kc_card)) {
                    $decoded = json_decode((string) $r->kc_card, true);
                    if (is_array($decoded)) {
                        $card = $decoded;
                    }
                }
                $cardState = $this->normalizeState(is_array($card) ? ($card['state'] ?? null) : null);
                if (is_array($card)) {
                    $card['state'] = $cardState;
                    $card['rules'] = $this->normalizeRules($card['rules'] ?? null);
                }
                $cards[(string) $r->id] = $card;
                $planType = is_array($packages) ? ($packages[(string) $r->id] ?? $packages[$r->id] ?? '') : '';
                // 未映射套餐属于其它商品/人工交付，不被代充供应商状态隐藏。
                $healthSellable = $planType === ''
                    ? true
                    : $healthClient->sellableIn($healthResult, (string) $planType);
                $displayState = $cardState === 'onsale' && !$healthSellable ? 'soldout' : $cardState;
                $isSellable = $healthSellable && $displayState === 'onsale';
                $reason = $this->stateReason($displayState, $healthSellable ? '' : (string) ($healthResult['health']['reason'] ?? ''));
                $sellable[(string) $r->id] = $isSellable;
                $availability[(string) $r->id] = [
                    'state' => $displayState,
                    'sellable' => $isSellable,
                    'reason' => $reason,
                ];
            }

            // 分类列表（后台可配；缺省给三类默认值）
            $categories = json_decode((string) DB::table('v2_settings')->where('name', 'kc_plan_categories')->value('value'), true);
            if (!is_array($categories) || !count($categories)) {
                $categories = [
                    ['key' => 'recharge', 'name' => '代充', 'nav' => true],
                    ['key' => 'account', 'name' => '成品号', 'nav' => true],
                    ['key' => 'website', 'name' => '建站服务', 'nav' => true],
                ];
            }

            // 商品页常见问题（后台可配）
            $faq = json_decode((string) DB::table('v2_settings')->where('name', 'kc_plan_faq')->value('value'), true);
            if (!is_array($faq)) {
                $faq = [];
            }

            return $this->success([
                'cards' => $cards,
                'sellable' => $sellable,
                'availability' => $availability,
                'supplier_health' => $healthResult['health'],
                'categories' => array_values($categories),
                'faq' => array_values($faq),
            ]);
        } catch (\Throwable $e) {
            \Log::channel('daily')->error('[KcIntegration] 商品页配置读取失败: ' . $e->getMessage());
            return $this->fail([500, '配置加载失败']);
        }
    }
}
