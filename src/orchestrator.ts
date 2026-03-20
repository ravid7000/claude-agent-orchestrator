import * as p from '@clack/prompts';
import {
  type OrchestratorConfig,
  type AgentState,
  type OrchestratorResult,
  type RunOptions,
} from './types.js';
import { Planner } from './planner.js';
import { WorkspaceManager } from './workspace.js';
import { Display } from './display.js';
import { runSubAgent } from './runner.js';

// ─── Concurrency Limiter ───────────────────────────────────────────────────

export async function runWithConcurrencyLimit(
  states: AgentState[],
  limit: number,
  fn: (state: AgentState) => Promise<void>,
): Promise<void> {
  const queue = [...states];
  const running = new Set<Promise<void>>();

  while (queue.length > 0 || running.size > 0) {
    while (running.size < limit && queue.length > 0) {
      const state = queue.shift()!;
      const promise = fn(state).finally(() => running.delete(promise));
      running.add(promise);
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export class Orchestrator {
  private planner: Planner;

  constructor(private config: OrchestratorConfig) {
    this.planner = new Planner(config);
  }

  async run(task: string, options: RunOptions): Promise<OrchestratorResult> {
    const { cwd } = options;

    // ── Phase 1: Initialize workspace manager ──────────────────────────────
    const workspaceManager = new WorkspaceManager(this.config);
    await workspaceManager.initialize(cwd);

    // ── Phase 2: Plan ──────────────────────────────────────────────────────
    p.log.step('Analyzing repository and generating decomposition plan...');

    let plan;
    try {
      plan = await this.planner.decompose(task, cwd);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      throw err;
    }

    const display = new Display(this.config.tmux);
    display.showPlan(plan);

    // ── Phase 3: User Approval ─────────────────────────────────────────────
    const confirmed = await p.confirm({
      message: `Proceed with ${plan.tasks.length} parallel agent(s)?`,
      initialValue: true,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Orchestration cancelled.');
      process.exit(0);
    }

    // Allow deselecting specific tasks
    let selectedTaskIds: string[];
    if (plan.tasks.length > 1) {
      const selected = await p.multiselect<string>({
        message: 'Select tasks to run (space to toggle, enter to confirm):',
        options: plan.tasks.map((t) => ({
          value: t.id,
          label: `${t.id}: ${t.title}`,
          hint: t.files.length > 0 ? t.files.join(', ') : undefined,
        })),
        initialValues: plan.tasks.map((t) => t.id),
      });

      if (p.isCancel(selected)) {
        p.cancel('Orchestration cancelled.');
        process.exit(0);
      }
      selectedTaskIds = selected as unknown as string[];
    } else {
      selectedTaskIds = plan.tasks.map((t) => t.id);
    }

    const selectedTasks = plan.tasks.filter((t) => selectedTaskIds.includes(t.id));

    if (selectedTasks.length === 0) {
      p.log.warn('No tasks selected. Exiting.');
      process.exit(0);
    }

    // ── Phase 4: Create Workspaces ─────────────────────────────────────────
    p.log.step(`Creating ${selectedTasks.length} isolated workspace(s)...`);

    const agentStates: AgentState[] = [];

    for (const task of selectedTasks) {
      try {
        const workspace = await workspaceManager.createWorkspace(task);
        agentStates.push({
          task,
          workspace,
          status: 'pending',
        });
        p.log.info(`  ✓ ${task.id}: workspace at ${workspace.path} (branch: ${workspace.branchName})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(`  ✗ ${task.id}: workspace creation failed — ${msg} (skipping)`);
      }
    }

    if (agentStates.length === 0) {
      p.log.error('All workspace creations failed. Cannot proceed.');
      process.exit(1);
    }

    // ── Phase 5: Initialize Display ────────────────────────────────────────
    await display.initialize(agentStates.map((s) => s.task));

    // ── Phase 6: Run Agents in Parallel ───────────────────────────────────
    p.log.step(`Launching ${agentStates.length} agent(s) in parallel (max ${this.config.maxAgents} concurrent)...`);

    await runWithConcurrencyLimit(
      agentStates,
      this.config.maxAgents,
      async (state) => {
        state.status = 'running';
        const logPath = display.getLogPath(state.task.id);
        p.log.info(`  → ${state.task.id}: launching agent for "${state.task.title}"`);
        if (logPath) {
          p.log.info(`     Log: ${logPath}`);
        }

        try {
          const { prUrl } = await runSubAgent(
            state.task,
            state.workspace,
            this.config,
            (text) => display.writeOutput(state.task.id, text),
          );
          state.status = 'success';
          state.prUrl = prUrl;
          p.log.success(`  ✓ ${state.task.id} — PR: ${prUrl}`);
        } catch (err) {
          state.status = 'failed';
          state.error = err instanceof Error ? err.message : String(err);
          p.log.warn(`  ✗ ${state.task.id} failed: ${state.error}`);
        }
      },
    );

    // ── Phase 7: Cleanup Workspaces ────────────────────────────────────────
    for (const state of agentStates) {
      const keepOnFailure = state.status === 'failed';
      await workspaceManager.cleanupWorkspace(state.workspace, keepOnFailure);
    }

    // ── Phase 8: Build Result & Show Summary ───────────────────────────────
    const completedTasks = agentStates.filter((s) => s.status === 'success');
    const failedTasks = agentStates.filter((s) => s.status === 'failed');
    const prs = completedTasks
      .filter((s) => s.prUrl)
      .map((s) => ({ taskTitle: s.task.title, url: s.prUrl! }));

    const result: OrchestratorResult = { completedTasks, failedTasks, prs };
    display.showSummary(result);

    return result;
  }
}
