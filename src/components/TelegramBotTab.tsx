import {useEffect, useState} from 'react';
import {AlertCircle, CheckCircle2, Copy, Check, ExternalLink, RefreshCw, Send} from 'lucide-react';

interface TelegramBotStatus {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  botName: string | null;
  miniAppUrl: string | null;
  restrictedToAllowlist: boolean;
}

const BOT_COMMANDS = [
  {command: '/start', description: 'Show welcome menu and Open LookupDesk Panel Mini App button'},
  {command: '/settoken <DISCORD_TOKEN>', description: 'Verify your Discord token in memory and auto-delete your token message'},
  {command: '/lookup <targets>', description: 'Look up usernames, User IDs, or DM channel IDs (space or comma separated)'},
  {command: '/pause', description: 'Pause an active lookup batch'},
  {command: '/continue', description: 'Resume a paused lookup batch'},
  {command: '/stop', description: 'Stop the batch early and immediately export saved CSV & JSON files'},
  {command: '/clear', description: 'Clear your Discord token from the Telegram chat session'},
];

export function TelegramBotTab() {
  const [status, setStatus] = useState<TelegramBotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/telegram/status');
      const data = (await resp.json()) as {ok: boolean; status?: TelegramBotStatus};
      if (resp.ok && data.ok && data.status) {
        setStatus(data.status);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  const currentOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'https://your-app-url';
  const miniAppUrl = status?.miniAppUrl || currentOrigin;

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Send className="h-5 w-5 text-indigo-400" />
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Telegram Bot & Mini App Host</h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Users can run lookups directly inside Telegram chat or open this SaaS panel as a Telegram Mini App.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={fetchStatus}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh Status
          </button>
        </div>

        <div className="mt-5 grid gap-4 border-t border-slate-800 pt-4 sm:grid-cols-3 text-xs">
          <div>
            <div className="text-slate-400">Bot Runner Status</div>
            <div className="mt-1.5 flex items-center gap-1.5 font-medium">
              {status?.running ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-emerald-400">
                    Active {status.botUsername ? `(@${status.botUsername})` : ''}
                  </span>
                </>
              ) : status?.configured ? (
                <>
                  <AlertCircle className="h-4 w-4 text-amber-300" />
                  <span className="text-amber-300">Configured (connecting...)</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-slate-400" />
                  <span className="text-slate-300">Awaiting TELEGRAM_BOT_TOKEN</span>
                </>
              )}
            </div>
          </div>

          <div>
            <div className="text-slate-400">Access Policy</div>
            <div className="mt-1.5 font-mono text-slate-200">
              {status?.restrictedToAllowlist
                ? 'Allowlist (TELEGRAM_ALLOWED_USER_IDS)'
                : 'Open to any Telegram user'}
            </div>
          </div>

          <div>
            <div className="text-slate-400">Mini App URL</div>
            <div className="mt-1.5 flex items-center gap-2 font-mono text-slate-200">
              <span className="truncate">{miniAppUrl}</span>
              <button
                type="button"
                onClick={() => copyText('url', miniAppUrl)}
                className="shrink-0 text-slate-400 hover:text-slate-100"
                title="Copy Mini App URL"
              >
                {copiedKey === 'url' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5 lg:col-span-6">
          <h3 className="text-sm font-semibold text-slate-100">How to Host on Telegram</h3>
          <ol className="mt-4 space-y-4 text-xs text-slate-300">
            <li>
              <div className="font-semibold text-slate-100">01. Create a bot with @BotFather</div>
              <p className="mt-1 leading-relaxed text-slate-400">
                Open{' '}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-indigo-400 hover:underline"
                >
                  @BotFather <ExternalLink className="h-3 w-3" />
                </a>{' '}
                in Telegram, send <code className="text-slate-200">/newbot</code>, and copy your bot token.
              </p>
            </li>

            <li>
              <div className="font-semibold text-slate-100">02. Set TELEGRAM_BOT_TOKEN on the server</div>
              <p className="mt-1 leading-relaxed text-slate-400">
                Add <code className="text-slate-200">TELEGRAM_BOT_TOKEN</code> to your environment secrets (or local <code className="text-slate-200">.env</code> file) and restart the server. The built-in Telegram runner starts automatically alongside the web panel.
              </p>
              <pre className="mt-2 overflow-x-auto rounded border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-200">
{`TELEGRAM_BOT_TOKEN="your_bot_token_here"
# Optional: restrict bot access to specific numeric Telegram user IDs
TELEGRAM_ALLOWED_USER_IDS=""`}
              </pre>
            </li>

            <li>
              <div className="font-semibold text-slate-100">03. Attach the Mini App Menu Button (Optional)</div>
              <p className="mt-1 leading-relaxed text-slate-400">
                In <code className="text-slate-200">@BotFather</code>, run <code className="text-slate-200">/setmenubutton</code>, pick your bot, and set the URL to <code className="text-slate-200">{miniAppUrl}</code> so users can launch this full SaaS panel inside Telegram.
              </p>
            </li>
          </ol>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5 lg:col-span-6">
          <h3 className="text-sm font-semibold text-slate-100">Supported Telegram Chat Commands</h3>
          <p className="mt-1 text-xs text-slate-400">
            Users can run lookups via chat commands or by uploading a <code className="text-slate-200">.txt</code> or <code className="text-slate-200">.csv</code> target file. Completed batches send both CSV and JSON files directly into chat.
          </p>

          <div className="mt-4 divide-y divide-slate-800/80 border-t border-slate-800">
            {BOT_COMMANDS.map((item) => (
              <div key={item.command} className="py-2.5 text-xs">
                <div className="font-mono font-medium text-indigo-300">{item.command}</div>
                <div className="mt-0.5 text-slate-400">{item.description}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
