import { Empty, Tag } from 'antd';
import type { ProjectGraph } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TabProps } from '../ProjectWorkspace';

const RELATION_LABELS: Record<string, string> = {
  responds_to: '响应',
  evidenced_by: '佐证',
  about: '关于',
  derived_from: '派生自',
  basis: '依据',
  supports: '支撑',
  cited_from: '引用原文',
};

const NODE_LABELS: Record<string, string> = {
  requirement: '要求',
  commitment: '承诺',
  deviation: '偏离',
  evidence: '证据',
  change: '变更',
  claim: '索赔',
  chunk: '原文片段',
};

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}` : id;
}

/** 把一个图节点解析成简短可读标签（尽量用业务文字，回退到短 id）。 */
function nodeLabel(graph: ProjectGraph, type: string, id: string): string {
  switch (type) {
    case 'change':
      return graph.changes.find((c) => c.id === id)?.title ?? `变更 ${shortId(id)}`;
    case 'claim': {
      const c = graph.claims.find((x) => x.id === id);
      return c ? `${c.type === 'time' ? '工期' : '费用'}索赔 ${shortId(id)}` : `索赔 ${shortId(id)}`;
    }
    case 'requirement':
      return graph.requirements.find((r) => r.id === id)?.text?.slice(0, 16) ?? `要求 ${shortId(id)}`;
    case 'evidence': {
      const ev = graph.evidences.find((e) => e.id === id);
      return ev?.note?.slice(0, 16) || `证据 ${shortId(id)}`;
    }
    case 'chunk':
      return `原文 ${shortId(id)}`;
    default:
      return `${NODE_LABELS[type] ?? type} ${shortId(id)}`;
  }
}

export function GraphTab({ graph }: TabProps) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            ['requirements', '要求基线'],
            ['commitments', '承诺'],
            ['deviations', '偏离'],
            ['evidences', '证据'],
            ['changes', '变更'],
            ['claims', '索赔'],
          ] as const
        ).map(([key, label]) => (
          <Card key={key}>
            <CardContent className="px-3 py-4 text-center">
              <div className="font-mono text-xl font-semibold tabular-nums">
                {(graph[key] as unknown[]).length}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>关联图谱边（{graph.links.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {graph.links.length === 0 ? (
            <Empty description="还没有图谱边。先录文档、登记变更并触发组卷，连边会自动生成。" />
          ) : (
            <div className="space-y-2">
              {graph.links.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                >
                  <Badge variant="outline">{NODE_LABELS[l.fromType] ?? l.fromType}</Badge>
                  <span className="max-w-[180px] truncate">{nodeLabel(graph, l.fromType, l.fromId)}</span>
                  <Tag color="blue" className="mx-1">
                    {RELATION_LABELS[l.relation] ?? l.relation}
                  </Tag>
                  <Badge variant="outline">{NODE_LABELS[l.toType] ?? l.toType}</Badge>
                  <span className="max-w-[180px] truncate">{nodeLabel(graph, l.toType, l.toId)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {graph.deviations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>偏离</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {graph.deviations.map((d) => (
              <div key={d.id} className="rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="red">{d.type}</Badge>
                  {d.severity && <Badge variant="yellow">{d.severity}</Badge>}
                  <span className="text-xs text-muted-foreground">{d.detectedBy}</span>
                </div>
                <p className="mt-1">{d.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
