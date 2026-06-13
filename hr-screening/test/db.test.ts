import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db';
import { CandidateRepository, ChatRepository, JobRepository } from '../src/db/repositories';
import type { JobPosting, ResumeProfile } from '../src/types';

const job: JobPosting = {
  title: '后端工程师',
  company: '某科技',
  minEducation: '本科',
  minYears: 3,
  requiredSkills: ['Node.js', 'TypeScript'],
};

const resume: ResumeProfile = {
  name: '张三',
  highestEducation: '本科',
  skills: ['Node.js'],
  education: [],
  workExperience: [],
};

describe('DB 仓储（:memory:）', () => {
  let db: Db;
  let jobs: JobRepository;
  let candidates: CandidateRepository;
  let chats: ChatRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    jobs = new JobRepository(db);
    candidates = new CandidateRepository(db);
    chats = new ChatRepository(db);
  });

  it('JobRepository 存取岗位（JSON 往返）', () => {
    const id = jobs.create(job);
    const got = jobs.get(id);
    expect(got?.title).toBe('后端工程师');
    expect(got?.requiredSkills).toEqual(['Node.js', 'TypeScript']);
    expect(jobs.get('不存在')).toBeUndefined();
  });

  it('CandidateRepository 存取候选人', () => {
    const id = candidates.create(resume);
    expect(candidates.get(id)?.name).toBe('张三');
    expect(candidates.get('不存在')).toBeUndefined();
  });

  it('ChatRepository 建会话并按 seq 追加/读取消息', () => {
    const jobId = jobs.create(job);
    const candidateId = candidates.create(resume);
    const session = chats.createSession(jobId, candidateId);
    expect(session.status).toBe('active');

    const m1 = chats.addMessage(session.id, 'assistant', '您好，方便沟通吗？');
    const m2 = chats.addMessage(session.id, 'candidate', '方便的');
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);

    const messages = chats.listMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'candidate']);
    expect(messages[1].content).toBe('方便的');
  });

  it('ChatRepository 回填小结并标记完成', () => {
    const jobId = jobs.create(job);
    const candidateId = candidates.create(resume);
    const session = chats.createSession(jobId, candidateId);
    chats.setSummary(
      session.id,
      {
        fitAssessment: '匹配度中等',
        confirmedInfo: ['期望薪资 20k'],
        pendingInfo: [],
        risks: [],
        recommendation: 'hold',
        reason: '需进一步评估',
        nextQuestions: [],
      },
      'completed',
    );
    const got = chats.getSession(session.id);
    expect(got?.status).toBe('completed');
    expect(got?.summary?.recommendation).toBe('hold');
    expect(got?.summary?.confirmedInfo).toEqual(['期望薪资 20k']);
  });

  it('listSessions 返回消息计数且按更新时间倒序', () => {
    const jobId = jobs.create(job);
    const candidateId = candidates.create(resume);
    const s1 = chats.createSession(jobId, candidateId);
    const s2 = chats.createSession(jobId, candidateId);
    chats.addMessage(s2.id, 'assistant', 'hi');
    const list = chats.listSessions();
    expect(list).toHaveLength(2);
    const found = list.find((s) => s.id === s2.id);
    expect(found?.messageCount).toBe(1);
    expect(list.find((s) => s.id === s1.id)?.messageCount).toBe(0);
  });
});
