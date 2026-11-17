---
name: sprinter
description: Start ticket sessions in the Sprinter app from a chat running inside it, e.g. "kick off all dev spec sessions", "start sessions for 123 and 456", or "what would each ticket run next?". Each session opens in its own Sprinter terminal and worktree with the ticket's next command. Uses the app's local API ($HQ_URL).
---

# Sprinter: start ticket sessions from a chat

Sprinter runs each ticket's Claude session in a terminal of its own. Its local server lets a chat running
inside Sprinter (such as Mission Control) list what each ticket would run next, and start several of
those sessions at once. The app opens a tab for each one it starts.

## Where the API is

- `HQ_URL`: the server, e.g. `http://127.0.0.1:7430`. Every Sprinter terminal has it set.
- `HQ_PROJECT`: the Sprinter project this terminal belongs to. Send it as the `x-hq-project` header.

If `HQ_URL` is empty, this chat is not running inside Sprinter. Try `http://127.0.0.1:7430` (leave the header
out to use the app's active project), and if nothing answers, tell the user Sprinter is not running.

## 1. List what each ticket would run next

```bash
curl -s "$HQ_URL/api/next" -H "x-hq-project: $HQ_PROJECT"
```

The answer is a list of tickets still in play. Each has `id`, `title`, `column`, `stage`, `command`, `isRunning`,
`hasConversation` and `isOffSprint`. `command` is exactly what the ticket's ▶ Claude button would send.
`hasConversation` means the ticket has a Claude conversation from before that can be reopened.

## 2. Pick the tickets the user means

- Match on the command's name, exactly: "dev spec sessions" means `command` starting with `/dev-spec ` (with the
  space), not `/dev-spec-finish` or `/dev-spec-revise`. "Implementation sessions" means `/dev-implement `, and so on.
- Leave out tickets with `isRunning: true`: their session is already going. Say which ones.
- Leave out `isOffSprint: true` tickets unless the user asks for them.
- If the user named tickets, use those, each with its own next command unless they gave one.
- "Resume", "reopen" or "bring back" sessions (for example after Sprinter restarted) means tickets with
  `hasConversation: true` and `isRunning: false`, started with `resume` (below), so nothing new is sent.

## 3. Show the list, then start on a yes

Each session is a separate Claude run that spends tokens, so show the tickets first, as a table of id, title,
column and command, and wait for the user's yes. Skip the question only when the user named the exact tickets.
Nothing matching is an answer too: say so, and say what those tickets would run instead.

```bash
curl -s -X POST "$HQ_URL/api/sessions/start" \
  -H "x-hq-project: $HQ_PROJECT" -H "content-type: application/json" \
  -d '{"items":[{"id":53417},{"id":56942,"command":"/dev-spec 56942"}]}'
```

- `command` is optional: without it the ticket's own next command runs.
- `"resume": true` reopens the ticket's conversation where it left off and sends nothing, like ⟳ Resume chat
  (`command` is ignored). A ticket with no conversation is skipped. Resuming costs no tokens until someone types
  in it, so the yes in step 3 isn't needed when the user asked to resume.
- Every start of a ticket with a conversation, with `resume` or not, continues that same conversation: a command
  goes in as its next turn.
- At most 12 per call. For more, ask whether to start them in batches.
- The answer lists `started` and `skipped` (with why). Report both, briefly.

The app adds a tab for each started session behind the one on show, grouped under its stage. Each session runs
on its own from here, so don't wait on it or try to drive it from this chat. The user follows it in its tab,
and Sprinter's **Needs you** shows any session that stops to ask something.
