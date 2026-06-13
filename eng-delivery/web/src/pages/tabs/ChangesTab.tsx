import { useState } from 'react';
import { App, Drawer, Empty, Select, Table } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '@/lib/api';
import type { Change, ClaimFlowResult, InScope } from '@/lib/types';
import { IN_SCOPE_LABELS, inScopeBadge } from '@/lib/labels';
import { formatTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FlowAudit } from '@/components/FlowAudit';
import type { TabProps } from '../ProjectWorkspace';

export function ChangesTab({ project, graph, reload }: TabProps) {
  const { message } = App.useApp();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [inScope, setInScope] = useState<InScope>('uncertain');
  const [submitting, setSubmitting] = useState(false);

  // 本会话内触发过的流程，按变更 id 缓存运行视图（含可续跑的 runId）。
  const [flows, setFlows] = useState<Record<string, ClaimFlowResult>>({});
  const [drawerChangeId, setDrawerChangeId] = useState<string | null>(null);
  const [busyChangeId, setBusyChangeId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  const record = async () => {
    if (!title.trim()) {
      message.warning('请填写变更标题');
      return;
    }
    setSubmitting(true);
    try {
      await api.recordChange(project.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        inScope,
      });
      message.success('变更已记录');
      setTitle('');
      setDescription('');
      setInScope('uncertain');
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const triggerClaim = async (change: Change) => {
    setBusyChangeId(change.id);
    message.loading({ content: '长流程运行中：范围认定 → 归集依据 → 影响量化 → 起草正文 → 组卷…', key: 'claim', duration: 0 });
    try {
      const result = await api.assembleClaim(change.id);
      setFlows((f) => ({ ...f, [change.id]: result }));
      setDrawerChangeId(change.id);
      message.success({ content: result.run.status === 'completed' ? '组卷完成' : '流程已停在断点，可续跑', key: 'claim' });
      await reload();
    } catch (e) {
      message.error({ content: (e as Error).message, key: 'claim' });
    } finally {
      setBusyChangeId(null);
    }
  };

  const resume = async () => {
    if (!drawerChangeId) return;
    const current = flows[drawerChangeId];
    if (!current) return;
    setResuming(true);
    try {
      const result = await api.resumeFlow(current.run.id);
      setFlows((f) => ({ ...f, [drawerChangeId]: result }));
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setResuming(false);
    }
  };

  const claimFor = (changeId: string) => graph.claims.find((c) => c.changeId === changeId);

  const columns: ColumnsType<Change> = [
    {
      title: '变更',
      dataIndex: 'title',
      render: (t: string, row) => (
        <div>
          <div className="font-medium">{t}</div>
          {row.description && (
            <div className="line-clamp-1 text-xs text-muted-foreground">{row.description}</div>
          )}
        </div>
      ),
    },
    {
      title: '范围认定',
      dataIndex: 'inScope',
      width: 100,
      render: (s: InScope) => inScopeBadge(s),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (s: string, row) =>
        claimFor(row.id) ? <Badge variant="green">已组卷</Badge> : <Badge variant="outline">{s}</Badge>,
    },
    {
      title: '操作',
      width: 150,
      render: (_, row) => {
        const hasClaim = Boolean(claimFor(row.id)) || Boolean(flows[row.id]);
        return (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={hasClaim ? 'outline' : 'default'}
              disabled={busyChangeId === row.id}
              onClick={() => (flows[row.id] ? setDrawerChangeId(row.id) : triggerClaim(row))}
            >
              <ThunderboltOutlined />
              {busyChangeId === row.id ? '运行中' : flows[row.id] ? '查看流程' : '触发组卷'}
            </Button>
          </div>
        );
      },
    },
  ];

  const drawerResult = drawerChangeId ? flows[drawerChangeId] : null;
  const drawerClaim = drawerChangeId ? claimFor(drawerChangeId) : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>登记现场变更</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ctitle">变更标题</Label>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  setTitle('业主要求新增地下室外墙 SBS 防水');
                  setDescription('因业主在施工阶段提出新增地下室外墙 SBS 改性沥青防水层，原合同范围未含此项，需评估工期与费用影响。');
                }}
              >
                填入示例变更
              </button>
            </div>
            <Input id="ctitle" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：业主新增地下室外墙防水" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cdesc">变更描述</Label>
            <Textarea id="cdesc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="现场情况、业主要求、原合同是否覆盖…" />
          </div>
          <div className="space-y-1.5">
            <Label>初判范围</Label>
            <Select
              value={inScope}
              onChange={setInScope}
              className="w-full"
              options={(Object.keys(IN_SCOPE_LABELS) as InScope[]).map((s) => ({
                value: s,
                label: IN_SCOPE_LABELS[s],
              }))}
            />
          </div>
          <Button className="w-full" onClick={record} disabled={submitting}>
            {submitting ? '记录中…' : '记录变更'}
          </Button>
          <p className="text-xs text-muted-foreground">
            记录后在右侧「触发组卷」，后端 agent 会跑完整长流程并自动建立索赔、连边、可断点续跑。
          </p>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>变更与组卷（{graph.changes.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {graph.changes.length === 0 ? (
            <Empty description="还没有变更，先在左侧登记一条" />
          ) : (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              columns={columns}
              dataSource={graph.changes}
            />
          )}
        </CardContent>
      </Card>

      <Drawer
        title="变更 → 索赔 长流程审计"
        width={560}
        open={Boolean(drawerChangeId)}
        onClose={() => setDrawerChangeId(null)}
      >
        {drawerResult ? (
          <FlowAudit result={drawerResult} onResume={resume} resuming={resuming} />
        ) : drawerClaim ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              本变更已组卷（来自历史运行）。实时分步审计在本会话内触发时可见；以下为已生成的索赔。
            </p>
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap">
              {drawerClaim.narrative || '（无正文）'}
            </div>
            <div className="text-xs text-muted-foreground">
              依据：{drawerClaim.basis || '—'} · 创建于 {formatTime(drawerClaim.createdAt)}
            </div>
          </div>
        ) : (
          <Empty description="暂无流程" />
        )}
      </Drawer>
    </div>
  );
}
