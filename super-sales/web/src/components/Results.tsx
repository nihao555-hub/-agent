import { useState } from "react";
import type { FinalState } from "../types";
import { Badge, Card, Cite, Stat } from "../ui";
import {
  IconAlert,
  IconBook,
  IconChat,
  IconClock,
  IconCopy,
  IconRoute,
  IconTag,
  IconTarget,
  IconUser,
} from "../icons";

const RISK_TONE = { low: "green", medium: "yellow", high: "red" } as const;
const RISK_LABEL = { low: "流失风险低", medium: "流失风险中", high: "流失风险高" } as const;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bone px-2.5 py-1 text-[12px] text-charcoal transition active:scale-95 hover:bg-line/40"
    >
      <IconCopy width={14} height={14} />
      {copied ? "已复制" : "复制"}
    </button>
  );
}

export default function Results({ state }: { state: FinalState }) {
  const { profile, stage, objections, recovery, script, quote, followup, crm, evidence } = state;
  const hasAny = profile || stage || objections || recovery || script || quote || followup || crm;

  if (!hasAny) {
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center rounded-card border border-dashed border-line bg-surface/60 text-center">
        <span className="mb-3 text-charcoal">
          <IconChat width={28} height={28} />
        </span>
        <p className="font-serif text-[18px] text-ink">贴一段客户聊天，让 AI 接管跟单</p>
        <p className="mt-1 max-w-sm text-[13px] text-muted">
          9 个销售智能体会依次判断阶段、拆解异议、生成话术与报价，并把每条结论溯源到销售方法论。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 阶段 + 画像 概览 */}
      {stage && (
        <Card
          title="商机阶段"
          icon={<IconTarget />}
          meta={
            <>
              <Badge tone={RISK_TONE[stage.churn_risk] ?? "neutral"}>
                {RISK_LABEL[stage.churn_risk] ?? stage.churn_risk}
              </Badge>
            </>
          }
          className="fade-in"
        >
          <div className="grid grid-cols-3 gap-3">
            <Stat label="当前阶段" value={stage.stage} />
            <Stat label="置信度" value={`${Math.round((stage.confidence ?? 0) * 100)}%`} />
            <Stat
              label="流失风险"
              value={RISK_LABEL[stage.churn_risk]?.replace("流失风险", "") ?? "-"}
              tone={stage.churn_risk === "high" ? "red" : undefined}
            />
          </div>
          {stage.buying_signals?.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {stage.buying_signals.map((s, i) => (
                <span key={i} className="rounded-md bg-bone px-2 py-1 text-[12px] text-charcoal">
                  {s}
                </span>
              ))}
            </div>
          )}
          {stage.rationale && <p className="mt-3 text-[13.5px] leading-6 text-charcoal">{stage.rationale}</p>}
          <Cite ids={stage.cited} />
        </Card>
      )}

      {profile && (
        <Card title="客户画像" icon={<IconUser />} className="fade-in">
          <p className="text-[13.5px] leading-6 text-charcoal">{profile.summary}</p>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
            <Field label="行业" value={profile.industry} />
            <Field label="角色" value={profile.role} />
            <Field label="预算敏感度" value={profile.budget_sensitivity} />
            <Field label="决策权" value={profile.decision_power} />
          </div>
          {profile.needs?.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {profile.needs.map((n, i) => (
                <Badge key={i} tone="blue">
                  {n}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* 异议拆解 */}
      {objections?.objections?.length ? (
        <Card title="异议拆解" icon={<IconAlert />} className="fade-in">
          <div className="space-y-3">
            {objections.objections.map((o, i) => (
              <div key={i} className="rounded-lg border border-line bg-bone/50 p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-serif text-[15px] text-ink">“{o.raw}”</p>
                  <Badge tone="yellow" className="shrink-0">
                    {o.type}
                  </Badge>
                </div>
                <p className="mt-2 text-[13px] leading-6 text-muted">
                  <span className="text-charcoal">真实顾虑：</span>
                  {o.real_concern}
                </p>
                <p className="mt-1.5 text-[13px] leading-6 text-charcoal">
                  <span className="text-pale-green-ink">应对：</span>
                  {o.counter}
                </p>
                <Cite ids={o.cited} />
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* 挽回官（条件分支） */}
      {recovery && (
        <Card
          title="流失挽回"
          icon={<IconRoute />}
          meta={
            <Badge tone={recovery.triggered ? "red" : "neutral"}>
              {recovery.triggered ? "已触发" : "本单跳过"}
            </Badge>
          }
          className="fade-in"
        >
          {recovery.triggered ? (
            <>
              {recovery.risk_reason && (
                <p className="text-[13.5px] leading-6 text-charcoal">{recovery.risk_reason}</p>
              )}
              {recovery.actions?.length ? (
                <ul className="mt-3 space-y-1.5">
                  {recovery.actions.map((a, i) => (
                    <li key={i} className="flex gap-2 text-[13px] text-charcoal">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-pale-red-ink" />
                      {a}
                    </li>
                  ))}
                </ul>
              ) : null}
              {recovery.message && (
                <div className="mt-3 rounded-lg border border-line bg-pale-red/30 p-3.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-[0.05em] text-pale-red-ink">挽回话术</span>
                    <CopyButton text={recovery.message} />
                  </div>
                  <p className="whitespace-pre-wrap text-[13.5px] leading-6 text-ink">{recovery.message}</p>
                </div>
              )}
              <Cite ids={recovery.cited} />
            </>
          ) : (
            <p className="text-[13px] text-muted">{recovery.reason ?? "流失风险不高，未触发挽回流程。"}</p>
          )}
        </Card>
      )}

      {/* 话术官 —— 主推 */}
      {script && (
        <Card
          title="推荐下一句话术"
          icon={<IconChat />}
          meta={<CopyButton text={script.next_message} />}
          className="fade-in border-charcoal/20"
        >
          <p className="whitespace-pre-wrap rounded-lg bg-bone p-3.5 font-serif text-[16px] leading-7 text-ink">
            {script.next_message}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {script.tone && <Badge tone="green">{script.tone}</Badge>}
            {script.talking_points?.map((t, i) => (
              <span key={i} className="rounded-md bg-bone px-2 py-1 text-[12px] text-charcoal">
                {t}
              </span>
            ))}
          </div>
          <Cite ids={script.cited} />
        </Card>
      )}

      {/* 报价官 */}
      {quote?.tiers?.length ? (
        <Card title="报价方案" icon={<IconTag />} className="fade-in">
          <div className="grid gap-3 sm:grid-cols-3">
            {quote.tiers.map((t, i) => {
              const rec = t.name === quote.recommended;
              return (
                <div
                  key={i}
                  className={`rounded-lg border p-3.5 ${
                    rec ? "border-charcoal bg-bone" : "border-line bg-surface"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-muted">{t.name}</span>
                    {rec && <Badge tone="green">推荐</Badge>}
                  </div>
                  <div className="mt-1 font-serif text-[20px] text-ink">{t.price}</div>
                  <ul className="mt-2 space-y-1">
                    {t.highlights?.map((h, j) => (
                      <li key={j} className="text-[12px] leading-5 text-charcoal">
                        · {h}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          {quote.anchor_strategy && (
            <p className="mt-3 text-[13px] leading-6 text-muted">
              <span className="text-charcoal">锚定策略：</span>
              {quote.anchor_strategy}
            </p>
          )}
          {quote.concession_levers?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {quote.concession_levers.map((c, i) => (
                <Badge key={i} tone="yellow">
                  让步项 · {c}
                </Badge>
              ))}
            </div>
          ) : null}
          <Cite ids={quote.cited} />
        </Card>
      ) : null}

      {/* 跟进 + CRM */}
      <div className="grid gap-4 lg:grid-cols-2">
        {followup?.plan?.length ? (
          <Card title="跟进计划" icon={<IconClock />} className="fade-in">
            <ol className="space-y-3">
              {followup.plan.map((p, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 w-12 shrink-0 font-mono text-[12px] text-pale-blue-ink">{p.when}</span>
                  <div>
                    <p className="text-[13.5px] text-ink">{p.action}</p>
                    <p className="text-[12px] text-muted">目标：{p.goal}</p>
                  </div>
                </li>
              ))}
            </ol>
            {followup.cadence && <p className="mt-3 text-[12px] text-muted">节奏：{followup.cadence}</p>}
          </Card>
        ) : null}

        {crm && (
          <Card title="CRM 自动建档" icon={<IconBook />} className="fade-in">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="成交概率" value={`${Math.round((crm.win_probability ?? 0) * 100)}%`} />
              <Stat label="阶段" value={crm.stage} />
            </div>
            <div className="mt-3 space-y-2 text-[13px]">
              <Field label="客户" value={crm.customer} block />
              <Field label="下一步" value={crm.next_action} block />
            </div>
            {crm.tags?.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {crm.tags.map((t, i) => (
                  <Badge key={i} tone="neutral">
                    {t}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Card>
        )}
      </div>

      {/* 检索依据 */}
      {evidence?.length ? (
        <Card title="检索到的销售方法论" icon={<IconBook />} className="fade-in">
          <div className="space-y-2">
            {evidence.map((e) => (
              <div key={e.id} className="flex gap-3 rounded-lg border border-line bg-bone/40 p-3">
                <span className="shrink-0 font-mono text-[10px] text-muted">{e.id}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-ink">{e.title}</span>
                    <span className="font-mono text-[10px] text-muted">相关度 {e.score}</span>
                  </div>
                  <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{e.text}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Field({ label, value, block }: { label: string; value: string; block?: boolean }) {
  return (
    <div className={block ? "" : ""}>
      <span className="text-[11px] uppercase tracking-[0.05em] text-muted">{label}</span>
      <div className="text-[13.5px] text-charcoal">{value}</div>
    </div>
  );
}
