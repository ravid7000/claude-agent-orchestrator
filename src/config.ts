import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { z } from 'zod';
import { ConfigError, type OrchestratorConfig } from './types.js';

// ─── Zod Schema ────────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().default('claude-opus-4-6'),
  maxAgents: z.number().int().min(1).max(20).default(5),
  maxBudgetPerAgentUsd: z.number().positive().optional(),
  workspace: z
    .object({
      type: z.enum(['worktree', 'clone']).default('worktree'),
      repoUrl: z.string().optional(),
    })
    .default({}),
  github: z
    .object({
      token: z.string().optional(),
    })
    .optional(),
  tmux: z.boolean().default(true),
});

// ─── File Helpers ──────────────────────────────────────────────────────────

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readYamlFile(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function loadProjectConfig(cwd: string): Record<string, unknown> {
  for (const filename of [
    'orchestrator.config.yaml',
    'orchestrator.config.yml',
    'orchestrator.config.json',
  ]) {
    const filepath = path.join(cwd, filename);
    if (fs.existsSync(filepath)) {
      return filename.endsWith('.json') ? readJsonFile(filepath) : readYamlFile(filepath);
    }
  }
  return {};
}

function deepMerge(
  ...objects: Array<Record<string, unknown>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

// ─── Default Config Template ───────────────────────────────────────────────

export const DEFAULT_CONFIG_YAML = `# Claude Agent Orchestrator Configuration
# apiKey: "sk-ant-..."   # optional — falls back to ANTHROPIC_API_KEY env var
model: claude-opus-4-6
maxAgents: 5
# maxBudgetPerAgentUsd: 2.0   # optional budget cap per sub-agent

workspace:
  type: worktree     # "worktree" (default) or "clone"
  # repoUrl: "https://github.com/user/repo"   # required for "clone" mode

# github:
#   token: "ghp_..."   # optional — gh CLI uses its own auth by default

tmux: true   # set to false to disable tmux display
`;

// ─── Main Loader ───────────────────────────────────────────────────────────

export async function loadConfig(
  cwd: string = process.cwd(),
  overrides: Partial<OrchestratorConfig> = {},
): Promise<OrchestratorConfig> {
  // 1. Global config
  const globalConfigPath = path.join(
    os.homedir(),
    '.config',
    'claude-orchestrator',
    'config.json',
  );
  const globalConfig = readJsonFile(globalConfigPath);

  // 2. Project config
  const projectConfig = loadProjectConfig(cwd);

  // 3. Merge
  const merged = deepMerge(
    globalConfig,
    projectConfig,
    overrides as Record<string, unknown>,
  );

  // 4. Env var wins for apiKey
  if (process.env.ANTHROPIC_API_KEY) {
    merged['apiKey'] = process.env.ANTHROPIC_API_KEY;
  }

  // 5. GitHub token from env
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const github = (merged['github'] as Record<string, unknown>) ?? {};
    github['token'] = token;
    merged['github'] = github;
  }

  // 6. Validate
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }

  const config = parsed.data as OrchestratorConfig;

  if (!config.apiKey) {
    throw new ConfigError(
      'No API key found. Set the ANTHROPIC_API_KEY environment variable or add apiKey to your config file.',
    );
  }

  return config;
}
