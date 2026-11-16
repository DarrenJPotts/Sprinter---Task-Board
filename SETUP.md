# Setting up Sprinter

Sprinter shows your sprint as a kanban board and gives every ticket its own Claude Code terminal, in its own
git worktree. This guide takes a new machine from nothing to a working board. The app walks you through the
same steps on its first run, checking each tool as you go.

## 1. Install Sprinter

Download the latest Windows build from
[Releases](https://github.com/DarrenJPotts/Sprinter---Task-Board/releases):

- `Sprinter-Setup-<version>.exe` installs it for your user, with a Start menu entry.
- `Sprinter-<version>-portable.exe` runs without installing.

The builds are not code-signed, so Windows SmartScreen says "Windows protected your PC" the first time. Choose
**More info → Run anyway**.

Closing the window hides Sprinter to the tray, so terminals keep running. **Quit** in the tray menu ends it.

To run from source instead, see [Run from source](README.md#run-from-source).

## 2. Install the tools it drives

Sprinter brings its own server, but not the tools it runs for you.

| Tool | Needed for | Install (Windows) |
|---|---|---|
| git | worktrees, every project | `winget install Git.Git` |
| Claude Code | every ticket terminal | `irm https://claude.ai/install.ps1 \| iex` |
| Azure CLI | Azure DevOps boards | `winget install Microsoft.AzureCLI` |
| GitHub CLI | GitHub boards (or use a token) | `winget install GitHub.cli` |

On macOS or Linux, install Claude Code with `curl -fsSL https://claude.ai/install.sh | bash`, and the rest from
their own sites.

## 3. Sign in

- **Claude Code:** open a terminal, run `claude` once and follow its sign-in. Every ticket terminal uses that
  account.
- **Azure DevOps:** `az login --tenant <your-tenant-id>`, using the tenant your Azure DevOps organisation is in.
- **GitHub:** `gh auth login`, or set a `GH_TOKEN` environment variable before starting Sprinter.

## 4. Add your first project

One project is one repo and its tracker. The first-run screen asks for:

| Field | What to put |
|---|---|
| Name | Anything; it shows in the project switcher |
| Repo folder | Your local clone of the repo |
| Worktrees cut from | The branch each ticket's worktree starts from, usually `origin/main` |
| Tracker | GitHub (owner/name, and a Projects number if you use one) or Azure DevOps (organisation, project, team, tenant) |
| Workflow | Auto uses AI-DLC stage commands when the repo has `ai-dlc.json`; Plain sends one command per card |

**⚙ Setup** in the toolbar checks the project at any time: git, Claude Code, the tracker sign-in, the repo
folder and the base branch, each with the command that fixes it.

## 5. Optional: let a chat start ticket sessions

Copy [`skills/sprinter/SKILL.md`](skills/sprinter/SKILL.md) to `~/.claude/skills/sprinter/SKILL.md`. Then a
chat running inside Sprinter, such as a Mission Control pin, can list each ticket's next command and start
several ticket sessions at once. It shows you the list and waits for your yes first, since every session is a
Claude run of its own.

## Where Sprinter keeps things

| What | Where |
|---|---|
| App settings and projects | `~/.sprinter/` |
| A project's board, saved screens and worktrees | its data folder, under `~/.sprinter/projects/<id>/` |
| Claude's conversations | Claude Code's own `~/.claude/projects/` |

Removing Sprinter leaves your repos, worktrees and Claude conversations where they are.
