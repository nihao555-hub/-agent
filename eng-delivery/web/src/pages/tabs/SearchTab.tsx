import { useState } from 'react';
import { App, Empty } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { api } from '@/lib/api';
import type { SearchResult } from '@/lib/types';
import { engineBadge } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { TabProps } from '../ProjectWorkspace';

const SUGGESTIONS = [
  '因业主原因导致的变更，承包人能否就工期和费用索赔',
  '地下室外墙防水的施工与验收要求',
  '设计变更时价款如何调整',
];

export function SearchTab({ project }: TabProps) {
  const { message } = App.useApp();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (q?: string) => {
    const text = (q ?? query).trim();
    if (!text) {
      message.warning('请输入检索内容');
      return;
    }
    setQuery(text);
    setLoading(true);
    try {
      const r = await api.search(project.id, text, 5);
      setResult(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>带引用的语义检索</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
              }}
              placeholder="用自然语言提问，命中片段会溯源到页码/条款"
            />
            <Button onClick={() => run()} disabled={loading}>
              <SearchOutlined /> {loading ? '检索中' : '检索'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => run(s)}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
              >
                {s}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {result && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              命中 {result.hits.length} 条 · 查询「{result.query}」
            </span>
            {engineBadge(result.engine)}
          </div>
          {result.hits.length === 0 ? (
            <Card>
              <CardContent className="py-10">
                <Empty description="未命中片段，先在「文档录入」录入文本" />
              </CardContent>
            </Card>
          ) : (
            result.hits.map((h, i) => (
              <Card key={h.id}>
                <CardContent className="py-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">#{i + 1}</span>
                    {h.page != null && <Badge variant="blue">P{h.page}</Badge>}
                    {h.clause && <Badge variant="outline">{h.clause}</Badge>}
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      相关度 {(h.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed">{h.text}</p>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
