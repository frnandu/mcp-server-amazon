import fs from 'fs'
import puppeteer from 'puppeteer'
import { COOKIES_FILE_PATH, MCP_CONFIG_PATHS } from './config.js'

export interface AmazonCookie {
  domain: string
  expirationDate?: number
  expires?: number
  hostOnly?: boolean
  httpOnly: boolean
  name: string
  path: string
  sameSite?: 'Strict' | 'Lax' | 'None'
  secure: boolean
  session?: boolean
  storeId?: string | null
  value: string
}

interface AmazonCredentials {
  email: string
  password: string
  domain?: string
}

/** Get the current timestamp like "2024-06-06_15-30-45" */
export function getTimestamp() {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(
    now.getSeconds()
  )}`
}

export function loadAmazonCookiesFile(options?: { throwIfMissing?: boolean }): AmazonCookie[] {
  if (!fs.existsSync(COOKIES_FILE_PATH)) {
    if (options?.throwIfMissing) {
      throw new Error(
        `No amazonCookies.json file found at ${COOKIES_FILE_PATH}. Either create it manually or configure AMAZON_EMAIL and AMAZON_PASSWORD so the server can generate it automatically.`
      )
    }
    return []
  }

  try {
    const json = JSON.parse(fs.readFileSync(COOKIES_FILE_PATH, 'utf-8'))
    if (!Array.isArray(json)) {
      throw new Error('amazonCookies.json must contain an array of cookies')
    }

    console.error('[INFO] Loaded Amazon cookies from file')
    return json.map((cookie: AmazonCookie) => ({
      ...cookie,
      sameSite: cookie.sameSite || 'Lax',
    }))
  } catch (error: any) {
    throw new Error(`Error reading or parsing amazonCookies.json: ${error.message}`)
  }
}

export function saveAmazonCookiesFile(cookies: AmazonCookie[]) {
  fs.writeFileSync(COOKIES_FILE_PATH, JSON.stringify(cookies, null, 2))
  console.error(`[INFO] Saved ${cookies.length} Amazon cookies to ${COOKIES_FILE_PATH}`)
}

export function getAmazonDomain(): string {
  const envDomain = process.env.AMAZON_DOMAIN?.trim()
  if (envDomain) {
    return stripAmazonDomain(envDomain)
  }

  const credentialsDomain = getAmazonCredentialsFromConfig()?.domain
  if (credentialsDomain) {
    return stripAmazonDomain(credentialsDomain)
  }

  const cookies = loadAmazonCookiesFile()
  const cookieDomain =
    cookies.find(cookie => cookie.domain?.startsWith('.amazon.'))?.domain ||
    cookies.find(cookie => cookie.domain?.includes('amazon'))?.domain

  if (cookieDomain) {
    const domain = stripAmazonDomain(cookieDomain)
    console.error(`[INFO] Detected Amazon domain from cookies: ${domain}`)
    return domain
  }

  console.error('[WARN] Could not detect Amazon domain from cookies or config, using default amazon.com')
  return 'amazon.com'
}

function stripAmazonDomain(domain: string) {
  return domain.replace(/^\./, '').replace(/^www\./, '')
}

function normalizeCookie(cookie: puppeteer.Cookie): AmazonCookie {
  return {
    domain: cookie.domain,
    expirationDate: cookie.expires,
    expires: cookie.expires,
    hostOnly: false,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    sameSite: cookie.sameSite as AmazonCookie['sameSite'],
    secure: cookie.secure,
    session: cookie.session,
    storeId: null,
    value: cookie.value,
  }
}

function extractAmazonCredentialsFromEnv(): AmazonCredentials | null {
  const email = process.env.AMAZON_EMAIL || process.env.AMAZON_LOGIN || process.env.AMAZON_USERNAME
  const password = process.env.AMAZON_PASSWORD
  const domain = process.env.AMAZON_DOMAIN

  if (email && password) {
    return {
      email,
      password,
      domain,
    }
  }

  return null
}

function extractAmazonCredentialsFromMcpServer(serverConfig: any): AmazonCredentials | null {
  const env = serverConfig?.env || {}
  const email = env.AMAZON_EMAIL || env.AMAZON_LOGIN || env.AMAZON_USERNAME || serverConfig?.login || serverConfig?.email
  const password = env.AMAZON_PASSWORD || serverConfig?.password
  const domain = env.AMAZON_DOMAIN || serverConfig?.domain

  if (!email || !password) {
    return null
  }

  return {
    email,
    password,
    domain,
  }
}

function getAmazonCredentialsFromConfig(): AmazonCredentials | null {
  const envCredentials = extractAmazonCredentialsFromEnv()
  if (envCredentials) {
    return envCredentials
  }

  for (const configPath of MCP_CONFIG_PATHS) {
    if (!fs.existsSync(configPath)) {
      continue
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const servers = config?.mcpServers || {}

      for (const [serverName, serverConfig] of Object.entries<any>(servers)) {
        const looksLikeAmazonServer =
          serverName === 'amazon' ||
          JSON.stringify(serverConfig?.args || []).includes('mcp-server-amazon') ||
          JSON.stringify(serverConfig || {}).toLowerCase().includes('amazon')

        if (!looksLikeAmazonServer) {
          continue
        }

        const credentials = extractAmazonCredentialsFromMcpServer(serverConfig)
        if (credentials) {
          console.error(`[INFO] Loaded Amazon credentials from MCP config ${configPath}`)
          return credentials
        }
      }
    } catch (error) {
      console.error(`[WARN] Failed to read MCP config at ${configPath}:`, error)
    }
  }

  return null
}

export function getConfiguredAmazonCredentialsOrThrow(): AmazonCredentials {
  const credentials = getAmazonCredentialsFromConfig()
  if (!credentials) {
    throw new Error(
      'Amazon login is required, but no credentials were found. Configure AMAZON_EMAIL and AMAZON_PASSWORD either as environment variables or inside your MCP server config.'
    )
  }

  return credentials
}

export async function createBrowserAndPage(): Promise<{ browser: puppeteer.Browser; page: puppeteer.Page }> {
  const browser = await puppeteer.launch({
    headless: true,
    devtools: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
  })

  const cookies = loadAmazonCookiesFile()
  if (cookies.length > 0) {
    await browser.setCookie(...cookies)
    console.error('[INFO] Set Amazon cookies in the browser')
  } else {
    console.error('[WARN] No Amazon cookies found, proceeding without them')
  }

  const page = await browser.newPage()

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    })
  })

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  )

  await page.setViewport({ width: 1366, height: 768 })

  return { browser, page }
}

export async function persistBrowserCookies(browser: puppeteer.Browser) {
  const cookies = (await browser.cookies()).filter((cookie: puppeteer.Cookie) => cookie.domain.includes('amazon'))
  saveAmazonCookiesFile(cookies.map(normalizeCookie))
}

export async function downloadImageAsBase64(url: string): Promise<string> {
  const response = await fetch(url)
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const b64 = buffer.toString('base64')
  return `${b64}`
}

export async function isLoginPage(page: puppeteer.Page): Promise<boolean> {
  return (
    (await page.$('#ap_email')) !== null ||
    (await page.$('#signInSubmit')) !== null ||
    (await page.$('#ap_email_login')) !== null ||
    (await page.$('input[name="email"]')) !== null
  )
}

async function isSignedOutExperience(page: puppeteer.Page): Promise<boolean> {
  if (await isLoginPage(page)) {
    return true
  }

  const signInWallSelectors = [
    '#sc-sign-in a[href*="/ap/signin"]',
    'a#nav-link-accountList[href*="/ap/signin"]',
    'a[data-nav-role="signin"][href*="/ap/signin"]',
    'form[name="signIn"]',
  ]

  for (const selector of signInWallSelectors) {
    if (await page.$(selector)) {
      return true
    }
  }

  return false
}

async function clickIfVisible(page: puppeteer.Page, selectors: string[]) {
  for (const selector of selectors) {
    const element = await page.$(selector)
    if (element) {
      await element.click()
      return true
    }
  }

  return false
}

async function clearAndType(page: puppeteer.Page, selector: string, value: string) {
  await page.waitForSelector(selector, { timeout: 10000 })
  await page.$eval(selector, element => {
    const input = element as HTMLInputElement
    input.focus()
    input.value = ''
  })
  await page.type(selector, value, { delay: 35 })
}

function isAdditionalVerificationPage(url: string, bodyText: string) {
  return /ap\/cvf|ap\/mfa|ap\/captcha|challenge/i.test(url) || /otp|one-time password|captcha|verification required/i.test(bodyText)
}

async function resolveSignInEntry(page: puppeteer.Page, domain: string): Promise<string> {
  const currentSignInHref = await page.$eval(
    '#sc-sign-in a[href*="/ap/signin"], a#nav-link-accountList[href*="/ap/signin"], a[data-nav-role="signin"]',
    element => (element as HTMLAnchorElement).href,
  ).catch(() => null)

  if (currentSignInHref) {
    return currentSignInHref
  }

  const homeUrl = `https://www.${domain}/`
  await page.goto(homeUrl, { waitUntil: 'networkidle2', timeout: 30000 })

  const homeSignInHref = await page.$eval(
    'a#nav-link-accountList[href*="/ap/signin"], a[data-nav-role="signin"][href*="/ap/signin"], a[href*="/ap/signin"]',
    element => (element as HTMLAnchorElement).href,
  ).catch(() => null)

  if (homeSignInHref) {
    return homeSignInHref
  }

  throw new Error('Could not find a valid Amazon sign-in entry point for this marketplace.')
}

export async function loginAndPersistSession(page: puppeteer.Page): Promise<void> {
  const credentials = getConfiguredAmazonCredentialsOrThrow()
  const domain = stripAmazonDomain(credentials.domain || getAmazonDomain())
  const signInUrl = await resolveSignInEntry(page, domain)

  console.error(`[INFO] Logging in to Amazon at ${signInUrl}`)
  await page.goto(signInUrl, { waitUntil: 'networkidle2', timeout: 30000 })

  const emailSelector =
    (await page.$('#ap_email')) ? '#ap_email' : (await page.$('#ap_email_login')) ? '#ap_email_login' : 'input[name="email"]'
  await clearAndType(page, emailSelector, credentials.email)

  const hasClassicSubmitButton = (await page.$('#signInSubmit')) !== null
  if (!hasClassicSubmitButton) {
    await clickIfVisible(page, ['#continue', 'button[type="submit"]', 'input[type="submit"]'])
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)
  }

  const passwordSelector =
    (await page.$('#ap_password'))
      ? '#ap_password'
      : (await page.$('#auth-credential-autofill-hint'))
        ? '#auth-credential-autofill-hint'
        : 'input[name="password"]'

  await clearAndType(page, passwordSelector, credentials.password)
  await clickIfVisible(page, ['#signInSubmit', 'input#signInSubmit', '#continue', 'button[type="submit"]', 'input[type="submit"]'])

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)

  const bodyText = await page.evaluate(() => document.body?.innerText || '')
  if (await isLoginPage(page)) {
    throw new Error('Amazon login failed. Please verify the configured login and password.')
  }

  if (isAdditionalVerificationPage(page.url(), bodyText)) {
    throw new Error('Amazon requested extra verification (OTP or captcha). Automatic login cannot continue until that challenge is resolved.')
  }

  await persistBrowserCookies(page.browser())
  console.error('[INFO] Amazon login succeeded and cookies were persisted')
}

export async function ensureLoggedIn(page: puppeteer.Page): Promise<void> {
  if (!(await isSignedOutExperience(page))) {
    return
  }

  const targetUrl = page.url()
  console.error('[WARN] Amazon session is missing or expired, attempting automatic login')
  await loginAndPersistSession(page)

  if (targetUrl && !/\/ap\/signin/i.test(targetUrl) && page.url() !== targetUrl) {
    console.error(`[INFO] Returning to the original page after login: ${targetUrl}`)
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 })
  }
}
