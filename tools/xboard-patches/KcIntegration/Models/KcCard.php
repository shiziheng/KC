<?php

namespace Plugin\KcIntegration\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * KC 发卡记录
 *
 * 每个 Xboard 订单（trade_no）对应一条记录，作为插件侧的幂等凭证与展示数据源。
 * 表由插件迁移创建，卸载插件时回滚。
 *
 * @property int    $id
 * @property string $trade_no
 * @property int    $plan_id
 * @property string $plan_type
 * @property string $user_ref
 * @property string $cdk_code
 * @property string $status
 * @property string $kc_status
 * @property ?int   $kc_progress  段C6：KC 侧任务进度 0-100
 * @property ?string $kc_message  段C6：KC 侧提示文案 / 失败原因
 * @property string $error_msg
 * @property int    $attempts
 */
class KcCard extends Model
{
    protected $table = 'v2_plugin_kc_cards';

    protected $guarded = ['id'];

    protected $casts = [
        'plan_id'      => 'integer',
        'attempts'     => 'integer',
        'kc_synced_at' => 'datetime',
        'kc_progress'  => 'integer',
    ];

    /** 已成功发放 */
    public const STATUS_ISSUED = 'issued';
    /** 发放失败（KC 不可达 / 拒绝 / 参数错误），可重试 */
    public const STATUS_FAILED = 'failed';
    /** 跳过（未开启发卡 / 未配置套餐映射），不应重试 */
    public const STATUS_SKIPPED = 'skipped';

    public static array $statusMap = [
        self::STATUS_ISSUED  => '已发放',
        self::STATUS_FAILED  => '发放失败',
        self::STATUS_SKIPPED => '已跳过',
    ];

    // ── 段C4：KC 侧开通状态（与上面的「发卡状态」是两回事）──

    /** 卡密已发放但尚未在 KC 侧发起开通 */
    public const KC_PENDING = 'pending';
    /** 正在 KC 侧开通中 */
    public const KC_RUNNING = 'running';
    /** KC 侧开通完成 */
    public const KC_COMPLETED = 'completed';
    /** KC 侧开通失败 */
    public const KC_FAILED = 'failed';

    // FEAT-018 S5：对外统一履约状态。旧 kc_status 字段继续保留兼容。
    public const STATE_PENDING = 'pending';
    public const STATE_VALIDATING = 'validating';
    public const STATE_RUNNING = 'running';
    public const STATE_COMPLETED = 'completed';
    public const STATE_FAILED = 'failed';
    public const STATE_COMPENSATING = 'compensating';
    public const STATE_MANUAL = 'manual';

    public static array $kcStatusMap = [
        self::KC_PENDING   => '待开通',
        self::KC_RUNNING   => '开通中',
        self::KC_COMPLETED => '已完成',
        self::KC_FAILED    => '开通失败',
    ];

    /**
     * KC `/api/cdk/query` 的中文三态 → 本插件内部状态码。
     *
     * KC 只返回「未使用 / 开通中 / 已使用」三种聚合结果，
     * 不暴露 progress / message（那需要段C5 的新接口）。
     */
    public static array $kcStatusFromApi = [
        '未使用' => self::KC_PENDING,
        '开通中' => self::KC_RUNNING,
        '已使用' => self::KC_COMPLETED,
    ];

    public function isIssued(): bool
    {
        return $this->status === self::STATUS_ISSUED && $this->cdk_code !== '';
    }

    /**
     * 是否处于终态（终态不再轮询）。
     */
    public function isKcTerminal(): bool
    {
        return in_array($this->kc_status, [self::KC_COMPLETED, self::KC_FAILED], true);
    }

    /**
     * 把发卡状态、KC 任务状态和补偿状态收敛成一个前台状态。
     */
    public function canonicalState(?string $compensationStatus = null): string
    {
        if ($compensationStatus !== null && $compensationStatus !== '') {
            if (in_array($compensationStatus, ['manual_pending', 'partial_refunded_manual_pending', 'manual_done', 'review_pending'], true)) {
                return self::STATE_MANUAL;
            }
            if (in_array($compensationStatus, ['processing', 'balance_refunded', 'failed'], true)) {
                return self::STATE_COMPENSATING;
            }
        }

        if ($this->status === self::STATUS_FAILED) {
            return self::STATE_FAILED;
        }
        if ($this->status === self::STATUS_SKIPPED) {
            return self::STATE_MANUAL;
        }
        if (!$this->isIssued()) {
            return self::STATE_PENDING;
        }

        return match ($this->kc_status) {
            self::KC_RUNNING => self::STATE_RUNNING,
            self::KC_COMPLETED => self::STATE_COMPLETED,
            self::KC_FAILED => self::STATE_FAILED,
            default => self::STATE_VALIDATING,
        };
    }

    public static function stateLabel(string $state): string
    {
        return [
            self::STATE_PENDING => '待处理',
            self::STATE_VALIDATING => '校验中',
            self::STATE_RUNNING => '开通中',
            self::STATE_COMPLETED => '开通完成',
            self::STATE_FAILED => '开通失败',
            self::STATE_COMPENSATING => '补偿处理中',
            self::STATE_MANUAL => '待人工处理',
        ][$state] ?? '处理中';
    }

    public static function stateIsTerminal(string $state): bool
    {
        return in_array($state, [
            self::STATE_COMPLETED,
            self::STATE_FAILED,
            self::STATE_COMPENSATING,
            self::STATE_MANUAL,
        ], true);
    }
}
