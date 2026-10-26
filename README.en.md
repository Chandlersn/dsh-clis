# CLIS · Causal Layered Intelligence System

[中文](README.md) | English

A DSH (DeepSeek Harness) plugin that does two things:

**One: it intervenes when problems and feedback show up.** It does not change
what the agent set out to do. When failures start repeating (same tool failing
≥2 times), CLIS injects a structural-judgement hint before the result reaches
the model — this failure pattern may not be a one-off but a loop (fixes bounce
back), a duality (fixing one side pulls the other), or a one-way chain (trace
the earliest cause instead of pushing at the effect). Misjudge the direction
and the effort is wasted. Four gates keep the intervention from being noise:
failures only, windowed counting, cooldown + dedup, silent budget. **And its
usefulness is measurable**: `clis_metrics` reports how many hints were injected
and how many the agent adopted.

**Two: it makes every plugin in the host visible to the rest.** It enumerates
all host plugins, collects their health probes, and merges scattered warnings
into structural conclusions ("these 5 warnings are facets of one feedback loop;
fixing them one by one will fail"). The automatic layer covers every non-builtin
plugin with zero cooperation; any plugin can adopt a deeper domain signal by
exporting one `healthProbe`.

Honest disclosure: the causal classifier is **deterministic rule scoring** (the
caller fills in four questions first), not semantic understanding. The strategy
paths and attribution claims have **no controlled experiment behind them** —
the tests prove engineering rigor, not "more effective than handling it
directly". The supervision and intervention layers have real-machine evidence.
See [reports/open-source-readiness.md](reports/open-source-readiness.md).

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

## Plugin layer: five agent tools

| Tool | What it does |
| --- | --- |
| `clis_run` | Full loop: classify → match path → execute → feedback → roll back if needed |
| `clis_classify` | Causal type only |
| `clis_plan` | Candidate paths only |
| `clis_probe` | System-level supervision: enumerate plugins, collect probes, deliver structural diagnoses |
| `clis_metrics` | Intervention effectiveness: hints injected vs adopted by the agent |

A system-prompt section is injected as well (passive reminder), and a
structural-judgement hint is **actively injected** when tool failures repeat
(see the first item up top).

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
| Tests | 49 files / 692 cases, all green |
| Type check | `tsc` exit 0 |
| Hard constraints | 7/7 PASS |
| Independent verification | All four components covered — an independent reviewer wrote 60 assertions for the orchestrator reading only the spec, **found no implementation-vs-spec violations**, but 7 spec/contract issues (2 contract defects fixed) |

## License

MIT — see [LICENSE](LICENSE).