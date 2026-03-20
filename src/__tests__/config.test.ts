import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, DEFAULT_CONFIG_YAML } from '../config.js';
import { ConfigError } from '../types.js';

// Use a real temp directory so we don't need to mock fs
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config-test-'));
  // Point global config to an empty temp dir so tests don't pick up real config
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  // Clear relevant env vars before each test
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  vi.stubEnv('API_TIMEOUT_MS', '');
  vi.stubEnv('ORCHESTRATOR_RUNNER', '');
  vi.stubEnv('GH_TOKEN', '');
  vi.stubEnv('GITHUB_TOKEN', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── DEFAULT_CONFIG_YAML ───────────────────────────────────────────────────

describe('DEFAULT_CONFIG_YAML', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_CONFIG_YAML).toBe('string');
    expect(DEFAULT_CONFIG_YAML.length).toBeGreaterThan(0);
  });

  it('contains ANTHROPIC_AUTH_TOKEN reference', () => {
    expect(DEFAULT_CONFIG_YAML).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('contains ANTHROPIC_BASE_URL reference', () => {
    expect(DEFAULT_CONFIG_YAML).toContain('ANTHROPIC_BASE_URL');
  });
});

// ─── loadConfig ───────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('throws ConfigError when no API key is set', async () => {
    await expect(loadConfig(tmpDir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError with helpful message when no API key', async () => {
    await expect(loadConfig(tmpDir)).rejects.toThrow('ANTHROPIC_AUTH_TOKEN');
  });

  it('loads authToken from ANTHROPIC_AUTH_TOKEN env var', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    const config = await loadConfig(tmpDir);
    expect(config.authToken).toBe('sk-ant-test');
  });

  it('loads apiKey from ANTHROPIC_API_KEY env var', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-apikey');
    const config = await loadConfig(tmpDir);
    expect(config.apiKey).toBe('sk-ant-apikey');
  });

  it('loads baseUrl from ANTHROPIC_BASE_URL env var', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.example.com');
    const config = await loadConfig(tmpDir);
    expect(config.baseUrl).toBe('https://proxy.example.com');
  });

  it('loads timeout from API_TIMEOUT_MS env var', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    vi.stubEnv('API_TIMEOUT_MS', '30000');
    const config = await loadConfig(tmpDir);
    expect(config.timeout).toBe(30000);
  });

  it('ignores invalid API_TIMEOUT_MS values', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    vi.stubEnv('API_TIMEOUT_MS', 'not-a-number');
    const config = await loadConfig(tmpDir);
    expect(config.timeout).toBeUndefined();
  });

  it('defaults runner to sdk', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    const config = await loadConfig(tmpDir);
    expect(config.runner).toBe('sdk');
  });

  it('ORCHESTRATOR_RUNNER=cli overrides runner to cli', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    vi.stubEnv('ORCHESTRATOR_RUNNER', 'cli');
    const config = await loadConfig(tmpDir);
    expect(config.runner).toBe('cli');
  });

  it('ignores unknown ORCHESTRATOR_RUNNER values', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    vi.stubEnv('ORCHESTRATOR_RUNNER', 'invalid');
    const config = await loadConfig(tmpDir);
    expect(config.runner).toBe('sdk'); // falls back to schema default
  });

  it('applies default model, maxAgents, workspace type, tmux', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    const config = await loadConfig(tmpDir);
    expect(config.model).toBe('claude-opus-4-6');
    expect(config.maxAgents).toBe(5);
    expect(config.workspace.type).toBe('worktree');
    expect(config.tmux).toBe(true);
  });

  it('respects overrides passed as second argument', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    const config = await loadConfig(tmpDir, { model: 'claude-haiku', maxAgents: 2, tmux: false });
    expect(config.model).toBe('claude-haiku');
    expect(config.maxAgents).toBe(2);
    expect(config.tmux).toBe(false);
  });

  it('ANTHROPIC_AUTH_TOKEN sets authToken independently from apiKey override', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-from-env');
    const config = await loadConfig(tmpDir, { apiKey: 'sk-ant-from-override' });
    expect(config.authToken).toBe('sk-ant-from-env');
    expect(config.apiKey).toBe('sk-ant-from-override');
  });

  it('reads GH_TOKEN env var into github.token', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    vi.stubEnv('GH_TOKEN', 'ghp_mytoken');
    const config = await loadConfig(tmpDir);
    expect(config.github?.token).toBe('ghp_mytoken');
  });

  it('reads GITHUB_TOKEN when GH_TOKEN is absent', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_fallback');
    const config = await loadConfig(tmpDir);
    expect(config.github?.token).toBe('ghp_fallback');
  });

  it('throws ConfigError on invalid maxAgents (> 20)', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    await expect(loadConfig(tmpDir, { maxAgents: 99 })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError on invalid maxAgents (< 1)', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    await expect(loadConfig(tmpDir, { maxAgents: 0 })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError on invalid workspace type', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-test');
    await expect(
      loadConfig(tmpDir, { workspace: { type: 'invalid' as 'worktree' } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('loads project YAML config file', async () => {
    const yamlContent = `apiKey: sk-ant-from-yaml\nmodel: claude-sonnet\nmaxAgents: 3\n`;
    fs.writeFileSync(path.join(tmpDir, 'orchestrator.config.yaml'), yamlContent);
    const config = await loadConfig(tmpDir);
    expect(config.apiKey).toBe('sk-ant-from-yaml');
    expect(config.model).toBe('claude-sonnet');
    expect(config.maxAgents).toBe(3);
  });

  it('loads project JSON config file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'orchestrator.config.json'),
      JSON.stringify({ apiKey: 'sk-ant-json', maxAgents: 4 }),
    );
    const config = await loadConfig(tmpDir);
    expect(config.apiKey).toBe('sk-ant-json');
    expect(config.maxAgents).toBe(4);
  });

  it('ANTHROPIC_AUTH_TOKEN sets authToken alongside apiKey from YAML', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'orchestrator.config.yaml'),
      'apiKey: sk-ant-from-yaml\n',
    );
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-from-env');
    const config = await loadConfig(tmpDir);
    expect(config.authToken).toBe('sk-ant-from-env');
    expect(config.apiKey).toBe('sk-ant-from-yaml');
  });

  it('ANTHROPIC_API_KEY env var overrides apiKey from YAML config file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'orchestrator.config.yaml'),
      'apiKey: sk-ant-from-yaml\n',
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-wins');
    const config = await loadConfig(tmpDir);
    expect(config.apiKey).toBe('sk-ant-env-wins');
  });

  it('loads global config from ~/.config/claude-orchestrator/config.json', async () => {
    const globalDir = path.join(tmpDir, '.config', 'claude-orchestrator');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk-ant-global', maxAgents: 7 }),
    );
    const config = await loadConfig(path.join(tmpDir, 'project'));
    expect(config.apiKey).toBe('sk-ant-global');
    expect(config.maxAgents).toBe(7);
  });

  it('project config overrides global config', async () => {
    const globalDir = path.join(tmpDir, '.config', 'claude-orchestrator');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk-ant-global', maxAgents: 7 }),
    );
    const projDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 'orchestrator.config.json'),
      JSON.stringify({ apiKey: 'sk-ant-project', maxAgents: 2 }),
    );
    const config = await loadConfig(projDir);
    expect(config.apiKey).toBe('sk-ant-project');
    expect(config.maxAgents).toBe(2);
  });

  it('deep-merges workspace object from project config', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'orchestrator.config.yaml'),
      `apiKey: sk-ant-test\nworkspace:\n  type: clone\n  repoUrl: https://github.com/org/repo\n`,
    );
    const config = await loadConfig(tmpDir);
    expect(config.workspace.type).toBe('clone');
    expect(config.workspace.repoUrl).toBe('https://github.com/org/repo');
  });
});
