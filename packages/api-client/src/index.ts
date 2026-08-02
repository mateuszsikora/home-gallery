import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
  API_ROUTES,
  adminSessionSchema,
  apiErrorBodySchema,
  gallerySettingsSchema,
  gallerySettingsUpdateInputSchema,
  healthResponseSchema,
  mediaIdSchema,
  mediaListQuerySchema,
  mediaListResponseSchema,
  mediaRecordSchema,
  mediaUpdateInputSchema,
  mediaUploadMetadataSchema,
  playlistResponseSchema,
  telegramContributorListResponseSchema,
  telegramContributorRegistrationSchema,
  telegramContributorSchema,
  telegramContributorUpdateInputSchema,
  telegramUserIdSchema,
  type ApiErrorBody,
  type AdminSession,
  type GallerySettings,
  type GallerySettingsUpdateInput,
  type HealthResponse,
  type MediaId,
  type MediaListQuery,
  type MediaListResponse,
  type MediaRecord,
  type MediaUpdateInput,
  type MediaUploadMetadata,
  type PlaylistResponse,
  type TelegramContributor,
  type TelegramContributorListResponse,
  type TelegramContributorRegistration,
  type TelegramContributorUpdateInput,
  type TelegramUserId,
} from '@home-gallery/shared-types';

interface RuntimeSchema<Output> {
  safeParse(
    input: unknown,
  ): { success: true; data: Output } | { success: false; error: unknown };
}

export interface HomeGalleryClientOptions {
  baseUrl: string;
  token?: string;
  useAdminSession?: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface UploadMediaInput extends MediaUploadMetadata {
  file: Blob;
}

export class HomeGalleryApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | undefined;

  constructor(status: number, message: string, body?: ApiErrorBody) {
    super(message);
    this.name = 'HomeGalleryApiError';
    this.status = status;
    this.body = body;
  }

  get code(): ApiErrorBody['error']['code'] | undefined {
    return this.body?.error.code;
  }

  get issues(): ApiErrorBody['error']['issues'] | undefined {
    return this.body?.error.issues;
  }
}

export class HomeGalleryResponseError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HomeGalleryResponseError';
    this.status = status;
  }
}

export interface HomeGalleryClient {
  createAdminSession(token: string): Promise<AdminSession>;
  getAdminSession(): Promise<AdminSession>;
  deleteAdminSession(): Promise<void>;
  getHealth(): Promise<HealthResponse>;
  uploadMedia(input: UploadMediaInput): Promise<MediaRecord>;
  listMedia(query?: MediaListQuery): Promise<MediaListResponse>;
  getMedia(id: MediaId): Promise<MediaRecord>;
  updateMedia(id: MediaId, input: MediaUpdateInput): Promise<MediaRecord>;
  deleteMedia(id: MediaId): Promise<void>;
  getPlaylist(): Promise<PlaylistResponse>;
  getMediaContent(id: MediaId): Promise<Blob>;
  getMediaContentUrl(id: MediaId): string;
  getSettings(): Promise<GallerySettings>;
  updateSettings(input: GallerySettingsUpdateInput): Promise<GallerySettings>;
  registerTelegramContributor(
    input: TelegramContributorRegistration,
  ): Promise<TelegramContributor>;
  listTelegramContributors(): Promise<TelegramContributorListResponse>;
  updateTelegramContributor(
    telegramUserId: TelegramUserId,
    input: TelegramContributorUpdateInput,
  ): Promise<TelegramContributor>;
}

const normalizeBaseUrl = (baseUrl: string): string => {
  const parsed = new URL(baseUrl);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('Home Gallery base URL must use HTTP or HTTPS');
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(
      'Home Gallery base URL must not contain credentials, a query, or a fragment',
    );
  }

  return parsed.toString().replace(/\/+$/, '');
};

const parseJson = (text: string, status: number): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HomeGalleryResponseError(
      status,
      'Response body is not valid JSON',
      { cause: error },
    );
  }
};

const parseErrorBody = (text: string): ApiErrorBody | undefined => {
  if (text.length === 0) {
    return undefined;
  }

  try {
    const parsed = apiErrorBodySchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export const createHomeGalleryClient = (
  options: HomeGalleryClientOptions,
): HomeGalleryClient => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const token = options.token?.trim();
  const useAdminSession = options.useAdminSession ?? false;

  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('A Fetch API implementation is required');
  }

  if (options.token !== undefined && !token) {
    throw new TypeError('Home Gallery bearer token must not be empty');
  }

  if (token !== undefined && useAdminSession) {
    throw new TypeError(
      'Choose either a bearer token or an administration session',
    );
  }

  interface RequestAuthentication {
    readonly authenticated?: boolean;
    readonly bearerToken?: string;
    readonly csrf?: boolean;
    readonly session?: boolean;
  }

  const buildUrl = (
    path: string,
    query?: Readonly<Record<string, string | number | undefined>>,
  ): URL => {
    const url = new URL(`${baseUrl}${path}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  };

  const request = async (
    path: string,
    init: RequestInit,
    authentication: RequestAuthentication = {},
    query?: Readonly<Record<string, string | number | undefined>>,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);

    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }

    const requestToken =
      authentication.bearerToken ??
      (authentication.authenticated ? token : undefined);

    if (requestToken !== undefined) {
      headers.set('authorization', `Bearer ${requestToken}`);
    }

    const sessionRequest =
      authentication.session === true ||
      (authentication.authenticated === true && useAdminSession);

    if (
      sessionRequest &&
      (authentication.csrf === true ||
        !['GET', 'HEAD', 'OPTIONS'].includes(init.method ?? 'GET')) &&
      requestToken === undefined
    ) {
      headers.set(ADMIN_SESSION_CSRF_HEADER, ADMIN_SESSION_CSRF_VALUE);
    }

    const response = await fetchImplementation(buildUrl(path, query), {
      ...init,
      headers,
      ...(sessionRequest ? { credentials: 'include' } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      const body = parseErrorBody(text);
      throw new HomeGalleryApiError(
        response.status,
        body?.error.message ??
          `Home Gallery request failed (${response.status})`,
        body,
      );
    }

    return response;
  };

  const requestJson = async <Output>(
    path: string,
    schema: RuntimeSchema<Output>,
    init: RequestInit,
    authentication: RequestAuthentication = {},
    query?: Readonly<Record<string, string | number | undefined>>,
  ): Promise<Output> => {
    const response = await request(path, init, authentication, query);
    const text = await response.text();

    if (text.length === 0) {
      throw new HomeGalleryResponseError(
        response.status,
        'Home Gallery returned an empty response where JSON was expected',
      );
    }

    const value = parseJson(text, response.status);
    const parsed = schema.safeParse(value);

    if (!parsed.success) {
      throw new HomeGalleryResponseError(
        response.status,
        'Home Gallery returned a response that does not match the API contract',
        { cause: parsed.error },
      );
    }

    return parsed.data;
  };

  const jsonInit = (method: string, body?: unknown): RequestInit => ({
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  });

  return {
    createAdminSession: (bootstrapToken) => {
      const trimmedToken = bootstrapToken.trim();

      if (trimmedToken.length === 0) {
        throw new TypeError('Administration bearer token must not be empty');
      }

      return requestJson(
        API_ROUTES.adminSession,
        adminSessionSchema,
        jsonInit('POST'),
        { bearerToken: trimmedToken, session: true },
      );
    },

    getAdminSession: () =>
      requestJson(
        API_ROUTES.adminSession,
        adminSessionSchema,
        jsonInit('GET'),
        { session: true },
      ),

    deleteAdminSession: async () => {
      await request(API_ROUTES.adminSession, jsonInit('DELETE'), {
        csrf: true,
        session: true,
      });
    },

    getHealth: () =>
      requestJson(API_ROUTES.health, healthResponseSchema, jsonInit('GET'), {}),

    uploadMedia: (input) => {
      const { file, ...metadataInput } = input;
      const metadata = mediaUploadMetadataSchema.parse(metadataInput);
      const formData = new FormData();
      formData.append('file', file, metadata.originalFilename);
      formData.append('originalFilename', metadata.originalFilename);
      formData.append('source', metadata.source);

      if (metadata.sourceId !== undefined) {
        formData.append('sourceId', metadata.sourceId);
      }

      if (metadata.authorName !== undefined) {
        formData.append('authorName', metadata.authorName);
      }

      return requestJson(
        API_ROUTES.media,
        mediaRecordSchema,
        { method: 'POST', body: formData },
        { authenticated: true },
      );
    },

    listMedia: (query = {}) => {
      const parsed = mediaListQuerySchema.parse(query);
      return requestJson(
        API_ROUTES.media,
        mediaListResponseSchema,
        jsonInit('GET'),
        { authenticated: true },
        parsed,
      );
    },

    getMedia: (id) => {
      const parsedId = mediaIdSchema.parse(id);
      return requestJson(
        API_ROUTES.mediaById(parsedId),
        mediaRecordSchema,
        jsonInit('GET'),
        { authenticated: true },
      );
    },

    updateMedia: (id, input) => {
      const parsedId = mediaIdSchema.parse(id);
      const parsedInput = mediaUpdateInputSchema.parse(input);
      return requestJson(
        API_ROUTES.mediaById(parsedId),
        mediaRecordSchema,
        jsonInit('PATCH', parsedInput),
        { authenticated: true },
      );
    },

    deleteMedia: async (id) => {
      const parsedId = mediaIdSchema.parse(id);
      await request(API_ROUTES.mediaById(parsedId), jsonInit('DELETE'), {
        authenticated: true,
      });
    },

    getPlaylist: () =>
      requestJson(
        API_ROUTES.playlist,
        playlistResponseSchema,
        jsonInit('GET'),
        {},
      ),

    getMediaContent: async (id) => {
      const parsedId = mediaIdSchema.parse(id);
      const response = await request(
        API_ROUTES.mediaContentById(parsedId),
        { method: 'GET', headers: { accept: 'image/webp' } },
        {},
      );
      return response.blob();
    },

    getMediaContentUrl: (id) => {
      const parsedId = mediaIdSchema.parse(id);
      return buildUrl(API_ROUTES.mediaContentById(parsedId)).toString();
    },

    getSettings: () =>
      requestJson(API_ROUTES.settings, gallerySettingsSchema, jsonInit('GET'), {
        authenticated: true,
      }),

    updateSettings: (input) => {
      const parsedInput = gallerySettingsUpdateInputSchema.parse(input);
      return requestJson(
        API_ROUTES.settings,
        gallerySettingsSchema,
        jsonInit('PATCH', parsedInput),
        { authenticated: true },
      );
    },

    registerTelegramContributor: (input) => {
      const parsedInput = telegramContributorRegistrationSchema.parse(input);
      return requestJson(
        API_ROUTES.telegramContributors,
        telegramContributorSchema,
        jsonInit('POST', parsedInput),
        { authenticated: true },
      );
    },

    listTelegramContributors: () =>
      requestJson(
        API_ROUTES.telegramContributors,
        telegramContributorListResponseSchema,
        jsonInit('GET'),
        { authenticated: true },
      ),

    updateTelegramContributor: (telegramUserId, input) => {
      const parsedId = telegramUserIdSchema.parse(telegramUserId);
      const parsedInput = telegramContributorUpdateInputSchema.parse(input);
      return requestJson(
        API_ROUTES.telegramContributorById(parsedId),
        telegramContributorSchema,
        jsonInit('PATCH', parsedInput),
        { authenticated: true },
      );
    },
  };
};
