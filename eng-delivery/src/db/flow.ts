import { randomUUID } from 'node:crypto';
import type { FlowRun, FlowStep } from '../flow/types';
import type { Db } from './index';

function now(): string {
  return new Date().toISOString();
}

interface IdDataRow {
  id: string;
  data: string;
}

/**
 * 长流程 run 仓储。整份 FlowRun（含累积 state / cursor / engine / error）以 JSON 存 `data`，
 * 另冗余出常用查询列。续跑时读回 data 即可恢复全部状态。
 */
export class FlowRunRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    kind: string;
    subjectType: string;
    subjectId: string;
    engine: string;
    state?: Record<string, unknown>;
  }): FlowRun {
    const ts = now();
    const run: FlowRun = {
      id: randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: 'pending',
      cursor: 0,
      engine: input.engine,
      state: input.state ?? {},
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        'INSERT INTO flow_runs (id, project_id, kind, subject_type, subject_id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        run.id,
        run.projectId,
        run.kind,
        run.subjectType,
        run.subjectId,
        run.status,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
      );
    return run;
  }

  get(id: string): FlowRun | undefined {
    const row = this.db.prepare('SELECT id, data FROM flow_runs WHERE id = ?').get(id) as
      | IdDataRow
      | undefined;
    return row ? (JSON.parse(row.data) as FlowRun) : undefined;
  }

  /** 整体保存（编排器修改 run 对象后回写）。 */
  save(run: FlowRun): FlowRun {
    const updated: FlowRun = { ...run, updatedAt: now() };
    this.db
      .prepare('UPDATE flow_runs SET status = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(updated.status, JSON.stringify(updated), updated.updatedAt, updated.id);
    return updated;
  }

  listByProject(projectId: string): FlowRun[] {
    const rows = this.db
      .prepare('SELECT id, data FROM flow_runs WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as FlowRun);
  }

  listBySubject(subjectType: string, subjectId: string): FlowRun[] {
    const rows = this.db
      .prepare(
        'SELECT id, data FROM flow_runs WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC',
      )
      .all(subjectType, subjectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as FlowRun);
  }
}

/** 长流程 step 仓储。 */
export class FlowStepRepository {
  constructor(private readonly db: Db) {}

  create(input: { runId: string; projectId: string; ordinal: number; name: string }): FlowStep {
    const step: FlowStep = {
      id: randomUUID(),
      runId: input.runId,
      projectId: input.projectId,
      ordinal: input.ordinal,
      name: input.name,
      status: 'pending',
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO flow_steps (id, run_id, project_id, ordinal, name, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        step.id,
        step.runId,
        step.projectId,
        step.ordinal,
        step.name,
        step.status,
        JSON.stringify(step),
        step.createdAt,
      );
    return step;
  }

  save(step: FlowStep): FlowStep {
    this.db
      .prepare('UPDATE flow_steps SET status = ?, data = ? WHERE id = ?')
      .run(step.status, JSON.stringify(step), step.id);
    return step;
  }

  listByRun(runId: string): FlowStep[] {
    const rows = this.db
      .prepare('SELECT id, data FROM flow_steps WHERE run_id = ? ORDER BY ordinal ASC')
      .all(runId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as FlowStep);
  }
}
