import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

const MAX_TEXT = 10_000;
const TIMEOUT = 30_000;

let _browser: Browser | undefined;
const _pages = new Map<string, Page>();

function wrapExternal(content: string): string {
  return `<<EXTERNAL UNTRUSTED CONTEXT>>\n${content}\n<<END OF THE EXTERNAL UNTRUSTED CONTENT>>`;
}

async function getBrowser(): Promise<Browser> {
  if (!_browser?.isConnected()) {
    // Build a clean env without undefined values for Playwright
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env['DISPLAY'] = env['DISPLAY'] ?? ':99';

    _browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
      env,
    });
  }
  return _browser;
}

async function getPage(sessionId: string): Promise<Page> {
  let page = _pages.get(sessionId);
  if (!page || page.isClosed()) {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    _pages.set(sessionId, page);
  }
  return page;
}

async function pageText(page: Page): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = await page.evaluate(() => (globalThis as any).document?.body?.innerText ?? '') as string;
  return text.slice(0, MAX_TEXT);
}

export async function browserNavigate(sessionId: string, url: string): Promise<string> {
  const page = await getPage(sessionId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
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
