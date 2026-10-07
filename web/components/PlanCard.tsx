'use client';

import Link from 'next/link';
import type { PlanView } from '@/lib/types';

export default function PlanCard({
  view,
  onOpen,
}: {
  view: PlanView;
  onOpen: (v: PlanView) => void;
}) {
  const { state, badge, title, subtitle, priceNum, priceUnit, priceTag, features, guarantees, buttonText, tip, rules } = view;

  const soon = state === 'soon';
  const soldout = state === 'soldout';
  const manual = state === 'manual';
  const disabled = soon || soldout || manual;

  const badgeClass =
    state === 'soon'
      ? 'bg-warn/10 text-warn'
      : state === 'soldout'
        ? 'bg-t3/10 text-t3'
        : state === 'manual'
          ? 'bg-warn/10 text-warn'
        : 'bg-brand-soft text-brand';

  const badgeText = badge || (soon ? '敬请期待' : soldout ? '暂不可售' : manual ? '人工办理' : '');

  return (
    <div className="kc-card flex flex-col p-5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-h3 text-t1">{title}</h3>
        {badgeText && <span className={'kc-tag ' + badgeClass}>{badgeText}</span>}
      </div>

      {subtitle && <p className="mt-1.5 text-aux text-t3">{subtitle}</p>}

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-h1 text-brand">{priceNum}</span>
        {priceUnit && <span className="text-aux text-t3">{priceUnit}</span>}
        {priceTag && <span className="kc-tag ml-1 bg-brand-soft text-brand">{priceTag}</span>}
      </div>

      {features.length > 0 && (
        <ul className="mt-4 flex-1 space-y-1.5 text-aux text-t2">
          {features.map((f) => (
            <li key={f} className="flex gap-1.5">
              <span className="text-brand">·</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}

      {guarantees.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {guarantees.map((g) => (
            <span key={g} className="kc-tag kc-tag-mute">
              {g}
            </span>
          ))}
        </div>
      )}

      {tip && <p className="mt-3 text-aux text-t3">{tip}</p>}

      <div className="mt-4 rounded-md bg-page px-3 py-2.5 text-aux text-t2">
        <div><span className="text-t3">适用账号：</span>{rules.account}</div>
        <div className="mt-1"><span className="text-t3">预计处理：</span>{rules.fulfillment}</div>
        {rules.restrictions.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-t3">
            {rules.restrictions.map((rule) => <li key={rule}>· {rule}</li>)}
          </ul>
        )}
        <div className="mt-1"><span className="text-t3">失败处理：</span>{rules.failure}</div>
      </div>

      {manual ? (
        <Link href="/help#purchase" className="kc-btn kc-btn-ghost mt-5 w-full text-center">
          查看办理规则 →
        </Link>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && onOpen(view)}
          className={'kc-btn mt-5 w-full ' + (disabled ? 'kc-btn-ghost' : 'kc-btn-primary')}
        >
          {disabled ? (soldout ? '暂不可售' : '敬请期待') : buttonText + ' →'}
        </button>
      )}
      {view.sellabilityReason && state !== 'onsale' && (
        <p className="mt-2 text-center text-aux text-t3">{view.sellabilityReason}</p>
      )}
    </div>
  );
}
