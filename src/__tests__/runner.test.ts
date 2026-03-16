import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { runSubAgent } from '../runner.js';
import { RunnerError } from '../types.js';
import type { SubTask, Workspace, OrchestratorConfig } from '../types.js';

const mockExeca = vi.mocked(execa);

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'task-1',
    slug: 'add-feature',
    title: 'Add Feature',
    description: 'Implement the feature',
    files: ['src/feature.ts'],
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    taskId: 'task-1',
    taskSlug: 'add-feature',
    branchName: 'orchestrator/add-feature-123',
    path: '/tmp/workspace/task-1',
    type: 'worktree',
    repoRoot: '/tmp/repo',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    model: 'claude-opus-4-6',
    maxAgents: 5,
    workspace: { type: 'worktree' },
    tmux: true,
    ...overrides,
  };
}

/**
 * Creates a mock execa subprocess with controllable stdout/stderr streams.
 * The mock simulates a child process that emits data events then resolves.
 */
function createMockSubprocess(options: {
  stdoutChunks?: string[];
  stderrText?: string;
  exitCode?: number;
} = {}) {
  const { stdoutChunks = [], stderrText = '', exitCode = 0 } = options;

  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdout.setEncoding = vi.fn();

  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr.setEncoding = vi.fn();

  let resolveProc!: (val: { exitCode: number }) => void;
  const resultPromise = new Promise<{ exitCode: number }>((res) => {
    resolveProc = res;
  });

  // Emit asynchronously after listeners are attached
  setImmediate(() => {
    for (const chunk of stdoutChunks) {
      stdout.emit('data', chunk);
    }
    if (stderrText) {
      stderr.emit('data', stderrText);
    }
    resolveProc({ exitCode });
  });

  return Object.assign(resultPromise, { stdout, stderr }) as unknown as ReturnType<typeof execa>;
}

function ghResult(url: string) {
  return { stdout: url, stderr: '', exitCode: 0 } as unknown as Awaited<ReturnType<typeof execa>>;
}

function makeAssistantEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }) + '\n';
}

function makeResultEvent(options: { isError?: boolean; cost?: number } = {}): string {
  return JSON.stringify({
    type: 'result',
    is_error: options.isError ?? false,
    result: options.isError ? 'Agent error occurred' : undefined,
    total_cost_usd: options.cost,
  }) + '\n';
}

// ─── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockExeca.mockReset();
});

describe('runSubAgent — PR URL in stream', () => {
  it('extracts PR URL from assistant text output', async () => {
    const prText = 'I created the PR.\nPR_URL: https://github.com/org/repo/pull/42\n';
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [makeAssistantEvent(prText)] }),
    );

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('calls onOutput with assistant text', async () => {
    const onOutput = vi.fn();
    const prText = 'Done! PR_URL: https://github.com/org/repo/pull/7\n';
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [makeAssistantEvent(prText)] }),
    );

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), onOutput);
    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('Done!'));
  });

  it('handles PR_URL case-insensitively', async () => {
    const text = 'pr_url: https://github.com/org/repo/pull/99\n';
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [makeAssistantEvent(text)] }),
    );

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/99');
  });

  it('handles multiple stdout chunks correctly', async () => {
    const chunk1 = makeAssistantEvent('Working on the feature...\n');
    const chunk2 = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/5\n');
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [chunk1, chunk2] }),
    );

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/5');
  });

  it('emits cost output on result event', async () => {
    const onOutput = vi.fn();
    const prText = 'PR_URL: https://github.com/org/repo/pull/1\n';
    const chunks = [makeAssistantEvent(prText), makeResultEvent({ cost: 0.0123 })];
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: chunks }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), onOutput);
    const allOutput = onOutput.mock.calls.map((c) => c[0]).join('');
    expect(allOutput).toContain('[Cost: $0.0123]');
  });

  it('handles non-JSON lines as raw text', async () => {
    const onOutput = vi.fn();
    const rawLine = 'Some raw output line\n';
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [rawLine, prText] }),
    );

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), onOutput);
    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('Some raw output line'));
  });
});

describe('runSubAgent — PR URL fallback via gh CLI', () => {
  it('falls back to gh pr view when PR URL not in stream', async () => {
    const chunks = [makeAssistantEvent('All done, branch pushed.\n')];
    mockExeca
      .mockReturnValueOnce(createMockSubprocess({ stdoutChunks: chunks }))  // claude
      .mockResolvedValueOnce(ghResult('https://github.com/org/repo/pull/10'));  // gh

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/10');
  });

  it('throws RunnerError when gh fallback also has no PR', async () => {
    const onOutput = vi.fn();
    mockExeca
      .mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [] }))  // claude — no PR URL
      .mockRejectedValueOnce(new Error('no PR found'));  // gh fails

    const err = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), onOutput).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.message).toContain('no PR URL was found');
  });
});

describe('runSubAgent — error handling', () => {
  it('throws RunnerError when process exits with non-zero code', async () => {
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stderrText: 'fatal: not a git repo', exitCode: 1 }),
    );

    const err = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn()).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.exitCode).toBe(1);
    expect(err.taskId).toBe('task-1');
  });

  it('throws RunnerError when result event has is_error=true', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    const errorResult = makeResultEvent({ isError: true });
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [prText, errorResult] }),
    );

    const err = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn()).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.message).toContain('Agent failed');
  });

  it('RunnerError includes taskId from the task', async () => {
    mockExeca.mockReturnValueOnce(createMockSubprocess({ exitCode: 127 }));

    const err = await runSubAgent(
      makeTask({ id: 'task-5' }),
      makeWorkspace({ taskId: 'task-5' }),
      makeConfig(),
      vi.fn(),
    ).catch((e) => e);

    expect(err.taskId).toBe('task-5');
  });
});

describe('runSubAgent — CLI args', () => {
  it('passes model to claude CLI', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig({ model: 'claude-haiku-4-5-20251001' }), vi.fn());

    const [cmd, args] = mockExeca.mock.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args).toContain('claude-haiku-4-5-20251001');
    expect(args).toContain('--model');
  });

  it('includes --max-budget-usd when configured', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig({ maxBudgetPerAgentUsd: 2.5 }), vi.fn());

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('2.5');
  });

  it('omits --max-budget-usd when not configured', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args).not.toContain('--max-budget-usd');
  });

  it('sets ANTHROPIC_AUTH_TOKEN in subprocess env from authToken', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig({ authToken: 'sk-ant-auth' }), vi.fn());

    const [, , opts] = mockExeca.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect((opts as any)?.env?.['ANTHROPIC_AUTH_TOKEN']).toBe('sk-ant-auth');
  });

  it('sets ANTHROPIC_API_KEY in subprocess env from apiKey', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig({ apiKey: 'sk-ant-key' }), vi.fn());

    const [, , opts] = mockExeca.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect((opts as any)?.env?.['ANTHROPIC_API_KEY']).toBe('sk-ant-key');
  });

  it('sets ANTHROPIC_BASE_URL in subprocess env when configured', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(
      makeTask(),
      makeWorkspace(),
      makeConfig({ baseUrl: 'https://proxy.example.com' }),
      vi.fn(),
    );

    const [, , opts] = mockExeca.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect((opts as any)?.env?.['ANTHROPIC_BASE_URL']).toBe('https://proxy.example.com');
  });

  it('sets GH_TOKEN from github.token config', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(
      makeTask(),
      makeWorkspace(),
      makeConfig({ github: { token: 'ghp_mytoken' } }),
      vi.fn(),
    );

    const [, , opts] = mockExeca.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect((opts as any)?.env?.['GH_TOKEN']).toBe('ghp_mytoken');
  });

  it('runs claude CLI in the workspace path (cwd)', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(
      makeTask(),
      makeWorkspace({ path: '/custom/workspace/path' }),
      makeConfig(),
      vi.fn(),
    );

    const [, , opts] = mockExeca.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect((opts as any)?.cwd).toBe('/custom/workspace/path');
  });

  it('includes --dangerously-skip-permissions flag', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('includes --output-format stream-json flag', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    const [, args] = mockExeca.mock.calls[0]!;
    const formatIdx = (args as string[]).indexOf('--output-format');
    expect(formatIdx).toBeGreaterThan(-1);
    expect((args as string[])[formatIdx + 1]).toBe('stream-json');
  });
});

describe('runSubAgent — prompt content', () => {
  it('includes task title in the prompt', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask({ title: 'Add Skeleton Loading States' }), makeWorkspace(), makeConfig(), vi.fn());

    const [, args] = mockExeca.mock.calls[0]!;
    const printIdx = (args as string[]).indexOf('--print');
    const prompt = (args as string[])[printIdx + 1] ?? '';
    expect(prompt).toContain('Add Skeleton Loading States');
  });

  it('includes branch name in the prompt', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(
      makeTask(),
      makeWorkspace({ branchName: 'orchestrator/custom-branch-999' }),
      makeConfig(),
      vi.fn(),
    );

    const [, args] = mockExeca.mock.calls[0]!;
    const printIdx = (args as string[]).indexOf('--print');
    const prompt = (args as string[])[printIdx + 1] ?? '';
    expect(prompt).toContain('orchestrator/custom-branch-999');
  });

  it('mentions files in the prompt when files are provided', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(
      makeTask({ files: ['src/Button.tsx', 'src/styles.css'] }),
      makeWorkspace(),
      makeConfig(),
      vi.fn(),
    );

    const [, args] = mockExeca.mock.calls[0]!;
    const printIdx = (args as string[]).indexOf('--print');
    const prompt = (args as string[])[printIdx + 1] ?? '';
    expect(prompt).toContain('src/Button.tsx');
    expect(prompt).toContain('src/styles.css');
  });

  it('shows generic "explore codebase" hint when no files are specified', async () => {
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    mockExeca.mockReturnValueOnce(createMockSubprocess({ stdoutChunks: [prText] }));

    await runSubAgent(makeTask({ files: [] }), makeWorkspace(), makeConfig(), vi.fn());

    const [, args] = mockExeca.mock.calls[0]!;
    const printIdx = (args as string[]).indexOf('--print');
    const prompt = (args as string[])[printIdx + 1] ?? '';
    expect(prompt).toContain('Explore the codebase');
  });
});

// ─── Coverage: collectedOutput PR_URL fallback (line 220) ─────────────────

describe('runSubAgent — collectedOutput PR_URL fallback', () => {
  it('finds PR URL in raw non-JSON output (not caught during streaming)', async () => {
    // When a raw non-JSON line contains PR_URL, it's not matched during streaming
    // but IS caught by the post-process collectedOutput check (line 220)
    const rawPrUrlLine = 'PR_URL: https://github.com/org/repo/pull/55\n';
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [rawPrUrlLine] }),
    );

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/55');
  });
});

// ─── Coverage: edge case branches ─────────────────────────────────────────

describe('runSubAgent — edge cases', () => {
  it('uses fallback message when is_error result event has no result field', async () => {
    // result event with is_error=true but no result field → uses 'Unknown error' fallback
    const errorEvent = JSON.stringify({ type: 'result', is_error: true }) + '\n';
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [errorEvent] }),
    );

    const err = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn()).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.message).toContain('Unknown error during agent execution');
  });

  it('handles subprocess without stderr stream', async () => {
    // Create a subprocess mock with no stderr property
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    const stdout = new EventEmitter() as any;
    stdout.setEncoding = vi.fn();

    let resolveProc!: (val: any) => void;
    const resultPromise = new Promise<any>((res) => { resolveProc = res; });
    setImmediate(() => {
      stdout.emit('data', prText);
      resolveProc({ exitCode: 0 });
    });
    const mockProc = Object.assign(resultPromise, { stdout, stderr: null }) as unknown as ReturnType<typeof execa>;
    mockExeca.mockReturnValueOnce(mockProc);

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
  });

  it('uses exitCode fallback (1) when exitCode is null on error', async () => {
    // exitCode is null → result.exitCode ?? 1 falls back to 1
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ exitCode: null as unknown as number }),
    );

    const err = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn()).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.exitCode).toBe(1);
  });

  it('handles assistant event with no message.content (exercises ?? [] fallback)', async () => {
    // event.message has no content field → content defaults to [] via ?? []
    const noContentEvent = JSON.stringify({ type: 'assistant', message: {} }) + '\n';
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/77\n');
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [noContentEvent, prText] }),
    );

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/77');
  });

  it('handles subprocess without stdout stream', async () => {
    // subprocess.stdout is null → skip stdout processing, fall to gh fallback
    let resolveProc!: (val: any) => void;
    const resultPromise = new Promise<any>((res) => { resolveProc = res; });
    setImmediate(() => resolveProc({ exitCode: 0 }));
    const mockProc = Object.assign(resultPromise, { stdout: null, stderr: null }) as unknown as ReturnType<typeof execa>;
    mockExeca
      .mockReturnValueOnce(mockProc)  // claude subprocess (no stdout)
      .mockResolvedValueOnce(ghResult('https://github.com/org/repo/pull/88'));  // gh fallback

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn());
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/88');
  });

  it('detectPrUrl returns undefined when gh outputs non-http URL', async () => {
    // gh pr view returns a non-http string → detectPrUrl returns undefined
    const chunks = [makeAssistantEvent('done')]; // no PR URL
    mockExeca
      .mockReturnValueOnce(createMockSubprocess({ stdoutChunks: chunks }))  // claude
      .mockResolvedValueOnce(ghResult('null'));  // gh returns "null" (non-http)

    // Falls through to the "no PR URL found" error
    const err = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), vi.fn()).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.message).toContain('no PR URL was found');
  });

  it('skips empty/whitespace lines in stdout (exercises !trimmed continue branch)', async () => {
    const onOutput = vi.fn();
    // Send a chunk that contains an empty line between events
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/1\n');
    // Adding an extra \n creates an empty line that exercises !trimmed → continue
    const chunkWithEmptyLine = '\n' + prText;
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [chunkWithEmptyLine] }),
    );

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), onOutput);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
  });

  it('handles assistant content block with no text field (exercises ?? empty string)', async () => {
    const onOutput = vi.fn();
    // Content block has type=text but no text field → text is undefined → block.text ?? '' = ''
    const noTextField = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text' }],
      },
    }) + '\n';
    const prText = makeAssistantEvent('PR_URL: https://github.com/org/repo/pull/5\n');
    mockExeca.mockReturnValueOnce(
      createMockSubprocess({ stdoutChunks: [noTextField, prText] }),
    );

    const result = await runSubAgent(makeTask(), makeWorkspace(), makeConfig(), onOutput);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/5');
  });
});
