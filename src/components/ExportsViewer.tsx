import {useEffect, useMemo, useState} from 'react';
import {
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import type {ExportFileMeta} from '../types';

interface ExportsViewerProps {
  selectedFilename: string | null;
  onSelectFilename: (name: string | null) => void;
  refreshSignal: number;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
      if (ch === '\r') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.length > 0));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ExportsViewer({
  selectedFilename,
  onSelectFilename,
  refreshSignal,
}: ExportsViewerProps) {
  const [files, setFiles] = useState<ExportFileMeta[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [formatFilter, setFormatFilter] = useState<'all' | 'csv' | 'json'>('all');

  const [fileContent, setFileContent] = useState('');
  const [fileFormat, setFileFormat] = useState<'csv' | 'json'>('csv');
  const [loadingContent, setLoadingContent] = useState(false);
  const [tableSearch, setTableSearch] = useState('');
  const [copied, setCopied] = useState(false);

  const loadFiles = async () => {
    setLoadingList(true);
    try {
      const resp = await fetch('/api/exports');
      const data = (await resp.json()) as {ok: boolean; files?: ExportFileMeta[]};
      if (resp.ok && data.ok && Array.isArray(data.files)) {
        setFiles(data.files);
        if (!selectedFilename && data.files.length > 0) {
          onSelectFilename(data.files[0].filename);
        }
      }
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    void loadFiles();
  }, [refreshSignal]);

  useEffect(() => {
    if (!selectedFilename) {
      setFileContent('');
      return;
    }
    let cancelled = false;
    setLoadingContent(true);
    fetch(`/api/exports/${encodeURIComponent(selectedFilename)}`)
      .then((r) => r.json())
      .then((data: {ok: boolean; content?: string; format?: 'csv' | 'json'}) => {
        if (!cancelled && data.ok && typeof data.content === 'string') {
          setFileContent(data.content);
          setFileFormat(data.format ?? (selectedFilename.endsWith('.csv') ? 'csv' : 'json'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFilename]);

  const handleDelete = async (filename: string) => {
    const resp = await fetch(`/api/exports/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });
    if (resp.ok) {
      setFiles((prev) => prev.filter((f) => f.filename !== filename));
      if (selectedFilename === filename) {
        onSelectFilename(null);
      }
    }
  };

  const handleCopy = async () => {
    if (!fileContent) return;
    await navigator.clipboard.writeText(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const filteredFiles = useMemo(() => {
    return files.filter((f) => formatFilter === 'all' || f.format === formatFilter);
  }, [files, formatFilter]);

  const parsedCsv = useMemo(() => {
    if (fileFormat !== 'csv' || !fileContent) return {headers: [], rows: []};
    const allRows = parseCsvRows(fileContent);
    if (allRows.length === 0) return {headers: [], rows: []};
    const [headers, ...body] = allRows;
    const q = tableSearch.trim().toLowerCase();
    const filtered = q
      ? body.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)))
      : body;
    return {headers, rows: filtered};
  }, [fileContent, fileFormat, tableSearch]);

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="rounded-lg border border-slate-800 bg-[#111827] lg:col-span-4">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Saved CSV & JSON Files</h2>
          <button
            type="button"
            onClick={loadFiles}
            className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>

        <div className="border-b border-slate-800 px-4 py-2.5">
          <div className="flex items-center gap-1 rounded-md bg-slate-950 p-0.5">
            {(['all', 'csv', 'json'] as const).map((fmt) => (
              <button
                key={fmt}
                type="button"
                onClick={() => setFormatFilter(fmt)}
                className={`flex-1 rounded py-1 text-xs font-medium uppercase transition ${
                  formatFilter === fmt
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {fmt}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[600px] divide-y divide-slate-800/80 overflow-y-auto">
          {loadingList ? (
            <div className="p-6 text-center text-xs text-slate-400">Loading saved exports...</div>
          ) : filteredFiles.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              No saved exports yet. Run a lookup to automatically save CSV and JSON files.
            </div>
          ) : (
            filteredFiles.map((file) => {
              const active = file.filename === selectedFilename;
              return (
                <div
                  key={file.filename}
                  onClick={() => onSelectFilename(file.filename)}
                  className={`cursor-pointer px-4 py-3 transition ${
                    active ? 'bg-indigo-600/15' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {file.format === 'csv' ? (
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-400" />
                      ) : (
                        <FileText className="h-4 w-4 shrink-0 text-indigo-400" />
                      )}
                      <span className="truncate font-mono text-xs font-medium text-slate-100">
                        {file.filename}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <a
                        href={`/api/exports/${encodeURIComponent(file.filename)}?download=1`}
                        onClick={(e) => e.stopPropagation()}
                        title="Download file"
                        className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </a>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(file.filename);
                        }}
                        title="Delete file"
                        className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px] tabular-nums text-slate-400">
                    <span>{file.recordCount} rows</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatBytes(file.sizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{file.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="flex flex-col rounded-lg border border-slate-800 bg-[#111827] lg:col-span-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-xs font-semibold text-slate-100">
              {selectedFilename || 'Select a saved export'}
            </h2>
          </div>

          {selectedFilename && (
            <div className="flex flex-wrap items-center gap-2">
              {fileFormat === 'csv' && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={tableSearch}
                    onChange={(e) => setTableSearch(e.target.value)}
                    placeholder="Search rows..."
                    className="w-44 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              )}
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <a
                href={`/api/exports/${encodeURIComponent(selectedFilename)}?download=1`}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {!selectedFilename ? (
            <div className="px-6 py-16 text-center text-xs text-slate-400">
              Choose a saved CSV or JSON file on the left to inspect its contents or download it.
            </div>
          ) : loadingContent ? (
            <div className="px-6 py-16 text-center text-xs text-slate-400">
              Loading file contents...
            </div>
          ) : fileFormat === 'csv' ? (
            <div className="max-h-[600px] overflow-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-slate-950">
                  <tr className="border-b border-slate-800 text-slate-400">
                    {parsedCsv.headers.map((header, idx) => (
                      <th key={`${header}-${idx}`} className="whitespace-nowrap px-3.5 py-2.5 font-mono font-medium">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {parsedCsv.rows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-slate-800/40">
                      {row.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          className="max-w-[260px] truncate whitespace-nowrap px-3.5 py-2 font-mono text-[11px] tabular-nums text-slate-200"
                          title={cell}
                        >
                          {cell || '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <pre className="max-h-[600px] overflow-auto bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
              <code>{fileContent}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
