import { describe, expect, it } from 'vitest';
import { MALICIOUS_HTML } from '../../src/server/connector/fixtures.js';
import { htmlToText, sanitizeMailHtml } from '../../src/server/domain/sanitize.js';

describe('sanitizeMailHtml', () => {
  const { html, blockedRemoteResources } = sanitizeMailHtml(MALICIOUS_HTML);

  it('removes scripts, event handlers, forms, frames, embeds and styles', () => {
    expect(html).not.toMatch(/<script|<style|<form|<input|<button|<iframe|<object|<embed|<svg|<video|<meta|<base|<link/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/__smmXss/);
    expect(html).not.toMatch(/style=/i);
  });

  it('leaves no attribute that could load a resource or navigate', () => {
    expect(html).not.toMatch(/\s(src|srcset|href|background|poster|action|formaction|xlink:href)\s*=/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('turns links into inert text spans and images into placeholders', () => {
    expect(html).toContain('<span class="mail-link" data-href="https://phishing.example/login">ここをクリック</span>');
    expect(html).toContain('data-href="（安全でないリンク先を除去）"');
    expect(html).toContain('<span class="blocked-image"></span>');
    expect(blockedRemoteResources).toBeGreaterThanOrEqual(8);
  });

  it('keeps benign structure and text', () => {
    expect(html).toContain('<h2>危険な HTML を含む合成メールです</h2>');
    expect(html).toContain('背景画像付き要素');
  });

  it('drops attacker-supplied classes and data attributes outside the allowlist', () => {
    const out = sanitizeMailHtml('<span class="evil mail-link" id="x" data-x="1">t</span><p class="a">p</p>').html;
    expect(out).toBe('<span class="mail-link">t</span><p>p</p>');
  });
});

describe('htmlToText', () => {
  it('provides a plain-text path without script or style content', () => {
    const text = htmlToText(MALICIOUS_HTML);
    expect(text).toContain('危険な HTML を含む合成メールです');
    expect(text).toContain('ここをクリック');
    expect(text).not.toMatch(/__smmXss|tracker\.example|<script/);
  });
});
