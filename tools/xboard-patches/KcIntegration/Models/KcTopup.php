<?php

namespace Plugin\KcIntegration\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * 充值流水（FEAT-004 · D2）
 *
 * trade_no 上有 UNIQUE 约束，是幂等的**唯一依据**。
 * 处理逻辑必须"先占位、再执行"，不能"先查再写"——后者在并发下会重复加钱。
 *
 * @property int    $id
 * @property string $trade_no
 * @property int    $user_id
 * @property int    $amount
 * @property int    $balance_before
 * @property int    $balance_after
 * @property string $status
 * @property string $error_msg
 * @property int    $attempts
 */
class KcTopup extends Model
{
    protected $table = 'v2_plugin_kc_topups';

    /** pending=已占位待处理 / done=已到账 / failed=处理失败 */
    public const STATUS_PENDING = 'pending';
    public const STATUS_DONE    = 'done';
    public const STATUS_FAILED  = 'failed';

    protected $guarded = ['id'];

    protected $casts = [
        'user_id'        => 'integer',
        'amount'         => 'integer',
        'balance_before' => 'integer',
        'balance_after'  => 'integer',
        'attempts'       => 'integer',
    ];
}
