/**
 * Balance analysis CLI. Loads a prototype data dir, builds the cost model, and prints the report.
 *
 * Usage:
 *   pnpm balance                         # analyze mods/base/prototypes
 *   pnpm balance --data <dir>            # analyze an experimental data dir
 *   pnpm balance --rate 2                # machine bills at 2 units/sec (default 1)
 *   pnpm balance --item item.gear        # only the machine bill for one good
 *   pnpm balance --mermaid               # also dump a Mermaid DAG
 *
 * This tool is READ-ONLY and game-agnostic: it never mutates prototypes or touches the sim.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defaultConfig } from './config.ts'
import { loadDataset } from './load.ts'
import { buildModel, machineBill } from './model.ts'
import { billTable, footprintTable, itemTable, mermaid, tierTable } from './report.ts'
import { tierFootprint, type MachineStep } from './model.ts'

interface Args {
  data: string
  rate: number
  item: string | undefined
  mermaid: boolean
}

function parseArgs(argv: readonly string[], defaultData: string): Args {
  const args: Args = { data: defaultData, rate: 1, item: undefined, mermaid: false }
  // Resolve --data against the dir the user actually invoked from. Under `pnpm --filter` the
  // process cwd is this package (apps/balance), so a bare `resolve()` would mangle repo-root
  // paths; pnpm exposes the real invocation dir as INIT_CWD.
  const invokeDir = process.env.INIT_CWD ?? process.cwd()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--mermaid') args.mermaid = true
    else if (flag === '--data') args.data = resolve(invokeDir, argv[++i] ?? args.data)
    else if (flag === '--item') args.item = argv[++i]
    else if (flag === '--rate') {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n > 0) args.rate = n
    }
  }
  return args
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const defaultData = resolve(here, '../../mods/base/prototypes')
  const args = parseArgs(process.argv.slice(2), defaultData)

  const data = loadDataset(args.data)
  const model = buildModel(data, defaultConfig)

  console.log(`=== balance report ===`)
  console.log(`data      ${args.data}`)
  console.log(
    `items     ${data.items.size}   recipes ${data.recipes.length}   crafters ${data.crafters.length}\n`,
  )

  if (args.item) {
    const cost = model.costs.get(args.item)
    if (!cost) {
      console.error(`unknown item "${args.item}"`)
      process.exitCode = 1
      return
    }
    console.log(
      `${args.item}: tier ${cost.tier}, labor ${cost.laborSeconds.toFixed(2)}s, composite ${cost.composite.toFixed(2)}`,
    )
    console.log(`machine bill @ ${args.rate}/s:`)
    const bill: MachineStep[] = machineBill(data, model, args.item, args.rate, defaultConfig)
    for (const step of bill) {
      console.log(
        `   ${step.machines.toFixed(2)}× ${step.recipe} [${step.category}] → ${step.outputPerSec.toFixed(2)}/s`,
      )
    }
    const footprint = tierFootprint(data, model, args.item, args.rate, defaultConfig)
    if (footprint.length > 1) {
      console.log(`machine-tier footprint (total crafters):`)
      for (const t of footprint) {
        console.log(
          `   ${t.label}: ${t.totalMachines.toFixed(2)} machines (${t.speedup.toFixed(1)}× vs mk1)`,
        )
      }
    }
  } else {
    console.log('— Item costs (unfolded to raw) —')
    console.log(itemTable(model, data))
    console.log('\n— Cost curve by tier —')
    console.log(tierTable(model, defaultConfig))
    console.log('\n— Machine bills for terminal goods —')
    console.log(billTable(data, model, defaultConfig, args.rate))
    console.log('\n— Machine-tier footprint (upgrade payoff) —')
    console.log(footprintTable(data, model, defaultConfig, args.rate))
  }

  if (args.mermaid) {
    console.log('\n— Production DAG (Mermaid) —')
    console.log(mermaid(data, model))
  }

  if (model.warnings.length) {
    console.log(`\n⚠ ${model.warnings.length} warning(s):`)
    for (const w of model.warnings) console.log(`   - ${w}`)
  }
}

main()
