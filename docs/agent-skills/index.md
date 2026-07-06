# Drive sluice from an AI agent

> sluice ships task-scoped agent skills — plain-markdown playbooks that let Claude Code, Cursor, or any skill-aware assistant run a migration, verify a sync, or operate a backup chain on your behalf, inside the same safety gate.

sluice ships a set of agent skills: task-scoped operator playbooks that let an AI coding agent — Claude Code, Cursor, or anything that follows the open agent-skills convention — drive the sluice CLI for one concrete job. Each skill is a plain SKILL.md file: no plugins, nothing agent-specific, versioned in the source repo alongside the CLI it drives. They live under skills/ in the repository.

## Why sluice ships them

sluice already exposes a machine-readable surface built for assistants: an AGENTS.md command taxonomy, an llms.txt docs index, per-command --format json envelopes, stable SLUICE-E-* error codes, and a documented exit taxonomy. A skill sits on top of that surface. It does not re-document the CLI — it references those canonical sources and encodes the decision tree for a single task: what to run, how to read the result back, what to report, and where a human must approve before anything changes. One skill, one task, one go/no-go.

## The catalog

Nine skills ship today, in two tiers.

### Tier 1 — the core loop

Skill · Use it to · Writes? ·

migrate-preflight · Assess a migrate or sync before running it → a go/no-go with the risks named. · read-only ·

fidelity-verify · Confirm a completed migrate / sync / restore is faithful → a fidelity report. · read-only ·

sluice-error-triage · Turn a SLUICE-E-* code + exit code into a root cause and a recovery path. · read-only ·

backup-chain-operator · Plan and operate an encrypted backup chain (full → incremental → compact → prune → restore-test). · gated ·

### Tier 2 — operational + engine-specific

Skill · Use it to · Writes? ·

cdc-sync-operator · Stand up and operate continuous sync (cold-start → CDC → cutover). · gated ·

planetscale-migration · Migrate or sync against PlanetScale / Vitess (VStream, reparent, ownership, metrics-watch). · gated ·

fleet-operator · Operate a sync run fleet — many syncs in one process. · gated ·

redaction-setup · Configure and verify PII redaction during migrate / sync. · gated ·

sqlite-d1-import · Import SQLite / Cloudflare D1 (--stage-local, --infer-types, big-int / CPU gotchas). · gated ·

## The safety gate

Every skill honors sluice's command taxonomy — the same gate a careful human operator uses:

- Read-only commands (--dry-run, verify, schema preview / diff, sync health / status, backup verify, engines) run freely.

- State-changing commands (migrate, sync start / run, backup *, restore, cutover) run only as part of an approved task.

- Destructive flags (--reset-target-data, --force-cold-start, --yes, backup prune / compact without --dry-run) are never passed without explicit human approval for that specific invocation.

Every skill also follows sluice's own discipline: verify by reading state back, never trust an exit code alone, and treat status:"refused" / exit 3 as a decision point — surface error.hint and wait, don't retry the command unchanged.

## Getting started

- Install the CLI. You need the sluice binary — brew install sluicesync/tap/sluice, go install sluicesync.dev/sluice/cmd/sluice@latest, or the ghcr.io/sluicesync/sluice container (see Getting started).

- Install the skills. Run the setup script from a checkout of the repo — it detects the agents present and installs each SKILL.md into the right place:

    ./skills/install.sh

  For Claude Code that is ~/.claude/skills/<name>/SKILL.md (personal, all projects) or .claude/skills/<name>/SKILL.md (checked into a project); Cursor and others have equivalents. Because the skills are just markdown, you can also copy the directories by hand.

- Describe the task in natural language. The matching skill's trigger loads it automatically — "migrate this Postgres DB to PlanetScale" pulls in migrate-preflight; "why did this restore fail?" pulls in sluice-error-triage — or invoke one explicitly (/migrate-preflight).

- Review the go/no-go. The skill drives the CLI on your behalf and returns a go/no-go, a report, or a gated action — and stops at the safety gate for your approval before anything writes.

## Learn more

- skills/ in the repository — every SKILL.md, the catalog, and install.sh.

- llms.txt and llms-full.txt — the AI-assistant docs index the skills point at.

- AGENTS.md — the command taxonomy, standard workflow, JSON-envelope shape, and env-first credentials that the safety gate is built on.

---
Canonical page: https://sluicesync.com/docs/agent-skills/ · Full docs index: https://sluicesync.com/llms.txt
