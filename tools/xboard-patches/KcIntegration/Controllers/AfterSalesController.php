<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Order;
use Illuminate\Http\Request;
use Plugin\KcIntegration\Services\AfterSalesService;

/** S9 用户与管理员售后申请接口。 */
class AfterSalesController extends PluginController
{
    public function mine(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        return $this->success([
            'requests' => (new AfterSalesService())->listForUser((int) $request->user()->id, (int) $request->input('limit', 50)),
        ]);
    }

    public function create(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $request->validate([
            'trade_no' => 'required|string|max:36',
            'request_type' => 'required|string|in:failed,timeout,refund,other',
            'message' => 'required|string|max:1000',
        ]);
        $userId = (int) $request->user()->id;
        $order = Order::where('trade_no', trim((string) $request->input('trade_no')))
            ->where('user_id', $userId)->first();
        if (!$order) return $this->fail([404, '订单不存在或无权访问']);
        $result = (new AfterSalesService())->createForUser(
            $order,
            $userId,
            (string) $request->input('request_type'),
            (string) $request->input('message')
        );
        if (!$result['ok']) return $this->fail([409, $result['error']]);
        return $this->success(['request' => $result['request']?->toPublicPayload(), 'idempotent' => false]);
    }

    public function detail(Request $request, string $requestNo)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $service = new AfterSalesService();
        $row = $service->findByUser($requestNo, (int) $request->user()->id);
        if (!$row) return $this->fail([404, '售后申请不存在或无权访问']);
        return $this->success(['request' => $service->publicDetail($row)]);
    }

    public function message(Request $request, string $requestNo)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $request->validate(['message' => 'required|string|max:1000']);
        $result = (new AfterSalesService())->addUserMessage(
            $requestNo,
            (int) $request->user()->id,
            (string) $request->input('message')
        );
        if (!$result['ok']) return $this->fail([409, $result['error']]);
        return $this->success(['request' => (new AfterSalesService())->publicDetail($result['request'])]);
    }

    public function cancel(Request $request, string $requestNo)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $result = (new AfterSalesService())->cancelForUser($requestNo, (int) $request->user()->id);
        if (!$result['ok']) return $this->fail([409, $result['error']]);
        return $this->success(['request' => $result['request']?->toPublicPayload()]);
    }

    public function adminList(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        return $this->success([
            'requests' => (new AfterSalesService())->listForAdmin(
                trim((string) $request->input('status', '')) ?: null,
                trim((string) $request->input('request_type', '')) ?: null,
                (int) $request->input('limit', 100)
            ),
        ]);
    }

    public function adminDetail(Request $request, string $requestNo)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $service = new AfterSalesService();
        $row = $service->find($requestNo);
        if (!$row) return $this->fail([404, '售后申请不存在']);
        return $this->success(['request' => $service->adminDetail($row)]);
    }

    public function process(Request $request, string $requestNo)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $request->validate([
            'action' => 'required|string|in:review,approve,reject,resolve',
            'note' => 'nullable|string|max:500',
            'refund' => 'nullable|boolean',
        ]);
        $admin = $request->user();
        $operator = (string) ($admin?->email ?: ('admin:' . (int) ($admin?->id ?? 0)));
        $result = (new AfterSalesService())->process(
            $requestNo,
            (string) $request->input('action'),
            $operator,
            (string) $request->input('note', ''),
            $request->boolean('refund')
        );
        if (!$result['ok']) return $this->fail([409, $result['error']]);
        return $this->success([
            'request' => (new AfterSalesService())->adminDetail($result['request']),
            'compensation' => $result['compensation']?->toPublicPayload(),
        ]);
    }
}
