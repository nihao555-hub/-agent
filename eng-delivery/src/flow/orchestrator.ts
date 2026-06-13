import type { FlowRunRepository, FlowStepRepository } from '../db/flow';
import type { Logger } from '../logger';
import type { FlowRun } from './types';

/** 一步处理函数的执行上下文。`state` 是到当前步为止累积、可续跑恢复的共享状态。 */
export interface StepContext {
  run: FlowRun;
  state: Record<string, unknown>;
  logger?: Logger;
}

/** 一步的产出：要合并进流程共享 state 的补丁 + 供审计的步骤输出。 */
export interface StepResult {
  state?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

/**
 * 一步的定义。流程「长什么样」由代码（步骤数组）描述，运行态（cursor/state/各步状态）落库；
 * 这正是断点续跑的关键：重启后用同一份定义 + 落库的 cursor，从未完成处继续。
 */
export interface FlowStepDefinition {
  name: string;
  run(ctx: StepContext): Promise<StepResult>;
}

export interface StartFlowInput {
  projectId: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  engine: string;
  steps: FlowStepDefinition[];
  initialState?: Record<string, unknown>;
}

/**
 * 通用长流程编排器：负责把一串步骤跑完，并把 run/step 状态持久化到 SQLite，
 * 使其可断点续跑（resume 从落库 cursor 继续，已完成步骤不重跑）。
 * 不内置任何业务语义——具体步骤逻辑由调用方以 FlowStepDefinition 注入。
 * 升级路径：步骤数变多/需并行与人审挂起时，可平滑迁移到 Mastra(TS) / LangGraph(Py 微服务)。
 */
export class FlowOrchestrator {
  constructor(
    private readonly runs: FlowRunRepository,
    private readonly steps: FlowStepRepository,
    private readonly logger?: Logger,
  ) {}

  /** 创建一次 run 并为每一步建好 pending 记录（尚未执行）。 */
  start(input: StartFlowInput): FlowRun {
    const run = this.runs.create({
      projectId: input.projectId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      engine: input.engine,
      state: input.initialState ?? {},
    });
    input.steps.forEach((def, ordinal) => {
      this.steps.create({ runId: run.id, projectId: input.projectId, ordinal, name: def.name });
    });
    return run;
  }

  /**
   * 从落库 cursor 继续执行（幂等）：已完成的 run 直接返回；某步抛错则标记该步与 run 为 failed，
   * cursor 停在该步——再次调用 resume 即从该步重试。每步成功后立刻落库，保证崩溃可恢复。
   */
  async resume(runId: string, definitions: FlowStepDefinition[]): Promise<FlowRun> {
    let run = this.runs.get(runId);
    if (!run) throw new Error(`flow run 不存在: ${runId}`);
    if (run.status === 'completed') return run;

    const stepRows = this.steps.listByRun(runId);
    run = { ...run, status: 'running', error: undefined };
    run = this.runs.save(run);

    for (let i = run.cursor; i < definitions.length; i++) {
      const def = definitions[i];
      const stepRow = stepRows[i];
      stepRow.status = 'running';
      stepRow.startedAt = new Date().toISOString();
      this.steps.save(stepRow);
      try {
        const result = await def.run({ run, state: run.state, logger: this.logger });
        if (result.state) run.state = { ...run.state, ...result.state };
        stepRow.status = 'completed';
        stepRow.output = result.output ?? {};
        stepRow.finishedAt = new Date().toISOString();
        this.steps.save(stepRow);
        run.cursor = i + 1;
        run = this.runs.save(run);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ runId, step: def.name, err: msg }, '长流程步骤失败，停在断点可续跑');
        stepRow.status = 'failed';
        stepRow.error = msg;
        stepRow.finishedAt = new Date().toISOString();
        this.steps.save(stepRow);
        run.status = 'failed';
        run.error = msg;
        run = this.runs.save(run);
        return run;
      }
    }

    run.status = 'completed';
    run.error = undefined;
    run = this.runs.save(run);
    return run;
  }
}
