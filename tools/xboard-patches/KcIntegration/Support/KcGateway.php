<?php

namespace Plugin\KcIntegration\Support;

use Illuminate\Support\Facades\Http;

/**
 * KC HTTP 网关（FEAT-004 · D1）
 *
 * 把「调 KC + 解析 KC 信封」收敛到一处，避免各控制器各写一份。
 *
 * KC 协议要点（实测，勿凭直觉改写）：
 *   - 业务信封是 {success:bool, message:string, data:any}；
 *     成功判定看 **success === true**，不是 code === 0（那是 ZovoCard 的协议，别混）。
 *   - 建单（/api/run-process）可能返回 HTTP 202，**202 ≠ 失败**，真正结果靠轮询。
 *   - 失败时错误文案在 message。
 */
class KcGateway
{
    protected string $baseUrl;
    protected int $timeout;
    protected int $connectTimeout;

    public function __construct(string $baseUrl, int $timeout = 8, int $connectTimeout = 3)
    {
        $this->baseUrl        = rtrim($baseUrl, '/');
        $this->timeout        = $timeout;
        $this->connectTimeout = $connectTimeout;
    }

    public function isConfigured(): bool
    {
        return $this->baseUrl !== '';
    }

    /**
     * POST 到 KC。
     *
     * @return array{ok: bool, status: int, data: array, error: string}
     */
    public function post(string $path, array $payload, array $headers = []): array
    {
        if (!$this->isConfigured()) {
            return ['ok' => false, 'status' => 0, 'data' => [], 'error' => 'KC 地址未配置'];
        }

        try {
            $response = Http::withHeaders(array_merge(['Accept' => 'application/json'], $headers))
                ->timeout($this->timeout)
                ->connectTimeout($this->connectTimeout)
                ->asJson()
                ->post($this->baseUrl . $path, $payload);
        } catch (\Throwable $e) {
            return ['ok' => false, 'status' => 0, 'data' => [], 'error' => '无法连接 KC 服务，请稍后重试'];
        }

        return $this->parse($response);
    }

    /**
     * GET 到 KC。
     *
     * @return array{ok: bool, status: int, data: array, error: string}
     */
    public function get(string $path, array $query = [], array $headers = []): array
    {
        if (!$this->isConfigured()) {
            return ['ok' => false, 'status' => 0, 'data' => [], 'error' => 'KC 地址未配置'];
        }

        try {
            $response = Http::withHeaders(array_merge(['Accept' => 'application/json'], $headers))
                ->timeout($this->timeout)
                ->connectTimeout($this->connectTimeout)
                ->get($this->baseUrl . $path, $query);
        } catch (\Throwable $e) {
            return ['ok' => false, 'status' => 0, 'data' => [], 'error' => '无法连接 KC 服务，请稍后重试'];
        }

        return $this->parse($response);
    }

    /**
     * 解析 KC 响应。
     *
     * 关键：2xx **不等于**业务成功。KC 用 HTTP 403 表达「CDK 已使用/无效」这类业务失败，
     * 所以必须同时看 HTTP 状态与 success 字段。
     *
     * @return array{ok: bool, status: int, data: array, error: string}
     */
    protected function parse($response): array
    {
        $status = $response->status();

        // 2xx 之外一律当失败；202 由调用方按成功处理（见 post 的注释）
        if ($status >= 400) {
            $json = null;
            try {
                $json = $response->json();
            } catch (\Throwable $ignored) {
            }

            $msg = is_array($json) ? (string) ($json['message'] ?? '') : '';

            $data = is_array($json['data'] ?? null) ? $json['data'] : [];
            return [
                'ok'     => false,
                'status' => $status,
                // 保留 KC 的状态码/下一步动作，供前台显示“已过期/已冻结”等明确结果。
                'data'   => $data,
                'error'  => $msg !== '' ? $msg : (string) ($data['message'] ?? ('KC 返回 HTTP ' . $status)),
            ];
        }

        $json = $response->json();
        if (!is_array($json)) {
            return ['ok' => false, 'status' => $status, 'data' => [], 'error' => 'KC 返回内容异常'];
        }

        if (($json['success'] ?? false) !== true) {
            $msg = (string) ($json['message'] ?? '操作失败');
            return ['ok' => false, 'status' => $status, 'data' => [], 'error' => $msg];
        }

        $data = $json['data'] ?? [];
        if (!is_array($data)) {
            $data = [];
        }

        return ['ok' => true, 'status' => $status, 'data' => $data, 'error' => ''];
    }
}
