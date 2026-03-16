import { describe, it, expect } from 'vitest';
import {
  OrchestratorError,
  ConfigError,
  PlannerError,
  WorkspaceError,
  RunnerError,
} from '../types.js';

describe('OrchestratorError', () => {
  it('sets message, name, and code', () => {
    const err = new OrchestratorError('something broke', 'SOME_CODE');
    expect(err.message).toBe('something broke');
    expect(err.name).toBe('OrchestratorError');
    expect(err.code).toBe('SOME_CODE');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ConfigError', () => {
  it('extends OrchestratorError with CONFIG_ERROR code', () => {
    const err = new ConfigError('bad config');
    expect(err.message).toBe('bad config');
    expect(err.name).toBe('ConfigError');
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('PlannerError', () => {
  it('extends OrchestratorError with PLANNER_ERROR code', () => {
    const err = new PlannerError('planning failed');
    expect(err.message).toBe('planning failed');
    expect(err.name).toBe('PlannerError');
    expect(err.code).toBe('PLANNER_ERROR');
    expect(err).toBeInstanceOf(OrchestratorError);
  });
});

describe('WorkspaceError', () => {
  it('includes taskId and WORKSPACE_ERROR code', () => {
    const err = new WorkspaceError('workspace failed', 'task-1');
    expect(err.message).toBe('workspace failed');
    expect(err.name).toBe('WorkspaceError');
    expect(err.code).toBe('WORKSPACE_ERROR');
    expect(err.taskId).toBe('task-1');
    expect(err).toBeInstanceOf(OrchestratorError);
  });
});

describe('RunnerError', () => {
  it('includes taskId and RUNNER_ERROR code', () => {
    const err = new RunnerError('agent failed', 'task-2');
    expect(err.message).toBe('agent failed');
    expect(err.name).toBe('RunnerError');
    expect(err.code).toBe('RUNNER_ERROR');
    expect(err.taskId).toBe('task-2');
    expect(err.exitCode).toBeUndefined();
  });

  it('stores optional exitCode', () => {
    const err = new RunnerError('non-zero exit', 'task-3', 1);
    expect(err.exitCode).toBe(1);
    expect(err.taskId).toBe('task-3');
  });

  it('extends OrchestratorError', () => {
    const err = new RunnerError('x', 'task-1', 2);
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(err).toBeInstanceOf(Error);
  });
});
