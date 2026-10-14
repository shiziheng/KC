<?php
/**
 * tools/xboard-patch-allow-concurrent-orders.php
 * ===================================================================
 * 允许同一用户同时存在多笔「待支付 / 处理中」订单（去掉「有未付款订单不能再下单」限制）
 *
 * 背景（2026-10-13 产品决策）：
 *   UserService::isNotCompleteOrderByUserId() 会查 status in (0,1) 的订单，
 *   只要存在就抛「您有未付款或开通中的订单，请稍后再试或将其取消」，**禁止用户再下单**。
 *   该规则不合理且内部不自洽：
 *     1. 插件侧充值（TopupController）早已把同款限制移除（见其文件头注释），
 *        「充值可以并发、下单却不行」口径不一；
 *     2. 套餐为虚拟商品、不占库存（capacity_limit=NULL），不存在防超发价值；
 *     3. 待支付订单 30 分钟后自动失效（ORDER_TTL_SECONDS），本身有回收机制；
 *     4. 用户换套餐买、或上一单支付失败想重开，都被这规则挡住 —— 直接损失订单。
 *
 * 改动范围（只放用户侧下单，共 2 处）：
 *   - app/Services/OrderService.php               （下单服务）
 *   - app/Http/Controllers/V1/User/OrderController.php （V1 用户下单接口）
 * 不改（有意保留）：
 *   - app/Http/Controllers/V2/Admin/OrderController.php —— 管理员后台「替用户分配订阅」，
 *     那里的提示是「该用户还有待支付的订单，无法分配」，属运营风控，口径不同，保持原样。
 *
 * 幂等：重复执行只输出 SKIP/APPLIED，不会重复改动。
 * 用法：docker cp 进容器后 php /www/xboard-patch-allow-concurrent-orders.php
 * ===================================================================
 */
$MARK = 'KC-PATCH:ALLOW-CONCURRENT-ORDERS';

$NOTE = <<<'NOTE'
        // KC-PATCH:ALLOW-CONCURRENT-ORDERS —— 允许同时存在多笔未支付/处理中订单（2026-10-13 产品决策）
        // 原规则：只要存在 status in (0,1) 的订单就禁止再下单（提示「您有未付款或开通中的订单」）。
        //        该规则与插件侧充值已移除的同类限制口径不一致；套餐不占库存、无防超发价值，
        //        且待支付订单 30 分钟自动失效，保留它只会挡住正常复购与支付失败后的重开。
        //        仅放开【用户侧下单】；管理员分配侧（V2/Admin/OrderController）保持原样。
NOTE;

$targets = [
    '/www/app/Services/OrderService.php',
    '/www/app/Http/Controllers/V1/User/OrderController.php',
];

$from = 'if ($userService->isNotCompleteOrderByUserId(';
$to   = 'if (false && $userService->isNotCompleteOrderByUserId(';

$exit = 0;
foreach ($targets as $file) {
    echo "--- $file\n";
    if (!file_exists($file)) {
        echo "    [MISS] 文件不存在\n";
        $exit = 1;
        continue;
    }
    $s = file_get_contents($file);
    if ($s === false) {
        echo "    [FAIL] 读不到文件\n";
        $exit = 1;
        continue;
    }
    if (strpos($s, $MARK) !== false) {
        $n = substr_count($s, 'false && $userService->isNotCompleteOrderByUserId(');
        echo "    [SKIP] 补丁已到位（短路点 $n 处）\n";
        continue;
    }
    $count = substr_count($s, $from);
    if ($count === 0) {
        echo "    [MISS] 未找到原始判断，可能版本已变 —— 未改动\n";
        $exit = 1;
        continue;
    }

    // 在第一个命中处插入说明注释，然后统一短路该判断（保留原表达式便于回溯）
    $pos = strpos($s, $from);
    $s = substr($s, 0, $pos) . $NOTE . "\n" . substr($s, $pos);
    $s = str_replace($from, $to, $s);

    if (file_put_contents($file, $s) === false) {
        echo "    [FAIL] 写文件失败\n";
        $exit = 1;
        continue;
    }
    echo "    [APPLIED] 短路 $count 处判断，并插入说明注释\n";
}
echo $exit === 0 ? "DONE OK\n" : "DONE WITH ERROR\n";
exit($exit);
