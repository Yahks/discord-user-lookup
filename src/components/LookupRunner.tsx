import {useEffect, useMemo, useRef, useState, type ChangeEvent} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Square,
  Upload,
  X,
} from 'lucide-react';
import {apiFetch, downloadExportFile} from '../lib/api';
import type {LookupJob, LookupResultEntry, QuotaSnapshot, VerifiedAccount} from '../types';

interface LookupRunnerProps {
  token: string;
  onTokenChange: (token: string) => void;
  verifiedAccount: VerifiedAccount | null;
  onVerifiedAccountChange: (account: VerifiedAccount | null) => void;
  quota: QuotaSnapshot | null;
  onQuotaChange: (quota: QuotaSnapshot) => void;
  onOpenExport: (filename: string) => void;
  onExportsChanged: () => void;
}

function parseCsvFirstColumnOrTargets(rawText: string): string[] {
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const firstParts = lines[0].split(',').map((s) => s.trim().toLowerCase().replace(/^"|"$/g, ''));
  const targetColIdx = firstParts.findIndex((h) =>
    ['username', 'id', 'user_id', 'target', 'query'].includes(h),
  );

  const items: string[] = [];
  if (targetColIdx !== -1 && lines.length > 1) {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const val = (cols[targetColIdx] ?? '').trim().replace(/^"|"$/g, '');
      if (val) items.push(val);
    }
    return items;
  }

  for (const line of lines) {
    for (const part of line.split(/[\s,]+/)) {
      const clean = part.trim().replace(/^"|"$/g, '');
      if (clean) items.push(clean);
    }
  }
  return items;
}

function AvatarCell({entry}: {entry: LookupResultEntry}) {
  const [imgError, setImgError] = useState(false);
  const label = (entry.global_name || entry.username || entry.query || '?').slice(0, 2).toUpperCase();
  const safeSrc =
    entry.avatar_url && entry.avatar_url.startsWith('https://') ? entry.avatar_url : '';

  if (!safeSrc || imgError) {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-800 text-[11px] font-semibold text-slate-300">
        {label}
      </div>
    );
  }

  return (
    <img
      src={safeSrc}
      alt={entry.username || entry.id}
      referrerPolicy="no-referrer"
      onError={() => setImgError(true)}
      className="h-7 w-7 shrink-0 rounded-md object-cover bg-slate-800"
    />
  );
}

export function LookupRunner({
  token,
  onTokenChange,
  verifiedAccount,
  onVerifiedAccountChange,
  quota,
  onQuotaChange,
  onOpenExport,
  onExportsChanged,
}: LookupRunnerProps) {
  const [showToken, setShowToken] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');

  const [targetsText, setTargetsText] = useState('');
  const [exportLabel, setExportLabel] = useState('usernames');
  const [delaySeconds, setDelaySeconds] = useState('1.5');
  const [fetchProfile, setFetchProfile] = useState(true);
  const [fetchSupplemental, setFetchSupplemental] = useState(true);
  const [withMutuals, setWithMutuals] = useState(true);

  const [job, setJob] = useState<LookupJob | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'resolved' | 'failed'>('all');
  const [selectedEntry, setSelectedEntry] = useState<LookupResultEntry | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const notifiedSaveRef = useRef<string | null>(null);

  const parsedTargetCount = useMemo(() => {
    const tokens = targetsText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return new Set(tokens).size;
  }, [targetsText]);

  useEffect(() => {
    if (!job) return;
    if (job.status !== 'running' && job.status !== 'paused') {
      if (job.savedFiles.csv && notifiedSaveRef.current !== job.id) {
        notifiedSaveRef.current = job.id;
        onExportsChanged();
      }
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        const resp = await apiFetch(`/api/lookups/${encodeURIComponent(job.id)}`);
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          ok: boolean;
          job?: LookupJob;
          quota?: QuotaSnapshot;
        };
        if (data.quota) {
          onQuotaChange(data.quota);
        }
        if (data.ok && data.job) {
          setJob(data.job);
          if (data.job.savedFiles.csv && notifiedSaveRef.current !== data.job.id) {
            notifiedSaveRef.current = data.job.id;
            onExportsChanged();
          }
        }
      } catch {
        // Keep polling while job is active
      }
    }, 650);

    return () => window.clearInterval(timer);
  }, [job, onExportsChanged, onQuotaChange]);

  const handleVerifyToken = async () => {
    setVerifyError('');
    if (!token.trim()) {
      setVerifyError('Enter a Discord token first.');
      return;
    }
    setVerifying(true);
    try {
      const resp = await apiFetch('/api/verify', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: token.trim()}),
      });
      const data = (await resp.json()) as {
        ok: boolean;
        account?: VerifiedAccount;
        error?: string;
      };
      if (!resp.ok || !data.ok || !data.account) {
        onVerifiedAccountChange(null);
        setVerifyError(data.error || 'Token verification failed.');
      } else {
        onVerifiedAccountChange(data.account);
      }
    } catch {
      setVerifyError('Network error while verifying token.');
    } finally {
      setVerifying(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const extracted = parseCsvFirstColumnOrTargets(text);
    if (extracted.length > 0) {
      setTargetsText((prev) => {
        const existing = prev.trim();
        return existing ? `${existing}\n${extracted.join('\n')}` : extracted.join('\n');
      });
    }
    e.target.value = '';
  };

  const handleStartLookup = async () => {
    setSubmitError('');
    if (!token.trim()) {
      setSubmitError('Please input your Discord token.');
      return;
    }
    if (parsedTargetCount === 0) {
      setSubmitError('Enter at least one Discord User ID, username, or DM Channel ID.');
      return;
    }

    setSubmitting(true);
    setSelectedEntry(null);
    notifiedSaveRef.current = null;

    try {
      const delayMs = Math.round((parseFloat(delaySeconds) || 1.5) * 1000);
      const resp = await apiFetch('/api/lookups', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          token: token.trim(),
          targets: targetsText,
          options: {
            label: exportLabel.trim() || 'usernames',
            delayMs,
            fetchProfile,
            fetchSupplemental,
            withMutualGuilds: withMutuals,
            withMutualFriends: withMutuals,
          },
        }),
      });
      const data = (await resp.json()) as {
        ok: boolean;
        job?: LookupJob;
        quota?: QuotaSnapshot;
        error?: string;
      };
      if (data.quota) {
        onQuotaChange(data.quota);
      }
      if (!resp.ok || !data.ok || !data.job) {
        setSubmitError(data.error || 'Failed to start lookup job.');
      } else {
        setJob(data.job);
      }
    } catch {
      setSubmitError('Network error starting lookup.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJobAction = async (action: 'pause' | 'resume' | 'stop') => {
    if (!job) return;
    try {
      const resp = await apiFetch(`/api/lookups/${encodeURIComponent(job.id)}/${action}`, {
        method: 'POST',
      });
      const data = (await resp.json()) as {
        ok: boolean;
        job?: LookupJob;
        quota?: QuotaSnapshot;
      };
      if (data.quota) {
        onQuotaChange(data.quota);
      }
      if (resp.ok && data.ok && data.job) {
        setJob(data.job);
        if (data.job.savedFiles.csv) {
          onExportsChanged();
        }
      }
    } catch {
      // Poll will reconcile state
    }
  };

  const filteredResults = useMemo(() => {
    if (!job) return [];
    const q = searchQuery.trim().toLowerCase();
    return job.results.filter((entry) => {
      if (statusFilter !== 'all' && entry.status !== statusFilter) return false;
      if (!q) return true;
      return (
        entry.query.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q) ||
        entry.username.toLowerCase().includes(q) ||
        entry.global_name.toLowerCase().includes(q) ||
        entry.bio.toLowerCase().includes(q)
      );
    });
  }, [job, searchQuery, statusFilter]);

  const isRunning = job?.status === 'running';
  const isPaused = job?.status === 'paused';
  const isActive = isRunning || isPaused;
  const progressPct = job && job.total > 0 ? Math.round((job.currentIndex / job.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5 lg:col-span-5">
          <h2 className="text-sm font-semibold text-slate-100">Session Credentials</h2>
          <p className="mt-1 text-xs text-slate-400">
            Your token is used only for live requests to Discord and is never written to exported files.
          </p>

          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="discord-token" className="block text-xs font-medium text-slate-300">
                Discord Authorization Token
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    id="discord-token"
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => {
                      onTokenChange(e.target.value);
                      if (verifyError) setVerifyError('');
                    }}
                    placeholder="Paste Discord authorization token"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 pr-9 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    aria-label={showToken ? 'Hide token' : 'Show token'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  >
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleVerifyToken}
                  disabled={verifying || isActive}
                  className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 text-xs font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {verifying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                  Verify
                </button>
              </div>
            </div>

            {verifyError && (
              <div className="flex items-center gap-2 text-xs text-rose-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{verifyError}</span>
              </div>
            )}

            {verifiedAccount && (
              <div className="flex items-center gap-2.5 border-t border-slate-800 pt-3 text-xs text-slate-300">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span className="font-medium text-slate-100">
                  {verifiedAccount.global_name || verifiedAccount.username}
                </span>
                <span className="text-slate-500" aria-hidden="true">·</span>
                <span className="font-mono text-slate-400">@{verifiedAccount.username}</span>
                <span className="text-slate-500" aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-slate-400">{verifiedAccount.id}</span>
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-slate-800 pt-4">
            <h3 className="text-xs font-semibold text-slate-200">Lookup Options</h3>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="export-label" className="block text-xs text-slate-400">
                  Export Label
                </label>
                <input
                  id="export-label"
                  type="text"
                  value={exportLabel}
                  onChange={(e) => setExportLabel(e.target.value)}
                  disabled={isActive}
                  placeholder="usernames"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="delay-select" className="block text-xs text-slate-400">
                  Delay Between Requests
                </label>
                <select
                  id="delay-select"
                  value={delaySeconds}
                  onChange={(e) => setDelaySeconds(e.target.value)}
                  disabled={isActive}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                >
                  <option value="1.2">1.2s (Minimum Safe + Jitter)</option>
                  <option value="1.5">1.5s (Balanced + Jitter)</option>
                  <option value="2.5">2.5s (Conservative + Jitter)</option>
                </select>
              </div>
            </div>

            <div className="mt-3 space-y-2 text-xs text-slate-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fetchProfile}
                  onChange={(e) => setFetchProfile(e.target.checked)}
                  disabled={isActive}
                  className="rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
                />
                <span>Fetch sidebar profile (bio, pronouns, badges, connected accounts)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={withMutuals}
                  onChange={(e) => setWithMutuals(e.target.checked)}
                  disabled={isActive || !fetchProfile}
                  className="rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
                />
                <span>Include mutual guilds and mutual friends</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fetchSupplemental}
                  onChange={(e) => setFetchSupplemental(e.target.checked)}
                  disabled={isActive}
                  className="rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
                />
                <span>Query message-request supplemental data</span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex flex-col rounded-lg border border-slate-800 bg-[#111827] p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Lookup Targets</h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Enter User IDs, Discord usernames, or DM channel IDs separated by new lines or commas.
              </p>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isActive}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
              >
                <Upload className="h-3.5 w-3.5" />
                Import .txt / .csv
              </button>
            </div>
          </div>

          <textarea
            value={targetsText}
            onChange={(e) => setTargetsText(e.target.value)}
            disabled={isActive}
            rows={8}
            placeholder={'227540255362777088\nsome_username\n1572251536338190498'}
            spellCheck={false}
            className="mt-3 w-full flex-1 resize-y rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
          />

          {submitError && (
            <div className="mt-3 flex items-center gap-2 text-xs text-rose-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
              <span>
                {parsedTargetCount} unique {parsedTargetCount === 1 ? 'target' : 'targets'} queued
              </span>
              {quota && (
                <>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className={quota.remaining === 0 ? 'text-rose-400' : 'text-slate-300'}>
                    Free Tier · {quota.used} / {quota.limit} used today · {quota.remaining} remaining · Resets 00:00 UTC
                  </span>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!isActive ? (
                <button
                  type="button"
                  onClick={handleStartLookup}
                  disabled={submitting || (quota !== null && quota.remaining <= 0)}
                  className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50 whitespace-nowrap"
                >
                  {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  {quota !== null && quota.remaining <= 0 ? 'Daily Limit Reached' : 'Lookup & Save'}
                </button>
              ) : (
                <>
                  {isRunning ? (
                    <button
                      type="button"
                      onClick={() => handleJobAction('pause')}
                      className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/20 whitespace-nowrap"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleJobAction('resume')}
                      className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 whitespace-nowrap"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Continue
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleJobAction('stop')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 whitespace-nowrap"
                  >
                    <Square className="h-3.5 w-3.5" />
                    Stop & Save
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {job && (
        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold text-slate-100">
                Status:{' '}
                <span
                  className={
                    job.status === 'completed'
                      ? 'text-emerald-400'
                      : job.status === 'paused'
                        ? 'text-amber-300'
                        : job.status === 'stopped' || job.status === 'failed'
                          ? 'text-rose-400'
                          : 'text-indigo-400'
                  }
                >
                  {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                </span>
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-slate-300">
                Processed {job.currentIndex} / {job.total} ({progressPct}%)
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-emerald-400">
                Resolved {job.resolvedCount}
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-rose-400">
                Failed {job.failedCount}
              </span>
              {job.currentTarget && isRunning && (
                <>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-400">
                    Current: {job.currentTarget}
                  </span>
                </>
              )}
            </div>

            {job.savedFiles.csv && job.savedFiles.json && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenExport(job.savedFiles.csv!)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 whitespace-nowrap"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
                  View CSV
                </button>
                <button
                  type="button"
                  onClick={() => onOpenExport(job.savedFiles.json!)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 whitespace-nowrap"
                >
                  <FileText className="h-3.5 w-3.5 text-indigo-400" />
                  View JSON
                </button>
                <button
                  type="button"
                  onClick={() => void downloadExportFile(job.savedFiles.csv!)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download CSV
                </button>
                <button
                  type="button"
                  onClick={() => void downloadExportFile(job.savedFiles.json!)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download JSON
                </button>
              </div>
            )}
          </div>

          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-indigo-500 transition-[width] duration-200"
              style={{width: `${progressPct}%`}}
            />
          </div>

          {job.quotaNote && (
            <p className="mt-2 text-xs text-amber-300">{job.quotaNote}</p>
          )}
          {job.haltReason && (
            <p className="mt-2 text-xs text-rose-400">{job.haltReason}</p>
          )}
          {job.rateLimitNote && (
            <p className="mt-2 text-xs text-amber-300">{job.rateLimitNote}</p>
          )}
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-[#111827]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-100">Lookup Results</h2>
            {job && (
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {filteredResults.length} of {job.results.length}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter username, ID, bio..."
                className="w-56 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 p-0.5">
              {(['all', 'resolved', 'failed'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusFilter(tab)}
                  className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition ${
                    statusFilter === tab
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!job ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-slate-200">No lookup run yet</p>
            <p className="mt-1 text-xs text-slate-400">
              Enter your Discord token and target usernames or IDs above, then click Lookup & Save. Results stream live and automatically save to CSV and JSON.
            </p>
          </div>
        ) : filteredResults.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-400">
            {isRunning ? 'Waiting for first target response...' : 'No matching lookup entries.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400">
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">User ID</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">Bio / Pronouns</th>
                  <th className="px-4 py-2.5 font-medium text-right">Mutuals</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredResults.map((entry, idx) => (
                  <tr
                    key={`${entry.query}-${entry.id}-${idx}`}
                    onClick={() => setSelectedEntry(entry)}
                    className="cursor-pointer transition hover:bg-slate-800/40"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <AvatarCell entry={entry} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-slate-100">
                            {entry.global_name || entry.username || entry.query}
                          </div>
                          <div className="truncate font-mono text-[11px] text-slate-400">
                            {entry.tag ? `@${entry.tag}` : entry.query}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-300">
                      {entry.id || '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-400">
                      {entry.created_at ? entry.created_at.slice(0, 10) : '—'}
                    </td>
                    <td className="max-w-[260px] truncate px-4 py-2.5 text-slate-300">
                      {entry.pronouns ? `${entry.pronouns} · ` : ''}
                      {entry.bio || (entry.error ? entry.error : '—')}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {entry.mutual_guilds.length}g / {entry.mutual_friends.length}f
                    </td>
                    <td className="px-4 py-2.5">
                      {entry.status === 'resolved' ? (
                        <span className="inline-flex items-center gap-1.5 text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Resolved
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-rose-400">
                          <AlertCircle className="h-3.5 w-3.5" />
                          Failed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEntry(entry);
                        }}
                        className="rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedEntry && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60"
          onClick={() => setSelectedEntry(null)}
        >
          <div
            className="flex h-full w-full max-w-xl flex-col border-l border-slate-800 bg-[#0d1320] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div className="flex items-center gap-3 min-w-0">
                <AvatarCell entry={selectedEntry} />
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-slate-100">
                    {selectedEntry.global_name || selectedEntry.username || selectedEntry.query}
                  </h3>
                  <p className="truncate font-mono text-xs text-slate-400">
                    @{selectedEntry.tag || selectedEntry.query} · {selectedEntry.id || 'Unresolved'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEntry(null)}
                aria-label="Close inspector"
                className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-5 text-xs">
              <div className="grid grid-cols-2 gap-3 border-b border-slate-800 pb-4">
                <div>
                  <div className="text-slate-400">Query Input</div>
                  <div className="mt-0.5 font-mono text-slate-200">{selectedEntry.query}</div>
                </div>
                <div>
                  <div className="text-slate-400">Resolved Via</div>
                  <div className="mt-0.5 font-mono text-slate-200">{selectedEntry.resolved_from}</div>
                </div>
                <div>
                  <div className="text-slate-400">DM Channel ID</div>
                  <div className="mt-0.5 font-mono tabular-nums text-slate-200">
                    {selectedEntry.dm_channel_id || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Account Created</div>
                  <div className="mt-0.5 font-mono tabular-nums text-slate-200">
                    {selectedEntry.created_at || '—'}
                  </div>
                </div>
              </div>

              {selectedEntry.error && (
                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-rose-300">
                  {selectedEntry.error}
                </div>
              )}

              <div>
                <div className="font-medium text-slate-300">Bio & Pronouns</div>
                <p className="mt-1 whitespace-pre-wrap text-slate-200">
                  {selectedEntry.pronouns ? `Pronouns: ${selectedEntry.pronouns}\n` : ''}
                  {selectedEntry.bio || 'No bio set.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="font-medium text-slate-300">Badges</div>
                  <p className="mt-1 font-mono text-slate-400">
                    {selectedEntry.badges.length > 0 ? selectedEntry.badges.join(', ') : 'None'}
                  </p>
                </div>
                <div>
                  <div className="font-medium text-slate-300">Connected Accounts</div>
                  <p className="mt-1 font-mono text-slate-400">
                    {selectedEntry.connected_accounts.length > 0
                      ? selectedEntry.connected_accounts.join(', ')
                      : 'None'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="font-medium text-slate-300">
                    Mutual Guilds ({selectedEntry.mutual_guilds.length})
                  </div>
                  <p className="mt-1 font-mono text-slate-400 break-all">
                    {selectedEntry.mutual_guilds.length > 0
                      ? selectedEntry.mutual_guilds.join(', ')
                      : 'None'}
                  </p>
                </div>
                <div>
                  <div className="font-medium text-slate-300">
                    Mutual Friends ({selectedEntry.mutual_friends.length})
                  </div>
                  <p className="mt-1 font-mono text-slate-400 break-all">
                    {selectedEntry.mutual_friends.length > 0
                      ? selectedEntry.mutual_friends.join(', ')
                      : 'None'}
                  </p>
                </div>
              </div>

              <div>
                <div className="mb-1.5 font-medium text-slate-300">Raw API Payload</div>
                <pre className="max-h-72 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                  {JSON.stringify(selectedEntry.raw, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
