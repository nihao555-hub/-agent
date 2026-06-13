import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db';
import { ProjectRepository } from '../src/db/factbase';
import { FlowRunRepository, FlowStepRepository } from '../src/db/flow';
import { FlowOrchestrator, type FlowStepDefinition } from '../src/flow/orchestrator';

/**
 * 通用长流程编排器测试：只验证「断点续跑 + 幂等」这类与业务无关的引擎能力，
 * 步骤逻辑用最小桩注入，确定性、离线、无需大模型。
 */
function setup(db: Db) {
  const project = new ProjectRepository(db).create({ name: 'P' });
  const runs = new FlowRunRepository(db);
  const steps = new FlowStepRepository(db);
  const orchestrator = new FlowOrchestrator(runs, steps);
  return { project, runs, steps, orchestrator };
}

describe('FlowOrchestrator 通用可续跑编排引擎', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('happy path：顺序执行所有步骤、累积 state、run 标记完成', async () => {
    const { project, orchestrator, steps: stepRepo } = setup(db);
    const defs: FlowStepDefinition[] = [
      { name: 'a', run: async () => ({ state: { a: 1 }, output: { ok: true } }) },
      { name: 'b', run: async (ctx) => ({ state: { b: (ctx.state.a as number) + 1 } }) },
    ];
    const run = orchestrator.start({
      projectId: project.id,
      kind: 'test',
      subjectType: 'x',
      subjectId: 'y',
      engine: 'test',
      steps: defs,
    });
    expect(run.status).toBe('pending');

    const finished = await orchestrator.resume(run.id, defs);
    expect(finished.status).toBe('completed');
    expect(finished.cursor).toBe(2);
    expect(finished.state).toMatchObject({ a: 1, b: 2 });

    const rows = stepRepo.listByRun(run.id);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(rows[0].output).toMatchObject({ ok: true });
  });

  it('断点续跑：失败步骤停在断点、续跑不重跑已完成步骤（幂等）', async () => {
    const { project, orchestrator, steps: stepRepo } = setup(db);
    let stepARuns = 0;
    let stepBAttempts = 0;
    const defs: FlowStepDefinition[] = [
      {
        name: 'a',
        run: async () => {
          stepARuns++;
          return { state: { a: 1 } };
        },
      },
      {
        name: 'b',
        run: async () => {
          stepBAttempts++;
          if (stepBAttempts === 1) throw new Error('boom');
          return { state: { b: 2 } };
        },
      },
      { name: 'c', run: async () => ({ state: { c: 3 } }) },
    ];
    const run = orchestrator.start({
      projectId: project.id,
      kind: 'test',
      subjectType: 'x',
      subjectId: 'y',
      engine: 'test',
      steps: defs,
    });

    // 第一次：在 b 失败，停在断点 cursor=1
    const failed = await orchestrator.resume(run.id, defs);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('boom');
    expect(failed.cursor).toBe(1);
    let rows = stepRepo.listByRun(run.id);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'failed', 'pending']);

    // 续跑：从 b 继续到完成；a 不被重跑
    const done = await orchestrator.resume(run.id, defs);
    expect(done.status).toBe('completed');
    expect(done.cursor).toBe(3);
    expect(done.state).toMatchObject({ a: 1, b: 2, c: 3 });
    expect(stepARuns).toBe(1);
    expect(stepBAttempts).toBe(2);
    rows = stepRepo.listByRun(run.id);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);

    // 已完成的 run 再次续跑是 no-op，不重复执行任何步骤
    const again = await orchestrator.resume(run.id, defs);
    expect(again.status).toBe('completed');
    expect(stepARuns).toBe(1);
    expect(stepBAttempts).toBe(2);
  });

  it('运行态持久化：另起仓储实例也能读回 run 与各步审计', async () => {
    const { project, orchestrator } = setup(db);
    const defs: FlowStepDefinition[] = [
      { name: 'only', run: async () => ({ state: { done: true }, output: { n: 1 } }) },
    ];
    const run = orchestrator.start({
      projectId: project.id,
      kind: 'test',
      subjectType: 'x',
      subjectId: 'y',
      engine: 'test',
      steps: defs,
    });
    await orchestrator.resume(run.id, defs);

    const freshRuns = new FlowRunRepository(db);
    const freshSteps = new FlowStepRepository(db);
    const reloaded = freshRuns.get(run.id);
    expect(reloaded?.status).toBe('completed');
    expect(reloaded?.state).toMatchObject({ done: true });
    expect(freshSteps.listByRun(run.id)[0].output).toMatchObject({ n: 1 });
  });
});
