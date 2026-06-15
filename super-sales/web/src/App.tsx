import { useEffect, useRef, useState } from "react";
import Sidebar, { type View } from "./components/Sidebar";
import PipelineRail from "./components/PipelineRail";
import Results from "./components/Results";
import Knowledge from "./components/Knowledge";
import About from "./components/About";
import ChatConsole from "./components/ChatConsole";
import { getHealth, getSample, runStream } from "./api";
import type { FinalState, Health, RunStep } from "./types";
import { Badge } from "./ui";
import { IconArrow, IconSpark } from "./icons";

export default function App() {
  const [view, setView] = useState<View>("console");
  const [health, setHealth] = useState<Health | null>(null);
  const [conversation, setConversation] = useState("");
  const [product, setProduct] = useState("");
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [state, setState] = useState<FinalState>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getHealth()
      .then((h) => {
        setHealth(h);
        setSteps(h.pipeline.map((p) => ({ ...p, status: "pending" })));
      })
      .catch(() => setError("无法连接后端，请确认 super-sales/backend 已在 :8099 运行"));
    getSample().then((s) => {
      setConversation(s.conversation);
      setProduct(s.product);
    });
  }, []);

  function markNextRunning(list: RunStep[]): RunStep[] {
    const idx = list.findIndex((s) => s.status === "pending");
    if (idx >= 0) list[idx] = { ...list[idx], status: "running" };
    return list;
  }

  async function handleRun() {
    if (!conversation.trim() || running) return;
    setRunning(true);
    setError(null);
    setState({});
    const base: RunStep[] = (health?.pipeline ?? []).map((p) => ({ ...p, status: "pending" }));
    if (base[0]) base[0].status = "running";
    setSteps([...base]);

    abortRef.current = new AbortController();
    try {
      await runStream(
        { conversation, product },
        {
          onStep: ({ node, field, result }) => {
            setState((prev) => ({ ...prev, [field]: result }));
            setSteps((prev) => {
              const next = prev.map((s) => ({ ...s }));
              const isSkip = node === "skip_recovery";
              const key = isSkip ? "recovery" : node;
              const t = next.find((s) => s.key === key);
              if (t) t.status = isSkip ? "skipped" : "done";
              return markNextRunning(next);
            });
          },
          onDone: ({ state: final }) => {
            setState(final);
            setSteps((prev) =>
              prev.map((s) => (s.status === "running" || s.status === "pending" ? { ...s, status: "done" } : s)),
            );
          },
          onError: (msg) => setError(msg),
        },
        abortRef.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar view={view} setView={setView} health={health} />

      <main className={`flex-1 ${view === "console" ? "overflow-hidden" : "overflow-y-auto"}`}>
        {view === "console" && (
          <ChatConsole
            channels={health?.channels ?? []}
            salesStages={health?.sales_stages ?? []}
            personas={health?.personas ?? []}
            bgAvailable={health?.background_check ?? false}
          />
        )}

        {view === "workbench" && (
          <div className="mx-auto max-w-[1180px] px-8 py-7">
            <header className="mb-6 flex items-end justify-between">
              <div>
                <h1 className="font-serif text-[26px] tracking-[-0.02em] text-ink">私域跟单工作台</h1>
                <p className="mt-1 text-[13.5px] text-muted">
                  贴一段客户的微信聊天，让 10 个销售智能体接管这一单。
                </p>
              </div>
              {health && (
                <Badge tone={health.engine === "llm" ? "green" : "yellow"}>
                  {health.engine === "llm" ? `引擎 · ${health.model}` : "引擎 · 离线兜底"}
                </Badge>
              )}
            </header>

            {error && (
              <div className="mb-4 rounded-lg border border-pale-red bg-pale-red/40 px-4 py-3 text-[13px] text-pale-red-ink">
                {error}
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
              {/* 左：输入 + 流水线 */}
              <div className="space-y-5">
                <div className="rounded-card border border-line bg-surface">
                  <div className="border-b border-line px-5 py-3.5">
                    <h3 className="font-serif text-[17px] text-ink">客户对话</h3>
                  </div>
                  <div className="px-5 py-4">
                    <input
                      value={product}
                      onChange={(e) => setProduct(e.target.value)}
                      placeholder="在卖什么产品（可选）"
                      className="mb-2 w-full rounded-md border border-line bg-bone/50 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-charcoal"
                    />
                    <textarea
                      value={conversation}
                      onChange={(e) => setConversation(e.target.value)}
                      rows={10}
                      placeholder="粘贴与客户的微信/企业微信聊天记录…"
                      className="w-full resize-none rounded-md border border-line bg-bone/50 px-3 py-2.5 text-[13px] leading-6 text-charcoal outline-none placeholder:text-muted focus:border-charcoal"
                    />
                    <button
                      onClick={handleRun}
                      disabled={running || !conversation.trim()}
                      className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-ink px-4 py-2.5 text-[14px] text-canvas transition active:scale-[0.99] hover:bg-charcoal disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {running ? (
                        <>
                          <IconSpark width={16} height={16} className="animate-spin" />
                          智能体工作中…
                        </>
                      ) : (
                        <>
                          让 AI 超级销售接管
                          <IconArrow width={16} height={16} />
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {steps.length > 0 && <PipelineRail steps={steps} />}
              </div>

              {/* 右：结果 */}
              <div>
                <Results state={state} />
              </div>
            </div>
          </div>
        )}

        {view === "knowledge" && (
          <div className="px-8 py-7">
            <Knowledge />
          </div>
        )}
        {view === "about" && (
          <div className="px-8 py-7">
            <About />
          </div>
        )}
      </main>
    </div>
  );
}
