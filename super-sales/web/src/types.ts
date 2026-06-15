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
  personas?: Persona[];
  background_check?: boolean;
}

export interface Persona {
  key: string;
  label: string;
  seed: string;
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
  customer_type?: string;
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

export interface BackgroundBrief {
  company_profile?: string;
  industry_guess?: string;
  company_scale?: string;
  footprint_summary?: string;
  recent_developments?: string[];
  possible_decision_makers?: string[];
  contact_summary?: string;
  icebreakers?: string[];
  talking_points?: string[];
  company_scale_money?: string;
  tech_stack?: string[];
  competitive_landscape?: string;
  buying_triggers?: string[];
  sales_angle?: string;
  qualification_framework?: string;
  qualification_gaps?: string[];
  caution?: string;
}

export interface ContactAccount {
  site: string;
  url?: string;
  tags?: string;
}

export interface ContactOsint {
  available?: boolean;
  name?: string;
  email?: string;
  username?: string;
  accounts?: ContactAccount[];
  account_count?: number;
  email_services?: string[];
  engines?: string[];
}

export interface NewsItem {
  title: string;
  date?: string;
  source?: string;
}

export interface SecEdgar {
  is_public?: boolean;
  ticker?: string;
  exchange?: string;
  sic_industry?: string;
  fiscal_year_end?: string;
  recent_filings?: string[];
}

export interface BusinessIntel {
  wikidata?: Record<string, string>;
  summary?: string;
  news?: NewsItem[];
  signals?: NewsItem[];
  site_blurb?: string;
  tech_stack?: string[];
  edgar?: SecEdgar;
  available?: boolean;
}

export interface Background {
  company: string;
  domain: string;
  country?: string;
  customer_type?: string;
  footprint?: { hosts?: string[]; emails?: string[]; ips?: string[]; available?: boolean };
  intel?: BusinessIntel;
  contact?: ContactOsint;
  brief?: BackgroundBrief;
  engine?: string;
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
  pacing?: number[];
  read_ms?: number;
  think_ms?: number;
  type_ms?: number[];
  engine?: Engine;
}

export interface Settings {
  mode: "auto" | "semi";
  [k: string]: string;
}

export type StepStatus = "pending" | "running" | "done" | "skipped";

export interface RunStep extends PipelineStep {
  status: StepStatus;
  result?: unknown;
}
