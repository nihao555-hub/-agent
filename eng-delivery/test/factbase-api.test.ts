import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

const TENDER_TEXT = [
  '投标人须具备市政公用工程施工总承包二级及以上资质。',
  '',
  '投标人应提供近三年类似工程业绩不少于三项。',
].join('\n');

describe('事实底座 API（规则兜底离线模式）', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(loadConfig({ DB_PATH: ':memory:', LOG_LEVEL: 'silent' }));
  });

  it('项目全流程：建项目 → 录文档 → 抽要求 → 图谱', async () => {
    const create = await request(app).post('/api/projects').send({ name: '某地铁工程' });
    expect(create.status).toBe(201);
    const projectId = create.body.project.id as string;
    expect(create.body.project.status).toBe('bidding');

    const ingest = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .send({ type: 'tender', title: '招标文件', text: TENDER_TEXT });
    expect(ingest.status).toBe(201);
    expect(ingest.body.chunkCount).toBe(2);

    const extract = await request(app)
      .post(`/api/projects/${projectId}/extract-requirements`)
      .send({});
    expect(extract.status).toBe(200);
    expect(extract.body.engine).toBe('rule-based');
    expect(extract.body.requirements.length).toBe(2);

    const graph = await request(app).get(`/api/projects/${projectId}/graph`);
    expect(graph.status).toBe(200);
    expect(graph.body.stats.requirements).toBe(2);
    expect(graph.body.stats.documents).toBe(1);
    expect(graph.body.links.length).toBe(2);
  });

  it('带引用检索 /search 溯源到原文片段', async () => {
    const create = await request(app).post('/api/projects').send({ name: 'P' });
    const projectId = create.body.project.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .send({ type: 'tender', text: TENDER_TEXT });

    const res = await request(app)
      .post(`/api/projects/${projectId}/search`)
      .send({ query: '类似工程业绩要求', topK: 3 });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('hash');
    expect(res.body.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.body.hits[0]).toHaveProperty('score');
    expect(res.body.hits[0]).toHaveProperty('text');
  });

  it('/search 缺少 query 返回 400', async () => {
    const create = await request(app).post('/api/projects').send({ name: 'P' });
    const projectId = create.body.project.id as string;
    const res = await request(app).post(`/api/projects/${projectId}/search`).send({});
    expect(res.status).toBe(400);
  });

  it('未配 BIM 服务时 /bim 录入返回 503', async () => {
    const create = await request(app).post('/api/projects').send({ name: 'P' });
    const projectId = create.body.project.id as string;
    const res = await request(app)
      .post(`/api/projects/${projectId}/bim`)
      .send({ fileBase64: 'AAAA', fileName: 'm.ifc' });
    expect(res.status).toBe(503);
  });

  it('/bim 缺少 fileBase64 返回 400', async () => {
    const create = await request(app).post('/api/projects').send({ name: 'P' });
    const projectId = create.body.project.id as string;
    const res = await request(app).post(`/api/projects/${projectId}/bim`).send({});
    expect(res.status).toBe(400);
  });

  it('录入文档缺少 text 与 fileBase64 返回 400', async () => {
    const create = await request(app).post('/api/projects').send({ name: 'P' });
    const projectId = create.body.project.id as string;
    const res = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .send({ type: 'tender' });
    expect(res.status).toBe(400);
  });

  it('项目列表与状态流转', async () => {
    const create = await request(app).post('/api/projects').send({ name: 'P' });
    const projectId = create.body.project.id as string;

    const status = await request(app)
      .post(`/api/projects/${projectId}/status`)
      .send({ status: 'awarded' });
    expect(status.status).toBe(200);
    expect(status.body.project.status).toBe('awarded');

    const list = await request(app).get('/api/projects');
    expect(list.status).toBe(200);
    expect(list.body.projects.length).toBe(1);
  });

  it('GET 不存在的项目返回 404', async () => {
    const res = await request(app).get('/api/projects/nope/graph');
    expect(res.status).toBe(404);
  });

  it('变更→索赔组卷长流程：组卷 → 查询运行态 → 续跑幂等', async () => {
    const create = await request(app).post('/api/projects').send({ name: '某管廊工程' });
    const projectId = create.body.project.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .send({ type: 'contract', text: '因业主原因导致的工程变更，承包人有权就工期与费用提出索赔。' });

    const change = await request(app)
      .post(`/api/projects/${projectId}/changes`)
      .send({ title: '业主新增防水工序', description: '现场签证要求增加一道防水卷材' });
    expect(change.status).toBe(201);
    const changeId = change.body.change.id as string;

    const claim = await request(app).post(`/api/changes/${changeId}/claim`);
    expect(claim.status).toBe(201);
    expect(claim.body.run.status).toBe('completed');
    expect(claim.body.claim).toBeTruthy();
    expect(claim.body.claim.changeId).toBe(changeId);
    const runId = claim.body.run.id as string;

    const flow = await request(app).get(`/api/flows/${runId}`);
    expect(flow.status).toBe(200);
    expect(flow.body.steps).toHaveLength(5);

    // 已完成的 run 续跑是 no-op，仍只有一条索赔
    const resume = await request(app).post(`/api/flows/${runId}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.body.run.status).toBe('completed');
    const graph = await request(app).get(`/api/projects/${projectId}/graph`);
    expect(graph.body.claims).toHaveLength(1);
  });

  it('对不存在的变更组卷返回 404；查询不存在流程返回 404', async () => {
    const claim = await request(app).post('/api/changes/nope/claim');
    expect(claim.status).toBe(404);
    const flow = await request(app).get('/api/flows/nope');
    expect(flow.status).toBe(404);
  });
});
