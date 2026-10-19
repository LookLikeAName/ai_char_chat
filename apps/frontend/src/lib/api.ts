import type {
  AppSettings,
  AvatarDto,
  AvatarInput,
  ConversationDto,
  HealthDto,
  LlmParams,
  LlmProfileDto,
  LlmProfileInput,
  MessageDto,
  PersonaGenerateInput,
  PersonaGenerateResult,
  PersonaIssue,
  Preferences,
  ProfileDto,
  ProviderType,
  InstrumentId,
} from '@acc/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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

export const api = {
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

  conversations: () => request<ConversationDto[]>('GET', '/api/conversations'),
  messages: (conversationId: string) =>
    request<{ messages: MessageDto[]; hasMore: boolean }>('GET', `/api/conversations/${conversationId}/messages?limit=100`),
  sendMessage: (conversationId: string, content: string) =>
    request<MessageDto>('POST', `/api/conversations/${conversationId}/messages`, { content }),
  markRead: (conversationId: string) => request<void>('POST', `/api/conversations/${conversationId}/read`),
  retryReply: (conversationId: string) => request<void>('POST', `/api/conversations/${conversationId}/retry`),
};

export const qk = {
  health: ['health'] as const,
  settings: ['settings'] as const,
  profile: ['profile'] as const,
  llmProfiles: ['llmProfiles'] as const,
  avatars: ['avatars'] as const,
  conversations: ['conversations'] as const,
  messages: (id: string) => ['messages', id] as const,
};
