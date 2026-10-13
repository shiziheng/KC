<?php

namespace Plugin\Epay;

use App\Services\Plugin\AbstractPlugin;
use App\Contracts\PaymentInterface;
use Illuminate\Support\Facades\DB;

class Plugin extends AbstractPlugin implements PaymentInterface
{
    public function boot(): void
    {
        $this->filter('available_payment_methods', function ($methods) {
            if ($this->getConfig('enabled', true)) {
                $methods['EPay'] = [
                    'name' => $this->getConfig('display_name', '易支付'),
                    'icon' => $this->getConfig('icon', '💳'),
                    'plugin_code' => $this->getPluginCode(),
                    'type' => 'plugin'
                ];
            }
            return $methods;
        });
    }

    public function form(): array
    {
        return [
            'url' => [
                'label' => '支付网关地址',
                'type' => 'string',
                'required' => true,
                'description' => '请填写完整的支付网关地址，包括协议（http或https）'
            ],
            'pid' => [
                'label' => '商户ID',
                'type' => 'string',
                'description' => '请填写商户ID',
                'required' => true
            ],
            'key' => [
                'label' => '通信密钥',
                'type' => 'string',
                'required' => true,
                'description' => '请填写通信密钥'
            ],
            'type' => [
                'label' => '支付类型',
                'type' => 'string',
                'description' => '支付类型，如: alipay, wxpay, qqpay 等，可自定义'
            ],
            'chain' => [
                'label' => 'USDT 网络',
                'type' => 'string',
                'default' => 'TRC20',
                'description' => '仅用于订单台账和人工核验展示，必须与 BEpusdt 收款网络一致'
            ],
            'wallet_address' => [
                'label' => '收款钱包地址',
                'type' => 'string',
                'description' => '可选。用于订单台账核验；真实钱包仍由 BEpusdt 配置，禁止填写私钥'
            ],
            'usdt_amount_suffix' => [
                'label' => 'USDT 启用订单金额尾数识别',
                'type' => 'boolean',
                'default' => true,
                'description' => '仅对 KC 余额充值订单生效；尾数只用于识别，不计入平台余额'
            ],
        ];
    }

    public function pay($order): array
    {
        $baseCents = (int) ($order['total_amount'] ?? 0);
        $isTopup = false;
        $paymentReference = (string) ($order['trade_no'] ?? '');
        $expectedCents = $baseCents;
        $chain = strtoupper(trim((string) $this->getConfig('chain', 'TRC20'))) ?: 'TRC20';
        $walletAddress = trim((string) $this->getConfig('wallet_address', ''));

        // Epay 是通用支付插件，KC 字段不存在时必须继续按原逻辑工作。
        try {
            $isTopup = (int) DB::table('v2_plan')->where('id', (int) ($order['plan_id'] ?? 0))->value('kc_is_topup') === 1;
        } catch (\Throwable $e) {
            $isTopup = false;
        }
        $suffixEnabled = filter_var($this->getConfig('usdt_amount_suffix', true), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($isTopup) {
            if ($suffixEnabled === null ? true : $suffixEnabled) {
                $hash = hash('sha256', (string) ($order['trade_no'] ?? ''));
                $suffix = (hexdec(substr($hash, 0, 4)) % 90) + 10;
                $expectedCents = $baseCents + $suffix;
                $paymentReference = 'KC' . strtoupper(substr($hash, 0, 12));
            }
            try {
                DB::statement(
                    'INSERT IGNORE INTO `v2_plugin_kc_topups`
                     (`trade_no`, `user_id`, `amount`, `balance_before`, `balance_after`, `status`, `error_msg`, `attempts`, `expires_at`, `payment_method`, `payment_reference`, `expected_amount`, `received_amount`, `chain`, `match_status`, `payment_source`, `created_at`, `updated_at`)
                     VALUES (?, ?, ?, 0, 0, \'pending\', \'\', 0, ?, \'usdt\', ?, ?, 0, ?, \'pending\', \'checkout\', ?, ?)',
                    [(string) ($order['trade_no'] ?? ''), (int) ($order['user_id'] ?? 0), $baseCents, time() + 1800, $paymentReference, $expectedCents, $chain, now(), now()]
                );
                if ($walletAddress !== '') {
                    DB::table('v2_plugin_kc_topups')->where('trade_no', (string) ($order['trade_no'] ?? ''))->update(['wallet_address' => substr($walletAddress, 0, 128)]);
                }
            } catch (\Throwable $e) {
                // 迁移尚未执行时不能阻断通用支付；回调侧仍会补建台账。
            }
        }

        $params = [
            'money' => number_format($expectedCents / 100, 2, '.', ''),
            // KC-PATCH(2026-10-13, v1.25.1)：平台金额口径为美元。BEpusdt 易支付兼容接口
            // 不传 fiat 时默认按 CNY 解读 money（$15 会被当成 15 元人民币 ÷6.69 ≈ 2.24 USDT，
            // 造成少收款）。显式声明 fiat=USD，让收银台按美元 1:1 折算 USDT。
            // fiat 参与双方签名：插件侧 http_build_query(ksort) 与 BEpusdt 侧
            // 「非空参数字典序 k=v& + api_auth_token」算法一致，无需额外处理。
            'fiat' => 'USD',
            'name' => $paymentReference,
            'notify_url' => $order['notify_url'],
            'return_url' => $order['return_url'],
            'out_trade_no' => $order['trade_no'],
            'pid' => $this->getConfig('pid')
        ];

        if ($paymentType = $this->getConfig('type')) {
            $params['type'] = $paymentType;
        }

        ksort($params);
        $str = stripslashes(urldecode(http_build_query($params))) . $this->getConfig('key');
        $params['sign'] = md5($str);
        $params['sign_type'] = 'MD5';

        return [
            'type' => 1,
            'data' => $this->getConfig('url') . '/submit.php?' . http_build_query($params)
        ];
    }

    public function notify($params): array|bool
    {
        $sign = $params['sign'];
        unset($params['sign'], $params['sign_type']);
        ksort($params);
        $str = stripslashes(urldecode(http_build_query($params))) . $this->getConfig('key');

        if ($sign !== md5($str)) {
            return false;
        }

        return [
            'trade_no' => $params['out_trade_no'],
            'callback_no' => $params['trade_no']
        ];
    }
}
