import { useEffect, useRef, useState } from "react";
import {
  approveDecision,
  createCustomer,
  getCustomer,
  getSettings,
  listCustomers,
  runBackground,
  sendInbound,
  simulateCustomer,
  updateSettings,
} from "../api";
import type { InboundResult } from "../api";
import type {
  Background,
  ChannelInfo,
  ChatMessage,
  Customer,
  Decision,
  MemoryFact,
  Persona,
  Settings,
} from "../types";
import { Badge } from "../ui";
import {
  IconBrain,
  IconPlus,
  IconSend,
  IconShield,
  IconTrophy,
  IconUser,
} from "../icons";

const PLATFORM_LABEL: Record<string, string> = {
  sandbox: "沙盒",
  whatsapp: "WhatsApp",
  line: "LINE",
  wecom: "企微",
};

const MEM_LABEL: Record<string, string> = {
  pain: "痛点",
  preference: "偏好",
  commitment: "承诺",
  objection: "异议",
  taboo: "禁忌",
  fact: "事实",
};

const MEM_TONE: Record<string, "red" | "blue" | "green" | "yellow" | "neutral"> = {
  pain: "red",
  objection: "yellow",
  commitment: "green",
  taboo: "red",
  preference: "blue",
  fact: "neutral",
};

function winTone(n: number): "red" | "yellow" | "green" {
  return n >= 67 ? "green" : n >= 34 ? "yellow" : "red";
}

// static class strings so Tailwind's JIT keeps them (no dynamic interpolation)
const WIN_TEXT: Record<"red" | "yellow" | "green", string> = {
  red: "text-pale-red-ink",
  yellow: "text-pale-yellow-ink",
  green: "text-pale-green-ink",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// clamp the backend's realistic per-phase pacing into a usable range for the
// live console — long enough to read like a real person, short enough to demo.
const readMs = (ms: number | undefined) => Math.min(Math.max(ms ?? 1500, 700), 3500);
const thinkMs = (ms: number | undefined) => Math.min(Math.max(ms ?? 1200, 500), 3000);
const typeMs = (ms: number | undefined) => Math.min(Math.max(ms ?? 1500, 700), 4500);

type Phase = "reading" | "thinking" | "typing" | null;
const PHASE_LABEL: Record<"reading" | "thinking" | "typing", string> = {
  reading: "AI 销冠正在读消息…",
  thinking: "AI 销冠正在思考怎么推进…",
  typing: "AI 销冠正在输入…",
};

export default function ChatConsole({
  channels,
  salesStages,
  personas,
  bgAvailable,
}: {
  channels: ChannelInfo[];
  salesStages: string[];
  personas: Persona[];
  bgAvailable: boolean;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [platform, setPlatform] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memory, setMemory] = useState<MemoryFact[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [background, setBackground] = useState<Background | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // Semi-AI (人审): suggested reply awaiting operator approval (editable).
  const [pending, setPending] = useState<{ cid: string; decision: Decision } | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [persona, setPersona] = useState<string>(personas[0]?.key ?? "skeptic");
  const [showNew, setShowNew] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef(0);

  const selected = customers.find((c) => c.id === selectedId) ?? null;
  const visible =
    platform === "all" ? customers : customers.filter((c) => c.platform === platform);

  async function refreshCustomers(selectFirst = false) {
    const list = await listCustomers();
    setCustomers(list);
    if (selectFirst && list.length && !selectedId) void selectCustomer(list[0].id);
  }

  useEffect(() => {
    void refreshCustomers(true);
    void getSettings().then(setSettings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const semi = settings?.mode === "semi";

  async function toggleMode() {
    const next = semi ? "auto" : "semi";
    setSettings(await updateSettings({ mode: next }));
  }

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function selectCustomer(id: string) {
    setSelectedId(id);
    setDecision(null);
    setPending(null);
    const d = await getCustomer(id);
    setMessages(d.messages);
    setMemory(d.memory);
    setBackground(d.background ?? null);
  }

  async function handleBackground(opts: {
    domain?: string;
    contact_name?: string;
    contact_email?: string;
    contact_username?: string;
  } = {}) {
    if (!selectedId || bgBusy) return;
    setBgBusy(true);
    try {
      const res = await runBackground(selectedId, opts);
      setBackground(res.background);
    } finally {
      setBgBusy(false);
    }
  }

  // Reveal the AI's outgoing bubbles at a real person's pace instead of dumping
  // them instantly: read the inbound → think → type each message in turn. The
  // right-panel reasoning shows at once (operator insight); only the chat bubbles
  // are paced. Returns false if a newer turn took over mid-way.
  async function revealMessages(agentMsgs: ChatMessage[], dec: Decision, token: number) {
    const types = dec.type_ms ?? dec.pacing ?? [];
    setPhase("reading");
    await sleep(readMs(dec.read_ms));
    if (turnRef.current !== token) return;
    setPhase("thinking");
    await sleep(thinkMs(dec.think_ms));
    for (let i = 0; i < agentMsgs.length; i++) {
      if (turnRef.current !== token) return;
      setPhase("typing");
      await sleep(typeMs(types[i]));
      if (turnRef.current !== token) return;
      setMessages((prev) => [...prev, agentMsgs[i]]);
    }
    setPhase(null);
  }

  // Apply a turn result. In auto mode we reveal the agent's (already-sent)
  // bubbles with pacing. In semi mode the backend sent nothing — we surface the
  // suggested reply for the operator to approve/edit first.
  async function playTurn(res: InboundResult, cid: string) {
    const token = ++turnRef.current;
    const sentIds = new Set(res.sent.map((s) => s.id));
    const base = res.messages.filter((m) => !sentIds.has(m.id));
    const agentMsgs = res.messages.filter((m) => sentIds.has(m.id));
    setDecision(res.decision);
    setMemory(res.memory);
    setCustomers((prev) => prev.map((c) => (c.id === cid ? res.customer : c)));
    setMessages(base);
    if (res.sent.length === 0 && (res.decision.reply?.length ?? 0) > 0) {
      // semi-AI: hold for operator approval
      setPending({ cid, decision: res.decision });
      setDraft([...res.decision.reply]);
      setPhase(null);
      return;
    }
    await revealMessages(agentMsgs, res.decision, token);
  }

  async function handleApprove() {
    if (!pending) return;
    const { cid, decision } = pending;
    const reply = draft.map((s) => s.trim()).filter(Boolean);
    if (reply.length === 0) return;
    setPending(null);
    setBusy(true);
    try {
      const res = await approveDecision(cid, { ...decision, reply });
      const token = ++turnRef.current;
      const sentIds = new Set(res.sent.map((s) => s.id));
      setMessages(res.messages.filter((m) => !sentIds.has(m.id)));
      setMemory(res.memory);
      setCustomers((prev) => prev.map((c) => (c.id === cid ? res.customer : c)));
      await revealMessages(
        res.messages.filter((m) => sentIds.has(m.id)),
        { ...decision, reply },
        token,
      );
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  function handleReject() {
    setPending(null);
    setDraft([]);
  }

  async function handleSend() {
    if (!input.trim() || !selectedId || busy || pending) return;
    const text = input.trim();
    const cid = selectedId;
    setInput("");
    setBusy(true);
    // optimistic: show the customer's inbound message immediately
    setMessages((prev) => [
      ...prev,
      { id: `tmp_${Date.now()}`, customer_id: cid, role: "customer", text, created_at: Date.now() / 1000 },
    ]);
    try {
      const res = await sendInbound(cid, text);
      await playTurn(res, cid);
    } finally {
      setBusy(false);
    }
  }

  // Let the system role-play the customer (different tempers) to pressure-test the closer.
  async function handleSimulate() {
    if (!selectedId || busy || pending) return;
    const cid = selectedId;
    setBusy(true);
    try {
      const res = await simulateCustomer(cid, persona);
      await playTurn(res, cid);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <PlatformBar
        channels={channels}
        platform={platform}
        setPlatform={setPlatform}
        onNew={() => setShowNew(true)}
        semi={semi}
        onToggleMode={() => void toggleMode()}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_344px]">
        {/* 左：客户筛选 */}
        <aside className="min-h-0 overflow-y-auto border-r border-line bg-bone/30">
          {visible.length === 0 && (
            <div className="px-5 py-8 text-center text-[12.5px] text-muted">
              还没有客户。<br />
              点右上角「新建客户」开始。
            </div>
          )}
          {visible.map((c) => {
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                onClick={() => void selectCustomer(c.id)}
                className={`flex w-full flex-col gap-1 border-b border-line/70 px-4 py-3 text-left transition ${
                  active ? "bg-surface" : "hover:bg-surface/60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate text-[14px] text-ink">{c.name}</span>
                  <Badge tone="neutral">{PLATFORM_LABEL[c.platform] ?? c.platform}</Badge>
                </div>
                <div className="flex items-center justify-between text-[11.5px] text-muted">
                  <span className="truncate">
                    {[c.country, c.category].filter(Boolean).join(" · ") || "未设画像"}
                  </span>
                  <span className="ml-2 shrink-0">
                    <span className={`font-mono ${WIN_TEXT[winTone(c.win_score)]}`}>{c.win_score}</span>
                    <span className="text-muted/70"> · {c.stage}</span>
                  </span>
                </div>
              </button>
            );
          })}
        </aside>

        {/* 中：实时聊天 */}
        <section className="flex min-h-0 flex-col bg-canvas">
          {selected ? (
            <>
              <ChatHeader
                customer={selected}
                bgAvailable={bgAvailable}
                bgBusy={bgBusy}
                onBackground={(opts) => void handleBackground(opts)}
              />
              <div ref={threadRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
                {messages.length === 0 && (
                  <p className="mt-10 text-center text-[13px] text-muted">
                    在下方以客户口吻发一条消息，AI 销冠会实时接管这一单。
                  </p>
                )}
                {messages.map((m) => (
                  <Bubble key={m.id} m={m} />
                ))}
                {(busy || phase) && (
                  <div className="flex items-center gap-2 text-[12.5px] text-muted">
                    <span className="flex gap-1">
                      <Dot /> <Dot /> <Dot />
                    </span>
                    {phase ? PHASE_LABEL[phase] : "AI 销冠正在读消息、组织话术…"}
                  </div>
                )}
              </div>
              {pending && (
                <ApprovalPanel
                  decision={pending.decision}
                  draft={draft}
                  setDraft={setDraft}
                  onApprove={() => void handleApprove()}
                  onReject={handleReject}
                  busy={busy}
                />
              )}
              <div className="border-t border-line bg-surface px-4 py-3">
                <div className="flex items-end gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    rows={1}
                    placeholder="以客户口吻发消息（Enter 发送 / Shift+Enter 换行）"
                    className="max-h-32 min-h-[42px] flex-1 resize-none rounded-lg border border-line bg-bone/40 px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-muted focus:border-charcoal"
                  />
                  <button
                    onClick={() => void handleSend()}
                    disabled={busy || !input.trim()}
                    className="flex h-[42px] items-center gap-1.5 rounded-lg bg-ink px-4 text-[13.5px] text-canvas transition hover:bg-charcoal disabled:opacity-40"
                  >
                    <IconSend width={16} height={16} /> 发送
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[11px] text-muted">模拟真实客户：</span>
                  <select
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                    disabled={busy}
                    className="rounded-md border border-line bg-bone/40 px-2 py-1 text-[11.5px] text-ink outline-none focus:border-charcoal disabled:opacity-40"
                  >
                    {personas.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void handleSimulate()}
                    disabled={busy}
                    className="rounded-md border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink transition hover:bg-bone disabled:opacity-40"
                    title="让系统扮演这种脾气的客户，发一条消息来压测 AI 销冠"
                  >
                    让 AI 扮客户发一条
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted">
                  你可亲自扮客户发消息，或用上方「模拟客户」让不同脾气的买家来压测。接入真实渠道后由客户真人发消息。
                </p>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-[13.5px] text-muted">
              从左侧选择一个客户，或新建一个开始对话。
            </div>
          )}
        </section>

        {/* 右：Agent 实时工作状态 / 思维链 */}
        <aside className="min-h-0 overflow-y-auto border-l border-line bg-bone/30">
          <AgentPanel
            customer={selected}
            decision={decision}
            memory={memory}
            salesStages={salesStages}
            background={background}
          />
        </aside>
      </div>

      {showNew && (
        <NewCustomerModal
          channels={channels}
          onClose={() => setShowNew(false)}
          onCreated={async (c) => {
            setShowNew(false);
            await refreshCustomers();
            void selectCustomer(c.id);
          }}
        />
      )}
    </div>
  );
}

function PlatformBar({
  channels,
  platform,
  setPlatform,
  onNew,
  semi,
  onToggleMode,
}: {
  channels: ChannelInfo[];
  platform: string;
  setPlatform: (p: string) => void;
  onNew: () => void;
  semi: boolean;
  onToggleMode: () => void;
}) {
  const tabs = [{ name: "all", label: "全部", configured: true, risk: "" }, ...channels];
  return (
    <div className="flex items-center justify-between border-b border-line bg-surface px-5 py-2.5">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => {
          const active = platform === t.name;
          return (
            <button
              key={t.name}
              onClick={() => setPlatform(t.name)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition ${
                active ? "bg-ink text-canvas" : "text-charcoal hover:bg-bone"
              }`}
            >
              {t.label}
              {t.name !== "all" && (
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    (t as ChannelInfo).configured ? "bg-pale-green-ink" : "bg-muted/50"
                  }`}
                  title={(t as ChannelInfo).configured ? "已接入" : "未接入凭证"}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleMode}
          title={semi ? "半AI（人审）：AI 只给建议，需人工采纳后才发出" : "全自动：AI 直接发出"}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition ${
            semi
              ? "border-pale-yellow-ink/40 bg-pale-yellow/40 text-pale-yellow-ink"
              : "border-line bg-bone text-charcoal hover:bg-surface"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${semi ? "bg-pale-yellow-ink" : "bg-pale-green-ink"}`} />
          {semi ? "半AI · 人审" : "全自动"}
        </button>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-bone px-3 py-1.5 text-[12.5px] text-ink transition hover:bg-surface"
        >
          <IconPlus width={15} height={15} /> 新建客户
        </button>
      </div>
    </div>
  );
}

// Semi-AI (人审) review: the operator sees the AI's suggested reply (one box per
// message), can edit / add / drop lines, then 采纳 (send) or 否决 (discard).
function ApprovalPanel({
  decision,
  draft,
  setDraft,
  onApprove,
  onReject,
  busy,
}: {
  decision: Decision;
  draft: string[];
  setDraft: (d: string[]) => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const setLine = (i: number, v: string) => setDraft(draft.map((d, j) => (j === i ? v : d)));
  const dropLine = (i: number) => setDraft(draft.filter((_, j) => j !== i));
  const addLine = () => setDraft([...draft, ""]);
  return (
    <div className="border-t border-pale-yellow-ink/30 bg-pale-yellow/25 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-pale-yellow-ink">
          <IconBrain width={14} height={14} /> 半AI · 待人工采纳（{draft.length} 条建议）
        </span>
        {decision.handoff && (
          <Badge tone="red">AI 建议转人工：{decision.handoff_reason || "触发护栏"}</Badge>
        )}
      </div>
      <div className="space-y-2">
        {draft.map((line, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-2 font-mono text-[11px] text-muted">{i + 1}</span>
            <textarea
              value={line}
              onChange={(e) => setLine(i, e.target.value)}
              rows={1}
              className="max-h-32 min-h-[38px] flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-charcoal"
            />
            <button
              onClick={() => dropLine(i)}
              title="删除这条"
              className="mt-1 rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-pale-red/40 hover:text-pale-red-ink"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={addLine}
          className="rounded-md border border-line bg-surface px-2.5 py-1 text-[11.5px] text-charcoal transition hover:bg-bone"
        >
          + 加一条
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onReject}
            disabled={busy}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-charcoal transition hover:bg-bone disabled:opacity-40"
          >
            否决
          </button>
          <button
            onClick={onApprove}
            disabled={busy || draft.every((d) => !d.trim())}
            className="flex items-center gap-1.5 rounded-lg bg-ink px-4 py-1.5 text-[12.5px] text-canvas transition hover:bg-charcoal disabled:opacity-40"
          >
            <IconSend width={14} height={14} /> 采纳并发出
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatHeader({
  customer,
  bgAvailable,
  bgBusy,
  onBackground,
}: {
  customer: Customer;
  bgAvailable: boolean;
  bgBusy: boolean;
  onBackground: (opts: {
    domain?: string;
    contact_name?: string;
    contact_email?: string;
    contact_username?: string;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState("");
  const [cName, setCName] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [cUser, setCUser] = useState("");
  function run() {
    onBackground({
      domain: domain.trim(),
      contact_name: cName.trim(),
      contact_email: cEmail.trim(),
      contact_username: cUser.trim(),
    });
    setOpen(false);
  }
  return (
    <header className="relative flex items-center justify-between border-b border-line bg-surface px-6 py-3">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bone text-charcoal">
          <IconUser width={18} height={18} />
        </span>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[15px] text-ink">{customer.name}</span>
            <Badge tone="neutral">{PLATFORM_LABEL[customer.platform] ?? customer.platform}</Badge>
            {customer.customer_type && (
              <Badge tone={customer.customer_type === "b2c" ? "yellow" : "blue"}>
                {customer.customer_type === "b2c" ? "C端·卖货" : "B端·顾问式"}
              </Badge>
            )}
            {customer.status === "handoff" && <Badge tone="red">待转人工</Badge>}
          </div>
          <div className="text-[11.5px] text-muted">
            {[customer.country, customer.category].filter(Boolean).join(" · ") || "未设画像"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 text-right">
        <div className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={bgBusy || !bgAvailable}
            title={bgAvailable ? "公司 + 决策人公开背调（Maigret/Blackbird/Holehe + 商业情报）" : "背调引擎未安装"}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-bone px-2.5 py-1.5 text-[12px] text-ink transition hover:bg-surface disabled:opacity-40"
          >
            <IconShield width={13} height={13} /> {bgBusy ? "背调中…" : "AI 背调"}
          </button>
          {open && !bgBusy && (
            <div className="absolute right-0 z-20 mt-1 w-72 rounded-card border border-line bg-surface p-3 text-left shadow-lg">
              <div className="mb-2 text-[11px] uppercase tracking-[0.05em] text-muted">
                公司 + 决策人公开调研（选填）
              </div>
              <div className="space-y-2 text-[12px]">
                <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="公司域名（如 acme.com）"
                  className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-ink outline-none" />
                <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="对接人/决策人姓名"
                  className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-ink outline-none" />
                <input value={cEmail} onChange={(e) => setCEmail(e.target.value)} placeholder="对接人公司邮箱"
                  className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-ink outline-none" />
                <input value={cUser} onChange={(e) => setCUser(e.target.value)} placeholder="对接人常用用户名"
                  className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-ink outline-none" />
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-ink">取消</button>
                <button onClick={run} className="rounded-md bg-charcoal px-3 py-1 text-[12px] text-surface">开始背调</button>
              </div>
              <div className="mt-2 text-[10.5px] leading-4 text-muted">仅聚合公开信息用于正当销售尽调；留空也可只查公司。</div>
            </div>
          )}
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.05em] text-muted">阶段</div>
          <div className="text-[13px] text-ink">{customer.stage}</div>
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.05em] text-muted">赢率</div>
          <div className={`font-mono text-[15px] ${WIN_TEXT[winTone(customer.win_score)]}`}>
            {customer.win_score}
          </div>
        </div>
      </div>
    </header>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === "system") {
    return <div className="text-center text-[11.5px] text-muted">{m.text}</div>;
  }
  const mine = m.role === "agent";
  const translation = (m.translation ?? "").trim();
  const showTranslation = translation && translation !== m.text.trim();
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-6 ${
          mine
            ? "rounded-br-md bg-ink text-canvas"
            : "rounded-bl-md border border-line bg-surface text-ink"
        }`}
      >
        {m.lang && m.lang !== "中文" && (
          <div
            className={`mb-1 text-[10px] uppercase tracking-[0.04em] ${
              mine ? "text-canvas/55" : "text-muted"
            }`}
          >
            {m.lang}
          </div>
        )}
        {m.text}
        {showTranslation && (
          <div
            className={`mt-1.5 border-t pt-1.5 text-[12px] leading-5 ${
              mine ? "border-canvas/20 text-canvas/70" : "border-line text-muted"
            }`}
          >
            <span className="mr-1 opacity-70">译</span>
            {translation}
          </div>
        )}
        {m.asset_id && (
          <div
            className={`mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
              mine ? "bg-canvas/15 text-canvas/90" : "bg-bone text-muted"
            }`}
          >
            <IconShield width={12} height={12} /> 已附带素材（隐私校验通过）
          </div>
        )}
      </div>
    </div>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />;
}

function StageRail({ stages, current }: { stages: string[]; current: string }) {
  const idx = stages.indexOf(current);
  return (
    <div className="rounded-card border border-line bg-surface p-3.5">
      <div className="mb-2.5 text-[11px] uppercase tracking-[0.05em] text-muted">销售进程</div>
      <div className="flex items-center">
        {stages.map((s, i) => {
          const done = idx >= 0 && i < idx;
          const active = i === idx;
          return (
            <div key={s} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-1">
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[9px] ${
                    active
                      ? "bg-ink text-canvas"
                      : done
                        ? "bg-pale-green-ink text-canvas"
                        : "bg-bone text-muted"
                  }`}
                >
                  {i + 1}
                </span>
                <span
                  className={`text-[9.5px] ${active ? "text-ink" : "text-muted"}`}
                >
                  {s}
                </span>
              </div>
              {i < stages.length - 1 && (
                <div
                  className={`mx-0.5 mb-4 h-px flex-1 ${done ? "bg-pale-green-ink" : "bg-line"}`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BackgroundCard({ bg }: { bg: Background }) {
  const br = bg.brief ?? {};
  const hosts = bg.footprint?.hosts ?? [];
  const news = bg.intel?.news ?? [];
  const contact = bg.contact;
  const accounts = contact?.accounts ?? [];
  const services = contact?.email_services ?? [];
  const edgar = bg.intel?.edgar;
  const techStack = br.tech_stack?.length ? br.tech_stack : (bg.intel?.tech_stack ?? []);
  return (
    <div className="rounded-card border border-line bg-surface p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.05em] text-muted">
          <IconShield width={13} height={13} /> AI 背调 · 公司 + 决策人公开情报
        </span>
        <div className="flex items-center gap-1">
          {bg.customer_type && (
            <Badge tone={bg.customer_type === "b2c" ? "yellow" : "blue"}>
              {bg.customer_type === "b2c" ? "C端·卖货" : "B端·顾问式"}
            </Badge>
          )}
          <Badge tone={bg.engine?.includes("business-intel") ? "green" : "yellow"}>{bg.engine}</Badge>
        </div>
      </div>
      <div className="space-y-1.5 text-[12px] leading-5 text-ink">
        {(bg.company || bg.domain) && (
          <div className="text-muted">
            {bg.company}
            {bg.domain && <span className="ml-1 font-mono text-[11px]">· {bg.domain}</span>}
          </div>
        )}
        {br.company_profile && <div>{br.company_profile}</div>}
        {br.industry_guess && (
          <div><span className="text-muted">行业：</span>{br.industry_guess}</div>
        )}
        {br.company_scale && (
          <div><span className="text-muted">规模：</span>{br.company_scale}</div>
        )}
        {br.company_scale_money && (
          <div><span className="text-muted">经营/预算线索：</span>{br.company_scale_money}</div>
        )}
        {edgar?.is_public && (
          <div className="text-[11px]">
            <span className="text-muted">上市：</span>
            {edgar.ticker}
            {edgar.exchange ? `·${edgar.exchange}` : ""}
            {edgar.sic_industry ? ` · ${edgar.sic_industry}` : ""}
            {edgar.recent_filings?.length ? (
              <span className="text-muted"> · 近期备案 {edgar.recent_filings.slice(0, 3).join("、")}</span>
            ) : null}
          </div>
        )}
        {techStack.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted">技术栈：</span>
            {techStack.slice(0, 8).map((t, i) => (
              <Badge key={i} tone="neutral">{t}</Badge>
            ))}
          </div>
        )}
        {br.competitive_landscape && (
          <div><span className="text-muted">竞争态势：</span>{br.competitive_landscape}</div>
        )}
        {br.footprint_summary && (
          <div><span className="text-muted">公开足迹：</span>{br.footprint_summary}</div>
        )}
        {br.sales_angle && (
          <div><span className="text-muted">切入角度：</span>{br.sales_angle}</div>
        )}
        {(br.talking_points?.length ?? 0) > 0 && (
          <ul className="ml-3 list-disc space-y-0.5 text-muted">
            {br.talking_points!.slice(0, 4).map((t, i) => (
              <li key={i} className="text-ink">{t}</li>
            ))}
          </ul>
        )}
        {(br.recent_developments?.length ?? 0) > 0 && (
          <div className="pt-0.5">
            <span className="text-muted">近期动态：</span>
            <ul className="ml-3 list-disc space-y-0.5">
              {br.recent_developments!.slice(0, 4).map((d, i) => (
                <li key={i} className="text-ink">{d}</li>
              ))}
            </ul>
          </div>
        )}
        {(br.possible_decision_makers?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {br.possible_decision_makers!.slice(0, 5).map((d, i) => (
              <Badge key={i} tone="blue">{d}</Badge>
            ))}
          </div>
        )}
        {br.contact_summary && (
          <div><span className="text-muted">对接人画像：</span>{br.contact_summary}</div>
        )}
        {(br.icebreakers?.length ?? 0) > 0 && (
          <div className="pt-0.5">
            <span className="text-muted">破冰话题：</span>
            <ul className="ml-3 list-disc space-y-0.5">
              {br.icebreakers!.slice(0, 4).map((t, i) => (
                <li key={i} className="text-ink">{t}</li>
              ))}
            </ul>
          </div>
        )}
        {(br.buying_triggers?.length ?? 0) > 0 && (
          <div className="pt-0.5">
            <span className="text-muted">{bg.customer_type === "b2c" ? "促单触发点：" : "采购/合作信号："}</span>
            <ul className="ml-3 list-disc space-y-0.5">
              {br.buying_triggers!.slice(0, 4).map((t, i) => (
                <li key={i} className="text-ink">{t}</li>
              ))}
            </ul>
          </div>
        )}
        {contact?.available && (accounts.length > 0 || services.length > 0) && (
          <details className="pt-0.5 text-[11px] text-muted">
            <summary className="cursor-pointer">
              对接人公开足迹 · {accounts.length} 账号{services.length ? ` · ${services.length} 邮箱服务` : ""}
              {contact.engines?.length ? `（${contact.engines.join("/")}）` : ""}
            </summary>
            {accounts.length > 0 && (
              <div className="ml-1 mt-1 flex flex-wrap gap-1">
                {accounts.slice(0, 16).map((a, i) =>
                  a.url ? (
                    <a key={i} href={a.url} target="_blank" rel="noreferrer" className="text-ink underline">
                      {a.site}
                    </a>
                  ) : (
                    <span key={i} className="text-ink">{a.site}</span>
                  ),
                )}
              </div>
            )}
          </details>
        )}
        {news.length > 0 && (
          <details className="pt-0.5 text-[11px] text-muted">
            <summary className="cursor-pointer">公开新闻 {news.length} 条</summary>
            <ul className="ml-3 mt-1 list-disc space-y-0.5">
              {news.slice(0, 5).map((n, i) => (
                <li key={i} className="text-ink">
                  {n.title}
                  {n.source && <span className="text-muted"> · {n.source}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
        {hosts.length > 0 && (
          <div className="pt-0.5 text-[11px] text-muted">公开子域 {hosts.length} 个</div>
        )}
        {br.caution && (
          <div className="mt-1 rounded-md bg-bone px-2 py-1 text-[11px] text-muted">注意：{br.caution}</div>
        )}
      </div>
    </div>
  );
}

function AgentPanel({
  customer,
  decision,
  memory,
  salesStages,
  background,
}: {
  customer: Customer | null;
  decision: Decision | null;
  memory: MemoryFact[];
  salesStages: string[];
  background: Background | null;
}) {
  const currentStage = decision?.stage ?? customer?.stage ?? "";
  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-center gap-2 text-[12px] uppercase tracking-[0.06em] text-muted">
        <IconBrain width={15} height={15} /> AI 销冠实时工作台
      </div>

      {salesStages.length > 0 && customer && (
        <StageRail stages={salesStages} current={currentStage} />
      )}

      {background && <BackgroundCard bg={background} />}

      {decision ? (
        <>
          <div className="rounded-card border border-line bg-surface p-3.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.05em] text-muted">思维链 · 各角色推理</span>
              <Badge tone={decision.engine === "llm" ? "green" : "yellow"}>
                {decision.engine === "llm" ? "LLM" : "兜底"}
              </Badge>
            </div>
            <ol className="space-y-2.5">
              {decision.cot?.map((s, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bone font-mono text-[10px] text-charcoal">
                    {i + 1}
                  </span>
                  <div>
                    <div className="text-[12px] font-medium text-ink">{s.role}</div>
                    <div className="text-[12px] leading-5 text-muted">{s.thought}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {decision.handoff && (
            <div className="rounded-lg border border-pale-red bg-pale-red/40 px-3.5 py-2.5 text-[12.5px] text-pale-red-ink">
              建议转人工：{decision.handoff_reason || "涉及收款/合同/红线"}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <MiniStat label="赢率" value={decision.win_score} tone={winTone(decision.win_score)} icon />
            <MiniStat label="阶段" value={decision.stage} />
          </div>

          {decision.next_step && (
            <div className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
              <div className="text-[10.5px] uppercase tracking-[0.05em] text-muted">锁定的下一步</div>
              <div className="mt-1 text-[12.5px] leading-5 text-ink">{decision.next_step}</div>
            </div>
          )}

          {decision.customer_lang && decision.customer_lang !== "中文" && (
            <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
              <span>客户语言·同语回复</span>
              <Badge tone="blue">{decision.customer_lang}</Badge>
            </div>
          )}

          {(decision.moves?.length ?? 0) > 0 && (
            <div className="rounded-card border border-line bg-surface p-3.5">
              <div className="mb-2 text-[11px] uppercase tracking-[0.05em] text-muted">
                本轮用了哪些方法论
              </div>
              <ul className="space-y-2">
                {decision.moves!.map((mv, i) => (
                  <li key={i} className="flex gap-2 text-[12px] leading-5">
                    <Badge tone="neutral">{mv.method}</Badge>
                    <span className="text-charcoal">{mv.move}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {decision.cited?.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">方法论依据</span>
              {decision.cited.map((id) => (
                <span
                  key={id}
                  className="rounded border border-line bg-bone px-1.5 py-0.5 font-mono text-[10px] text-muted"
                >
                  {id}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="rounded-card border border-dashed border-line bg-surface/50 px-3.5 py-6 text-center text-[12.5px] text-muted">
          {customer ? "发一条消息，这里会实时显示 AI 的逐角色推理。" : "选择客户后开始。"}
        </p>
      )}

      {/* 持久记忆 */}
      <div className="rounded-card border border-line bg-surface p-3.5">
        <div className="mb-2 text-[11px] uppercase tracking-[0.05em] text-muted">
          客户记忆（永久保存 · {memory.length}）
        </div>
        {memory.length === 0 ? (
          <p className="text-[12px] text-muted">暂无。AI 会在对话中自动记录痛点、承诺、异议与禁忌。</p>
        ) : (
          <ul className="space-y-1.5">
            {memory.map((m) => (
              <li key={m.id} className="flex items-start gap-2 text-[12.5px] leading-5 text-charcoal">
                <Badge tone={MEM_TONE[m.kind] ?? "neutral"}>{MEM_LABEL[m.kind] ?? m.kind}</Badge>
                <span>{m.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  tone?: "red" | "yellow" | "green";
  icon?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10.5px] uppercase tracking-[0.05em] text-muted">
        {icon && <IconTrophy width={12} height={12} />}
        {label}
      </div>
      <div className={`mt-1 font-serif text-[20px] leading-none ${tone ? WIN_TEXT[tone] : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}

function NewCustomerModal({
  channels,
  onClose,
  onCreated,
}: {
  channels: ChannelInfo[];
  onClose: () => void;
  onCreated: (c: Customer) => void;
}) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState(channels[0]?.name ?? "sandbox");
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [customerType, setCustomerType] = useState("b2b");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const c = await createCustomer({ name: name.trim(), platform, country, category, customer_type: customerType });
      onCreated(c);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-card border border-line bg-surface shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-line px-5 py-3.5">
          <h3 className="font-serif text-[17px] text-ink">新建客户</h3>
        </header>
        <div className="space-y-3 px-5 py-4">
          <Field label="客户称呼">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：田中社长 / 王总 / John"
              className="w-full rounded-md border border-line bg-bone/40 px-3 py-2 text-[13px] text-ink outline-none focus:border-charcoal"
            />
          </Field>
          <Field label="平台">
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full rounded-md border border-line bg-bone/40 px-3 py-2 text-[13px] text-ink outline-none focus:border-charcoal"
            >
              {channels.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label}
                  {c.configured ? "" : "（未接入）"}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="国家 / 地区">
              <input
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="如：日本 / 美国 / 中东"
                className="w-full rounded-md border border-line bg-bone/40 px-3 py-2 text-[13px] text-ink outline-none focus:border-charcoal"
              />
            </Field>
            <Field label="行业 / 品类">
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="如：SaaS / 外贸 / 电商"
                className="w-full rounded-md border border-line bg-bone/40 px-3 py-2 text-[13px] text-ink outline-none focus:border-charcoal"
              />
            </Field>
          </div>
          <Field label="客户类型（决定销售风格）">
            <select
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value)}
              className="w-full rounded-md border border-line bg-bone/40 px-3 py-2 text-[13px] text-ink outline-none focus:border-charcoal"
            >
              <option value="b2b">B 端企业·顾问式销售（背调/痛点/ROI/MEDDIC）</option>
              <option value="b2c">C 端消费者·纯卖货（带货/激发购买欲）</option>
            </select>
          </Field>
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3.5 py-2 text-[13px] text-charcoal hover:bg-bone">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!name.trim() || saving}
            className="rounded-lg bg-ink px-4 py-2 text-[13px] text-canvas transition hover:bg-charcoal disabled:opacity-40"
          >
            创建
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] uppercase tracking-[0.05em] text-muted">{label}</span>
      {children}
    </label>
  );
}
