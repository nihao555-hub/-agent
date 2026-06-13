import { useState } from 'react';
import { App, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '@/lib/api';
import type { Chunk, DocumentType, IngestResult, ProjectDocument } from '@/lib/types';
import { DOC_TYPE_LABELS } from '@/lib/labels';
import { formatTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { TabProps } from '../ProjectWorkspace';

const SAMPLE_CONTRACT = `第7.2条 工程变更：因业主原因导致的变更，承包人有权就由此引起的工期顺延与费用增加提出索赔，并应在变更发生后14日内提交书面索赔意向。
第7.5条 地下室外墙防水按设计图纸及现行国家规范施工，验收合格后方可隐蔽。
第9.1条 价款调整：发生设计变更或业主新增工作内容时，按合同约定的综合单价或经审定的签证据实结算。`;

export function DocumentsTab({ project, graph, reload }: TabProps) {
  const { message } = App.useApp();
  const [type, setType] = useState<DocumentType>('contract');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<IngestResult | null>(null);

  const submit = async () => {
    if (!text.trim()) {
      message.warning('请粘贴文档纯文本');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.ingestDocument(project.id, {
        type,
        title: title.trim() || undefined,
        text: text.trim(),
      });
      setLastResult(result);
      message.success(`已录入并切块 ${result.chunkCount} 个可引用片段`);
      setText('');
      setTitle('');
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const docColumns: ColumnsType<ProjectDocument> = [
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (t: DocumentType) => <Badge variant="outline">{DOC_TYPE_LABELS[t]}</Badge>,
    },
    { title: '标题', dataIndex: 'title', render: (v: string) => v || <span className="text-muted-foreground">未命名</span> },
    {
      title: '解析',
      dataIndex: 'parsed',
      width: 80,
      render: (p: boolean) =>
        p ? <Badge variant="green">已解析</Badge> : <Badge variant="yellow">未解析</Badge>,
    },
    { title: '录入时间', dataIndex: 'createdAt', width: 180, render: formatTime },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>录入文档</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>文档类型</Label>
              <Select
                value={type}
                onChange={setType}
                className="w-full"
                options={(Object.keys(DOC_TYPE_LABELS) as DocumentType[]).map((t) => ({
                  value: t,
                  label: DOC_TYPE_LABELS[t],
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="title">标题（选填）</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：施工合同" />
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>文档纯文本</Label>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  setType('contract');
                  setTitle('施工合同（示例）');
                  setText(SAMPLE_CONTRACT);
                }}
              >
                填入示例合同
              </button>
            </div>
            <Textarea
              rows={9}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="粘贴合同 / 招标 / 规范文本…切块时会保留页码/条款，便于检索溯源"
            />
          </div>
          <Button onClick={submit} disabled={submitting} className="w-full">
            {submitting ? '解析入库中…' : '录入并切块向量化'}
          </Button>

          {lastResult && (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <div className="mb-2 text-xs text-muted-foreground">
                最近录入：切块 {lastResult.chunkCount} 个片段（前 3 条预览）
              </div>
              <div className="space-y-2">
                {lastResult.chunks.slice(0, 3).map((c: Chunk) => (
                  <div key={c.id} className="rounded border border-border bg-card p-2 text-xs">
                    <div className="mb-1 flex gap-1.5">
                      {c.page != null && <Badge variant="blue">P{c.page}</Badge>}
                      {c.clause && <Badge variant="outline">{c.clause}</Badge>}
                    </div>
                    <p className="line-clamp-3 leading-relaxed">{c.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>已录文档（{graph.documents.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            columns={docColumns}
            dataSource={graph.documents}
            locale={{ emptyText: '还没有文档' }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
