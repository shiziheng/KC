import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import Topbar from '@/components/Topbar';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: 'KC 加速 · ChatGPT Plus 官方直充',
  description: '官方渠道代充，3 分钟自动到账。支持 USDT 与账户余额支付，失败全额退款。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d9488',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col">
        <AuthProvider>
          <Topbar />
          <main className="flex-1 pt-nav">{children}</main>
          <Footer />
        </AuthProvider>
      </body>
    </html>
  );
}
