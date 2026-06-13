import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition } from '../src/pipeline/status';

describe('候选人状态机', () => {
  it('允许 applied → screening/interview/rejected/talent_pool', () => {
    expect(canTransition('applied', 'screening')).toBe(true);
    expect(canTransition('applied', 'interview')).toBe(true);
    expect(canTransition('applied', 'rejected')).toBe(true);
    expect(canTransition('applied', 'talent_pool')).toBe(true);
  });

  it('允许 screening → interview/rejected/talent_pool，但不允许回到 applied', () => {
    expect(canTransition('screening', 'interview')).toBe(true);
    expect(canTransition('screening', 'rejected')).toBe(true);
    expect(canTransition('screening', 'applied')).toBe(false);
  });

  it('rejected 仅可重新纳入人才库（其余终态）', () => {
    expect(canTransition('rejected', 'talent_pool')).toBe(true);
    expect(canTransition('rejected', 'interview')).toBe(false);
    expect(canTransition('rejected', 'screening')).toBe(false);
  });

  it('每个状态都定义了迁移表（含终态用空/受限集合）', () => {
    for (const tos of Object.values(ALLOWED_TRANSITIONS)) {
      expect(Array.isArray(tos)).toBe(true);
    }
  });
});
