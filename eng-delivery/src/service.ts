import type { TenderDocParser } from './doc/parser';
import { assignRequirementIds } from './engine/normalize';
import type { TenderEngine } from './engine/types';
import { HttpError } from './errors';
import type { Logger } from './logger';
import type {
  AnalysisRepository,
  CapabilityRepository,
  EventRepository,
  TenderRepository,
} from './db/repositories';
import type {
  AnalyzeRequestBody,
  ComplianceRequestBody,
  GapRequestBody,
  ParseTenderBody,
  TenderSpecInput,
} from './schemas';
import type {
  CapabilityProfile,
  ComplianceReport,
  GapReport,
  TenderSpec,
} from './types';

export interface Repositories {
  tenders: TenderRepository;
  capabilities: CapabilityRepository;
  analyses: AnalysisRepository;
  events: EventRepository;
}

export interface ParseTenderResult {
  tenderId: string;
  engine: string;
  source: string;
  tender: TenderSpec;
}

export interface GapResult {
  tenderId: string;
  engine: string;
  report: GapReport;
}

export interface ComplianceResult {
  tenderId: string;
  engine: string;
  report: ComplianceReport;
}

export interface AnalyzeResult {
  tenderId: string;
  engine: string;
  source: string;
  tender: TenderSpec;
  gap?: GapReport;
  compliance: ComplianceReport;
}

/**
 * 工程交付大脑核心服务：编排「文档解析 → 引擎(大模型/规则) → 持久化」三层。
 * 引擎本身负责领域判断（优先大模型），本服务只负责取数据、调引擎、落库与留痕。
 */
export class EngDeliveryService {
  constructor(
    private readonly engine: TenderEngine,
    private readonly parser: TenderDocParser,
    private readonly repos: Repositories,
    private readonly logger?: Logger,
  ) {}

  get engineName(): string {
    return this.engine.name;
  }

  /** 解析招标文件（文本或文件）→ 抽取结构化要点并落库。 */
  async parseTender(body: ParseTenderBody): Promise<ParseTenderResult> {
    const extracted = await this.parser.extract({
      text: body.text,
      fileBase64: body.fileBase64,
      fileName: body.fileName,
    });
    const tender = await this.engine.parseTender({
      text: extracted.text,
      projectName: body.projectName,
    });
    const tenderId = this.repos.tenders.create(tender, this.engine.name);
    this.repos.events.create(tenderId, 'tender_parsed', {
      engine: this.engine.name,
      source: extracted.source,
      requirements: tender.requirements.length,
      disqualifications: tender.disqualifications.length,
    });
    return { tenderId, engine: this.engine.name, source: extracted.source, tender };
  }

  /** 范围/资格缺口检测。 */
  async detectGaps(body: GapRequestBody): Promise<GapResult> {
    const { tenderId, tender } = this.resolveTender(body);
    const { capability } = this.resolveCapability(body);
    if (!capability) {
      throw new HttpError(400, '请提供 capabilityId 或内联 capability 之一');
    }
    const report = await this.engine.detectGaps({ tender, capability });
    this.repos.analyses.create({
      tenderId,
      kind: 'gap',
      engine: this.engine.name,
      result: report,
    });
    this.repos.events.create(tenderId, 'gap_detected', {
      engine: this.engine.name,
      blockers: report.blockers.length,
      readiness: report.readiness,
    });
    return { tenderId, engine: this.engine.name, report };
  }

  /** 合规 / 废标风险自检。 */
  async checkCompliance(body: ComplianceRequestBody): Promise<ComplianceResult> {
    const { tenderId, tender } = this.resolveTender(body);
    const { capability } = this.resolveCapability(body);
    const report = await this.engine.checkCompliance({ tender, capability });
    this.repos.analyses.create({
      tenderId,
      kind: 'compliance',
      engine: this.engine.name,
      result: report,
    });
    this.repos.events.create(tenderId, 'compliance_checked', {
      engine: this.engine.name,
      disqualificationRisks: report.disqualificationRisks.length,
      passLikelihood: report.passLikelihood,
    });
    return { tenderId, engine: this.engine.name, report };
  }

  /** 端到端：解析招标文件 → 缺口检测（有我方资料时）+ 合规自检，一次完成并落库。 */
  async analyze(body: AnalyzeRequestBody): Promise<AnalyzeResult> {
    const extracted = await this.parser.extract({
      text: body.text,
      fileBase64: body.fileBase64,
      fileName: body.fileName,
    });
    const tender = await this.engine.parseTender({
      text: extracted.text,
      projectName: body.projectName,
    });
    const tenderId = this.repos.tenders.create(tender, this.engine.name);
    this.repos.events.create(tenderId, 'tender_parsed', {
      engine: this.engine.name,
      source: extracted.source,
      requirements: tender.requirements.length,
    });

    const capability = this.resolveOptionalCapability(body.capabilityId, body.capability);

    let gap: GapReport | undefined;
    if (capability) {
      gap = await this.engine.detectGaps({ tender, capability });
      this.repos.events.create(tenderId, 'gap_detected', {
        engine: this.engine.name,
        blockers: gap.blockers.length,
      });
    }
    const compliance = await this.engine.checkCompliance({ tender, capability });
    this.repos.events.create(tenderId, 'compliance_checked', {
      engine: this.engine.name,
      disqualificationRisks: compliance.disqualificationRisks.length,
    });

    this.repos.analyses.create({
      tenderId,
      kind: 'analyze',
      engine: this.engine.name,
      result: { gap, compliance },
    });

    return {
      tenderId,
      engine: this.engine.name,
      source: extracted.source,
      tender,
      gap,
      compliance,
    };
  }

  createCapability(capability: CapabilityProfile): string {
    return this.repos.capabilities.create(capability);
  }

  getCapability(id: string): CapabilityProfile | undefined {
    return this.repos.capabilities.get(id);
  }

  getTender(id: string): TenderSpec | undefined {
    return this.repos.tenders.get(id);
  }

  listTenders() {
    return this.repos.tenders.list();
  }

  getAnalyses(tenderId: string) {
    if (!this.repos.tenders.get(tenderId)) {
      throw new HttpError(404, `招标文件不存在: ${tenderId}`);
    }
    return {
      analyses: this.repos.analyses.listByTender(tenderId),
      events: this.repos.events.listByTender(tenderId),
    };
  }

  /** 把请求里的 tenderId/inline tender 解析为可用的 {tenderId, tender}（inline 会落库以便留痕）。 */
  private resolveTender(body: { tenderId?: string; tender?: TenderSpecInput }): {
    tenderId: string;
    tender: TenderSpec;
  } {
    if (body.tenderId) {
      const tender = this.repos.tenders.get(body.tenderId);
      if (!tender) throw new HttpError(404, `招标文件不存在: ${body.tenderId}`);
      return { tenderId: body.tenderId, tender };
    }
    if (body.tender) {
      const tender = toTenderSpec(body.tender);
      const tenderId = this.repos.tenders.create(tender, 'manual');
      return { tenderId, tender };
    }
    throw new HttpError(400, '请提供 tenderId 或内联 tender 之一');
  }

  private resolveCapability(body: { capabilityId?: string; capability?: CapabilityProfile }): {
    capability?: CapabilityProfile;
  } {
    return { capability: this.resolveOptionalCapability(body.capabilityId, body.capability) };
  }

  private resolveOptionalCapability(
    capabilityId?: string,
    capability?: CapabilityProfile,
  ): CapabilityProfile | undefined {
    if (capabilityId) {
      const found = this.repos.capabilities.get(capabilityId);
      if (!found) throw new HttpError(404, `我方能力档案不存在: ${capabilityId}`);
      return found;
    }
    return capability;
  }
}

/** 把外部传入的（字段宽松的）招标要点补齐为内部 TenderSpec：补编号、补默认类别。 */
function toTenderSpec(raw: TenderSpecInput): TenderSpec {
  return {
    projectName: raw.projectName,
    tenderer: raw.tenderer,
    agent: raw.agent,
    method: raw.method,
    budget: raw.budget,
    bidSecurity: raw.bidSecurity,
    requirements: assignRequirementIds(
      raw.requirements.map((r) => ({
        id: r.id,
        category: r.category ?? '未分类',
        text: r.text,
        mandatory: r.mandatory ?? false,
        source: r.source,
      })),
    ),
    scoringItems: raw.scoringItems,
    disqualifications: raw.disqualifications,
    milestones: raw.milestones,
    summary: raw.summary,
  };
}
