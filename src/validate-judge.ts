import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Verdict } from './judge.js';

// Workflow:
//   1. Run the main eval first (`npm run eval -- --limit 3` writes a results JSON).
//   2. Extract a blank annotation template:
//      `npx tsx src/validate-judge.ts --results results/X.json --extract annotations/template.md`
//   3. Manually fill in your own verdicts in the template.
//   4. Validate agreement vs the judge:
//      `npx tsx src/validate-judge.ts --results results/X.json --annotations annotations/template.md`
//
// The template hides judge verdicts so you score independently. The validate
// step reports raw agreement and lists every disagreement for audit.

interface CriterionRecord {
  verdict: Verdict;
  evidenceQuote: string;
  reasoning: string;
}

interface ScoredResult {
  rank: number;
  url: string;
  title: string;
  content: string;
  publishedDate: string | null;
  verdict: {
    onTopic: CriterionRecord;
    actionableSignal: CriterionRecord;
    recentOrStructural: CriterionRecord;
    notNoise: CriterionRecord;
    salesTrigger: boolean;
    retrievalRelevant: boolean;
  } | null;
  judgeError: string | null;
}

interface SearcherRun {
  query: string;
  results: ScoredResult[];
}

interface CompanyRunResult {
  company: {
    id: string;
    name: string;
    domain: string;
    oneLiner: string | null;
    industry: string | null;
    stage: string;
  };
  perSearcher: Record<string, SearcherRun>;
}

interface RunResults {
  metadata: { runDate: string; cutoffDate: string; judgeModel: string };
  companies: CompanyRunResult[];
}

const CRITERIA = [
  'on_topic',
  'actionable_signal',
  'recent_or_structural',
  'not_noise',
] as const;
type Criterion = (typeof CRITERIA)[number];

// Labelable fields = the four criteria + a composite "useful" verdict that
// maps to the judge's salesTrigger boolean. Annotators can fill in just
// 'useful' (composite spot-check, ~30 judgments) or all four criteria
// (per-criterion calibration, 4x the work). The validator handles either.
const LABEL_FIELDS = ['useful', ...CRITERIA] as const;
type LabelField = (typeof LABEL_FIELDS)[number];

interface AnnotationKey {
  companyId: string;
  searcher: string;
  rank: number;
}

function keyOf(k: AnnotationKey): string {
  return `${k.companyId}::${k.searcher}::${k.rank}`;
}

function parseFlag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1] ?? null;
  return null;
}

function buildTemplate(run: RunResults): string {
  const lines: string[] = [];
  lines.push('# Spot-check annotation');
  lines.push('');
  lines.push(
    'For each result, write **pass**, **fail**, or **unclear** after `useful:`.'
  );
  lines.push('');
  lines.push(
    'Question: *"Would I cite this content as a hook in a personalized cold email about this company?"*'
  );
  lines.push('');
  lines.push('Do not edit the `[id ...]` headers.');
  lines.push('');
  lines.push(
    `_Run date: ${run.metadata.runDate.slice(0, 10)} | recency cutoff: ${run.metadata.cutoffDate.slice(0, 10)}_`
  );
  lines.push('');

  for (const c of run.companies) {
    for (const [searcher, sr] of Object.entries(c.perSearcher)) {
      for (const r of sr.results) {
        if (!r.verdict || r.judgeError) continue;
        const k: AnnotationKey = {
          companyId: c.company.id,
          searcher,
          rank: r.rank,
        };
        lines.push('---');
        lines.push('');
        lines.push(`## [id ${keyOf(k)}]`);
        lines.push(
          `**${c.company.name}** (${c.company.stage}) · ${searcher} rank ${r.rank} · published ${r.publishedDate?.slice(0, 10) ?? '(none)'}`
        );
        lines.push('');
        lines.push(`**${r.title}**`);
        lines.push(`<${r.url}>`);
        lines.push('');
        lines.push('```');
        lines.push(r.content || '(empty)');
        lines.push('```');
        lines.push('');
        lines.push('- useful: ');
        lines.push('');
      }
    }
  }
  return lines.join('\n') + '\n';
}

interface Annotations {
  // map from keyOf(AnnotationKey) → { field → verdict }
  [key: string]: Partial<Record<LabelField, Verdict>>;
}

function parseAnnotations(text: string): Annotations {
  const out: Annotations = {};
  const lines = text.split('\n');
  let currentKey: string | null = null;
  const fieldRe =
    /^\s*-\s+(useful|on_topic|actionable_signal|recent_or_structural|not_noise)\s*:\s*(.*)$/;
  for (const line of lines) {
    const headerMatch = line.match(/^##\s*\[id\s+([^\]]+)\]/);
    if (headerMatch) {
      currentKey = headerMatch[1]!.trim();
      out[currentKey] = {};
      continue;
    }
    if (!currentKey) continue;
    const verdictMatch = line.match(fieldRe);
    if (verdictMatch) {
      const field = verdictMatch[1] as LabelField;
      const value = verdictMatch[2]!.trim().toLowerCase();
      if (value === 'pass' || value === 'fail' || value === 'unclear') {
        out[currentKey]![field] = value;
      }
    }
  }
  return out;
}

function agreement(pairs: Array<[Verdict, Verdict]>): {
  agreed: number;
  n: number;
} {
  let agreed = 0;
  for (const [a, b] of pairs) if (a === b) agreed++;
  return { agreed, n: pairs.length };
}

async function main() {
  const resultsPath = parseFlag('--results');
  if (!resultsPath) {
    throw new Error('Pass --results <path-to-results.json>');
  }
  const raw = await readFile(resolve(resultsPath), 'utf8');
  const run = JSON.parse(raw) as RunResults;

  const extractPath = parseFlag('--extract');
  if (extractPath) {
    const md = buildTemplate(run);
    const out = resolve(extractPath);
    await mkdir(dirname(out), { recursive: true }).catch(() => {});
    await writeFile(out, md, 'utf8');
    const numAnnotatable = run.companies.reduce((acc, c) => {
      for (const sr of Object.values(c.perSearcher)) {
        acc += sr.results.filter((r) => r.verdict && !r.judgeError).length;
      }
      return acc;
    }, 0);
    console.log(`Wrote template with ${numAnnotatable} results → ${out}`);
    console.log(
      'Fill in pass/fail/unclear for each criterion, then re-run with --annotations <path>.'
    );
    return;
  }

  const annotationsPath = parseFlag('--annotations');
  if (!annotationsPath) {
    throw new Error(
      'Pass --extract <path> to write a template, or --annotations <path> to validate.'
    );
  }
  const annotationsRaw = await readFile(resolve(annotationsPath), 'utf8');
  const annotations = parseAnnotations(annotationsRaw);
  const annotatedKeys = Object.keys(annotations).filter((k) =>
    LABEL_FIELDS.some((f) => annotations[k]![f])
  );
  if (annotatedKeys.length === 0) {
    throw new Error(
      'No filled-in verdicts found in annotations file. Looked for `- useful: pass` etc.'
    );
  }

  // Build flat lookups of judge verdicts and the underlying result records
  // (for disagreement display). The composite 'useful' field is synthesised
  // from the judge's salesTrigger boolean.
  const judgeLookup = new Map<string, Record<LabelField, Verdict>>();
  const resultLookup = new Map<
    string,
    {
      company: CompanyRunResult['company'];
      searcher: string;
      result: ScoredResult;
    }
  >();
  for (const c of run.companies) {
    for (const [searcher, sr] of Object.entries(c.perSearcher)) {
      for (const r of sr.results) {
        if (!r.verdict || r.judgeError) continue;
        const key = keyOf({ companyId: c.company.id, searcher, rank: r.rank });
        judgeLookup.set(key, {
          useful: r.verdict.salesTrigger ? 'pass' : 'fail',
          on_topic: r.verdict.onTopic.verdict,
          actionable_signal: r.verdict.actionableSignal.verdict,
          recent_or_structural: r.verdict.recentOrStructural.verdict,
          not_noise: r.verdict.notNoise.verdict,
        });
        resultLookup.set(key, { company: c.company, searcher, result: r });
      }
    }
  }

  // Per-field pair lists keyed by result, so disagreements can be inspected
  // with full context (the cases you actually want to read are the disagreements,
  // not the agreement count).
  type ScoredPair = { key: string; human: Verdict; judge: Verdict };
  const perField: Record<LabelField, ScoredPair[]> = {
    useful: [],
    on_topic: [],
    actionable_signal: [],
    recent_or_structural: [],
    not_noise: [],
  };
  let missingJudge = 0;
  for (const key of annotatedKeys) {
    const judge = judgeLookup.get(key);
    if (!judge) {
      missingJudge++;
      continue;
    }
    const human = annotations[key]!;
    for (const f of LABEL_FIELDS) {
      const h = human[f];
      if (!h) continue;
      perField[f].push({ key, human: h, judge: judge[f] });
    }
  }

  console.log(`# Judge validation\n`);
  console.log(`Annotated results: ${annotatedKeys.length}`);
  if (missingJudge > 0)
    console.log(`Skipped (no judge verdict for key): ${missingJudge}`);
  console.log('');

  // Headline: agreement counts per field the user actually labeled.
  console.log('## Agreement\n');
  for (const f of LABEL_FIELDS) {
    const pairs = perField[f];
    if (pairs.length === 0) continue;
    const verdictPairs: Array<[Verdict, Verdict]> = pairs.map((p) => [
      p.human,
      p.judge,
    ]);
    const { agreed, n } = agreement(verdictPairs);
    const headerLabel = f === 'useful' ? `${f} (vs judge.salesTrigger)` : f;
    console.log(
      `  ${headerLabel.padEnd(40)} ${agreed}/${n} (${((agreed / n) * 100).toFixed(0)}%)`
    );
  }
  console.log('');

  // The actually-useful output: every disagreement, with judge reasoning so
  // you can see *why* the judge said what it said and decide whether the
  // rubric or your gut needs to move.
  for (const f of LABEL_FIELDS) {
    const pairs = perField[f];
    if (pairs.length === 0) continue;
    const disagreements = pairs.filter((p) => p.human !== p.judge);
    if (disagreements.length === 0) continue;
    console.log(`## Disagreements on ${f} (${disagreements.length})\n`);
    for (const d of disagreements) {
      const ctx = resultLookup.get(d.key);
      if (!ctx) continue;
      const r = ctx.result;
      console.log(`### ${ctx.company.name} — ${ctx.searcher} rank ${r.rank}`);
      console.log(`URL:   ${r.url}`);
      console.log(`Title: ${r.title}`);
      console.log(`You: ${d.human}   Judge: ${d.judge}`);
      if (f === 'useful') {
        // For composite disagreements, dump the 4 underlying verdicts +
        // reasoning so the user can see exactly what tipped the judge.
        const v = r.verdict!;
        for (const [name, cv] of [
          ['on_topic', v.onTopic],
          ['actionable_signal', v.actionableSignal],
          ['recent_or_structural', v.recentOrStructural],
          ['not_noise', v.notNoise],
        ] as const) {
          console.log(`  judge.${name}: ${cv.verdict} — ${cv.reasoning}`);
        }
      } else {
        // For per-criterion disagreements, show the judge's reasoning + quote
        // for that single criterion only.
        const cv =
          f === 'on_topic'
            ? r.verdict!.onTopic
            : f === 'actionable_signal'
              ? r.verdict!.actionableSignal
              : f === 'recent_or_structural'
                ? r.verdict!.recentOrStructural
                : r.verdict!.notNoise;
        console.log(`  judge reasoning: ${cv.reasoning}`);
        if (cv.evidenceQuote)
          console.log(`  judge evidence:  "${cv.evidenceQuote}"`);
      }
      console.log('');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
