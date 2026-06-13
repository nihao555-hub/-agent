import { Timeline } from 'antd';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/utils';
import type { TabProps } from '../ProjectWorkspace';

const STAT_ITEMS: { key: keyof TabProps['graph']['stats']; label: string }[] = [
  { key: 'documents', label: '文档' },
  { key: 'chunks', label: '可引用片段' },
  { key: 'requirements', label: '要求基线' },
  { key: 'commitments', label: '我方承诺' },
  { key: 'deviations', label: '偏离' },
  { key: 'changes', label: '变更' },
  { key: 'claims', label: '索赔' },
];

export function OverviewTab({ project, graph }: TabProps) {
  const events = [...graph.events].reverse();
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {STAT_ITEMS.map((s) => (
            <Card key={s.key}>
              <CardContent className="px-3 py-4 text-center">
                <div className="font-mono text-2xl font-semibold tabular-nums">
                  {graph.stats[s.key]}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{s.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>主线流程</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 text-sm">
              {[
                ['录合同 / 招标文本', '切块带页码、向量化入库，成为可引用片段'],
                ['现场变更登记', '业主新增需求 → 记录一条变更'],
                ['一键触发长流程', '范围认定(RAG) → 归集依据 → 影响量化 → 起草正文 → 组卷连边'],
                ['断点续跑', '中途断电/超时，状态落库，从断点续跑且不重复出卷'],
                ['看图谱与审计', '索赔挂回哪条变更、引用了哪条合同原文，每步可审计'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[11px]">
                    {i + 1}
                  </span>
                  <div>
                    <div className="font-medium">{t}</div>
                    <div className="text-muted-foreground">{d}</div>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>项目信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="业主" value={project.client} />
            <Row label="招标人" value={project.tenderer} />
            <Row label="创建时间" value={formatTime(project.createdAt)} />
            <Row label="项目 ID" value={project.id} mono />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>事件留痕</CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无事件</p>
            ) : (
              <Timeline
                items={events.slice(0, 12).map((e) => ({
                  children: (
                    <div className="text-sm">
                      <span className="font-mono text-xs">{e.type}</span>
                      <div className="text-xs text-muted-foreground">{formatTime(e.createdAt)}</div>
                    </div>
                  ),
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'truncate font-mono text-xs' : 'truncate text-right'}>
        {value || '—'}
      </span>
    </div>
  );
}
