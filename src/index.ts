// ─── Public Library API ────────────────────────────────────────────────────
// Usage: import { Orchestrator, loadConfig } from 'claude-agent-orchestrator'

export { Orchestrator } from './orchestrator.js';
export { loadConfig } from './config.js';
export { Planner, collectRepoContext } from './planner.js';

export type {
  OrchestratorConfig,
  SubTask,
  DecompositionPlan,
  AgentState,
  AgentStatus,
  OrchestratorResult,
  Workspace,
  RunOptions,
  OrchestratorError,
  ConfigError,
  PlannerError,
  WorkspaceError,
  RunnerError,
} from './types.js';
