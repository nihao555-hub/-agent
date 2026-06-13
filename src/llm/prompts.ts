import type { RecallChannel, Review, ShopProfile, SocialPlatform } from '../types';

export const SYSTEM_PROMPT = `你是"AI店小二"，专为中国本地实体小店（餐饮/美业/零售/生活服务）做口碑与复购运营的资深专家。
要求：
1. 只输出 JSON，不要任何解释、前后缀或 markdown 代码块。
2. 全部使用简体中文，文案自然、口语、可直接复制使用；避免空话套话、避免夸大与医疗/绝对化用语。
3. 严格按用户给定的 JSON 结构与字段名输出，不要增删字段，数组顺序与数量与输入保持一致。`;

export function shopBlock(shop: ShopProfile): string {
  return [
    `店名：${shop.name}`,
    `业态：${shop.category}`,
    shop.city ? `城市：${shop.city}` : '',
    shop.address ? `地址：${shop.address}` : '',
    typeof shop.perCapita === 'number' ? `人均：${shop.perCapita} 元` : '',
    shop.highlights?.length ? `卖点：${shop.highlights.join('、')}` : '',
    shop.targetCustomers ? `目标客群：${shop.targetCustomers}` : '',
    shop.tone ? `语气：${shop.tone}` : '',
    shop.contact ? `联系方式：${shop.contact}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function reviewReplyUser(shop: ShopProfile, reviews: Review[]): string {
  const list = reviews
    .map(
      (r, i) =>
        `${i + 1}. id=${r.id ?? `r${i + 1}`} 评分=${r.rating}星 渠道=${r.channel ?? '未知'} 内容：${r.content}`,
    )
    .join('\n');
  return `${shopBlock(shop)}

【任务】为以下每一条顾客评价生成一条可直接公开发布的回复，并给店主 1-3 条内部跟进建议。
${list}

【要求】
- 差评(≤2星)：先真诚致歉、不找借口，给出具体补救与线下沟通引导（联系方式：${shop.contact ?? '门店电话/微信'}），态度诚恳但不卑微。
- 中评(3星)：感谢并正面承接不足，邀请再次到店。
- 好评(≥4星)：表达感谢、强化招牌、引导复购或加会员。
- 每条回复 40-120 字，口语自然，避免雷同句式与套话。
【只输出如下 JSON】
{"replies":[{"reviewId":"对应的id","reply":"面向顾客的公开回复","actions":["内部建议1","内部建议2"]}]}
顺序与上面一致，数量一致。`;
}

export interface SegmentInput {
  key: string;
  label: string;
}

export function recallUser(shop: ShopProfile, segments: SegmentInput[], channel: RecallChannel): string {
  const list = segments.map((s, i) => `${i + 1}. ${s.key} —— ${s.label}`).join('\n');
  const channelRule =
    channel === '短信'
      ? '短信控制在 70 字内，自带【店名】签名前缀，结尾给可执行 CTA。'
      : '微信更口语亲切，可少量使用语气词，像店主本人发的私信。';
  return `${shopBlock(shop)}

【任务】针对以下顾客分层，各生成一条【${channel}】召回文案（目的：把老顾客拉回来复购）。
${list}

【要求】
- ${channelRule}
- 真诚不轰炸，给一个有吸引力但商家可承受的优惠钩子(offer)与建议发送时机(bestSendTime)。
【只输出如下 JSON】
{"scripts":[{"message":"召回文案","bestSendTime":"建议时机","offer":"优惠钩子"}]}
顺序与上面一致，数量一致。`;
}

export function promotionUser(shop: ShopProfile, count: number, perCapita: number): string {
  return `${shopBlock(shop)}

【任务】为该店设计 ${count} 个团购/套餐组合，用于拉新到店与复购，价格围绕人均约 ${perCapita} 元测算。
【要求】
- 覆盖不同人数/场景（如单人尝鲜、双人主力、多人聚会）。
- 给出原价 originalPrice 与团购价 dealPrice（元，整数）；团购价要有吸引力又能保住毛利。
- items 用招牌/人气项拼装；rationale 用一句话讲清定价与让利逻辑。
【只输出如下 JSON】
{"packages":[{"name":"套餐名","items":["项1","项2"],"originalPrice":100,"dealPrice":79,"targetScenario":"适用场景","rationale":"定价逻辑"}]}`;
}

export function contentUser(shop: ShopProfile, platforms: SocialPlatform[], topic?: string): string {
  return `${shopBlock(shop)}

【任务】为该店分别创作【${platforms.join('、')}】平台的引流种草内容${topic ? `，主题：${topic}` : ''}。
【要求】
- 小红书：标题前部埋"城市+品类"关键词，正文第一人称种草，约 5 个 4-8 字话题标签；
- 抖音：前 3 秒强钩子、竖屏脚本感、引导评论区互动；
- 真实可信不夸大；hashtags 不要带 # 号。
【只输出如下 JSON】
{"posts":[{"title":"标题","body":"正文","hashtags":["标签1","标签2"],"tips":"拍摄/发布建议"}]}
平台顺序与上面一致，数量一致。`;
}
