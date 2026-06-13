// 与后端 src/factbase/types.ts 对齐的最小类型（前端只取需要展示的字段）。

export type ProjectStatus = 'bidding' | 'awarded' | 'delivering' | 'settled';

export type DocumentType =
  | 'tender'
  | 'contract'
  | 'spec'
  | 'boq'
  | 'drawing'
  | 'bim'
  | 'bid'
  | 'change_order'
  | 'letter'
  | 'other';

export type InScope = 'yes' | 'no' | 'uncertain';

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  tenderer?: string;
  client?: string;
  createdAt: string;
}

export interface ProjectDocument {
  id: string;
  projectId: string;
  type: DocumentType;
  title?: string;
  source?: string;
  pageCount?: number;
  parsed: boolean;
  createdAt: string;
}

export interface Chunk {
  id: string;
  documentId: string;
  projectId: string;
  ordinal: number;
  page?: number;
  clause?: string;
  text: string;
}

export interface ChunkHit {
  id: string;
  documentId: string;
  page?: number;
  clause?: string;
  text: string;
  score: number;
}

export interface Change {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  inScope: InScope;
  basisChunkId?: string;
  costImpact?: string;
  timeImpact?: string;
  status: string;
  createdAt: string;
}

export interface Claim {
  id: string;
  projectId: string;
  changeId?: string;
  type: 'time' | 'cost';
  basis?: string;
  amount?: string;
  days?: number;
  narrative?: string;
  status: string;
  createdAt: string;
}

export interface Requirement {
  id: string;
  projectId: string;
  sourceChunkId?: string;
  kind: string;
  category?: string;
  text: string;
  mandatory: boolean;
  status: string;
  severity?: string;
  createdAt: string;
}

export interface Commitment {
  id: string;
  text: string;
  requirementId?: string;
  createdAt: string;
}

export interface Deviation {
  id: string;
  type: string;
  severity?: string;
  status: string;
  description: string;
  detectedBy: string;
  createdAt: string;
}

export interface Evidence {
  id: string;
  chunkId: string;
  note?: string;
  createdAt: string;
}

export interface Link {
  id: string;
  projectId: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  createdAt: string;
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface IngestResult {
  document: ProjectDocument;
  chunkCount: number;
  chunks: Chunk[];
}

export interface SearchResult {
  engine: string;
  query: string;
  hits: ChunkHit[];
}

export type FlowStatus = 'pending' | 'running' | 'completed' | 'failed';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface FlowRun {
  id: string;
  projectId: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  status: FlowStatus;
  cursor: number;
  engine: string;
  state: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowStep {
  id: string;
  runId: string;
  ordinal: number;
  name: string;
  status: StepStatus;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface ClaimFlowResult {
  run: FlowRun;
  steps: FlowStep[];
  claim?: Claim;
}

export interface ProjectGraph {
  project: Project;
  documents: ProjectDocument[];
  requirements: Requirement[];
  commitments: Commitment[];
  deviations: Deviation[];
  evidences: Evidence[];
  changes: Change[];
  claims: Claim[];
  links: Link[];
  events: ProjectEvent[];
  stats: {
    documents: number;
    chunks: number;
    requirements: number;
    commitments: number;
    deviations: number;
    changes: number;
    claims: number;
  };
}

export interface Health {
  status: string;
  service: string;
  engine: string;
  model: string | null;
  docService: string;
  bimService: string;
  storage: string;
}
