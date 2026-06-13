import type {
  Change,
  ClaimFlowResult,
  DocumentType,
  Health,
  IngestResult,
  InScope,
  Project,
  ProjectGraph,
  ProjectStatus,
  SearchResult,
} from './types';

/** 统一的后端调用封装：所有推理/组卷都在后端 agent，前端只负责调用与展示。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message =
      (body && (body.message || body.error)) || `请求失败：${res.status} ${res.statusText}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/health'),

  listProjects: () => request<{ projects: Project[] }>('/api/projects').then((r) => r.projects),

  getProject: (id: string) =>
    request<{ project: Project }>(`/api/projects/${id}`).then((r) => r.project),

  createProject: (input: { name: string; tenderer?: string; client?: string; status?: ProjectStatus }) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.project),

  setStatus: (id: string, status: ProjectStatus) =>
    request<{ project: Project }>(`/api/projects/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }).then((r) => r.project),

  ingestDocument: (
    projectId: string,
    input: { type: DocumentType; title?: string; source?: string; text: string },
  ) =>
    request<IngestResult>(`/api/projects/${projectId}/documents`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  search: (projectId: string, query: string, topK = 5) =>
    request<SearchResult>(`/api/projects/${projectId}/search`, {
      method: 'POST',
      body: JSON.stringify({ query, topK }),
    }),

  recordChange: (
    projectId: string,
    input: { title: string; description?: string; inScope?: InScope; costImpact?: string; timeImpact?: string },
  ) =>
    request<{ change: Change }>(`/api/projects/${projectId}/changes`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.change),

  assembleClaim: (changeId: string) =>
    request<ClaimFlowResult>(`/api/changes/${changeId}/claim`, { method: 'POST' }),

  resumeFlow: (runId: string) =>
    request<ClaimFlowResult>(`/api/flows/${runId}/resume`, { method: 'POST' }),

  getFlow: (runId: string) => request<ClaimFlowResult>(`/api/flows/${runId}`),

  getGraph: (projectId: string) => request<ProjectGraph>(`/api/projects/${projectId}/graph`),

  extractRequirements: (projectId: string, documentId?: string) =>
    request<{ engine: string; requirements: unknown[] }>(
      `/api/projects/${projectId}/extract-requirements`,
      { method: 'POST', body: JSON.stringify(documentId ? { documentId } : {}) },
    ),
};
