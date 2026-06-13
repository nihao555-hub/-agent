import type {
  PromotionPackage,
  RecallChannel,
  RecallScript,
  RecallSegmentKey,
  Review,
  ReviewReply,
  Sentiment,
  ShopCategory,
  ShopProfile,
  SocialContent,
  SocialPlatform,
  Tone,
} from '../types';
import type {
  ContentEngine,
  ContentRequest,
  ContentResult,
  PromotionRequest,
  PromotionResult,
  RecallRequest,
  RecallResult,
  ReviewReplyRequest,
  ReviewReplyResult,
} from './types';

interface CategoryPreset {
  /** 默认人均(元) */
  perCapita: number;
  /** 招牌项名称 */
  signature: string;
  /** 到店动作动词，如"用餐""体验" */
  visitNoun: string;
  /** 常见消费项，用于套餐拼装 */
  items: string[];
  /** 复购优惠钩子 */
  offer: string;
}

const CATEGORY_PRESETS: Record<ShopCategory, CategoryPreset> = {
  餐饮: {
    perCapita: 60,
    signature: '招牌菜',
    visitNoun: '用餐',
    items: ['招牌硬菜', '人气小炒', '招牌例汤', '时令蔬菜', '米饭/主食'],
    offer: '到店送一道招牌例汤',
  },
  咖啡饮品: {
    perCapita: 25,
    signature: '招牌拿铁',
    visitNoun: '到店',
    items: ['招牌咖啡', '季节限定饮品', '手工甜点'],
    offer: '第二杯半价',
  },
  烘焙甜品: {
    perCapita: 35,
    signature: '招牌蛋糕',
    visitNoun: '到店',
    items: ['当日现烤面包', '招牌蛋糕', '人气小点'],
    offer: '满 50 元送一只可颂',
  },
  美业丽人: {
    perCapita: 168,
    signature: '招牌护理',
    visitNoun: '体验',
    items: ['深层清洁护理', '头部按摩', '肩颈放松'],
    offer: '老客回购享 8 折',
  },
  健身运动: {
    perCapita: 150,
    signature: '私教体验课',
    visitNoun: '训练',
    items: ['体能评估', '私教课', '团课体验'],
    offer: '带朋友同练各得一节课',
  },
  零售: {
    perCapita: 80,
    signature: '热卖单品',
    visitNoun: '选购',
    items: ['人气热卖', '新品上架', '搭配好物'],
    offer: '会员日全场 9 折',
  },
  教育培训: {
    perCapita: 200,
    signature: '体验课',
    visitNoun: '上课',
    items: ['1 对 1 测评', '体验课', '阶段测评'],
    offer: '老学员转介绍各减学费',
  },
  休闲娱乐: {
    perCapita: 88,
    signature: '招牌套餐',
    visitNoun: '游玩',
    items: ['双人畅玩', '招牌项目', '小吃饮品'],
    offer: '工作日到店享 7 折',
  },
  医疗健康: {
    perCapita: 120,
    signature: '检查套餐',
    visitNoun: '到院',
    items: ['基础检查', '专项评估', '健康咨询'],
    offer: '复诊免挂号费',
  },
  酒店民宿: {
    perCapita: 320,
    signature: '招牌房型',
    visitNoun: '入住',
    items: ['招牌房型一晚', '双人早餐', '延迟退房'],
    offer: '直订享会员价并升房',
  },
  其他: {
    perCapita: 80,
    signature: '招牌服务',
    visitNoun: '到店',
    items: ['招牌服务', '人气项目', '增值服务'],
    offer: '老客回购享专属优惠',
  },
};

export const SEGMENT_LABELS: Record<RecallSegmentKey, string> = {
  lapsed: '流失老客（30 天以上未到店）',
  sleeping: '沉睡会员（90 天以上未消费）',
  new_to_repeat: '新客二次转化（仅到店 1 次）',
  birthday: '生日关怀',
  vip: '高价值常客',
};

function presetFor(shop: ShopProfile): CategoryPreset {
  return CATEGORY_PRESETS[shop.category] ?? CATEGORY_PRESETS['其他'];
}

export function perCapitaOf(shop: ShopProfile): number {
  if (typeof shop.perCapita === 'number' && shop.perCapita > 0) return shop.perCapita;
  return presetFor(shop).perCapita;
}

function money(n: number): number {
  return Math.max(1, Math.round(n));
}

function classify(rating: number): Sentiment {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'neutral';
  return 'negative';
}

interface AspectHit {
  key: string;
  label: string;
}

const ASPECT_RULES: { key: string; label: string; keywords: string[] }[] = [
  {
    key: 'taste',
    label: '口味',
    keywords: ['难吃', '不好吃', '太咸', '太淡', '味道', '口味', '好吃'],
  },
  {
    key: 'service',
    label: '服务态度',
    keywords: ['服务', '态度', '冷漠', '爱搭不理', '热情', '店员'],
  },
  { key: 'wait', label: '出餐/等待', keywords: ['等', '慢', '排队', '上菜', '等位', '催'] },
  {
    key: 'hygiene',
    label: '环境卫生',
    keywords: ['脏', '卫生', '苍蝇', '头发', '不干净', '干净', '环境'],
  },
  { key: 'price', label: '价格', keywords: ['贵', '价格', '性价比', '划算', '不值'] },
];

function detectAspects(content: string): AspectHit[] {
  const hits: AspectHit[] = [];
  for (const rule of ASPECT_RULES) {
    if (rule.keywords.some((k) => content.includes(k))) {
      hits.push({ key: rule.key, label: rule.label });
    }
  }
  return hits;
}

function toneOpener(tone: Tone, name: string): string {
  switch (tone) {
    case '专业':
      return `感谢您选择${name}，并抽空留下宝贵反馈。`;
    case '活泼':
      return `亲~ 谢谢你来${name}打卡，也谢谢你留言！`;
    case '简洁':
      return `感谢您的反馈。`;
    case '亲切':
    default:
      return `谢谢您来${name}，也谢谢您特意留下评价。`;
  }
}

function buildReply(shop: ShopProfile, review: Review, sentiment: Sentiment): ReviewReply {
  const tone = shop.tone ?? '亲切';
  const preset = presetFor(shop);
  const aspects = detectAspects(review.content);
  const opener = toneOpener(tone, shop.name);
  const highlight = shop.highlights?.[0] ?? preset.signature;

  let reply: string;
  const actions: string[] = [];

  if (sentiment === 'positive') {
    const aspectPraise =
      aspects.length > 0
        ? `您提到的${aspects.map((a) => a.label).join('、')}，正是我们日常最用心打磨的地方。`
        : '';
    reply = `${opener}${aspectPraise}下次来记得试试我们的${highlight}，我们会一直保持这份用心，期待与您再次相见！`;
    actions.push('置顶/精选该好评，作为口碑展示', '邀请顾客加会员或社群，沉淀为复购客');
  } else if (sentiment === 'neutral') {
    const aspectNote =
      aspects.length > 0
        ? `您提到的${aspects.map((a) => a.label).join('、')}我们已记录，会马上复盘改进。`
        : '我们会继续打磨细节，争取下次让您打满分。';
    reply = `${opener}${aspectNote}诚挚邀请您再给我们一次机会，下次到店报一声，由店长为您安排，期待把体验做得更好。`;
    actions.push('内部复盘顾客提到的不足项', '发放小额回头券，争取二次到店');
  } else {
    const aspectApology =
      aspects.length > 0
        ? `关于您反映的${aspects.map((a) => a.label).join('、')}问题，是我们没有做好，给您添麻烦了。`
        : '这次体验没能让您满意，是我们的责任。';
    reply = `${opener}${aspectApology}我们已第一时间安排核查与整改。方便的话请通过${shop.contact ?? '门店电话/微信'}联系店长，我们想当面致歉并为您补偿，也真心希望有机会重新赢回您的认可。`;
    actions.push(
      '店长 24 小时内私下联系顾客致歉',
      '核查并整改顾客反映的问题',
      '提供补偿（退款/重做/补偿券），争取删改差评',
    );
  }

  return {
    reviewId: review.id ?? '',
    rating: review.rating,
    sentiment,
    reply,
    actions,
  };
}

function recallMessage(
  shop: ShopProfile,
  segment: RecallSegmentKey,
  channel: RecallChannel,
): RecallScript {
  const preset = presetFor(shop);
  const name = shop.name;
  const cta = shop.contact ?? '回复本条或到店出示即可';
  let message: string;
  let bestSendTime: string;
  let offer: string | undefined;

  switch (segment) {
    case 'lapsed':
      offer = preset.offer;
      message = `【${name}】好久不见，想您啦~ 这段时间我们上新了${preset.signature}，特地为老朋友留了福利：${offer}。这周抽空来坐坐？${cta}。`;
      bestSendTime = '周四或周五 11:00 / 17:00（餐前决策窗口）';
      break;
    case 'sleeping':
      offer = '专属唤醒礼：到店立减 20 元';
      message = `【${name}】许久未见，我们很挂念您。送您一份${offer}（30 天内有效），就想请您回来再${preset.visitNoun}一次。${cta}。`;
      bestSendTime = '周末上午 10:00（休闲计划时段）';
      break;
    case 'new_to_repeat':
      offer = '第二次到店专享 8 折';
      message = `【${name}】感谢上次的光临！不知道这次体验您还满意吗？我们准备了${offer}，期待很快再见到您。${cta}。`;
      bestSendTime = '首次到店后第 3 天 19:00';
      break;
    case 'birthday':
      offer = '生日当月到店送招牌好礼一份';
      message = `【${name}】祝您生日快乐！这个月到店，${offer}，愿您被温柔以待。${cta}。`;
      bestSendTime = '生日当天 09:00';
      break;
    case 'vip':
      offer = '常客专属：优先预约 + 隐藏菜单/服务';
      message = `【${name}】谢谢您一直以来的偏爱~ 作为我们的常客，为您开通${offer}。下次来提前说一声，由店长亲自安排。${cta}。`;
      bestSendTime = '周中 15:00（非高峰，便于沟通）';
      break;
    default:
      offer = preset.offer;
      message = `【${name}】想您啦，欢迎回来再${preset.visitNoun}一次，福利已为您备好：${offer}。${cta}。`;
      bestSendTime = '周五 17:00';
  }

  // 微信渠道可更口语、可加表情位（此处保持纯文本，便于直接复制发送）
  if (channel === '微信') {
    message = message.replace(/^【.*?】/, '').trim();
    message = `Hi~ ${message}`;
  }

  return { segment, segmentLabel: SEGMENT_LABELS[segment], channel, message, bestSendTime, offer };
}

function buildPromotions(shop: ShopProfile, count: number): PromotionPackage[] {
  const preset = presetFor(shop);
  const pc = perCapitaOf(shop);
  const tiers: {
    name: string;
    people: number;
    itemCount: number;
    discount: number;
    scenario: string;
  }[] = [
    {
      name: `${shop.name}单人尝鲜套餐`,
      people: 1,
      itemCount: 2,
      discount: 0.8,
      scenario: '吸引新客低门槛尝鲜、提升点评曝光',
    },
    {
      name: `${shop.name}双人优享套餐`,
      people: 2,
      itemCount: 3,
      discount: 0.82,
      scenario: '情侣/朋友到店的主力走量套餐',
    },
    {
      name: `${shop.name}欢聚${preset.visitNoun}套餐`,
      people: 4,
      itemCount: 5,
      discount: 0.78,
      scenario: '家庭/小聚客单价拉升，凑单更划算',
    },
  ];

  return tiers.slice(0, Math.max(1, Math.min(count, tiers.length))).map((tier) => {
    const items = preset.items.slice(0, tier.itemCount);
    if (items.length < tier.itemCount) {
      items.push(`${preset.signature} x${tier.itemCount - items.length}`);
    }
    const original = money(pc * tier.people * 1.15);
    const deal = money(original * tier.discount);
    return {
      name: tier.name,
      items: tier.people > 1 ? [...items, `适合 ${tier.people} 人`] : items,
      originalPrice: original,
      dealPrice: deal,
      discount: Math.round((deal / original) * 100) / 100,
      targetScenario: tier.scenario,
      rationale: `按人均约 ${pc} 元、${tier.people} 人测算，原价 ${original} 元、团购价 ${deal} 元（约 ${(
        (deal / original) *
        10
      ).toFixed(1)} 折）。让利控制在毛利可承受区间，用低价套餐换取到店流量、点评与复购。`,
    };
  });
}

function buildSocial(shop: ShopProfile, platform: SocialPlatform, topic?: string): SocialContent {
  const preset = presetFor(shop);
  const city = shop.city ? `${shop.city}` : '本地';
  const highlight = shop.highlights?.[0] ?? preset.signature;
  const theme = topic ?? `${highlight}`;

  if (platform === '小红书') {
    return {
      platform,
      title: `${city}藏不住了！这家${shop.category}的${theme}也太顶了吧`,
      body: `最近翻到一家宝藏小店——${shop.name}${shop.address ? `（${shop.address}）` : ''}。\n主打的${highlight}是真的戳中我，${
        shop.targetCustomers ? `${shop.targetCustomers}` : '喜欢探店的姐妹'
      }闭眼冲。\n人均${perCapitaOf(shop)}左右，性价比在线，环境也很出片。\n做了攻略给你们：进店先点${preset.signature}，再按需搭配，体验拉满。\n${
        shop.contact ? `想去的扣个『${shop.name}』，地址私我~` : '坐标已标好，自己冲！'
      }`,
      hashtags: [city + '美食', shop.category, '探店', '宝藏小店', highlight],
      tips: '配 3-6 张实拍图，首图突出招牌项与门头；标题前 20 字埋城市+品类关键词利于被搜到。',
    };
  }
  return {
    platform,
    title: `${city}人速看｜${shop.name}的${theme}，我先冲为敬`,
    body: `3 秒带你看${city}这家${shop.category}！\n招牌${highlight}一上桌就出片，\n人均才${perCapitaOf(
      shop,
    )}左右，到店${preset.visitNoun}体验感拉满。\n${preset.offer}，划算到我想二刷。\n${
      shop.address ? `地址：${shop.address}，` : ''
    }想去的评论区扣『想吃』，安排！`,
    hashtags: [city + '探店', shop.category, '本地生活', shop.name],
    tips: '前 3 秒用招牌项特写抓眼球；竖屏拍摄，加门店定位与团购挂载，引导评论区互动提升推荐。',
  };
}

/**
 * 规则引擎：确定性、无需联网、无需任何 API Key。
 * 既作为大模型不可用时的兜底，也用于单测与离线演示。
 */
export class RuleBasedEngine implements ContentEngine {
  readonly name = 'rule-based';

  async reviewReplies(req: ReviewReplyRequest): Promise<ReviewReplyResult> {
    const replies = req.reviews.map((raw, idx) => {
      const review: Review = { ...raw, id: raw.id ?? `r${idx + 1}` };
      return buildReply(req.shop, review, classify(review.rating));
    });
    return { replies };
  }

  async recall(req: RecallRequest): Promise<RecallResult> {
    const segments: RecallSegmentKey[] =
      req.segments && req.segments.length > 0
        ? req.segments
        : ['lapsed', 'sleeping', 'new_to_repeat'];
    const channel: RecallChannel = req.channel ?? '微信';
    const scripts = segments.map((seg) => recallMessage(req.shop, seg, channel));
    return { scripts };
  }

  async promotions(req: PromotionRequest): Promise<PromotionResult> {
    return { packages: buildPromotions(req.shop, req.count ?? 3) };
  }

  async socialContent(req: ContentRequest): Promise<ContentResult> {
    const platforms: SocialPlatform[] =
      req.platforms && req.platforms.length > 0 ? req.platforms : ['小红书', '抖音'];
    const posts = platforms.map((p) => buildSocial(req.shop, p, req.topic));
    return { posts };
  }
}
