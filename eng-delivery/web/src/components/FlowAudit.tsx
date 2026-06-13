import { Steps, Tag } from 'antd';
import type { ClaimFlowResult, FlowStep, StepStatus } from '@/lib/types';
import { FLOW_STEP_LABELS, engineBadge } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatTime } from '@/lib/utils';

const STEP_TAG: Record<StepStatus, { color: string; text: string }> = {
  completed: { color: 'green', text: '已完成' },
  running: { color: 'blue', text: '进行中' },
  pending: { color: 'default', text: '待执行' },
  failed: { color: 'red', text: '失败' },
  skipped: { color: 'default', text: '跳过' },
};

const RUN_TAG: Record<string, { color: string; text: string }> = {
  completed: { color: 'green', text: '已完成' },
  running: { color: 'blue', text: '运行中' },
  pending: { color: 'gold', text: '待运行' },
  failed: { color: 'red', text: '失败（可续跑）' },
};

function stepCurrent(steps: FlowStep[]): number {
  const idx = steps.findIndex((s) => s.status !== 'completed' && s.status !== 'skipped');
  return idx === -1 ? steps.length : idx;
}

export function FlowAudit({
  result,
  onResume,
  resuming,
}: {
  result: ClaimFlowResult;
  onResume: () => void;
  resuming: boolean;
}) {
  const { run, steps, claim } = result;
  const incomplete = run.status !== 'completed';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Tag color={RUN_TAG[run.status]?.color}>{RUN_TAG[run.status]?.text ?? run.status}</Tag>
        {engineBadge(run.engine)}
        <span className="text-muted-foreground">cursor {run.cursor}/{steps.length}</span>
        {incomplete && (
          <Button size="sm" variant="outline" onClick={onResume} disabled={resuming} className="ml-auto">
            {resuming ? '续跑中…' : '从断点续跑'}
          </Button>
        )}
      </div>

      {run.error && (
        <div className="rounded-md border border-[#FDEBEC] bg-[#FDEBEC] p-2 text-xs text-[#9F2F2D]">
          {run.error}
        </div>
      )}

      <Steps
        direction="vertical"
        size="small"
        current={stepCurrent(steps)}
        items={steps.map((s) => ({
          title: (
            <span className="text-sm">
              {FLOW_STEP_LABELS[s.name] ?? s.name}{' '}
              <Tag color={STEP_TAG[s.status].color} className="ml-1">
                {STEP_TAG[s.status].text}
              </Tag>
            </span>
          ),
          status:
            s.status === 'completed'
              ? 'finish'
              : s.status === 'failed'
                ? 'error'
                : s.status === 'running'
                  ? 'process'
                  : 'wait',
          description: <StepOutput step={s} />,
        }))}
      />

      {claim && (
        <Card>
          <CardContent className="space-y-2 py-4">
            <div className="flex items-center gap-2">
              <Badge variant="green">已组卷索赔</Badge>
              <Badge variant={claim.type === 'time' ? 'yellow' : 'blue'}>
                {claim.type === 'time' ? '工期索赔' : '费用索赔'}
              </Badge>
              {claim.days != null && <span className="text-xs text-muted-foreground">工期 {claim.days} 天</span>}
              {claim.amount && <span className="text-xs text-muted-foreground">金额 {claim.amount}</span>}
            </div>
            {claim.basis && <p className="text-xs text-muted-foreground">依据：{claim.basis}</p>}
            {claim.narrative && (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                {claim.narrative}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StepOutput({ step }: { step: FlowStep }) {
  if (step.error) {
    return <span className="text-xs text-[#9F2F2D]">{step.error}</span>;
  }
  if (!step.output) {
    return <span className="text-xs text-muted-foreground">{formatTime(step.finishedAt)}</span>;
  }
  return (
    <pre className="mt-1 max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
      {JSON.stringify(step.output, null, 2)}
    </pre>
  );
}
