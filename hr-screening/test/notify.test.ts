import { describe, expect, it } from 'vitest';
import { DryRunNotifier } from '../src/notify/channels';
import { RuleBasedFeedbackComposer } from '../src/notify/composer';
import type { JobPosting, ResumeProfile } from '../src/types';

const job: JobPosting = { title: '前端工程师', company: '某科技' };
const resume: ResumeProfile = {
  name: '李四',
  email: 'lisi@example.com',
  education: [],
  workExperience: [],
};

const composer = new RuleBasedFeedbackComposer();

describe('反馈文案（规则引擎）', () => {
  it('拒信专业有温度、不含歧视性理由', async () => {
    const letter = await composer.compose({ job, resume, status: 'rejected' });
    expect(letter.engine).toBe('rule-based');
    expect(letter.subject).toContain('前端工程师');
    expect(letter.body).toContain('李四');
    // 不得出现与岗位无关的歧视性字眼
    for (const bad of ['年龄', '性别', '婚', '户籍', '院校']) {
      expect(letter.body).not.toContain(bad);
    }
  });

  it('约面通知包含邀请语', async () => {
    const letter = await composer.compose({ job, resume, status: 'interview' });
    expect(letter.body).toContain('面试');
  });

  it('进入初筛 / 人才库均有对应文案', async () => {
    const screening = await composer.compose({ job, resume, status: 'screening' });
    expect(screening.body).toContain('初筛');
    const pool = await composer.compose({ job, resume, status: 'talent_pool' });
    expect(pool.body).toContain('人才库');
  });
});

describe('DryRunNotifier', () => {
  it('不外发，返回 skipped', async () => {
    const notifier = new DryRunNotifier();
    expect(notifier.channel).toBe('none');
    const result = await notifier.send({ recipient: 'a@b.com', subject: 's', body: 'b' });
    expect(result.status).toBe('skipped');
  });
});
