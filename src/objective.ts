import type { ResearchBrief, AgentTrace, CompanyContext } from './agent.js'

// Objective metrics computed directly from the brief + agent trace, with no
// LLM judge calls. These triangulate the judge's verdict with reproducible
// numbers — domain diversity, primary-source rate, recency, and search/cost
// efficiency. Reported alongside (not in place of) the judge scores.
export interface ObjectiveMetrics {
  totalSourceUrls: number
  distinctDomains: number
  primarySourceRate: number        // 0-1, share of URLs on company.domain
  thirdPartyRate: number           // 0-1, 1 - primary; the "echo chamber" guard
  zeroResultSearchRate: number     // 0-1, share of search calls that returned 0
  totalSearchCalls: number
  medianDatedAgeDays: number | null  // null when no items have parseable `when`
  datedItemCount: number
  hooksPerSearchCall: number       // raw efficiency
  tokensPerUsableHook: number | null  // null when score missing or 0 usable
  totalTokens: number
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function isPrimaryDomain(host: string, companyDomain: string): boolean {
  const target = companyDomain.toLowerCase().replace(/^www\./, '')
  return host === target || host.endsWith('.' + target)
}

function collectUrls(brief: ResearchBrief): string[] {
  const urls: string[] = []
  for (const x of brief.recentLaunches) if (x.sourceUrl) urls.push(x.sourceUrl)
  for (const x of brief.leadershipChanges) if (x.sourceUrl) urls.push(x.sourceUrl)
  for (const x of brief.strategicShifts) if (x.sourceUrl) urls.push(x.sourceUrl)
  for (const x of brief.outreachHooks) if (x.sourceUrl) urls.push(x.sourceUrl)
  return urls
}

// Best-effort date parser. The `when` field is freeform — the agent might
// write "2026-02-15", "February 2026", "Feb 2026", "Q1 2026", "unknown", or
// "". We accept anything Date.parse handles plus YYYY-MM and a couple of
// month-name forms; otherwise return null and the item is excluded from the
// median.
function parseWhen(when: string): Date | null {
  if (!when) return null
  const trimmed = when.trim()
  if (!trimmed || /^unknown$/i.test(trimmed) || /^n\/a$/i.test(trimmed)) return null
  // Native Date.parse handles ISO ("2026-02-15"), RFC ("Feb 15, 2026"), and
  // most month-name forms in V8.
  const direct = Date.parse(trimmed)
  if (Number.isFinite(direct)) return new Date(direct)
  // YYYY-MM (e.g. "2026-02") — Date.parse handles this in V8 but make it explicit.
  const ymOnly = /^(\d{4})-(\d{1,2})$/.exec(trimmed)
  if (ymOnly) {
    const y = parseInt(ymOnly[1]!, 10)
    const m = parseInt(ymOnly[2]!, 10)
    if (m >= 1 && m <= 12) return new Date(Date.UTC(y, m - 1, 15))
  }
  return null
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2
  return sorted[mid]!
}

export function computeObjective(
  brief: ResearchBrief,
  trace: AgentTrace,
  company: CompanyContext,
  runDate: Date,
  hooksUsable: number | null = null,
): ObjectiveMetrics {
  const urls = collectUrls(brief)
  const hosts = urls.map(safeHostname).filter((h): h is string => h !== null)
  const distinctDomains = new Set(hosts).size

  const primaryCount = hosts.filter((h) => isPrimaryDomain(h, company.domain)).length
  const totalUrls = hosts.length
  const primaryRate = totalUrls === 0 ? 0 : primaryCount / totalUrls

  const totalSearches = trace.searchCalls.length
  const zeroResults = trace.searchCalls.filter((s) => s.numResults === 0).length
  const zeroResultRate = totalSearches === 0 ? 0 : zeroResults / totalSearches

  const datedItems = [
    ...brief.recentLaunches,
    ...brief.leadershipChanges,
    ...brief.strategicShifts,
  ]
  const ages: number[] = []
  for (const item of datedItems) {
    const d = parseWhen(item.when)
    if (!d) continue
    const ageMs = runDate.getTime() - d.getTime()
    // Negative ages (future-dated typos) are kept so they show up in audits
    // rather than silently dropped.
    ages.push(Math.round(ageMs / (24 * 60 * 60 * 1000)))
  }
  const medianAge = ages.length === 0 ? null : median(ages)

  const hooksTotal = brief.outreachHooks.length
  const hooksPerCall = totalSearches === 0 ? 0 : hooksTotal / totalSearches

  const totalTokens = trace.inputTokens + trace.outputTokens
  const tokensPerHook =
    hooksUsable !== null && hooksUsable > 0 ? totalTokens / hooksUsable : null

  return {
    totalSourceUrls: totalUrls,
    distinctDomains,
    primarySourceRate: primaryRate,
    thirdPartyRate: 1 - primaryRate,
    zeroResultSearchRate: zeroResultRate,
    totalSearchCalls: totalSearches,
    medianDatedAgeDays: medianAge,
    datedItemCount: ages.length,
    hooksPerSearchCall: hooksPerCall,
    tokensPerUsableHook: tokensPerHook,
    totalTokens,
  }
}
