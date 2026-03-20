import { execa } from 'execa';
import { type OrchestratorConfig, type SubTask, type Workspace, RunnerError } from './types.js';
import { buildSubAgentPrompt, PR_URL_PATTERN, detectPrUrl } from './agent-prompt.js';
import { runSubAgentSDK } from './sdk-runner.js';

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

// ─── Main Runner ───────────────────────────────────────────────────────────

export async function runSubAgent(
  task: SubTask,
  workspace: Workspace,
  config: OrchestratorConfig,
  onOutput: (text: string) => void,
): Promise<{ prUrl: string }> {
  if (config.runner === 'sdk') {
    return runSubAgentSDK(task, workspace, config, onOutput);
  }

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

  onOutput(`[${task.id}] Spawned claude CLI (pid: ${subprocess.pid ?? 'unknown'})\n`);
  onOutput(`[${task.id}] Command: claude ${args.slice(0, 4).join(' ')} ...\n`);
  onOutput(`[${task.id}] Working dir: ${workspace.path}\n`);

  // Read stdout line by line
  if (subprocess.stdout) {
    subprocess.stdout.setEncoding('utf-8');

    let buffer = '';
    let firstChunk = true;
    subprocess.stdout.on('data', (chunk: string) => {
      if (firstChunk) {
        onOutput(`[${task.id}] First stdout data received — agent is running\n`);
        firstChunk = false;
      }
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

  // Collect stderr and stream it live for debugging
  let stderrOutput = '';
  if (subprocess.stderr) {
    subprocess.stderr.setEncoding('utf-8');
    subprocess.stderr.on('data', (chunk: string) => {
      stderrOutput += chunk;
      onOutput(`[${task.id}][stderr] ${chunk}`);
    });
  }

  // Wait for process to complete
  const result = await subprocess;
  onOutput(`[${task.id}] Process exited with code ${result.exitCode ?? 'unknown'}\n`);

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
