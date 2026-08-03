# Home Gallery — Project Specification

## 1. Introduction

Home Gallery is a self-hosted application designed to display photos and videos submitted by users through Telegram. It provides a fullscreen web gallery and an administration interface for managing the media library.

Media is delivered through a Telegram bot responsible for authenticating users and forwarding uploaded files to the application. Home Gallery runs entirely within a local network and can be deployed with Docker Compose.

## 2. Project goals

The goal is to build a lightweight, self-hosted media gallery that allows authorized users to contribute photos, and later videos, through Telegram.

The system must:

- receive media from Telegram;
- store media locally;
- present media as a fullscreen slideshow;
- provide a web administration interface;
- expose a clean REST API;
- remain modular and easy to extend.

The only required external dependency is the Telegram Bot API.

## 3. Scope

### 3.1 Telegram bot

The bot is responsible for communication with Telegram users. It receives incoming messages, authenticates users, downloads media, uploads media to Home Gallery through the REST API, and deletes successfully processed messages from the Telegram chat.

The bot is not responsible for storing or displaying media.

### 3.2 Home Gallery server

The main application is responsible for media storage, the REST API, the fullscreen gallery, the administration panel, and application configuration.

## 4. Architecture

```text
Telegram
   ↓
Telegram Bot
   ↓
REST API
   ↓
Home Gallery
├── media/
├── database
├── API
├── Gallery UI
└── Admin UI
```

## 5. Design principles

- Self-hosted first
- API-first architecture
- Browser-first UI
- Local network operation
- Stateless frontend
- Modular components
- Easy deployment with Docker Compose
- Future-proof architecture allowing media sources beyond Telegram

## 6. Functional requirements

### 6.1 Media upload

The Telegram bot uploads media to Home Gallery. The MVP supports JPEG, PNG, WebP, HEIC, and HEIF.

The server must validate file type, file size, and file integrity. Uploaded images must be normalized into a common browser-compatible internal format such as WebP or JPEG. Orientation must be preserved using EXIF metadata.

### 6.2 Media storage

Each media item contains a unique ID, filename, media type, upload timestamp, author, enabled state, width, and height. Metadata is stored in a database and files are stored on local storage.

### 6.3 Gallery

The gallery is accessible through a web browser at a route such as `/` or `/screensaver`.

It must fill the screen, play media automatically, preload upcoming images, periodically refresh the playlist, support portrait and landscape images, and require no user interaction for normal playback.

A photo whose aspect ratio does not match the display is fitted according to the configured image fit: letterboxed, letterboxed over a blurred copy of itself, or cropped to fill when little of the photo is lost.

### 6.4 Slideshow

The slideshow supports automatic slide changes, smooth transitions, configurable slide and transition durations, and sequential or shuffled playback. Fade is the only required MVP transition.

Potential future transitions include Ken Burns, zoom, slide, and dissolve.

### 6.5 Video support

The architecture must leave room for videos, but video playback is not required for the MVP.

## 7. REST API

The MVP exposes:

- `POST /api/media` using `multipart/form-data` and bearer authentication;
- `GET /api/media`;
- `GET /api/playlist`;
- `GET /api/media/{id}`;
- `PATCH /api/media/{id}`;
- `DELETE /api/media/{id}`.

The implementation plan may add supporting content, health, and configuration endpoints while preserving these contracts.

## 8. Administration panel

The web administration interface provides a media list, previews, deletion, enable/disable controls, ordering, gallery configuration, and review of Telegram contributor access requests.

## 9. Configuration

Configurable options include slide duration, transition duration, playback mode, shuffle behavior, maximum upload size, and maximum number of stored files. Configuration must be available through environment variables and may also be exposed through the administration panel where appropriate.

## 10. Security

### 10.1 Telegram bot

- Only approved users may upload media.
- Users are identified by Telegram User ID.
- The first contact from an unknown user is recorded as a pending access request that an administrator approves or rejects; their media is not downloaded in the meantime.
- Messages from users who are not approved are rejected.
- After Home Gallery confirms successful processing, the bot deletes the original Telegram message containing the uploaded media.
- If processing fails, the message remains in the chat for retry or troubleshooting.

### 10.2 REST API

- Ingestion and administrative operations use independently rotatable bearer-token credentials with separate scopes.
- Browser administration exchanges its bearer once for a bounded, short-lived, opaque HttpOnly session; cookie-authenticated mutations require explicit CSRF protection.
- Administrative endpoints must not be publicly accessible.
- Uploaded files must be treated as untrusted, validated, and verified before permanent storage.
- Invalid authentication and excessive upload attempts must be bounded without limiting public gallery playback.
- Forwarded client identity must be ignored unless the immediate proxy is explicitly trusted.

## 11. MVP completion

The first release supports receiving photos from Telegram, local media storage, a fullscreen slideshow, automatic fade transitions, a media management interface, and media deletion.

## 12. Future enhancements

- video playback;
- albums, tags, and favorites;
- scheduled and multiple playlists;
- multiple displays;
- a moderation workflow;
- thumbnail generation;
- WebSocket or SSE live updates;
- additional transition effects;
- additional media sources.

## 13. Non-functional requirements

The system must be designed for 24/7 operation, use modest memory, run on a Raspberry Pi, NAS, mini-PC, or Docker host, remain simple to deploy, and have a clean, maintainable architecture and well-defined REST API. Frontend and backend components must remain independent.

## 14. Repository structure

The project is a monorepo with independently deployable applications and reusable shared packages. Components communicate exclusively through public APIs or shared contracts.
