import { HttpError } from '../errors';
import type { CandidateRepository, ChatRepository, JobRepository } from '../db/repositories';
import type { JobPosting, ResumeProfile } from '../types';
import type { ChatAgent } from './agent';
import type { ChatMessage, ChatScreeningSummary, ChatSession, ChatSessionMeta } from './types';

export interface SessionView {
  session: ChatSession;
  messages: ChatMessage[];
}

/**
 * 对话式初筛编排层：组合「持久化仓储 + 对话 Agent」。
 * 负责建会话（落库岗位/候选人/开场白）、收发消息（落库 + 生成回复）、取上下文、出小结并回填会话。
 */
export class ChatService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly candidates: CandidateRepository,
    private readonly chats: ChatRepository,
    private readonly agent: ChatAgent,
  ) {}

  get engineName(): string {
    return this.agent.name;
  }

  /** 新建会话：持久化岗位与候选人，生成并落库开场白，返回会话与消息。 */
  async createSession(input: { job: JobPosting; resume: ResumeProfile }): Promise<SessionView> {
    const jobId = this.jobs.create(input.job);
    const candidateId = this.candidates.create(input.resume);
    const row = this.chats.createSession(jobId, candidateId);
    const opening = await this.agent.opening({ job: input.job, resume: input.resume });
    this.chats.addMessage(row.id, 'assistant', opening);
    this.chats.touch(row.id);
    return this.getSession(row.id);
  }

  /** 候选人发一条消息：落库后生成并落库 AI 回复，返回回复与最新历史。 */
  async postMessage(
    sessionId: string,
    content: string,
  ): Promise<{ session: ChatSession; reply: ChatMessage; messages: ChatMessage[] }> {
    const { session } = this.getSession(sessionId);
    if (session.status === 'completed') {
      throw new HttpError(409, '该会话已结束并出具小结，无法继续发送消息。');
    }
    this.chats.addMessage(sessionId, 'candidate', content);
    const history = this.chats.listMessages(sessionId);
    const replyText = await this.agent.reply({ job: session.job, resume: session.resume }, history);
    const reply = this.chats.addMessage(sessionId, 'assistant', replyText);
    this.chats.touch(sessionId);
    const view = this.getSession(sessionId);
    return { session: view.session, reply, messages: view.messages };
  }

  /** 取会话上下文：会话元信息 + 岗位 + 简历 + 完整消息历史。 */
  getSession(sessionId: string): SessionView {
    const row = this.chats.getSession(sessionId);
    if (!row) throw new HttpError(404, '会话不存在或已被删除。');
    const job = this.jobs.get(row.jobId);
    const resume = this.candidates.get(row.candidateId);
    if (!job || !resume) {
      throw new HttpError(500, '会话关联的岗位或候选人数据缺失。');
    }
    const session: ChatSession = {
      id: row.id,
      jobId: row.jobId,
      candidateId: row.candidateId,
      status: row.status,
      job,
      resume,
      summary: row.summary,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return { session, messages: this.chats.listMessages(sessionId) };
  }

  /** 出小结：基于完整对话产出结构化小结，回填会话并标记为已完成。 */
  async summarize(sessionId: string): Promise<ChatScreeningSummary> {
    const { session, messages } = this.getSession(sessionId);
    const summary = await this.agent.summarize(
      { job: session.job, resume: session.resume },
      messages,
    );
    this.chats.setSummary(sessionId, summary, 'completed');
    return summary;
  }

  listSessions(): ChatSessionMeta[] {
    return this.chats.listSessions().map((row) => ({
      id: row.id,
      jobId: row.jobId,
      candidateId: row.candidateId,
      jobTitle: this.jobs.get(row.jobId)?.title ?? '未知岗位',
      candidateName: this.candidates.get(row.candidateId)?.name,
      status: row.status,
      messageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}
