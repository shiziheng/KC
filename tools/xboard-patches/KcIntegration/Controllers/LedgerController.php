<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Plugin\KcIntegration\Services\LedgerService;

/** S6：用户只读账务流水与管理员对账查询。 */
class LedgerController extends PluginController
{
    public function mine(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        $userId = (int) $request->user()->id;
        $service = new LedgerService();

        return $this->success([
            'entries' => $service->listForUser($userId, (int) $request->input('limit', 50)),
            'reconciliation' => $service->reconcileUser($userId),
        ]);
    }

    public function adminList(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        $userId = $request->filled('user_id') ? (int) $request->input('user_id') : null;
        $service = new LedgerService();
        return $this->success([
            'entries' => $service->listForAdmin(
                $userId,
                $request->input('trade_no') !== null ? (string) $request->input('trade_no') : null,
                $request->input('type') !== null ? (string) $request->input('type') : null,
                (int) $request->input('limit', 100)
            ),
        ]);
    }

    public function reconcile(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        $userId = (int) $request->input('user_id');
        if ($userId <= 0) return $this->fail([422, 'user_id 参数不正确']);
        return $this->success((new LedgerService())->reconcileUser($userId));
    }
}
