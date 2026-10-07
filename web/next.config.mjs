/** @type {import('next').NextConfig} */
const XBOARD_ORIGIN = process.env.XBOARD_ORIGIN || 'http://localhost:7001';

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  // 前台自己代理后端接口 —— 浏览器只跟前台说话，因此：
  //   1) 不存在跨域问题
  //   2) Xboard 完全不需要改造（CORS / 回调地址都不用动）
  //   3) 将来若要换后端，只改这里
  async rewrites() {
    return [
      // ① Xboard 标准接口：/api/xb/v1/user/info → {origin}/api/v1/user/info
      { source: '/api/xb/:path*', destination: `${XBOARD_ORIGIN}/api/:path*` },
      // ② 插件路由（无 /api 前缀）：/api/pg/plan/kc-cards → {origin}/plan/kc-cards
      { source: '/api/pg/:path*', destination: `${XBOARD_ORIGIN}/:path*` },
    ];
  },
};

export default nextConfig;
