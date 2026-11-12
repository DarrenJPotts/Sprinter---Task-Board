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
      fix: 'npm install -g @anthropic-ai/claude-code',
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
