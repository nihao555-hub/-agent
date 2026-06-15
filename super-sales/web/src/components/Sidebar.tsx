import type { Health } from "../types";
import { IconBook, IconBrain, IconChat, IconSpark } from "../icons";

export type View = "console" | "workbench" | "knowledge" | "about";

const NAV: { key: View; label: string; icon: typeof IconChat; hint: string }[] = [
  { key: "console", label: "实时成交台", icon: IconBrain, hint: "核心" },
  { key: "workbench", label: "对话复盘工作台", icon: IconChat, hint: "" },
  { key: "knowledge", label: "销售方法论库", icon: IconBook, hint: "" },
  { key: "about", label: "关于产品", icon: IconSpark, hint: "" },
];

export default function Sidebar({
  view,
  setView,
  health,
}: {
  view: View;
  setView: (v: View) => void;
  health: Health | null;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-bone/40">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-canvas">
          <IconSpark width={20} height={20} />
        </span>
        <div className="leading-tight">
          <div className="font-serif text-[18px] tracking-[-0.01em] text-ink">AI 超级销售</div>
          <div className="text-[11px] text-muted">私域跟单 · 多智能体</div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-2">
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition ${
                active ? "bg-surface text-ink shadow-lift" : "text-charcoal hover:bg-surface/60"
              }`}
            >
              <span className={active ? "text-ink" : "text-muted"}>
                <Icon width={18} height={18} />
              </span>
              <span className="flex-1">{n.label}</span>
              {n.hint && (
                <span className="rounded bg-pale-blue px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-pale-blue-ink">
                  {n.hint}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-line px-5 py-4">
        <div className="text-[11px] uppercase tracking-[0.05em] text-muted">推理引擎</div>
        <div className="mt-1.5 flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              health?.engine === "llm" ? "bg-pale-green-ink" : "bg-pale-yellow-ink"
            }`}
          />
          <span className="text-[13px] text-ink">
            {health ? (health.engine === "llm" ? health.model : "离线规则兜底") : "连接中…"}
          </span>
        </div>
        {health && (
          <div className="mt-1 font-mono text-[10px] text-muted">
            检索 · {health.retrieval_backend === "embedding" ? "本地向量(BGE)" : "TF-IDF"}
          </div>
        )}
      </div>
    </aside>
  );
}
