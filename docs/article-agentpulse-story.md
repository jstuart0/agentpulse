# From "Which Tab Is Doing What?" to a Command Center for AI Agents

## The problem that started it all

I run a lot of AI coding agents. Claude Code in one tab refactoring authentication. Codex CLI in another writing tests. A third agent debugging a deployment issue. A fourth doing research on a library migration.

And I never know what any of them are doing.

I'd flip between terminal tabs trying to remember -- was it this one working on the auth bug, or the other one? Did that long-running refactor finish? Is the test agent stuck or still going? I'd lose track, lose context, and waste time just figuring out which tab was which.

There was nothing out there that solved this cleanly. A few minimal tools existed -- file-based status trackers, basic Express dashboards -- but nothing that supported both Claude Code and Codex, nothing with a real UI, and nothing that worked the way I actually work: many agents, many projects, many terminal tabs, all at once.

So I built AgentPulse.

## What AgentPulse started as

The original idea was simple: a live dashboard where every agent session checks in automatically. You start Claude Code or Codex in a terminal tab, and it shows up on the dashboard within seconds. Each session gets a random memorable name -- `bold-falcon`, `zen-owl`, `warm-crane` -- so you can match the dashboard to your terminal tabs at a glance.

Click a session and you see a scrollable chat history of everything you've said to that agent. Your prompts show as blue bubbles, in order, with timestamps. No tool call noise, no internal events -- just what you actually told each agent to do.

The technical approach: Claude Code and Codex both have hook systems that fire HTTP events on session lifecycle events (start, stop, tool use, prompt submission). AgentPulse receives these events, stores them, and pushes updates to the dashboard in real time via WebSocket.

I added notes per session so I could jot down context. A CLAUDE.md / AGENTS.md editor so I could view and tweak agent instructions right from the dashboard. Pin sessions to keep important ones at the top. Archive or delete completed ones. Search across all sessions by project, name, or task. The dashboard auto-groups sessions by project when you have enough of them.

It was exactly what I needed: visibility into what all my agents are doing, from one place.

## The conversation that changed everything

I was showing AgentPulse to a friend and he said something like: "Cool, so you can see what they're doing. But can you tell them what to do from here?"

I hadn't thought about it that way. AgentPulse was an observer -- it watched sessions, it didn't create or control them. But the more I thought about it, the more obvious it became. If I can see all my agents in one dashboard, why can't I launch new ones from there? Why can't I send a prompt to a running session? Why can't I stop one that's gone off the rails?

The observability layer already had all the infrastructure: session tracking, event ingestion, WebSocket real-time updates, API key auth. Adding orchestration on top of that wasn't starting from scratch -- it was extending what was already there.

So I built it.

## AgentPulse as an orchestration platform

The orchestration layer adds three major capabilities:

**Session templates.** Define reusable session configurations -- which agent to use, which directory to work in, what instructions to give, what model and approval policy to set. Save them, favorite them, duplicate them. When you want to launch a task, pick a template instead of remembering all the flags.

**Supervisors.** A lightweight local process that claims launch requests from the AgentPulse server and executes them. It knows how to start Claude Code sessions (headless or interactive), manage their lifecycle, report progress back to the dashboard, and handle retries. The supervisor runs on the same machine as the agents -- it's the bridge between the dashboard's intent and the terminal's reality.

**Managed sessions.** Once a session is launched through AgentPulse, it becomes a managed session. The dashboard shows its launch status, links it to the template that created it, tracks whether the agent is still working, and lets you send follow-up prompts or stop it cleanly.

The key architectural decision: orchestration is optional. You can run AgentPulse as observability-only (hooks + dashboard, no supervisor) and it's still the best way to track your agent sessions. Or you can enable the full control plane and launch, manage, and monitor agents from one unified interface.

## The relay: remote control across machines

Here's where it gets interesting.

Claude Code and Codex block HTTP hooks to non-localhost IPs. It's a security measure -- agents will only phone home to `localhost`. This means the AgentPulse server has to be reachable on `localhost` for hooks to work.

For a single machine, that's easy -- run AgentPulse locally. But I wanted to access the dashboard from my phone. From my iPad when I'm away from my desk. From a different machine entirely.

The solution: a relay. It's a tiny Bun script that runs on `localhost`, receives hook events from agents, and forwards them to a remote AgentPulse server (in my case, running on my Kubernetes cluster). The agents think they're talking to `localhost`. The relay silently forwards everything to the real server.

One command sets it up:

```bash
curl -sSL https://your-server.com/setup-relay.sh | bash -s -- --key ap_YOUR_KEY
```

It installs the relay, creates a LaunchAgent (macOS) or systemd service (Linux) so it auto-starts on login, configures all the hooks for both Claude Code and Codex, and sends a test event to verify connectivity. Takes about 10 seconds.

And here's the part I didn't fully appreciate until I set it up: **the relay works from any machine.** Install it on your MacBook, your Linux build server, a cloud VM -- every agent session across all your machines shows up in one dashboard. One place to see everything. One place to control everything.

I can be at dinner, pull up the AgentPulse dashboard on my phone, and see that the refactoring agent I kicked off two hours ago finished successfully. Or that the test agent hit an error and needs attention. Or that three agents are still working across two different machines. All from one URL.

## What it is now

AgentPulse started as a "which tab is doing what?" answer and became a platform. Today it has:

**Observability:**
- Live session monitoring with random memorable names
- Chat-style prompt history per session
- Working indicator (pulsing badge when an agent is actively processing)
- Git branch detection, project grouping, search
- Browser notifications when agents finish
- CLAUDE.md / AGENTS.md viewer and editor (synced via relay)
- Session notes with auto-save
- Export sessions as markdown

**Orchestration:**
- Session templates with launch preview
- Local supervisor for headless and interactive agent launches
- Managed session lifecycle tracking
- Prompt delivery to running sessions
- Host routing for multi-machine setups

**Infrastructure:**
- One-command install (Bun + SQLite, or Docker)
- Relay for remote dashboard access across machines
- LaunchAgent / systemd auto-start
- Kubernetes deployment with Authentik SSO
- Anonymous telemetry (opt-out)
- MIT licensed, open source

You can run it as just an observer. Or as a full command center. Your call.

## The philosophy

The way I think about it: AI coding agents are becoming a fleet. Not one agent doing one thing, but many agents working in parallel across different projects, different machines, different contexts. And managing a fleet requires visibility and control from a single pane.

That's what AgentPulse is. A command center for AI coding agents across all your machines.

It's open source at [github.com/jstuart0/agentpulse](https://github.com/jstuart0/agentpulse).

---

*Built by Jay Stuart. Started as a weekend project to solve my own terminal tab chaos. Became something bigger.*
