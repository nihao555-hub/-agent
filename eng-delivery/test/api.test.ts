import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

const TENDER_TEXT = [
  '投标人须具备市政公用工程施工总承包二级及以上资质。',
  '投标人应提供近三年类似工程业绩。',
  '投标截止时间为2025年7月1日9:30。',
  '未按要求提交投标保证金的按废标处理。',
].join('');

describe('eng-delivery API（规则引擎离线模式）', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp(loadConfig({ DB_PATH: ':memory:' }));
  });

  it('GET /health 返回 rule-based 引擎（未配 LLM key）', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.model).toBeNull();
    expect(res.body.storage).toBe('memory');
  });

  it('POST /api/tenders/parse 抽取要点并落库', async () => {
    const res = await request(app)
      .post('/api/tenders/parse')
      .send({ text: TENDER_TEXT, projectName: '某污水处理厂工程' });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.source).toBe('text');
    expect(typeof res.body.tenderId).toBe('string');
    expect(res.body.tender.requirements.length).toBeGreaterThan(0);
    expect(res.body.tender.disqualifications.length).toBeGreaterThan(0);
    expect(res.body.tender.milestones.length).toBeGreaterThan(0);

    const list = await request(app).get('/api/tenders');
    expect(list.status).toBe(200);
    expect(list.body.tenders.length).toBe(1);

    const single = await request(app).get(`/api/tenders/${res.body.tenderId}`);
    expect(single.status).toBe(200);
    expect(single.body.tender.requirements.length).toBeGreaterThan(0);
  });

  it('POST /api/tenders/parse 缺少 text 与 fileBase64 时返回 400', async () => {
    const res = await request(app).post('/api/tenders/parse').send({ projectName: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST /api/capabilities 登记并可读取', async () => {
    const create = await request(app)
      .post('/api/capabilities')
      .send({ companyName: '示例建工', qualifications: ['市政公用工程施工总承包一级'] });
    expect(create.status).toBe(201);
    expect(typeof create.body.id).toBe('string');

    const read = await request(app).get(`/api/capabilities/${create.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.capability.companyName).toBe('示例建工');
  });

  it('POST /api/gap-analysis 内联 tender + capability 返回逐条覆盖结论', async () => {
    const res = await request(app)
      .post('/api/gap-analysis')
      .send({
        tender: {
          projectName: '某项目',
          requirements: [
            { text: '市政公用工程施工总承包二级及以上资质', mandatory: true },
            { text: '近三年类似工程业绩', mandatory: false },
          ],
        },
        capability: {
          companyName: '示例建工',
          qualifications: ['市政公用工程施工总承包一级'],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.report.findings.length).toBe(2);
    expect(typeof res.body.report.readiness).toBe('number');
  });

  it('POST /api/gap-analysis 缺少 capability 时返回 400', async () => {
    const res = await request(app)
      .post('/api/gap-analysis')
      .send({ tender: { requirements: [{ text: 'x' }] } });
    expect(res.status).toBe(400);
  });

  it('POST /api/compliance-check 列出需核验项（capability 可选）', async () => {
    const res = await request(app)
      .post('/api/compliance-check')
      .send({
        tender: {
          requirements: [{ text: '强制项A', mandatory: true }],
          disqualifications: [{ text: '未交保证金按废标处理' }],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.report.findings.length).toBeGreaterThan(0);
    expect(res.body.report.disqualificationRisks.length).toBe(1);
  });

  it('POST /api/analyze 端到端：解析 + 缺口 + 合规，并留痕', async () => {
    const res = await request(app)
      .post('/api/analyze')
      .send({
        text: TENDER_TEXT,
        projectName: '某污水处理厂工程',
        capability: { companyName: '示例建工', qualifications: ['市政公用工程施工总承包一级'] },
      });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.tender.requirements.length).toBeGreaterThan(0);
    expect(res.body.gap).toBeDefined();
    expect(res.body.compliance).toBeDefined();

    const analyses = await request(app).get(`/api/tenders/${res.body.tenderId}/analyses`);
    expect(analyses.status).toBe(200);
    expect(analyses.body.analyses.length).toBeGreaterThan(0);
    // 事件链：解析 + 缺口 + 合规
    expect(analyses.body.events.length).toBeGreaterThanOrEqual(3);
  });

  it('GET 不存在的招标文件返回 404', async () => {
    const res = await request(app).get('/api/tenders/not-exist');
    expect(res.status).toBe(404);
  });

  it('未知路由返回 404', async () => {
    const res = await request(app).get('/api/unknown');
    expect(res.status).toBe(404);
  });
});
