import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  type OrchestratorConfig,
  type DecompositionPlan,
  type SubTask,
  PlannerError,
} from './types.js';

// ─── Repo Context Collection ───────────────────────────────────────────────

const KEY_FILES = [
  'package.json',
  'README.md',
  'readme.md',
  'tsconfig.json',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'Makefile',
  'Cargo.toml',
];

const SOURCE_EXTENSIONS = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.rb', '.cs'];

function readFileTruncated(filePath: string, maxLines: number): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n') + `\n... (truncated at ${maxLines} lines)`;
  } catch {
    return '';
  }
}

async function getFileTree(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa(
      'find',
      ['.', '-maxdepth', '3', '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/dist/*', '-not', '-path', '*/.next/*'],
      { cwd },
    );
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length <= 200) return lines.join('\n');
    return lines.slice(0, 200).join('\n') + '\n... (truncated at 200 entries)';
  } catch {
    return '(could not list files)';
  }
}

async function getGitLog(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['log', '--oneline', '-10'], { cwd });
    return stdout;
  } catch {
    return '(no git log available)';
  }
}

function findSampleSourceFiles(cwd: string, max = 3): string[] {
  const results: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 3 || results.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= max) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }
  walk(cwd, 0);
  return results;
}

export async function collectRepoContext(cwd: string): Promise<string> {
  const sections: string[] = [];

  // File tree
  const tree = await getFileTree(cwd);
  sections.push(`## File Tree\n\`\`\`\n${tree}\n\`\`\``);

  // Key files
  const keyFileContents: string[] = [];
  for (const filename of KEY_FILES) {
    const filePath = path.join(cwd, filename);
    if (fs.existsSync(filePath)) {
      const content = readFileTruncated(filePath, 100);
      if (content) {
        keyFileContents.push(`### ${filename}\n\`\`\`\n${content}\n\`\`\``);
      }
    }
  }
  if (keyFileContents.length > 0) {
    sections.push(`## Key Files\n${keyFileContents.join('\n\n')}`);
  }

  // Sample source files
  const sourceFiles = findSampleSourceFiles(cwd, 3);
  if (sourceFiles.length > 0) {
    const sourceContents = sourceFiles.map((fp) => {
      const rel = path.relative(cwd, fp);
      const content = readFileTruncated(fp, 80);
      return `### ${rel}\n\`\`\`\n${content}\n\`\`\``;
    });
    sections.push(`## Sample Source Files\n${sourceContents.join('\n\n')}`);
  }

  // Git log
  const gitLog = await getGitLog(cwd);
  sections.push(`## Recent Commits\n\`\`\`\n${gitLog}\n\`\`\``);

  return sections.join('\n\n');
}

// ─── JSON Parsing ──────────────────────────────────────────────────────────

const PlanSchema = z.object({
  summary: z.string(),
  tasks: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      description: z.string(),
      files: z.array(z.string()).default([]),
    }),
  ),
});

function extractJson(text: string): unknown {
  // 1. Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // 2. Extract from ```json ... ``` fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // continue
    }
  }

  // 3. Find first { to last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // continue
    }
  }

  return null;
}

// ─── Planner ───────────────────────────────────────────────────────────────

export class Planner {
  private client: Anthropic;

  constructor(private config: OrchestratorConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async decompose(task: string, cwd: string): Promise<DecompositionPlan> {
    const repoContext = await collectRepoContext(cwd);

    const systemPrompt = `You are a senior software architect. Your job is to analyze a user's task and a repository, then decompose the task into specific, independently-implementable sub-tasks that can be worked on in parallel by separate engineers.

Rules:
- Each sub-task must be truly independent (no sub-task depends on another sub-task's output)
- Each sub-task should be scoped to specific files or modules
- Keep the number of sub-tasks reasonable (2-${this.config.maxAgents} tasks)
- Use descriptive, action-oriented titles
- The "slug" must be kebab-case, max 40 characters
- The "id" must be "task-1", "task-2", etc.
- Respond ONLY with valid JSON — no explanation, no markdown, just the JSON object`;

    const userPrompt = `## Task to Implement
${task}

## Repository Context
${repoContext}

## Required JSON Response Format
{
  "summary": "Brief description of the overall approach",
  "tasks": [
    {
      "id": "task-1",
      "slug": "kebab-case-slug",
      "title": "Short action-oriented title",
      "description": "Detailed description of exactly what to implement, including acceptance criteria",
      "files": ["src/file1.ts", "src/file2.ts"]
    }
  ]
}`;

    let responseText: string;
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new PlannerError('Planner returned no text content');
      }
      responseText = textBlock.text;
    } catch (err) {
      if (err instanceof PlannerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new PlannerError(`Failed to call Claude API for planning: ${msg}`);
    }

    const parsed = extractJson(responseText);
    if (!parsed) {
      throw new PlannerError(
        `Could not extract valid JSON from planner response.\nRaw response:\n${responseText.slice(0, 500)}`,
      );
    }

    const validated = PlanSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new PlannerError(`Planner returned invalid plan structure:\n${issues}`);
    }

    const plan = validated.data as DecompositionPlan;

    // Enforce maxAgents limit
    if (plan.tasks.length > this.config.maxAgents) {
      plan.tasks = plan.tasks.slice(0, this.config.maxAgents) as SubTask[];
    }

    return plan;
  }
}
