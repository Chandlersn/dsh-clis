# CLIS · Causal Layered Intelligence System

A resident plugin for DSH (DeepSeek Harness). It **classifies what kind of causal
structure a problem has, then picks a strategy accordingly** — and detects when it
classified wrong, so it can roll back.

This repository contains **two things with different evidence strength**. Please
read them separately:

| | System-level plugin supervision | Causal reasoning library |
|---|---|---|
| What it is | Enumerates every plugin in the host, collects their health probes, and delivers only **structural conclusions** | Four-question causal typing → strategy match → execute → feedback → rollback |
| Evidence | Forced into existence by real use, with reproducible findings | 602 tests + 7 hard constraints verified |
| What those tests prove | It catches real problems | **Engineering rigor — not "more effective than handling it directly"** |

> **The causal reasoning layer has no controlled experiment behind its core claim.**
> The 602 tests prove the implementation matches its spec, not that it is valuable.
> Verify it yourself before relying on it. The supervision layer is a different
> story — it caught problems I did not anticipate (see
> `reports/open-source-readiness.md`).

## Layout

```
packages/clis-contracts/    Shared contracts (types + four questions + service interfaces, no logic)
packages/clis-classifier/   Causal type classifier
packages/clis-strategy/     Strategy matching, path generation/ranking, execution
packages/clis-feedback/     Feedback signals and misjudgement detection
packages/clis-orchestrator/ Orchestration and rollback decisions
packages/clis-plugin/       Plugin entry: agent tools + prompt section + supervision probes
packaging/                  Hand-written installable assets (patch / package.json / icon / README / locale)
docs/                       Frozen specs + plugin packaging standard + install guide
scripts/                    Build (bundle / package), smoke tests, one-shot deploy
tests/                      Cross-package black-box acceptance and end-to-end
reports/                    Verification reports and open-source readiness assessment
```

## Components and hard constraints

The four components cooperate in a fixed order and **depend only on the shared
contracts package** — never on each other's implementation:

| Component | Responsibility | Output |
| --- | --- | --- |
| `clis-classifier` | Causal type judgement only | `CausalClassification` |
| `clis-strategy` | Strategy matching, candidate paths, ranking, execution | `CandidatePath[]` / `ExecutionResult` |
| `clis-feedback` | Feedback signal detection only | `FeedbackSignal` |
| `clis-orchestrator` | Orchestration and rollback decisions | Closed-loop control |

1. **Generation and judgement are separate**: the classifier never scores
   strategies, the strategy never re-classifies, feedback never rolls back by itself.
2. **Rollback is executed by the orchestrator**; feedback only emits signals.
3. **Contracts first**: depend only on `@clis/clis-contracts`.
4. **Confidence ceiling 0.9**; below 0.7 must be flagged as exploration mode.
5. **Rollback limit 3** by default; past it, report "manual intervention required"
   and keep the full trace.
6. **Type lock**: two consecutive rollbacks of the same type lock it for at least one round.
7. **A loop is only a loop across rounds**: one rule firing twice within a single
   round is not recurrence.

## Causal types

- `structural_duality` — A and B hold simultaneously, define each other, no temporal order
- `cyclic` — A→B→A with a delay; may oscillate
- `unidirectional` — A→B, strictly ordered and irreversible
- `nested` — several causal structures coexist; split into submodules
- `unknown` — the four questions cannot decide; enter exploration mode rather than forcing a label

## Boundaries you must know

1. **The classifier is deterministic rule scoring; it does not parse natural
   language.** The caller must fill in the four questions first.
2. **The executor is semi-automatic**: read-only actions pass, write actions are
   blocked by default unless explicitly allowed via `allow_writes`.
3. **Read-only runs do not spin**: when every step of a path is read-only, that is
   not "progress" — the loop returns "authorization required" instead of retrying.
4. **Tight host coupling**: useful only inside DSH; it does not run standalone.

## Plugin layer: four agent tools

`clis_run` (full loop), `clis_classify` (type only), `clis_plan` (paths only),
`clis_probe` (system-level supervision). A system-prompt section is injected as well.

`clis_probe` supervises on two layers. The **automatic layer needs no cooperation
from plugins and covers every non-builtin plugin**; a plugin joins the
**cooperative layer** by exporting `healthProbe` from its module root (for deeper
domain signals). See [docs/PLUGIN-STANDARD.md](docs/PLUGIN-STANDARD.md).

## Stack

- Cordis plugin spec, `@deepseek-ai/cordis@4.0.5` (same version as the host)
- TypeScript 5.9 strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- pnpm workspace, vitest 5

## Commands

```powershell
pnpm install        # install dependencies
pnpm run typecheck  # tsc -p tsconfig.json, expect exit 0
pnpm run test       # vitest run
pnpm run check      # both
```

Build and package:

```powershell
node scripts/bundle.mjs       # esbuild: 5 entries → bundle/ (gitignored)
node scripts/package.mjs      # assemble the installable directory → dist-package/
.\scripts\deploy.ps1          # 7 gates + sync + restart (see -SkipRestart)
```

> `scripts/deploy.ps1` takes every path from parameters or environment variables
> (`DSH_NODE_DIR`, `DSH_PROFILE_DIR`, `DSH_CLIS_PLUGIN_DIR`) — no machine paths are
> hard-coded. A clone can rebuild the installable plugin with no files outside the repo.

## Status

| Item | Value |
| --- | --- |
| Tests | 46 files / 602 cases, all green |
| Type check | `tsc` exit 0 |
| Hard constraints | 7/7 PASS |
| Independent verification | classifier / strategy / feedback reasonably covered; **orchestrator has none** (see `reports/system-verification.md` §4) |

## License

MIT — see [LICENSE](LICENSE).