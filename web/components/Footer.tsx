import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="mt-16 border-t border-line bg-card">
      <div className="kc-container flex flex-col gap-6 py-8 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-[11px] font-semibold text-white">
              KC
            </span>
            <span className="text-h3 text-t1">KC 加速</span>
          </div>
          <p className="mt-2 max-w-md text-aux text-t3">
            官方渠道代充，3 分钟自动到账。支持 USDT 与账户余额支付，开通失败全额退款。
          </p>
        </div>

        <div className="flex gap-12">
          <div>
            <div className="mb-2 text-aux font-medium text-t1">服务</div>
            <ul className="space-y-1.5 text-aux text-t3">
              <li><Link href="/plan" className="hover:text-brand">商品</Link></li>
              <li><Link href="/order" className="hover:text-brand">我的订单</Link></li>
              <li><Link href="/topup" className="hover:text-brand">余额充值</Link></li>
              <li><Link href="/redeem" className="hover:text-brand">兑换卡密</Link></li>
              <li><Link href="/referral" className="hover:text-brand">邀请返利</Link></li>
            </ul>
          </div>
          <div>
            <div className="mb-2 text-aux font-medium text-t1">帮助</div>
            <ul className="space-y-1.5 text-aux text-t3">
              <li><Link href="/help" className="hover:text-brand">常见问题</Link></li>
              <li><Link href="/help#support" className="hover:text-brand">联系客服</Link></li>
            </ul>
          </div>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="kc-container flex flex-col gap-1 py-4 text-aux text-t3 md:flex-row md:items-center md:justify-between">
          <span>虚拟商品，一经开通不支持退款，请确认后购买。</span>
          <span>© {new Date().getFullYear()} KC 加速</span>
        </div>
      </div>
    </footer>
  );
}
