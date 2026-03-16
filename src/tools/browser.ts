import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';

chromium.use(StealthPlugin());

const MAX_TEXT = 10_000;
const TIMEOUT = 30_000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
];

// Selectors for common Consent Management Platforms
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',                              // OneTrust
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',    // Cookiebot
  '.cc-accept-all',                                            // Cookie Consent
  '[data-testid="accept-all"]',
  'button[id*="accept" i]',
  'button[class*="accept-all" i]',
  '[aria-label*="accept all" i]',
  '[aria-label*="agree" i]',
];

const CONSENT_BUTTON_TEXT = [
  'Accept all', 'Accept All', 'Accept all cookies', 'Accept All Cookies',
  'Allow all', 'Allow All', 'Allow all cookies',
  'I agree', 'I Accept', 'Agree to all',
  'OK', 'Got it',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function wrapExternal(content: string): string {
  return `<<EXTERNAL UNTRUSTED CONTEXT>>\n${content}\n<<END OF THE EXTERNAL UNTRUSTED CONTENT>>`;
}

let _browser: Browser | undefined;
const _sessions = new Map<string, { context: BrowserContext; page: Page }>();

async function getBrowser(): Promise<Browser> {
  if (!(_browser as Browser | undefined)?.isConnected()) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env['DISPLAY'] = env['DISPLAY'] ?? ':99';

    _browser = (await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      env,
    })) as unknown as Browser;
  }
  return _browser!;
}

async function getPage(sessionId: string): Promise<Page> {
  const existing = _sessions.get(sessionId);
  if (existing && !existing.page.isClosed()) return existing.page;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: randomItem(USER_AGENTS),
    viewport: randomItem(VIEWPORTS),
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();
  _sessions.set(sessionId, { context, page });
  return page;
}

async function dismissCookieWall(page: Page): Promise<void> {
  // Brief pause for CMP scripts to render
  await page.waitForTimeout(900).catch(() => undefined);

  // Try known CMP selectors
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 2000 });
        return;
      }
    } catch { /* not present */ }
  }

  // Fallback: match by button text
  for (const text of CONSENT_BUTTON_TEXT) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true });
      if (await btn.isVisible({ timeout: 300 })) {
        await btn.click({ timeout: 2000 });
        return;
      }
    } catch { /* not present */ }
  }
}

async function pageText(page: Page): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (await page.evaluate(() => (globalThis as any).document?.body?.innerText ?? '')) as string;
  return text.slice(0, MAX_TEXT);
}

export async function browserNavigate(sessionId: string, url: string): Promise<string> {
  const page = await getPage(sessionId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await dismissCookieWall(page);
  const title = await page.title();
  const text = await pageText(page);
  return wrapExternal(`Title: ${title}\nURL: ${page.url()}\n\n${text}`);
}

export async function browserClick(sessionId: string, selector: string): Promise<string> {
  const page = await getPage(sessionId);
  await page.click(selector, { timeout: TIMEOUT });
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  return `Clicked "${selector}". Current URL: ${page.url()}`;
}

export async function browserType(sessionId: string, selector: string, text: string): Promise<string> {
  const page = await getPage(sessionId);
  await page.fill(selector, text, { timeout: TIMEOUT });
  return `Typed into "${selector}".`;
}

export async function browserGetText(sessionId: string, selector?: string): Promise<string> {
  const page = await getPage(sessionId);
  const text = selector
    ? await page.locator(selector).innerText({ timeout: TIMEOUT })
    : await pageText(page);
  return wrapExternal(text.slice(0, MAX_TEXT));
}

export async function browserEval(sessionId: string, script: string): Promise<string> {
  const page = await getPage(sessionId);
  const result = await page.evaluate(script);
  return wrapExternal(String(result).slice(0, MAX_TEXT));
}
