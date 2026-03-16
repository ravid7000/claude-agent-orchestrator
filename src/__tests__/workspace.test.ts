import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../git.js', () => ({
  getCurrentRepoRoot: vi.fn(),
  getRemoteUrl: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  cloneRepo: vi.fn(),
  makeTaskSlug: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
  makeBranchName: vi.fn((slug: string) => `orchestrator/${slug}-1234567890`),
}));

import {
  getCurrentRepoRoot,
  getRemoteUrl,
  hasUncommittedChanges,
  createWorktree,
  removeWorktree,
  cloneRepo,
  makeTaskSlug,
  makeBranchName,
} from '../git.js';
import { WorkspaceManager } from '../workspace.js';
import { WorkspaceError } from '../types.js';
import type { OrchestratorConfig, SubTask } from '../types.js';

const mockGetRepoRoot = vi.mocked(getCurrentRepoRoot);
const mockGetRemoteUrl = vi.mocked(getRemoteUrl);
const mockHasUncommitted = vi.mocked(hasUncommittedChanges);
const mockCreateWorktree = vi.mocked(createWorktree);
const mockRemoveWorktree = vi.mocked(removeWorktree);
const mockCloneRepo = vi.mocked(cloneRepo);
const mockMakeTaskSlug = vi.mocked(makeTaskSlug);
const mockMakeBranchName = vi.mocked(makeBranchName);

// ─── Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    model: 'claude-opus-4-6',
    maxAgents: 5,
    workspace: { type: 'worktree' },
    tmux: true,
    ...overrides,
  };
}

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(tmpDir);

  mockGetRepoRoot.mockReset();
  mockGetRemoteUrl.mockReset();
  mockHasUncommitted.mockReset();
  mockCreateWorktree.mockReset();
  mockRemoveWorktree.mockReset();
  mockCloneRepo.mockReset();
  mockMakeTaskSlug.mockImplementation((s: string) => s.toLowerCase().replace(/\s+/g, '-'));
  mockMakeBranchName.mockImplementation((slug: string) => `orchestrator/${slug}-1234567890`);

  // Default resolutions
  mockGetRepoRoot.mockResolvedValue('/repo/root');
  mockGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
  mockHasUncommitted.mockResolvedValue(false);
  mockCreateWorktree.mockResolvedValue(undefined);
  mockRemoveWorktree.mockResolvedValue(undefined);
  mockCloneRepo.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── initialize ────────────────────────────────────────────────────────────

describe('WorkspaceManager.initialize', () => {
  it('sets repoRoot from getCurrentRepoRoot', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/some/project/src');

    expect(mockGetRepoRoot).toHaveBeenCalledWith('/some/project/src');
    expect(manager.getRepoRoot()).toBe('/repo/root');
  });

  it('sets remoteUrl from getRemoteUrl', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    expect(manager.getRemoteUrl()).toBe('https://github.com/org/repo.git');
  });

  it('sets remoteUrl to empty string when getRemoteUrl fails', async () => {
    mockGetRemoteUrl.mockRejectedValue(new Error('no remote'));
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    expect(manager.getRemoteUrl()).toBe('');
  });

  it('creates basePath directory', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    const basePath = manager.getBasePath();
    expect(basePath).toContain('claude-orchestrator-');
    expect(fs.existsSync(basePath)).toBe(true);
  });
});

// ─── createWorkspace — worktree mode ───────────────────────────────────────

describe('WorkspaceManager.createWorkspace (worktree)', () => {
  it('calls createWorktree with correct args', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    const task = makeTask({ slug: 'add-dark-mode' });
    await manager.createWorkspace(task);

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repo/root',
      expect.stringContaining('task-1'),
      expect.stringMatching(/^orchestrator\/add-dark-mode-/),
    );
  });

  it('returns Workspace with correct fields', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    const task = makeTask({ id: 'task-2', slug: 'fix-bug' });
    const workspace = await manager.createWorkspace(task);

    expect(workspace.taskId).toBe('task-2');
    expect(workspace.type).toBe('worktree');
    expect(workspace.repoRoot).toBe('/repo/root');
    expect(workspace.branchName).toMatch(/^orchestrator\/fix-bug-/);
    expect(workspace.path).toContain('task-2');
  });

  it('warns to stderr when repo has uncommitted changes', async () => {
    mockHasUncommitted.mockResolvedValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');
    await manager.createWorkspace(makeTask());

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('uncommitted changes'));
    stderrSpy.mockRestore();
  });

  it('throws WorkspaceError when createWorktree fails', async () => {
    mockCreateWorktree.mockRejectedValue(new Error('git error'));

    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    await expect(manager.createWorkspace(makeTask())).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('includes task.id in WorkspaceError.taskId', async () => {
    mockCreateWorktree.mockRejectedValue(new Error('git error'));

    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    const err = await manager.createWorkspace(makeTask({ id: 'task-3' })).catch((e) => e);
    expect(err.taskId).toBe('task-3');
  });

  it('uses task.title as slug fallback when slug is empty', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');

    await manager.createWorkspace(makeTask({ slug: '', title: 'Add Hero Banner' }));

    expect(mockMakeTaskSlug).toHaveBeenCalledWith('Add Hero Banner');
  });
});

// ─── createWorkspace — clone mode ─────────────────────────────────────────

describe('WorkspaceManager.createWorkspace (clone)', () => {
  it('calls cloneRepo with remote URL', async () => {
    const manager = new WorkspaceManager(makeConfig({ workspace: { type: 'clone' } }));
    await manager.initialize('/project');

    await manager.createWorkspace(makeTask());

    expect(mockCloneRepo).toHaveBeenCalledWith(
      'https://github.com/org/repo.git',
      expect.any(String),
      expect.any(String),
    );
  });

  it('prefers workspace.repoUrl config over detected remote URL', async () => {
    const manager = new WorkspaceManager(
      makeConfig({ workspace: { type: 'clone', repoUrl: 'https://custom.example.com/repo.git' } }),
    );
    await manager.initialize('/project');

    await manager.createWorkspace(makeTask());

    expect(mockCloneRepo).toHaveBeenCalledWith(
      'https://custom.example.com/repo.git',
      expect.any(String),
      expect.any(String),
    );
  });

  it('throws WorkspaceError when no repoUrl and no remote URL detected', async () => {
    mockGetRemoteUrl.mockRejectedValue(new Error('no remote'));
    const manager = new WorkspaceManager(makeConfig({ workspace: { type: 'clone' } }));
    await manager.initialize('/project');

    await expect(manager.createWorkspace(makeTask())).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('returns workspace with type=clone', async () => {
    const manager = new WorkspaceManager(makeConfig({ workspace: { type: 'clone' } }));
    await manager.initialize('/project');

    const ws = await manager.createWorkspace(makeTask());
    expect(ws.type).toBe('clone');
  });
});

// ─── cleanupWorkspace ──────────────────────────────────────────────────────

describe('WorkspaceManager.cleanupWorkspace', () => {
  it('calls removeWorktree for worktree type when keepOnFailure=false', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');
    const ws = await manager.createWorkspace(makeTask());

    await manager.cleanupWorkspace(ws, false);

    expect(mockRemoveWorktree).toHaveBeenCalledWith(ws.repoRoot, ws.path);
  });

  it('does not call removeWorktree when keepOnFailure=true', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');
    const ws = await manager.createWorkspace(makeTask());

    await manager.cleanupWorkspace(ws, true);

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('removes clone directory via fs.rmSync when keepOnFailure=false', async () => {
    const manager = new WorkspaceManager(makeConfig({ workspace: { type: 'clone' } }));
    await manager.initialize('/project');
    const ws = await manager.createWorkspace(makeTask());

    // Create the directory so rmSync doesn't fail
    fs.mkdirSync(ws.path, { recursive: true });
    const rmSpy = vi.spyOn(fs, 'rmSync');

    await manager.cleanupWorkspace(ws, false);

    expect(rmSpy).toHaveBeenCalledWith(ws.path, { recursive: true, force: true });
    rmSpy.mockRestore();
  });

  it('deregisters workspace from active list', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');
    const ws1 = await manager.createWorkspace(makeTask({ id: 'task-1' }));
    const ws2 = await manager.createWorkspace(makeTask({ id: 'task-2' }));

    await manager.cleanupWorkspace(ws1, false);

    // ws2 should still be tracked — cleaning up ws2 should still call removeWorktree
    await manager.cleanupWorkspace(ws2, false);
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(2);
  });

  it('does not throw when removeWorktree fails (best-effort cleanup)', async () => {
    mockRemoveWorktree.mockRejectedValue(new Error('cleanup failed'));
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');
    const ws = await manager.createWorkspace(makeTask());

    // Should not throw
    await expect(manager.cleanupWorkspace(ws, false)).resolves.toBeUndefined();
  });
});

// ─── cleanupAll ────────────────────────────────────────────────────────────

describe('WorkspaceManager.cleanupAll', () => {
  it('cleans up all active workspaces', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');
    await manager.createWorkspace(makeTask({ id: 'task-1' }));
    await manager.createWorkspace(makeTask({ id: 'task-2' }));
    await manager.createWorkspace(makeTask({ id: 'task-3' }));

    await manager.cleanupAll(false);

    expect(mockRemoveWorktree).toHaveBeenCalledTimes(3);
  });

  it('passes keepFailed=true to cleanupWorkspace when called with true', async () => {
    const manager = new WorkspaceManager(makeConfig());
    await manager.initialize('/project');
    await manager.createWorkspace(makeTask({ id: 'task-1' }));

    await manager.cleanupAll(true);

    // keepFailed=true means removeWorktree is NOT called
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });
});
