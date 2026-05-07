import type { Searcher, SearchInput, SearchResult } from './types.js'

const TAVILY_URL = 'https://api.tavily.com/search'

interface RawTavilyResult {
  url?: unknown
  title?: unknown
  content?: unknown
  published_date?: unknown
}

export class TavilySearcher implements Searcher {
  readonly name = 'tavily'

  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      searchDepth?: 'basic' | 'advanced'
      days?: number | null
    } = {},
  ) {}

  async search(input: SearchInput): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query: input.query,
      max_results: input.numResults ?? 5,
      search_depth: this.opts.searchDepth ?? 'advanced',
    }
    if (this.opts.days && this.opts.days > 0) {
      body.days = this.opts.days
    }

    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Tavily ${resp.status}: ${text || 'request failed'}`)
    }

    const data = (await resp.json()) as { results?: unknown[] }
    if (!Array.isArray(data.results)) return []

    return data.results
      .map((raw) => normalize(raw))
      .filter((r): r is SearchResult => r !== null)
  }
}

function normalize(raw: unknown): SearchResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawTavilyResult
  if (typeof r.url !== 'string') return null
  return {
    url: r.url,
    title: typeof r.title === 'string' ? r.title : '',
    content: typeof r.content === 'string' ? r.content : '',
    publishedDate: typeof r.published_date === 'string' ? r.published_date : null,
  }
}
