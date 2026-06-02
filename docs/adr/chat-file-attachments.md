# ADR: Chat File Attachments

- **Status:** Accepted
- **Date:** 2026-06-02
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [Attachments skill](../../skills/attachments/SKILL.md), [BFF Trust Boundary](./bff-trust-boundary.md)

## Decision

The chat composer accepts **arbitrary file attachments** (PDF, CSV,
logs, code, etc.), not only images. A non-image file reaches the agent
**by reference**: the user message names each file in an `Attached files
(in order):` text marker (`- <id> — <filename> (<mime>, <bytes> bytes)`),
and the agent pulls the bytes into the workspace on demand via the
existing `attachments` skill's `materialize` script, then reads them with
`file_read`. We do **not** add provider-native `document` content parts.

The upload gate (`POST /api/uploads`) accepts any **plausible** MIME
(`isPlausibleMime`) rather than gating on `image/*` / `audio/*`. Storage
was already generic. Structurally-invalid mimes return 415 and empty
bodies return 400.

The wire/persistence field stays named **`images`** (`{ id, mimeType,
size }`); no rename or state migration. `buildVisionContent` is renamed
to `buildAttachmentContent` and partitions attachments by MIME: images
keep the inline `image_url` data-url path; non-image files produce the
text marker.

## Context

Before this change the whole pipeline was image-only: the upload gate
rejected non-image/non-audio MIME with 415, and the chat-task content
builder only knew how to inline images as data URLs. Yet the upload
*storage* layer, the `attachments` skill, and the `materialize` /
`promote-file` / `signed-download` scripts already handled arbitrary
byte streams. The only missing piece was letting a non-image file in at
the front door and telling the model how to read it.

Two ways to deliver a non-image file to the model were considered:

- **Provider-native `document` parts** — inline the bytes as a provider
  content part. Rejected: provider-specific, larger context cost, and it
  duplicates infrastructure the `attachments` skill already owns.
- **Reference + on-demand read (chosen)** — name the file in a text
  marker and let the agent `materialize` + `file_read` it. Provider-
  agnostic, reuses existing skills, and keeps large bytes out of every
  turn's context until the agent actually needs them.

The image path is unchanged: images still inline as `image_url` data
URLs, and `vision_query` remains image-only (`image/png` / `image/jpeg`)
— a non-image upload never lands in a vision call because both the
`image_url` path and `vision_query` gate on `image/*` downstream.

## Consequences

- The `/api/uploads` trust boundary widens to any plausible MIME. This is
  safe: the bytes are stored opaquely and only ever leave the gateway via
  the authenticated `GET /api/uploads/:id` path or an explicit agent
  action (`materialize`, `signed-upload`), each of which the agent must
  choose. The web BFF still injects the bearer server-side; browser code
  never sees it.
- Sent non-image attachments must render as a **file chip** (mobile +
  web transcript), not an `<Image>`/`<img>` — a non-image upload served
  as an image would be a broken render. The persisted block carries no
  original filename (`ImageAttachment` is `{ id, mimeType, size }`), so
  the transcript chip shows the mime subtype + size, not a name.
- The agent depends on the `attachments` skill to consume a chat-attached
  file. The skill documents the `Attached files (in order):` marker and
  the `materialize` → `file_read` recipe.

## Acceptance Checks

- `POST /api/uploads` with `application/pdf` / `text/csv` returns 201 and
  the bytes round-trip via `GET /api/uploads/:id` with the right
  `content-type`; a structurally-invalid mime is rejected by
  `isPlausibleMime`; an empty body returns 400.
- A user message with a non-image attachment carries the `Attached files
  (in order):` marker; the agent materializes the uploadId and reads the
  contents in its reply.
- `vision_query` still rejects non-image MIME.
- Sent non-image attachments render as a file chip on mobile and web,
  never as a broken image.
