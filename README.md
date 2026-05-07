# exa-search-benchmark

A benchmark for evaluating search APIs on **B2B company research retrieval** — given a company, find recent, useful, company-specific information of the kind a salesperson, recruiter, or VC analyst would want before reaching out.

Inspired by [Sparrow](https://github.com/cx18121/sparrow), a cold-email automation tool that uses Exa to research target companies before drafting personalized outreach. Sparrow's smoke test (`scripts/smoke-exa-vs-tavily.ts`) was scored manually by eye; this benchmark replaces that with an automated AI judge so the comparison is reproducible.

## What this benchmark measures

A search API's ability to surface, given a company name + domain, results that:

1. Are **about the target company** (not noise, not a different company with a similar name, not generic industry content)
2. Contain a **concrete, recent development** (product launch, hire, funding, strategy shift) — not stale or generic content
3. Come from a **reputable source** (the company's own site, a real publication) rather than aggregator spam, SEO-farmed listicles, or off-topic content from the right domain

Each retrieved result is scored on these three axes by an AI judge (Claude). Per-API scores are aggregated across companies.

## Why this matters

Anyone building tools for sales, recruiting, or investment research depends on a search API to power "give me context on this company." Most existing search benchmarks test factual lookup or named entity retrieval — none test the specific shape of "find me recent, actionable signals about this specific company." This benchmark fills that gap.

## Status

In progress. See `tasks/` (TODO) for the build plan.

## How to run

```bash
cp .env.example .env
# fill in EXA_API_KEY, TAVILY_API_KEY, ANTHROPIC_API_KEY
npm install
npm run eval
```

## How to add a new search API

Implement the `Searcher` interface in `src/searchers/types.ts`:

```ts
class MySearcher implements Searcher {
  readonly name = 'my-api'
  async search(input: SearchInput): Promise<SearchResult[]> { ... }
}
```

Register it in `src/run-eval.ts` and re-run.

## Limitations

- Companies are drawn from a real production database (Sparrow), so the distribution skews toward early-stage US/EU SaaS startups. Results may not generalize to other verticals.
- The AI judge introduces some subjectivity. Validation against manual annotations is included (see `npm run judge:validate`).
- 20–30 companies is enough to detect large differences between APIs but not small ones. Treat results as directional.
