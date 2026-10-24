/** Filter avatar_url values that we trust as `<img src>`: same-origin (`/…`)
 *  or absolute https. Anything else (null, http, javascript:, data:) is
 *  rejected so the consumer falls back to the initials fallback.
 *
 *  Security-Scan 2026-10-24: protokoll-relative URLs (`//evil.example/t.png`)
 *  beginnen zwar mit `/`, werden aber gegen einen fremden Host aufgelöst —
 *  sie werden ebenfalls abgelehnt. */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('//')) return null;
  return url.startsWith('/') || url.startsWith('https://') ? url : null;
}
