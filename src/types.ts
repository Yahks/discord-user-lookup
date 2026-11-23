export interface VerifiedAccount {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar_url: string;
}

export interface QuotaSnapshot {
  tier: 'free';
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  dateUtc: string;
}

export interface LookupOptions {
  fetchProfile: boolean;
  fetchSupplemental: boolean;
  fetchMessages: boolean;
  messageLimit: number;
  withMutualGuilds: boolean;
  withMutualFriends: boolean;
  delayMs: number;
  label: string;
}

export interface LookupResultEntry {
  query: string;
  id: string;
  status: 'resolved' | 'failed';
  resolved_from: string;
  username: string;
  global_name: string;
  discriminator: string;
  tag: string;
  bot: boolean;
  created_at: string;
  avatar: string;
  avatar_url: string;
  public_flags: number;
  bio: string;
  pronouns: string;
  badges: string[];
  connected_accounts: string[];
  mutual_guilds: string[];
  mutual_friends: string[];
  dm_channel_id: string;
  message_count_sampled: number;
  error: string;
  raw: {
    dm_channel?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    supplemental_data?: unknown;
    messages?: unknown[];
  };
}

export type JobStatus = 'running' | 'paused' | 'completed' | 'stopped' | 'failed';

export interface LookupJob {
  id: string;
  status: JobStatus;
  label: string;
  targets: string[];
  currentIndex: number;
  total: number;
  resolvedCount: number;
  failedCount: number;
  currentTarget: string;
  rateLimitNote: string;
  quotaNote?: string;
  haltReason?: string;
  startedAt: string;
  finishedAt: string | null;
  options: LookupOptions;
  results: LookupResultEntry[];
  savedFiles: {
    csv: string | null;
    json: string | null;
  };
}

export interface ExportFileMeta {
  filename: string;
  format: 'csv' | 'json';
  sizeBytes: number;
  recordCount: number;
  createdAt: string;
}

export interface TrackedUserSummary {
  ownerKey: string;
  ownerHash: string;
  channel: 'telegram_bot' | 'telegram_webapp' | 'web';
  telegramUserId?: number;
  telegramUsername?: string;
  firstName?: string;
  discordAccountId?: string;
  discordUsername?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAction: string;
  lastDetails: string;
  totalActions: number;
  totalJobsStarted: number;
  totalLookupsProcessed: number;
  totalLookupsResolved: number;
  totalLookupsFailed: number;
  totalExportsDownloaded: number;
  blockedCount: number;
  quota: QuotaSnapshot;
}

export interface ActivityEventEntry {
  id: string;
  timestamp: string;
  ownerKey: string;
  ownerHash: string;
  channel: 'telegram_bot' | 'telegram_webapp' | 'web';
  telegramUserId?: number;
  telegramUsername?: string;
  firstName?: string;
  action: string;
  details: string;
  targetsCount?: number;
  targetsSample?: string[];
}

export interface AdminActivitySummary {
  totalUsers: number;
  activeToday: number;
  totalEvents: number;
  users: TrackedUserSummary[];
  events: ActivityEventEntry[];
}

