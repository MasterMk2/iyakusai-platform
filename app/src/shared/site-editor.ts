// The website editor (2026-11-23): WebGenEngine's editor, behind this app. The app signs people in and decides who may
// edit or publish; the editor's own server (a container of its own) answers only the requests the app signs
// (docs/site-editor.md).

/** Every path of the editor is under this prefix: outside /api/, so the editor's own requests need no X-SMM-CSRF. */
export const SITE_EDITOR_PREFIX = '/site-editor';

/** The client ID the app signs the editor's requests with (svc-auth/v1); the editor's server is told the same. */
export const SITE_EDITOR_CLIENT = 'iyakusai-app';

export interface SiteEditorMetaResponse {
  /** site-editor.json is in place and this person is a committee member who could be named in it. */
  enabled: boolean;
  canEdit: boolean;
  /** Publishing and taking a publish back; implies canEdit. */
  canPublish: boolean;
  /** An access administrator: chooses who may write and who may publish. */
  canAdminister: boolean;
  /** The editor's page in this app (the list of posts), for a person who may edit. */
  editorUrl: string | null;
  /** Where the published site is seen, for a person who may edit, when the configuration says. */
  siteUrl: string | null;
}

/** Who may write (edit) and who may publish (2026-11-23): chosen by the access administrators on the settings screen. */
export interface SiteEditorAccess {
  /** Writing: every committee member, or only the departments and people listed. */
  editors: { everyone: boolean; departments: string[]; userIds: string[] };
  /** Publishing (and taking a publish back): the departments and people listed. Access administrators always may. */
  publishers: { departments: string[]; userIds: string[] };
  /** 0 until the first save on the screen (then the configuration's lists apply). */
  version: number;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface SiteEditorAccessResponse {
  access: SiteEditorAccess;
  choices: {
    departments: string[];
    people: { id: string; name: string; departments: string[] }[];
  };
}

export const SITE_EDITOR_LIMITS = { departments: 50, people: 200 } as const;

/** The website's tab inside the app (2026-11-23; #/settings/site, its first address under the settings, opens it too). */
export const SITE_HREF = '#/site';

/** A post as the editor's server lists it (GET /site-editor/api/pages, WebGenEngine's blog.md). */
export interface SiteEditorPage {
  id: string;
  /** Null for a page that has no title yet. */
  title: string | null;
  /** YYYY-MM-DD, or null. */
  date: string | null;
  /** On the site now. */
  published: boolean;
  /** Last save of the draft, in milliseconds. */
  savedAt: number | null;
}

export interface SiteEditorPagesResponse {
  ok: boolean;
  pages: SiteEditorPage[];
}

/** The editor opened on one post. */
export function siteEditorPostHref(id: string): string {
  return `${SITE_EDITOR_PREFIX}/editor/index.html#p=${encodeURIComponent(id)}`;
}

/** Newest first: by the post's date, then by the last save; a post without a date last. */
export function sortSitePages(pages: SiteEditorPage[]): SiteEditorPage[] {
  return [...pages].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.savedAt ?? 0) - (a.savedAt ?? 0) || a.id.localeCompare(b.id));
}
