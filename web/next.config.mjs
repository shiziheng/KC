import path from 'node:path';

/** @type {import('next').NextConfig} */
const XBOARD_ORIGIN = process.env.XBOARD_ORIGIN || 'http://localhost:7001';
const KC_API_ORIGIN = process.env.KC_API_ORIGIN || 'http://localhost:3100';

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR || '.next',
  webpack(config) {
    config.resolve.alias['@'] = path.resolve(process.cwd());
    return config;
  },

  // 前台自己代理后端接口 —— 浏览器只跟前台说话，因此：
  //   1) 不存在跨域问题
  //   2) Xboard 完全不需要改造（CORS / 回调地址都不用动）
  //   3) 将来若要换后端，只改这里
  async rewrites() {
    return [
      // 代充 Mock 业务 API：由 KC 服务校验 Xboard 用户身份并隔离业务数据
      { source: '/api/storefront/:path*', destination: `${KC_API_ORIGIN}/api/public/business/:path*` },
      // ① Xboard 标准接口：/api/xb/v1/user/info → {origin}/api/v1/user/info
      { source: '/api/xb/:path*', destination: `${XBOARD_ORIGIN}/api/:path*` },
      // ② 插件路由（无 /api 前缀）：/api/pg/plan/kc-cards → {origin}/plan/kc-cards
      { source: '/api/pg/:path*', destination: `${XBOARD_ORIGIN}/:path*` },
    ];
  },
};

export default nextConfig;
