import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type { DocumentType, InScope, ProjectStatus } from './types';

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  bidding: '投标中',
  awarded: '已中标',
  delivering: '履约交付',
  settled: '已结算',
};

export const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  tender: '招标文件',
  contract: '合同',
  spec: '技术规范',
  boq: '工程量清单',
  drawing: '图纸',
  bim: 'BIM/IFC',
  bid: '我方投标',
  change_order: '变更/签证',
  letter: '往来函件',
  other: '其他',
};

export const IN_SCOPE_LABELS: Record<InScope, string> = {
  yes: '范围内',
  no: '超范围',
  uncertain: '待认定',
};

type BadgeVariant = 'default' | 'red' | 'blue' | 'green' | 'yellow' | 'outline';

export function projectStatusBadge(status: ProjectStatus): ReactNode {
  const map: Record<ProjectStatus, BadgeVariant> = {
    bidding: 'yellow',
    awarded: 'blue',
    delivering: 'green',
    settled: 'default',
  };
  return <Badge variant={map[status]}>{PROJECT_STATUS_LABELS[status]}</Badge>;
}

export function inScopeBadge(scope: InScope): ReactNode {
  const map: Record<InScope, BadgeVariant> = {
    yes: 'green',
    no: 'red',
    uncertain: 'yellow',
  };
  return <Badge variant={map[scope]}>{IN_SCOPE_LABELS[scope]}</Badge>;
}

export const FLOW_STEP_LABELS: Record<string, string> = {
  classify_in_scope: '范围认定',
  gather_contract_basis: '归集依据',
  quantify_impact: '影响量化',
  draft_claim_narrative: '起草正文',
  compile_packet: '组卷连边',
};

export function engineBadge(engine: string): ReactNode {
  if (engine === 'ragflow') {
    return <Badge variant="green">RAGFlow · 多模态检索</Badge>;
  }
  if (engine === 'llm' || engine === 'openai') {
    return <Badge variant="blue">{`大模型 · ${engine}`}</Badge>;
  }
  return <Badge variant="outline">{`离线兜底 · ${engine}`}</Badge>;
}
