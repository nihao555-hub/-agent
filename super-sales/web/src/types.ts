export type Engine = "llm" | "fallback";

export interface PipelineStep {
  key: string;
  label: string;
}

export interface Health {
  ok: boolean;
  engine: Engine;
  model: string | null;
  retrieval_backend: string;
  pipeline: PipelineStep[];
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

export type StepStatus = "pending" | "running" | "done" | "skipped";

export interface RunStep extends PipelineStep {
  status: StepStatus;
  result?: unknown;
}
