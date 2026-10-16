<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

/**
 * 前台同源代理控制器（v1.39.0 · Stage 2.4 收口）
 *
 * 背景：Xboard 注入的前台页面历史上直连 KC（http://localhost:3100），
 *       会把 KC 端口/域名写进前端源码，且依赖跨域。本控制器提供**同源**代理：
 *       前台只请求本插件路由，KC 真实地址只存在于服务端配置（kc_base_url）。
 *
 * 真实访问路径（插件路由无 /api 前缀）：
 *   GET /kc-proxy/site-config  → 代理 KC 公开接口 /api/public/site-config
 *   GET /kc-proxy/redeem       → 302 跳转 KC 兑卡页（cdk 透传；KC 地址不出现在响应正文）
 */
class ProxyController extends PluginController
{
    private const TIMEOUT = 5;
    private const CONNECT_TIMEOUT = 3;

    public function siteConfig(Request $request)
    {
        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        if ($baseUrl === '') {
            return response()->json(['success' => false, 'message' => 'KC 未配置'], 503);
        }
        try {
            $resp = Http::timeout(self::TIMEOUT)
                ->connectTimeout(self::CONNECT_TIMEOUT)
                ->acceptJson()
                ->get($baseUrl . '/api/public/site-config');
        } catch (\Throwable $e) {
            return response()->json(['success' => false, 'message' => 'KC 暂不可达'], 502);
        }
        // 原样透传 KC 响应体（KC 的 payload 在 config 键下，不套用 KcGateway 的 data 解包）
        return response($resp->body(), $resp->status())->header('Content-Type', 'application/json');
    }

    public function redeem(Request $request)
    {
        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        if ($baseUrl === '') {
            return response('KC 未配置', 503);
        }
        $cdk = (string) $request->query('cdk', '');
        $url = $baseUrl . '/' . ($cdk !== '' ? ('?cdk=' . urlencode($cdk)) : '');
        return redirect()->away($url);
    }
}
