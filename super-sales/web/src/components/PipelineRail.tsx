import type { RunStep } from "../types";
import { IconCheck } from "../icons";

const STATUS_LABEL: Record<RunStep["status"], string> = {
  pending: "待命",
  running: "工作中",
  done: "完成",
  skipped: "跳过",
};

function Node({ step, index, isLast }: { step: RunStep; index: number; isLast: boolean }) {
  const { status } = step;
  const dot =
    status === "done"
      ? "border-pale-green-ink bg-pale-green text-pale-green-ink"
      : status === "running"
        ? "border-pale-blue-ink bg-pale-blue text-pale-blue-ink running-dot"
        : status === "skipped"
          ? "border-line bg-bone text-muted"
          : "border-line bg-surface text-muted";

  return (
    <li className="relative flex gap-3 pb-1">
      {!isLast && (
        <span
          className={`absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px ${
            status === "done" ? "bg-pale-green-ink/40" : "bg-line"
          }`}
        />
      )}
      <span
        className={`z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[12px] font-mono ${dot}`}
      >
        {status === "done" ? <IconCheck width={15} height={15} /> : index + 1}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-between pt-1.5">
        <span
          className={`truncate text-[14px] ${
            status === "pending" ? "text-muted" : "text-ink"
          } ${status === "skipped" ? "line-through decoration-muted/50" : ""}`}
        >
          {step.label}
        </span>
        <span
          className={`ml-2 shrink-0 text-[11px] ${
            status === "running"
              ? "text-pale-blue-ink"
              : status === "done"
                ? "text-pale-green-ink"
                : "text-muted"
          }`}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>
    </li>
  );
}

export default function PipelineRail({ steps }: { steps: RunStep[] }) {
  const doneCount = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return (
    <div className="rounded-card border border-line bg-surface">
      <header className="border-b border-line px-5 py-3.5">
        <h3 className="font-serif text-[17px] tracking-[-0.01em] text-ink">智能体流水线</h3>
        <p className="mt-0.5 text-[12px] text-muted">
          LangGraph 状态图编排 · {doneCount}/{steps.length}
        </p>
      </header>
      <ol className="px-5 py-4">
        {steps.map((s, i) => (
          <Node key={s.key} step={s} index={i} isLast={i === steps.length - 1} />
        ))}
      </ol>
    </div>
  );
}
