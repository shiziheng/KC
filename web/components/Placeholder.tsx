import Link from 'next/link';

export default function Placeholder({
  title,
  stage,
  points,
}: {
  title: string;
  stage: string;
  points: string[];
}) {
  return (
    <div className="kc-container py-10 md:py-16">
      <div className="kc-card mx-auto max-w-xl border-dashed p-8 text-center">
        <span className="kc-tag kc-tag-mute">{stage}</span>
        <h1 className="mt-3 text-h2 text-t1">{title}</h1>
        <p className="mt-2 text-body text-t2">此页面尚未实现，将在后续阶段完成。</p>

        <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left text-body text-t2">
          {points.map((p) => (
            <li key={p} className="flex gap-2">
              <span className="text-t3">○</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>

        <Link href="/" className="kc-btn kc-btn-ghost mt-6">
          返回首页
        </Link>
      </div>
    </div>
  );
}
