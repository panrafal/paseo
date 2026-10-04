# Kilo Code: plan/balance usage + skills discovery

## Context

Kilo (Kilo Code CLI, `kilo acp`) is currently only a generic ACP catalog entry
(`packages/app/src/data/acp-provider-catalog.ts:250-258`, `id: "kilo"`). When added
via the catalog it resolves to `GenericACPAgentClient` server-side
(`packages/server/src/server/agent/provider-registry.ts`) — there is no Kilo-specific
adapter, and none is needed for this work.

Two unrelated things are missing for Kilo, matching what already exists for
neighboring providers (Kimi, Cursor, Codex, Claude):

1. **Plan/balance usage** — the Settings "Usage" screen and the running-agent
   context-window tooltip both read `ProviderUsage[]` from
   `packages/server/src/services/quota-fetcher/manifest.ts`. This is a hardcoded
   fetcher registry (`claude, codex, copilot, cursor, zai, grok, kimi, minimax`) —
   `kilo` is absent, so no card/tooltip section ever renders for it. Nothing else
   gates this: `provider-usage/list.tsx` and `tooltip-section.tsx`
   (`packages/app/src/provider-usage/`) key purely off `providerId` and need no
   changes once the daemon returns a `kilo` entry.
   - **Live token/cost usage** in the running-agent context-window ring
     (`packages/app/src/components/context-window-meter.tsx`) already works for
     Kilo with no change — it comes generically through the ACP `mapACPUsage()`
     path in `packages/server/src/server/agent/providers/acp-agent.ts`.
   - Kilo's cloud API (`https://api.kilo.ai`, from `Kilo-Org/kilocode`
     `packages/kilo-gateway/src/api/profile.ts`) exposes `GET /api/profile/balance`
     (Bearer token, optional `x-kilocode-organizationid` header) returning
     `{ balance: number }` — a USD credit balance, not a %-of-limit window. There is
     no window/limit endpoint yet (tracked upstream as `Kilo-Org/cloud#921`, still
     open), so Kilo reports a single balance, the same shape Cursor's fetcher uses
     for its "Plan usage" balance.
   - The CLI's own OAuth token lives at `~/.local/share/kilo/auth.json`, an
     OpenCode-style auth store: `{ "kilo": { "type": "oauth", "access": "<jwt>",
"refresh": "<jwt>", "expires": <ms> } }`. Read-only: never write it back
     (matches the "usage fetchers are read-only on credentials" rule in
     `docs/providers.md`). If the token is expired the CLI itself refreshes it on
     its own next run; the fetcher just reports unavailable until then.
   - "Gated on Kilo enabled" happens for free: if `auth.json` is missing/has no
     `kilo` entry, `fetchUsage()` returns `unavailableUsage(this)`, exactly like
     every other fetcher — no explicit enable-check needed.

2. **Skills discovery** — `packages/server/src/server/orchestration-skills/internal/paths.ts`
   syncs Paseo's bundled skills unconditionally into exactly three home
   directories: `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`. Kilo
   CLI's own docs (`Kilo-Org/kilocode` `packages/kilo-docs/pages/customize/skills.md`)
   are explicit: global (home-dir) skills live at `~/.kilo/skills/` — singular
   `.kilo`, not `.kilocode` (that name is reserved for project-relative
   compatibility paths). The doc even lists `~/.kilo/skills/`, `~/.agents/skills/`,
   and `~/.claude/skills/` together as the trusted global skill locations Kilo
   scans — Paseo already writes two of those three, just not the Kilo-specific
   one. Fix: add a fourth hardcoded target, `kiloDir`, threaded through the same
   fields/functions that already carry `agentsDir`/`claudeDir`/`codexDir`.

Out of scope: making Kilo a first-class provider (dedicated adapter, provider
manifest entry, icon changes) — none of that is needed for either fix.

## Decisions

- Model the Kilo quota fetcher on `CursorQuotaProvider`
  (`packages/server/src/services/quota-fetcher/providers/cursor.ts`): a single
  `ProviderUsageBalance` (`unit: "usd"`), no windows — because Kilo's API only
  exposes a balance today, not a limit/window.
- Read the OAuth access token straight from `~/.local/share/kilo/auth.json`
  (`{"kilo": {"access": "..."}}`), with an env override
  (`KILOCODE_API_KEY`/`KILO_API_KEY`, matching the CLI's own env-override names
  documented in `docs/code-with-ai/platforms/cli`) checked first, same pattern as
  `KimiQuotaProvider`/`CursorQuotaProvider`.
- Add `kiloDir` as a fourth named field everywhere `agentsDir`/`claudeDir`/`codexDir`
  are threaded (not an array) — matches the existing style in `operations.ts`,
  `sync.ts`, `transaction.ts`, and keeps every call site's diff mechanical and
  reviewable.
- No app-side changes for either fix: `provider-usage/*` and `agent-skills/*` are
  already provider-agnostic and pick up the new data automatically.

## Steps

- [x] 1. Add the Kilo quota fetcher — files:
     `packages/server/src/services/quota-fetcher/providers/kilo.ts` (new, modeled on
     `cursor.ts`: read token from `~/.local/share/kilo/auth.json` → `kilo.access`,
     fall back to `KILOCODE_API_KEY`/`KILO_API_KEY` env vars, call
     `GET https://api.kilo.ai/api/profile/balance` with `Authorization: Bearer
<token>`, map `{ balance }` to one `ProviderUsageBalance` with `unit: "usd"`,
     `used: null`, `remaining: balance`, `limit: null`, `tone:
balanceToneFromRemaining(balance)`), plus a collocated
     `kilo.test.ts` (mirror `service.test.ts`'s per-provider fixture pattern: token
     present + balance parses; token missing → unavailable; API error → unavailable).
     Register it: `packages/server/src/services/quota-fetcher/manifest.ts` (import +
     new `{ providerId: "kilo", create: ... }` entry). — verify: `npx vitest run
packages/server/src/services/quota-fetcher/providers/kilo.test.ts --bail=1`

- [x] 2. Add the `kiloDir` skills target — files:
     `packages/server/src/server/orchestration-skills/internal/paths.ts` (add
     `kiloDir: path.join(home, ".kilo", "skills")` to `resolveSkillTargets()`),
     `internal/operations.ts` (`SkillTargets` interface; thread `kiloDir` through
     `getSkillsStatus`'s `hashSkills`/`disks` array, `applySkills`'s `syncSkills`/
     `removeSkill` calls, and `uninstallSkills`'s `removeSkill` calls),
     `internal/sync.ts` (`SkillSyncOptions`, `RemoveSkillTargets` interfaces;
     `syncSkills()`'s per-target `syncDirectoryFiles` call; `removeSkill()`'s `paths`
     array), `internal/transaction.ts` (the three `[targets.agentsDir,
targets.claudeDir, targets.codexDir]` root arrays at lines ~137, ~446, ~496 —
     add `targets.kiloDir`). — verify: typecheck only for this step (tests updated
     next).

- [x] 3. Update existing skills tests for the new target — files:
     `internal/paths.test.ts`, `internal/operations.test.ts`, `internal/sync.test.ts`,
     `internal/controller.test.ts` — add `kiloDir`/`.kilocode/skills` fixture wiring
     everywhere the existing three dirs are set up or asserted (mechanical:
     every `agentsDir`/`claudeDir`/`codexDir` triple in a test target/sandbox object
     or array gets a fourth `kiloDir` member; assertions that check "installed in
     every target" or "removed from every target" gain a fourth check). — verify:
     `npx vitest run packages/server/src/server/orchestration-skills/internal/paths.test.ts packages/server/src/server/orchestration-skills/internal/operations.test.ts packages/server/src/server/orchestration-skills/internal/sync.test.ts packages/server/src/server/orchestration-skills/internal/controller.test.ts --bail=1`

- [x] 4. Docs — file: `docs/providers.md` — add `.kilocode/skills` alongside the
     existing `.claude/skills`/`.codex/skills` mention (grep for where those two are
     named) and confirm the "Provider Usage Fetchers" section still matches the
     manifest (it needs no rewrite, just check the fetcher list is not hardcoded
     there).

## Verification

- `npm run typecheck` (root) — must be clean.
- `npm run format` before committing.
- Targeted vitest runs from steps 1 and 3 above green.
- Manual: with a real `~/.local/share/kilo/auth.json` present (already the case on
  this box), start the daemon and confirm the Settings → Usage screen shows a
  "Kilo" card with a balance, and that a running Kilo agent's context-window
  tooltip shows the same balance in its plan-usage section.
- Manual: run the orchestration-skills sync (however it's triggered today —
  check `agent-skills` screen "install"/"update") and confirm
  `~/.kilo/skills/<name>/SKILL.md` files appear and match the bundle.

## Open questions

- Kilo's balance endpoint has no organization support surfaced through the CLI's
  own token scope that we can read locally — if a Kilo user is on a team/org
  plan, `balance` may reflect personal balance only. Acceptable for v1; note this
  as a known gap in the fetcher's file comment rather than guessing at
  `x-kilocode-organizationid` sourcing. Does not block any step.
