// ─── Core Configuration ────────────────────────────────────────────────────

export interface OrchestratorConfig {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  model: string;
  timeout?: number;
  runner: 'cli' | 'sdk';
  maxAgents: number;
  maxBudgetPerAgentUsd?: number;
  workspace: {
    type: 'worktree' | 'clone';
    repoUrl?: string;
  };
  github?: {
    token?: string;
  };
  tmux: boolean;
}

// ─── Planning ──────────────────────────────────────────────────────────────

export interface SubTask {
  id: string;          // e.g. "task-1"
  slug: string;        // kebab-case e.g. "add-auth-middleware"
  title: string;
  description: string;
  files: string[];     // files likely to be modified (hints for the agent)
}

export interface DecompositionPlan {
  summary: string;
  tasks: SubTask[];
}

// ─── Workspace ─────────────────────────────────────────────────────────────

export interface Workspace {
  taskId: string;
  taskSlug: string;
  branchName: string;  // "orchestrator/<slug>-<timestamp>"
  path: string;        // absolute path to isolated workspace
  type: 'worktree' | 'clone';
  repoRoot: string;    // original repo root (for worktree removal)
}

// ─── Agent State ───────────────────────────────────────────────────────────

export type AgentStatus = 'pending' | 'running' | 'success' | 'failed';

export interface AgentState {
  task: SubTask;
  workspace: Workspace;
  status: AgentStatus;
  prUrl?: string;
  error?: string;
}

// ─── Result ────────────────────────────────────────────────────────────────

export interface OrchestratorResult {
  completedTasks: AgentState[];
  failedTasks: AgentState[];
  prs: Array<{ taskTitle: string; url: string }>;
}

// ─── Run Options ───────────────────────────────────────────────────────────

export interface RunOptions {
  cwd: string;
}

// ─── Custom Errors ─────────────────────────────────────────────────────────

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export class ConfigError extends OrchestratorError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class PlannerError extends OrchestratorError {
  constructor(message: string) {
    super(message, 'PLANNER_ERROR');
    this.name = 'PlannerError';
  }
}

export class WorkspaceError extends OrchestratorError {
  constructor(
    message: string,
    public readonly taskId: string,
  ) {
    super(message, 'WORKSPACE_ERROR');
    this.name = 'WorkspaceError';
  }
}

export class RunnerError extends OrchestratorError {
  constructor(
    message: string,
    public readonly taskId: string,
    public readonly exitCode?: number,
  ) {
    super(message, 'RUNNER_ERROR');
    this.name = 'RunnerError';
  }
}
