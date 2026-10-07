<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Plugin\KcIntegration\Services\RiskService;

/** FEAT-018 S7：管理员只读风险事件、配置阈值和解除临时拦截。 */
class RiskController extends PluginController
{
    public function index(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $service = new RiskService();
        return $this->success([
            'rules' => $service->rules(),
            'events' => $service->listEvents([
                'endpoint' => $request->input('endpoint'), 'scope_type' => $request->input('scope_type'),
                'scope_hash' => $request->input('scope_hash'), 'action' => $request->input('action'),
                'event_type' => $request->input('event_type'), 'user_id' => $request->input('user_id'),
            ], (int) $request->input('limit', 100)),
        ]);
    }

    public function updateRules(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $rules = $request->input('rules', []);
        if (!is_array($rules)) return $this->fail([422, '风险规则格式不正确']);
        return $this->success(['rules' => (new RiskService())->updateRules($rules)]);
    }

    public function release(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $request->validate([
            'scope_type' => 'required|string|in:ip,user,cdk,account',
            'scope_hash' => ['required', 'string', 'size:64', 'regex:/^[a-f0-9]{64}$/i'],
            'endpoint' => 'nullable|string|in:redeem,topup',
            'note' => 'nullable|string|max:200',
        ]);
        $admin = $request->user();
        $operator = (string) ($admin?->email ?: ('admin:' . (int) ($admin?->id ?? 0)));
        $released = (new RiskService())->release(
            (string) $request->input('scope_type'), (string) $request->input('scope_hash'), $operator,
            $request->input('endpoint') ? (string) $request->input('endpoint') : null, (string) $request->input('note', '')
        );
        return $this->success(['released' => $released]);
    }
}


