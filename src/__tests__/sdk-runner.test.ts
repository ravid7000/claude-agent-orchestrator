import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Hoist SDK mock ────────────────────────────────────────────────────────

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

import { execa } from 'execa';
import { executeTool, runSubAgentSDK } from '../sdk-runner.js';
import { RunnerError } from '../types.js';
import type { SubTask, Workspace, OrchestratorConfig } from '../types.js';

const mockExeca = vi.mocked(execa);

// ─── Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'task-1',
    slug: 'add-feature',
    title: 'Add Feature',
    description: 'Implement the feature',
    files: [],
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    taskId: 'task-1',
    taskSlug: 'add-feature',
    branchName: 'orchestrator/add-feature-123',
    path: tmpDir,
    type: 'worktree',
    repoRoot: tmpDir,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    model: 'claude-opus-4-6',
    maxAgents: 5,
    workspace: { type: 'worktree' },
    tmux: false,
    runner: 'sdk',
    authToken: 'sk-ant-test',
    ...overrides,
  };
}

/** Build a minimal Anthropic message response */
function makeMessage(
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>,
  stop_reason: string = 'end_turn',
) {
  return {
    content,
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function mockExecaResult(stdout = '', stderr = '', exitCode = 0) {
  return Promise.resolve({ stdout, stderr, exitCode }) as unknown as ReturnType<typeof execa>;
}

// ─── executeTool — bash ────────────────────────────────────────────────────

describe('executeTool — bash', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-runner-test-'));
    mockExeca.mockReset();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs the command in workspace.path and returns exit code + stdout', async () => {
    mockExeca.mockReturnValueOnce(mockExecaResult('hello world', '', 0));
    const ws = makeWorkspace();
    const onOutput = vi.fn();

    const result = await executeTool('bash', { command: 'echo hello world' }, ws, onOutput);

    expect(mockExeca).toHaveBeenCalledWith('sh', ['-c', 'echo hello world'], expect.objectContaining({ cwd: tmpDir }));
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('hello world');
  });

  it('emits the command via onOutput', async () => {
    mockExeca.mockReturnValueOnce(mockExecaResult('', '', 0));
    const onOutput = vi.fn();

    await executeTool('bash', { command: 'ls' }, makeWorkspace(), onOutput);

    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('$ ls'));
  });

  it('includes stderr in the result', async () => {
    mockExeca.mockReturnValueOnce(mockExecaResult('', 'command not found', 127));

    const result = await executeTool('bash', { command: 'bad-cmd' }, makeWorkspace(), vi.fn());

    expect(result).toContain('Exit code: 127');
    expect(result).toContain('command not found');
  });

  it('uses custom timeout_ms when provided', async () => {
    mockExeca.mockReturnValueOnce(mockExecaResult());

    await executeTool('bash', { command: 'sleep 1', timeout_ms: 5000 }, makeWorkspace(), vi.fn());

    expect(mockExeca).toHaveBeenCalledWith('sh', ['-c', 'sleep 1'], expect.objectContaining({ timeout: 5000 }));
  });

  it('returns tool error string on exception', async () => {
    mockExeca.mockRejectedValueOnce(new Error('spawn failed'));

    const result = await executeTool('bash', { command: 'bad' }, makeWorkspace(), vi.fn());

    expect(result).toContain('Tool error (bash)');
    expect(result).toContain('spawn failed');
  });
});

// ─── executeTool — read_file ───────────────────────────────────────────────

describe('executeTool — read_file', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-runner-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a file relative to workspace.path', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hello content');

    const result = await executeTool('read_file', { path: 'hello.txt' }, makeWorkspace(), vi.fn());

    expect(result).toBe('hello content');
  });

  it('reads an absolute path directly', async () => {
    const absPath = path.join(tmpDir, 'abs.txt');
    fs.writeFileSync(absPath, 'absolute content');

    const result = await executeTool('read_file', { path: absPath }, makeWorkspace(), vi.fn());

    expect(result).toBe('absolute content');
  });

  it('returns tool error string when file does not exist', async () => {
    const result = await executeTool('read_file', { path: 'nonexistent.txt' }, makeWorkspace(), vi.fn());

    expect(result).toContain('Tool error (read_file)');
  });
});

// ─── executeTool — write_file ──────────────────────────────────────────────

describe('executeTool — write_file', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-runner-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a file relative to workspace.path', async () => {
    const result = await executeTool(
      'write_file',
      { path: 'out.txt', content: 'written content' },
      makeWorkspace(),
      vi.fn(),
    );

    expect(result).toContain('Written');
    expect(fs.readFileSync(path.join(tmpDir, 'out.txt'), 'utf-8')).toBe('written content');
  });

  it('creates parent directories if they do not exist', async () => {
    await executeTool(
      'write_file',
      { path: 'nested/deep/file.ts', content: 'code' },
      makeWorkspace(),
      vi.fn(),
    );

    expect(fs.existsSync(path.join(tmpDir, 'nested/deep/file.ts'))).toBe(true);
  });
});

// ─── executeTool — web_fetch ───────────────────────────────────────────────

describe('executeTool — web_fetch', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-runner-test-'));
    global.fetch = vi.fn();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('fetches a URL and returns the text body', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      text: async () => 'page content',
    } as unknown as Response);

    const result = await executeTool('web_fetch', { url: 'https://example.com' }, makeWorkspace(), vi.fn());

    expect(result).toBe('page content');
  });

  it('truncates long responses', async () => {
    const longText = 'x'.repeat(25_000);
    vi.mocked(global.fetch).mockResolvedValueOnce({
      text: async () => longText,
    } as unknown as Response);

    const result = await executeTool('web_fetch', { url: 'https://example.com' }, makeWorkspace(), vi.fn());

    expect(result.length).toBeLessThan(25_000);
    expect(result).toContain('truncated');
  });

  it('returns tool error string on fetch failure', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('network error'));

    const result = await executeTool('web_fetch', { url: 'https://bad.url' }, makeWorkspace(), vi.fn());

    expect(result).toContain('Tool error (web_fetch)');
    expect(result).toContain('network error');
  });
});

// ─── executeTool — unknown tool ────────────────────────────────────────────

describe('executeTool — unknown tool', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-runner-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "Unknown tool" string for unrecognised tool name', async () => {
    const result = await executeTool('magic_tool', {}, makeWorkspace(), vi.fn());
    expect(result).toBe('Unknown tool: magic_tool');
  });
});

// ─── runSubAgentSDK — agent loop ───────────────────────────────────────────

describe('runSubAgentSDK', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-runner-test-'));
    mockCreate.mockReset();
    mockExeca.mockReset();
    vi.stubEnv('ANTHROPIC_MODEL', '');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('returns prUrl from text on a single end_turn response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeMessage([{ type: 'text', text: 'Done!\nPR_URL: https://github.com/org/repo/pull/42\n' }]),
    );

    const result = await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('executes a tool use block and continues the loop', async () => {
    // Turn 1: tool call; Turn 2: end_turn with PR URL
    mockCreate
      .mockResolvedValueOnce(
        makeMessage(
          [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
          'tool_use',
        ),
      )
      .mockResolvedValueOnce(
        makeMessage([{ type: 'text', text: 'PR_URL: https://github.com/org/repo/pull/7\n' }]),
      );
    mockExeca.mockReturnValueOnce(mockExecaResult('file.ts', '', 0));

    const result = await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/7');
  });

  it('continues conversation on max_tokens stop_reason', async () => {
    // Turn 1: text block, truncated; Turn 2: end_turn with PR URL
    mockCreate
      .mockResolvedValueOnce(makeMessage([{ type: 'text', text: 'Thinking...' }], 'max_tokens'))
      .mockResolvedValueOnce(
        makeMessage([{ type: 'text', text: 'PR_URL: https://github.com/org/repo/pull/8\n' }]),
      );

    const result = await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/8');
  });

  it('throws RunnerError on SDK API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const err = await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), vi.fn()).catch((e) => e);

    expect(err).toBeInstanceOf(RunnerError);
    expect(err.message).toContain('Rate limit exceeded');
  });

  it('uses gh CLI fallback when no PR_URL in text', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage([{ type: 'text', text: 'All done.' }]));
    // gh pr view fallback
    mockExeca.mockResolvedValueOnce(
      Promise.resolve({ stdout: 'https://github.com/org/repo/pull/55', stderr: '', exitCode: 0 }) as unknown as ReturnType<typeof execa>,
    );

    const result = await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    expect(result.prUrl).toBe('https://github.com/org/repo/pull/55');
  });

  it('throws RunnerError when no PR URL is found at all', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage([{ type: 'text', text: 'All done.' }]));
    mockExeca.mockRejectedValueOnce(new Error('no PR'));

    const err = await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), vi.fn()).catch((e) => e);

    expect(err).toBeInstanceOf(RunnerError);
    expect(err.message).toContain('no PR URL was found');
  });

  it('uses ANTHROPIC_MODEL env var when set', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-custom-model');
    mockCreate.mockResolvedValueOnce(
      makeMessage([{ type: 'text', text: 'PR_URL: https://github.com/org/repo/pull/1\n' }]),
    );

    await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), vi.fn());

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-custom-model' }));
  });

  it('emits text output via onOutput', async () => {
    mockCreate.mockResolvedValueOnce(
      makeMessage([{ type: 'text', text: 'Working on it...\nPR_URL: https://github.com/org/repo/pull/1\n' }]),
    );
    const onOutput = vi.fn();

    await runSubAgentSDK(makeTask(), makeWorkspace(), makeConfig(), onOutput);

    const allOutput = onOutput.mock.calls.map((c) => c[0]).join('');
    expect(allOutput).toContain('Working on it...');
  });
});
