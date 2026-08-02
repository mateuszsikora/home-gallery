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
import type {
  GallerySettings,
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
  | 'getAdminSession'
  | 'getMediaContentUrl'
  | 'getSettings'
  | 'listMedia'
  | 'listTelegramContributors'
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
  readonly playbackMode: PlaybackMode;
  readonly slideDurationSeconds: string;
}

type Phase = 'loading' | 'ready' | 'signed-out';

const toSettingsDraft = (settings: GallerySettings): SettingsDraft => ({
  fadeDurationSeconds: String(settings.fadeDurationMs / 1_000),
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
  readonly settings: GallerySettings;
}

/** Everything the studio needs, fetched together so it opens in one state. */
const loadStudio = async (client: AdminClient): Promise<StudioData> => {
  const [media, settings, contributors] = await Promise.all([
    listAllMedia(client),
    client.getSettings(),
    client.listTelegramContributors(),
  ]);

  return {
    contributors: sortContributors(contributors.items),
    media,
    settings,
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

  return media.source === 'admin' ? 'Administration upload' : 'API upload';
};

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
        className="message message--error"
        ref={errorRef}
        role="alert"
        tabIndex={-1}
      >
        <span aria-hidden="true">!</span>
        <p>{error}</p>
      </div>
    );
  }

  if (notice !== undefined) {
    return (
      <div className="message message--success" role="status">
        <span aria-hidden="true">✓</span>
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
  const [tokenInput, setTokenInput] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [media, setMedia] = useState<MediaRecord[]>([]);
  const [contributors, setContributors] = useState<TelegramContributor[]>([]);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>();
  const [busyAction, setBusyAction] = useState<string>();
  const [deleteCandidate, setDeleteCandidate] = useState<string>();
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

        setMedia(studio.media);
        setContributors(studio.contributors);
        setSettingsDraft(toSettingsDraft(studio.settings));
        setPhase('ready');
        setTokenInput('');
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }

        setPhase('signed-out');
        if (!isUnauthorized(reason)) {
          setError(
            `The administration session could not be restored. ${errorDetail(reason)}`,
          );
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
    setTokenInput('');
    setMedia([]);
    setContributors([]);
    setSettingsDraft(undefined);
    setBusyAction(undefined);
    setDeleteCandidate(undefined);
    setPhase('signed-out');
    setError(message);
    setNotice(undefined);
  };

  const handleActionFailure = (reason: unknown, context: string): void => {
    if (isUnauthorized(reason)) {
      signOut('Your session expired. Enter the access token to continue.');
      return;
    }

    setError(`${context} ${errorDetail(reason)}`);
  };

  const authenticate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    clearMessages();
    const trimmedToken = tokenInput.trim();

    if (trimmedToken === '') {
      setError('Enter an access token to continue.');
      return;
    }

    setTokenInput('');
    setPhase('loading');

    try {
      await client.createAdminSession(trimmedToken);
      const studio = await loadStudio(client);
      setMedia(studio.media);
      setContributors(studio.contributors);
      setSettingsDraft(toSettingsDraft(studio.settings));
      setPhase('ready');
    } catch (reason) {
      setPhase('signed-out');
      setError(
        isUnauthorized(reason)
          ? 'That access token was rejected. Check the token and try again.'
          : `The administration data could not be loaded. ${errorDetail(reason)}`,
      );
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
        setError(`The studio could not be locked. ${errorDetail(reason)}`);
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
      setNotice(`${file.name} was uploaded and added to the gallery.`);
    } catch (reason) {
      handleActionFailure(reason, 'The image could not be uploaded.');
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
      <main className="login-shell">
        <section aria-labelledby="login-title" className="login-card">
          <div className="brand-mark" aria-hidden="true">
            HG
          </div>
          <p className="eyebrow">Home Gallery / Admin</p>
          <h1 id="login-title">Your walls, in your hands.</h1>
          <p className="login-card__intro">
            Enter the private API access token to start a short-lived studio
            session. The token itself is never stored by the browser.
          </p>
          <StatusMessage error={error} errorRef={errorRef} notice={notice} />
          <form
            className="login-form"
            onSubmit={(event) => void authenticate(event)}
          >
            <label htmlFor="access-token">Access token</label>
            <div className="login-form__row">
              <input
                autoComplete="off"
                autoFocus
                id="access-token"
                name="accessToken"
                onChange={(event) => {
                  setTokenInput(event.currentTarget.value);
                }}
                placeholder="Paste your token"
                required
                type="password"
                value={tokenInput}
              />
              <button className="button button--primary" type="submit">
                Open studio
              </button>
            </div>
          </form>
          <p className="security-note">
            <span aria-hidden="true">●</span> The server replaces the token with
            an HttpOnly session cookie that application code cannot read.
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
      <main className="loading-shell" aria-busy="true">
        <div className="brand-mark" aria-hidden="true">
          HG
        </div>
        <p role="status">Opening your gallery studio…</p>
      </main>
    );
  }

  const actionInProgress = busyAction !== undefined;
  const pendingContributors = contributors.filter(
    (contributor) => contributor.status === 'pending',
  ).length;

  return (
    <div className="admin-shell">
      <header className="site-header">
        <a
          className="brand"
          href="#top"
          aria-label="Home Gallery administration"
        >
          <span className="brand-mark" aria-hidden="true">
            HG
          </span>
          <span>
            Home Gallery
            <small>Administration</small>
          </span>
        </a>
        <button
          className="button button--quiet"
          disabled={actionInProgress}
          onClick={() => {
            void endSession();
          }}
          type="button"
        >
          Lock studio
        </button>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Collection control</p>
            <h1 id="page-title">Make the room feel alive.</h1>
          </div>
          <p>
            Shape the sequence, choose what appears, and keep every transition
            feeling effortless.
          </p>
        </section>

        <StatusMessage error={error} errorRef={errorRef} notice={notice} />

        <div className="dashboard-grid">
          <section
            aria-labelledby="library-title"
            className="panel panel--library"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">01 / Library</p>
                <h2 id="library-title">Photos on rotation</h2>
              </div>
              <span className="count-badge">
                {media.length} {media.length === 1 ? 'photo' : 'photos'}
              </span>
            </div>

            <form
              className="upload-bar"
              onSubmit={(event) => void uploadMedia(event)}
            >
              <div>
                <label htmlFor="media-upload">Add a photograph</label>
                <p>JPEG, PNG, WebP, HEIC or HEIF</p>
              </div>
              <input
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                id="media-upload"
                name="media"
                ref={uploadInputRef}
                required
                type="file"
              />
              <button
                className="button button--primary"
                disabled={actionInProgress}
                type="submit"
              >
                {busyAction === 'upload' ? 'Uploading…' : 'Upload photo'}
              </button>
            </form>

            {media.length === 0 ? (
              <div className="empty-state">
                <span aria-hidden="true">□</span>
                <h3>The first frame is waiting.</h3>
                <p>Upload a photograph to begin your gallery rotation.</p>
              </div>
            ) : (
              <ol className="media-list" aria-label="Gallery order">
                {media.map((item, index) => {
                  const previewFailed = previewFailures.has(item.id);
                  const deleting = deleteCandidate === item.id;

                  return (
                    <li key={item.id}>
                      <article
                        className={`media-card${item.enabled ? '' : ' media-card--disabled'}`}
                      >
                        <div className="media-card__preview">
                          {previewFailed ? (
                            <span>Preview unavailable</span>
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
                              src={client.getMediaContentUrl(item.id)}
                              width={item.width}
                            />
                          )}
                          <span className="order-number" aria-hidden="true">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          {!item.enabled ? (
                            <span className="visibility-label">Hidden</span>
                          ) : null}
                        </div>

                        <div className="media-card__body">
                          <div className="media-card__title-row">
                            <div>
                              <h3>{item.originalFilename}</h3>
                              <p>{mediaAttribution(item)}</p>
                            </div>
                            <button
                              aria-pressed={item.enabled}
                              className={`toggle${item.enabled ? ' toggle--active' : ''}`}
                              disabled={actionInProgress}
                              onClick={() => void toggleMedia(item)}
                              type="button"
                            >
                              <span aria-hidden="true" />
                              {item.enabled ? 'Visible' : 'Hidden'}
                            </button>
                          </div>

                          <dl className="metadata">
                            <div>
                              <dt>Added</dt>
                              <dd>{formatTimestamp(item.uploadedAt)}</dd>
                            </div>
                            <div>
                              <dt>Frame</dt>
                              <dd>
                                {item.width} × {item.height}
                              </dd>
                            </div>
                          </dl>

                          <div className="media-card__actions">
                            <div
                              className="reorder-actions"
                              aria-label={`Reorder ${item.originalFilename}`}
                            >
                              <button
                                aria-label={`Move ${item.originalFilename} up`}
                                className="icon-button"
                                disabled={actionInProgress || index === 0}
                                onClick={() => void moveMedia(item, -1)}
                                type="button"
                              >
                                ↑
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
                                ↓
                              </button>
                            </div>
                            <button
                              className="button button--danger-link"
                              disabled={actionInProgress}
                              onClick={() => {
                                clearMessages();
                                setDeleteCandidate(item.id);
                              }}
                              type="button"
                            >
                              Delete
                            </button>
                          </div>

                          {deleting ? (
                            <div
                              aria-labelledby={`delete-title-${item.id}`}
                              aria-modal="false"
                              className="delete-confirmation"
                              role="alertdialog"
                            >
                              <div>
                                <strong id={`delete-title-${item.id}`}>
                                  Delete permanently?
                                </strong>
                                <p>
                                  This removes the image file and cannot be
                                  undone.
                                </p>
                              </div>
                              <div>
                                <button
                                  className="button button--quiet"
                                  disabled={busyAction === `delete:${item.id}`}
                                  onClick={() => {
                                    setDeleteCandidate(undefined);
                                  }}
                                  type="button"
                                >
                                  Cancel
                                </button>
                                <button
                                  className="button button--danger"
                                  disabled={busyAction === `delete:${item.id}`}
                                  onClick={() => void deleteMedia(item)}
                                  ref={confirmDeleteRef}
                                  type="button"
                                >
                                  {busyAction === `delete:${item.id}`
                                    ? 'Deleting…'
                                    : 'Delete photo'}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <aside
            className="panel panel--settings"
            aria-labelledby="settings-title"
          >
            <div className="section-heading section-heading--stacked">
              <p className="eyebrow">02 / Playback</p>
              <h2 id="settings-title">Set the rhythm</h2>
              <p>Changes reach the fullscreen gallery on its next refresh.</p>
            </div>
            <form
              className="settings-form"
              onSubmit={(event) => void saveSettings(event)}
            >
              <label htmlFor="slide-duration">
                <span>Time per photo</span>
                <small>1 second to 60 minutes</small>
              </label>
              <div className="number-field">
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

              <label htmlFor="fade-duration">
                <span>Fade duration</span>
                <small>0 to 10 seconds</small>
              </label>
              <div className="number-field">
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

              <fieldset>
                <legend>Playback order</legend>
                <label className="radio-card">
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
                <label className="radio-card">
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

              <button
                className="button button--primary button--full"
                disabled={actionInProgress}
                type="submit"
              >
                {busyAction === 'settings'
                  ? 'Saving…'
                  : 'Save playback settings'}
              </button>
            </form>
          </aside>

          <section
            aria-labelledby="contributors-title"
            className="panel panel--contributors"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">03 / Contributors</p>
                <h2 id="contributors-title">Who may send photos</h2>
              </div>
              <span className="count-badge">{pendingContributors} waiting</span>
            </div>

            {contributors.length === 0 ? (
              <div className="empty-state">
                <span aria-hidden="true">□</span>
                <h3>Nobody has asked yet.</h3>
                <p>
                  A Telegram user appears here the first time they write to the
                  bot. Nothing they send is stored before you approve them.
                </p>
              </div>
            ) : (
              <ul className="contributor-list">
                {contributors.map((contributor) => {
                  const name = contributorName(contributor);
                  const deciding =
                    busyAction === `contributor:${contributor.telegramUserId}`;

                  return (
                    <li key={contributor.telegramUserId}>
                      <article
                        className={`contributor-card contributor-card--${contributor.status}`}
                      >
                        <div className="contributor-card__identity">
                          <h3>{name}</h3>
                          <p>
                            {contributor.username === undefined
                              ? null
                              : `@${contributor.username} · `}
                            Telegram ID {contributor.telegramUserId}
                          </p>
                          <p>
                            Asked {formatTimestamp(contributor.requestedAt)}
                          </p>
                        </div>

                        <div className="contributor-card__actions">
                          <span
                            className={`status-pill status-pill--${contributor.status}`}
                          >
                            {CONTRIBUTOR_STATUS_LABEL[contributor.status]}
                          </span>
                          {contributor.status === 'approved' ? null : (
                            <button
                              aria-label={`Approve ${name}`}
                              className="button button--primary"
                              disabled={actionInProgress}
                              onClick={() =>
                                void decideContributor(contributor, 'approved')
                              }
                              type="button"
                            >
                              {deciding ? 'Saving…' : 'Approve'}
                            </button>
                          )}
                          {contributor.status === 'rejected' ? null : (
                            <button
                              aria-label={`Reject ${name}`}
                              className="button button--danger-link"
                              disabled={actionInProgress}
                              onClick={() =>
                                void decideContributor(contributor, 'rejected')
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
          </section>
        </div>
      </main>

      <footer>
        <span>Home Gallery</span>
        <span>Private by design · Built for the room</span>
      </footer>
    </div>
  );
};
