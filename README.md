# Sprinter

A kanban over your tracker (Azure DevOps or GitHub), with a Claude Code terminal per ticket beside it. One install, any number of projects, everything on your own machine.

## What it does

- **Board:** your tickets in the tracker's own columns, read over the tracker's API. It costs no tokens and refreshes every five minutes. Hide a column with ⋯; it moves to *Hidden groups*.
- **Plan:** Today / This week / Next week / Parked. Drag cards between them; moves and ★ stars are saved.
- **Terminals:** click a card to open its tab. **▶ Claude** starts Claude Code in the ticket's own git worktree with the card's next command. Later opens resume the same conversation, so each ticket keeps its context.
- **Split and full screen:** drag a tab onto any edge of a pane to split it, or onto its middle to move it. **⤢** makes a pane fill the window.
- **Pinned chats:** standing Claude chats in the toolbar. *Fresh run* starts a new conversation with its prompt each press; *Keep chat* reopens the same one.
- **Needs you:** every Claude asking you something or done with its turn, plus PRs with review threads, in one list.
- **Reviews:** other people's open PRs, driven through a Reviewer pin that drafts reviews and posts only when you say so.
- **Tokens:** today's and each ticket's token use, read from Claude Code's own transcripts.
- **Tour:** **? Tour** walks through the page, pointing at each control.

## Projects

Each project is one repo plus its tracker. Switch with the 📁 button beside the title; **＋ New project** adds one.

| Tracker | Board | Sprint | Sign-in |
|---|---|---|---|
| Azure DevOps | The team board's columns; your stories and bugs | The team's current iteration | `az login --tenant <tenant>` |
| GitHub | A Project (v2): its Status options as columns. Without one: Todo / In Progress / Done from your issues | The Project's current iteration, if it has one | `gh auth login` (or `GH_TOKEN`) |

**Workflow** decides what a card's ▶ Claude runs:

- *AI-DLC* is picked automatically when the repo has `ai-dlc.json`. It uses the AI-DLC stage commands and flags stage tasks that lag the board. If a planner writes `.aidlc/notes/sprint-plan-<sprint>.json`, its order and notes show on the cards; without it the board orders cards itself.
- *Plain* sends one command template per card, `Work on #{id}: {title}` by default.

## Run it

```bash
npm install
npm start       # http://localhost:7430 (run npm run build first)
npm run app     # the desktop app: builds the UI and opens it in its own window
npm run dev     # development: the UI on http://localhost:5173 against the server on 7430
```

Needs Node 20+, git, Claude Code (`claude`) on your PATH, and the sign-in for your tracker (above).

The desktop app hides to the tray when you close its window, so terminals keep running; **Quit** in the tray menu ends it.

## Settings

Everything is edited in ⚙ Setup and saved under `~/.sprinter`:

| File | What it holds |
|---|---|
| `~/.sprinter/app.json` | The port and the project open last |
| `~/.sprinter/projects/<id>/project.json` | The project's name, repo folder, base ref, tracker, workflow, card command, sync-tasks command, focus hours a day, shell, Claude command and pins |
| `<data folder>/state.json` | Your moves, stars, each ticket's Claude session id and the last board |
| `<data folder>/scrollback/<key>.log` | Each terminal's saved screen |
| `<data folder>/worktrees/<id>` | Each ticket's git worktree, removed with 🧹 when you're done |

Azure DevOps works with any process template (Agile, Scrum, CMMI, Basic); the area path is optional. A **sync-tasks command** (for example one that closes finished stage tasks) adds a ⟲ button to tickets whose tasks lag their column. **Focus hours a day** (6 by default) sets the load bar.

A project's data folder is `~/.sprinter/projects/<id>` unless it was migrated from an older setup.

## What survives a restart

- **Claude conversations:** **⟳ Resume chat** reopens a ticket's or pin's conversation without sending anything; **▶ Claude** resumes it with the card's command.
- **Screens:** a stopped terminal's tab shows its last screen, read-only, until you resume it.
- **Running terminals do not survive:** they live inside the server, so stopping it ends them. Use `npm start` or the desktop app rather than `npm run dev`, whose watch mode restarts the server on every code change.

## Safety

The server listens on 127.0.0.1 only. It refuses changes from any other website, and a terminal socket accepts pages served from this machine only. A terminal runs commands as you, and Claude Code's own permission prompts still apply inside it. Nothing here merges or approves anything.
