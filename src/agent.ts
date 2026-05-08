import Anthropic from '@anthropic-ai/sdk'
import type { Searcher, SearchResult } from './searchers/types.js'
import type { CompanyContext } from './judge.js'

export type { CompanyContext }

export interface BriefItem {
  what: string
  when: string
  sourceUrl: string
  evidenceQuote: string
}

export interface OutreachHook {
  hook: string
  sourceUrl: string
  rationale: string
  evidenceQuote: string
}

export interface ResearchBrief {
  recentLaunches: BriefItem[]
  leadershipChanges: BriefItem[]
  strategicShifts: BriefItem[]
  outreachHooks: OutreachHook[]
}

export interface AgentTrace {
  searchCalls: { query: string; numResults: number; elapsedMs: number }[]
  iterations: number
  inputTokens: number
  outputTokens: number
  stoppedReason: 'submitted' | 'max_iterations' | 'agent_ended' | 'error'
  error: string | null
}

export interface AgentResult {
  brief: ResearchBrief | null
  trace: AgentTrace
}

export interface AgentOptions {
  model?: string
  maxIterations?: number
  numResultsPerSearch?: number
  recencyDays?: number
}

const DEFAULT_MAX_ITERATIONS = 8
const DEFAULT_NUM_RESULTS = 5

const SEARCH_TOOL = {
  name: 'search',
  description:
    'Search the web for recent, specific information about the target company. Use targeted queries — searching for the company name alone wastes calls; instead search for specific things you want to find (e.g. "{company} Series A funding 2026" or "{company} CEO hire" or "{company} new product launch site:{company}.com").',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'The search query. Be specific — include the company name and at least one targeted modifier (date, event type, person, product).',
      },
    },
    required: ['query'],
  },
}

const SUBMIT_BRIEF_TOOL = {
  name: 'submit_brief',
  description:
    'Submit the final research brief. Call this when additional searches are unlikely to improve the brief. Empty sections are allowed — partial coverage is better than fabrication. Calling this ends the research session.',
  input_schema: {
    type: 'object' as const,
    properties: {
      recent_launches: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            what: { type: 'string' as const, description: 'What the company launched or shipped.' },
            when: { type: 'string' as const, description: 'When it happened (date or "unknown").' },
            source_url: { type: 'string' as const, description: 'The URL where you saw this.' },
            evidence_quote: { type: 'string' as const, description: 'A short verbatim quote (8-40 words) from the search result snippet at this URL that supports this item. Required to discourage fabrication.' },
          },
          required: ['what', 'when', 'source_url', 'evidence_quote'],
        },
      },
      leadership_changes: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            what: { type: 'string' as const, description: 'The hire, departure, or role change.' },
            when: { type: 'string' as const, description: 'When it happened.' },
            source_url: { type: 'string' as const, description: 'Source URL.' },
            evidence_quote: { type: 'string' as const, description: 'Short verbatim quote from the snippet at this URL.' },
          },
          required: ['what', 'when', 'source_url', 'evidence_quote'],
        },
      },
      strategic_shifts: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            what: { type: 'string' as const, description: 'The strategic change (new market, partnership, pivot, etc).' },
            when: { type: 'string' as const, description: 'When it happened (date or "unknown" if undated).' },
            source_url: { type: 'string' as const, description: 'Source URL.' },
            evidence_quote: { type: 'string' as const, description: 'Short verbatim quote from the snippet at this URL.' },
          },
          required: ['what', 'when', 'source_url', 'evidence_quote'],
        },
      },
      outreach_hooks: {
        type: 'array' as const,
        description: 'Three to five specific things a salesperson could mention in a personalized cold email.',
        items: {
          type: 'object' as const,
          properties: {
            hook: { type: 'string' as const, description: 'A one-sentence opener referencing a specific company-specific fact.' },
            source_url: { type: 'string' as const, description: 'The URL backing this hook.' },
            rationale: { type: 'string' as const, description: 'Why this hook works for outreach.' },
            evidence_quote: { type: 'string' as const, description: 'Short verbatim quote from the snippet at the source URL that backs the hook.' },
          },
          required: ['hook', 'source_url', 'rationale', 'evidence_quote'],
        },
      },
    },
    required: ['recent_launches', 'leadership_changes', 'strategic_shifts', 'outreach_hooks'],
  },
}

function buildSystemPrompt(maxIterations: number, recencyDays: number): string {
  return `You are a research analyst preparing a brief for someone writing personalized B2B outreach about the target company. The recipient could be a salesperson, a BDR, a recruiter, a VC analyst, a partnerships lead, or anyone making a specific first contact with the company. Your job is to produce a structured research brief that gives them the raw material for a personalized message.

# Search budget
You have at most ${maxIterations} search calls. Use them wisely — start broad, then narrow into specific events. Do not repeat near-duplicate queries.

# What to find
Aim to fill four sections:
1. **Recent launches** — products, features, releases, expansions in the last ${recencyDays} days
2. **Leadership changes** — exec hires, departures, role changes
3. **Strategic shifts** — new markets, partnerships, pivots, public statements
4. **Outreach hooks** — 3-5 specific things the writer could open with (each hook must reference a specific company-specific fact, not generic positioning)

# Quality bar for hooks
A good hook is restateable as: "I saw that [company] [specific fact] — [reason this matters in context]." Generic hooks like "I see you focus on AI" do not count. Specific hooks like "I saw you launched X feature on March 4" do. The same hook should work whether the writer is pitching a product, recruiting an engineer, exploring a partnership, or scoping an investment — what matters is that the fact is specific, recent, and verifiable.

# When to stop
Call \`submit_brief\` when ANY of these conditions hold:
- You have 3-5 specific outreach hooks each backed by a recent event
- Two consecutive searches have returned no new specific facts
- The search budget is exhausted
- Further searches would duplicate ground already covered

Empty sections are allowed — partial coverage is better than fabrication.

# Critical anti-fabrication rules
- Every brief item MUST cite a source_url from your actual search results.
- Every brief item MUST include an evidence_quote: a short verbatim phrase (8-40 words) from the result snippet at that URL that supports the item.
- Do not invent dates, names, or events. If the snippet doesn't mention a date, set when="unknown" rather than guessing.
- Do not extrapolate. If the snippet says "launched X feature in beta," do not claim "launched X feature publicly."`
}

function buildInitialMessage(company: CompanyContext): string {
  const parts = [
    `# Target company`,
    `Name: ${company.name}`,
    `Domain: ${company.domain}`,
  ]
  if (company.oneLiner) parts.push(`One-liner: ${company.oneLiner}`)
  if (company.industry) parts.push(`Industry: ${company.industry}`)
  parts.push(``)
  parts.push(`Begin researching. Make your first search call.`)
  return parts.join('\n')
}

function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `Search query: ${query}\nNo results returned.`
  const blocks: string[] = [`Search query: ${query}`, `${results.length} results:`, '']
  results.forEach((r, i) => {
    blocks.push(`[${i + 1}] ${r.title}`)
    blocks.push(`    URL: ${r.url}`)
    blocks.push(`    Published: ${r.publishedDate ?? '(not provided)'}`)
    const content = r.content.length > 1500 ? r.content.slice(0, 1500) + '…' : r.content
    blocks.push(`    Content: ${content}`)
    blocks.push('')
  })
  return blocks.join('\n')
}

interface RawBriefItem {
  what?: unknown
  when?: unknown
  source_url?: unknown
  evidence_quote?: unknown
}

interface RawHook {
  hook?: unknown
  source_url?: unknown
  rationale?: unknown
  evidence_quote?: unknown
}

interface RawBrief {
  recent_launches?: unknown
  leadership_changes?: unknown
  strategic_shifts?: unknown
  outreach_hooks?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseBrief(raw: unknown): ResearchBrief {
  const r = (raw && typeof raw === 'object' ? raw : {}) as RawBrief
  const recent = Array.isArray(r.recent_launches) ? r.recent_launches : []
  const leadership = Array.isArray(r.leadership_changes) ? r.leadership_changes : []
  const strategic = Array.isArray(r.strategic_shifts) ? r.strategic_shifts : []
  const hooks = Array.isArray(r.outreach_hooks) ? r.outreach_hooks : []

  const parseItem = (x: unknown): BriefItem => {
    const item = (x && typeof x === 'object' ? x : {}) as RawBriefItem
    return {
      what: asString(item.what),
      when: asString(item.when),
      sourceUrl: asString(item.source_url),
      evidenceQuote: asString(item.evidence_quote),
    }
  }

  return {
    recentLaunches: recent.map(parseItem),
    leadershipChanges: leadership.map(parseItem),
    strategicShifts: strategic.map(parseItem),
    outreachHooks: hooks.map((x) => {
      const item = (x && typeof x === 'object' ? x : {}) as RawHook
      return {
        hook: asString(item.hook),
        sourceUrl: asString(item.source_url),
        rationale: asString(item.rationale),
        evidenceQuote: asString(item.evidence_quote),
      }
    }),
  }
}

export class ResearchAgent {
  private readonly client: Anthropic
  private readonly model: string
  private readonly maxIterations: number
  private readonly numResults: number
  private readonly recencyDays: number

  constructor(apiKey: string, opts: AgentOptions = {}) {
    this.client = new Anthropic({ apiKey })
    this.model = opts.model ?? 'claude-sonnet-4-6'
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
    this.numResults = opts.numResultsPerSearch ?? DEFAULT_NUM_RESULTS
    this.recencyDays = opts.recencyDays ?? 90
  }

  async research(company: CompanyContext, searcher: Searcher): Promise<AgentResult> {
    const trace: AgentTrace = {
      searchCalls: [],
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      stoppedReason: 'agent_ended',
      error: null,
    }
    let brief: ResearchBrief | null = null

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: buildInitialMessage(company) },
    ]
    const system = buildSystemPrompt(this.maxIterations, this.recencyDays)
    const allTools = [SEARCH_TOOL, SUBMIT_BRIEF_TOOL]
    const submitOnlyTools = [SUBMIT_BRIEF_TOOL]

    let consecutiveNoToolTurns = 0
    const maxLoops = this.maxIterations + 4

    try {
      while (trace.iterations < maxLoops) {
        trace.iterations++

        // Once the search budget is exhausted, restrict tools to submit_brief
        // only AND force the agent to call it via tool_choice. This guarantees
        // we get a brief instead of a polite text suggestion the agent ignores.
        const budgetExhausted = trace.searchCalls.length >= this.maxIterations
        const toolsForCall = budgetExhausted ? submitOnlyTools : allTools

        const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
          model: this.model,
          max_tokens: 4000,
          temperature: 0,
          system,
          tools: toolsForCall,
          messages,
        }
        if (budgetExhausted) {
          requestParams.tool_choice = { type: 'tool', name: 'submit_brief' }
        }

        const resp = await this.client.messages.create(requestParams)
        trace.inputTokens += resp.usage.input_tokens
        trace.outputTokens += resp.usage.output_tokens

        // Append the assistant turn so the conversation stays valid for tool replies.
        messages.push({ role: 'assistant', content: resp.content })

        const toolUses = resp.content.filter((b) => b.type === 'tool_use')
        if (toolUses.length === 0) {
          // Agent returned text only. Nudge once before giving up (Codex
          // review fix #1). One stray text turn is recoverable; two in a row
          // means the agent is stuck.
          consecutiveNoToolTurns++
          if (consecutiveNoToolTurns >= 2) {
            trace.stoppedReason = 'agent_ended'
            break
          }
          messages.push({
            role: 'user',
            content:
              'You must call either the `search` tool or the `submit_brief` tool. Do not respond with text alone.',
          })
          continue
        }
        consecutiveNoToolTurns = 0

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        let submitted = false

        // Process submit_brief first if present — if the agent submitted the
        // brief in the same turn as a search call, the brief can't include
        // those results, so we reply to the search calls with an explanatory
        // tool_result and end the loop after this turn.
        const submitCall = toolUses.find((b) => b.type === 'tool_use' && b.name === 'submit_brief')
        if (submitCall && submitCall.type === 'tool_use') {
          brief = parseBrief(submitCall.input)
          submitted = true
        }

        for (const block of toolUses) {
          if (block.type !== 'tool_use') continue
          if (block.name === 'search') {
            const input = block.input as { query?: unknown }
            const query = typeof input.query === 'string' ? input.query : ''
            if (!query) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: 'Error: search requires a non-empty query string.',
                is_error: true,
              })
              continue
            }
            if (submitted) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: 'Search ignored: submit_brief was issued in the same turn, ending the session.',
                is_error: true,
              })
              continue
            }
            if (trace.searchCalls.length >= this.maxIterations) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Search budget exhausted (${this.maxIterations} calls used). Submit the brief now with what you have.`,
                is_error: true,
              })
              continue
            }
            const t0 = Date.now()
            try {
              const results = await searcher.search({ query, numResults: this.numResults })
              trace.searchCalls.push({
                query,
                numResults: results.length,
                elapsedMs: Date.now() - t0,
              })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: formatSearchResults(query, results),
              })
            } catch (err) {
              trace.searchCalls.push({
                query,
                numResults: 0,
                elapsedMs: Date.now() - t0,
              })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Search error: ${err instanceof Error ? err.message : String(err)}`,
                is_error: true,
              })
            }
          } else if (block.name === 'submit_brief') {
            // Already parsed above; just ack.
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Brief submitted. Research session ended.',
            })
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Unknown tool: ${block.name}`,
              is_error: true,
            })
          }
        }

        messages.push({ role: 'user', content: toolResults })

        if (submitted) {
          trace.stoppedReason = 'submitted'
          break
        }
      }

      if (trace.stoppedReason === 'agent_ended' && trace.iterations >= maxLoops) {
        trace.stoppedReason = 'max_iterations'
      }
    } catch (err) {
      trace.stoppedReason = 'error'
      trace.error = err instanceof Error ? err.message : String(err)
    }

    return { brief, trace }
  }
}
