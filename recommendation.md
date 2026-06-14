# Recommended Features

- [ ] **Drag-and-drop upload** — drop files directly onto the UI instead of clicking a button
- [ ] **Batch upload** — upload multiple documents at once and process them in parallel
- [ ] **Real-time status updates via WebSocket** — replace 3-second polling with live push from server
- [ ] **Edit extracted text** — inline editing of OCR results with auto-save back to the database
- [ ] **Persistent job queue (Redis + BullMQ)** — survive server restarts, retry failed jobs, parallel workers
- [ ] **Multi-language OCR** — select language per document (spa, fra, deu, jpn, etc.)
- [ ] **Search across documents** — full-text search over all extracted OCR text
- [ ] **PDF export** — download OCR results as a formatted PDF with original image + text side by side
- [ ] **Multi-page PDF support** — extract and OCR each page of a PDF separately
- [ ] **Image rotation and crop** — rotate and crop uploaded images before OCR for better accuracy
- [ ] **User authentication** — login/register to isolate documents per user
- [ ] **Confidence-based highlighting** — overlay low-confidence words on the preview image
- [ ] **Export to DOCX / CSV** — download extracted text in common office formats
- [ ] **Docker Compose deployment** — one-command spin-up with all services containerized
- [ ] **PostgreSQL migration** — swap SQLite for PostgreSQL for production scale