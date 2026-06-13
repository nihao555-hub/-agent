import { describe, expect, it } from 'vitest';
import { perCapitaOf, RuleBasedEngine } from '../src/engine/ruleBased';
import type { ShopProfile } from '../src/types';

const shop: ShopProfile = {
  name: '巷子咖啡',
  category: '咖啡饮品',
  city: '成都',
  perCapita: 30,
  highlights: ['手冲单品', '自烘豆'],
  tone: '亲切',
  contact: '微信 xiangzi-coffee',
};

describe('RuleBasedEngine.reviewReplies', () => {
  const engine = new RuleBasedEngine();

  it('给差评生成致歉+补救回复，并补齐 reviewId 与跟进建议', async () => {
    const { replies } = await engine.reviewReplies({
      shop,
      reviews: [{ rating: 1, content: '服务态度太差，等了半天还爱搭不理' }],
    });
    expect(replies).toHaveLength(1);
    const r = replies[0];
    expect(r.reviewId).toBe('r1');
    expect(r.sentiment).toBe('negative');
    expect(r.reply.length).toBeGreaterThan(10);
    expect(r.reply).toContain(shop.contact);
    expect(r.actions.length).toBeGreaterThan(0);
  });

  it('好评归类为 positive 并引导复购', async () => {
    const { replies } = await engine.reviewReplies({
      shop,
      reviews: [{ id: 'x9', rating: 5, content: '咖啡很好喝，环境也舒服' }],
    });
    expect(replies[0].reviewId).toBe('x9');
    expect(replies[0].sentiment).toBe('positive');
  });

  it('3 星归类为 neutral', async () => {
    const { replies } = await engine.reviewReplies({
      shop,
      reviews: [{ rating: 3, content: '一般般，还行吧' }],
    });
    expect(replies[0].sentiment).toBe('neutral');
  });
});

describe('RuleBasedEngine.recall', () => {
  const engine = new RuleBasedEngine();

  it('未指定分层时默认产出 3 段召回文案', async () => {
    const { scripts } = await engine.recall({ shop });
    expect(scripts).toHaveLength(3);
    for (const s of scripts) {
      expect(s.message.length).toBeGreaterThan(5);
      expect(s.bestSendTime.length).toBeGreaterThan(0);
    }
  });

  it('微信渠道去除短信式【店名】前缀', async () => {
    const { scripts } = await engine.recall({ shop, segments: ['lapsed'], channel: '微信' });
    expect(scripts[0].channel).toBe('微信');
    expect(scripts[0].message.startsWith('【')).toBe(false);
  });
});

describe('RuleBasedEngine.promotions', () => {
  const engine = new RuleBasedEngine();

  it('团购价低于原价，折扣在 (0,1) 区间', async () => {
    const { packages } = await engine.promotions({ shop, count: 3 });
    expect(packages).toHaveLength(3);
    for (const p of packages) {
      expect(p.dealPrice).toBeLessThan(p.originalPrice);
      expect(p.discount).toBeGreaterThan(0);
      expect(p.discount).toBeLessThan(1);
      expect(p.items.length).toBeGreaterThan(0);
    }
  });

  it('count 被限制在 1..tiers 范围内', async () => {
    const { packages } = await engine.promotions({ shop, count: 99 });
    expect(packages.length).toBeLessThanOrEqual(3);
    expect(packages.length).toBeGreaterThanOrEqual(1);
  });
});

describe('RuleBasedEngine.socialContent', () => {
  const engine = new RuleBasedEngine();

  it('默认产出小红书与抖音两条内容，含话题标签', async () => {
    const { posts } = await engine.socialContent({ shop });
    expect(posts.map((p) => p.platform).sort()).toEqual(['小红书', '抖音'].sort());
    for (const p of posts) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.body.length).toBeGreaterThan(0);
      expect(p.hashtags.length).toBeGreaterThan(0);
    }
  });
});

describe('perCapitaOf', () => {
  it('优先用店铺自报人均，否则回退到业态预设', () => {
    expect(perCapitaOf(shop)).toBe(30);
    expect(perCapitaOf({ name: 'x', category: '咖啡饮品' })).toBe(25);
  });
});
