<?php

use Illuminate\Support\Facades\Route;
use Plugin\KcIntegration\Controllers\AdminMenuController;

// 编译版 Xboard 管理端无法在仓库内改写原生菜单，提供同源运营壳作为统一入口。
Route::get('/plugins/kc_integration/ops', [AdminMenuController::class, 'page'])
    ->middleware(['admin']);
