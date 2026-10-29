import sanitizeHtml from 'sanitize-html';
import { Parser } from 'htmlparser2';

// Layer 1 of the HTML defence: an allowlist sanitizer built on htmlparser2.
// The client adds further layers (sandboxed iframe without scripts/forms, CSP
// default-src 'none', no-referrer). Nothing here claims to be verified against
// real-world mail; it is exercised with synthetic hostile samples only.

const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'small',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  // Rewritten below; never emitted with their original attributes.
  'a', 'img',
];

const SAFE_LINK = /^(https?:|mailto:)/i;
const RESOURCE_ATTRS = new Set(['src', 'srcset', 'background', 'poster', 'data', 'href', 'xlink:href']);

export interface SanitizedHtml {
  html: string;
  /** Count of elements/attributes in the original that would have loaded a resource. */
  blockedRemoteResources: number;
}

function countResourceCarriers(html: string): number {
  let count = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        // Links are never followed and form actions are never submitted; neither is a resource load.
        if (tag === 'a' || tag === 'form') return;
        const hasResourceAttr = Object.keys(attribs).some((key) => RESOURCE_ATTRS.has(key.toLowerCase()));
        const styleUrl = /url\s*\(/i.test(attribs.style ?? '');
        if (hasResourceAttr || styleUrl) count += 1;
      },
      ontext(text) {
        // url() or @import inside <style> blocks
        const matches = text.match(/url\s*\(|@import/gi);
        if (matches) count += matches.length;
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return count;
}

export function sanitizeMailHtml(html: string): SanitizedHtml {
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      span: ['class', 'data-href'],
    },
    allowedClasses: { span: ['mail-link', 'blocked-image'] },
    allowedSchemes: [],
    allowedSchemesAppliedToAttributes: [],
    allowProtocolRelative: false,
    allowedStyles: {},
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'template', 'head', 'iframe', 'object', 'svg', 'math'],
    selfClosing: ['br', 'hr'],
    transformTags: {
      a: (_tagName, attribs) => {
        const href = (attribs.href ?? '').trim();
        return {
          tagName: 'span',
          attribs: {
            class: 'mail-link',
            'data-href': SAFE_LINK.test(href) ? href : '（安全でないリンク先を除去）',
          },
        };
      },
      img: () => ({ tagName: 'span', attribs: { class: 'blocked-image' } }),
    },
  });
  return { html: clean, blockedRemoteResources: countResourceCarriers(html) };
}

/** Plain-text display path for HTML-only messages. Tags are dropped, script/style text discarded. */
export function htmlToText(html: string): string {
  const text = sanitizeHtml(html.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '$&\n'), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'template', 'head'],
  });
  return decodeBasicEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
