# exa-search-benchmark

This is a benchmark for evaluating search APIs on company research retrieval. Given a company, this benchmark tests a search API's ability to find recent, useful, company-specific information that someone like a salesperson, recruiter, or VC analyst would want.

I decided to build this benchmark for this specific use case because I built a cold-email automation tool called [Sparrow](https://github.com/cx18121/sparrow) that uses Exa to do research on specific startups in order to provide context to draft personalized outreach emails.

When building Sparrow, I was trying to decide between a few different search APIs, including Tavily, Brave, Claude web search, and Exa. I wanted to find the best search API that would provide me relevant information that I could incorporate into my emails, but I didn't have a proper way to benchmark it then.

## What it measures

Two tracks:

- **Track 1** (`npm run eval`) — per-result pointwise eval. Each retrieved result is scored on whether it's about the target company, contains an actual recent development, and comes from a reputable source.
- **Track 2** (`npm run eval:agent`) — A research agent runs a multi step loop using the search API as a tool, produces a structured brief (recent launches, leadership changes, strategic shifts, 3–5 outreach hooks), and the brief is scored. This is how I actually use the search API for Sparrow.

Each Track 2 run is scored through three independent parameters:

1. **Pointwise judge** with explicit rubric using Claude Sonnet 4.6 as the judge, scores each brief from 0-5
2. **Pairwise judge** compares Exa and Tavily produced briefs side-by-side, run twice with order swapped, only consistent verdicts count.
3. **Objective metrics** with no judge: distinct domains, primary-source rate, median age of dated content, tokens per usable hook.

## Results

| Metric                      | Exa          | Tavily   |
| --------------------------- | ------------ | -------- |
| Pointwise overall (1–5)     | **4.60**     | 3.53     |
| Usable hooks per brief      | **4.33 / 5** | 2.40 / 5 |
| Median age of dated content | **66d**      | 177d     |
| Tokens per usable hook      | **7,152**    | 11,655   |
| Distinct domains cited      | 4.20         | **4.80** |

**Pairwise (15 head-to-head comparisons, run with order swapped):**

| Outcome                                    | Count      |
| ------------------------------------------ | ---------- |
| Exa wins (consistent on both orderings)    | 2          |
| Tavily wins (consistent on both orderings) | 4          |
| Ties (both orderings agree it's a tie)     | 0          |
| Inconsistent — judge flipped on order swap | **9 / 15** |

I ran this benchmark on 15 startups from [`data/companies.json`](data/companies.json), and the information about each company was pulled directly from my database of startups that I'm using for Sparrow. There were 5 seed stage, 5 Series A, and 5 Series B.

The pointwise and pairwise judges _disagree_, and that disagreement is an important finding. Pointwise (rubric-anchored) says Exa wins overall, while the pairwise comparison (without the rubric) favors Tavily's slightly fuller-looking briefs and flips on order swap 60% of the time.

The 9/15 pairwise inconsistency rate is also interesting. Position bias of 30–60% on close comparisons is consistent with published LLM-judge research (Arena-Hard, AlpacaEval, G-Eval), which is when two outputs are close on the dimensions the judge cares about, whichever one is shown first tends to win.

My takeaway from this is that the pairwise test alone is unreliable for close comparisons, and the rubric based pointwise comparison and objective metrics are the tests that are more relevant. Based on those tests, Exa wins over Tavily, which is good to know for me so I know to continue using Exa for Sparrow.

Full results: [`results/agent-2026-05-08.json`](results/agent-2026-05-08.json).

## With more time

I would scale to test more companies at a variety of stages, including pre-seed companies. I'd also add Brave / Perplexity / Claude web search. Also add more LLM models as judges (ex. GPT/Gemini/Kimi).

I'd also add edge/adversial cases, so companies with the same name as another company, recent rebrands, and non-US companies.

## How to run

```bash
cp .env.example .env       # EXA_API_KEY, TAVILY_API_KEY, ANTHROPIC_API_KEY
npm install

npm run eval                              # per result
npm run eval:agent -- --per-stage 5       # agent eval, 5 companies per stage = 15 total
```

## How to add a new search API

Implement the `Searcher` interface in `src/searchers/types.ts`:

```ts
class MySearcher implements Searcher {
  readonly name = 'my-api'
  async search(input: SearchInput): Promise<SearchResult[]> { ... }
}
```

Register it in `src/run-eval.ts` or `src/run-agent-eval.ts`.
