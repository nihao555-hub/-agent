import { describe, expect, it } from 'vitest';
import { RuleBasedChatAgent } from '../src/chat/agent';
import type { ChatContext, ChatMessage } from '../src/chat/types';
import type { JobPosting, ResumeProfile } from '../src/types';

const job: JobPosting = {
  title: '后端工程师',
  company: '某科技',
  city: '上海',
  requiredSkills: ['Node.js'],
};

const resume: ResumeProfile = {
  name: '张三',
  education: [],
  workExperience: [],
};

const ctx: ChatContext = { job, resume };

let seq = 0;
function msg(role: ChatMessage['role'], content: string): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    sessionId: 's1',
    seq,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

describe('RuleBasedChatAgent（离线脚本化初筛）', () => {
  const agent = new RuleBasedChatAgent();

  it('开场白包含候选人姓名、公司与岗位', async () => {
    const opening = await agent.opening(ctx);
    expect(opening).toContain('张三');
    expect(opening).toContain('某科技');
    expect(opening).toContain('后端工程师');
  });

  it('按候选人回应推进脚本（一次只问一个问题）', async () => {
    const opening = msg('assistant', await agent.opening(ctx));
    // 候选人回应第一次 → 给出脚本第 1 问（求职状态/到岗时间）
    const r1 = await agent.reply(ctx, [opening, msg('candidate', '方便的')]);
    expect(r1).toContain('求职状态');

    const history2: ChatMessage[] = [
      opening,
      msg('candidate', '方便的'),
      msg('assistant', r1),
      msg('candidate', '我目前在职，一个月内可到岗'),
    ];
    const r2 = await agent.reply(ctx, history2);
    expect(r2).toContain('期望薪资');
  });

  it('脚本走完后礼貌收尾', async () => {
    const history: ChatMessage[] = [msg('assistant', '开场白')];
    for (let i = 0; i < 8; i += 1) {
      history.push(msg('candidate', `回答${i}`));
      history.push(msg('assistant', await agent.reply(ctx, history)));
    }
    const last = history[history.length - 1].content;
    expect(last).toContain('反馈结果');
  });

  it('summarize 产出结构化小结（hold + 标注规则引擎）', async () => {
    const history: ChatMessage[] = [msg('assistant', '开场白'), msg('candidate', '在职，期望 25k')];
    const summary = await agent.summarize(ctx, history);
    expect(summary.recommendation).toBe('hold');
    expect(summary.confirmedInfo.length).toBeGreaterThan(0);
    expect(summary.reason).toContain('规则引擎');
  });
});
