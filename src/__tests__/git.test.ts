import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  getCurrentRepoRoot,
  getRemoteUrl,
  getCurrentBranch,
  hasUncommittedChanges,
  createWorktree,
  removeWorktree,
  cloneRepo,
  makeTaskSlug,
  makeBranchName,
} from '../git.js';

const mockExeca = vi.mocked(execa);

function execaResult(stdout: string, stderr = '') {
  return { stdout, stderr, exitCode: 0 } as unknown as Awaited<ReturnType<typeof execa>>;
}

beforeEach(() => {
  mockExeca.mockReset();
});

// ─── Repo Introspection ────────────────────────────────────────────────────

describe('getCurrentRepoRoot', () => {
  it('returns trimmed repo root', async () => {
    mockExeca.mockResolvedValueOnce(execaResult('/home/user/repo\n'));
    const result = await getCurrentRepoRoot('/home/user/repo/src');
    expect(result).toBe('/home/user/repo');
    expect(mockExeca).toHaveBeenCalledWith(
      'git', ['rev-parse', '--show-toplevel'], { cwd: '/home/user/repo/src' },
    );
  });
});

describe('getRemoteUrl', () => {
  it('returns remote URL using default origin', async () => {
    mockExeca.mockResolvedValueOnce(execaResult('https://github.com/org/repo.git\n'));
    const result = await getRemoteUrl('/repo');
    expect(result).toBe('https://github.com/org/repo.git');
    expect(mockExeca).toHaveBeenCalledWith(
      'git', ['remote', 'get-url', 'origin'], { cwd: '/repo' },
    );
  });

  it('uses a custom remote name', async () => {
    mockExeca.mockResolvedValueOnce(execaResult('https://github.com/org/fork.git'));
    const result = await getRemoteUrl('/repo', 'upstream');
    expect(result).toBe('https://github.com/org/fork.git');
    expect(mockExeca).toHaveBeenCalledWith(
      'git', ['remote', 'get-url', 'upstream'], { cwd: '/repo' },
    );
  });
});

describe('getCurrentBranch', () => {
  it('returns current branch name trimmed', async () => {
    mockExeca.mockResolvedValueOnce(execaResult('  main  '));
    const result = await getCurrentBranch('/repo');
    expect(result).toBe('main');
  });
});

describe('hasUncommittedChanges', () => {
  it('returns true when porcelain output is non-empty', async () => {
    mockExeca.mockResolvedValueOnce(execaResult(' M src/index.ts'));
    const result = await hasUncommittedChanges('/repo');
    expect(result).toBe(true);
  });

  it('returns false when porcelain output is empty', async () => {
    mockExeca.mockResolvedValueOnce(execaResult(''));
    const result = await hasUncommittedChanges('/repo');
    expect(result).toBe(false);
  });

  it('returns false when porcelain output is only whitespace', async () => {
    mockExeca.mockResolvedValueOnce(execaResult('   \n  '));
    const result = await hasUncommittedChanges('/repo');
    expect(result).toBe(false);
  });
});

// ─── Worktree Management ───────────────────────────────────────────────────

describe('createWorktree', () => {
  it('calls git worktree add with correct args', async () => {
    mockExeca.mockResolvedValueOnce(execaResult(''));
    await createWorktree('/repo', '/tmp/wt', 'feature-branch');
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '/tmp/wt', '-b', 'feature-branch'],
      { cwd: '/repo' },
    );
  });
});

describe('removeWorktree', () => {
  it('calls git worktree remove --force', async () => {
    mockExeca.mockResolvedValueOnce(execaResult(''));
    await removeWorktree('/repo', '/tmp/wt');
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/tmp/wt'],
      { cwd: '/repo' },
    );
  });
});

// ─── Clone Management ──────────────────────────────────────────────────────

describe('cloneRepo', () => {
  it('clones then checks out branch in two separate calls', async () => {
    mockExeca
      .mockResolvedValueOnce(execaResult(''))  // git clone
      .mockResolvedValueOnce(execaResult(''));  // git checkout -b
    await cloneRepo('https://github.com/org/repo', '/tmp/clone', 'feat-x');
    expect(mockExeca).toHaveBeenNthCalledWith(
      1, 'git', ['clone', 'https://github.com/org/repo', '/tmp/clone'],
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2, 'git', ['checkout', '-b', 'feat-x'], { cwd: '/tmp/clone' },
    );
  });
});

// ─── Naming Helpers ────────────────────────────────────────────────────────

describe('makeTaskSlug', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(makeTaskSlug('Add Dark Mode Support')).toBe('add-dark-mode-support');
  });

  it('strips non-alphanumeric characters (except hyphens)', () => {
    expect(makeTaskSlug('Fix auth! (prod) bug#42')).toBe('fix-auth-prod-bug42');
  });

  it('collapses multiple hyphens', () => {
    expect(makeTaskSlug('hello   world')).toBe('hello-world');
  });

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(50);
    expect(makeTaskSlug(long)).toHaveLength(40);
  });

  it('handles already-slugged input', () => {
    expect(makeTaskSlug('add-dark-mode')).toBe('add-dark-mode');
  });

  it('handles empty string', () => {
    expect(makeTaskSlug('')).toBe('');
  });
});

describe('makeBranchName', () => {
  it('returns orchestrator/<slug>-<timestamp> format', () => {
    const branch = makeBranchName('add-dark-mode');
    expect(branch).toMatch(/^orchestrator\/add-dark-mode-\d+$/);
  });

  it('includes a numeric timestamp', () => {
    const before = Date.now();
    const branch = makeBranchName('test');
    const after = Date.now();
    const ts = parseInt(branch.split('-').pop()!, 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
