import { afterEach, describe, expect, it, vi } from 'vitest';
import { RagflowRetriever } from '../src/factbase/ragflow';
import type { Chunk } from '../src/factbase/types';

function chunk(partial: Partial<Chunk> & { id: string; text: string }): Chunk {
  return {
    documentId: 'doc-1',
    projectId: 'proj-1',
    ordinal: 0,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeRetriever() {
  return new RagflowRetriever({
    baseUrl: 'http://ragflow.local',
    apiKey: 'key-123',
    datasetId: 'ds-1',
    timeoutMs: 5000,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RagflowRetriever', () => {
  it('入库：删除同名旧文档→建占位文档→逐 chunk 写入并把本地 id/页码/条款编码进 keywords', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (method === 'GET') return jsonResponse({ code: 0, data: { docs: [] } });
      if (method === 'POST' && url.endsWith('/documents')) {
        return jsonResponse({ code: 0, data: [{ id: 'rdoc-1', name: 'proj-1__doc-1__t.txt' }] });
      }
      return jsonResponse({ code: 0, data: { chunk: { id: 'rc-1' } } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await makeRetriever().index({
      projectId: 'proj-1',
      documentId: 'doc-1',
      documentTitle: '合同',
      chunks: [
        chunk({ id: 'local-aaa', text: '承包人有权就工期与费用索赔', page: 3, clause: '5.1' }),
        chunk({ id: 'local-bbb', text: '无页码片段' }),
      ],
    });

    const addChunkCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/chunks'));
    expect(addChunkCalls.length).toBe(2);
    expect(addChunkCalls[0].body).toMatchObject({
      content: '承包人有权就工期与费用索赔',
      important_keywords: ['lcid:local-aaa', 'pg:3', 'cl:5.1'],
    });
    expect(addChunkCalls[1].body).toMatchObject({
      content: '无页码片段',
      important_keywords: ['lcid:local-bbb'],
    });
  });

  it('检索：按项目名前缀缩小文档范围，命中从 keywords 还原本地 chunk id/页码/条款', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse({
          code: 0,
          data: {
            docs: [
              { id: 'rdoc-1', name: 'proj-1__doc-1__t.txt' },
              { id: 'rdoc-x', name: 'other-proj__doc-9__x.txt' },
            ],
          },
        });
      }
      // retrieval
      const body = JSON.parse(init.body as string);
      expect(body.document_ids).toEqual(['rdoc-1']);
      expect(body.dataset_ids).toEqual(['ds-1']);
      return jsonResponse({
        code: 0,
        data: {
          chunks: [
            {
              content: '承包人有权就工期与费用索赔',
              document_id: 'rdoc-1',
              important_keywords: ['lcid:local-aaa', 'pg:3', 'cl:5.1'],
              similarity: 0.84,
            },
          ],
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const hits = await makeRetriever().retrieve({
      projectId: 'proj-1',
      query: '索赔',
      topK: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      localChunkId: 'local-aaa',
      page: 3,
      clause: '5.1',
      text: '承包人有权就工期与费用索赔',
      score: 0.84,
    });
  });

  it('检索：项目无对应文档时直接返回空（不调用 /retrieval）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: { docs: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const hits = await makeRetriever().retrieve({ projectId: 'empty', query: 'q', topK: 3 });
    expect(hits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('RAGFlow 返回非零 code 时抛错（由调用方回退内置检索）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 100, message: 'boom', data: null }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeRetriever().retrieve({ projectId: 'p', query: 'q', topK: 3 })).rejects.toThrow(
      /boom/,
    );
  });
});
