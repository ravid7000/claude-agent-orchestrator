#!/usr/bin/env node
import { Command } from "commander";
import * as p from "@clack/prompts";
import readline from "readline";
import fs from "fs";
import path from "path";
import { loadConfig, DEFAULT_CONFIG_YAML } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { type OrchestratorConfig } from "./types.js";

// ─── Multi-line task prompt ─────────────────────────────────────────────────
// p.text() uses raw-mode stdin which treats every newline as "submit", so
// pasted multi-line text gets truncated after the first line.
// This helper switches to cooked-mode readline (OS handles line buffering),
// collects lines, and finishes when the user submits an empty line or Ctrl+D.

async function promptMultilineTask(message: string, example: string): Promise<string | null> {
  const DIM = "\x1b[2m";
  const CYAN = "\x1b[36m";
  const RESET = "\x1b[0m";

  process.stdout.write(
    `\n${CYAN}◆${RESET}  ${message}\n` +
    `${DIM}   Paste or type — press Enter on an empty line to submit, Ctrl+C to cancel.\n` +
    `   Example: ${example}${RESET}\n\n`,
  );

  const lines: string[] = [];
  let resolved = false;

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      // terminal:false keeps the TTY in cooked mode so the OS echoes keystrokes
      // and line-buffers input — pastes arrive as distinct line events, not one
      // raw burst that submits on the first newline.
      terminal: false,
    });

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(result);
    };

    rl.on("line", (line) => {
      if (line === "" && lines.length > 0) {
        finish(lines.join("\n").trim());
      } else if (line !== "") {
        lines.push(line);
      }
    });

    // Ctrl+D / end of piped input
    rl.on("close", () => finish(lines.length > 0 ? lines.join("\n").trim() : null));

    // Ctrl+C
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      finish(null);
    });
  });
}

// ─── Version ───────────────────────────────────────────────────────────────

const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

// ─── Main Program ──────────────────────────────────────────────────────────

const program = new Command()
  .name("orchestrate")
  .description(
    "Parallel Claude agent orchestrator — spawns sub-agents to fix features/bugs in isolated git workspaces",
  )
  .version(pkg.version);

// ─── orchestrate run ───────────────────────────────────────────────────────

program
  .command("run [task]")
  .description(
    "Decompose a task and run parallel Claude sub-agents to implement it",
  )
  .option("-m, --model <model>", "Claude model to use (e.g. claude-opus-4-6)")
  .option(
    "-w, --workspace <type>",
    "Workspace type: worktree or clone",
    (v) => {
      if (v !== "worktree" && v !== "clone") {
        throw new Error('--workspace must be "worktree" or "clone"');
      }
      return v as "worktree" | "clone";
    },
  )
  .option("-n, --max-agents <n>", "Maximum number of parallel agents", parseInt)
  .option(
    "-b, --budget <usd>",
    "Max spend per agent in USD (e.g. 2.0)",
    parseFloat,
  )
  .option("--no-tmux", "Disable tmux display, stream output to console")
  .option(
    "--repo-url <url>",
    "Repository URL (required for clone workspace mode)",
  )
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
        type: options.workspace ?? "worktree",
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
      const input = await promptMultilineTask(
        "What task should the agents work on?",
        "Add authentication middleware to all API routes",
      );

      if (input === null) {
        p.cancel("Cancelled.");
        process.exit(0);
      }

      if (input.trim().length < 10) {
        p.log.error("Please provide a more detailed task description.");
        process.exit(1);
      }

      p.log.info(`Task (${input.length} chars): ${input.slice(0, 120)}${input.length > 120 ? "…" : ""}`);
      finalTask = input;
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

    p.outro("Done!");

    // Exit with non-zero only if ALL agents failed
    if (result.failedTasks.length > 0 && result.completedTasks.length === 0) {
      process.exit(1);
    }
  });

// ─── orchestrate init ──────────────────────────────────────────────────────

program
  .command("init")
  .description(
    "Create a default orchestrator.config.yaml in the current directory",
  )
  .action(() => {
    const configPath = path.join(process.cwd(), "orchestrator.config.yaml");
    if (fs.existsSync(configPath)) {
      console.error(`Config file already exists at ${configPath}`);
      process.exit(1);
    }
    fs.writeFileSync(configPath, DEFAULT_CONFIG_YAML, "utf-8");
    console.log(`Created ${configPath}`);
  });

// ─── Unhandled Errors ─────────────────────────────────────────────────────

process.on("unhandledRejection", (err) => {
  console.error(
    "\nUnhandled error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});

// ─── Parse ─────────────────────────────────────────────────────────────────

program.parse(process.argv);
