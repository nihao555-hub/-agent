import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { ImapConfig } from '../config';
import type { Logger } from '../logger';
import type { IntakeItem } from './types';

/**
 * 邮箱收件源抽象：从企业邮箱拉取「未读」邮件中的简历（附件优先，正文兜底）。
 * 抽象出来便于测试注入桩；真实实现 ImapEmailSource 走 IMAP（imapflow + mailparser）。
 */
export interface EmailIntakeSource {
  /** 拉取待处理简历项；返回拉取到的项与一段可读说明。 */
  fetch(): Promise<{ items: IntakeItem[]; note: string }>;
}

const RESUME_EXT = /\.(pdf|docx?|txt)$/i;

function isResumeAttachment(
  filename: string | undefined,
  contentType: string | undefined,
): boolean {
  if (filename && RESUME_EXT.test(filename)) return true;
  if (!contentType) return false;
  return /pdf|word|officedocument|msword|text\/plain/i.test(contentType);
}

/**
 * IMAP 邮箱收件实现：连接企业邮箱 → 读取未读邮件 → 抽取简历附件（PDF/Word/txt，base64）
 * 或正文文本 → 标记为已读，避免重复入库。配齐凭据才会被实例化（否则归集层禁用邮箱源）。
 */
export class ImapEmailSource implements EmailIntakeSource {
  constructor(
    private readonly config: ImapConfig,
    private readonly logger?: Logger,
  ) {}

  async fetch(): Promise<{ items: IntakeItem[]; note: string }> {
    const client = new ImapFlow({
      host: this.config.host ?? '',
      port: this.config.port,
      secure: this.config.tls,
      auth: { user: this.config.user ?? '', pass: this.config.password ?? '' },
      logger: false,
    });
    const items: IntakeItem[] = [];
    await client.connect();
    const lock = await client.getMailboxLock(this.config.mailbox);
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject ?? '';
        const attachments = parsed.attachments.filter((a) =>
          isResumeAttachment(a.filename, a.contentType),
        );
        if (attachments.length > 0) {
          for (const att of attachments) {
            items.push({
              fileBase64: att.content.toString('base64'),
              fileName: att.filename ?? 'resume.pdf',
              meta: `邮件主题：${subject}`,
            });
          }
        } else if (parsed.text && parsed.text.trim()) {
          items.push({ text: parsed.text.trim(), meta: `邮件主题：${subject}` });
        }
        await client.messageFlagsAdd({ uid: String(msg.uid) }, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
      await client.logout();
    }
    const note = `从邮箱 ${this.config.mailbox} 拉取到 ${items.length} 份待处理简历`;
    this.logger?.info({ count: items.length }, note);
    return { items, note };
  }
}
