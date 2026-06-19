import { useEffect, useState } from 'react'
import { DonutChart, AreaChart, HBarList, CHART_COLORS, scoreColor, GrowBar } from '../components/charts'
import { PageHeader, Card, Loading, EmptyState } from '../components/ui'

function staggerDelay(i, step = 0.055, cap = 0.48) {
  return `${Math.min(i * step, cap)}s`
}

const SUB_SCORE_LABELS = {
  keyword_match_score: 'Keyword Match',
  semantic_alignment_score: 'Semantic Alignment',
  technical_skills_score: 'Technical Skills',
  experience_relevance_score: 'Experience Relevance',
  project_alignment_score: 'Project Alignment',
  impact_score: 'Resume Impact',
  ats_structure_score: 'ATS Structure',
  recruiter_readability_score: 'Recruiter Readability',
  seniority_fit_score: 'Seniority Fit',
  domain_fit_score: 'Domain Fit',
  tailoring_readiness_score: 'Tailoring Readiness',
}

export default function Analytics() {
  const [data, setData] = useState(null)

  useEffect(() => {
    fetch('/api/analytics').then(r => r.json()).then(setData)
  }, [])

  if (!data) return <Loading />

  const applyData = Object.entries(data.apply_via || {})
    .map(([label, value], i) => ({ label: label.replace('_', ' '), value }))
    .sort((a, b) => b.value - a.value)

  const expData = Object.entries(data.experience_buckets || {})
    .filter(([, v]) => v > 0)
    .map(([label, value]) => ({ label, value }))

  const trend = (data.score_trend || []).map(d => ({ x: d.date.slice(5), y: d.avg_score }))

  const subScores = Object.entries(SUB_SCORE_LABELS)
    .map(([key, label]) => ({ label, value: data.avg_sub_scores?.[key] }))
    .filter(s => s.value != null)
    .sort((a, b) => b.value - a.value)

  const skills = (data.top_skills || []).map(s => ({ label: s.skill, value: s.count }))
  const companies = (data.top_companies || []).map(c => ({
    label: c.company, value: c.cnt, sub: c.avg_score ? `· avg ${c.avg_score}` : '',
  }))
  const locations = (data.locations || []).map(l => ({ label: l.city, value: l.cnt }))

  const CLOUD_COLOR = { aws: 'rgb(var(--warning))', azure: 'rgb(var(--info))', gcp: 'rgb(var(--danger))' }
  const cloudDemand = Object.entries(data.cloud_demand || {})
    .map(([k, v]) => ({ label: k.toUpperCase(), value: v, color: CLOUD_COLOR[k] }))
    .sort((a, b) => b.value - a.value)
  const modelUsage = (data.model_usage || []).map(m => ({
    label: (m.model || 'unknown').split('/').pop(), value: m.cnt, sub: m.provider ? `· ${m.provider}` : '',
  }))

  return (
    <>
      <PageHeader
        title="Market Insights"
        subtitle="What the Data Engineer market is asking for, based on every post the agent has scraped."
      />

      {/* Skill demand + companies */}
      <div className="grid grid-cols-12 gap-5 mb-6 fade-up fade-up-1">
        <Card className="col-span-12 xl:col-span-7" title="Most In-Demand Skills" icon="construction"
          action={<span className="text-[11px] text-faint font-mono">from extracted job posts</span>}>
          {skills.length
            ? <div className="grid md:grid-cols-2 gap-x-8"><HBarList items={skills.slice(0, 12)} /><HBarList items={skills.slice(12, 24)} /></div>
            : <EmptyState icon="construction" title="No skills extracted yet" />}
        </Card>

        <Card className="col-span-12 xl:col-span-5" title="Top Hiring Companies" icon="apartment">
          {companies.length
            ? <HBarList items={companies} color="rgb(var(--chart-4))" />
            : <EmptyState icon="apartment" title="No companies yet" />}
        </Card>
      </div>

      {/* Cloud demand + scoring models */}
      <div className="grid grid-cols-12 gap-5 mb-6 fade-up fade-up-2">
        <Card className="col-span-12 md:col-span-6" title="Cloud Platform Demand" icon="cloud"
          action={<span className="text-[11px] text-faint font-mono">across targeted jobs</span>}>
          {cloudDemand.length
            ? <HBarList items={cloudDemand} showPct />
            : <EmptyState icon="cloud_off" title="No cloud data yet" />}
        </Card>
        <Card className="col-span-12 md:col-span-6" title="Scoring Models Used" icon="smart_toy"
          action={<span className="text-[11px] text-faint font-mono">cascade fallbacks</span>}>
          {modelUsage.length
            ? <HBarList items={modelUsage} color="rgb(var(--chart-3))" />
            : <EmptyState icon="smart_toy" title="No scores yet" />}
        </Card>
      </div>

      {/* Apply channel + experience + locations */}
      <div className="grid grid-cols-12 gap-5 mb-6 fade-up fade-up-3">
        <Card className="col-span-12 md:col-span-6 xl:col-span-4" title="How To Apply" icon="outgoing_mail">
          {applyData.length
            ? <DonutChart data={applyData} size={150} thickness={20} centerLabel="posts" />
            : <EmptyState icon="outgoing_mail" title="No data" />}
        </Card>

        <Card className="col-span-12 md:col-span-6 xl:col-span-4" title="Experience Demanded" icon="timeline">
          {expData.length
            ? <DonutChart data={expData} size={150} thickness={20} centerLabel="posts"
                colors={[CHART_COLORS[1], CHART_COLORS[0], CHART_COLORS[2], CHART_COLORS[3], CHART_COLORS[5]]} />
            : <EmptyState icon="timeline" title="No data" />}
        </Card>

        <Card className="col-span-12 xl:col-span-4" title="Top Locations" icon="location_on">
          {locations.length
            ? <HBarList items={locations} color="rgb(var(--chart-5))" />
            : <EmptyState icon="location_off" title="No locations yet" />}
        </Card>
      </div>

      {/* Score trend + resume profile */}
      <div className="grid grid-cols-12 gap-5 fade-up fade-up-4">
        <Card className="col-span-12 xl:col-span-6" title="Avg ATS Score Over Time" icon="trending_up"
          action={<span className="text-[11px] text-faint font-mono">by scoring date</span>}>
          <AreaChart data={trend} color="rgb(var(--chart-2))" maxY={100} />
        </Card>

        <Card className="col-span-12 xl:col-span-6" title="Your Resume Profile" icon="person_search"
          action={<span className="text-[11px] text-faint font-mono">avg sub-scores, all jobs</span>}>
          {subScores.length ? (
            <div className="space-y-2.5">
              {subScores.map((s, i) => (
                <div key={s.label} className="fade-up" style={{ animationDelay: staggerDelay(i, 0.04, 0.4) }}>
                  <div className="flex justify-between mb-1">
                    <span className="text-xs font-medium text-ink">{s.label}</span>
                    <span className="text-xs font-mono font-semibold" style={{ color: scoreColor(s.value) }}>{s.value}</span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                    <GrowBar pct={s.value} color={scoreColor(s.value)} />
                  </div>
                </div>
              ))}
            </div>
          ) : <EmptyState icon="person_search" title="No scores yet" hint="Your strongest and weakest resume dimensions will show here." />}
        </Card>
      </div>
    </>
  )
}
