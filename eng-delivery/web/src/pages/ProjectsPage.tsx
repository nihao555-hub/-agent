import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { App, Empty, Spin } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { formatTime } from '@/lib/utils';
import { projectStatusBadge } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ProjectsPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [tenderer, setTenderer] = useState('');
  const [client, setClient] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => message.error(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!name.trim()) {
      message.warning('请填写项目名称');
      return;
    }
    setCreating(true);
    try {
      const p = await api.createProject({
        name: name.trim(),
        tenderer: tenderer.trim() || undefined,
        client: client.trim() || undefined,
      });
      message.success('项目已创建');
      navigate(`/projects/${p.id}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">项目</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              每个项目是一座事实底座：录入合同/招标/变更，沉淀可追溯、带原文出处的事实图谱。
            </p>
          </div>
          <span className="text-sm text-muted-foreground">{projects.length} 个</span>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Spin />
          </div>
        ) : projects.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <Empty description="还没有项目，先在右侧新建一个" />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {projects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{p.name}</span>
                        {projectStatusBadge(p.status)}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {p.client ? `业主：${p.client}` : '业主未填'}
                        {p.tenderer ? ` · 招标人：${p.tenderer}` : ''}
                        {` · 创建于 ${formatTime(p.createdAt)}`}
                      </div>
                    </div>
                    <ArrowRightOutlined className="text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div>
        <Card>
          <CardHeader>
            <CardTitle>新建项目</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">项目名称</Label>
              <Input
                id="name"
                placeholder="如：某污水处理厂 EPC 工程"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="client">业主 / 发包人</Label>
              <Input
                id="client"
                placeholder="选填"
                value={client}
                onChange={(e) => setClient(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tenderer">招标人 / 代理</Label>
              <Input
                id="tenderer"
                placeholder="选填"
                value={tenderer}
                onChange={(e) => setTenderer(e.target.value)}
              />
            </div>
            <Button className="w-full" onClick={create} disabled={creating}>
              {creating ? '创建中…' : '创建项目'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
