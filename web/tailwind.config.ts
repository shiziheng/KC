import type { Config } from 'tailwindcss';

/**
 * 设计基线（第 0 段定稿）
 *
 * 取值沿用现有前台的 teal 体系，保证换前台后视觉上仍是"同一个站点"。
 * 后续所有页面只用这里的 token，不写裸色值 —— 这样改配色只改一处。
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#0d9488',   // 主品牌色（按钮/链接/强调）
          hover: '#0f766e',     // 悬停
          deep: '#085041',      // 深色块（页脚/深色标题条）
          soft: 'rgba(13,148,136,.10)',  // 浅底（选中态/标签底）
        },
        page: '#f6f8fa',        // 页面底色
        card: '#ffffff',        // 卡片/面板底色
        line: {
          DEFAULT: '#e8edf2',   // 常规描边
          strong: '#d5dde5',    // 强调描边
        },
        t1: '#0f172a',          // 一级文字（标题）
        t2: '#475569',          // 二级文字（正文）
        t3: '#94a3b8',          // 三级文字（辅助说明）
        ok: '#16a34a',          // 成功/已完成
        warn: '#BA7517',        // 待处理/提醒
        err: '#ef4444',         // 失败/危险
      },
      fontSize: {
        h1: ['28px', { lineHeight: '1.3', fontWeight: '600' }],
        h2: ['20px', { lineHeight: '1.4', fontWeight: '600' }],
        h3: ['16px', { lineHeight: '1.5', fontWeight: '600' }],
        body: ['14px', { lineHeight: '1.7' }],
        aux: ['12.5px', { lineHeight: '1.6' }],
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      maxWidth: {
        page: '1200px',        // 内容区最大宽度
      },
      spacing: {
        nav: '56px',           // 顶栏高度
      },
    },
  },
  plugins: [],
};

export default config;
