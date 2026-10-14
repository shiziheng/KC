<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * 用户权益查询控制器（权益包）
 *
 * 为什么需要这一层代理：
 *   权益数据（kc_entitlement_grants）在 KC（server.js）侧，而 KC **没有任何 CORS 配置**，
 *   浏览器直连会被同源策略拦掉；同时 KC 侧也没有用户态鉴权。
 *   因此由 Xboard 后端带集成密钥代查，前台只调自家接口（与 StatusController 同款范式）。
 *
 * 安全约束：
 *   1) 必须登录（路由挂 'user' 中间件）
 *   2) user_id 一律取自登录态，**不接受前端传入**，杜绝越权看他人权益
 *   3) KC 不可达时降级为空列表（stale=true），不让页面报错
 *
 * 路由：GET /user/kc/entitlements
 */
class EntitlementController extends PluginController
{
    private const TIMEOUT = 3;
    private const CONNECT_TIMEOUT = 2;

    public function mine(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        $apiKey  = (string) $this->getConfig('integration_key', '');
        if ($baseUrl === '' || $apiKey === '') {
            return $this->success(['grants' => [], 'stale' => true]);
        }

        try {
            $response = Http::withHeaders([
                'X-Integration-Key' => $apiKey,
                'Accept'            => 'application/json',
            ])
                ->timeout(self::TIMEOUT)
                ->connectTimeout(self::CONNECT_TIMEOUT)
                ->get($baseUrl . '/api/integration/entitlement/grants', [
                    'user_id' => (int) $request->user()->id,
                ]);
        } catch (\Throwable $e) {
            Log::channel('daily')->warning('[KcIntegration] 权益查询请求失败: ' . $e->getMessage());
            return $this->success(['grants' => [], 'stale' => true]);
        }

        if ($response->failed()) {
            return $this->success(['grants' => [], 'stale' => true]);
        }

        $json = $response->json();
        if (!is_array($json) || ($json['success'] ?? false) !== true) {
            return $this->success(['grants' => [], 'stale' => true]);
        }

        $data = $json['data'] ?? [];
        return $this->success([
            'grants' => is_array($data['grants'] ?? null) ? $data['grants'] : [],
            'stale'  => false,
        ]);
    }
}
