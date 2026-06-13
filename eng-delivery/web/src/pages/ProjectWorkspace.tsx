import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { App, Select, Spin, Tabs } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { api } from '@/lib/api';
import type { Project, ProjectGraph, ProjectStatus } from '@/lib/types';
import { PROJECT_STATUS_LABELS, projectStatusBadge } from '@/lib/labels';
import { OverviewTab } from './tabs/OverviewTab';
import { DocumentsTab } from './tabs/DocumentsTab';
import { SearchTab } from './tabs/SearchTab';
import { ChangesTab } from './tabs/ChangesTab';
import { GraphTab } from './tabs/GraphTab';

export interface TabProps {
  project: Project;
  graph: ProjectGraph;
  reload: () => Promise<void>;
}

export function ProjectWorkspace() {
  const { id = '' } = useParams();
  const { message } = App.useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [p, g] = await Promise.all([api.getProject(id), api.getGraph(id)]);
    setProject(p);
    setGraph(g);
  }, [id]);

  useEffect(() => {
    setLoading(true);
    reload()
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [reload, message]);

  const changeStatus = async (status: ProjectStatus) => {
    try {
      await api.setStatus(id, status);
      await reload();
      message.success('状态已更新');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (loading || !project || !graph) {
    return (
      <div className="flex justify-center py-24">
        <Spin />
      </div>
    );
  }

  const tabProps: TabProps = { project, graph, reload };

  return (
    <div>
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftOutlined /> 全部项目
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          {projectStatusBadge(project.status)}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>状态流转</span>
          <Select
            size="small"
            value={project.status}
            style={{ width: 130 }}
            onChange={changeStatus}
            options={(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((s) => ({
              value: s,
              label: PROJECT_STATUS_LABELS[s],
            }))}
          />
        </div>
      </div>

      <Tabs
        defaultActiveKey="overview"
        items={[
          { key: 'overview', label: '概览', children: <OverviewTab {...tabProps} /> },
          { key: 'documents', label: '文档录入', children: <DocumentsTab {...tabProps} /> },
          { key: 'search', label: '语义检索', children: <SearchTab {...tabProps} /> },
          { key: 'changes', label: '变更 → 索赔', children: <ChangesTab {...tabProps} /> },
          { key: 'graph', label: '事实图谱', children: <GraphTab {...tabProps} /> },
        ]}
      />
    </div>
  );
}
