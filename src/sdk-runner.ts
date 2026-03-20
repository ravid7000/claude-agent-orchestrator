import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { execa } from 'execa';
import { type OrchestratorConfig, type SubTask, type Workspace, RunnerError } from './types.js';
import { buildSubAgentPrompt, PR_URL_PATTERN, detectPrUrl } from './agent-prompt.js';

const MAX_TURNS = 100;
const MAX_TOKENS_PER_TURN = 8192;
const BASH_TIMEOUT_MS = 300_000; // 5 minutes
const WEB_FETCH_MAX_CHARS = 20_000;

// ─── Tool Definitions ──────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description:
      'Execute a shell command in the workspace directory. Returns exit code, stdout, and stderr.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        timeout_ms: {
          type: 'number',
          description: `Timeout in milliseconds (default ${BASH_TIMEOUT_MS})`,
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file. Path may be relative to the workspace root or absolute.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file, creating parent directories as needed. Path may be relative to the workspace root or absolute.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'web_fetch',
    description: `Fetch the text content of a URL. Response body is truncated to ${WEB_FETCH_MAX_CHARS} characters.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
];

// ─── Tool Execution ────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  workspace: Workspace,
  onOutput: (text: string) => void,
): Promise<string> {
  try {
    switch (name) {
      case 'bash': {
        const command = String(input['command']);
        const timeoutMs =
          typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : BASH_TIMEOUT_MS;
        onOutput(`[bash] $ ${command}\n`);
        const result = await execa('sh', ['-c', command], {
          cwd: workspace.path,
          timeout: timeoutMs,
          reject: false,
          all: false,
        });
        const parts: string[] = [`Exit code: ${result.exitCode ?? 'unknown'}`];
        if (result.stdout) parts.push(`Stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`Stderr:\n${result.stderr}`);
        if (result.stdout || result.stderr) {
          onOutput((result.stdout || result.stderr || '') + '\n');
        }
        return parts.join('\n');
      }

      case 'read_file': {
        const filePath = String(input['path']);
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspace.path, filePath);
        return fs.readFileSync(absPath, 'utf-8');
      }

      case 'write_file': {
        const filePath = String(input['path']);
        const content = String(input['content']);
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspace.path, filePath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');
        return `Written ${content.length} bytes to ${absPath}`;
      }

      case 'web_fetch': {
        const url = String(input['url']);
        const response = await fetch(url);
        const text = await response.text();
        return text.length > WEB_FETCH_MAX_CHARS
          ? text.slice(0, WEB_FETCH_MAX_CHARS) +
              `\n... (truncated at ${WEB_FETCH_MAX_CHARS} chars)`
          : text;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    // Return error as a string so the agent sees it and can retry or adjust
    return `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── SDK Agent Loop ────────────────────────────────────────────────────────

export async function runSubAgentSDK(
  task: SubTask,
  workspace: Workspace,
  config: OrchestratorConfig,
  onOutput: (text: string) => void,
): Promise<{ prUrl: string }> {
  const client = new Anthropic({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.authToken ? { authToken: config.authToken } : {}),
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    ...(config.timeout ? { timeout: config.timeout } : {}),
  });

  const model = process.env.ANTHROPIC_MODEL || config.model;
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildSubAgentPrompt(task, workspace) },
  ];

  onOutput(`[${task.id}] SDK runner starting (model: ${model}, max turns: ${MAX_TURNS})\n`);
  onOutput(`[${task.id}] Working dir: ${workspace.path}\n`);

  let prUrl: string | undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let completedNormally = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS_PER_TURN,
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RunnerError(`SDK API error on turn ${turn + 1}: ${msg}`, task.id);
    }

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // Collect tool_use blocks and emit text blocks
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        if (block.text) {
          onOutput(block.text);
          const match = block.text.match(PR_URL_PATTERN);
          if (match) prUrl = match[1];
        }
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    }

    // No tool calls — agent is done or was truncated
    if (toolUseBlocks.length === 0) {
      if (response.stop_reason === 'max_tokens') {
        // Model was cut off mid-response — ask it to continue
        onOutput(`\n[Turn ${turn + 1}] Response truncated, continuing...\n`);
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: 'Please continue from where you left off.' }],
        });
        continue;
      }
      onOutput(`\n[Turn ${turn + 1}] Agent finished (stop_reason: ${response.stop_reason})\n`);
      completedNormally = true;
      break;
    }

    // Execute tools in sequence and collect results
    onOutput(`\n[Turn ${turn + 1}] Running ${toolUseBlocks.length} tool(s)...\n`);
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolBlock of toolUseBlocks) {
      onOutput(`[tool: ${toolBlock.name}]\n`);
      const result = await executeTool(
        toolBlock.name,
        toolBlock.input as Record<string, unknown>,
        workspace,
        onOutput,
      );
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: result,
      });
    }

    // Extend conversation with assistant response + tool results
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  if (!completedNormally) {
    throw new RunnerError(
      `Agent exceeded the maximum of ${MAX_TURNS} turns without completing.`,
      task.id,
    );
  }

  onOutput(`\n[Tokens] ${totalInputTokens} in / ${totalOutputTokens} out\n`);

  // Fallback: check gh CLI for PR on this branch
  if (!prUrl) {
    prUrl = await detectPrUrl(workspace);
  }

  if (!prUrl) {
    onOutput(
      '\n[Warning: No PR URL detected. Branch may have been pushed but PR creation may have failed.]\n',
    );
    throw new RunnerError(
      'Agent completed but no PR URL was found. Check the workspace for details.',
      task.id,
    );
  }

  return { prUrl };
}
