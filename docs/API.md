# MVP API Contracts

The shared runtime schemas and TypeScript types live in `@home-gallery/shared-types`. Browser applications and the Telegram bot should call the API through `@home-gallery/api-client` instead of duplicating request logic.

## Conventions

- Protected routes accept `Authorization: Bearer <token>`. Administration and ingestion use independent credentials, and tokens are never accepted in a URL. Administration routes also accept a valid browser session cookie created by the session endpoint.
- Cookie-authenticated `POST`, `PATCH`, and `DELETE` requests require `X-Home-Gallery-CSRF: 1`. Bearer clients do not need this header.
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

`issues` is optional. Consumers should branch on `error.code`; `message` is intended for people and may change.

## Routes

| Method   | Path                 | Access        | Request                             | Successful response                |
| -------- | -------------------- | ------------- | ----------------------------------- | ---------------------------------- |
| `POST`   | `/api/admin/session` | Admin bearer  | None                                | Session expiry                     |
| `GET`    | `/api/admin/session` | Admin session | None                                | Session expiry                     |
| `DELETE` | `/api/admin/session` | Admin session | CSRF header                         | `204 No Content`                   |
| `GET`    | `/health`            | Public        | None                                | Health status                      |
| `POST`   | `/api/media`         | Ingest        | Multipart image and attribution     | Media record                       |
| `GET`    | `/api/media`         | Admin         | Optional `cursor` and `limit` query | Paginated media list               |
| `GET`    | `/api/media/{id}`    | Admin         | None                                | Media record                       |
| `PATCH`  | `/api/media/{id}`    | Admin         | Non-empty media update              | Updated media record               |
| `DELETE` | `/api/media/{id}`    | Admin         | None                                | `204 No Content`                   |
| `GET`    | `/api/playlist`      | Public        | None                                | Enabled media and gallery settings |
| `GET`    | `/media/{id}`        | Public        | None                                | Normalized image bytes             |
| `GET`    | `/api/settings`      | Admin         | None                                | Gallery settings                   |
| `PATCH`  | `/api/settings`      | Admin         | Non-empty settings update           | Updated gallery settings           |

### Browser administration session

`POST /api/admin/session` validates an administration bearer and returns `201 Created` while setting an opaque `home_gallery_admin_session` cookie. The cookie is `HttpOnly`, `SameSite=Strict`, scoped to `/`, and marked `Secure` in the supported TLS profile. The response exposes only the server-side expiry:

```json
{
  "expiresAt": "2026-08-02T12:00:00.000Z"
}
```

`GET /api/admin/session` restores a valid cookie session. `DELETE /api/admin/session` requires `X-Home-Gallery-CSRF: 1`, removes the server-side session, clears the cookie, and returns `204 No Content`. Sessions are held only in bounded process memory: the default lifetime is eight hours, the default capacity is 64, the oldest live session is evicted at capacity, and every server restart invalidates all sessions. The administration bearer remains supported directly on protected routes for non-browser API clients.

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

The ingestion credential is required. An administration credential is accepted only when the operator explicitly enables administration uploads.

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
    "playbackMode": "sequential"
  }
}
```

Items are listed in playlist order. `settings.playbackMode` tells the client whether to play them in that order or to shuffle them, so the response itself stays deterministic.

`GET /media/{id}` returns the normalized image bytes for an enabled item. Missing, disabled, or unavailable content uses the structured error response, and all three cases answer identically so an unauthenticated caller cannot tell them apart.

### Settings

`GET /api/settings` returns the settings object shown in the playlist. `PATCH /api/settings` accepts at least one of these fields:

```json
{
  "slideDurationMs": 10000,
  "fadeDurationMs": 1500,
  "playbackMode": "shuffle"
}
```

Slide duration must be between 1,000 and 3,600,000 milliseconds. Fade duration must be between 0 and 10,000 milliseconds. Playback mode is `sequential` or `shuffle`.
