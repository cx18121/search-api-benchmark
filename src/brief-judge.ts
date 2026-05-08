import Anthropic from '@anthropic-ai/sdk'
import type { CompanyContext, ResearchBrief } from './agent.js'

export interface BriefScore {
  completeness: number  // 0-4: number of sections with at least one item
  hooksTotal: number    // count of outreach hooks
  hooksSpecific: number // hooks that pass the "specific named fact" test
  hooksUsable: number   // hooks the judge would actually use in an email
  recencyHits: number   // dated items within the recency window
  recencyTotal: number  // dated items overall
  overallScore: number  // 1-5 holistic score
  rationale: string
}

export interface PairwiseVerdict {
  winner: 'a' | 'b' | 'tie'
  rationale: string
}

const SYSTEM_PROMPT = `You are evaluating B2B outreach research briefs produced by an AI agent. The brief will be used by someone preparing personalized first-contact outreach about the target company — could be a salesperson, BDR, recruiter, VC analyst, or partnerships lead. Reason from the visible content of each brief, not from general knowledge of the company. Output strict JSON with no prose or markdown.`

function describeBrief(label: string, brief: ResearchBrief): string {
  const lines: string[] = [`### Brief ${label}`, '']
  lines.push(`**Recent launches** (${brief.recentLaunches.length}):`)
  for (const x of brief.recentLaunches) {
    lines.push(`- ${x.what}  _(when: ${x.when || '?'})_  → ${x.sourceUrl}`)
    if (x.evidenceQuote) lines.push(`  evidence: "${x.evidenceQuote}"`)
  }
  if (brief.recentLaunches.length === 0) lines.push('- (empty)')
  lines.push('')
  lines.push(`**Leadership changes** (${brief.leadershipChanges.length}):`)
  for (const x of brief.leadershipChanges) {
    lines.push(`- ${x.what}  _(when: ${x.when || '?'})_  → ${x.sourceUrl}`)
    if (x.evidenceQuote) lines.push(`  evidence: "${x.evidenceQuote}"`)
  }
  if (brief.leadershipChanges.length === 0) lines.push('- (empty)')
  lines.push('')
  lines.push(`**Strategic shifts** (${brief.strategicShifts.length}):`)
  for (const x of brief.strategicShifts) {
    lines.push(`- ${x.what}  _(when: ${x.when || '?'})_  → ${x.sourceUrl}`)
    if (x.evidenceQuote) lines.push(`  evidence: "${x.evidenceQuote}"`)
  }
  if (brief.strategicShifts.length === 0) lines.push('- (empty)')
  lines.push('')
  lines.push(`**Outreach hooks** (${brief.outreachHooks.length}):`)
  for (const x of brief.outreachHooks) {
    lines.push(`- "${x.hook}"  → ${x.sourceUrl}`)
    if (x.rationale) lines.push(`  rationale: ${x.rationale}`)
    if (x.evidenceQuote) lines.push(`  evidence: "${x.evidenceQuote}"`)
  }
  if (brief.outreachHooks.length === 0) lines.push('- (empty)')
  return lines.join('\n')
}

function buildPointwisePrompt(
  company: CompanyContext,
  brief: ResearchBrief,
  recencyDays: number,
  cutoffDate: string,
): string {
  return `# Target company
Name: ${company.name}
Domain: ${company.domain}
${company.oneLiner ? `One-liner: ${company.oneLiner}` : ''}

# Brief to evaluate

${describeBrief('', brief)}

# Scoring task

Evaluate this brief on the following criteria. Return strict JSON.

1. **completeness** (integer 0-4): how many of the four sections (recent_launches, leadership_changes, strategic_shifts, outreach_hooks) contain at least one item with substantive content (not a placeholder)?

2. **hooks_total** (integer): the number of outreach hooks in the brief.

3. **hooks_specific** (integer): of those hooks, how many reference a specific company-specific named fact (a product launch, a hire, a date, a partnership)? A hook is NOT specific if it's generic ("you focus on AI") or vague ("you've been growing").

4. **hooks_usable** (integer): of those hooks, how many would actually work as the first sentence of a personalized B2B outreach message (sales / BDR / recruiting / partnerships / VC sourcing)? A hook is usable if it's specific, recent (within ${recencyDays} days where datable, i.e. on or after ${cutoffDate}), non-creepy, and references something the recipient would acknowledge as accurate.

5. **recency_hits** (integer) and **recency_total** (integer): of all dated items across recent_launches and leadership_changes, how many have a date on or after ${cutoffDate} (recency_hits) and how many are dated at all (recency_total)? Treat "unknown" or empty dates as undated (excluded from both counts).

6. **overall_score** (integer 1-5): your holistic judgment of how useful this brief would be to anyone preparing personalized B2B outreach (sales / BDR / recruiting / partnerships / VC sourcing). 5 = ready to use, 1 = unusable.

7. **rationale** (one short sentence): the most important reason for your overall score.

Output ONLY this JSON:

{
  "completeness": 0-4,
  "hooks_total": <int>,
  "hooks_specific": <int>,
  "hooks_usable": <int>,
  "recency_hits": <int>,
  "recency_total": <int>,
  "overall_score": 1-5,
  "rationale": "<one short sentence>"
}`
}

function buildPairwisePrompt(
  company: CompanyContext,
  briefA: ResearchBrief,
  briefB: ResearchBrief,
): string {
  return `# Target company
Name: ${company.name}
Domain: ${company.domain}
${company.oneLiner ? `One-liner: ${company.oneLiner}` : ''}

# Two briefs to compare

${describeBrief('A', briefA)}

---

${describeBrief('B', briefB)}

# Task

You are an experienced B2B operator (sales, BDR, recruiting, or partnerships). Which brief would you rather hand to a teammate making personalized first-contact outreach about ${company.name}? Pick "a" if A is meaningfully better, "b" if B is meaningfully better, or "tie" if they are roughly equivalent.

Decision criteria, in priority order:
1. Specific named facts beat generic positioning.
2. Recent events beat old events.
3. More usable outreach hooks beats more total content.
4. Coverage across the four sections beats depth in one.
5. Trustworthy source URLs beat dubious ones.

Output ONLY this JSON:

{
  "winner": "a" | "b" | "tie",
  "rationale": "<one short sentence on the deciding factor>"
}`
}

interface RawScoreJson {
  completeness?: unknown
  hooks_total?: unknown
  hooks_specific?: unknown
  hooks_usable?: unknown
  recency_hits?: unknown
  recency_total?: unknown
  overall_score?: unknown
  rationale?: unknown
}

interface RawPairwiseJson {
  winner?: unknown
  rationale?: unknown
}

function parseJson<T>(text: string): T {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new Error(`Brief judge output not JSON: ${text.slice(0, 200)}`)
  }
  return JSON.parse(text.slice(start, end + 1)) as T
}

function asInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10)
  return fallback
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export class BriefJudge {
  private readonly client: Anthropic
  private readonly model: string
  private readonly recencyDays: number
  private readonly cutoffDate: string

  constructor(
    apiKey: string,
    opts: { model?: string; runDate?: Date; recencyDays?: number } = {},
  ) {
    this.client = new Anthropic({ apiKey })
    this.model = opts.model ?? 'claude-sonnet-4-6'
    this.recencyDays = opts.recencyDays ?? 90
    const runDate = opts.runDate ?? new Date()
    const cutoff = new Date(runDate.getTime() - this.recencyDays * 24 * 60 * 60 * 1000)
    this.cutoffDate = toIsoDate(cutoff)
  }

  async scoreBrief(company: CompanyContext, brief: ResearchBrief): Promise<BriefScore> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 600,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildPointwisePrompt(company, brief, this.recencyDays, this.cutoffDate),
        },
      ],
    })
    const block = resp.content.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') throw new Error('Brief judge returned no text')
    const parsed = parseJson<RawScoreJson>(block.text)
    // Clamp count invariants the judge can violate: hooksSpecific ≤ hooksTotal,
    // hooksUsable ≤ hooksSpecific, recencyHits ≤ recencyTotal. Without this,
    // the judge sometimes reports nonsensical counts (e.g. 4 specific out of 3 total).
    const hooksTotal = Math.max(0, asInt(parsed.hooks_total))
    const hooksSpecific = Math.max(0, Math.min(hooksTotal, asInt(parsed.hooks_specific)))
    const hooksUsable = Math.max(0, Math.min(hooksSpecific, asInt(parsed.hooks_usable)))
    const recencyTotal = Math.max(0, asInt(parsed.recency_total))
    const recencyHits = Math.max(0, Math.min(recencyTotal, asInt(parsed.recency_hits)))

    return {
      completeness: Math.max(0, Math.min(4, asInt(parsed.completeness))),
      hooksTotal,
      hooksSpecific,
      hooksUsable,
      recencyHits,
      recencyTotal,
      overallScore: Math.max(1, Math.min(5, asInt(parsed.overall_score, 1))),
      rationale: asString(parsed.rationale),
    }
  }

  // Pairwise comparison with order-swap to control position bias. Runs the
  // comparison twice (A vs B and B vs A) and returns both verdicts so the
  // caller can decide how to aggregate (e.g., majority, or only count
  // consistent verdicts).
  async pairwise(
    company: CompanyContext,
    aBrief: ResearchBrief,
    bBrief: ResearchBrief,
  ): Promise<{ ab: PairwiseVerdict; ba: PairwiseVerdict }> {
    const [ab, ba] = await Promise.all([
      this.runPairwise(company, aBrief, bBrief),
      this.runPairwise(company, bBrief, aBrief),
    ])
    // BA was judged with B as the "a" slot — so we flip its winner so callers
    // see verdicts in terms of the *original* A/B identities.
    const baFlipped: PairwiseVerdict = {
      winner: ba.winner === 'a' ? 'b' : ba.winner === 'b' ? 'a' : 'tie',
      rationale: ba.rationale,
    }
    return { ab, ba: baFlipped }
  }

  private async runPairwise(
    company: CompanyContext,
    aBrief: ResearchBrief,
    bBrief: ResearchBrief,
  ): Promise<PairwiseVerdict> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 300,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildPairwisePrompt(company, aBrief, bBrief),
        },
      ],
    })
    const block = resp.content.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') throw new Error('Pairwise judge returned no text')
    const parsed = parseJson<RawPairwiseJson>(block.text)
    const w = asString(parsed.winner).toLowerCase()
    const winner: PairwiseVerdict['winner'] = w === 'a' ? 'a' : w === 'b' ? 'b' : 'tie'
    return { winner, rationale: asString(parsed.rationale) }
  }
}
