/**
 * 回归：半自动执行器的**安全边界**。
 *
 * 这是权限边界的唯一守卫，必须钉死：
 * 1. 只读动作自动放行（测量/追溯/枚举/定位等）；
 * 2. 写动作**默认一律拦下**，即使它排在路径首位；
 * 3. 未分级动作 fail-closed（不猜有没有副作用）；
 * 4. 白名单放行后写动作才执行；
 * 5. 拦下的写动作能被调用方看到（不是静默跳过）。
 */
import { describe, expect, it } from 'vitest';

import type { ActionInvocation } from '@clis/clis-contracts';
import { ACTION_SIDE_EFFECTS, SemiAutoExecutor, sideEffectOf } from '../packages/clis-plugin/src/executor';

/** 造一个动作调用。 */
function invoke(action: string, params: Record<string, unknown> = {}): ActionInvocation {
  return { path_id: 'p1', step_index: 0, action, params };
}

/** 全部写动作（从分级表里取，不手抄）。 */
const WRITE_ACTIONS = Object.entries(ACTION_SIDE_EFFECTS)
  .filter(([, level]) => level === 'write')
  .map(([action]) => action);

/** 全部只读动作。 */
const READ_ACTIONS = Object.entries(ACTION_SIDE_EFFECTS)
  .filter(([, level]) => level === 'read')
  .map(([action]) => action);

describe('动作分级表', () => {
  it('27 个策略动作全部完成了分级（无遗漏）', () => {
    // 与策略库的动作集合一一对应；新增动作时必须同步分级，
    // 否则执行器会 fail-closed 拒绝 —— 这是有意的强制。
    expect(Object.keys(ACTION_SIDE_EFFECTS).length).toBe(27);
  });

  it('只读与写两类都非空', () => {
    expect(READ_ACTIONS.length).toBeGreaterThan(0);
    expect(WRITE_ACTIONS.length).toBeGreaterThan(0);
  });

  it('典型只读动作分类正确', () => {
    for (const action of [
      'measure_loop_gain',
      'trace_upstream',
      'enumerate_conditions',
      'map_feedback_loop',
      'extract_definitions',
    ]) {
      expect(sideEffectOf(action)).toBe('read');
    }
  });

  it('典型写动作分类正确', () => {
    for (const action of [
      'apply_intervention',
      'inject_damping',
      'shift_delay',
      'tune_relation_parameter',
      'limit_gain',
    ]) {
      expect(sideEffectOf(action)).toBe('write');
    }
  });

  it('未登记的动作返回 undefined（交由执行器 fail-closed）', () => {
    expect(sideEffectOf('nonexistent_action')).toBeUndefined();
  });
});

describe('半自动执行器：只读放行', () => {
  it('只读动作返回 ok 并记录到 observations', async () => {
    const executor = new SemiAutoExecutor();

    for (const action of READ_ACTIONS) {
      const result = await executor.execute(invoke(action));
      expect(result.status).toBe('ok');
      expect(result.detail).toContain('只读观测');
    }

    expect(executor.observations).toEqual(READ_ACTIONS);
    expect(executor.pendingWrites).toEqual([]);
  });
});

describe('半自动执行器：写动作默认拦下', () => {
  it('写动作返回 failed 并记录到 pendingWrites', async () => {
    const executor = new SemiAutoExecutor();

    for (const action of WRITE_ACTIONS) {
      const result = await executor.execute(invoke(action));
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('需授权');
    }

    expect(executor.pendingWrites).toEqual(WRITE_ACTIONS);
    expect(executor.observations).toEqual([]);
  });

  it('即使写动作排在最前，也不会被执行', async () => {
    const executor = new SemiAutoExecutor();
    // 这是真实风险场景：干预动作通常是路径的第一步
    const result = await executor.execute(invoke('apply_intervention', { strength: 1 }));

    expect(result.status).toBe('failed');
    expect(executor.pendingWrites).toContain('apply_intervention');
  });
});

describe('半自动执行器：未分级动作 fail-closed', () => {
  it('未登记动作被拒绝（不猜它有没有副作用）', async () => {
    const executor = new SemiAutoExecutor();
    const result = await executor.execute(invoke('totally_unknown_action'));

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('未分级');
    expect(executor.pendingWrites).toContain('totally_unknown_action');
  });
});

describe('半自动执行器：白名单放行', () => {
  it('白名单内的写动作被执行', async () => {
    const executor = new SemiAutoExecutor({ allowWrites: ['inject_damping'] });
    const result = await executor.execute(invoke('inject_damping', { coefficient: 0.2 }));

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('白名单');
    expect(executor.pendingWrites).not.toContain('inject_damping');
  });

  it('白名单只放行列出的那个，其余写动作仍拦下', async () => {
    const executor = new SemiAutoExecutor({ allowWrites: ['inject_damping'] });

    const allowed = await executor.execute(invoke('inject_damping'));
    const other = await executor.execute(invoke('apply_intervention'));

    expect(allowed.status).toBe('ok');
    expect(other.status).toBe('failed');
    expect(executor.pendingWrites).toEqual(['apply_intervention']);
  });

  it('白名单不影响只读动作', async () => {
    const executor = new SemiAutoExecutor({ allowWrites: [] });
    const result = await executor.execute(invoke('measure_loop_gain'));

    expect(result.status).toBe('ok');
  });
});

describe('半自动执行器：可审计', () => {
  it('一次混合执行能分别列出观测与拦下的写动作', async () => {
    const executor = new SemiAutoExecutor();

    await executor.execute(invoke('map_feedback_loop'));
    await executor.execute(invoke('measure_loop_gain'));
    await executor.execute(invoke('limit_gain'));
    await executor.execute(invoke('inject_damping'));

    expect(executor.observations).toEqual(['map_feedback_loop', 'measure_loop_gain']);
    expect(executor.pendingWrites).toEqual(['limit_gain', 'inject_damping']);
  });
});
