import fs from 'fs';
import path from 'path';
import os from 'os';
import { execa } from 'execa';
import { type SubTask, type AgentState, type OrchestratorResult, type DecompositionPlan } from './types.js';

// ─── ANSI Colors (for non-tmux fallback) ──────────────────────────────────

const COLORS = [
  '\x1b[36m', // cyan
  '\x1b[33m', // yellow
  '\x1b[35m', // magenta
  '\x1b[32m', // green
  '\x1b[34m', // blue
  '\x1b[91m', // bright red
  '\x1b[93m', // bright yellow
  '\x1b[96m', // bright cyan
];
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// ─── tmux Helpers ──────────────────────────────────────────────────────────

async function tmuxHasSession(sessionName: string): Promise<boolean> {
  try {
    await execa('tmux', ['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxNewSession(sessionName: string): Promise<void> {
  await execa('tmux', ['new-session', '-d', '-s', sessionName, '-x', '220', '-y', '50']);
}

async function tmuxSplitWindow(sessionName: string): Promise<string> {
  // Split and capture the new pane ID
  const { stdout } = await execa('tmux', [
    'split-window',
    '-t',
    `${sessionName}:0`,
    '-v',
    '-P',
    '-F',
    '#{pane_id}',
  ]);
  return stdout.trim();
}

async function tmuxNewWindow(sessionName: string, name: string): Promise<string> {
  const { stdout } = await execa('tmux', [
    'new-window',
    '-t',
    sessionName,
    '-n',
    name,
    '-P',
    '-F',
    '#{pane_id}',
  ]);
  return stdout.trim();
}

async function tmuxGetCurrentPaneId(sessionName: string): Promise<string> {
  const { stdout } = await execa('tmux', [
    'display-message',
    '-t',
    `${sessionName}:0`,
    '-p',
    '#{pane_id}',
  ]);
  return stdout.trim();
}

async function tmuxSendKeys(paneId: string, command: string): Promise<void> {
  await execa('tmux', ['send-keys', '-t', paneId, command, 'Enter']);
}

async function tmuxSelectLayout(sessionName: string, layout: string): Promise<void> {
  await execa('tmux', ['select-layout', '-t', `${sessionName}:0`, layout]);
}

async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execa('which', ['tmux']);
    return true;
  } catch {
    return false;
  }
}

// ─── Display Class ─────────────────────────────────────────────────────────

export class Display {
  private sessionName = '';
  private logDir = '';
  private logPaths = new Map<string, string>();
  private colorMap = new Map<string, string>();
  private useTmux = false;
  private paneIds = new Map<string, string>();  // taskId -> pane ID
  private tasks: SubTask[] = [];

  constructor(private enableTmux: boolean) {}

  // ─── Plan Display ──────────────────────────────────────────────────────

  showPlan(plan: DecompositionPlan): void {
    console.log(`\n${BOLD}Decomposition Plan${RESET}`);
    console.log(`${DIM}${plan.summary}${RESET}\n`);

    for (const task of plan.tasks) {
      console.log(`  ${BOLD}${task.id}${RESET}: ${task.title}`);
      console.log(`  ${DIM}${task.description.split('\n')[0].slice(0, 100)}${RESET}`);
      if (task.files.length > 0) {
        console.log(`  ${DIM}Files: ${task.files.join(', ')}${RESET}`);
      }
      console.log('');
    }
  }

  // ─── Initialize tmux / log files ──────────────────────────────────────

  async initialize(tasks: SubTask[]): Promise<void> {
    this.tasks = tasks;

    // Assign colors
    tasks.forEach((task, i) => {
      this.colorMap.set(task.id, COLORS[i % COLORS.length] ?? COLORS[0]!);
    });

    // Create log directory
    this.logDir = path.join(os.tmpdir(), `claude-orch-${process.pid}`);
    fs.mkdirSync(this.logDir, { recursive: true });

    for (const task of tasks) {
      const logPath = path.join(this.logDir, `${task.id}.log`);
      fs.writeFileSync(logPath, `=== Agent: ${task.title} ===\n`, 'utf-8');
      this.logPaths.set(task.id, logPath);
    }

    if (!this.enableTmux) {
      console.log(`\n${DIM}(tmux disabled — streaming to console)${RESET}\n`);
      return;
    }

    const hasTmux = await isTmuxAvailable();
    if (!hasTmux) {
      console.log(
        `${DIM}tmux not found — streaming all agent output to console${RESET}\n`,
      );
      return;
    }

    this.useTmux = true;
    this.sessionName = `claude-orchestrator-${process.pid}`;

    const isInTmux = !!process.env['TMUX'];

    if (isInTmux) {
      // Create a new window in the existing tmux session
      const currentSession = (
        await execa('tmux', ['display-message', '-p', '#{session_name}'])
      ).stdout.trim();
      this.sessionName = currentSession;

      // Get initial pane (the orchestrator pane)
      const orchestratorPaneId = await tmuxGetCurrentPaneId(currentSession);
      this.paneIds.set('__orchestrator__', orchestratorPaneId);

      // Create a pane for each task
      for (const task of tasks) {
        const paneId = await tmuxSplitWindow(currentSession);
        this.paneIds.set(task.id, paneId);
        const logPath = this.logPaths.get(task.id)!;
        await tmuxSendKeys(paneId, `tail -f "${logPath}"`);
      }
    } else {
      // Create a detached session
      await tmuxNewSession(this.sessionName);
      const orchestratorPaneId = await tmuxGetCurrentPaneId(this.sessionName);
      this.paneIds.set('__orchestrator__', orchestratorPaneId);

      // Run orchestrator status in the first pane
      await tmuxSendKeys(
        orchestratorPaneId,
        `echo "Claude Agent Orchestrator — ${tasks.length} agents running..."`,
      );

      // Create a pane for each task
      for (const task of tasks) {
        const paneId = await tmuxSplitWindow(this.sessionName);
        this.paneIds.set(task.id, paneId);
        const logPath = this.logPaths.get(task.id)!;
        await tmuxSendKeys(paneId, `tail -f "${logPath}"`);
      }
    }

    // Apply tiled layout
    try {
      await tmuxSelectLayout(this.sessionName, 'tiled');
    } catch {
      // layout might not work with 1 pane — ignore
    }

    if (!isInTmux) {
      console.log(
        `\n${BOLD}tmux session created.${RESET} View all agents with:\n  ${BOLD}tmux attach -t ${this.sessionName}${RESET}\n`,
      );
    }
  }

  // ─── Output Routing ────────────────────────────────────────────────────

  writeOutput(taskId: string, text: string): void {
    const logPath = this.logPaths.get(taskId);
    if (logPath) {
      // Async append — fire and forget (best effort)
      fs.appendFile(logPath, text, () => {});
    }

    if (!this.useTmux) {
      // Console fallback: prefix each line with colored task ID
      const color = this.colorMap.get(taskId) ?? '';
      const prefix = `${color}[${taskId}]${RESET} `;
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          process.stdout.write(prefix + line + '\n');
        }
      }
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────

  showSummary(result: OrchestratorResult): void {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${BOLD}Orchestration Complete${RESET}`);
    console.log(`${'─'.repeat(60)}\n`);

    if (result.completedTasks.length > 0) {
      console.log(`${BOLD}✓ Completed (${result.completedTasks.length})${RESET}`);
      for (const state of result.completedTasks) {
        console.log(`  ${BOLD}${state.task.title}${RESET}`);
        if (state.prUrl) {
          console.log(`    PR: ${state.prUrl}`);
        }
      }
      console.log('');
    }

    if (result.failedTasks.length > 0) {
      console.log(`${BOLD}✗ Failed (${result.failedTasks.length})${RESET}`);
      for (const state of result.failedTasks) {
        console.log(`  ${BOLD}${state.task.title}${RESET}`);
        if (state.error) {
          console.log(`    Error: ${state.error}`);
        }
        console.log(`    Workspace preserved at: ${state.workspace.path}`);
        const logPath = this.logPaths.get(state.task.id);
        if (logPath) {
          console.log(`    Log: ${logPath}`);
        }
      }
      console.log('');
    }

    if (result.prs.length > 0) {
      console.log(`${BOLD}Pull Requests Created${RESET}`);
      for (const pr of result.prs) {
        console.log(`  ${pr.taskTitle}: ${pr.url}`);
      }
      console.log('');
    }

    if (this.useTmux) {
      console.log(
        `${DIM}Agent logs preserved at: ${this.logDir}${RESET}`,
      );
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────

  getLogPath(taskId: string): string | undefined {
    return this.logPaths.get(taskId);
  }
}
