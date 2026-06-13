import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig, SmtpConfig } from '../config';
import type { Logger } from '../logger';
import type { NotificationChannel, NotificationStatus } from '../pipeline/types';

/** 待外发的一条消息 */
export interface OutboundMessage {
  recipient: string;
  subject?: string;
  body: string;
}

/** 发送结果（落库用） */
export interface SendResult {
  status: NotificationStatus;
  error?: string;
}

/**
 * 通知渠道抽象。所有渠道可插拔；默认实现为 dry-run（仅落库不外发），
 * 配置了真实凭据后由对应渠道接管，业务层无需改动。
 */
export interface Notifier {
  readonly channel: NotificationChannel;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/**
 * 默认渠道：不外发，仅返回 skipped。用于离线/未配置凭据时安全演练（dry-run），
 * 通知意图仍会落库，便于本地测试与审计。
 */
export class DryRunNotifier implements Notifier {
  readonly channel: NotificationChannel = 'none';
  constructor(private readonly logger?: Logger) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    this.logger?.info(
      { recipient: msg.recipient, subject: msg.subject },
      '通知未外发（dry-run，未配置真实渠道），已落库',
    );
    return { status: 'skipped' };
  }
}

/**
 * 邮件渠道（SMTP，复用 nodemailer）。仅当配置了 SMTP_HOST/SMTP_FROM 时启用，
 * 是面向候选人最通用、最易合规落地的反馈渠道。
 */
export class SmtpEmailNotifier implements Notifier {
  readonly channel: NotificationChannel = 'email';

  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
    private readonly logger?: Logger,
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: msg.recipient,
        subject: msg.subject ?? '您的应聘进展',
        text: msg.body,
      });
      return { status: 'sent' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ error }, '邮件发送失败');
      return { status: 'failed', error };
    }
  }
}

function buildSmtpTransport(smtp: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
  });
}

/**
 * 按配置选择默认通知渠道。未配置真实渠道（或 NOTIFY_DEFAULT_CHANNEL=none）时回退 dry-run。
 * 短信(阿里云/腾讯云)、企业微信等渠道可按相同 Notifier 接口扩展接入。
 */
export function createNotifier(config: AppConfig, logger?: Logger): Notifier {
  if (config.notify.defaultChannel === 'email' && config.notify.smtp.enabled) {
    const from = config.notify.smtp.from ?? config.notify.smtp.user ?? '';
    logger?.info({ host: config.notify.smtp.host }, '已启用邮件(SMTP)通知渠道');
    return new SmtpEmailNotifier(buildSmtpTransport(config.notify.smtp), from, logger);
  }
  logger?.info('未配置可用通知渠道，使用 dry-run（仅落库不外发）');
  return new DryRunNotifier(logger);
}
