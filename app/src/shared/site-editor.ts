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
  /** The editor's page in this app, for a person who may edit. */
  editorUrl: string | null;
  /** Where the published site is seen, for a person who may edit, when the configuration says. */
  siteUrl: string | null;
}
