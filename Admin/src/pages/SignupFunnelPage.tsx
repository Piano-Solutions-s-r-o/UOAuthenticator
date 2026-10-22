import { useSearchParams } from 'react-router';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, Td } from '../components/ui/Table';
import { useAuthFunnelQuery } from '../features/admin/auth-funnel-queries';
import { buildDailyRows, buildFunnelRows, isReachedOutcome, outcomeLabel } from '../features/admin/auth-funnel-steps';
import { ApiRequestError } from '../services/api-client';

function share(count: number, base: number): string {
  return base ? `${Math.round((count / base) * 100)}%` : '–';
}

export function SignupFunnelPage() {
  // Filters live in the URL so a period and service can be shared or bookmarked.
  const [params, setParams] = useSearchParams();
  const filters = { from: params.get('from') ?? '', to: params.get('to') ?? '', domain: params.get('domain') ?? '' };
  const setFilter = (key: keyof typeof filters, value: string) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });
  const { data, error, isLoading, isError, refetch } = useAuthFunnelQuery(filters);
  // The endpoint answers 400 only for an impossible period.
  const badRange = error instanceof ApiRequestError && error.status === 400;
  const rows = buildFunnelRows(data?.totals ?? []);
  const opened = rows[0]?.reachedCount ?? 0;
  const daily = buildDailyRows(data?.days ?? []);

  return <>
    <PageHeader title="Sign-up funnel" description="How many sign-up and sign-in steps each service's visitors reached, per UTC day. Counts of events only: no emails, IP addresses or tokens are recorded, and one person can count more than once." />
    <Card className="mb-4 p-4"><div className="flex flex-wrap items-end gap-3">
      <FieldShell label="From (UTC)"><TextField aria-label="From (UTC)" type="date" value={filters.from || data?.from || ''} onChange={(event) => setFilter('from', event.target.value)} /></FieldShell>
      <FieldShell label="To (UTC)"><TextField aria-label="To (UTC)" type="date" value={filters.to || data?.to || ''} onChange={(event) => setFilter('to', event.target.value)} /></FieldShell>
      <FieldShell label="Service"><SelectField aria-label="Service" value={filters.domain} onChange={(event) => setFilter('domain', event.target.value)}>
        <option value="">All services</option>
        {[...new Set([...(data?.domains ?? []), ...(filters.domain ? [filters.domain] : [])])].map((domain) => <option key={domain}>{domain}</option>)}
      </SelectField></FieldShell>
    </div></Card>
    {isError ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p>{badRange ? 'Choose a From day on or before To, at most 366 days apart.' : 'Could not load the funnel.'}</p>
      {badRange ? null : <Button className="mt-3" onClick={() => void refetch()}>Try again</Button>}
    </div> : isLoading ? <Card><p role="status" className="p-5">Loading funnel...</p></Card> : <>
      <Card className="mb-4">
        <CardHeader><h2 className="font-semibold">Steps</h2></CardHeader>
        <DataTable headers={['Step', 'Reached', 'Of opened', 'Breakdown']}>
          {rows.map((row) => <tr key={row.step}>
            <Td><p className="font-medium text-gray-900">{row.label}</p><p className="mt-0.5 max-w-md text-xs text-gray-500">{row.description}</p></Td>
            <Td className="text-right font-semibold tabular-nums">{row.reachedCount}</Td>
            <Td className="text-right tabular-nums text-gray-500">{share(row.reachedCount, opened)}</Td>
            <Td><div className="flex flex-wrap gap-1">
              {row.outcomes.length ? row.outcomes.map((item) => <Badge key={item.outcome} variant={isReachedOutcome(row, item.outcome) ? 'green' : 'amber'}>{outcomeLabel(item.outcome)}: {item.count}</Badge>) : <span className="text-xs text-gray-400">None</span>}
            </div></Td>
          </tr>)}
        </DataTable>
      </Card>
      <Card>
        <CardHeader><h2 className="font-semibold">By day</h2></CardHeader>
        <DataTable headers={['Day (UTC)', ...rows.map((row) => row.label)]}>
          {daily.map((day) => <tr key={day.day}><Td className="whitespace-nowrap">{day.day}</Td>{day.reached.map((count, index) => <Td key={rows[index].step} className="text-right tabular-nums">{count}</Td>)}</tr>)}
          {!daily.length ? <tr><Td colSpan={rows.length + 1}>No sign-in activity was recorded for these filters.</Td></tr> : null}
        </DataTable>
      </Card>
    </>}
  </>;
}
