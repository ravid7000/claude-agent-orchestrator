import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createWorktree,
  removeWorktree,
  cloneRepo,
  getCurrentRepoRoot,
  getRemoteUrl,
  hasUncommittedChanges,
  makeTaskSlug,
  makeBranchName,
} from './git.js';
import {
  type OrchestratorConfig,
  type SubTask,
  type Workspace,
  WorkspaceError,
} from './types.js';

export class WorkspaceManager {
  private repoRoot = '';
  private remoteUrl = '';
  private basePath = '';
  private activeWorkspaces: Workspace[] = [];

  constructor(private config: OrchestratorConfig) {
    // Register cleanup on exit
    process.on('exit', () => {
      this.cleanupAllSync();
    });

    process.on('SIGINT', () => {
      this.cleanupAllSync();
      process.exit(130);
    });

    process.on('SIGTERM', () => {
      this.cleanupAllSync();
      process.exit(143);
    });
  }

  async initialize(cwd: string): Promise<void> {
    this.repoRoot = await getCurrentRepoRoot(cwd);

    try {
      this.remoteUrl = await getRemoteUrl(this.repoRoot);
    } catch {
      this.remoteUrl = '';
    }

    this.basePath = path.join(os.tmpdir(), `claude-orchestrator-${process.pid}`);
    fs.mkdirSync(this.basePath, { recursive: true });
  }

  async createWorkspace(task: SubTask): Promise<Workspace> {
    const slug = makeTaskSlug(task.slug || task.title);
    const branchName = makeBranchName(slug);
    const workspacePath = path.join(this.basePath, task.id);

    const type = this.config.workspace.type;

    try {
      if (type === 'worktree') {
        // Check for dirty working tree before adding worktree
        const dirty = await hasUncommittedChanges(this.repoRoot);
        if (dirty) {
          // warn but proceed — worktree add works even with uncommitted changes
          process.stderr.write(
            `Warning: repo has uncommitted changes. Worktree will start from HEAD.\n`,
          );
        }
        await createWorktree(this.repoRoot, workspacePath, branchName);
      } else {
        // clone mode
        const repoUrl =
          this.config.workspace.repoUrl ||
          this.remoteUrl ||
          (() => {
            throw new WorkspaceError(
              'No repoUrl configured and could not detect remote URL. Set workspace.repoUrl in config.',
              task.id,
            );
          })();
        await cloneRepo(repoUrl, workspacePath, branchName);
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new WorkspaceError(
        `Failed to create workspace for task "${task.id}": ${msg}`,
        task.id,
      );
    }

    const workspace: Workspace = {
      taskId: task.id,
      taskSlug: slug,
      branchName,
      path: workspacePath,
      type,
      repoRoot: this.repoRoot,
    };

    this.activeWorkspaces.push(workspace);
    return workspace;
  }

  async cleanupWorkspace(workspace: Workspace, keepOnFailure: boolean): Promise<void> {
    if (keepOnFailure) {
      // Leave it for debugging — just deregister
      this.activeWorkspaces = this.activeWorkspaces.filter((w) => w.taskId !== workspace.taskId);
      return;
    }

    try {
      if (workspace.type === 'worktree') {
        await removeWorktree(workspace.repoRoot, workspace.path);
      } else {
        fs.rmSync(workspace.path, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }

    this.activeWorkspaces = this.activeWorkspaces.filter((w) => w.taskId !== workspace.taskId);
  }

  async cleanupAll(keepFailed = true): Promise<void> {
    await Promise.allSettled(
      this.activeWorkspaces.map((ws) => this.cleanupWorkspace(ws, keepFailed)),
    );
  }

  private cleanupAllSync(): void {
    for (const ws of this.activeWorkspaces) {
      try {
        if (ws.type === 'clone') {
          fs.rmSync(ws.path, { recursive: true, force: true });
        }
        // worktrees are left on sync exit — git worktree remove requires async
      } catch {
        // best-effort
      }
    }
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }

  getRemoteUrl(): string {
    return this.remoteUrl;
  }

  getBasePath(): string {
    return this.basePath;
  }
}
