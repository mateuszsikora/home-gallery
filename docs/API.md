# MVP API Contracts

The shared runtime schemas and TypeScript types live in `@home-gallery/shared-types`. Browser applications and the Telegram bot should call the API through `@home-gallery/api-client` instead of duplicating request logic.

## Conventions

- Administration routes require the browser session cookie created by the session endpoint. Ingestion routes require `Authorization: Bearer <token>`; the ingestion token is never accepted in a URL. The two scopes are independent, and neither credential is accepted on the other's routes. A valid administration session offered on an ingestion route is refused with `403` and error code `administration_ingestion_disabled`, so it is never confused with the `401` that means the session expired.
- Cookie-authenticated `POST`, `PATCH`, and `DELETE` requests require `X-Home-Gallery-CSRF: 1`; a request without it is refused with `403` and error code `csrf_required`. Ingestion bearer clients do not need this header.
- JSON requests use `Content-Type: application/json` and JSON responses use `Content-Type: application/json`.
- Timestamps are ISO 8601 UTC strings.
- Media IDs are UUIDs. Pagination cursors are opaque and clients must return them unchanged.
- Normalized MVP media is served as `image/webp`.
- A successful deletion returns `204 No Content`.
- JSON responses are sent with `Cache-Control: no-store`; normalized image bytes are immutable and are sent with a long-lived `Cache-Control` and an `ETag`.
- Rate-limited requests return HTTP `429`, error code `rate_limited`, and a `Retry-After` header in seconds. Public health, playlist, and content requests do not consume authentication or upload limits.

Every non-successful response uses this shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid request",
    "issues": [
      {
        "path": "slideDurationMs",
        "message": "Must be at least 1000"
      }
    ]
  }
}
```

`issues` is optional. Consumers should branch on `error.code`; `message` is intended for people and may change. A status may carry more than one code. Every `403` this API raises names its cause — `invalid_password`, `administration_ingestion_disabled`, `csrf_required`, or `contributor_not_approved` — and a bare `forbidden` is left for a refusal the contract does not name. A consumer that acts on a specific cause must match its code, because the status alone does not identify one, and must treat an unrecognized code as a refusal it cannot explain. Codes are added over time, and `@home-gallery/api-client` validates the body against the code list it was built with, so a client older than the server discards the whole error body — message included — rather than reporting an unknown code. Ship the client and the server together.

## Routes

| Method   | Path                                          | Access        | Request                             | Successful response                  |
| -------- | --------------------------------------------- | ------------- | ----------------------------------- | ------------------------------------ |
| `GET`    | `/api/admin/auth`                             | Public        | None                                | Password state and upload capability |
| `POST`   | `/api/admin/session`                          | Password      | CSRF header, optional password      | Session expiry                       |
| `GET`    | `/api/admin/session`                          | Admin session | None                                | Session expiry                       |
| `DELETE` | `/api/admin/session`                          | Admin session | CSRF header                         | `204 No Content`                     |
| `PUT`    | `/api/admin/password`                         | Admin session | CSRF header, password change        | `204 No Content`                     |
| `DELETE` | `/api/admin/password`                         | Admin session | CSRF header, current password       | `204 No Content`                     |
| `GET`    | `/health`                                     | Public        | None                                | Health status                        |
| `POST`   | `/api/media`                                  | Ingest        | Multipart image and attribution     | Media record                         |
| `GET`    | `/api/media`                                  | Admin         | Optional `cursor` and `limit` query | Paginated media list                 |
| `GET`    | `/api/media/{id}`                             | Admin         | None                                | Media record                         |
| `PATCH`  | `/api/media/{id}`                             | Admin         | Non-empty media update              | Updated media record                 |
| `DELETE` | `/api/media/{id}`                             | Admin         | None                                | `204 No Content`                     |
| `GET`    | `/api/media/{id}/content`                     | Admin         | None                                | Normalized image bytes               |
| `GET`    | `/api/playlist`                               | Public        | None                                | Enabled media and gallery settings   |
| `GET`    | `/media/{id}`                                 | Public        | None                                | Normalized image bytes               |
| `GET`    | `/api/settings`                               | Admin         | None                                | Gallery settings                     |
| `PATCH`  | `/api/settings`                               | Admin         | Non-empty settings update           | Updated gallery settings             |
| `POST`   | `/api/telegram/contributors`                  | Ingest        | Telegram identity                   | Contributor record                   |
| `GET`    | `/api/telegram/contributors`                  | Admin         | None                                | Contributor list                     |
| `PATCH`  | `/api/telegram/contributors/{telegramUserId}` | Admin         | Approval decision                   | Updated contributor record           |

### Administration password

A fresh installation has no administration password, and anyone who can reach the server can open the studio. `GET /api/admin/auth` is public and reports the current state so the administration app knows which sign-in screen to render and which controls the deployment accepts:

```json
{
  "administrationUploadsEnabled": false,
  "passwordConfigured": false
}
```

`administrationUploadsEnabled` mirrors `HOME_GALLERY_ALLOW_ADMIN_UPLOADS`. The administration app hides its upload control when it is false, rather than offering an action the server will refuse.

`PUT /api/admin/password` sets or changes the password. It needs an administration session, `X-Home-Gallery-CSRF: 1`, and a body of:

```json
{
  "currentPassword": "the-password-in-use",
  "newPassword": "the-password-to-use"
}
```

`currentPassword` is required exactly when a password is already configured. `DELETE /api/admin/password` takes the same session, the same CSRF header, and a body with only `currentPassword`; it returns the installation to the unprotected default, and answers `409` with error code `conflict` when there is no password to remove. Both routes return `204 No Content` on success, invalidate every other administration session, and keep the calling session valid.

A password is 8 to 128 characters and may not contain control characters. A wrong `currentPassword` is answered with `403` and error code `invalid_password`, which distinguishes it from the `401` that an expired session produces and from every other refusal that shares the `403`. That code belongs to these two routes: sign-in reports a rejected password as `401 unauthorized`, because no session exists there to keep valid. Passwords are stored only as salted scrypt hashes, are never logged, and are never returned by the API.

### Browser administration session

`POST /api/admin/session` returns `201 Created` while setting an opaque `home_gallery_admin_session` cookie. The cookie is `HttpOnly`, `SameSite=Strict`, scoped to `/`, and marked `Secure` in the supported TLS profile. The request requires `X-Home-Gallery-CSRF: 1`, so a cross-origin page cannot open a session without passing a preflight. When a password is configured the body must carry it; otherwise the body is empty:

```json
{
  "password": "the-password-in-use"
}
```

The response exposes only the server-side expiry:

```json
{
  "expiresAt": "2026-08-02T12:00:00.000Z"
}
```

`GET /api/admin/session` restores a valid cookie session. `DELETE /api/admin/session` requires `X-Home-Gallery-CSRF: 1`, removes the server-side session, clears the cookie, and returns `204 No Content`. Sessions are held only in bounded process memory: the default lifetime is eight hours, the default capacity is 64, the oldest live session is evicted at capacity, and every server restart invalidates all sessions.

A rejected password consumes the same authentication rate limit as any other failed credential. A client that has already exhausted that limit is answered `429` before its password is checked at all, so repeated attempts cannot keep the server deriving password hashes.

### Health

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 3600
}
```

The healthy response uses HTTP `200`. If the database readiness probe fails, the route returns HTTP `503` with `status` set to `degraded`; clients should use both the status code and response body for diagnostics.

### Upload media

`POST /api/media` uses `multipart/form-data` with these fields:

The ingestion credential is required. An administration session is accepted only when the operator explicitly enables administration uploads; otherwise a valid session is answered `403` with error code `administration_ingestion_disabled`, never the `401` that means an expired session. That code names the deployment setting as the cause, so a client can tell it apart from the other refusals this route answers with `403`. The same code answers every ingestion route, so it says that this session may not ingest, not that this particular route is closed.

| Field              | Required | Description                                                           |
| ------------------ | -------- | --------------------------------------------------------------------- |
| `file`             | Yes      | JPEG, PNG, WebP, HEIC, or HEIF bytes; the server verifies the content |
| `originalFilename` | Yes      | Original client filename, treated as untrusted input                  |
| `source`           | Yes      | `telegram`, `admin`, or `api`                                         |
| `sourceId`         | No       | Source-specific contributor identifier, such as a Telegram user ID    |
| `authorName`       | No       | Display name supplied by the trusted client                           |

A successful upload returns `201 Created` with an administrative media record:

```json
{
  "id": "70f16fba-e1c2-40c6-a8c8-9f1acbe4155d",
  "storedFilename": "70f16fba-e1c2-40c6-a8c8-9f1acbe4155d.webp",
  "originalFilename": "summer.jpg",
  "mediaType": "image",
  "mimeType": "image/webp",
  "uploadedAt": "2026-07-31T10:15:30.000Z",
  "source": "telegram",
  "sourceId": "123456",
  "authorName": "Gallery contributor",
  "enabled": true,
  "sortOrder": 4,
  "width": 1920,
  "height": 1080
}
```

### List and mutate media

`GET /api/media?limit=50&cursor=<opaque-cursor>` returns:

```json
{
  "items": [],
  "nextCursor": null
}
```

`limit` is optional and must be between 1 and 100. `nextCursor` is `null` when no further page exists.

`PATCH /api/media/{id}` accepts at least one mutable field:

```json
{
  "enabled": false,
  "sortOrder": 8
}
```

The response is the complete updated media record. `GET /api/media/{id}` returns the same representation.

`sortOrder` is a position in the playlist rather than a free-form weight. The server keeps positions contiguous from `0`, so writing a position moves the record there and shifts the others, a position beyond the last one moves the record to the end, and deleting a record closes the gap it leaves. Repeating the same update therefore produces the same playlist.

An unknown or malformed media identifier is reported as `not_found`.

### Playlist and content

`GET /api/playlist` exposes only enabled media. It omits contributor and internal storage metadata:

```json
{
  "items": [
    {
      "id": "70f16fba-e1c2-40c6-a8c8-9f1acbe4155d",
      "contentUrl": "/media/70f16fba-e1c2-40c6-a8c8-9f1acbe4155d",
      "mimeType": "image/webp",
      "width": 1920,
      "height": 1080
    }
  ],
  "settings": {
    "slideDurationMs": 8000,
    "fadeDurationMs": 1000,
    "playbackMode": "sequential",
    "imageFit": "blur"
  }
}
```

Items are listed in playlist order. `settings.playbackMode` tells the client whether to play them in that order or to shuffle them, so the response itself stays deterministic. `width` and `height` describe the stored image after its EXIF orientation has been applied, which is what lets the client resolve `settings.imageFit` per photo.

`GET /media/{id}` returns the normalized image bytes for an enabled item. Missing, disabled, or unavailable content uses the structured error response, and all three cases answer identically so an unauthenticated caller cannot tell them apart. Successful responses are immutable and carry an ETag, because stored bytes never change.

`GET /api/media/{id}/content` returns the same bytes for a disabled item as well, which is how the administration app previews a photo it has hidden. It accepts the session cookie, so a plain `<img>` element authenticates itself, and it answers `no-store` because visibility is mutable state. A caller without a valid credential gets the same `not_found` response as one asking for an identifier that does not exist.

### Telegram contributors

Telegram contributors are approved by an administrator instead of being listed in deployment configuration. Their identifiers are exchanged as digit strings because a Telegram user ID may exceed the safe integer range.

`POST /api/telegram/contributors` uses the ingestion credential and is how the bot reports a contact:

```json
{
  "telegramUserId": "123456",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "username": "ada"
}
```

Only `telegramUserId` is required, and the caller cannot propose a status. The route is an upsert: the first call records a pending access request, and every later call refreshes the identity Telegram reports without changing a decision an administrator already made. It answers `200` with the current record:

```json
{
  "telegramUserId": "123456",
  "status": "pending",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "username": "ada",
  "requestedAt": "2026-08-01T10:00:00.000Z",
  "updatedAt": "2026-08-01T10:00:00.000Z"
}
```

`status` is `pending`, `approved`, or `rejected`. `requestedAt` is the first contact and never moves; `updatedAt` changes when the identity or the status really changes.

`GET /api/telegram/contributors` returns every contributor to an administrator, pending requests first and the newest request first within a status. The list is deliberately not paginated:

```json
{
  "items": []
}
```

`PATCH /api/telegram/contributors/{telegramUserId}` accepts only a decided status and returns the complete updated record:

```json
{
  "status": "approved"
}
```

`pending` is rejected as a decision, and an unknown or malformed identifier is reported as `not_found`.

`POST /api/media` with `source` set to `telegram` requires `sourceId` to name an approved contributor. Unidentified, unknown, pending, and rejected senders all receive the same `403` and error code `contributor_not_approved`, so the caller learns nothing about the review queue beyond the fact that this sender may not submit.

### Settings

`GET /api/settings` returns the settings object shown in the playlist. `PATCH /api/settings` accepts at least one of these fields:

```json
{
  "slideDurationMs": 10000,
  "fadeDurationMs": 1500,
  "playbackMode": "shuffle",
  "imageFit": "blur"
}
```

Slide duration must be between 1,000 and 3,600,000 milliseconds. Fade duration must be between 0 and 10,000 milliseconds. Playback mode is `sequential` or `shuffle`.

Image fit decides what the gallery does when a photo does not match the shape of the display, which is what a portrait photo on a landscape wall tablet always does:

| Value     | Behavior                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------- |
| `blur`    | Show the whole photo and fill the remaining area with a blurred, scaled copy of the same image |
| `auto`    | Crop to fill while the mismatch stays small, and fall back to the blurred backdrop otherwise   |
| `contain` | Never crop and never blur, leaving black bars                                                  |

`blur` is the default. The decision is made per photo from its stored dimensions and the current viewport, so a photo that already matches the display is rendered as a single image either way.
