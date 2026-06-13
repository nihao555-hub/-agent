import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

// 不传 LLM_API_KEY → 走规则引擎，离线、确定性，便于断言。
const app = createApp(loadConfig({}));

const shop = {
  name: '巷子咖啡',
  category: '咖啡饮品',
  city: '成都',
  perCapita: 30,
  highlights: ['手冲单品'],
  contact: '微信 xiangzi-coffee',
};

describe('GET /health', () => {
  it('返回 ok 与引擎信息', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.engine).toBe('rule-based');
  });
});

describe('POST /api/reviews/reply', () => {
  it('合法请求返回逐条回复', async () => {
    const res = await request(app)
      .post('/api/reviews/reply')
      .send({ shop, reviews: [{ rating: 2, content: '上单太慢了' }] });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.replies).toHaveLength(1);
    expect(res.body.replies[0].sentiment).toBe('negative');
  });

  it('缺少 reviews 返回 400 且带字段级错误', async () => {
    const res = await request(app).post('/api/reviews/reply').send({ shop });
    expect(res.status).toBe(400);
    expect(res.body.error.status).toBe(400);
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('评分越界返回 400', async () => {
    const res = await request(app)
      .post('/api/reviews/reply')
      .send({ shop, reviews: [{ rating: 9, content: '?' }] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/recall', () => {
  it('返回召回话术', async () => {
    const res = await request(app)
      .post('/api/recall')
      .send({ shop, segments: ['lapsed', 'vip'], channel: '短信' });
    expect(res.status).toBe(200);
    expect(res.body.scripts).toHaveLength(2);
    expect(res.body.scripts[0].channel).toBe('短信');
  });
});

describe('POST /api/promotions', () => {
  it('返回套餐且团购价低于原价', async () => {
    const res = await request(app).post('/api/promotions').send({ shop, count: 2 });
    expect(res.status).toBe(200);
    expect(res.body.packages).toHaveLength(2);
    expect(res.body.packages[0].dealPrice).toBeLessThan(res.body.packages[0].originalPrice);
  });
});

describe('POST /api/content', () => {
  it('返回指定平台文案', async () => {
    const res = await request(app)
      .post('/api/content')
      .send({ shop, platforms: ['小红书'] });
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0].platform).toBe('小红书');
  });
});

describe('POST /api/analyze', () => {
  it('带评价时四个模块齐全', async () => {
    const res = await request(app)
      .post('/api/analyze')
      .send({ shop, reviews: [{ rating: 5, content: '好喝' }] });
    expect(res.status).toBe(200);
    expect(res.body.replies.length).toBe(1);
    expect(res.body.recall.length).toBeGreaterThan(0);
    expect(res.body.promotions.length).toBeGreaterThan(0);
    expect(res.body.content.length).toBeGreaterThan(0);
  });

  it('不带评价时 replies 为空数组，其余模块照常产出', async () => {
    const res = await request(app).post('/api/analyze').send({ shop });
    expect(res.status).toBe(200);
    expect(res.body.replies).toEqual([]);
    expect(res.body.promotions.length).toBeGreaterThan(0);
  });
});

describe('错误处理', () => {
  it('未知路由返回 404', async () => {
    const res = await request(app).get('/api/不存在');
    expect(res.status).toBe(404);
    expect(res.body.error.status).toBe(404);
  });

  it('非法 JSON 体返回 400', async () => {
    const res = await request(app)
      .post('/api/promotions')
      .set('Content-Type', 'application/json')
      .send('{ bad json');
    expect(res.status).toBe(400);
  });
});
