import { execa } from 'execa';
import { type SubTask, type Workspace } from './types.js';

// ─── Sub-Agent Prompt ──────────────────────────────────────────────────────

export function buildSubAgentPrompt(task: SubTask, workspace: Workspace): string {
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

// ─── PR URL Pattern ────────────────────────────────────────────────────────

export const PR_URL_PATTERN = /PR_URL:\s*(https?:\/\/\S+)/i;

// ─── Fallback PR URL Detection ─────────────────────────────────────────────

export async function detectPrUrl(workspace: Workspace): Promise<string | undefined> {
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
