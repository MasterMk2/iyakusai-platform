// Content-Disposition for a download: an ASCII fallback plus the RFC 5987 name (2026-11-03, review L2).
// encodeURIComponent leaves ! ' ( ) * unescaped, which RFC 5987's attr-char does not allow, so they are
// escaped here. Control characters and line breaks never reach the header (they are escaped as %xx).
// One implementation for every download (mail attachments, contacts, minutes, Bot files).

export function attachmentDisposition(name: string, fallback = 'attachment'): string {
  // The ASCII name: printable, no quote/backslash/semicolon. When no letter or digit survives (a Japanese-only
  // name), the fallback is clearer than a row of underscores.
  const printable = name.replace(/[^\x20-\x7e]|["\\;]/g, '_').trim();
  const ascii = /[A-Za-z0-9]/.test(printable) ? printable : fallback;
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
