<?php

use Illuminate\Support\Facades\Route;
use Plugin\KcIntegration\Controllers\AdminMenuController;
use Plugin\KcIntegration\Controllers\SupportController;

// 编译版 Xboard 管理端无法在仓库内改写原生菜单，提供同源运营壳作为统一入口。
//
// 鉴权模型（2026-10-11 修订）：页面壳**公开**（不含任何业务数据），壳内 JS 从同源
// 管理端 localStorage（VUE_NAIVE_ACCESS_TOKEN）读取管理员令牌，附加到数据请求头；
// 真正的数据接口在 routes/api.php 的 admin/kc/*，仍由 ['user','admin'] 中间件保护。
// （此前页面本身挂 admin 中间件，浏览器直开无 Authorization 头 → 403，无法使用。）
Route::get('/plugins/kc_integration/ops', [AdminMenuController::class, 'page']);

// 客服工作台（SP-2026-10-11 · P1）：查询用户余额 / 订单进度 / 充值到账 / 卡密状态 + 话术卡。
Route::get('/plugins/kc_integration/support', [SupportController::class, 'page']);
