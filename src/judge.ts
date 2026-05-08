import Anthropic from '@anthropic-ai/sdk'
import type { SearchResult } from './searchers/types.js'

export interface CompanyContext {
  name: string
  domain: string
  oneLiner: string | null
  industry: string | null
}

export type Verdict = 'pass' | 'fail' | 'unclear'

export type EvidenceSource = 'content' | 'title' | 'url' | 'published_date'

export type SourceType =
  | 'first_party'
  | 'trade_press'
  | 'aggregator'
  | 'forum'
  | 'spam'
  | 'other'

export interface CriterionResult {
  verdict: Verdict
  evidenceQuote: string
  evidenceSource: EvidenceSource
  reasoning: string
  // True when the evidence_source is allowed for this criterion AND the quote
  // is an actual substring of that source field. False when either check
  // fails — verdict is force-set to 'unclear' so a hallucinated or
  // wrong-field quote can't sneak through.
  quoteValidated: boolean
  // True when the model returned a clean JSON object with no surrounding
  // prose. Diagnostic only — captures judge instruction-following quality.
  strictJson: boolean
}

export interface SourceTypeResult {
  value: SourceType
  reasoning: string
  // True when the model returned one of the six allowed values. False
  // when the value was malformed or unknown and was coerced to 'other'.
  valid: boolean
  strictJson: boolean
}

export interface JudgeVerdict {
  onTopic: CriterionResult
  actionableSignal: CriterionResult
  recentOrStructural: CriterionResult
  notNoise: CriterionResult
  sourceType: SourceTypeResult
  // Two-tier composite scores. retrievalRelevant = "is this even a usable
  // company-research result?". salesTrigger = "does it also give us an
  // outreach opener?".
  retrievalRelevant: boolean
  salesTrigger: boolean
  unclearCount: number
}

export interface JudgeOptions {
  // The date the benchmark is being run on. The 180-day recency cutoff is
  // rendered as a literal calendar date in the prompt so reruns on
  // different dates can't silently relabel the same result.
  runDate?: Date
  model?: string
}

const SYSTEM_PROMPT = `You are evaluating a single search result against a single, specific criterion. You must reason from observable evidence in the search result fields, not from general knowledge or domain reputation. Output strict JSON with no prose or markdown.`

const RECENCY_WINDOW_DAYS = 180

interface CriterionSpec {
  key: 'onTopic' | 'actionableSignal' | 'recentOrStructural' | 'notNoise'
  name: string
  question: string
  passDefinition: string
  failDefinition: string
  unclearDefinition: string
  // Which fields the judge is allowed to quote from for this criterion.
  // ON_TOPIC accepts content/title/url because the page subject can be
  // visible in any of them. ACTIONABLE_SIGNAL needs the actual fact in
  // prose, so content only. RECENT_OR_STRUCTURAL accepts content or
  // published_date because the date can come from either. NOT_NOISE is
  // about narrative quality — it has to be in content.
  allowedEvidenceSources: EvidenceSource[]
}

function buildCriteria(cutoffDate: string): CriterionSpec[] {
  return [
    {
      key: 'onTopic',
      name: 'ON_TOPIC',
      question: 'Is this search result primarily about the target company itself?',
      passDefinition:
        'The Title, URL, or first substantive paragraph of Content names the target company, AND at least half of the visible Content concerns the target company specifically — its product, activities, employees, customers, funding, operations, or announcements.',
      failDefinition:
        'The target company appears only as one entry in a multi-company list or roundup with no target-specific paragraph carrying a distinct fact, OR the page is on the target\'s own domain but is actually about a different tool/person/topic, OR a different company with a similar name is the actual subject.',
      unclearDefinition:
        'The Content block was paywalled, login-walled, or empty AND the Title and URL are not specific enough to determine the page subject.',
      allowedEvidenceSources: ['content', 'title', 'url'],
    },
    {
      key: 'actionableSignal',
      name: 'ACTIONABLE_SIGNAL',
      question: 'Does the Content contain at least one quotable, company-specific fact?',
      passDefinition:
        'The Content contains at least one named event, change, claim, announcement, relationship, metric, launch, or hiring / funding / customer / partnership fact about the target company that could be restated in the form: "I saw that [company] [specific fact]." Recency does not matter for this criterion. Source format does not matter — first-party blogs, press articles, profile pages, and forum posts can all pass if they contain such a fact.',
      failDefinition:
        'The Content contains only generic structural descriptions (founded year, HQ city, what the company does, pricing tiers, employee count) with no named event, change, or specific development.',
      unclearDefinition:
        'The Content is too short or empty to tell whether it contains a quotable fact.',
      allowedEvidenceSources: ['content'],
    },
    {
      key: 'recentOrStructural',
      name: 'RECENT_OR_STRUCTURAL',
      question:
        'Is the result either (a) news-shaped and dated on or after ' +
        cutoffDate +
        ', or (b) about stable structural facts where freshness does not matter?',
      passDefinition:
        '(a) The result describes a dated event (announcement, launch, funding round, quarterly result, hire, partnership) AND the event date — visible in Content or in the Published date field — is on or after ' +
        cutoffDate +
        '. OR (b) The Content describes only enduring structural facts about the company — founders, product category, business model, core long-running product capabilities, HQ, customer segment — where recency is not relevant.',
      failDefinition:
        'The result describes a dated event with a visible date earlier than ' +
        cutoffDate +
        '. Outdatedness is determined by date alone — do not require proof the event has been superseded.',
      unclearDefinition:
        'No publication date is visible in either Content or the Published date field, AND the Content is event-shaped so structural-fact handling does not apply.',
      allowedEvidenceSources: ['content', 'published_date'],
    },
    {
      key: 'notNoise',
      name: 'NOT_NOISE',
      question: 'Does the Content contain extractable, substantive narrative?',
      passDefinition:
        'EITHER (a) the visible Content contains at least two complete sentences of source-specific narrative about the target company with a coherent claim beyond names, titles, employee counts, or contact details, OR (b) the Content contains at least one full sentence that names a specific company-specific event, metric, partnership, hire, or development. Note: source classification (aggregator vs trade press vs spam) is judged separately — here you are only judging whether the visible text is substantive narrative.',
      failDefinition:
        'The Content is mostly templated metadata, keyword stuffing, structured profile fields with no narrative, parked / dead pages, no-preview paywall pages, login walls with no visible content, or auto-generated boilerplate.',
      unclearDefinition:
        'Content is too short (under one full sentence) to assess narrative quality.',
      allowedEvidenceSources: ['content'],
    },
  ]
}

function buildContext(
  company: CompanyContext,
  result: SearchResult,
  runDate: string,
): string {
  const ctx = [
    `Company name: ${company.name}`,
    `Company domain: ${company.domain}`,
    company.oneLiner ? `Company one-liner: ${company.oneLiner}` : null,
    company.industry ? `Industry: ${company.industry}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return `# Benchmark run date
${runDate}

# Target company
${ctx}

# Search result
URL: ${result.url}
Title: ${result.title}
Published date: ${result.publishedDate ?? '(not provided)'}
Content:
"""
${result.content || '(empty)'}
"""`
}

function describeAllowedSources(allowed: EvidenceSource[]): string {
  const labels: Record<EvidenceSource, string> = {
    content: 'the Content block',
    title: 'the Title field',
    url: 'the URL field',
    published_date: 'the Published date field',
  }
  return allowed.map((s) => labels[s]).join(' or ')
}

function buildCriterionPrompt(
  spec: CriterionSpec,
  company: CompanyContext,
  result: SearchResult,
  runDate: string,
): string {
  const allowedList = spec.allowedEvidenceSources
    .map((s) => `"${s}"`)
    .join(' | ')
  const allowedDescription = describeAllowedSources(spec.allowedEvidenceSources)

  return `${buildContext(company, result, runDate)}

# Criterion: ${spec.name}

${spec.question}

PASS if: ${spec.passDefinition}

FAIL if: ${spec.failDefinition}

UNCLEAR if: ${spec.unclearDefinition}

# Evidence quote rules

For this criterion, evidence may come from: ${allowedDescription}.

- Pick the single field your verdict actually rests on, set "evidence_source" to its identifier (${allowedList}), and quote from THAT field only.
- The evidence_quote MUST be a direct, verbatim, case-matching contiguous substring of the chosen field. Do not paraphrase, rewrite, or stitch fragments together.
- Pick the shortest contiguous span (up to ~40 words) that proves the verdict. For URL or Published date evidence, the quote is typically the full field value or a relevant slug.
- The company name alone is NEVER sufficient evidence — the quote must show the property the criterion is testing.
- For FAIL verdicts, quote the most relevant visible span that supports your reasoning, and explain in reasoning what is missing or contradictory. Do not return an empty quote for a FAIL.
- Only return an empty evidence_quote when the verdict is "unclear" because the relevant fields are genuinely empty or paywalled. In all other cases the quote must be non-empty.

# Output

Output ONLY a single JSON object, no markdown, no prose outside the object:

{
  "evidence_quote": "<verbatim substring of the chosen field, or empty only if verdict is unclear due to empty fields>",
  "evidence_source": ${allowedList},
  "reasoning": "<one short sentence connecting the quote (or its absence) to the verdict>",
  "verdict": "pass" | "fail" | "unclear"
}

Do not consider any criterion other than ${spec.name}. Do not let other dimensions (recency, source reputation, actionability) leak into this verdict unless this criterion explicitly asks about them.`
}

function buildSourceTypePrompt(
  company: CompanyContext,
  result: SearchResult,
  runDate: string,
): string {
  return `${buildContext(company, result, runDate)}

# Task: classify the source type

Classify this search result's source into exactly one category, using observable signals (URL host, page formatting visible in Content, structural cues) — not domain reputation or general knowledge.

Categories:

- "first_party": the URL host is the target company's own domain or a direct subdomain of it (e.g. host = ${company.domain} or *.${company.domain}).
- "trade_press": editorial article or report with a visible byline, outlet name, or article-style formatting (headline followed by paragraphs of original prose, often with a publication date).
- "aggregator": profile / database / directory / listing page where the visible Content is mostly structured fields (employees, competitors, contact info, founding date) rather than narrative.
- "forum": user-generated post, thread, or comment (Reddit, Hacker News, Discord, X/Twitter, LinkedIn posts, etc.).
- "spam": page with visible SEO-template indicators — keyword-stuffed listicle, autogenerated content, content-farm patterns, "top 10 [category]" formats with no original analysis.
- "other": anything that doesn't fit the above (e.g., GitHub repos, SEC filings, academic papers, regulatory pages).

Precedence rules when more than one category could apply:

1. If the visible Content shows clear SEO-template indicators (keyword stuffing, listicle format, autogenerated patterns), classify as "spam" regardless of host.
2. Otherwise, if the visible Content is mostly structured profile fields rather than narrative, classify as "aggregator" regardless of host.
3. Otherwise, if the URL host matches the target company's domain or a direct subdomain, classify as "first_party".
4. Otherwise apply the remaining categories above.

Output ONLY a single JSON object:

{
  "source_type": "first_party" | "trade_press" | "aggregator" | "forum" | "spam" | "other",
  "reasoning": "<one short sentence pointing to the observable signal that justifies the classification>"
}`
}

interface RawCriterionJson {
  evidence_quote: unknown
  evidence_source: unknown
  reasoning: unknown
  verdict: unknown
}

interface RawSourceTypeJson {
  source_type: unknown
  reasoning: unknown
}

interface ParsedJson<T> {
  parsed: T
  strictJson: boolean
}

function parseJsonObject<T>(text: string): ParsedJson<T> {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new Error(`Judge output is not JSON: ${text.slice(0, 200)}`)
  }
  // strictJson = the model emitted exactly {...} with no surrounding prose.
  // Looser outputs are still parseable (we slice between braces) but the
  // flag lets the eval runner surface instruction-following quality.
  const strictJson = start === 0 && end === trimmed.length - 1
  return {
    parsed: JSON.parse(trimmed.slice(start, end + 1)) as T,
    strictJson,
  }
}

function asVerdict(v: unknown): Verdict {
  if (v === 'pass' || v === 'fail' || v === 'unclear') return v
  return 'unclear'
}

const ALL_SOURCES: EvidenceSource[] = ['content', 'title', 'url', 'published_date']

function asEvidenceSource(v: unknown): EvidenceSource | null {
  if (typeof v === 'string' && (ALL_SOURCES as string[]).includes(v)) {
    return v as EvidenceSource
  }
  return null
}

const ALL_SOURCE_TYPES: SourceType[] = [
  'first_party',
  'trade_press',
  'aggregator',
  'forum',
  'spam',
  'other',
]

function asSourceType(v: unknown): { value: SourceType; valid: boolean } {
  if (typeof v === 'string' && (ALL_SOURCE_TYPES as string[]).includes(v)) {
    return { value: v as SourceType, valid: true }
  }
  return { value: 'other', valid: false }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function getSourceField(result: SearchResult, source: EvidenceSource): string {
  switch (source) {
    case 'content':
      return result.content
    case 'title':
      return result.title
    case 'url':
      return result.url
    case 'published_date':
      return result.publishedDate ?? ''
  }
}

function normalizeTypography(s: string): string {
  // Models reliably casualize typographic punctuation when copying
  // (smart quotes → ASCII, em/en dashes → hyphen, ellipsis → three dots).
  // We map both source and quote into the same casual form before the
  // substring check so the validation doesn't reject otherwise-faithful
  // quotes for unicode the model can't reasonably preserve. Genuine
  // fabrications still fail because they involve different *words*, not
  // just different glyphs.
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
}

function isVerbatimSubstring(quote: string, source: string): boolean {
  if (quote.length === 0) return false
  // Strict, case-sensitive match first — the prompt says "verbatim,
  // case-matching." We deliberately do NOT lowercase. Two layered fallbacks:
  // typographic normalization (smart quotes, dashes, ellipsis) and then
  // whitespace collapsing. Both must remain strict on actual letters.
  if (source.includes(quote)) return true
  const normSource = normalizeTypography(source)
  const normQuote = normalizeTypography(quote)
  if (normSource.includes(normQuote)) return true
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
  return collapse(normSource).includes(collapse(normQuote))
}

export class Judge {
  private readonly client: Anthropic
  private readonly model: string
  readonly runDate: Date
  readonly cutoffDate: Date
  readonly criteria: CriterionSpec[]

  constructor(apiKey: string, opts: JudgeOptions = {}) {
    this.client = new Anthropic({ apiKey })
    this.model = opts.model ?? 'claude-sonnet-4-6'
    this.runDate = opts.runDate ?? new Date()
    this.cutoffDate = new Date(
      this.runDate.getTime() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    )
    this.criteria = buildCriteria(toIsoDate(this.cutoffDate))
  }

  async judge(company: CompanyContext, result: SearchResult): Promise<JudgeVerdict> {
    // Each criterion runs in its own prompt to avoid spillover bias —
    // sharing a chain-of-thought across criteria lets early verdicts anchor
    // later ones. Source-type runs as a 5th categorical prompt; it's a
    // diagnostic slice, not part of the boolean composition.
    const [criterionResults, sourceTypeResult] = await Promise.all([
      Promise.all(this.criteria.map((spec) => this.runCriterion(spec, company, result))),
      this.runSourceType(company, result),
    ])

    const byKey = Object.fromEntries(
      this.criteria.map((spec, i) => [spec.key, criterionResults[i]!]),
    ) as Record<CriterionSpec['key'], CriterionResult>

    // Two-tier composition:
    //   retrievalRelevant = on_topic AND not_noise — "usable for research"
    //   salesTrigger     = retrievalRelevant AND actionableSignal AND recent
    //
    // Strict variants: 'unclear' on any required criterion collapses to false.
    // The eval runner can recompute "non-missing" variants from the raw
    // verdicts if it wants to exclude unclear cases from the denominator.
    const retrievalRelevant =
      byKey.onTopic.verdict === 'pass' && byKey.notNoise.verdict === 'pass'
    const salesTrigger =
      retrievalRelevant &&
      byKey.actionableSignal.verdict === 'pass' &&
      byKey.recentOrStructural.verdict === 'pass'

    const unclearCount =
      (byKey.onTopic.verdict === 'unclear' ? 1 : 0) +
      (byKey.actionableSignal.verdict === 'unclear' ? 1 : 0) +
      (byKey.recentOrStructural.verdict === 'unclear' ? 1 : 0) +
      (byKey.notNoise.verdict === 'unclear' ? 1 : 0)

    return {
      onTopic: byKey.onTopic,
      actionableSignal: byKey.actionableSignal,
      recentOrStructural: byKey.recentOrStructural,
      notNoise: byKey.notNoise,
      sourceType: sourceTypeResult,
      retrievalRelevant,
      salesTrigger,
      unclearCount,
    }
  }

  private async runCriterion(
    spec: CriterionSpec,
    company: CompanyContext,
    result: SearchResult,
  ): Promise<CriterionResult> {
    const prompt = buildCriterionPrompt(spec, company, result, toIsoDate(this.runDate))
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 400,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })

    const block = resp.content.find((c) => c.type === 'text')
    if (!block || block.type !== 'text') {
      throw new Error(`Judge (${spec.name}) returned no text content`)
    }

    const { parsed, strictJson } = parseJsonObject<RawCriterionJson>(block.text)
    let verdict = asVerdict(parsed.verdict)
    const evidenceQuote = asString(parsed.evidence_quote)
    const reasoning = asString(parsed.reasoning)
    const declaredSource = asEvidenceSource(parsed.evidence_source)
    // If the model returned an unrecognised evidence_source, default to
    // 'content' so we can still attempt validation; quoteValidated will
    // capture the failure.
    const evidenceSource: EvidenceSource = declaredSource ?? 'content'

    let quoteValidated: boolean
    if (evidenceQuote.trim() === '') {
      // Empty quote is only legitimate when verdict is unclear and the
      // relevant fields really are empty/paywalled. Otherwise force unclear:
      // a pass or fail verdict with no evidence quote is exactly the
      // hallucination shape the substring check is meant to catch.
      if (verdict !== 'unclear') {
        verdict = 'unclear'
        quoteValidated = false
      } else {
        quoteValidated = true
      }
    } else if (
      declaredSource === null ||
      !spec.allowedEvidenceSources.includes(declaredSource)
    ) {
      // Either no source declared, or the model picked a field this
      // criterion isn't allowed to rely on (e.g. quoting URL for
      // ACTIONABLE_SIGNAL). Treat as unclear.
      verdict = 'unclear'
      quoteValidated = false
    } else {
      const sourceText = getSourceField(result, declaredSource)
      quoteValidated = isVerbatimSubstring(evidenceQuote, sourceText)
      if (!quoteValidated) {
        verdict = 'unclear'
      }
    }

    return {
      verdict,
      evidenceQuote,
      evidenceSource,
      reasoning,
      quoteValidated,
      strictJson,
    }
  }

  private async runSourceType(
    company: CompanyContext,
    result: SearchResult,
  ): Promise<SourceTypeResult> {
    const prompt = buildSourceTypePrompt(company, result, toIsoDate(this.runDate))
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 200,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })

    const block = resp.content.find((c) => c.type === 'text')
    if (!block || block.type !== 'text') {
      throw new Error('Judge (source_type) returned no text content')
    }

    const { parsed, strictJson } = parseJsonObject<RawSourceTypeJson>(block.text)
    const { value, valid } = asSourceType(parsed.source_type)
    return {
      value,
      reasoning: asString(parsed.reasoning),
      valid,
      strictJson,
    }
  }
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
