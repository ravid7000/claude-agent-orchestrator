import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { Display } from '../display.js';
import type { SubTask, AgentState, OrchestratorResult, DecompositionPlan } from '../types.js';

const mockExeca = vi.mocked(execa);

// ─── Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function execaResult(stdout = '') {
  return { stdout, stderr: '', exitCode: 0 } as unknown as Awaited<ReturnType<typeof execa>>;
}

function makeTasks(count = 2): SubTask[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i + 1}`,
    slug: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    description: `Description for task ${i + 1}`,
    files: [`src/file${i + 1}.ts`],
  }));
}

function makePlan(tasks: SubTask[] = makeTasks()): DecompositionPlan {
  return { summary: 'Add dark mode support', tasks };
}

function makeAgentState(task: SubTask, overrides: Partial<AgentState> = {}): AgentState {
  return {
    task,
    workspace: {
      taskId: task.id,
      taskSlug: task.slug,
      branchName: `orchestrator/${task.slug}-123`,
      path: `/tmp/ws/${task.id}`,
      type: 'worktree',
      repoRoot: '/repo',
    },
    status: 'success',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'display-test-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(tmpDir);
  mockExeca.mockReset();
  // Unset TMUX to avoid tmux path in tests
  vi.stubEnv('TMUX', '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Allow fire-and-forget fs.appendFile calls in writeOutput to flush before cleanup
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── showPlan ──────────────────────────────────────────────────────────────

describe('Display.showPlan', () => {
  it('logs the plan summary', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);
    display.showPlan(makePlan());

    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('Add dark mode support');
    logSpy.mockRestore();
  });

  it('logs each task id and title', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);
    const tasks = makeTasks(3);
    display.showPlan(makePlan(tasks));

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('task-1');
    expect(allOutput).toContain('task-2');
    expect(allOutput).toContain('task-3');
    logSpy.mockRestore();
  });

  it('logs file hints when task has files', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);
    const tasks: SubTask[] = [{
      id: 'task-1', slug: 'task', title: 'Task', description: 'desc',
      files: ['src/Button.tsx', 'src/styles.css'],
    }];
    display.showPlan(makePlan(tasks));

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('src/Button.tsx');
    logSpy.mockRestore();
  });
});

// ─── initialize — no tmux ─────────────────────────────────────────────────

describe('Display.initialize — tmux disabled', () => {
  it('creates a log file per task', async () => {
    const display = new Display(false);
    const tasks = makeTasks(2);
    await display.initialize(tasks);

    expect(display.getLogPath('task-1')).toBeDefined();
    expect(display.getLogPath('task-2')).toBeDefined();
    expect(fs.existsSync(display.getLogPath('task-1')!)).toBe(true);
    expect(fs.existsSync(display.getLogPath('task-2')!)).toBe(true);
  });

  it('writes header to each log file', async () => {
    const display = new Display(false);
    const tasks = makeTasks(1);
    await display.initialize(tasks);

    const content = fs.readFileSync(display.getLogPath('task-1')!, 'utf-8');
    expect(content).toContain('Task 1');
  });

  it('prints tmux-disabled message to console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);
    await display.initialize(makeTasks(1));

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('tmux disabled');
    logSpy.mockRestore();
  });

  it('returns undefined log path for unknown task', async () => {
    const display = new Display(false);
    await display.initialize(makeTasks(1));
    expect(display.getLogPath('nonexistent')).toBeUndefined();
  });
});

describe('Display.initialize — tmux enabled but unavailable', () => {
  it('falls back gracefully when tmux binary not found', async () => {
    // 'which tmux' fails
    mockExeca.mockRejectedValue(new Error('not found'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(true);
    await display.initialize(makeTasks(1));

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('tmux not found');
    logSpy.mockRestore();
  });

  it('still creates log files even when tmux is unavailable', async () => {
    mockExeca.mockRejectedValue(new Error('not found'));

    const display = new Display(true);
    await display.initialize(makeTasks(2));

    expect(display.getLogPath('task-1')).toBeDefined();
    expect(display.getLogPath('task-2')).toBeDefined();
  });
});

describe('Display.initialize — tmux enabled and available (detached session)', () => {
  beforeEach(() => {
    vi.stubEnv('TMUX', '');  // not in tmux
  });

  function setupTmuxMocks() {
    mockExeca
      .mockResolvedValueOnce(execaResult('/usr/bin/tmux'))  // which tmux
      .mockResolvedValueOnce(execaResult(''))  // new-session
      .mockResolvedValueOnce(execaResult('%0'))  // display-message (current pane)
      .mockResolvedValueOnce(execaResult(''))  // send-keys (orchestrator status)
      .mockResolvedValueOnce(execaResult('%1'))  // split-window pane 1
      .mockResolvedValueOnce(execaResult(''))  // send-keys tail -f
      .mockResolvedValueOnce(execaResult('%2'))  // split-window pane 2
      .mockResolvedValueOnce(execaResult(''))  // send-keys tail -f
      .mockResolvedValueOnce(execaResult(''))  // select-layout tiled
  }

  it('creates a detached tmux session', async () => {
    setupTmuxMocks();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const display = new Display(true);
    await display.initialize(makeTasks(2));

    const newSessionCall = mockExeca.mock.calls.find(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('new-session'),
    );
    expect(newSessionCall).toBeDefined();
    logSpy.mockRestore();
  });

  it('prints attach command when not in tmux', async () => {
    setupTmuxMocks();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const display = new Display(true);
    await display.initialize(makeTasks(2));

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('tmux attach');
    logSpy.mockRestore();
  });

  it('starts tail -f for each task pane', async () => {
    setupTmuxMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const display = new Display(true);
    const tasks = makeTasks(2);
    await display.initialize(tasks);

    const sendKeysCalls = mockExeca.mock.calls.filter(
      ([cmd, args]) => cmd === 'tmux' && (args as string[])[0] === 'send-keys',
    );
    const tailCalls = sendKeysCalls.filter(([, args]) =>
      (args as string[]).some((a) => typeof a === 'string' && a.includes('tail -f')),
    );
    expect(tailCalls.length).toBe(2);
  });
});

// ─── writeOutput ───────────────────────────────────────────────────────────

describe('Display.writeOutput', () => {
  it('appends text to the task log file', async () => {
    const display = new Display(false);
    await display.initialize(makeTasks(1));

    display.writeOutput('task-1', 'Hello from agent\n');

    // fs.appendFile is async (fire-and-forget in Display); wait for it to flush
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const content = fs.readFileSync(display.getLogPath('task-1')!, 'utf-8');
    expect(content).toContain('Hello from agent');
  });

  it('prints to stdout with task prefix when not in tmux mode', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const display = new Display(false);
    await display.initialize(makeTasks(1));

    display.writeOutput('task-1', 'Agent output line\n');

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('task-1'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Agent output line'));
    writeSpy.mockRestore();
  });

  it('does not write to stdout empty/whitespace-only lines', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const display = new Display(false);
    await display.initialize(makeTasks(1));

    display.writeOutput('task-1', '   \n\n  \n');

    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('handles unknown taskId gracefully (no crash)', async () => {
    const display = new Display(false);
    await display.initialize(makeTasks(1));

    // Should not throw
    expect(() => display.writeOutput('nonexistent', 'text')).not.toThrow();
  });

  it('uses different ANSI colors per task', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const display = new Display(false);
    const tasks = makeTasks(2);
    await display.initialize(tasks);

    display.writeOutput('task-1', 'line1\n');
    display.writeOutput('task-2', 'line2\n');

    const outputs = writeSpy.mock.calls.map((c) => c[0] as string);
    // Both outputs have ANSI escape sequences but different ones
    const task1Output = outputs.find((o) => o.includes('task-1')) ?? '';
    const task2Output = outputs.find((o) => o.includes('task-2')) ?? '';
    expect(task1Output).toContain('\x1b[');
    expect(task2Output).toContain('\x1b[');
    writeSpy.mockRestore();
  });
});

// ─── showSummary ───────────────────────────────────────────────────────────

describe('Display.showSummary', () => {
  it('shows completed task titles', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);
    const tasks = makeTasks(2);

    const result: OrchestratorResult = {
      completedTasks: [makeAgentState(tasks[0]!, { prUrl: 'https://github.com/org/repo/pull/1' })],
      failedTasks: [],
      prs: [{ taskTitle: 'Task 1', url: 'https://github.com/org/repo/pull/1' }],
    };
    display.showSummary(result);

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('Task 1');
    expect(allOutput).toContain('https://github.com/org/repo/pull/1');
    logSpy.mockRestore();
  });

  it('shows failed task titles and errors', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);
    const tasks = makeTasks(1);

    const result: OrchestratorResult = {
      completedTasks: [],
      failedTasks: [makeAgentState(tasks[0]!, { status: 'failed', error: 'Timeout' })],
      prs: [],
    };
    display.showSummary(result);

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('Task 1');
    expect(allOutput).toContain('Timeout');
    logSpy.mockRestore();
  });

  it('shows PR URLs in summary', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);

    const result: OrchestratorResult = {
      completedTasks: [],
      failedTasks: [],
      prs: [
        { taskTitle: 'Task A', url: 'https://github.com/org/repo/pull/10' },
        { taskTitle: 'Task B', url: 'https://github.com/org/repo/pull/11' },
      ],
    };
    display.showSummary(result);

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('Task A');
    expect(allOutput).toContain('Task B');
    expect(allOutput).toContain('pull/10');
    expect(allOutput).toContain('pull/11');
    logSpy.mockRestore();
  });

  it('shows failed workspace path for debugging', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);
    const tasks = makeTasks(1);
    await display.initialize(tasks);

    const result: OrchestratorResult = {
      completedTasks: [],
      failedTasks: [makeAgentState(tasks[0]!, { status: 'failed', error: 'git push failed' })],
      prs: [],
    };
    display.showSummary(result);

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('/tmp/ws/task-1');
    logSpy.mockRestore();
  });

  it('handles empty result gracefully', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = new Display(false);

    const result: OrchestratorResult = { completedTasks: [], failedTasks: [], prs: [] };
    expect(() => display.showSummary(result)).not.toThrow();
    logSpy.mockRestore();
  });
});

// ─── initialize — in tmux session (lines 163-177) ────────────────────────

describe('Display.initialize — inside existing tmux session', () => {
  beforeEach(() => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,0,0');
  });

  function setupInTmuxMocks(taskCount: number) {
    // which tmux → available
    mockExeca.mockResolvedValueOnce(execaResult('/usr/bin/tmux'));
    // display-message -p #{session_name} → current session name
    mockExeca.mockResolvedValueOnce(execaResult('my-session'));
    // display-message -t my-session:0 -p #{pane_id} → orchestrator pane
    mockExeca.mockResolvedValueOnce(execaResult('%0'));

    for (let i = 0; i < taskCount; i++) {
      // split-window for each task pane
      mockExeca.mockResolvedValueOnce(execaResult(`%${i + 1}`));
      // send-keys tail -f
      mockExeca.mockResolvedValueOnce(execaResult(''));
    }

    // select-layout tiled
    mockExeca.mockResolvedValueOnce(execaResult(''));
  }

  it('uses existing tmux session instead of creating a new one', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setupInTmuxMocks(2);

    const display = new Display(true);
    await display.initialize(makeTasks(2));

    // Should NOT have called new-session
    const newSessionCall = mockExeca.mock.calls.find(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('new-session'),
    );
    expect(newSessionCall).toBeUndefined();
    logSpy.mockRestore();
  });

  it('creates panes for each task in existing session', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setupInTmuxMocks(2);

    const display = new Display(true);
    await display.initialize(makeTasks(2));

    const splitWindowCalls = mockExeca.mock.calls.filter(
      ([cmd, args]) => cmd === 'tmux' && (args as string[])[0] === 'split-window',
    );
    expect(splitWindowCalls).toHaveLength(2);
  });

  it('does NOT print tmux attach message when already in tmux', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setupInTmuxMocks(1);

    const display = new Display(true);
    await display.initialize(makeTasks(1));

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).not.toContain('tmux attach');
    logSpy.mockRestore();
  });

  it('showSummary prints logDir when useTmux=true', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setupInTmuxMocks(1);

    const display = new Display(true);
    const tasks = makeTasks(1);
    await display.initialize(tasks);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result: OrchestratorResult = { completedTasks: [], failedTasks: [], prs: [] };
    display.showSummary(result);

    const allOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('Agent logs preserved at');
    logSpy.mockRestore();
  });
});
