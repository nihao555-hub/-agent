import { Badge, Card } from "../ui";
import { IconRoute, IconSpark, IconTarget } from "../icons";

const AGENTS = [
  ["检索官", "从销售方法论库召回相关片段，给后续推理做依据"],
  ["客户画像官", "刻画行业 / 角色 / 需求 / 预算敏感度 / 决策权"],
  ["商机阶段判断官", "判定成交阶段、购买信号与流失风险"],
  ["异议拆解官", "找出每条异议，挖真实顾虑并给应对"],
  ["流失挽回官", "仅当高流失风险时触发，写可直接发的挽回话术"],
  ["话术生成官", "综合阶段与异议，给下一句该发的微信话术"],
  ["报价官", "三档套餐锚定，主推中间档"],
  ["跟进策略官", "排出带时间点的跟进计划"],
  ["CRM 建档官", "沉淀成交概率、标签与下一步动作"],
];

export default function About() {
  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-8">
        <Badge tone="blue">B2B · 私域销售 Agent</Badge>
        <h1 className="mt-3 font-serif text-[32px] leading-tight tracking-[-0.02em] text-ink">
          住在你微信私域里的
          <br />
          多智能体销售大脑
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-charcoal">
          西方的 SDR 工具做的是冷邮件群发，进不了中国「微信/企业微信私域成交」的场景；现有 CRM 只负责记录，不替你干活。
          AI 超级销售读懂客户聊天，判断阶段、拆解异议、生成话术与报价、排出跟进、自动建档——销售只管发出去和签单。
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="不是套壳" icon={<IconSpark />}>
          <p className="text-[13.5px] leading-6 text-charcoal">
            9 个角色各司其职，结论都用方法论片段做溯源，而不是让大模型写一段话。
          </p>
        </Card>
        <Card title="真 Agent 编排" icon={<IconRoute />}>
          <p className="text-[13.5px] leading-6 text-charcoal">
            LangGraph 状态图。阶段官判定的流失风险决定是否触发「挽回官」——状态驱动的条件分支，不是固定顺序链。
          </p>
        </Card>
        <Card title="离线可演示" icon={<IconTarget />}>
          <p className="text-[13.5px] leading-6 text-charcoal">
            配 LLM key 走 gpt-5.5 + 本地向量检索；没 key 也能跑，全程规则兜底。
          </p>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 font-serif text-[20px] text-ink">九个销售智能体</h2>
      <div className="overflow-hidden rounded-card border border-line">
        {AGENTS.map(([name, desc], i) => (
          <div
            key={name}
            className={`flex items-center gap-4 px-5 py-3.5 ${i % 2 ? "bg-bone/40" : "bg-surface"}`}
          >
            <span className="w-6 shrink-0 font-mono text-[12px] text-muted">{i + 1}</span>
            <span className="w-32 shrink-0 font-serif text-[15px] text-ink">{name}</span>
            <span className="text-[13px] text-charcoal">{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
