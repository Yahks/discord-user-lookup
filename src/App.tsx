import {useEffect, useState} from 'react';
import {FolderArchive, Menu, Search, X} from 'lucide-react';
import {ExportsViewer} from './components/ExportsViewer';
import {LookupRunner} from './components/LookupRunner';
import {apiFetch} from './lib/api';
import type {QuotaSnapshot, VerifiedAccount} from './types';

type ActiveSection = 'lookup' | 'exports';

const NAV_ITEMS: {id: ActiveSection; label: string; icon: typeof Search}[] = [
  {id: 'lookup', label: 'Lookup Runner', icon: Search},
  {id: 'exports', label: 'Saved Exports', icon: FolderArchive},
];

export default function App() {
  const [section, setSection] = useState<ActiveSection>('lookup');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [token, setToken] = useState('');
  const [verifiedAccount, setVerifiedAccount] = useState<VerifiedAccount | null>(null);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [selectedExport, setSelectedExport] = useState<string | null>(null);
  const [exportsRefreshSignal, setExportsRefreshSignal] = useState(0);

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();

    let cancelled = false;
    apiFetch('/api/quota')
      .then((r) => r.json())
      .then((data: {ok?: boolean; quota?: QuotaSnapshot}) => {
        if (!cancelled && data.ok && data.quota) {
          setQuota(data.quota);
        }
      })
      .catch(() => {
        // Ignore transient startup errors
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenExport = (filename: string) => {
    setSelectedExport(filename);
    setSection('exports');
    setExportsRefreshSignal((n) => n + 1);
  };

  const sectionTitle = section === 'lookup' ? 'Lookup Runner' : 'Saved Exports';

  return (
    <div className="flex min-h-screen bg-[#090d16] text-slate-100">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-800 bg-[#0d1320] transition-transform lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-slate-800 px-5">
          <span className="text-base font-bold tracking-tight text-slate-50 whitespace-nowrap">
            LookupDesk
          </span>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close navigation"
            className="rounded p-1 text-slate-400 hover:text-slate-100 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSection(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-medium transition whitespace-nowrap ${
                  active
                    ? 'bg-indigo-600/15 text-indigo-300'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-3 border-t border-slate-800 p-4 text-xs">
          <div>
            <div className="text-slate-400">Daily Plan Quota</div>
            <div className="mt-1 font-mono text-[11px] tabular-nums text-slate-200">
              {quota
                ? `Free Tier · ${quota.remaining}/${quota.limit} left today`
                : 'Free Tier · 50/day'}
            </div>
          </div>

          <div className="border-t border-slate-800/80 pt-3">
            <div className="text-slate-400">Active Discord Session</div>
            {verifiedAccount ? (
              <div className="mt-1.5">
                <div className="truncate font-medium text-slate-100">
                  {verifiedAccount.global_name || verifiedAccount.username}
                </div>
                <div className="truncate font-mono text-[11px] tabular-nums text-slate-400">
                  @{verifiedAccount.username} · {verifiedAccount.id}
                </div>
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-slate-500">
                Not verified yet
              </div>
            )}
          </div>
        </div>
      </aside>

      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-8 border-b border-slate-800 bg-[#0d1320] px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
              className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-400 whitespace-nowrap">
              <span>Workspace</span>
              <span aria-hidden="true">/</span>
              <span className="font-medium text-slate-100">{sectionTitle}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {section !== 'exports' ? (
              <button
                type="button"
                onClick={() => setSection('exports')}
                className="rounded-md border border-slate-700 bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                Open Saved Exports
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSection('lookup')}
                className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 whitespace-nowrap shrink-0"
              >
                New Lookup
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1360px] flex-1 p-6">
          {section === 'lookup' && (
            <LookupRunner
              token={token}
              onTokenChange={(val) => {
                setToken(val);
                if (verifiedAccount) setVerifiedAccount(null);
              }}
              verifiedAccount={verifiedAccount}
              onVerifiedAccountChange={setVerifiedAccount}
              quota={quota}
              onQuotaChange={setQuota}
              onOpenExport={handleOpenExport}
              onExportsChanged={() => setExportsRefreshSignal((n) => n + 1)}
            />
          )}

          {section === 'exports' && (
            <ExportsViewer
              selectedFilename={selectedExport}
              onSelectFilename={setSelectedExport}
              refreshSignal={exportsRefreshSignal}
            />
          )}
        </main>
      </div>
    </div>
  );
}
