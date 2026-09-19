# Installed agent skill: `typesafe-ai`

This repository vendors the official TypeSafe agent skill so that any coding
agent working in this checkout (DSH, Claude Code, Codex, …) can use it without
network installation.

## What is installed and where

```
.agents/skills/typesafe-ai/SKILL.md   # byte-identical upstream file
.agents/skills/typesafe-ai/LICENSE    # upstream MIT license
```

| Property | Value |
|---|---|
| Source repository | <https://github.com/typesafe-ai/skills> |
| Source path | `skills/typesafe-ai/SKILL.md` |
| Pinned commit | `65a39f393687675ce170e6094757de20370365b9` (Release v0.5.7, 2026-09-12) |
| `SKILL.md` SHA-256 | `71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52` |
| `LICENSE` SHA-256 | `835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02` |
| License | MIT, Copyright (c) 2026 TypeSafe AI |

## Why it is discovered with no extra DSH configuration

DSH's `@deepseek-ai/dsh-skill-filesystem` scans, in rank order:

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

The project root is the nearest ancestor containing `.git`, which is this
repository root. The standard `@deepseek-ai/dsh-base` bundle mounts
`@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-skill-filesystem`, and
`@deepseek-ai/dsh-tool-skill`, so a default profile already surfaces the skill
in the session catalog — no row, path, or config change is required.

The file is a valid DSH skill: `name: typesafe-ai` is kebab-case, `description`
is present, and the extra `license` frontmatter key is ignored by the parser
(verified in `skill-filesystem/src/index.ts`, `parseSkillFile`).

## How this connects to dsh-jev skill routing

When the plugin's `skills.enabled` is true, the pre-step adapter:

1. calls `ctx.skills.list({ scope: agent })` and keeps model-invocable skills;
2. sends only **metadata** (name, description, optional `whenToUse`, capped) to
   Jev through `routeSkills()` — the skill body never leaves the process;
3. in `enforce` mode injects one bounded one-line hint per turn
   (`Skill routing suggestion: "typesafe-ai" — …`) through `agent.inject`;
4. leaves loading the actual body to the normal skill mechanism
   (`dsh-tool-skill`), so the full instructions enter context only when the
   model decides they help.

The upstream `SKILL.md` carries no `whenToUse` key; routing therefore uses the
description text. See `docs/roadmap.md` for the optional routing-hint overlay.

## Updating the vendored skill

Update deliberately, pinned to a released commit:

```sh
PIN=<new-commit-sha>
curl -fsSL "https://raw.githubusercontent.com/typesafe-ai/skills/$PIN/skills/typesafe-ai/SKILL.md" \
  -o .agents/skills/typesafe-ai/SKILL.md
curl -fsSL "https://raw.githubusercontent.com/typesafe-ai/skills/$PIN/skills/typesafe-ai/LICENSE" \
  -o .agents/skills/typesafe-ai/LICENSE
shasum -a 256 .agents/skills/typesafe-ai/SKILL.md .agents/skills/typesafe-ai/LICENSE
```

Then update the pinned commit and both hashes in this file, and run
`pnpm verify` (the integration test fails if the skill disappears or its
metadata stops being routable).

Never edit the vendored file locally. Project-specific guidance belongs in
this repository's own docs, not in an upstream artifact that has to be
diffable against its source.

## Global alternative

To make the skill available to every project on a machine instead of one
repository, install it into a user root that DSH scans:

```sh
mkdir -p ~/.agents/skills/typesafe-ai
cp .agents/skills/typesafe-ai/SKILL.md ~/.agents/skills/typesafe-ai/
```

This is deliberately not done by the repository: machine-level state is not
reproducible from a checkout.
