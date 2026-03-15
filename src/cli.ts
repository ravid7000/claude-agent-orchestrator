#!/usr/bin/env node
import { Command } from 'commander';
import * as p from '@clack/prompts';
import fs from 'fs';
import path from 'path';
import { loadConfig, DEFAULT_CONFIG_YAML } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { type OrchestratorConfig } from './types.js';

// ─── Version ───────────────────────────────────────────────────────────────

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as { version: string };

// ─── Main Program ──────────────────────────────────────────────────────────

const program = new Command()
  .name('orchestrate')
  .description('Parallel Claude agent orchestrator — spawns sub-agents to fix features/bugs in isolated git workspaces')
  .version(pkg.version);

// ─── orchestrate run ───────────────────────────────────────────────────────

program
  .command('run [task]')
  .description('Decompose a task and run parallel Claude sub-agents to implement it')
  .option('-m, --model <model>', 'Claude model to use (e.g. claude-opus-4-6)')
  .option('-w, --workspace <type>', 'Workspace type: worktree or clone', (v) => {
    if (v !== 'worktree' && v !== 'clone') {
      throw new Error('--workspace must be "worktree" or "clone"');
    }
    return v as 'worktree' | 'clone';
  })
  .option('-n, --max-agents <n>', 'Maximum number of parallel agents', parseInt)
  .option('-b, --budget <usd>', 'Max spend per agent in USD (e.g. 2.0)', parseFloat)
  .option('--no-tmux', 'Disable tmux display, stream output to console')
  .option('--repo-url <url>', 'Repository URL (required for clone workspace mode)')
  .action(async (task: string | undefined, options) => {
    p.intro(`Claude Agent Orchestrator`);

    // Build config overrides from CLI flags
    const overrides: Partial<OrchestratorConfig> = {};
    if (options.model) overrides.model = options.model;
    if (options.maxAgents) overrides.maxAgents = options.maxAgents;
    if (options.budget) overrides.maxBudgetPerAgentUsd = options.budget;
    if (options.tmux === false) overrides.tmux = false;
    if (options.workspace || options.repoUrl) {
      overrides.workspace = {
        type: options.workspace ?? 'worktree',
        repoUrl: options.repoUrl,
      };
    }

    // Load config
    let config: OrchestratorConfig;
    try {
      config = await loadConfig(process.cwd(), overrides);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Get task (from arg or interactive prompt)
    let finalTask = task;
    if (!finalTask) {
      const input = await p.text({
        message: 'What task should the agents work on?',
        placeholder: 'Add authentication middleware to all API routes',
        validate: (v) => {
          if (v.trim().length < 10) return 'Please provide a more detailed task description';
        },
      });

      if (p.isCancel(input)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      finalTask = input as string;
    }

    // Run orchestration
    const orchestrator = new Orchestrator(config);
    let result;
    try {
      result = await orchestrator.run(finalTask, { cwd: process.cwd() });
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    p.outro('Done!');

    // Exit with non-zero only if ALL agents failed
    if (result.failedTasks.length > 0 && result.completedTasks.length === 0) {
      process.exit(1);
    }
  });

// ─── orchestrate init ──────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a default orchestrator.config.yaml in the current directory')
  .action(() => {
    const configPath = path.join(process.cwd(), 'orchestrator.config.yaml');
    if (fs.existsSync(configPath)) {
      console.error(`Config file already exists at ${configPath}`);
      process.exit(1);
    }
    fs.writeFileSync(configPath, DEFAULT_CONFIG_YAML, 'utf-8');
    console.log(`Created ${configPath}`);
  });

// ─── Unhandled Errors ─────────────────────────────────────────────────────

process.on('unhandledRejection', (err) => {
  console.error('\nUnhandled error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// ─── Parse ─────────────────────────────────────────────────────────────────

program.parse(process.argv);
