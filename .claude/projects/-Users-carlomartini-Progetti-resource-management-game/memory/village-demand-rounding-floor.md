---
name: village-demand-rounding-floor
description: M7 — village demand ratePerMin now honoured exactly (was a 60/min rounding floor); two related blockers remain
metadata:
  type: project
---

**FIXED 2026-07-04.** Previously `villageDemandNeed` rounded `ratePerMin * 60 / 3600` to `max(1, …)`, so every authored rate below ~30/min collapsed to a **1-per-cadence = 60/min floor** — rocket_fuel 20, avionics 6, aircraft 2, rocket 1 all ate 60/min, flattening the ladder. Fix: `VillageDemand` now carries `ratePerMin` (not a pre-rounded `need`), and `updateVillages` in mods/base/scripts/sim.ts keeps a per-village fractional accumulator (`demandAcc`, unit·ticks, sized `MAX_VILLAGE_DEMANDS`) that accrues `ratePerMin * VILLAGE_CADENCE` per cadence and owes one unit per `VILLAGE_TICKS_PER_MIN`. Accumulators reset on stage change and are serialized in the village snapshot. A demand with an empty buffer counts as unmet every cadence (not just on due-cadences) so a starved village still declines. HUD `VillageDemandStatus.need`→`ratePerMin`. Tests in apps/headless/tests/village.test.ts assert 20/min→20 and 6/min→6 per minute; gate + `pnpm headless 99 750` (twice, matching) green.

**Two related M7 blockers still open** (found the same day):

1. The village ladder is **cumulative** — growth past level 2 needs multiple deep chains (rocket_fuel + avionics + …) supplied simultaneously, not one.
2. Multi-output routing (e.g. distillation → naphtha+kerosene) — **DONE 2026-07-04, sim + UI**: belt ports carry a colour filter (whitelist/blacklist, up to `MAX_PORT_FILTER` colours) via a `set_port_filter` command; an output port drains only admitted colours, an input port ingests only admitted items. Sim: `mods/base/scripts/sim.ts` (`filterMode`/`filterColor` on the belt grid, `firstDrainableForPort`, `portFilterPasses`), tests in `apps/headless/tests/port-filter.test.ts`. UI: pin a port → the right sidebar shows a filter editor (`apps/game/src/FilterPanel.tsx` + `filterStore.ts`, wired in `placement.ts` alongside the recipe picker; `allResources()` in `resources.ts` lists items). **Still TODO only** if the headless playbook is ever to feed the village end-to-end: its 1:1 BFS `Router` can't merge/fan-out.
