export type Engine = "llm" | "fallback";

export interface PipelineStep {
  key: string;
  label: string;
}

export interface ChannelInfo {
  name: string;
  label: string;
  risk: string;
  configured: boolean;
}

export interface Health {
  ok: boolean;
  engine: Engine;
  model: string | null;
  retrieval_backend: string;
  pipeline: PipelineStep[];
  channels?: ChannelInfo[];
  live_closer?: boolean;
  sales_stages?: string[];
}

export interface Evidence {
  id: string;
  topic: string;
  title: string;
  text: string;
  score: number;
  backend: string;
}

export interface Profile {
  summary: string;
  industry: string;
  role: string;
  needs: string[];
  budget_sensitivity: string;
  decision_power: string;
}

export interface Stage {
  stage: string;
  confidence: number;
  churn_risk: "low" | "medium" | "high";
  buying_signals: string[];
  rationale: string;
  cited: string[];
}

export interface Objection {
  raw: string;
  real_concern: string;
  type: string;
  counter: string;
  cited: string[];
}

export interface Recovery {
  triggered: boolean;
  reason?: string;
  risk_reason?: string;
  actions?: string[];
  message?: string;
  cited?: string[];
}

export interface Script {
  next_message: string;
  tone: string;
  talking_points: string[];
  cited: string[];
}

export interface QuoteTier {
  name: string;
  price: string;
  highlights: string[];
}

export interface Quote {
  tiers: QuoteTier[];
  recommended: string;
  anchor_strategy: string;
  concession_levers: string[];
  cited: string[];
}

export interface FollowupItem {
  when: string;
  action: string;
  goal: string;
}

export interface Followup {
  plan: FollowupItem[];
  cadence: string;
  cited: string[];
}

export interface Crm {
  customer: string;
  stage: string;
  win_probability: number;
  next_action: string;
  tags: string[];
}

export interface CoachFactor {
  name: string;
  score: number;
  comment: string;
}

export interface Coach {
  win_score: number;
  factors: CoachFactor[];
  key_risks: string[];
  improvement_actions: string[];
  coaching_tip: string;
  cited: string[];
}

export interface FinalState {
  evidence?: Evidence[];
  profile?: Profile;
  stage?: Stage;
  objections?: { objections: Objection[] };
  recovery?: Recovery;
  script?: Script;
  quote?: Quote;
  followup?: Followup;
  crm?: Crm;
  coach?: Coach;
  engine?: Engine;
  churn_risk?: string;
}

// ---- live AI-closer ----

export interface Customer {
  id: string;
  name: string;
  platform: string;
  country: string;
  category: string;
  stage: string;
  win_score: number;
  status: string;
  next_step: string;
  tags: string[];
  updated_at: number;
}

export interface ChatMessage {
  id: string;
  customer_id: string;
  role: "customer" | "agent" | "system";
  text: string;
  asset_id?: string;
  translation?: string;
  lang?: string;
  created_at: number;
}

export interface MemoryFact {
  id: string;
  customer_id: string;
  kind: string;
  text: string;
  created_at: number;
}

export interface CotStep {
  role: string;
  thought: string;
}

export interface MemoryDraft {
  kind: string;
  text: string;
}

export interface Move {
  method: string;
  move: string;
}

export interface Decision {
  cot: CotStep[];
  reply: string[];
  reply_translation?: string[];
  customer_lang?: string;
  inbound_translation?: string;
  moves?: Move[];
  send_asset: string;
  stage: string;
  win_score: number;
  next_step: string;
  new_memory: MemoryDraft[];
  handoff: boolean;
  handoff_reason: string;
  cited: string[];
  engine?: Engine;
}

export type StepStatus = "pending" | "running" | "done" | "skipped";

export interface RunStep extends PipelineStep {
  status: StepStatus;
  result?: unknown;
}
