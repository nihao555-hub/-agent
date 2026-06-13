import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db';
import {
  AnalysisRepository,
  CapabilityRepository,
  EventRepository,
  TenderRepository,
} from '../src/db/repositories';
import type { TenderSpec } from '../src/types';

function sampleTender(): TenderSpec {
  return {
    projectName: '某项目',
    requirements: [{ id: 'R1', category: '资质', text: '需要二级资质', mandatory: true }],
    scoringItems: [],
    disqualifications: [],
    milestones: [],
  };
}

describe('SQLite 仓储（内存库）', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('TenderRepository 存取与列表', () => {
    const repo = new TenderRepository(db);
    const id = repo.create(sampleTender(), 'rule-based');
    const got = repo.get(id);
    expect(got?.projectName).toBe('某项目');
    expect(got?.requirements[0].id).toBe('R1');
    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].engine).toBe('rule-based');
    expect(repo.get('missing')).toBeUndefined();
  });

  it('CapabilityRepository 存取', () => {
    const repo = new CapabilityRepository(db);
    const id = repo.create({ companyName: '示例建工', qualifications: ['一级'] });
    expect(repo.get(id)?.companyName).toBe('示例建工');
    expect(repo.get('missing')).toBeUndefined();
  });

  it('AnalysisRepository / EventRepository 按招标文件归集', () => {
    const tenders = new TenderRepository(db);
    const analyses = new AnalysisRepository(db);
    const events = new EventRepository(db);
    const tenderId = tenders.create(sampleTender(), 'rule-based');

    analyses.create({
      tenderId,
      kind: 'gap',
      engine: 'rule-based',
      result: { findings: [], summary: 's', blockers: [] },
    });
    events.create(tenderId, 'tender_parsed', { engine: 'rule-based' });
    events.create(tenderId, 'gap_detected', { blockers: 0 });

    expect(analyses.listByTender(tenderId)).toHaveLength(1);
    const evs = events.listByTender(tenderId);
    expect(evs).toHaveLength(2);
    // 事件按时间升序
    expect(evs[0].type).toBe('tender_parsed');
    expect(evs[1].detail.blockers).toBe(0);
  });

  it('foreign_keys 外键约束生效', () => {
    const events = new EventRepository(db);
    // tender_id 引用不存在的招标文件应被外键拒绝
    expect(() => events.create('no-such-tender', 'x')).toThrow();
  });
});
