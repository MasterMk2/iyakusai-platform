import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  await context.addCookies([{ name: 'smm_demo_persona', value: 'u-admin', url: 'http://127.0.0.1:18751' }]);
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:18751/#/settings');
  const panel = page.getByTestId('rental-access');
  await panel.getByRole('searchbox').waitFor();
  // Capture the panel on its own. Temporarily make the existing sticky navigation static for this screenshot only.
  const style = '.global-nav { position: static !important; }';
  await panel.screenshot({ path: '.tmp/rental-access-browser/preview-desktop.png', style });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('searchbox').fill('閲覧担当B');
  await panel.screenshot({ path: '.tmp/rental-access-browser/preview-mobile.png', style });
  await context.close();
} finally { await browser.close(); }
