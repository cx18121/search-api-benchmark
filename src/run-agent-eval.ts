import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { ExaSearcher } from './searchers/exa.js'
import { TavilySearcher } from './searchers/tavily.js'
import type { Searcher } from './searchers/types.js'
import { ResearchAgent, type ResearchBrief, type AgentTrace, type CompanyContext } from './agent.js'
import { BriefJudge, type BriefScore, type PairwiseVerdict } from './brief-judge.js'
import { computeObjective, type ObjectiveMetrics } from './objective.js'
import type { EvalCompany, Stage } from './types.js'
import { STAGES } from './types.js'

interface AgentRunRecord {
  brief: ResearchBrief | null
  trace: AgentTrace
  score: BriefScore | null
  scoreError: string | null
  objective: ObjectiveMetrics | null
}

interface CompanyAgentResult {
  company: EvalCompany
  perSearcher: Record<string, AgentRunRecord>
  pairwise: {
    pair: [string, string] // [searcherA, searcherB]
    ab: PairwiseVerdict
    ba: PairwiseVerdict
  } | null
}

interface RunMetadata {
  runDate: string
  judgeModel: string
  agentModel: string
  numCompanies: number
  maxIterations: number
  numResultsPerSearch: number
  recencyDays: number
  searchers: string[]
}

interface RunResults {
  metadata: RunMetadata
  companies: CompanyAgentResult[]
}

function parseFlag(name: string): string | null {
  const idx = process.argv.indexOf(name)
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1] ?? null
  return null
}

function parsePositiveInt(name: string, value: string | null, fallback: number): number {
  if (value === null) return fallback
  const n = parseInt(value, 10)
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== value.trim()) {
    throw new Error(`Invalid value for ${name}: ${JSON.stringify(value)}. Expected a positive integer.`)
  }
  return n
}

function pct(num: number, denom: number): string {
  if (denom === 0) return '   -  '
  return ((num / denom) * 100).toFixed(0).padStart(3, ' ') + '%'
}

interface AggregateBucket {
  briefCount: number
  scoreCount: number
  failedAgent: number
  failedScore: number

  sumCompleteness: number
  sumHooksTotal: number
  sumHooksSpecific: number
  sumHooksUsable: number
  sumRecencyHits: number
  sumRecencyTotal: number
  sumOverall: number

  sumSearchCalls: number
  sumIterations: number
  sumInputTokens: number
  sumOutputTokens: number

  // Objective metrics (no judge calls)
  objCount: number
  sumDistinctDomains: number
  sumPrimaryRate: number
  sumZeroResultRate: number
  sumHooksPerCall: number
  // Median age and tokens-per-usable-hook are excluded from per-call counts
  // when undefined; track separately so the denominator is honest.
  medianAgeValues: number[]
  tokensPerHookValues: number[]
}

function emptyBucket(): AggregateBucket {
  return {
    briefCount: 0,
    scoreCount: 0,
    failedAgent: 0,
    failedScore: 0,
    sumCompleteness: 0,
    sumHooksTotal: 0,
    sumHooksSpecific: 0,
    sumHooksUsable: 0,
    sumRecencyHits: 0,
    sumRecencyTotal: 0,
    sumOverall: 0,
    sumSearchCalls: 0,
    sumIterations: 0,
    sumInputTokens: 0,
    sumOutputTokens: 0,
    objCount: 0,
    sumDistinctDomains: 0,
    sumPrimaryRate: 0,
    sumZeroResultRate: 0,
    sumHooksPerCall: 0,
    medianAgeValues: [],
    tokensPerHookValues: [],
  }
}

function fold(bucket: AggregateBucket, rec: AgentRunRecord): void {
  bucket.briefCount++
  if (!rec.brief) bucket.failedAgent++
  if (rec.score) {
    bucket.scoreCount++
    bucket.sumCompleteness += rec.score.completeness
    bucket.sumHooksTotal += rec.score.hooksTotal
    bucket.sumHooksSpecific += rec.score.hooksSpecific
    bucket.sumHooksUsable += rec.score.hooksUsable
    bucket.sumRecencyHits += rec.score.recencyHits
    bucket.sumRecencyTotal += rec.score.recencyTotal
    bucket.sumOverall += rec.score.overallScore
  } else if (rec.scoreError) {
    bucket.failedScore++
  }
  bucket.sumSearchCalls += rec.trace.searchCalls.length
  bucket.sumIterations += rec.trace.iterations
  bucket.sumInputTokens += rec.trace.inputTokens
  bucket.sumOutputTokens += rec.trace.outputTokens
  if (rec.objective) {
    bucket.objCount++
    bucket.sumDistinctDomains += rec.objective.distinctDomains
    bucket.sumPrimaryRate += rec.objective.primarySourceRate
    bucket.sumZeroResultRate += rec.objective.zeroResultSearchRate
    bucket.sumHooksPerCall += rec.objective.hooksPerSearchCall
    if (rec.objective.medianDatedAgeDays !== null) {
      bucket.medianAgeValues.push(rec.objective.medianDatedAgeDays)
    }
    if (rec.objective.tokensPerUsableHook !== null) {
      bucket.tokensPerHookValues.push(rec.objective.tokensPerUsableHook)
    }
  }
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2
  return sorted[mid]!
}

function avg(sum: number, n: number): string {
  if (n === 0) return '  -  '
  return (sum / n).toFixed(2).padStart(5, ' ')
}

function printAggregate(label: string, b: AggregateBucket): void {
  console.log(`\n## ${label}`)
  console.log(`  briefs:     ${b.briefCount}  (${b.failedAgent} agent failures, ${b.failedScore} score failures)`)
  if (b.scoreCount === 0) return
  console.log(`  per brief averages (n=${b.scoreCount}):`)
  console.log(`    completeness  /4:        ${avg(b.sumCompleteness, b.scoreCount)}`)
  console.log(`    hooks_total:             ${avg(b.sumHooksTotal, b.scoreCount)}`)
  console.log(`    hooks_specific:          ${avg(b.sumHooksSpecific, b.scoreCount)}`)
  console.log(`    hooks_usable:            ${avg(b.sumHooksUsable, b.scoreCount)}`)
  console.log(`    recency_hits/total:      ${avg(b.sumRecencyHits, b.scoreCount)} / ${avg(b.sumRecencyTotal, b.scoreCount)}`)
  console.log(`    overall_score /5:        ${avg(b.sumOverall, b.scoreCount)}`)
  console.log(`  agent diagnostics:`)
  console.log(`    avg search calls:        ${avg(b.sumSearchCalls, b.briefCount)}`)
  console.log(`    avg iterations:          ${avg(b.sumIterations, b.briefCount)}`)
  console.log(`    avg input tokens:        ${avg(b.sumInputTokens, b.briefCount)}`)
  console.log(`    avg output tokens:       ${avg(b.sumOutputTokens, b.briefCount)}`)
  if (b.objCount > 0) {
    const primaryPct = ((b.sumPrimaryRate / b.objCount) * 100).toFixed(0)
    const zeroPct = ((b.sumZeroResultRate / b.objCount) * 100).toFixed(0)
    const medAge = b.medianAgeValues.length
      ? medianOf(b.medianAgeValues).toFixed(0) + 'd'
      : '   n/a'
    const medTok = b.tokensPerHookValues.length
      ? medianOf(b.tokensPerHookValues).toFixed(0)
      : '  n/a'
    console.log(`  objective metrics (n=${b.objCount}):`)
    console.log(`    avg distinct domains:    ${avg(b.sumDistinctDomains, b.objCount)}`)
    console.log(`    avg primary-source rate:    ${primaryPct.padStart(3)}%`)
    console.log(`    avg zero-result rate:       ${zeroPct.padStart(3)}%`)
    console.log(`    avg hooks per search call: ${avg(b.sumHooksPerCall, b.objCount)}`)
    console.log(`    median dated-item age:    ${medAge.padStart(6)}  (n=${b.medianAgeValues.length})`)
    console.log(`    median tokens / usable hook: ${medTok.padStart(6)}  (n=${b.tokensPerHookValues.length})`)
  }
}

interface PairwiseTally {
  exaWinsConsistent: number
  tavilyWinsConsistent: number
  ties: number
  inconsistent: number  // judge flipped on order swap — treat as no-info
  total: number
}

function emptyPairwise(): PairwiseTally {
  return { exaWinsConsistent: 0, tavilyWinsConsistent: 0, ties: 0, inconsistent: 0, total: 0 }
}

function tallyPairwise(tally: PairwiseTally, ab: PairwiseVerdict, ba: PairwiseVerdict, exaIsA: boolean): void {
  // A tie counts only when BOTH order-swapped judgments agree it's a tie.
  // Mixed outcomes (one tie + one winner, or conflicting winners) are
  // inconsistent — neither a real tie nor a stable win signal.
  tally.total++
  if (ab.winner === ba.winner) {
    if (ab.winner === 'tie') {
      tally.ties++
      return
    }
    // Both arms agree on the same winning slot.
    const winnerSlot = ab.winner
    const exaWon = exaIsA ? winnerSlot === 'a' : winnerSlot === 'b'
    if (exaWon) tally.exaWinsConsistent++
    else tally.tavilyWinsConsistent++
    return
  }
  // Mismatched verdicts (any combination of tie + winner, or A vs B) → no info.
  tally.inconsistent++
}

function printPairwise(label: string, t: PairwiseTally): void {
  console.log(`\n## Pairwise — ${label}`)
  console.log(`  total comparisons: ${t.total}`)
  console.log(`  exa wins (consistent on order swap):    ${t.exaWinsConsistent}`)
  console.log(`  tavily wins (consistent on order swap): ${t.tavilyWinsConsistent}`)
  console.log(`  ties:                                   ${t.ties}`)
  console.log(`  inconsistent (position bias, no info):  ${t.inconsistent}`)
}

async function main() {
  const exaKey = process.env.EXA_API_KEY?.trim()
  const tavilyKey = process.env.TAVILY_API_KEY?.trim()
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!exaKey) throw new Error('EXA_API_KEY missing')
  if (!tavilyKey) throw new Error('TAVILY_API_KEY missing')
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY missing')

  const limitFlag = parseFlag('--limit')
  const limit = limitFlag === null ? Infinity : parsePositiveInt('--limit', limitFlag, Infinity)
  const perStageFlag = parseFlag('--per-stage')
  const perStage = perStageFlag === null ? null : parsePositiveInt('--per-stage', perStageFlag, 0)
  const maxIterations = parsePositiveInt('--max-iter', parseFlag('--max-iter'), 6)
  const numResultsPerSearch = parsePositiveInt('--results-per-search', parseFlag('--results-per-search'), 5)
  const recencyDays = parsePositiveInt('--recency', parseFlag('--recency'), 90)
  const skipPairwise = process.argv.includes('--no-pairwise')
  const outPath = resolve(parseFlag('--out') ?? `results/agent-${new Date().toISOString().slice(0, 10)}.json`)

  const raw = await readFile(resolve('data/companies.json'), 'utf8')
  const allCompanies = JSON.parse(raw) as EvalCompany[]
  let companies: EvalCompany[]
  if (perStage !== null) {
    // Take first N from each stage in STAGES order (Series B → Series A → Seed,
    // i.e. well-known to obscure).
    const byStage: Record<Stage, EvalCompany[]> = { 'Series B': [], 'Series A': [], Seed: [] }
    for (const c of allCompanies) byStage[c.stage].push(c)
    companies = STAGES.flatMap((s) => byStage[s].slice(0, perStage))
  } else {
    companies = allCompanies.slice(0, limit)
  }

  const searchers: Searcher[] = [
    // recencyDays is wired into both searchers so the window the agent
    // prompt mentions is actually enforced at retrieval time, not just in
    // the LLM's reasoning.
    new ExaSearcher(exaKey, { type: 'auto', textMaxCharacters: 5000, recencyDays }),
    new TavilySearcher(tavilyKey, { searchDepth: 'advanced', days: recencyDays }),
  ]
  const agent = new ResearchAgent(anthropicKey, {
    model: 'claude-sonnet-4-6',
    maxIterations,
    numResultsPerSearch,
    recencyDays,
  })
  const judge = new BriefJudge(anthropicKey, { model: 'claude-sonnet-4-6', recencyDays })
  const searcherNames = searchers.map((s) => s.name)

  const runDate = new Date()
  console.log(`# exa-search-benchmark — Track 2 (agentic research)`)
  console.log(`run date:        ${runDate.toISOString().slice(0, 10)}`)
  console.log(`recency window:  ${recencyDays}d`)
  console.log(`max iterations:  ${maxIterations}`)
  console.log(`results/search:  ${numResultsPerSearch}`)
  console.log(`companies:       ${companies.length}`)
  console.log(`searchers:       ${searcherNames.join(', ')}`)
  console.log(`pairwise:        ${skipPairwise ? 'skipped' : 'on (order-swapped)'}`)

  const results: CompanyAgentResult[] = []

  // Resume support: if the output file already exists, load completed
  // companies and skip them. Lets us pick up after a crash without losing
  // hours of API calls.
  const completedNames = new Set<string>()
  try {
    const existing = JSON.parse(await readFile(outPath, 'utf8')) as RunResults
    if (Array.isArray(existing.companies)) {
      for (const c of existing.companies) {
        results.push(c)
        completedNames.add(c.company.name)
      }
      if (completedNames.size > 0) {
        console.log(`resume:          loaded ${completedNames.size} completed companies from ${outPath}`)
      }
    }
  } catch {
    // No prior file or unreadable — fresh run.
  }

  // Helper: write current state to disk after each company so a crash never
  // costs more than one company of work.
  const checkpoint = async (current: CompanyAgentResult[]): Promise<void> => {
    const out: RunResults = {
      metadata: {
        runDate: runDate.toISOString(),
        judgeModel: 'claude-sonnet-4-6',
        agentModel: 'claude-sonnet-4-6',
        numCompanies: companies.length,
        maxIterations,
        numResultsPerSearch,
        recencyDays,
        searchers: searcherNames,
      },
      companies: current,
    }
    await mkdir(dirname(outPath), { recursive: true }).catch(() => {})
    await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8')
  }

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i]!
    if (completedNames.has(c.name)) {
      console.log(`\n[${i + 1}/${companies.length}] ${c.name} — SKIP (resumed)`)
      continue
    }
    const ctx: CompanyContext = {
      name: c.name,
      domain: c.domain,
      oneLiner: c.oneLiner,
      industry: c.industry,
    }
    console.log(`\n[${i + 1}/${companies.length}] ${c.name} (${c.stage})`)

    // Run the agent for each searcher sequentially. (Could parallelize but
    // sequential keeps Anthropic load lower and progress legible.)
    const perSearcher: Record<string, AgentRunRecord> = {}
    for (const s of searchers) {
      const t0 = Date.now()
      const { brief, trace } = await agent.research(ctx, s)
      const elapsed = Date.now() - t0
      let score: BriefScore | null = null
      let scoreError: string | null = null
      if (brief) {
        try {
          score = await judge.scoreBrief(ctx, brief)
        } catch (err) {
          scoreError = err instanceof Error ? err.message : String(err)
        }
      }
      const objective = brief
        ? computeObjective(brief, trace, ctx, runDate, score?.hooksUsable ?? null)
        : null
      perSearcher[s.name] = { brief, trace, score, scoreError, objective }

      const briefStatus = brief
        ? `${brief.recentLaunches.length}L/${brief.leadershipChanges.length}P/${brief.strategicShifts.length}S/${brief.outreachHooks.length}H`
        : `NO BRIEF (${trace.stoppedReason})`
      const scoreStr = score
        ? `score ${score.overallScore}/5 (usable hooks ${score.hooksUsable}/${score.hooksTotal})`
        : scoreError
          ? `score FAIL: ${scoreError.slice(0, 60)}`
          : 'no score'
      console.log(
        `  ${s.name.padEnd(8)} ${trace.searchCalls.length} searches, ${trace.iterations} iters, ${elapsed}ms | ${briefStatus} | ${scoreStr}`,
      )
    }

    // Pairwise comparison: only meaningful if both searchers produced briefs.
    let pairwise: CompanyAgentResult['pairwise'] = null
    if (!skipPairwise && searchers.length >= 2) {
      const aName = searcherNames[0]!
      const bName = searcherNames[1]!
      const aBrief = perSearcher[aName]?.brief ?? null
      const bBrief = perSearcher[bName]?.brief ?? null
      if (aBrief && bBrief) {
        try {
          const verdicts = await judge.pairwise(ctx, aBrief, bBrief)
          pairwise = { pair: [aName, bName], ab: verdicts.ab, ba: verdicts.ba }
          const consistent = verdicts.ab.winner === verdicts.ba.winner ? verdicts.ab.winner : 'flip'
          console.log(`  pairwise:  ab=${verdicts.ab.winner} ba=${verdicts.ba.winner} → ${consistent}`)
        } catch (err) {
          console.log(`  pairwise FAILED: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        console.log(`  pairwise skipped (one or both briefs missing)`)
      }
    }

    results.push({ company: c, perSearcher, pairwise })
  }

  const metadata: RunMetadata = {
    runDate: runDate.toISOString(),
    judgeModel: 'claude-sonnet-4-6',
    agentModel: 'claude-sonnet-4-6',
    numCompanies: companies.length,
    maxIterations,
    numResultsPerSearch,
    recencyDays,
    searchers: searcherNames,
  }
  const out: RunResults = { metadata, companies: results }
  await mkdir(dirname(outPath), { recursive: true }).catch(() => {})
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8')

  // Aggregates: per-searcher overall + per tier.
  const overall: Record<string, AggregateBucket> = Object.fromEntries(
    searcherNames.map((n) => [n, emptyBucket()]),
  )
  const byStage: Record<string, Record<Stage, AggregateBucket>> = Object.fromEntries(
    searcherNames.map((n) => [
      n,
      { 'Series B': emptyBucket(), 'Series A': emptyBucket(), Seed: emptyBucket() } as Record<Stage, AggregateBucket>,
    ]),
  )
  const pairwiseTally = emptyPairwise()
  const pairwiseByStage: Record<Stage, PairwiseTally> = {
    'Series B': emptyPairwise(),
    'Series A': emptyPairwise(),
    Seed: emptyPairwise(),
  }

  for (const c of results) {
    for (const name of searcherNames) {
      const rec = c.perSearcher[name]
      if (!rec) continue
      fold(overall[name]!, rec)
      fold(byStage[name]![c.company.stage], rec)
    }
    if (c.pairwise) {
      const exaIsA = c.pairwise.pair[0] === 'exa'
      tallyPairwise(pairwiseTally, c.pairwise.ab, c.pairwise.ba, exaIsA)
      tallyPairwise(pairwiseByStage[c.company.stage], c.pairwise.ab, c.pairwise.ba, exaIsA)
    }
  }

  console.log('\n\n========================================')
  console.log('SUMMARY')
  console.log('========================================')
  for (const name of searcherNames) {
    printAggregate(`${name.toUpperCase()} — overall`, overall[name]!)
  }
  if (!skipPairwise) printPairwise('overall', pairwiseTally)
  for (const stage of STAGES) {
    console.log('\n----------------------------------------')
    console.log(`STAGE: ${stage}`)
    console.log('----------------------------------------')
    for (const name of searcherNames) {
      printAggregate(`${name.toUpperCase()} — ${stage}`, byStage[name]![stage])
    }
    if (!skipPairwise) printPairwise(stage, pairwiseByStage[stage])
  }

  console.log(`\nFull results → ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
