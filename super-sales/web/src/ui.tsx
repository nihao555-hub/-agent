import type { ReactNode } from "react";

type Tone = "red" | "blue" | "green" | "yellow" | "neutral";

const toneMap: Record<Tone, string> = {
  red: "bg-pale-red text-pale-red-ink",
  blue: "bg-pale-blue text-pale-blue-ink",
  green: "bg-pale-green text-pale-green-ink",
  yellow: "bg-pale-yellow text-pale-yellow-ink",
  neutral: "bg-bone text-muted",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em] ${toneMap[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  title,
  icon,
  meta,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <section
      className={`rounded-card border border-line bg-surface transition-shadow duration-200 hover:shadow-lift ${className}`}
    >
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            {icon && <span className="text-charcoal">{icon}</span>}
            <h3 className="font-serif text-[17px] tracking-[-0.01em] text-ink">{title}</h3>
          </div>
          {meta && <div className="flex items-center gap-2">{meta}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Cite({ ids }: { ids?: string[] }) {
  if (!ids || ids.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted">依据</span>
      {ids.map((id) => (
        <span
          key={id}
          className="rounded border border-line bg-bone px-1.5 py-0.5 font-mono text-[10px] text-muted"
        >
          {id}
        </span>
      ))}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-line bg-bone/60 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.05em] text-muted">{label}</div>
      <div className={`mt-1 font-serif text-[22px] leading-none ${tone === "red" ? "text-pale-red-ink" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}
