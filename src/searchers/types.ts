export interface SearchResult {
  url: string
  title: string
  content: string
  publishedDate: string | null
}

export interface SearchInput {
  query: string
  numResults?: number
}

export interface Searcher {
  readonly name: string
  search(input: SearchInput): Promise<SearchResult[]>
}
