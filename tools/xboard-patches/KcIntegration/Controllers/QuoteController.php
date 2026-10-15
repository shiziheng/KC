<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * 用户态报价控制器（Step 7：代充按用户权益价结算）
 *
 * 为什么需要这一层代理：
 *   权益折扣数据（kc_entitlement_grants）与报价引擎在 KC（server.js）侧，
 *   KC 无 CORS、也没有用户态鉴权；集成端点必须带 X-Integration-Key，
 *   该密钥绝不能下发到浏览器。因此由 Xboard 后端带密钥代报，前台只调自家接口。
 *
 * 安全约束：
 *   1) 必须登录（路由挂 'user' 中间件）
 *   2) user_id 一律取自登录态，**不接受前端传入**，杜绝越权拿他人权益报价
 *   3) 仅返回报价数值（原价/权益价/折扣额），不返回 grant 内部字段
 *   4) KC 不可达时降级为「原价」（quotes 为空数组），前台回退到主题原价，不报错
 *
 * 路由：POST /user/kc/quotes   { items: [{ plan_id, base_cents, period? }] }
 */
class QuoteController extends PluginController
{
    private const TIMEOUT = 3;
    private const CONNECT_TIMEOUT = 2;
    private const MAX_ITEMS = 20;

    public function index(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $items = $request->input('items');
        if (!is_array($items) || count($items) === 0) {
            return $this->success(['quotes' => [], 'stale' => true]);
        }
        if (count($items) > self::MAX_ITEMS) {
            $items = array_slice($items, 0, self::MAX_ITEMS);
        }

        // 归一化为 KC 入参：plan_code 约定 xplan_<v2_plan.id>（与 R2 回填脚本一致）
        $kcItems = [];
        $planIdByCode = [];
        foreach ($items as $it) {
            $planId = (int) ($it['plan_id'] ?? 0);
            $baseCents = (int) ($it['base_cents'] ?? 0);
            if ($planId <= 0 || $baseCents <= 0) {
                continue;
            }
            $planCode = 'xplan_' . $planId;
            $kcItems[] = ['plan_code' => $planCode, 'base_cents' => $baseCents, 'qty' => 1];
            $planIdByCode[$planCode] = $planId;
        }
        if (count($kcItems) === 0) {
            return $this->success(['quotes' => [], 'stale' => true]);
        }

        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        $apiKey  = (string) $this->getConfig('integration_key', '');
        if ($baseUrl === '' || $apiKey === '') {
            return $this->success(['quotes' => [], 'stale' => true]);
        }

        try {
            $response = Http::withHeaders([
                'X-Integration-Key' => $apiKey,
                'Accept'            => 'application/json',
            ])
                ->timeout(self::TIMEOUT)
                ->connectTimeout(self::CONNECT_TIMEOUT)
                ->asJson()
                ->post($baseUrl . '/api/integration/entitlement/quote', [
                    'user_id' => (int) $request->user()->id,
                    'items'   => $kcItems,
                ]);
        } catch (\Throwable $e) {
            Log::channel('daily')->warning('[KcIntegration] 权益报价请求失败: ' . $e->getMessage());
            return $this->success(['quotes' => [], 'stale' => true]);
        }

        if ($response->failed()) {
            return $this->success(['quotes' => [], 'stale' => true]);
        }

        $json = $response->json();
        if (!is_array($json) || ($json['success'] ?? false) !== true) {
            return $this->success(['quotes' => [], 'stale' => true]);
        }

        $raw = $json['data']['quotes'] ?? [];
        $out = [];
        if (is_array($raw)) {
            foreach ($raw as $q) {
                $code = (string) ($q['plan_code'] ?? '');
                if ($code === '' || !isset($planIdByCode[$code])) {
                    continue;
                }
                $out[] = [
                    'plan_id'          => $planIdByCode[$code],
                    'base_cents'       => (int) ($q['base_cents'] ?? 0),
                    'final_cents'      => (int) ($q['final_cents'] ?? 0),
                    'applied_source'   => (string) ($q['applied_source'] ?? 'none'),
                    'discount_cents'   => (int) ($q['discount_cents'] ?? 0),
                ];
            }
        }

        return $this->success(['quotes' => $out, 'stale' => false]);
    }
}
