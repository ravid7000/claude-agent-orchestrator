import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Hoist mocks so they are available inside vi.mock factories ────────────

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('execa', () => ({ execa: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  // Must use regular function (not arrow) so `new Anthropic(...)` works as a constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

import { execa } from 'execa';
import { Planner, collectRepoContext } from '../planner.js';
import { PlannerError } from '../types.js';
import type { OrchestratorConfig } from '../types.js';

const mockExeca = vi.mocked(execa);

// ─── Helpers ───────────────────────────────────────────────────────────────

function execaResult(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 } as unknown as Awaited<ReturnType<typeof execa>>;
}

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    model: 'claude-opus-4-6',
    maxAgents: 5,
    workspace: { type: 'worktree' },
    tmux: true,
    runner: 'cli',
    ...overrides,
  };
}

const VALID_PLAN_JSON = JSON.stringify({
  summary: 'Add dark mode support',
  tasks: [
    {
      id: 'task-1',
      slug: 'add-dark-mode-css',
      title: 'Add dark mode CSS variables',
      description: 'Add CSS variables for dark mode theme',
      files: ['src/styles/theme.css'],
    },
    {
      id: 'task-2',
      slug: 'add-dark-mode-toggle',
      title: 'Add dark mode toggle button',
      description: 'Add a toggle button in the header',
      files: ['src/components/Header.tsx'],
    },
  ],
});

// ─── collectRepoContext ────────────────────────────────────────────────────

describe('collectRepoContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-test-'));
    mockExeca.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes file tree section', async () => {
    mockExeca
      .mockResolvedValueOnce(execaResult('./src\n./src/index.ts\n./package.json'))  // find
      .mockResolvedValueOnce(execaResult('abc1234 Initial commit'));                // git log

    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('## File Tree');
    expect(context).toContain('./src');
  });

  it('includes recent commits section', async () => {
    mockExeca
      .mockResolvedValueOnce(execaResult('.'))
      .mockResolvedValueOnce(execaResult('abc1234 feat: add login\ndef5678 fix: navbar'));

    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('## Recent Commits');
    expect(context).toContain('abc1234');
    expect(context).toContain('def5678');
  });

  it('gracefully handles execa failures', async () => {
    mockExeca.mockRejectedValue(new Error('command not found'));

    // Should not throw — returns fallback strings
    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('## File Tree');
    expect(context).toContain('could not list files');
    expect(context).toContain('no git log available');
  });

  it('includes key files when they exist', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
    mockExeca
      .mockResolvedValueOnce(execaResult('.'))
      .mockResolvedValueOnce(execaResult(''));

    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('## Key Files');
    expect(context).toContain('package.json');
    expect(context).toContain('"name":"test"');
  });

  it('truncates file tree at 200 entries', async () => {
    const manyFiles = Array.from({ length: 250 }, (_, i) => `./file${i}.ts`).join('\n');
    mockExeca
      .mockResolvedValueOnce(execaResult(manyFiles))
      .mockResolvedValueOnce(execaResult(''));

    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('truncated at 200 entries');
  });

  it('includes sample source files when they exist', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const x = 1;');
    mockExeca
      .mockResolvedValueOnce(execaResult('./index.ts'))
      .mockResolvedValueOnce(execaResult(''));

    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('## Sample Source Files');
    expect(context).toContain('index.ts');
    expect(context).toContain('export const x = 1;');
  });

  it('walks into subdirectories to find source files (exercises recursive walk)', async () => {
    // Create nested directory structure
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const app = "hello";');
    mockExeca
      .mockResolvedValueOnce(execaResult('./src\n./src/app.ts'))
      .mockResolvedValueOnce(execaResult(''));

    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('## Sample Source Files');
    expect(context).toContain('app.ts');
  });

  it('truncates key files longer than 100 lines', async () => {
    // Create a package.json with more than 100 lines
    const longContent = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), longContent);
    mockExeca
      .mockResolvedValueOnce(execaResult('.'))
      .mockResolvedValueOnce(execaResult(''));

    const context = await collectRepoContext(tmpDir);
    expect(context).toContain('truncated at 100 lines');
  });
});

// ─── Planner.decompose ────────────────────────────────────────────────────

describe('Planner.decompose', () => {
  beforeEach(() => {
    mockExeca.mockReset();
    mockCreate.mockReset();
    // Default: empty find + empty git log
    mockExeca
      .mockResolvedValue(execaResult(''));
    // Prevent real env vars from leaking into model selection
    vi.stubEnv('ANTHROPIC_MODEL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeMessage(text: string) {
    return {
      content: [{ type: 'text', text }],
    };
  }

  it('returns parsed plan when response contains valid JSON', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage(VALID_PLAN_JSON));

    const planner = new Planner(makeConfig());
    const plan = await planner.decompose('add dark mode', '/repo');

    expect(plan.summary).toBe('Add dark mode support');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.id).toBe('task-1');
    expect(plan.tasks[1]?.slug).toBe('add-dark-mode-toggle');
  });

  it('extracts JSON from fenced code block', async () => {
    const fenced = `Here is the plan:\n\`\`\`json\n${VALID_PLAN_JSON}\n\`\`\``;
    mockCreate.mockResolvedValueOnce(makeMessage(fenced));

    const planner = new Planner(makeConfig());
    const plan = await planner.decompose('task', '/repo');

    expect(plan.tasks).toHaveLength(2);
  });

  it('extracts JSON from first { to last }', async () => {
    const embedded = `Some text before ${VALID_PLAN_JSON} some text after`;
    mockCreate.mockResolvedValueOnce(makeMessage(embedded));

    const planner = new Planner(makeConfig());
    const plan = await planner.decompose('task', '/repo');

    expect(plan.tasks).toHaveLength(2);
  });

  it('throws PlannerError when response has no text content', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'x' }] });

    const planner = new Planner(makeConfig());
    await expect(planner.decompose('task', '/repo')).rejects.toBeInstanceOf(PlannerError);
  });

  it('throws PlannerError when response is empty content array', async () => {
    mockCreate.mockResolvedValueOnce({ content: [] });

    const planner = new Planner(makeConfig());
    await expect(planner.decompose('task', '/repo')).rejects.toBeInstanceOf(PlannerError);
  });

  it('throws PlannerError when JSON cannot be extracted', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage('Sorry, I cannot help with that.'));

    const planner = new Planner(makeConfig());
    await expect(planner.decompose('task', '/repo')).rejects.toBeInstanceOf(PlannerError);
  });

  it('throws PlannerError when JSON fails Zod validation (missing tasks)', async () => {
    const badJson = JSON.stringify({ summary: 'ok' });  // missing tasks
    mockCreate.mockResolvedValueOnce(makeMessage(badJson));

    const planner = new Planner(makeConfig());
    await expect(planner.decompose('task', '/repo')).rejects.toBeInstanceOf(PlannerError);
  });

  it('throws PlannerError when tasks items are malformed', async () => {
    const badJson = JSON.stringify({ summary: 'ok', tasks: [{ id: 1 }] });
    mockCreate.mockResolvedValueOnce(makeMessage(badJson));

    const planner = new Planner(makeConfig());
    await expect(planner.decompose('task', '/repo')).rejects.toBeInstanceOf(PlannerError);
  });

  it('wraps API errors in PlannerError', async () => {
    mockCreate.mockRejectedValueOnce(new Error('401 Unauthorized'));

    const planner = new Planner(makeConfig());
    const err = await planner.decompose('task', '/repo').catch((e) => e);

    expect(err).toBeInstanceOf(PlannerError);
    expect(err.message).toContain('401 Unauthorized');
  });

  it('re-throws PlannerError thrown inside try block', async () => {
    // This tests that if a PlannerError is thrown by internal code it propagates
    mockCreate.mockRejectedValueOnce(new PlannerError('already a planner error'));

    const planner = new Planner(makeConfig());
    const err = await planner.decompose('task', '/repo').catch((e) => e);

    expect(err).toBeInstanceOf(PlannerError);
    expect(err.message).toBe('already a planner error');
  });

  it('slices tasks to maxAgents when plan has more tasks', async () => {
    const manyTasksJson = JSON.stringify({
      summary: 'big plan',
      tasks: Array.from({ length: 8 }, (_, i) => ({
        id: `task-${i + 1}`,
        slug: `task-${i + 1}`,
        title: `Task ${i + 1}`,
        description: `Description ${i + 1}`,
        files: [],
      })),
    });
    mockCreate.mockResolvedValueOnce(makeMessage(manyTasksJson));

    const planner = new Planner(makeConfig({ maxAgents: 3 }));
    const plan = await planner.decompose('task', '/repo');

    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[2]?.id).toBe('task-3');
  });

  it('does not slice tasks when count equals maxAgents', async () => {
    const json = JSON.stringify({
      summary: 'plan',
      tasks: Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i + 1}`,
        slug: `task-${i + 1}`,
        title: `Task ${i + 1}`,
        description: `desc`,
        files: [],
      })),
    });
    mockCreate.mockResolvedValueOnce(makeMessage(json));

    const planner = new Planner(makeConfig({ maxAgents: 5 }));
    const plan = await planner.decompose('task', '/repo');

    expect(plan.tasks).toHaveLength(5);
  });

  it('tasks default files to empty array when omitted', async () => {
    const json = JSON.stringify({
      summary: 'plan',
      tasks: [
        { id: 'task-1', slug: 'fix-bug', title: 'Fix Bug', description: 'fix it' },
      ],
    });
    mockCreate.mockResolvedValueOnce(makeMessage(json));

    const planner = new Planner(makeConfig());
    const plan = await planner.decompose('task', '/repo');

    expect(plan.tasks[0]?.files).toEqual([]);
  });

  it('calls Anthropic API with correct model and max_tokens', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage(VALID_PLAN_JSON));

    const planner = new Planner(makeConfig({ model: 'claude-haiku-4-5-20251001' }));
    await planner.decompose('task', '/repo');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
      }),
    );
  });

  it('ANTHROPIC_MODEL env var overrides config model', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-custom-model');
    mockCreate.mockResolvedValueOnce(makeMessage(VALID_PLAN_JSON));

    const planner = new Planner(makeConfig({ model: 'claude-opus-4-6' }));
    await planner.decompose('task', '/repo');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-custom-model' }),
    );
  });

  it('passes task string in user prompt', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage(VALID_PLAN_JSON));

    const planner = new Planner(makeConfig());
    await planner.decompose('Add skeleton loading states', '/repo');

    const call = mockCreate.mock.calls[0]?.[0];
    const userContent = call?.messages?.[0]?.content;
    expect(userContent).toContain('Add skeleton loading states');
  });
});
