import type {
  AppSettings,
  AvatarDto,
  AvatarStateDto,
  InitialStage,
  AvatarInput,
  ConversationDto,
  HealthDto,
  LlmParams,
  LlmProfileDto,
  LlmProfileInput,
  MessageDto,
  PersonaGenerateInput,
  PersonaGenerateResult,
  DebugEventDto,
  PersonaIssue,
  PromptPreviewDto,
  QueueDto,
  RetrievalRowDto,
  TraceDto,
  TraceSummaryDto,
  UsageRowDto,
  Preferences,
  ProfileDto,
  ProviderType,
  InstrumentId,
  GroupInput,
  UsageSummaryDto,
  AuthStatusDto,
  AvatarPhoto,
  UploadDto,
  ImportRequest,
  ImportResultDto,
} from '@acc/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  const str = q.toString();
  return str ? `?${str}` : '';
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body === undefined || isForm ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && (data as { code?: string }).code === 'unauthorized') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export type LlmTestResult =
  | { ok: true; reply: string; latencyMs: number; params: LlmParams }
  | { ok: false; error: string; latencyMs: number };

export interface LlmDraft {
  profileId?: string;
  provider: ProviderType;
  baseUrl?: string | null;
  model: string;
  apiKey?: string | null;
  params?: LlmParams;
}

/** 請求被擋（cookie 失效）時發出，AuthGate 會回到登入頁 */
export const UNAUTHORIZED_EVENT = 'acc:unauthorized';

export const api = {
  authStatus: () => request<AuthStatusDto>('GET', '/api/auth/status'),
  login: (password: string, remember: boolean) => request<{ ok: true }>('POST', '/api/auth/login', { password, remember }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  logoutAll: () => request<{ ok: true }>('POST', '/api/auth/logout-all'),
  setPassword: (current: string | undefined, next: string | null) =>
    request<{ ok: true }>('PUT', '/api/auth/password', { current, next }),

  health: () => request<HealthDto>('GET', '/api/health'),

  settings: () => request<AppSettings>('GET', '/api/settings'),
  updateSettings: (patch: Partial<AppSettings>) => request<AppSettings>('PATCH', '/api/settings', patch),

  llmProfiles: () => request<LlmProfileDto[]>('GET', '/api/llm-profiles'),
  createLlmProfile: (input: LlmProfileInput) => request<LlmProfileDto>('POST', '/api/llm-profiles', input),
  updateLlmProfile: (id: string, input: LlmProfileInput) => request<LlmProfileDto>('PUT', `/api/llm-profiles/${id}`, input),
  deleteLlmProfile: (id: string) => request<void>('DELETE', `/api/llm-profiles/${id}`),
  testLlmProfile: (id: string, params: LlmParams) =>
    request<LlmTestResult>('POST', `/api/llm-profiles/${id}/test`, { params }),
  testLlmDraft: (draft: LlmDraft) => request<LlmTestResult>('POST', '/api/llm-profiles/test-draft', draft),
  listModels: (draft: LlmDraft) => request<{ models: string[] }>('POST', '/api/llm-profiles/models', draft),

  avatars: () => request<AvatarDto[]>('GET', '/api/avatars'),
  createAvatar: (input: AvatarInput) => request<AvatarDto>('POST', '/api/avatars', input),
  updateAvatar: (id: string, input: AvatarInput) => request<AvatarDto>('PUT', `/api/avatars/${id}`, input),
  deleteAvatar: (id: string) => request<void>('DELETE', `/api/avatars/${id}`),
  uploadAvatarImage: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<AvatarDto>('POST', `/api/avatars/${id}/image`, form);
  },
  uploadPhotoReference: (id: string, blob: Blob) => {
    const form = new FormData();
    form.append('file', blob, blob instanceof File ? blob.name : 'reference.jpg');
    return request<AvatarDto>('POST', `/api/avatars/${id}/photo-reference`, form);
  },
  deletePhotoReference: (id: string) => request<AvatarDto>('DELETE', `/api/avatars/${id}/photo-reference`),
  testPhoto: (id: string, description: string, photo: AvatarPhoto) =>
    request<{ url: string; width: number | null; height: number | null }>('POST', `/api/avatars/${id}/photo/test`, { description, photo }),
  deleteAvatarImage: (id: string) => request<AvatarDto>('DELETE', `/api/avatars/${id}/image`),
  generateAvatarImage: (id: string, prompt: string) =>
    request<AvatarDto>('POST', `/api/avatars/${id}/image/generate`, { prompt }),
  generatePersona: (input: PersonaGenerateInput) =>
    request<PersonaGenerateResult>('POST', '/api/avatars/persona/generate', input),
  checkPersona: (input: { name: string; bio: string; persona: unknown; locks: string[] }) =>
    request<{ issues: PersonaIssue[] }>('POST', '/api/avatars/persona/check', input),

  profile: () => request<ProfileDto>('GET', '/api/profile'),
  savePreferences: (p: Preferences) => request<ProfileDto>('PUT', '/api/profile/preferences', p),
  patchAnswers: (instrument: InstrumentId, answers: Record<string, number | null>) =>
    request<ProfileDto>('PATCH', '/api/profile/answers', { instrument, answers }),
  setSummary: (summary: string) => request<ProfileDto>('PUT', '/api/profile/summary', { summary }),
  generateSummary: () => request<ProfileDto>('POST', '/api/profile/summary/generate'),

  exportUrl: (avatarId: string | null, opts: { memories: boolean; history: boolean }) =>
    `/api/avatars/${avatarId ? `${avatarId}/` : ''}export${query({ memories: String(opts.memories), history: String(opts.history) })}`,
  importAvatars: (input: ImportRequest) => request<ImportResultDto>('POST', '/api/avatars/import', input),
  usage: (days: number) => request<UsageSummaryDto>('GET', `/api/usage?days=${days}`),

  avatarState: (id: string) => request<AvatarStateDto>('GET', `/api/avatars/${id}/state`),
  deleteMemory: (id: string, memoryId: string) => request<void>('DELETE', `/api/avatars/${id}/memories/${memoryId}`),
  resetRelationship: (id: string, stage: InitialStage) =>
    request<{ ok: true }>('POST', `/api/avatars/${id}/relationship/reset`, { stage }),
  reflectNow: (id: string) => request<{ updated: boolean }>('POST', `/api/avatars/${id}/reflect`),

  debug: {
    events: (params: Record<string, string | undefined>) =>
      request<DebugEventDto[]>('GET', `/api/debug/events${query(params)}`),
    traces: (params: Record<string, string | undefined>) =>
      request<TraceSummaryDto[]>('GET', `/api/debug/traces${query(params)}`),
    trace: (id: string) => request<TraceDto>('GET', `/api/debug/traces/${id}`),
    queue: () => request<QueueDto>('GET', '/api/debug/queue'),
    promote: (jobId: string) => request<{ ok: boolean }>('POST', `/api/debug/queue/${encodeURIComponent(jobId)}/promote`),
    replyNow: (conversationId: string) => request<{ ok: true }>('POST', `/api/debug/conversations/${conversationId}/reply-now`),
    extractNow: (conversationId: string) =>
      request<{ ok: true }>('POST', `/api/debug/conversations/${conversationId}/extract-now`),
    run: (task: 'proactive-tick' | 'maintenance') => request<{ ok: true }>('POST', `/api/debug/run/${task}`),
    usage: (hours: number) => request<UsageRowDto[]>('GET', `/api/debug/usage?hours=${hours}`),
    preview: (conversationId: string, mode: 'reply' | 'proactive', avatarId?: string) =>
      request<PromptPreviewDto>('GET', `/api/debug/preview/${conversationId}${query({ mode, avatarId })}`),
    retrieve: (avatarId: string, q: string) =>
      request<{ embedder: string | null; rows: RetrievalRowDto[] }>('POST', `/api/debug/avatars/${avatarId}/retrieve`, {
        query: q,
      }),
  },

  conversations: () => request<ConversationDto[]>('GET', '/api/conversations'),
  messages: (conversationId: string) =>
    request<{ messages: MessageDto[]; hasMore: boolean }>('GET', `/api/conversations/${conversationId}/messages?limit=100`),
  sendMessage: (conversationId: string, content: string, image?: string) =>
    request<MessageDto>('POST', `/api/conversations/${conversationId}/messages`, { content, image }),
  upload: (blob: Blob) => {
    const form = new FormData();
    form.append('file', blob, blob instanceof File ? blob.name : 'image.jpg');
    return request<UploadDto>('POST', '/api/uploads', form);
  },
  markRead: (conversationId: string) => request<void>('POST', `/api/conversations/${conversationId}/read`),
  retryReply: (conversationId: string) => request<void>('POST', `/api/conversations/${conversationId}/retry`),
  createGroup: (input: GroupInput) => request<{ id: string }>('POST', '/api/conversations', input),
  updateGroup: (id: string, input: GroupInput) => request<{ ok: true }>('PUT', `/api/conversations/${id}`, input),
  deleteGroup: (id: string) => request<void>('DELETE', `/api/conversations/${id}`),
  typing: (conversationId: string) => request<void>('POST', `/api/conversations/${conversationId}/typing`),
};

export const qk = {
  auth: ['auth'] as const,
  health: ['health'] as const,
  settings: ['settings'] as const,
  profile: ['profile'] as const,
  llmProfiles: ['llmProfiles'] as const,
  avatars: ['avatars'] as const,
  conversations: ['conversations'] as const,
  messages: (id: string) => ['messages', id] as const,
  avatarState: (id: string) => ['avatarState', id] as const,
};
