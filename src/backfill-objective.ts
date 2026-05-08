import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { computeObjective, type ObjectiveMetrics } from './objective.js'
import type { ResearchBrief, AgentTrace, CompanyContext } from './agent.js'
import type { BriefScore } from './brief-judge.js'

// Read an existing agent-eval result JSON, compute objective metrics for
// every per-searcher entry that has a brief, and write the file back in
// place. Pure post-processing — no API calls, no judge calls.

interface FileShape {
  metadata: { runDate?: string }
  companies: Array<{
    company: { name: string; domain: string; oneLiner?: string; industry?: string }
    perSearcher: Record<
      string,
      {
        brief: ResearchBrief | null
        trace: AgentTrace
        score: BriefScore | null
        scoreError: string | null
        objective?: ObjectiveMetrics | null
      }
    >
  }>
}

async function main() {
  const inPath = resolve(process.argv[2] ?? 'results/agent-2026-05-08.json')
  const raw = await readFile(inPath, 'utf8')
  const data = JSON.parse(raw) as FileShape

  const runDate = data.metadata.runDate ? new Date(data.metadata.runDate) : new Date()

  let updated = 0
  let skipped = 0
  for (const c of data.companies) {
    const ctx: CompanyContext = {
      name: c.company.name,
      domain: c.company.domain,
      oneLiner: c.company.oneLiner ?? null,
      industry: c.company.industry ?? null,
    }
    for (const [name, rec] of Object.entries(c.perSearcher)) {
      if (!rec.brief) {
        rec.objective = null
        skipped++
        continue
      }
      rec.objective = computeObjective(
        rec.brief,
        rec.trace,
        ctx,
        runDate,
        rec.score?.hooksUsable ?? null,
      )
      updated++
      console.log(
        `  ${c.company.name.padEnd(22)} ${name.padEnd(8)} domains=${rec.objective.distinctDomains}  primary=${(rec.objective.primarySourceRate * 100).toFixed(0)}%  medAge=${rec.objective.medianDatedAgeDays ?? '?'}d  tok/hook=${rec.objective.tokensPerUsableHook?.toFixed(0) ?? '?'}`,
      )
    }
  }

  await writeFile(inPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log(`\nUpdated: ${updated}  Skipped: ${skipped}  → ${inPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
