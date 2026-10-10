<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Payment;
use Illuminate\Http\Request;

/**
 * Xboard 运营菜单策略。
 *
 * Xboard 的管理端前端是编译产物，插件不能安全地改写其路由表，因此菜单整改
 * 先以可读取的策略清单落地：运营入口使用 keep，技术入口标记 technical，
 * 非代充能力标记 hidden。底层 API 不删除，方便管理员回退。
 */
class AdminMenuController extends PluginController
{
    public function index(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        return $this->success([
            'version' => '2026-10-06',
            'default_role' => 'operator',
            'groups' => [
                [
                    'key' => 'operations',
                    'title' => '代充运营',
                    'visibility' => 'operator',
                    'items' => [
                        ['key' => 'plan', 'title' => '代充商品', 'path' => '/finance/plan', 'action' => 'keep'],
                        ['key' => 'order', 'title' => '订单管理', 'path' => '/finance/order', 'action' => 'keep'],
                        ['key' => 'user', 'title' => '用户与余额', 'path' => '/user/manage', 'action' => 'keep'],
                        ['key' => 'payment', 'title' => 'USDT 支付', 'path' => '/payment', 'action' => 'keep'],
                        ['key' => 'topup', 'title' => '充值异常/余额补单', 'path' => '/plugins/kc_integration/ops#topups', 'action' => 'keep'],
                        ['key' => 'ticket', 'title' => '售后工单', 'path' => '/user/ticket', 'action' => 'keep'],
                    ],
                ],
                [
                    'key' => 'technical',
                    'title' => '技术维护',
                    'visibility' => 'administrator',
                    'items' => [
                        ['key' => 'server', 'title' => '节点/服务器', 'path' => '/server/manage', 'action' => 'technical'],
                        ['key' => 'machine', 'title' => '机器管理', 'path' => '/server/machine', 'action' => 'technical'],
                        ['key' => 'route', 'title' => '路由分组', 'path' => '/server/route', 'action' => 'technical'],
                        ['key' => 'traffic', 'title' => '流量重置', 'path' => '/traffic-reset', 'action' => 'technical'],
                        ['key' => 'system', 'title' => '系统状态/日志', 'path' => '/system', 'action' => 'technical'],
                        ['key' => 'plugin', 'title' => '插件维护', 'path' => '/plugin', 'action' => 'technical'],
                    ],
                ],
                [
                    'key' => 'deferred',
                    'title' => '暂不使用',
                    'visibility' => 'hidden',
                    'items' => [
                        ['key' => 'coupon', 'title' => '优惠券/活动', 'path' => '/finance/coupon', 'action' => 'hidden'],
                        ['key' => 'referral', 'title' => '分销/佣金', 'path' => '/user/referral', 'action' => 'hidden'],
                        ['key' => 'theme', 'title' => '主题管理', 'path' => '/theme', 'action' => 'hidden'],
                        ['key' => 'mail', 'title' => '邮件模板', 'path' => '/mail/template', 'action' => 'hidden'],
                        ['key' => 'knowledge', 'title' => '知识库', 'path' => '/config/knowledge', 'action' => 'hidden'],
                        ['key' => 'gift-card', 'title' => '礼品卡', 'path' => '/finance/gift-card', 'action' => 'hidden'],
                    ],
                ],
            ],
            'rollback' => [
                'enabled' => true,
                'note' => '本策略只影响菜单呈现；未删除底层接口和历史数据。',
            ],
        ]);
    }

    public function page(Request $request)
    {
        $secure = trim((string) admin_setting('secure_path', admin_setting('frontend_admin_path', '')));
        $walletUrl = '';
        try {
            // 只读取已启用 Epay 的公开网关地址，不读取/输出 pid、key 或 Token。
            $payment = Payment::where('payment', 'Epay')->where('enable', true)->first();
            $config = $payment ? (is_array($payment->config) ? $payment->config : []) : [];
            $candidate = trim((string) ($config['url'] ?? ''));
            if (preg_match('/^https?:\/\/[^\s"\']+$/i', $candidate) === 1) {
                $walletUrl = rtrim($candidate, '/');
            }
        } catch (\Throwable $e) {
            // 钱包后台地址不是运营页可用性的前置条件，读取失败时保持空链接。
        }
        return response()->view('KcIntegration::ops', [
            'securePath' => trim($secure, '/'),
            'walletUrl' => $walletUrl,
        ]);
    }
}
