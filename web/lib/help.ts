export type HelpSection = {
  id: string;
  title: string;
  summary: string;
  steps?: string[];
  notes?: string[];
};

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'start',
    title: 'Mock 业务演示',
    summary: '当前网站用于验证代充商品、订单、售后和凭证流程，不提供真实支付或真实代充。',
    steps: ['浏览运营后台上架的商品。', '登录后创建一笔模拟订单。', '在“我的订单”中手动推进模拟支付和履约状态，并查看模拟交易凭证。'],
    notes: ['模拟支付不会扣款，模拟履约不会调用 ZovoCard 或其他供应商。', '任何 Mock 状态均不代表现实中已付款或已开通。'],
  },
  {
    id: 'credentials',
    title: '账号凭据与隐私',
    summary: '本阶段不需要 ChatGPT Session、Token、Cookie、密码、卡号或 CVC。',
    steps: ['请勿在任何页面、订单留言或客服沟通中粘贴上述凭据。', '订单仅关联已登录的商城用户，并在独立业务库保存脱敏邮箱和不可逆指纹。'],
    notes: ['用户登录令牌只用于向 Xboard 核验当前登录身份，不会写入业务数据库或操作审计。'],
  },
  {
    id: 'purchase',
    title: '商品与模拟下单',
    summary: '商品价格由运营人员在独立业务后台配置，用户只能看到在售商品的必要信息。',
    steps: ['在商品页选择当前在售的代充商品。', '确认后会生成一笔“待模拟支付”订单。', '点击“模拟支付”只改变 Mock 状态；随后可单独推进模拟履约。'],
    notes: ['真实 USDT 收款、账户余额扣款、链上扫描和供应商履约均未开放。'],
  },
  {
    id: 'payment',
    title: '支付与履约状态',
    summary: '支付状态和履约状态彼此独立。Mock 订单不会产生任何资金变动。',
    steps: ['待模拟支付：订单已创建，尚未模拟确认。', '模拟已支付：只表示用户点过模拟按钮，不是支付成功凭证。', '模拟完成：只表示演示流程结束，不代表 ChatGPT 账号权益已开通。'],
    notes: ['不要向任何个人钱包或地址转账；网站当前未提供真实收款地址。'],
  },
  {
    id: 'after-sales',
    title: '售后与留言',
    summary: '你可以从模拟订单提交售后留言，运营人员会在业务后台查看申请并推进处理状态。',
    steps: ['打开“我的订单”，找到相应订单并点击“申请售后 / 留言”。', '描述订单问题和现象，不要重复提交同一问题。', '运营后台可记录受理、同意、拒绝或结案决定；同意不等于已退款。'],
    notes: ['当前没有实时在线客服；不会自动执行真实退款或余额补偿。'],
  },
  {
    id: 'security',
    title: '安全说明',
    summary: '所有业务订单与 Xboard、KC 旧订单保持隔离；Mock 页面不会调用真实履约接口。',
    steps: ['用户请求通过现有商城登录态校验归属。', '运营只能查看脱敏账号信息。', '凭证显示模拟订单状态，不是发票、收款凭据或开通证明。'],
    notes: ['如果发现订单留言误含凭据，请停止重复提交并联系运营处理。'],
  },
];

export const HELP_QUICK_LINKS = [
  { id: 'start', label: 'Mock 演示' },
  { id: 'purchase', label: '商品与下单' },
  { id: 'payment', label: '状态说明' },
  { id: 'after-sales', label: '售后留言' },
  { id: 'security', label: '安全说明' },
];
