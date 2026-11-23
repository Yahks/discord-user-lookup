import {useState} from 'react';
import {Check, Copy, Download, FileCode2} from 'lucide-react';
import lookupScriptRaw from '../../discord_username_lookup.py?raw';
import accountExampleRaw from '../../account.example.json?raw';
import requirementsRaw from '../../requirements.txt?raw';

interface FileTab {
  id: 'script' | 'account' | 'requirements';
  filename: string;
  content: string;
}

const FILES: FileTab[] = [
  {id: 'script', filename: 'discord_username_lookup.py', content: lookupScriptRaw},
  {id: 'account', filename: 'account.example.json', content: accountExampleRaw},
  {id: 'requirements', filename: 'requirements.txt', content: requirementsRaw},
];

export function CliReference() {
  const [activeId, setActiveId] = useState<FileTab['id']>('script');
  const [copied, setCopied] = useState(false);

  const activeFile = FILES.find((f) => f.id === activeId) ?? FILES[0];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownload = (file: FileTab) => {
    const blob = new Blob([file.content], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#111827]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-1">
          {FILES.map((file) => {
            const isActive = file.id === activeFile.id;
            return (
              <button
                key={file.id}
                type="button"
                onClick={() => setActiveId(file.id)}
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-mono text-xs transition ${
                  isActive
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                }`}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                {file.filename}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => handleDownload(activeFile)}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        </div>
      </div>

      <pre className="max-h-[640px] overflow-auto bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
        <code>{activeFile.content}</code>
      </pre>
    </div>
  );
}
