# @factory/balance — economy balancing sandbox

A standalone, read-only analysis tool for the production graph. It unfolds every recipe down to
raw resources so you can see a good's **true cost** and whether the cost curve grows the way you
intend — _before_ committing content to the game. It never touches the sim and never mutates
prototypes.

By default it reads the real `mods/base/prototypes/*.json`, so it doubles as the authoring
pipeline: the numbers you balance here are the numbers you ship. Point `--data` at an experimental
dir (same JSON shape) to prototype a deep tree without wiring anything into the game.

## Run

```bash
pnpm balance                    # full report over mods/base/prototypes
pnpm balance --data path/to/dir # analyze an experimental data dir
pnpm balance --rate 2           # machine bills at 2 units/sec
pnpm balance --item item.gear   # just one good's machine bill
pnpm balance --mermaid          # also print a Mermaid DAG
```

## What it computes (per item, memoized over a topological order)

- **Raw-cost vector** — the bag of raw (leaf) resources embodied in one unit.
- **Embodied labor** — total machine-seconds across the whole sub-tree per unit.
- **Composite** — a single scalar `Σ raw · weight`; the axis the cost curve is drawn on.
- **Tier** — longest path to a raw leaf; the curve's x-axis.
- **Machine bill** — crafters per step to sustain a target units/sec, shared intermediates rolled up.
- **Machine-tier footprint** — total crafters to sustain a target rate at each machine tier (mk1,
  mk2, …), derived from the distinct `speed`s of the crafters that provide each category. This is
  the "upgrade to go faster" loop made static: mk1 machines can build anything, but the count a
  rate demands is punishing; a faster crafter collapses it. A step whose category has fewer tiers
  reuses its top tier (already maxed).

## Reading the output

- **Cost curve by tier** flags any tier whose median composite, over the previous tier's, leaves
  the intended growth band (`config.tierMultiplier`), plus per-item spikes (`intraTierSpike`).
  That's the "is the economy smoothly escalating?" check.
- **Machine-tier footprint** shows, per terminal good, `mk1 N (1.0×)  mk2 N/2 (2.0×) …` — the
  machine count and its shrink factor versus mk1. A steep collapse means upgrading pays off; a flat
  one means that good barely benefits from faster machines (e.g. it is dominated by a single-tier
  category). Define machine tiers by giving a category crafters at more than one `speed`.
- **Warnings** call out items with more than one producer (pin a canonical one in
  `config.preferredRecipes`) and unknown ingredients.

## Tuning

All knobs live in [`config.ts`](./config.ts): `tickRate`, raw `rawWeights`, the `tierMultiplier`
band, the `intraTierSpike` threshold, and `preferredRecipes`. The cost math is covered by
`tests/model.test.ts` (a hand-checked chain + a real-prototype smoke test).
