# AGENTS.md

## Setup

```sh
npm install
npm --prefix server install
npm --prefix client install
```

**Three separate `npm install` calls.** This is not an npm workspace — root `npm install` only pulls `concurrently`.

## Running

```sh
npm run dev            # starts both server (tsx watch) and client (Vite)
npm --prefix server run dev   # server only on :3001
npm --prefix client run dev   # client only on :5173
```

## Type-check

```sh
npm --prefix server exec -- npx tsc --noEmit
npm --prefix client exec -- npx tsc --noEmit
```

Both server and client are TypeScript. Server uses `tsx` at runtime (no build step), client uses Vite.

## Architecture quick facts

- **Server** is ESM (`"type": "module"`), imports use `.js` extensions (e.g., `import db from './db.js'`).
- **SQLite** auto-creates at `server/documents.db` on first import of `server/src/db.ts`. Schema is embedded in that file — no migration tool.
- **Queue** is in-memory, serial (one OCR job at a time). No persistence — crashes lose queued jobs.
- **Vite** proxies `/api` → `http://localhost:3001`. The client never calls the server directly in dev.
- **Uploads** go to `server/uploads/`, which is `.gitignore`d. 50MB limit, allowed types: PNG, JPEG, TIFF, WebP, PDF.

## OCR pipeline (`server/src/ocr-worker.ts`)

Sharp preprocessing: grayscale → normalize(clip 3–97%) → sharpen(σ=1.2) → resize(2500px width) → PNG.

Tesseract config:
- **PSM.SPARSE_TEXT** — chosen for bullet-heavy documents
- `preserve_interword_spaces=1`, `textord_tabfind_find_tables=0`, `classify_bln_numeric_mode=0`

First OCR run downloads `eng.traineddata` (~30 MB) via tesseract.js — expect a slow first job.

### Bullet post-processing

`fixBullets()` runs two passes to correct common Tesseract misreads of bullet symbols into `•` (U+2022):
- **Pass 1**: inline misreads — `e`, `o`, `c`, `®`, `*`, `.`, `-`, `+`, `~` at line starts replaced with `•` when neighboring lines have similar patterns or preceded by a blank line. Also handles `[J] text → • text`.
- **Pass 2**: standalone `[J]` lines where text is on the next line (common in two-column layouts). When two `[J]` lines precede one line with two items, both get bullets.

Output goes through NFC normalization before post-processing.

## Key files

| File | Purpose |
|---|---|
| `server/src/index.ts` | Express API (all routes) |
| `server/src/db.ts` | SQLite schema + connection |
| `server/src/queue.ts` | In-memory job queue |
| `server/src/ocr-worker.ts` | Tesseract OCR + preprocessing + bullet fix |
| `client/src/App.tsx` | Entire React UI (single component) |
| `client/src/api.ts` | API client functions |
| `client/vite.config.ts` | Vite config with `/api` proxy |