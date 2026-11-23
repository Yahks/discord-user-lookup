declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

export function getTelegramInitData(): string {
  if (typeof window === 'undefined') return '';
  return window.Telegram?.WebApp?.initData || '';
}

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const tgInitData = getTelegramInitData();
  if (tgInitData) {
    headers.set('X-Telegram-Init-Data', tgInitData);
  }
  return fetch(input, {...init, headers});
}

export async function downloadExportFile(filename: string): Promise<void> {
  const resp = await apiFetch(`/api/exports/${encodeURIComponent(filename)}?download=1`);
  if (!resp.ok) return;
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadAdminActivityReport(format: 'csv' | 'json'): Promise<void> {
  const resp = await apiFetch(`/api/admin/activity/export?format=${format}`);
  if (!resp.ok) return;
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `activity_report.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

