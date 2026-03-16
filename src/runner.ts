import { execa } from 'execa';
import { type OrchestratorConfig, type SubTask, type Workspace, RunnerError } from './types.js';

// ─── Sub-Agent Prompt ──────────────────────────────────────────────────────

function buildSubAgentPrompt(task: SubTask, workspace: Workspace): string {
  const filesHint =
    task.files.length > 0
      ? `Files likely to need changes: ${task.files.join(', ')}`
      : 'Explore the codebase to identify which files need changes.';

  return `You are an expert software engineer working on an isolated git branch.

## Your Task
**Title**: ${task.title}

**Description**:
${task.description}

## Context
- Branch: ${workspace.branchName}
- ${filesHint}

## Instructions
Complete the following steps in order:

1. **Explore**: Use your tools to understand the repository structure and existing code patterns.
2. **Implement**: Make all required changes to complete your task. Follow existing code style.
3. **Test**: Run the project's test suite if one exists (look for \`npm test\`, \`pytest\`, \`go test\`, \`cargo test\`, etc.).
4. **Commit**: Stage and commit your changes:
   \`\`\`
   git add -A && git commit -m "feat: ${task.title}"
   \`\`\`
5. **Push**: Push your branch to the remote:
   \`\`\`
   git push -u origin ${workspace.branchName}
   \`\`\`
6. **Pull Request**: Create a PR using the gh CLI:
   \`\`\`
   gh pr create --title "${task.title}" --body "..."
   \`\`\`
   Write a clear PR body explaining what was changed and why.

**Important**: When the PR is created successfully, output its URL on a line formatted exactly as:
\`PR_URL: <url>\`

Your task is complete once the PR is created.`;
}

// ─── Stream-JSON Event Types ───────────────────────────────────────────────

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

function extractTextFromEvent(event: StreamEvent): string {
  if (event.type !== 'assistant') return '';
  const content = event.message?.content ?? [];
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

const PR_URL_PATTERN = /PR_URL:\s*(https?:\/\/\S+)/i;

// ─── Fallback PR URL Detection ─────────────────────────────────────────────

async function detectPrUrl(workspace: Workspace): Promise<string | undefined> {
  try {
    const { stdout } = await execa('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], {
      cwd: workspace.path,
    });
    const url = stdout.trim();
    if (url.startsWith('http')) return url;
  } catch {
    // no PR found
  }
  return undefined;
}

// ─── Main Runner ───────────────────────────────────────────────────────────

export async function runSubAgent(
  task: SubTask,
  workspace: Workspace,
  config: OrchestratorConfig,
  onOutput: (text: string) => void,
): Promise<{ prUrl: string }> {
  const prompt = buildSubAgentPrompt(task, workspace);

  const args: string[] = [
    '--print',
    prompt,
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--model',
    config.model,
  ];

  if (config.maxBudgetPerAgentUsd != null) {
    args.push('--max-budget-usd', String(config.maxBudgetPerAgentUsd));
  }

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (config.authToken) {
    env['ANTHROPIC_AUTH_TOKEN'] = config.authToken;
  }
  if (config.apiKey) {
    env['ANTHROPIC_API_KEY'] = config.apiKey;
  }
  if (config.baseUrl) {
    env['ANTHROPIC_BASE_URL'] = config.baseUrl;
  }
  if (config.github?.token) {
    env['GH_TOKEN'] = config.github.token;
  }

  let prUrl: string | undefined;
  let resultError: string | undefined;
  let collectedOutput = '';

  // Spawn claude CLI
  const subprocess = execa('claude', args, {
    cwd: workspace.path,
    env,
    reject: false,  // don't throw on non-zero exit — we handle it manually
    all: false,
  });

  // Read stdout line by line
  if (subprocess.stdout) {
    subprocess.stdout.setEncoding('utf-8');

    let buffer = '';
    subprocess.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: StreamEvent | null = null;
        try {
          event = JSON.parse(trimmed) as StreamEvent;
        } catch {
          // non-JSON line — treat as raw text
          onOutput(trimmed + '\n');
          collectedOutput += trimmed + '\n';
          continue;
        }

        // Extract readable text from assistant messages
        const text = extractTextFromEvent(event);
        if (text) {
          onOutput(text);
          collectedOutput += text;

          // Check for PR URL pattern in assistant text
          const match = text.match(PR_URL_PATTERN);
          if (match) {
            prUrl = match[1];
          }
        }

        // Handle result event
        if (event.type === 'result') {
          if (event.is_error) {
            resultError = event.result ?? 'Unknown error during agent execution';
          }
          if (event.total_cost_usd != null) {
            onOutput(`\n[Cost: $${event.total_cost_usd.toFixed(4)}]\n`);
          }
        }
      }
    });
  }

  // Collect stderr for error reporting
  let stderrOutput = '';
  if (subprocess.stderr) {
    subprocess.stderr.setEncoding('utf-8');
    subprocess.stderr.on('data', (chunk: string) => {
      stderrOutput += chunk;
    });
  }

  // Wait for process to complete
  const result = await subprocess;

  if (resultError) {
    throw new RunnerError(
      `Agent failed: ${resultError}`,
      task.id,
      result.exitCode ?? 1,
    );
  }

  if (result.exitCode !== 0) {
    const errMsg = stderrOutput.trim() || resultError || 'Non-zero exit code';
    throw new RunnerError(
      `Agent process exited with code ${result.exitCode}: ${errMsg}`,
      task.id,
      result.exitCode ?? 1,
    );
  }

  // Also check the full output for PR_URL if not caught during streaming
  if (!prUrl) {
    const match = collectedOutput.match(PR_URL_PATTERN);
    if (match) {
      prUrl = match[1];
    }
  }

  // Fallback: use gh CLI to find PR for this branch
  if (!prUrl) {
    prUrl = await detectPrUrl(workspace);
  }

  if (!prUrl) {
    // Soft failure — agent may have done the work but didn't output PR_URL
    onOutput(
      '\n[Warning: Could not detect PR URL. The branch was pushed but PR creation may have failed.]\n',
    );
    throw new RunnerError(
      'Agent completed but no PR URL was found. Check the workspace for details.',
      task.id,
    );
  }

  return { prUrl };
}
