export type Stage = 'Seed' | 'Series A' | 'Series B'

export const STAGES: Stage[] = ['Series B', 'Series A', 'Seed']

export interface EvalCompany {
  id: string
  name: string
  domain: string
  oneLiner: string | null
  industry: string | null
  stage: Stage
}
