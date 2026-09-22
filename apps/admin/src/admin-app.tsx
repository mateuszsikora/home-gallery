import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

import {
  HomeGalleryApiError,
  createHomeGalleryClient,
  type HomeGalleryClient,
} from '@home-gallery/api-client';
import { MIN_ADMIN_PASSWORD_LENGTH } from '@home-gallery/shared-types';

import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ImageIcon,
  ShieldIcon,
  SignOutIcon,
  TrashIcon,
  UploadIcon,
  UsersIcon,
} from './icons.js';
import type {
  GallerySettings,
  ImageFit,
  MediaRecord,
  PlaybackMode,
  TelegramContributor,
  TelegramContributorDecision,
  TelegramContributorStatus,
} from '@home-gallery/shared-types';

export type AdminClient = Pick<
  HomeGalleryClient,
  | 'createAdminSession'
  | 'deleteAdminSession'
  | 'deleteMedia'
  | 'getAdminAuthStatus'
  | 'getAdminMediaThumbnailUrl'
  | 'getAdminSession'
  | 'getSettings'
  | 'listMedia'
  | 'listTelegramContributors'
  | 'removeAdminPassword'
  | 'setAdminPassword'
  | 'updateMedia'
  | 'updateSettings'
  | 'updateTelegramContributor'
  | 'uploadMedia'
>;

export interface AdminAppProps {
  readonly apiBaseUrl: string;
  readonly createClient?: () => AdminClient;
}

interface SettingsDraft {
  readonly fadeDurationSeconds: string;
  readonly imageFit: ImageFit;
  readonly playbackMode: PlaybackMode;
  readonly slideDurationSeconds: string;
}

interface SecurityDraft {
  readonly confirmPassword: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

const EMPTY_SECURITY_DRAFT: SecurityDraft = {
  confirmPassword: '',
  currentPassword: '',
  newPassword: '',
};

type Phase = 'loading' | 'ready' | 'signed-out';

interface ImageFitChoice {
  readonly description: string;
  readonly label: string;
  readonly value: ImageFit;
}

const IMAGE_FIT_CHOICES: readonly ImageFitChoice[] = [
  {
    description: 'Show the whole photo over a blurred copy of itself.',
    label: 'Blurred edges',
    value: 'blur',
  },
  {
    description: 'Fill the screen while at most a quarter is cut, blur beyond.',
    label: 'Crop when it barely shows',
    value: 'auto',
  },
  {
    description: 'Never crop, never blur; leave black bars.',
    label: 'Plain black bars',
    value: 'contain',
  },
];

const toSettingsDraft = (settings: GallerySettings): SettingsDraft => ({
  fadeDurationSeconds: String(settings.fadeDurationMs / 1_000),
  imageFit: settings.imageFit,
  playbackMode: settings.playbackMode,
  slideDurationSeconds: String(settings.slideDurationMs / 1_000),
});

const sortMedia = (items: readonly MediaRecord[]): MediaRecord[] =>
  [...items].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder ||
      left.uploadedAt.localeCompare(right.uploadedAt),
  );

const listAllMedia = async (client: AdminClient): Promise<MediaRecord[]> => {
  const items: MediaRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await client.listMedia({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);

    if (page.nextCursor === null) {
      cursor = undefined;
    } else {
      if (seenCursors.has(page.nextCursor)) {
        throw new Error('The server returned a repeated pagination cursor');
      }

      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  } while (cursor !== undefined);

  return sortMedia(items);
};

/** Mirrors the order the API uses, so a decision does not reshuffle the list. */
const CONTRIBUTOR_RANK: Readonly<Record<TelegramContributorStatus, number>> = {
  pending: 0,
  approved: 1,
  rejected: 2,
};

const sortContributors = (
  items: readonly TelegramContributor[],
): TelegramContributor[] =>
  [...items].sort(
    (left, right) =>
      CONTRIBUTOR_RANK[left.status] - CONTRIBUTOR_RANK[right.status] ||
      right.requestedAt.localeCompare(left.requestedAt) ||
      left.telegramUserId.localeCompare(right.telegramUserId),
  );

const contributorName = (contributor: TelegramContributor): string => {
  const displayName = [contributor.firstName, contributor.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();

  if (displayName) {
    return displayName;
  }

  return contributor.username
    ? `@${contributor.username}`
    : `Telegram user ${contributor.telegramUserId}`;
};

interface StudioData {
  readonly contributors: TelegramContributor[];
  readonly media: MediaRecord[];
  readonly passwordConfigured: boolean;
  readonly settings: GallerySettings;
  readonly uploadsEnabled: boolean;
}

/** Everything the studio needs, fetched together so it opens in one state. */
const loadStudio = async (client: AdminClient): Promise<StudioData> => {
  const [media, settings, contributors, auth] = await Promise.all([
    listAllMedia(client),
    client.getSettings(),
    client.listTelegramContributors(),
    client.getAdminAuthStatus(),
  ]);

  return {
    contributors: sortContributors(contributors.items),
    media,
    passwordConfigured: auth.passwordConfigured,
    settings,
    uploadsEnabled: auth.administrationUploadsEnabled,
  };
};

const errorDetail = (error: unknown): string => {
  if (error instanceof HomeGalleryApiError) {
    const issues = error.issues?.map(({ message }) => message).join(' ');
    return issues || error.message;
  }

  return 'Check that the API is running and try again.';
};

const isUnauthorized = (error: unknown): boolean =>
  error instanceof HomeGalleryApiError && error.status === 401;

/**
 * Everything the server refuses while the session is still valid — a rejected
 * current password, an upload the deployment does not accept — is answered
 * with 403, so none of it can be mistaken for the expired session that 401
 * always means here.
 */
const isForbidden = (error: unknown): boolean =>
  error instanceof HomeGalleryApiError && error.status === 403;

const formatTimestamp = (timestamp: string): string =>
  new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));

const CONTRIBUTOR_STATUS_LABEL: Readonly<
  Record<TelegramContributorStatus, string>
> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const mediaAttribution = (media: MediaRecord): string => {
  if (media.authorName !== undefined) {
    return media.authorName;
  }

  if (media.source === 'telegram' && media.sourceId !== undefined) {
    return `Telegram user ${media.sourceId}`;
  }

  return media.source === 'admin' ? 'Admin upload' : 'API upload';
};

/** Two letters are enough to tell contributor rows apart at a glance. */
const contributorInitials = (name: string): string =>
  name
    .replace(/^@/, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('');

interface StatusMessageProps {
  readonly error: string | undefined;
  readonly notice: string | undefined;
  readonly errorRef: React.RefObject<HTMLDivElement | null>;
}

const StatusMessage = ({
  error,
  errorRef,
  notice,
}: StatusMessageProps): ReactElement | null => {
  if (error !== undefined) {
    return (
      <div
        className="banner banner--error"
        ref={errorRef}
        role="alert"
        tabIndex={-1}
      >
        <AlertIcon />
        <p>{error}</p>
      </div>
    );
  }

  if (notice !== undefined) {
    return (
      <div className="banner banner--success" role="status">
        <CheckIcon />
        <p>{notice}</p>
      </div>
    );
  }

  return null;
};

export const AdminApp = ({
  apiBaseUrl,
  createClient,
}: AdminAppProps): ReactElement => {
  const [passwordInput, setPasswordInput] = useState('');
  // Assumed until the server answers, so a failed status request never renders
  // the studio as open when it is in fact protected.
  const [passwordConfigured, setPasswordConfigured] = useState(true);
  // Assumed off for the mirrored reason: the deployment default rejects browser
  // uploads, so the control stays hidden until the server says it is accepted.
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [securityDraft, setSecurityDraft] =
    useState<SecurityDraft>(EMPTY_SECURITY_DRAFT);
  const [phase, setPhase] = useState<Phase>('loading');
  const [media, setMedia] = useState<MediaRecord[]>([]);
  const [contributors, setContributors] = useState<TelegramContributor[]>([]);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>();
  const [busyAction, setBusyAction] = useState<string>();
  const [deleteCandidate, setDeleteCandidate] = useState<string>();
  const [selectedFileName, setSelectedFileName] = useState<string>();
  const [previewFailures, setPreviewFailures] = useState<Set<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const clientFactory = useMemo(
    () =>
      createClient ??
      ((): AdminClient =>
        createHomeGalleryClient({
          baseUrl: apiBaseUrl,
          useAdminSession: true,
        })),
    [apiBaseUrl, createClient],
  );
  const client = useMemo(() => clientFactory(), [clientFactory]);

  const openStudio = (studio: StudioData): void => {
    setMedia(studio.media);
    setContributors(studio.contributors);
    setSettingsDraft(toSettingsDraft(studio.settings));
    setPasswordConfigured(studio.passwordConfigured);
    setUploadsEnabled(studio.uploadsEnabled);
    setSecurityDraft(EMPTY_SECURITY_DRAFT);
    setPasswordInput('');
    setPhase('ready');
  };

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(undefined);

    void client
      .getAdminSession()
      .then(async () => loadStudio(client))
      .then((studio) => {
        if (cancelled) {
          return;
        }

        openStudio(studio);
      })
      .catch(async (reason: unknown) => {
        if (cancelled) {
          return;
        }

        setPhase('signed-out');
        if (!isUnauthorized(reason)) {
          setError(
            `The administration session could not be restored. ${errorDetail(reason)}`,
          );
        }

        // Without this the sign-in screen cannot tell an unprotected gallery
        // from one that is waiting for a password.
        const auth = await client.getAdminAuthStatus().catch(() => undefined);

        if (!cancelled && auth !== undefined) {
          setPasswordConfigured(auth.passwordConfigured);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (deleteCandidate !== undefined) {
      confirmDeleteRef.current?.focus();
    }
  }, [deleteCandidate]);

  useEffect(() => {
    if (error !== undefined) {
      errorRef.current?.focus();
    }
  }, [error]);

  const clearMessages = (): void => {
    setError(undefined);
    setNotice(undefined);
  };

  const signOut = (message?: string): void => {
    setPasswordInput('');
    setSecurityDraft(EMPTY_SECURITY_DRAFT);
    setMedia([]);
    setContributors([]);
    setSettingsDraft(undefined);
    setBusyAction(undefined);
    setDeleteCandidate(undefined);
    setSelectedFileName(undefined);
    setPhase('signed-out');
    setError(message);
    setNotice(undefined);
  };

  const handleActionFailure = (reason: unknown, context: string): void => {
    if (isUnauthorized(reason)) {
      signOut('Your session expired. Open the studio again to continue.');
      return;
    }

    setError(`${context} ${errorDetail(reason)}`);
  };

  const authenticate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    clearMessages();

    if (passwordConfigured && passwordInput === '') {
      setError('Enter the administration password to continue.');
      return;
    }

    const password = passwordConfigured ? passwordInput : undefined;
    setPasswordInput('');
    setPhase('loading');

    try {
      await client.createAdminSession(password);
      openStudio(await loadStudio(client));
    } catch (reason) {
      setPhase('signed-out');

      if (isUnauthorized(reason)) {
        setError('That password was rejected. Check it and try again.');
        setPasswordConfigured(true);
        return;
      }

      setError(
        `The administration data could not be loaded. ${errorDetail(reason)}`,
      );
    }
  };

  const savePassword = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (busyAction !== undefined) {
      return;
    }

    clearMessages();

    if (securityDraft.newPassword !== securityDraft.confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }

    if (securityDraft.newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      setError(
        `A password needs at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }

    setBusyAction('password');

    try {
      await client.setAdminPassword({
        newPassword: securityDraft.newPassword,
        ...(passwordConfigured
          ? { currentPassword: securityDraft.currentPassword }
          : {}),
      });
      setPasswordConfigured(true);
      setSecurityDraft(EMPTY_SECURITY_DRAFT);
      setNotice(
        'The administration password was saved. Other signed-in browsers were locked out.',
      );
    } catch (reason) {
      if (isForbidden(reason)) {
        setError('The current password is incorrect.');
      } else {
        handleActionFailure(reason, 'The password could not be saved.');
      }
    } finally {
      setBusyAction(undefined);
    }
  };

  const removePassword = async (): Promise<void> => {
    if (busyAction !== undefined) {
      return;
    }

    clearMessages();

    if (securityDraft.currentPassword === '') {
      setError('Enter the current password to remove it.');
      return;
    }

    setBusyAction('password');

    try {
      await client.removeAdminPassword({
        currentPassword: securityDraft.currentPassword,
      });
      setPasswordConfigured(false);
      setSecurityDraft(EMPTY_SECURITY_DRAFT);
      setNotice(
        'The administration password was removed. Anyone on this network can now open the studio.',
      );
    } catch (reason) {
      if (isForbidden(reason)) {
        setError('The current password is incorrect.');
      } else {
        handleActionFailure(reason, 'The password could not be removed.');
      }
    } finally {
      setBusyAction(undefined);
    }
  };

  const endSession = async (): Promise<void> => {
    clearMessages();
    setBusyAction('logout');

    try {
      await client.deleteAdminSession();
      signOut();
    } catch (reason) {
      if (isUnauthorized(reason)) {
        signOut();
      } else {
        setError(`Signing out failed. ${errorDetail(reason)}`);
        setBusyAction(undefined);
      }
    }
  };

  const uploadMedia = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;

    if (client === undefined || busyAction !== undefined) {
      return;
    }

    const file = uploadInputRef.current?.files?.[0];

    if (file === undefined) {
      setError('Choose an image to upload.');
      return;
    }

    clearMessages();
    setBusyAction('upload');

    try {
      const uploaded = await client.uploadMedia({
        file,
        originalFilename: file.name,
        source: 'admin',
        authorName: 'Administrator',
      });
      setMedia((items) =>
        sortMedia([
          ...items.filter((item) => item.id !== uploaded.id),
          uploaded,
        ]),
      );
      form.reset();
      setSelectedFileName(undefined);
      setNotice(`${file.name} was uploaded and added to the gallery.`);
    } catch (reason) {
      // The server refuses a browser upload with 403, so a deployment that
      // turned the capability off after this studio opened says so plainly and
      // withdraws the control instead of repeating a failure.
      if (isForbidden(reason)) {
        setUploadsEnabled(false);
        setSelectedFileName(undefined);
        setError('Browser uploads are disabled on this server.');
      } else {
        handleActionFailure(reason, 'The image could not be uploaded.');
      }
    } finally {
      setBusyAction(undefined);
    }
  };

  const toggleMedia = async (item: MediaRecord): Promise<void> => {
    if (client === undefined || busyAction !== undefined) {
      return;
    }

    clearMessages();
    setBusyAction(`toggle:${item.id}`);

    try {
      const updated = await client.updateMedia(item.id, {
        enabled: !item.enabled,
      });
      setMedia((items) =>
        sortMedia(
          items.map((candidate) =>
            candidate.id === item.id ? updated : candidate,
          ),
        ),
      );
      setPreviewFailures((failures) => {
        const next = new Set(failures);
        next.delete(item.id);
        return next;
      });
      setNotice(
        `${item.originalFilename} is now ${updated.enabled ? 'visible' : 'hidden'} in the gallery.`,
      );
    } catch (reason) {
      handleActionFailure(reason, 'The visibility could not be changed.');
    } finally {
      setBusyAction(undefined);
    }
  };

  const moveMedia = async (
    item: MediaRecord,
    direction: -1 | 1,
  ): Promise<void> => {
    if (client === undefined || busyAction !== undefined) {
      return;
    }

    const currentIndex = media.findIndex(({ id }) => id === item.id);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= media.length) {
      return;
    }

    clearMessages();
    setBusyAction(`move:${item.id}`);

    try {
      await client.updateMedia(item.id, { sortOrder: nextIndex });
      setMedia((items) => {
        const reordered = [...items];
        const sourceIndex = reordered.findIndex(({ id }) => id === item.id);

        if (sourceIndex < 0) {
          return items;
        }

        const [moved] = reordered.splice(sourceIndex, 1);

        if (moved === undefined) {
          return items;
        }

        reordered.splice(nextIndex, 0, moved);
        return reordered.map((candidate, sortOrder) => ({
          ...candidate,
          sortOrder,
        }));
      });
      setNotice(
        `${item.originalFilename} was moved ${direction < 0 ? 'up' : 'down'}.`,
      );
    } catch (reason) {
      handleActionFailure(reason, 'The gallery order could not be changed.');
    } finally {
      setBusyAction(undefined);
    }
  };

  const deleteMedia = async (item: MediaRecord): Promise<void> => {
    if (client === undefined || busyAction !== undefined) {
      return;
    }

    clearMessages();
    setBusyAction(`delete:${item.id}`);

    try {
      await client.deleteMedia(item.id);
      setMedia((items) =>
        items
          .filter(({ id }) => id !== item.id)
          .map((candidate, sortOrder) => ({ ...candidate, sortOrder })),
      );
      setPreviewFailures((failures) => {
        const next = new Set(failures);
        next.delete(item.id);
        return next;
      });
      setDeleteCandidate(undefined);
      setNotice(`${item.originalFilename} was permanently deleted.`);
    } catch (reason) {
      handleActionFailure(reason, 'The image could not be deleted.');
    } finally {
      setBusyAction(undefined);
    }
  };

  const decideContributor = async (
    contributor: TelegramContributor,
    status: TelegramContributorDecision,
  ): Promise<void> => {
    if (busyAction !== undefined) {
      return;
    }

    clearMessages();
    setBusyAction(`contributor:${contributor.telegramUserId}`);

    try {
      const updated = await client.updateTelegramContributor(
        contributor.telegramUserId,
        { status },
      );
      setContributors((items) =>
        sortContributors(
          items.map((candidate) =>
            candidate.telegramUserId === updated.telegramUserId
              ? updated
              : candidate,
          ),
        ),
      );
      setNotice(
        `${contributorName(contributor)} can ${
          status === 'approved' ? 'now' : 'no longer'
        } send photos to the gallery.`,
      );
    } catch (reason) {
      handleActionFailure(reason, 'The contributor decision was not saved.');
    } finally {
      setBusyAction(undefined);
    }
  };

  const saveSettings = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      client === undefined ||
      settingsDraft === undefined ||
      busyAction !== undefined
    ) {
      return;
    }

    const slideDurationMs = Math.round(
      Number(settingsDraft.slideDurationSeconds) * 1_000,
    );
    const fadeDurationMs = Math.round(
      Number(settingsDraft.fadeDurationSeconds) * 1_000,
    );

    if (!Number.isFinite(slideDurationMs) || !Number.isFinite(fadeDurationMs)) {
      setError('Enter valid durations before saving settings.');
      return;
    }

    clearMessages();
    setBusyAction('settings');

    try {
      const updated = await client.updateSettings({
        fadeDurationMs,
        imageFit: settingsDraft.imageFit,
        playbackMode: settingsDraft.playbackMode,
        slideDurationMs,
      });
      setSettingsDraft(toSettingsDraft(updated));
      setNotice('Playback settings were saved.');
    } catch (reason) {
      handleActionFailure(reason, 'The playback settings could not be saved.');
    } finally {
      setBusyAction(undefined);
    }
  };

  if (phase === 'signed-out') {
    return (
      <main className="auth">
        <section aria-labelledby="login-title" className="auth__card">
          <span className="brand-mark" aria-hidden="true">
            HG
          </span>
          <h1 id="login-title">Home Gallery admin</h1>
          <p className="auth__intro">
            {passwordConfigured
              ? 'Enter the administration password to start a short-lived session.'
              : 'This gallery has no administration password yet, so the panel opens for anyone who can reach it. Set one from the Security panel once you are in.'}
          </p>
          <StatusMessage error={error} errorRef={errorRef} notice={notice} />
          <form
            className="auth__form field"
            onSubmit={(event) => void authenticate(event)}
          >
            {passwordConfigured ? (
              <>
                <label className="field__label" htmlFor="admin-password">
                  Administration password
                </label>
                <input
                  autoComplete="current-password"
                  autoFocus
                  className="text-input"
                  id="admin-password"
                  name="adminPassword"
                  onChange={(event) => {
                    setPasswordInput(event.currentTarget.value);
                  }}
                  placeholder="Your password"
                  required
                  type="password"
                  value={passwordInput}
                />
              </>
            ) : null}
            <button
              autoFocus={!passwordConfigured}
              className="button button--primary button--block"
              type="submit"
            >
              Sign in
            </button>
          </form>
          <p className="auth__note">
            <ShieldIcon />
            {passwordConfigured
              ? 'The browser never stores the password. The server exchanges it for an HttpOnly session cookie that page scripts cannot read.'
              : 'Until a password is set, treat this gallery as open to everyone on your local network.'}
          </p>
        </section>
      </main>
    );
  }

  if (
    phase === 'loading' ||
    settingsDraft === undefined ||
    client === undefined
  ) {
    return (
      <main className="loading" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <p role="status">Loading the admin panel…</p>
      </main>
    );
  }

  const actionInProgress = busyAction !== undefined;
  const pendingContributors = contributors.filter(
    (contributor) => contributor.status === 'pending',
  ).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              HG
            </span>
            <h1>
              Home Gallery <span>Administration</span>
            </h1>
          </div>
          <button
            className="button button--secondary"
            disabled={actionInProgress}
            onClick={() => {
              void endSession();
            }}
            type="button"
          >
            <SignOutIcon />
            Sign out
          </button>
        </div>
      </header>

      <main className="page">
        <StatusMessage error={error} errorRef={errorRef} notice={notice} />

        {passwordConfigured ? null : (
          <div className="banner banner--warning" role="status">
            <AlertIcon />
            <p>
              No administration password is set, so anyone on this network can
              change the gallery. <a href="#security">Set one now</a>.
            </p>
          </div>
        )}

        <div className="layout">
          <div className="layout__main">
            <section aria-labelledby="library-title" className="panel">
              <div className="panel__header">
                <div>
                  <h2 id="library-title">Library</h2>
                  <p className="panel__hint">
                    Photos in rotation, in playback order.
                  </p>
                </div>
                <span className="badge">
                  {media.length} {media.length === 1 ? 'photo' : 'photos'}
                </span>
              </div>

              <div className="panel__body">
                {uploadsEnabled ? (
                  <form
                    className="uploader"
                    onSubmit={(event) => void uploadMedia(event)}
                  >
                    <div className="uploader__field">
                      <label htmlFor="media-upload">Add a photograph</label>
                      {/*
                       * The native file control is replaced by a button that
                       * forwards the click, so the row matches the rest of the
                       * panel. Validation stays in `uploadMedia`, because a
                       * visually hidden `required` input cannot be focused to
                       * show the browser's own message.
                       */}
                      <div className="file-picker">
                        <button
                          className="button button--secondary"
                          disabled={actionInProgress}
                          onClick={() => uploadInputRef.current?.click()}
                          type="button"
                        >
                          Choose file
                        </button>
                        <span className="file-picker__name" id="upload-hint">
                          {selectedFileName ?? 'JPEG, PNG, WebP, HEIC or HEIF'}
                        </span>
                      </div>
                      <input
                        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                        aria-describedby="upload-hint"
                        className="sr-only"
                        id="media-upload"
                        name="media"
                        onChange={(event) => {
                          setSelectedFileName(
                            event.currentTarget.files?.[0]?.name,
                          );
                        }}
                        ref={uploadInputRef}
                        tabIndex={-1}
                        type="file"
                      />
                    </div>
                    <button
                      className="button button--primary"
                      disabled={actionInProgress}
                      type="submit"
                    >
                      <UploadIcon />
                      {busyAction === 'upload' ? 'Uploading…' : 'Upload photo'}
                    </button>
                  </form>
                ) : (
                  <p className="uploader-note">
                    Browser uploads are disabled on this server. Photographs
                    arrive through Telegram or another ingestion client.
                  </p>
                )}

                {media.length === 0 ? (
                  <div className="empty">
                    <ImageIcon />
                    <h3>No photos yet</h3>
                    <p>
                      {uploadsEnabled
                        ? 'Upload a photograph or approve a Telegram contributor to fill the rotation.'
                        : 'Approve a Telegram contributor to fill the rotation.'}
                    </p>
                  </div>
                ) : (
                  <ol className="media-list" aria-label="Gallery order">
                    {media.map((item, index) => {
                      const previewFailed = previewFailures.has(item.id);
                      const deleting = deleteCandidate === item.id;
                      const busyDeleting = busyAction === `delete:${item.id}`;

                      return (
                        <li key={item.id}>
                          <article
                            className={`media${item.enabled ? '' : ' media--hidden'}`}
                          >
                            <div className="media__thumb">
                              {previewFailed ? (
                                <span className="media__fallback">
                                  <ImageIcon />
                                </span>
                              ) : (
                                <img
                                  alt={`Preview of ${item.originalFilename}`}
                                  height={item.height}
                                  loading="lazy"
                                  onError={() => {
                                    setPreviewFailures((failures) =>
                                      new Set(failures).add(item.id),
                                    );
                                  }}
                                  src={client.getAdminMediaThumbnailUrl(
                                    item.id,
                                  )}
                                  width={item.width}
                                />
                              )}
                              <span className="media__index" aria-hidden="true">
                                {index + 1}
                              </span>
                            </div>

                            <div className="media__main">
                              <h3 className="media__name">
                                {item.originalFilename}
                              </h3>
                              <p className="media__facts">
                                {mediaAttribution(item)} ·{' '}
                                {formatTimestamp(item.uploadedAt)} ·{' '}
                                {item.width} × {item.height}
                              </p>
                            </div>

                            <div className="media__controls">
                              <button
                                aria-pressed={item.enabled}
                                className={`switch${item.enabled ? ' switch--on' : ''}`}
                                disabled={actionInProgress}
                                onClick={() => void toggleMedia(item)}
                                type="button"
                              >
                                <span
                                  className="switch__track"
                                  aria-hidden="true"
                                />
                                {item.enabled ? 'Visible' : 'Hidden'}
                              </button>
                              <span className="divider" aria-hidden="true" />
                              <button
                                aria-label={`Move ${item.originalFilename} up`}
                                className="icon-button"
                                disabled={actionInProgress || index === 0}
                                onClick={() => void moveMedia(item, -1)}
                                type="button"
                              >
                                <ChevronUpIcon />
                              </button>
                              <button
                                aria-label={`Move ${item.originalFilename} down`}
                                className="icon-button"
                                disabled={
                                  actionInProgress || index === media.length - 1
                                }
                                onClick={() => void moveMedia(item, 1)}
                                type="button"
                              >
                                <ChevronDownIcon />
                              </button>
                              <button
                                aria-label={`Delete ${item.originalFilename}`}
                                className="icon-button icon-button--danger"
                                disabled={actionInProgress}
                                onClick={() => {
                                  clearMessages();
                                  setDeleteCandidate(item.id);
                                }}
                                type="button"
                              >
                                <TrashIcon />
                              </button>
                            </div>

                            {deleting ? (
                              <div
                                aria-labelledby={`delete-title-${item.id}`}
                                aria-modal="false"
                                className="confirm"
                                role="alertdialog"
                              >
                                <div>
                                  <strong id={`delete-title-${item.id}`}>
                                    Delete this photo?
                                  </strong>
                                  <p>
                                    The image file is removed permanently and
                                    cannot be restored.
                                  </p>
                                </div>
                                <div className="confirm__actions">
                                  <button
                                    className="button button--secondary"
                                    disabled={busyDeleting}
                                    onClick={() => {
                                      setDeleteCandidate(undefined);
                                    }}
                                    type="button"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    className="button button--danger"
                                    disabled={busyDeleting}
                                    onClick={() => void deleteMedia(item)}
                                    ref={confirmDeleteRef}
                                    type="button"
                                  >
                                    {busyDeleting
                                      ? 'Deleting…'
                                      : 'Delete photo'}
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </section>

            <section aria-labelledby="contributors-title" className="panel">
              <div className="panel__header">
                <div>
                  <h2 id="contributors-title">Contributors</h2>
                  <p className="panel__hint">
                    Telegram users who may send photos to the gallery.
                  </p>
                </div>
                <span
                  className={`badge${pendingContributors > 0 ? ' badge--attention' : ''}`}
                >
                  {pendingContributors} waiting
                </span>
              </div>

              <div className="panel__body">
                {contributors.length === 0 ? (
                  <div className="empty">
                    <UsersIcon />
                    <h3>No access requests</h3>
                    <p>
                      A Telegram user appears here the first time they write to
                      the bot. Nothing they send is stored before you approve
                      them.
                    </p>
                  </div>
                ) : (
                  <ul className="contributor-list">
                    {contributors.map((contributor) => {
                      const name = contributorName(contributor);
                      const deciding =
                        busyAction ===
                        `contributor:${contributor.telegramUserId}`;

                      return (
                        <li key={contributor.telegramUserId}>
                          <article
                            className={`contributor contributor--${contributor.status}`}
                          >
                            <div className="contributor__identity">
                              <span
                                className="contributor__avatar"
                                aria-hidden="true"
                              >
                                {contributorInitials(name)}
                              </span>
                              <div>
                                <h3 className="contributor__name">{name}</h3>
                                <p className="contributor__meta">
                                  {contributor.username === undefined
                                    ? null
                                    : `@${contributor.username} · `}
                                  Telegram ID {contributor.telegramUserId} ·
                                  Requested{' '}
                                  {formatTimestamp(contributor.requestedAt)}
                                </p>
                              </div>
                            </div>

                            <div className="contributor__actions">
                              <span
                                className={`pill pill--${contributor.status}`}
                              >
                                {CONTRIBUTOR_STATUS_LABEL[contributor.status]}
                              </span>
                              {contributor.status === 'approved' ? null : (
                                <button
                                  aria-label={`Approve ${name}`}
                                  className="button button--primary"
                                  disabled={actionInProgress}
                                  onClick={() =>
                                    void decideContributor(
                                      contributor,
                                      'approved',
                                    )
                                  }
                                  type="button"
                                >
                                  {deciding ? 'Saving…' : 'Approve'}
                                </button>
                              )}
                              {contributor.status === 'rejected' ? null : (
                                <button
                                  aria-label={`Reject ${name}`}
                                  className="button button--quiet"
                                  disabled={actionInProgress}
                                  onClick={() =>
                                    void decideContributor(
                                      contributor,
                                      'rejected',
                                    )
                                  }
                                  type="button"
                                >
                                  Reject
                                </button>
                              )}
                            </div>
                          </article>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            <section
              aria-labelledby="security-title"
              className="panel"
              id="security"
            >
              <div className="panel__header">
                <div>
                  <h2 id="security-title">Security</h2>
                  <p className="panel__hint">
                    {passwordConfigured
                      ? 'Saving a new password signs out every other browser and keeps this one open.'
                      : `A password of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters closes the panel to everyone else on this network.`}
                  </p>
                </div>
                <span
                  className={`badge${passwordConfigured ? '' : ' badge--attention'}`}
                >
                  {passwordConfigured ? 'Protected' : 'Open'}
                </span>
              </div>

              <div className="panel__body">
                <form
                  className="security"
                  onSubmit={(event) => void savePassword(event)}
                >
                  {passwordConfigured ? (
                    <div className="field">
                      <label
                        className="field__label"
                        htmlFor="current-password"
                      >
                        Current password
                      </label>
                      <input
                        autoComplete="current-password"
                        className="text-input"
                        id="current-password"
                        name="currentPassword"
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setSecurityDraft((draft) => ({
                            ...draft,
                            currentPassword: value,
                          }));
                        }}
                        required
                        type="password"
                        value={securityDraft.currentPassword}
                      />
                    </div>
                  ) : null}

                  <div className="field">
                    <label className="field__label" htmlFor="new-password">
                      <span>New password</span>
                      <small>
                        At least {MIN_ADMIN_PASSWORD_LENGTH} characters
                      </small>
                    </label>
                    <input
                      autoComplete="new-password"
                      className="text-input"
                      id="new-password"
                      minLength={MIN_ADMIN_PASSWORD_LENGTH}
                      name="newPassword"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setSecurityDraft((draft) => ({
                          ...draft,
                          newPassword: value,
                        }));
                      }}
                      required
                      type="password"
                      value={securityDraft.newPassword}
                    />
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="confirm-password">
                      Repeat the new password
                    </label>
                    <input
                      autoComplete="new-password"
                      className="text-input"
                      id="confirm-password"
                      name="confirmPassword"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setSecurityDraft((draft) => ({
                          ...draft,
                          confirmPassword: value,
                        }));
                      }}
                      required
                      type="password"
                      value={securityDraft.confirmPassword}
                    />
                  </div>

                  <button
                    className="button button--primary button--block"
                    disabled={actionInProgress}
                    type="submit"
                  >
                    {busyAction === 'password'
                      ? 'Saving…'
                      : passwordConfigured
                        ? 'Change password'
                        : 'Set password'}
                  </button>
                </form>

                {passwordConfigured ? (
                  <div className="security__removal">
                    <p>
                      Removing the password reopens the panel to everyone on
                      this network. It needs the current password above.
                    </p>
                    <button
                      className="button button--danger"
                      disabled={actionInProgress}
                      onClick={() => void removePassword()}
                      type="button"
                    >
                      Remove password
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          <aside
            className="panel layout__side"
            aria-labelledby="settings-title"
          >
            <div className="panel__header">
              <div>
                <h2 id="settings-title">Playback</h2>
                <p className="panel__hint">
                  Applied when the gallery next refreshes.
                </p>
              </div>
            </div>
            <form
              className="settings"
              onSubmit={(event) => void saveSettings(event)}
            >
              <div className="field">
                <label className="field__label" htmlFor="slide-duration">
                  <span>Time per photo</span>
                  <small>1 second to 60 minutes</small>
                </label>
                <div className="input-group">
                  <input
                    id="slide-duration"
                    max="3600"
                    min="1"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSettingsDraft((draft) =>
                        draft === undefined
                          ? draft
                          : {
                              ...draft,
                              slideDurationSeconds: value,
                            },
                      );
                    }}
                    required
                    step="0.1"
                    type="number"
                    value={settingsDraft.slideDurationSeconds}
                  />
                  <span>seconds</span>
                </div>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="fade-duration">
                  <span>Fade duration</span>
                  <small>0 to 10 seconds</small>
                </label>
                <div className="input-group">
                  <input
                    id="fade-duration"
                    max="10"
                    min="0"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSettingsDraft((draft) =>
                        draft === undefined
                          ? draft
                          : {
                              ...draft,
                              fadeDurationSeconds: value,
                            },
                      );
                    }}
                    required
                    step="0.1"
                    type="number"
                    value={settingsDraft.fadeDurationSeconds}
                  />
                  <span>seconds</span>
                </div>
              </div>

              <fieldset className="choice-group">
                <legend>Playback order</legend>
                <label className="choice">
                  <input
                    checked={settingsDraft.playbackMode === 'sequential'}
                    name="playbackMode"
                    onChange={() => {
                      setSettingsDraft((draft) =>
                        draft === undefined
                          ? draft
                          : { ...draft, playbackMode: 'sequential' },
                      );
                    }}
                    type="radio"
                    value="sequential"
                  />
                  <span>
                    <strong>In gallery order</strong>
                    <small>Repeat the sequence shown here.</small>
                  </span>
                </label>
                <label className="choice">
                  <input
                    checked={settingsDraft.playbackMode === 'shuffle'}
                    name="playbackMode"
                    onChange={() => {
                      setSettingsDraft((draft) =>
                        draft === undefined
                          ? draft
                          : { ...draft, playbackMode: 'shuffle' },
                      );
                    }}
                    type="radio"
                    value="shuffle"
                  />
                  <span>
                    <strong>Shuffle</strong>
                    <small>Begin with a fresh random order.</small>
                  </span>
                </label>
              </fieldset>

              <fieldset className="choice-group">
                <legend>Photos that do not fit the screen</legend>
                {IMAGE_FIT_CHOICES.map(({ description, label, value }) => (
                  <label className="choice" key={value}>
                    <input
                      checked={settingsDraft.imageFit === value}
                      name="imageFit"
                      onChange={() => {
                        setSettingsDraft((draft) =>
                          draft === undefined
                            ? draft
                            : { ...draft, imageFit: value },
                        );
                      }}
                      type="radio"
                      value={value}
                    />
                    <span>
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>

              <button
                className="button button--primary button--block"
                disabled={actionInProgress}
                type="submit"
              >
                {busyAction === 'settings'
                  ? 'Saving…'
                  : 'Save playback settings'}
              </button>
            </form>
          </aside>
        </div>
      </main>
    </div>
  );
};
