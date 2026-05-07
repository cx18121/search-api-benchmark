import type { Searcher, SearchInput, SearchResult } from './types.js'

const EXA_URL = 'https://api.exa.ai/search'

interface RawExaResult {
  url?: unknown
  title?: unknown
  text?: unknown
  publishedDate?: unknown
}

export class ExaSearcher implements Searcher {
  readonly name = 'exa'

  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      type?: 'auto' | 'neural' | 'keyword'
      recencyDays?: number | null
      textMaxCharacters?: number
    } = {},
  ) {}

  async search(input: SearchInput): Promise<SearchResult[]> {
    const numResults = input.numResults ?? 5
    const body: Record<string, unknown> = {
      query: input.query,
      numResults,
      type: this.opts.type ?? 'auto',
      contents: {
        text: { maxCharacters: this.opts.textMaxCharacters ?? 2000 },
      },
    }
    if (this.opts.recencyDays && this.opts.recencyDays > 0) {
      body.startPublishedDate = new Date(
        Date.now() - this.opts.recencyDays * 24 * 60 * 60 * 1000,
      ).toISOString()
    }

    const resp = await fetch(EXA_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Exa ${resp.status}: ${text || 'request failed'}`)
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
  const r = raw as RawExaResult
  if (typeof r.url !== 'string') return null
  return {
    url: r.url,
    title: typeof r.title === 'string' ? r.title : '',
    content: typeof r.text === 'string' ? r.text : '',
    publishedDate: typeof r.publishedDate === 'string' ? r.publishedDate : null,
  }
}
