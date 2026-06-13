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
});
