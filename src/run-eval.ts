import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { ExaSearcher } from './searchers/exa.js'
import { TavilySearcher } from './searchers/tavily.js'
import type { Searcher, SearchResult } from './searchers/types.js'
import { Judge, type CompanyContext, type JudgeVerdict, type SourceType } from './judge.js'
import type { EvalCompany, Stage } from './types.js'
import { STAGES } from './types.js'

interface ScoredResult {
  rank: number
  url: string
  title: string
  content: string
  publishedDate: string | null
  verdict: JudgeVerdict | null
  judgeError: string | null
}

interface SearcherRun {
  query: string
  elapsedMs: number
  error: string | null
  results: ScoredResult[]
}

interface CompanyRunResult {
  company: EvalCompany
  perSearcher: Record<string, SearcherRun>
}

interface RunMetadata {
  runDate: string
  cutoffDate: string
  judgeModel: string
  numCompanies: number
  numResultsPerQuery: number
  searchers: string[]
}

interface RunResults {
  metadata: RunMetadata
  companies: CompanyRunResult[]
}

function parseFlag(name: string): string | null {
  const idx = process.argv.indexOf(name)
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1] ?? null
  return null
}

function buildQuery(c: EvalCompany): string {
  // Domain is intentionally NOT included. An earlier version concatenated
  // ${c.domain} into the query, but that turns the eval into "given the
  // domain, can you return its pages?" — which any search engine wins
  // trivially and which biases hard toward first-party concentration. The
  // honest retrieval question is "given just the company name, can you find
  // recent useful info?" — so name + intent words only.
  return `${c.name} product features recent launches`
}

async function runSearcher(
  searcher: Searcher,
  company: EvalCompany,
  numResults: number,
): Promise<SearcherRun> {
  const query = buildQuery(company)
  const t0 = Date.now()
  try {
    const results = await searcher.search({ query, numResults })
    return {
      query,
      elapsedMs: Date.now() - t0,
      error: null,
      results: results.map((r, i) => ({
        rank: i + 1,
        url: r.url,
        title: r.title,
        content: r.content,
        publishedDate: r.publishedDate,
        verdict: null,
        judgeError: null,
      })),
    }
  } catch (err) {
    return {
      query,
      elapsedMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      results: [],
    }
  }
}

async function judgeResults(
  judge: Judge,
  company: EvalCompany,
  run: SearcherRun,
): Promise<void> {
  const ctx: CompanyContext = {
    name: company.name,
    domain: company.domain,
    oneLiner: company.oneLiner,
    industry: company.industry,
  }
  // Judge results sequentially within an API so progress is visible and
  // we don't fan out 5 results × 5 prompts = 25 in-flight calls per
  // company. The judge already parallelises its 5 criterion prompts
  // internally via Promise.all.
  for (const r of run.results) {
    const raw: SearchResult = {
      url: r.url,
      title: r.title,
      content: r.content,
      publishedDate: r.publishedDate,
    }
    try {
      r.verdict = await judge.judge(ctx, raw)
    } catch (err) {
      r.judgeError = err instanceof Error ? err.message : String(err)
    }
  }
}

interface AggregateBucket {
  resultCount: number
  retrievalRelevantCount: number
  salesTriggerCount: number
  unclearTotal: number
  judgedCount: number
  errorCount: number
  sourceTypeCounts: Record<SourceType, number>
  perCriterionPass: {
    onTopic: number
    actionableSignal: number
    recentOrStructural: number
    notNoise: number
  }
  perCriterionUnclear: {
    onTopic: number
    actionableSignal: number
    recentOrStructural: number
    notNoise: number
  }
}

function emptyBucket(): AggregateBucket {
  return {
    resultCount: 0,
    retrievalRelevantCount: 0,
    salesTriggerCount: 0,
    unclearTotal: 0,
    judgedCount: 0,
    errorCount: 0,
    sourceTypeCounts: {
      first_party: 0,
      trade_press: 0,
      aggregator: 0,
      forum: 0,
      spam: 0,
      other: 0,
    },
    perCriterionPass: {
      onTopic: 0,
      actionableSignal: 0,
      recentOrStructural: 0,
      notNoise: 0,
    },
    perCriterionUnclear: {
      onTopic: 0,
      actionableSignal: 0,
      recentOrStructural: 0,
      notNoise: 0,
    },
  }
}

function fold(bucket: AggregateBucket, run: SearcherRun): void {
  for (const r of run.results) {
    bucket.resultCount++
    if (r.judgeError) {
      bucket.errorCount++
      continue
    }
    const v = r.verdict
    if (!v) continue
    bucket.judgedCount++
    if (v.retrievalRelevant) bucket.retrievalRelevantCount++
    if (v.salesTrigger) bucket.salesTriggerCount++
    bucket.unclearTotal += v.unclearCount
    bucket.sourceTypeCounts[v.sourceType.value]++

    if (v.onTopic.verdict === 'pass') bucket.perCriterionPass.onTopic++
    if (v.actionableSignal.verdict === 'pass') bucket.perCriterionPass.actionableSignal++
    if (v.recentOrStructural.verdict === 'pass') bucket.perCriterionPass.recentOrStructural++
    if (v.notNoise.verdict === 'pass') bucket.perCriterionPass.notNoise++

    if (v.onTopic.verdict === 'unclear') bucket.perCriterionUnclear.onTopic++
    if (v.actionableSignal.verdict === 'unclear') bucket.perCriterionUnclear.actionableSignal++
    if (v.recentOrStructural.verdict === 'unclear') bucket.perCriterionUnclear.recentOrStructural++
    if (v.notNoise.verdict === 'unclear') bucket.perCriterionUnclear.notNoise++
  }
}

function pct(num: number, denom: number): string {
  if (denom === 0) return '  -  '
  const v = (num / denom) * 100
  return v.toFixed(0).padStart(3, ' ') + '%'
}

function printAggregate(label: string, bucket: AggregateBucket): void {
  console.log(`\n## ${label}`)
  console.log(
    `  results: ${bucket.resultCount} | judged: ${bucket.judgedCount} | judge errors: ${bucket.errorCount}`,
  )
  if (bucket.judgedCount === 0) return
  const denom = bucket.judgedCount
  console.log(`  retrieval_relevant: ${pct(bucket.retrievalRelevantCount, denom)}`)
  console.log(`  sales_trigger:      ${pct(bucket.salesTriggerCount, denom)}`)
  console.log(`  per-criterion pass:`)
  console.log(`    on_topic:             ${pct(bucket.perCriterionPass.onTopic, denom)}`)
  console.log(`    actionable_signal:    ${pct(bucket.perCriterionPass.actionableSignal, denom)}`)
  console.log(`    recent_or_structural: ${pct(bucket.perCriterionPass.recentOrStructural, denom)}`)
  console.log(`    not_noise:            ${pct(bucket.perCriterionPass.notNoise, denom)}`)
  console.log(`  per-criterion unclear:`)
  console.log(`    on_topic:             ${pct(bucket.perCriterionUnclear.onTopic, denom)}`)
  console.log(`    actionable_signal:    ${pct(bucket.perCriterionUnclear.actionableSignal, denom)}`)
  console.log(`    recent_or_structural: ${pct(bucket.perCriterionUnclear.recentOrStructural, denom)}`)
  console.log(`    not_noise:            ${pct(bucket.perCriterionUnclear.notNoise, denom)}`)
  console.log(`  source mix:`)
  for (const [k, n] of Object.entries(bucket.sourceTypeCounts)) {
    console.log(`    ${k.padEnd(13)} ${pct(n, denom)}`)
  }
}

interface Aggregates {
  overall: Record<string, AggregateBucket>
  byStage: Record<string, Record<Stage, AggregateBucket>>
}

function aggregate(
  searcherNames: string[],
  results: CompanyRunResult[],
): Aggregates {
  const overall: Record<string, AggregateBucket> = {}
  const byStage: Record<string, Record<Stage, AggregateBucket>> = {}
  for (const name of searcherNames) {
    overall[name] = emptyBucket()
    byStage[name] = { 'Series B': emptyBucket(), 'Series A': emptyBucket(), Seed: emptyBucket() }
  }
  for (const c of results) {
    for (const name of searcherNames) {
      const run = c.perSearcher[name]
      if (!run) continue
      fold(overall[name]!, run)
      fold(byStage[name]![c.company.stage], run)
    }
  }
  return { overall, byStage }
}

async function main() {
  const exaKey = process.env.EXA_API_KEY?.trim()
  const tavilyKey = process.env.TAVILY_API_KEY?.trim()
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!exaKey) throw new Error('EXA_API_KEY missing')
  if (!tavilyKey) throw new Error('TAVILY_API_KEY missing')
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY missing')

  const limitFlag = parseFlag('--limit')
  const limit = limitFlag ? parseInt(limitFlag, 10) : Infinity
  const numResults = parseInt(parseFlag('--num-results') ?? '5', 10)
  const outPath = resolve(parseFlag('--out') ?? `results/${new Date().toISOString().slice(0, 10)}.json`)

  const raw = await readFile(resolve('data/companies.json'), 'utf8')
  const companies = (JSON.parse(raw) as EvalCompany[]).slice(0, limit)

  const searchers: Searcher[] = [
    // textMaxCharacters: 5000 chosen to roughly match Tavily 'advanced' extract
    // length (~1-3KB). The wrapper default is 2000 (matches Sparrow's production
    // setting); the higher cap here gives the judge more to work with and makes
    // the manual spot-check templates readable without being unfair to either API.
    new ExaSearcher(exaKey, { type: 'auto', textMaxCharacters: 5000 }),
    new TavilySearcher(tavilyKey, { searchDepth: 'advanced' }),
  ]
  const judge = new Judge(anthropicKey)
  const searcherNames = searchers.map((s) => s.name)

  console.log(`# exa-search-benchmark`)
  console.log(`run date:    ${judge.runDate.toISOString().slice(0, 10)}`)
  console.log(`recency cut: ${judge.cutoffDate.toISOString().slice(0, 10)} (180d)`)
  console.log(`companies:   ${companies.length}`)
  console.log(`searchers:   ${searcherNames.join(', ')}`)
  console.log(`results/q:   ${numResults}`)

  const results: CompanyRunResult[] = []
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i]!
    console.log(`\n[${i + 1}/${companies.length}] ${c.name} (${c.stage})`)

    const runs = await Promise.all(
      searchers.map((s) => runSearcher(s, c, numResults)),
    )
    const perSearcher: Record<string, SearcherRun> = {}
    for (let j = 0; j < searchers.length; j++) {
      const s = searchers[j]!
      const run = runs[j]!
      perSearcher[s.name] = run
      const status = run.error
        ? `ERROR ${run.error.slice(0, 80)}`
        : `${run.results.length} results in ${run.elapsedMs}ms`
      console.log(`  ${s.name.padEnd(8)} ${status}`)
    }

    for (const s of searchers) {
      const run = perSearcher[s.name]!
      if (run.error || run.results.length === 0) continue
      await judgeResults(judge, c, run)
      const judged = run.results.filter((r) => r.verdict).length
      const useful = run.results.filter((r) => r.verdict?.salesTrigger).length
      const relevant = run.results.filter((r) => r.verdict?.retrievalRelevant).length
      console.log(
        `  ${s.name.padEnd(8)} judged ${judged}/${run.results.length} | retrieval ${relevant} | trigger ${useful}`,
      )
    }

    results.push({ company: c, perSearcher })
  }

  const metadata: RunMetadata = {
    runDate: judge.runDate.toISOString(),
    cutoffDate: judge.cutoffDate.toISOString(),
    judgeModel: 'claude-sonnet-4-6',
    numCompanies: companies.length,
    numResultsPerQuery: numResults,
    searchers: searcherNames,
  }
  const out: RunResults = { metadata, companies: results }
  await mkdir(dirname(outPath), { recursive: true }).catch(() => {})
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8')

  // Aggregate scores: overall + per tier per API.
  const agg = aggregate(searcherNames, results)
  console.log('\n\n========================================')
  console.log('SUMMARY')
  console.log('========================================')
  for (const name of searcherNames) {
    printAggregate(`${name.toUpperCase()} — overall`, agg.overall[name]!)
  }
  for (const stage of STAGES) {
    console.log('\n----------------------------------------')
    console.log(`STAGE: ${stage}`)
    console.log('----------------------------------------')
    for (const name of searcherNames) {
      printAggregate(`${name.toUpperCase()} — ${stage}`, agg.byStage[name]![stage])
    }
  }

  console.log(`\nFull results → ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
