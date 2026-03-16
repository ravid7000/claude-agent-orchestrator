import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoist mock instances ──────────────────────────────────────────────────

const {
  mockDecompose,
  mockWsInitialize,
  mockCreateWorkspace,
  mockCleanupWorkspace,
  mockShowPlan,
  mockDisplayInitialize,
  mockWriteOutput,
  mockShowSummary,
  mockRunSubAgent,
} = vi.hoisted(() => ({
  mockDecompose: vi.fn(),
  mockWsInitialize: vi.fn(),
  mockCreateWorkspace: vi.fn(),
  mockCleanupWorkspace: vi.fn(),
  mockShowPlan: vi.fn(),
  mockDisplayInitialize: vi.fn(),
  mockWriteOutput: vi.fn(),
  mockShowSummary: vi.fn(),
  mockRunSubAgent: vi.fn(),
}));

// Must use regular functions (not arrows) so `new Class()` works as a constructor
vi.mock('../planner.js', () => ({
  Planner: vi.fn().mockImplementation(function () {
    return { decompose: mockDecompose };
  }),
}));

vi.mock('../workspace.js', () => ({
  WorkspaceManager: vi.fn().mockImplementation(function () {
    return {
      initialize: mockWsInitialize,
      createWorkspace: mockCreateWorkspace,
      cleanupWorkspace: mockCleanupWorkspace,
    };
  }),
}));

vi.mock('../display.js', () => ({
  Display: vi.fn().mockImplementation(function () {
    return {
      showPlan: mockShowPlan,
      initialize: mockDisplayInitialize,
      writeOutput: mockWriteOutput,
      showSummary: mockShowSummary,
    };
  }),
}));

vi.mock('../runner.js', () => ({
  runSubAgent: mockRunSubAgent,
}));

vi.mock('@clack/prompts', () => ({
  log: {
    step: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  },
  confirm: vi.fn(),
  isCancel: vi.fn(),
  multiselect: vi.fn(),
  cancel: vi.fn(),
}));

import * as p from '@clack/prompts';
import { Orchestrator, runWithConcurrencyLimit } from '../orchestrator.js';
import type { AgentState, OrchestratorConfig } from '../types.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const mockConfirm = vi.mocked(p.confirm);
const mockIsCancel = vi.mocked(p.isCancel);
const mockMultiselect = vi.mocked(p.multiselect);

const SAMPLE_PLAN = {
  summary: 'Add dark mode',
  tasks: [
    {
      id: 'task-1',
      slug: 'add-dark-mode-css',
      title: 'Add dark mode CSS',
      description: 'Add CSS variables',
      files: ['src/styles.css'],
    },
    {
      id: 'task-2',
      slug: 'add-dark-mode-toggle',
      title: 'Add dark mode toggle',
      description: 'Add toggle button',
      files: ['src/Header.tsx'],
    },
  ],
};

const SAMPLE_WORKSPACE = (taskId: string) => ({
  taskId,
  taskSlug: taskId,
  branchName: `orchestrator/${taskId}-123`,
  path: `/tmp/ws/${taskId}`,
  type: 'worktree' as const,
  repoRoot: '/repo',
});

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    model: 'claude-opus-4-6',
    maxAgents: 5,
    workspace: { type: 'worktree' },
    tmux: false,
    ...overrides,
  };
}

function setupHappyPath() {
  mockWsInitialize.mockResolvedValue(undefined);
  mockDecompose.mockResolvedValue(SAMPLE_PLAN);
  mockConfirm.mockResolvedValue(true);
  mockIsCancel.mockReturnValue(false);
  mockMultiselect.mockResolvedValue(['task-1', 'task-2']);
  mockCreateWorkspace
    .mockResolvedValueOnce(SAMPLE_WORKSPACE('task-1'))
    .mockResolvedValueOnce(SAMPLE_WORKSPACE('task-2'));
  mockDisplayInitialize.mockResolvedValue(undefined);
  mockRunSubAgent.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1' });
  mockCleanupWorkspace.mockResolvedValue(undefined);
}

beforeEach(() => {
  // Reset individual method mocks only — do NOT use vi.resetAllMocks() as it
  // would remove the mockImplementation from the constructor mocks (WorkspaceManager,
  // Planner, Display) and break `new Class()` calls in orchestrator.run.
  mockDecompose.mockReset();
  mockWsInitialize.mockReset();
  mockCreateWorkspace.mockReset();
  mockCleanupWorkspace.mockReset();
  mockShowPlan.mockReset();
  mockDisplayInitialize.mockReset();
  mockWriteOutput.mockReset();
  mockShowSummary.mockReset();
  mockRunSubAgent.mockReset();
  mockIsCancel.mockReset();
  vi.mocked(p.confirm).mockReset();
  vi.mocked(p.multiselect).mockReset();
  vi.mocked(p.log.step).mockReset();
  vi.mocked(p.log.error).mockReset();
  vi.mocked(p.log.info).mockReset();
  vi.mocked(p.log.warn).mockReset();
  vi.mocked(p.log.success).mockReset();
  vi.mocked(p.cancel).mockReset();

  // Default: user doesn't cancel
  mockIsCancel.mockReturnValue(false);
});

// ─── runWithConcurrencyLimit ────────────────────────────────────────────────

describe('runWithConcurrencyLimit', () => {
  it('runs all items when limit >= count', async () => {
    const results: number[] = [];
    const states = [{ id: 1 }, { id: 2 }, { id: 3 }] as unknown as AgentState[];

    await runWithConcurrencyLimit(states, 5, async (s: any) => {
      results.push(s.id);
    });

    expect(results).toHaveLength(3);
    expect(results.sort()).toEqual([1, 2, 3]);
  });

  it('respects concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const states = Array.from({ length: 6 }, (_, i) => ({ i }) as unknown as AgentState);

    await runWithConcurrencyLimit(states, 2, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('runs all items with limit=1 (serial)', async () => {
    const order: number[] = [];
    const states = [1, 2, 3, 4].map((n) => ({ n }) as unknown as AgentState);

    await runWithConcurrencyLimit(states, 1, async (s: any) => {
      order.push(s.n);
      await new Promise((r) => setTimeout(r, 1));
    });

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('handles empty states array', async () => {
    const fn = vi.fn();
    await runWithConcurrencyLimit([], 3, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('propagates errors from fn', async () => {
    const states = [{}] as unknown as AgentState[];
    const fn = vi.fn().mockRejectedValue(new Error('task failed'));

    await expect(runWithConcurrencyLimit(states, 1, fn)).rejects.toThrow('task failed');
  });

  it('processes all items even with limit=1 and many items', async () => {
    const count = 10;
    const processed: number[] = [];
    const states = Array.from({ length: count }, (_, i) => ({ i }) as unknown as AgentState);

    await runWithConcurrencyLimit(states, 1, async (s: any) => {
      processed.push(s.i);
    });

    expect(processed).toHaveLength(count);
  });
});

// ─── Orchestrator.run — happy path ────────────────────────────────────────

describe('Orchestrator.run — happy path', () => {
  it('returns completedTasks and prs on success', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    const result = await orchestrator.run('add dark mode', { cwd: '/repo' });

    expect(result.completedTasks).toHaveLength(2);
    expect(result.failedTasks).toHaveLength(0);
    expect(result.prs).toHaveLength(2);
    expect(result.prs[0]?.url).toBe('https://github.com/org/repo/pull/1');
  });

  it('initializes workspace manager with cwd', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/my/project' });

    expect(mockWsInitialize).toHaveBeenCalledWith('/my/project');
  });

  it('calls decompose with task string and cwd', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('Add skeleton states', { cwd: '/repo' });

    expect(mockDecompose).toHaveBeenCalledWith('Add skeleton states', '/repo');
  });

  it('calls showPlan with the decomposition plan', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    expect(mockShowPlan).toHaveBeenCalledWith(SAMPLE_PLAN);
  });

  it('calls display.initialize with selected tasks', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    expect(mockDisplayInitialize).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'task-1' }),
        expect.objectContaining({ id: 'task-2' }),
      ]),
    );
  });

  it('calls runSubAgent for each selected task', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    expect(mockRunSubAgent).toHaveBeenCalledTimes(2);
  });

  it('calls cleanupWorkspace for each agent after running', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    expect(mockCleanupWorkspace).toHaveBeenCalledTimes(2);
  });

  it('calls showSummary with result', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    expect(mockShowSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        completedTasks: expect.any(Array),
        failedTasks: expect.any(Array),
        prs: expect.any(Array),
      }),
    );
  });
});

// ─── Orchestrator.run — user cancellation ────────────────────────────────

describe('Orchestrator.run — user cancellation', () => {
  it('exits process on confirm cancel', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(SAMPLE_PLAN);
    mockIsCancel.mockReturnValue(true);  // user hit Ctrl-C
    mockConfirm.mockResolvedValue(Symbol('clack:cancel'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const orchestrator = new Orchestrator(makeConfig());
    await expect(orchestrator.run('task', { cwd: '/repo' })).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('exits when user does not confirm (returns false)', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(SAMPLE_PLAN);
    mockConfirm.mockResolvedValue(false);
    mockIsCancel.mockReturnValue(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const orchestrator = new Orchestrator(makeConfig());
    await expect(orchestrator.run('task', { cwd: '/repo' })).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('exits when multiselect is cancelled', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(SAMPLE_PLAN);
    mockConfirm.mockResolvedValue(true);
    mockIsCancel
      .mockReturnValueOnce(false)  // confirm check
      .mockReturnValueOnce(true);  // multiselect check
    mockMultiselect.mockResolvedValue(Symbol('clack:cancel'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const orchestrator = new Orchestrator(makeConfig());
    await expect(orchestrator.run('task', { cwd: '/repo' })).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('exits when no tasks are selected from multiselect', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(SAMPLE_PLAN);
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);
    mockMultiselect.mockResolvedValue([]);  // no tasks selected

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const orchestrator = new Orchestrator(makeConfig());
    await expect(orchestrator.run('task', { cwd: '/repo' })).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});

// ─── Orchestrator.run — single task (no multiselect) ──────────────────────

describe('Orchestrator.run — single task', () => {
  it('skips multiselect prompt when plan has only one task', async () => {
    const singlePlan = {
      summary: 'Single fix',
      tasks: [SAMPLE_PLAN.tasks[0]!],
    };

    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(singlePlan);
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);
    mockCreateWorkspace.mockResolvedValue(SAMPLE_WORKSPACE('task-1'));
    mockDisplayInitialize.mockResolvedValue(undefined);
    mockRunSubAgent.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1' });
    mockCleanupWorkspace.mockResolvedValue(undefined);

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    expect(mockMultiselect).not.toHaveBeenCalled();
  });
});

// ─── Orchestrator.run — workspace failures ────────────────────────────────

describe('Orchestrator.run — workspace failures', () => {
  it('skips task when workspace creation fails, continues with others', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(SAMPLE_PLAN);
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);
    mockMultiselect.mockResolvedValue(['task-1', 'task-2']);
    mockCreateWorkspace
      .mockRejectedValueOnce(new Error('workspace creation failed'))
      .mockResolvedValueOnce(SAMPLE_WORKSPACE('task-2'));
    mockDisplayInitialize.mockResolvedValue(undefined);
    mockRunSubAgent.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/2' });
    mockCleanupWorkspace.mockResolvedValue(undefined);

    const orchestrator = new Orchestrator(makeConfig());
    const result = await orchestrator.run('task', { cwd: '/repo' });

    // Only task-2 succeeded (task-1 workspace creation failed)
    expect(result.completedTasks).toHaveLength(1);
    expect(result.completedTasks[0]?.task.id).toBe('task-2');
  });

  it('exits with code 1 when all workspace creations fail', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(SAMPLE_PLAN);
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);
    mockMultiselect.mockResolvedValue(['task-1', 'task-2']);
    mockCreateWorkspace.mockRejectedValue(new Error('git worktree failed'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const orchestrator = new Orchestrator(makeConfig());
    await expect(orchestrator.run('task', { cwd: '/repo' })).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ─── Orchestrator.run — agent failures ────────────────────────────────────

describe('Orchestrator.run — agent failures', () => {
  it('marks task as failed when runSubAgent throws', async () => {
    setupHappyPath();
    mockRunSubAgent
      .mockRejectedValueOnce(new Error('agent crashed'))
      .mockResolvedValueOnce({ prUrl: 'https://github.com/org/repo/pull/2' });

    const orchestrator = new Orchestrator(makeConfig());
    const result = await orchestrator.run('task', { cwd: '/repo' });

    expect(result.failedTasks).toHaveLength(1);
    expect(result.failedTasks[0]?.task.id).toBe('task-1');
    expect(result.failedTasks[0]?.error).toBe('agent crashed');
  });

  it('keeps workspace for failed tasks (keepOnFailure=true)', async () => {
    setupHappyPath();
    mockRunSubAgent
      .mockRejectedValueOnce(new Error('agent failed'))
      .mockResolvedValueOnce({ prUrl: 'https://github.com/org/repo/pull/2' });

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    const cleanupCalls = mockCleanupWorkspace.mock.calls;
    // First call (failed task) should have keepOnFailure=true
    const failedCall = cleanupCalls.find(([, keep]) => keep === true);
    expect(failedCall).toBeDefined();
  });

  it('cleans up workspace for successful tasks', async () => {
    setupHappyPath();

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    const cleanupCalls = mockCleanupWorkspace.mock.calls;
    const successCalls = cleanupCalls.filter(([, keep]) => keep === false);
    expect(successCalls).toHaveLength(2);
  });

  it('stores error message on failed agent state', async () => {
    setupHappyPath();
    mockRunSubAgent.mockRejectedValue(new Error('timeout error'));

    const orchestrator = new Orchestrator(makeConfig());
    const result = await orchestrator.run('task', { cwd: '/repo' });

    expect(result.failedTasks[0]?.error).toBe('timeout error');
  });
});

// ─── Orchestrator.run — planner errors ───────────────────────────────────

describe('Orchestrator.run — planner errors', () => {
  it('re-throws when decompose fails', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockRejectedValue(new Error('API error'));

    const orchestrator = new Orchestrator(makeConfig());
    await expect(orchestrator.run('task', { cwd: '/repo' })).rejects.toThrow('API error');
  });
});

// ─── Coverage: onOutput callback + non-Error throws ───────────────────────

describe('Orchestrator.run — coverage branches', () => {
  it('routes agent output through display.writeOutput callback', async () => {
    setupHappyPath();
    // Make runSubAgent call the onOutput callback before resolving
    mockRunSubAgent.mockImplementation(
      async (_task: any, _workspace: any, _config: any, onOutput: (t: string) => void) => {
        onOutput('line from agent\n');
        return { prUrl: 'https://github.com/org/repo/pull/1' };
      },
    );

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    // writeOutput should have been called with the agent output
    expect(mockWriteOutput).toHaveBeenCalledWith(expect.any(String), 'line from agent\n');
  });

  it('converts non-Error thrown by runSubAgent to string error message', async () => {
    setupHappyPath();
    // Throw a non-Error value (string) to exercise the String(err) branch
    mockRunSubAgent
      .mockRejectedValueOnce('plain string error')
      .mockResolvedValueOnce({ prUrl: 'https://github.com/org/repo/pull/2' });

    const orchestrator = new Orchestrator(makeConfig());
    const result = await orchestrator.run('task', { cwd: '/repo' });

    expect(result.failedTasks[0]?.error).toBe('plain string error');
  });

  it('shows undefined hint in multiselect when task has no files', async () => {
    // Tasks with empty files should produce hint: undefined in multiselect options
    const planNoFiles = {
      summary: 'Plan with no file hints',
      tasks: [
        { id: 'task-1', slug: 'task-1', title: 'Task 1', description: 'desc', files: [] },
        { id: 'task-2', slug: 'task-2', title: 'Task 2', description: 'desc', files: [] },
      ],
    };

    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(planNoFiles);
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);
    mockMultiselect.mockResolvedValue(['task-1', 'task-2']);
    mockCreateWorkspace
      .mockResolvedValueOnce(SAMPLE_WORKSPACE('task-1'))
      .mockResolvedValueOnce(SAMPLE_WORKSPACE('task-2'));
    mockDisplayInitialize.mockResolvedValue(undefined);
    mockRunSubAgent.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1' });
    mockCleanupWorkspace.mockResolvedValue(undefined);

    const orchestrator = new Orchestrator(makeConfig());
    await orchestrator.run('task', { cwd: '/repo' });

    // Check that multiselect was called with hint: undefined for no-file tasks
    const multiselectArgs = vi.mocked(p.multiselect).mock.calls[0]?.[0];
    const options = (multiselectArgs as any)?.options ?? [];
    expect(options[0]?.hint).toBeUndefined();
    expect(options[1]?.hint).toBeUndefined();
  });

  it('converts non-Error workspace creation failure to string', async () => {
    mockWsInitialize.mockResolvedValue(undefined);
    mockDecompose.mockResolvedValue(SAMPLE_PLAN);
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);
    mockMultiselect.mockResolvedValue(['task-1', 'task-2']);
    // Throw a non-Error (string) from createWorkspace
    mockCreateWorkspace
      .mockRejectedValueOnce('disk full')
      .mockResolvedValueOnce(SAMPLE_WORKSPACE('task-2'));
    mockDisplayInitialize.mockResolvedValue(undefined);
    mockRunSubAgent.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/2' });
    mockCleanupWorkspace.mockResolvedValue(undefined);

    const orchestrator = new Orchestrator(makeConfig());
    const result = await orchestrator.run('task', { cwd: '/repo' });

    // task-2 succeeded (task-1 workspace failed with string error)
    expect(result.completedTasks).toHaveLength(1);
    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );
  });
});
