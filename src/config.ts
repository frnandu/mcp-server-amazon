const __dirname = new URL('.', import.meta.url).pathname

export const IS_BROWSER_VISIBLE = false

/** Use local mock files instead of live scraping */
export const USE_MOCKS = false

/** Export live scraping HTML to mocks for future use */
export const EXPORT_LIVE_SCRAPING_FOR_MOCKS = true

export const COOKIES_FILE_PATH = `${__dirname}/../amazonCookies.json`
export const PURCHASE_STATE_FILE_PATH = `${__dirname}/../amazonPurchaseState.json`
export const MCP_CONFIG_PATHS = [
  process.env.MCP_CONFIG_PATH,
  `${process.env.HOME || ''}/Library/Application Support/Claude/claude_desktop_config.json`,
  `${process.env.HOME || ''}/.config/Claude/claude_desktop_config.json`,
  `${process.env.HOME || ''}/.claude/claude_desktop_config.json`,
].filter(Boolean) as string[]
/**
 * Go to the Amazon website and log in to your account
 * Then export cookies as JSON using a browser extension like "Cookie-Editor"
 * and paste them in [amazonCookies.json](../amazonCookies.json)
 *
 * @see https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm?hl=fr
 */
