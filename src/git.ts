import { execa } from 'execa';

// ─── Repo Introspection ────────────────────────────────────────────────────

export async function getCurrentRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd });
  return stdout.trim();
}

export async function getRemoteUrl(cwd: string, remote = 'origin'): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', remote], { cwd });
  return stdout.trim();
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execa('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}

// ─── Worktree Management ───────────────────────────────────────────────────

export async function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await execa('git', ['worktree', 'add', worktreePath, '-b', branchName], {
    cwd: repoRoot,
  });
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  await execa('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoRoot,
  });
}

// ─── Clone Management ──────────────────────────────────────────────────────

export async function cloneRepo(
  repoUrl: string,
  targetPath: string,
  branchName: string,
): Promise<void> {
  await execa('git', ['clone', repoUrl, targetPath]);
  await execa('git', ['checkout', '-b', branchName], { cwd: targetPath });
}

// ─── Naming Helpers ────────────────────────────────────────────────────────

export function makeTaskSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

export function makeBranchName(slug: string): string {
  return `orchestrator/${slug}-${Date.now()}`;
}
