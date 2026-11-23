import {useEffect, useMemo, useState} from 'react';
import {Download, RefreshCw, Search} from 'lucide-react';
import {apiFetch, downloadAdminActivityReport} from '../lib/api';
import type {AdminActivitySummary} from '../types';

export function ActivityMonitor() {
  const [summary, setSummary] = useState<AdminActivitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const loadActivity = async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await apiFetch('/api/admin/activity?limit=150');
      const data = (await resp.json()) as {
        ok: boolean;
        error?: string;
      } & Partial<AdminActivitySummary>;
      if (!resp.ok || !data.ok) {
        setError(data.error || 'Failed to load activity tracking data.');
        return;
      }
      setSummary({
        totalUsers: data.totalUsers ?? 0,
        activeToday: data.activeToday ?? 0,
        totalEvents: data.totalEvents ?? 0,
        users: data.users ?? [],
        events: data.events ?? [],
      });
    } catch {
      setError('Network error loading activity logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadActivity();
  }, []);

  const filteredUsers = useMemo(() => {
    if (!summary) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return summary.users;
    return summary.users.filter((u) =>
      [
        u.firstName ?? '',
        u.telegramUsername ?? '',
        u.telegramUserId ? String(u.telegramUserId) : '',
        u.discordUsername ?? '',
        u.ownerKey,
        u.lastAction,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [summary, searchQuery]);

  const filteredEvents = useMemo(() => {
    if (!summary) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return summary.events;
    return summary.events.filter((ev) =>
      [
        ev.firstName ?? '',
        ev.telegramUsername ?? '',
        ev.telegramUserId ? String(ev.telegramUserId) : '',
        ev.ownerKey,
        ev.action,
        ev.details,
        ...(ev.targetsSample ?? []),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [summary, searchQuery]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-800 bg-[#111827] px-5 py-4">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <div>
            <div className="text-slate-400">Tracked Users</div>
            <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-slate-100">
              {summary?.totalUsers ?? 0}
            </div>
          </div>
          <span className="h-8 w-px bg-slate-800" aria-hidden="true" />
          <div>
            <div className="text-slate-400">Active Today</div>
            <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-emerald-400">
              {summary?.activeToday ?? 0}
            </div>
          </div>
          <span className="h-8 w-px bg-slate-800" aria-hidden="true" />
          <div>
            <div className="text-slate-400">Logged Actions</div>
            <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-indigo-300">
              {summary?.totalEvents ?? 0}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter user, ID, action..."
              className="w-52 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => void loadActivity()}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 whitespace-nowrap"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>

          <button
            type="button"
            onClick={() => void downloadAdminActivityReport('csv')}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>

          <button
            type="button"
            onClick={() => void downloadAdminActivityReport('json')}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            Export JSON
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-[#111827]">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-100">Tracked Users</h2>
          <span className="font-mono text-xs tabular-nums text-slate-400">
            {filteredUsers.length} users
          </span>
        </div>

        {loading && !summary ? (
          <div className="px-6 py-10 text-center text-xs text-slate-400">
            Loading user activity...
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-400">
            No matching users recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400">
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">Channel</th>
                  <th className="px-4 py-2.5 font-medium">Discord Session</th>
                  <th className="px-4 py-2.5 font-medium text-right">Today Quota</th>
                  <th className="px-4 py-2.5 font-medium text-right">Lookups</th>
                  <th className="px-4 py-2.5 font-medium">Last Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredUsers.map((u) => (
                  <tr key={u.ownerKey} className="hover:bg-slate-800/40">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-100">
                        {u.firstName || u.telegramUsername || u.ownerKey}
                      </div>
                      <div className="font-mono text-[11px] tabular-nums text-slate-400">
                        {u.telegramUsername ? `@${u.telegramUsername} · ` : ''}
                        {u.telegramUserId ? `ID ${u.telegramUserId}` : u.ownerKey}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{u.channel}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">
                      {u.discordUsername ? `@${u.discordUsername}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {u.quota.used} / {u.quota.limit}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {u.totalLookupsResolved} / {u.totalLookupsProcessed}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-slate-200">{u.lastAction}</div>
                      <div className="max-w-[280px] truncate text-[11px] text-slate-400">
                        {u.lastSeenAt.slice(0, 16).replace('T', ' ')} · {u.lastDetails}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-800 bg-[#111827]">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-100">Recent Action Log</h2>
          <span className="font-mono text-xs tabular-nums text-slate-400">
            {filteredEvents.length} events
          </span>
        </div>

        {filteredEvents.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-400">
            No logged events yet.
          </div>
        ) : (
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-slate-950">
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="px-4 py-2.5 font-medium">Time (UTC)</th>
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">Channel</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredEvents.map((ev) => (
                  <tr key={ev.id} className="hover:bg-slate-800/40">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] tabular-nums text-slate-400">
                      {ev.timestamp.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-slate-200">
                      {ev.telegramUsername
                        ? `@${ev.telegramUsername}`
                        : ev.firstName || ev.ownerKey}
                      {ev.telegramUserId ? ` (${ev.telegramUserId})` : ''}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-slate-400">
                      {ev.channel}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-indigo-300">
                      {ev.action}
                    </td>
                    <td className="max-w-[360px] truncate px-4 py-2 text-slate-300" title={ev.details}>
                      {ev.details}
                      {ev.targetsSample && ev.targetsSample.length > 0
                        ? ` [${ev.targetsSample.join(', ')}]`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
