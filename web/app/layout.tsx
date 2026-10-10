import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import Topbar from '@/components/Topbar';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: 'KC 代充业务 · Mock 流程演示',
  description: '浏览代充商品并体验模拟订单流程；当前不收款、不扣款、不进行真实代充。',
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
