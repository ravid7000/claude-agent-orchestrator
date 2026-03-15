# Claude Agent Orchestrator

Orchestrate multiple Claude Code CLI agents running **in parallel** to implement features or fix bugs across isolated git branches — each agent commits its work and opens a GitHub PR automatically.

```
You: "Add dark mode support across the entire UI"
  └─► Claude plans: 3 independent sub-tasks
       ├─► Agent 1 → theme tokens + CSS variables       → PR #42
       ├─► Agent 2 → dark mode toggle in NavBar         → PR #43
       └─► Agent 3 → update all page-level components   → PR #44
```

---

## How It Works

1. **You provide a task** — via CLI argument, interactive prompt, or config file
2. **The planner** calls Claude API to analyze your repo and decompose the task into independent sub-tasks
3. **You approve** the plan (and optionally deselect tasks) before anything runs
4. **Isolated workspaces** are created for each sub-task (git worktrees or full clones)
5. **Parallel agents** — one `claude` CLI subprocess per sub-task — explore the code, implement changes, run tests, commit, push, and open a PR
6. **tmux** shows all agents streaming live in separate panes
7. **Summary** lists all created PR URLs

The master orchestrator handles only coordination. All actual coding is done by the `claude` CLI — no custom tool loop required.

---

## Prerequisites

### Required

| Tool | Install | Verify |
|---|---|---|
| **Node.js 20+** | [nodejs.org](https://nodejs.org) | `node --version` |
| **Claude Code CLI** | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| **GitHub CLI** | [cli.github.com](https://cli.github.com) | `gh --version` |
| **Git** | [git-scm.com](https://git-scm.com) | `git --version` |

### Optional but Recommended

| Tool | Purpose | Install |
|---|---|---|
| **tmux** | Live multi-pane agent display | `brew install tmux` / `apt install tmux` |

### Authentication

**Claude API key** — the sub-agents need an Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**GitHub CLI** — must be logged in to create PRs:

```bash
gh auth login
```

**Claude Code CLI** — must be authenticated:

```bash
claude --version   # will prompt to log in if needed
```

---

## Installation

### From source (development)

```bash
git clone https://github.com/your-org/claude-agent-orchestrator
cd claude-agent-orchestrator
npm install
npm run build

# Run directly
node dist/cli.js run "your task here"

# Or link globally
npm link
orchestrate run "your task here"
```

### From npm (once published)

```bash
npm install -g claude-agent-orchestrator
orchestrate --version
```

---

## Quick Start

```bash
# 1. Navigate to any git repository
cd ~/your-project

# 2. Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run the orchestrator
orchestrate run "add skeleton loading states to all page components"
```

The orchestrator will:

- Analyze your repo
- Propose a decomposition plan
- Wait for your approval
- Spawn agents in parallel
- Print PR URLs when done

---

## Usage

### Interactive mode (recommended)

```bash
orchestrate run
# You will be prompted: "What task should the agents work on?"
```

### Inline task

```bash
orchestrate run "add unit tests for the UserProfile and Settings components"
```

### With options

```bash
# Use a specific model
orchestrate run "refactor the NavBar into a responsive mobile-friendly layout" --model claude-sonnet-4-5

# Limit to 2 parallel agents
orchestrate run "fix broken animations in the onboarding flow" --max-agents 2

# Set a cost budget per agent (in USD)
orchestrate run "add skeleton loading states to all list views" --budget 1.50

# Disable tmux, stream everything to console
orchestrate run "add empty state illustrations to all data tables" --no-tmux

# Clone mode (full git clone per agent, from a remote URL)
orchestrate run "add infinite scroll to the product feed" --workspace clone --repo-url https://github.com/org/repo

# Combine options
orchestrate run "migrate all component styles from CSS Modules to Tailwind CSS" \
  --model claude-opus-4-6 \
  --max-agents 4 \
  --budget 5.0
```

### All CLI flags

| Flag | Default | Description |
|---|---|---|
| `-m, --model <model>` | `claude-opus-4-6` | Claude model for planning and sub-agents |
| `-w, --workspace <type>` | `worktree` | Workspace isolation: `worktree` or `clone` |
| `-n, --max-agents <n>` | `5` | Maximum parallel agents at once |
| `-b, --budget <usd>` | none | Max spend per sub-agent (USD) |
| `--no-tmux` | tmux enabled | Disable tmux, print output to console |
| `--repo-url <url>` | auto-detected | Remote URL for clone mode |

---

## Configuration File

Run `orchestrate init` to scaffold a config file in your project root, or create it manually:

```bash
orchestrate init
# Creates: ./orchestrator.config.yaml
```

**`orchestrator.config.yaml`**:

```yaml
# Claude Agent Orchestrator Configuration

# apiKey: "sk-ant-..."   # optional — falls back to ANTHROPIC_API_KEY env var
model: claude-opus-4-6
maxAgents: 5
# maxBudgetPerAgentUsd: 2.0   # optional budget cap per sub-agent

workspace:
  type: worktree     # "worktree" (default) or "clone"
  # repoUrl: "https://github.com/user/repo"   # required for "clone" mode

# github:
#   token: "ghp_..."   # optional — gh CLI uses its own auth by default

tmux: true
```

### Config file locations (loaded in order, later overrides earlier)

1. `~/.config/claude-orchestrator/config.json` — global user config
2. `./orchestrator.config.yaml` or `./orchestrator.config.json` — project config
3. `ANTHROPIC_API_KEY` environment variable — always overrides `apiKey` in files
4. CLI flags — highest priority

---

## Workspace Modes

### `worktree` (default)

Creates a [git worktree](https://git-scm.com/docs/git-worktree) for each agent in a temp directory. Fast — shares the git history without cloning. Each agent gets its own branch and working directory.

```
/tmp/claude-orchestrator-<pid>/
  task-1/   ← Agent 1 works here (branch: orchestrator/theme-tokens-css-variables-1234567890)
  task-2/   ← Agent 2 works here (branch: orchestrator/dark-mode-toggle-navbar-1234567890)
```

**Requirements**: Must be run inside a git repository. Works with any remote.

### `clone`

Does a full `git clone` for each agent. Slower to start but fully independent. Required if you want agents working on a repo other than the current one.

```yaml
# orchestrator.config.yaml
workspace:
  type: clone
  repoUrl: https://github.com/org/repo
```

Or via CLI:

```bash
orchestrate run "task" --workspace clone --repo-url https://github.com/org/repo
```

---

## tmux Display

When tmux is available, the orchestrator creates a session with one pane per agent:

```
┌──────────────────────┬──────────────────────┐
│  [Orchestrator]      │  [task-1]            │
│  3 agents running    │  Reading NavBar.tsx  │
│                      │  Adding dark toggle  │
│                      │  Running npm test    │
├──────────────────────┼──────────────────────┤
│  [task-2]            │  [task-3]            │
│  Writing theme       │  Creating PR #44...  │
│  tokens in globals   │  PR_URL: https://... │
└──────────────────────┴──────────────────────┘
```

**If not already in tmux**: A new detached session is created. You'll see:

```
tmux session created. View all agents with:
  tmux attach -t claude-orchestrator-12345
```

**If already in tmux**: Panes are added to your current window.

**No tmux**: Use `--no-tmux` to stream all output to the console with colored prefixes.

Agent logs are always written to `/tmp/claude-orch-<pid>/task-N.log` and preserved after the run for debugging.

---

## What Sub-Agents Do

Each sub-agent receives a detailed prompt and runs as a `claude` CLI subprocess with full tool access. The agent autonomously:

1. Explores the repo structure (`ls`, `cat`, `grep`)
2. Reads relevant source files
3. Implements the changes (edits/creates files)
4. Runs the test suite if available
5. Commits: `git add -A && git commit -m "feat: <title>"`
6. Pushes: `git push -u origin <branch>`
7. Creates a PR: `gh pr create --title "..." --body "..."`

The agent has access to all Claude Code built-in tools: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`.

---

## Programmatic API

Use as a library in your own scripts:

```typescript
import { Orchestrator, loadConfig } from 'claude-agent-orchestrator';

const config = await loadConfig('/path/to/project', {
  model: 'claude-opus-4-6',
  maxAgents: 3,
  tmux: false,
});

const orchestrator = new Orchestrator(config);

const result = await orchestrator.run(
  'Build a responsive dashboard with charts, filters, and CSV export',
  { cwd: '/path/to/project' }
);

console.log('PRs created:');
for (const pr of result.prs) {
  console.log(`  ${pr.taskTitle}: ${pr.url}`);
}

if (result.failedTasks.length > 0) {
  console.log('Failed tasks:', result.failedTasks.map(t => t.task.title));
}
```

### API Reference

#### `loadConfig(cwd?, overrides?)`

Loads and validates configuration from all sources. Returns `OrchestratorConfig`.

#### `new Orchestrator(config)`

Creates an orchestrator instance.

#### `orchestrator.run(task, { cwd })`

Runs the full orchestration flow. Returns `OrchestratorResult`:

```typescript
{
  completedTasks: AgentState[];  // succeeded agents
  failedTasks: AgentState[];     // failed agents (workspaces preserved)
  prs: { taskTitle: string; url: string }[];  // created PR URLs
}
```

---

## Troubleshooting

### `No API key found`

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or add apiKey to orchestrator.config.yaml
```

### `gh: command not found` or PR creation fails

```bash
# Install gh CLI
brew install gh        # macOS
# or: https://cli.github.com/manual/installation

# Authenticate
gh auth login
```

### `git worktree add` fails — "fatal: ... is already checked out"

Each worktree needs a unique branch. This shouldn't happen normally, but if it does:

```bash
git worktree list       # see existing worktrees
git worktree prune      # clean up stale entries
```

### Agents fail with "Non-zero exit code"

The failed workspace is preserved at `/tmp/claude-orchestrator-<pid>/task-N/`. Inspect:

```bash
# Check the agent log
cat /tmp/claude-orch-<pid>/task-N.log

# Inspect the workspace
ls /tmp/claude-orchestrator-<pid>/task-N/
```

### `tmux: command not found`

tmux is optional. Use `--no-tmux` or install it:

```bash
brew install tmux       # macOS
apt install tmux        # Ubuntu/Debian
```

### Agents hit API rate limits

Reduce parallelism:

```bash
orchestrate run "task" --max-agents 2
```

Or add a per-agent budget:

```bash
orchestrate run "task" --budget 1.0
```

---

## Project Structure

```
claude-agent-orchestrator/
├── src/
│   ├── types.ts          # Shared interfaces and custom error classes
│   ├── config.ts         # Config loading (Zod schema, multi-source merge)
│   ├── git.ts            # Git helpers: worktree, clone, branch naming
│   ├── workspace.ts      # Workspace lifecycle and temp directory management
│   ├── planner.ts        # Anthropic SDK call for task decomposition
│   ├── runner.ts         # Spawns `claude` CLI subprocess per task
│   ├── display.ts        # tmux pane management and log-file routing
│   ├── orchestrator.ts   # Main coordinator with concurrency limiting
│   ├── cli.ts            # CLI entry point (commander.js + @clack/prompts)
│   └── index.ts          # Library exports
├── dist/                 # Compiled output (after npm run build)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# TypeScript type-check only
npm run typecheck

# Run from source (no build step)
npm run dev -- run "your task"

# Clean build output
npm run clean
```

---

## License

MIT
