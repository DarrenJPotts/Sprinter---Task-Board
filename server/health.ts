import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { HealthCheck } from '../shared/types.js'
import type { ProjectConfig } from './config.js'

function run(command: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    // A shell on Windows, where az, gh and claude may be .cmd shims.
    execFile(command, args, { cwd, timeout: 30_000, shell: process.platform === 'win32' }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: (error ? stderr || error.message : stdout).trim().split('\n')[0] ?? '' }),
    )
  })
}

async function trackerCheck(config: ProjectConfig): Promise<HealthCheck> {
  if (config.tracker === 'ado') {
    const tenant = config.ado?.tenant ?? ''
    // The board asks for a token in the ADO tenant itself, whichever subscription is the default.
    const az = await run('az', ['account', 'get-access-token', '--tenant', tenant, '--query', 'expiresOn', '-o', 'tsv'])
    return {
      name: 'Azure CLI signed in to the ADO tenant',
      isOk: az.ok,
      detail: az.ok ? `token valid until ${az.out}` : az.out || 'az did not run',
      fix: `az login --tenant ${tenant}`,
    }
  }
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    return { name: 'GitHub token', isOk: true, detail: 'from GH_TOKEN / GITHUB_TOKEN' }
  }
  const gh = await run('gh', ['auth', 'status'])
  return {
    name: 'GitHub CLI signed in',
    isOk: gh.ok,
    detail: gh.ok ? gh.out || 'signed in' : gh.out || 'gh did not run',
    fix: gh.out.includes('not recognized') || gh.out.includes('not found') ? 'winget install GitHub.cli, then gh auth login' : 'gh auth login',
  }
}

const isWindows = process.platform === 'win32'
// Claude Code's own installer; it keeps itself up to date.
const CLAUDE_INSTALL = isWindows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'

/**
 * What this machine needs before any project exists: git and Claude Code, and the sign-in tool for each kind
 * of board. The installed app brings its own Node, so Node is only checked when running from source.
 */
export async function checkMachine(): Promise<HealthCheck[]> {
  const [git, claude, az, gh] = await Promise.all([
    run('git', ['--version']),
    run('claude', ['--version']),
    run('az', ['--version']),
    run('gh', ['--version']),
  ])
  const major = Number(process.versions.node.split('.')[0])
  const hasToken = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)

  return [
    ...(process.versions.electron
      ? []
      : [{ name: 'Node.js 20 or later', isOk: major >= 20, detail: `v${process.versions.node}`, fix: 'Install Node.js 20+ from nodejs.org' }]),
    { name: 'git', isOk: git.ok, detail: git.ok ? git.out : 'not found', fix: isWindows ? 'winget install Git.Git' : 'Install git from git-scm.com' },
    {
      name: 'Claude Code',
      isOk: claude.ok,
      detail: claude.ok ? claude.out : 'not found',
      // Just the command, so Copy pastes something that runs; signing in is the guide's next step.
      fix: CLAUDE_INSTALL,
    },
    {
      name: 'Azure CLI, for Azure DevOps boards',
      isOk: az.ok,
      detail: az.ok ? az.out.replace(/\s+/g, ' ') : 'not found',
      fix: isWindows ? 'winget install Microsoft.AzureCLI' : 'Install from learn.microsoft.com/cli/azure',
      isOptional: true,
    },
    {
      name: 'GitHub CLI or token, for GitHub boards',
      isOk: gh.ok || hasToken,
      detail: hasToken ? 'GH_TOKEN is set' : gh.ok ? gh.out : 'not found',
      fix: isWindows ? 'winget install GitHub.cli' : 'Install from cli.github.com',
      isOptional: true,
    },
  ]
}

/** Everything a project's board and terminals need on this machine, each with the command that fixes it. */
export async function checkHealth(config: ProjectConfig): Promise<HealthCheck[]> {
  const major = Number(process.versions.node.split('.')[0])
  const isRepo = Boolean(config.repoPath) && existsSync(join(config.repoPath, '.git'))

  const [git, claude, tracker, base] = await Promise.all([
    run('git', ['--version']),
    run(config.claudeCommand, ['--version']),
    trackerCheck(config),
    isRepo ? run('git', ['rev-parse', '--verify', '--quiet', config.baseRef], config.repoPath) : Promise.resolve({ ok: false, out: '' }),
  ])

  return [
    { name: 'Node.js 20 or later', isOk: major >= 20, detail: `v${process.versions.node}`, fix: 'Install Node.js 20+ from nodejs.org' },
    { name: 'git', isOk: git.ok, detail: git.out, fix: 'winget install Git.Git' },
    {
      name: 'Claude Code',
      isOk: claude.ok,
      detail: claude.ok ? claude.out : `"${config.claudeCommand}" did not run`,
      fix: CLAUDE_INSTALL,
    },
    tracker,
    { name: 'Repo folder', isOk: isRepo, detail: config.repoPath || 'not set', fix: 'Set the repo folder in Settings below' },
    {
      name: `Base ref ${config.baseRef}`,
      isOk: base.ok,
      detail: base.ok ? base.out.slice(0, 10) : 'not found in the repo',
      fix: config.repoPath ? `git -C "${config.repoPath}" fetch origin` : 'Set the repo folder first',
    },
  ]
}
