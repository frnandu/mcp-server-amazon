import fs from 'fs'
import puppeteer from 'puppeteer'
import { getOrdersHistory } from './orders.js'
import { PURCHASE_STATE_FILE_PATH } from './config.js'
import { createBrowserAndPage, ensureLoggedIn, getAmazonDomain, persistBrowserCookies } from './utils.js'

type PendingPurchasePhase = 'awaiting_blik_code' | 'submitting_blik_code' | 'awaiting_payment_confirmation'

interface PersistedPurchaseState {
  createdAt: string
  updatedAt: string
  phase: PendingPurchasePhase
  checkoutUrl: string
  orderNumber?: string
  confirmationDetected?: boolean
}

interface PendingPurchaseRuntime {
  browser: puppeteer.Browser
  page: puppeteer.Page
}

let pendingPurchaseRuntime: PendingPurchaseRuntime | null = null

function normalizeText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function savePurchaseState(state: PersistedPurchaseState | null) {
  if (!state) {
    if (fs.existsSync(PURCHASE_STATE_FILE_PATH)) {
      fs.unlinkSync(PURCHASE_STATE_FILE_PATH)
    }
    return
  }

  fs.writeFileSync(PURCHASE_STATE_FILE_PATH, JSON.stringify(state, null, 2))
}

function loadPurchaseState(): PersistedPurchaseState | null {
  if (!fs.existsSync(PURCHASE_STATE_FILE_PATH)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(PURCHASE_STATE_FILE_PATH, 'utf-8')) as PersistedPurchaseState
  } catch (error) {
    console.error('[WARN][purchase] Failed to read purchase state file:', error)
    return null
  }
}

async function resetPendingPurchaseState() {
  if (pendingPurchaseRuntime) {
    await pendingPurchaseRuntime.browser.close().catch(() => null)
    pendingPurchaseRuntime = null
  }

  savePurchaseState(null)
}

async function clickFirstVisible(page: puppeteer.Page, selectors: string[]) {
  for (const selector of selectors) {
    const element = await page.$(selector)
    if (element) {
      await element.click().catch(() => element.evaluate(el => (el as HTMLElement).click()))
      return selector
    }
  }

  return null
}

async function clickByVisibleText(page: puppeteer.Page, texts: string[]) {
  const escapedTexts = texts.map(text => text.replace(/"/g, '\\"'))

  for (const text of escapedTexts) {
    const handle = await page.$(
      `::-p-xpath(//*[self::button or self::a or self::span or self::input or self::label][contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), "${text.toUpperCase()}")])`
    )

    if (handle) {
      await handle.click().catch(() => handle.evaluate(el => (el as HTMLElement).click()))
      return text
    }
  }

  return null
}

async function getBodyText(page: puppeteer.Page) {
  return page.evaluate(() => document.body?.innerText || '')
}

async function waitForPotentialNavigation(page: puppeteer.Page, timeout = 20000) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout }).catch(() => null),
    new Promise(resolve => setTimeout(resolve, 2500)),
  ])
}

async function openCheckoutFromCart(page: puppeteer.Page) {
  const domain = getAmazonDomain()
  const cartUrl = `https://www.${domain}/-/en/gp/cart/view.html?ref_=nav_cart`
  await page.goto(cartUrl, { waitUntil: 'networkidle2', timeout: 30000 })
  await ensureLoggedIn(page)
  await page.waitForSelector('body', { timeout: 10000 })

  const selector = await clickFirstVisible(page, [
    'input[name="proceedToRetailCheckout"]',
    '#sc-buy-box-ptc-button input',
    '[data-feature-id="proceed-to-checkout-action"] input',
    'input[aria-labelledby*="checkout"]',
  ])

  if (!selector) {
    const clickedText = await clickByVisibleText(page, ['Proceed to checkout', 'Continue to checkout', 'Checkout', 'Przejdź do kasy', 'Do kasy', 'Przejdz do kasy'])
    if (!clickedText) {
      throw new Error('Could not find the checkout button in the cart.')
    }
  }

  await waitForPotentialNavigation(page)
  await ensureLoggedIn(page)
}

async function continuePastAddressOrSummary(page: puppeteer.Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clickedSelector = await clickFirstVisible(page, [
      'input[name="shipToThisAddress"]',
      'input[name="continue-bottom"]',
      'input[name="continue"]',
      'input[name="ppw-widgetEvent:SetPaymentPlanSelectContinueEvent"]',
      'input[data-testid="bottom-continue-button"]',
      '#checkout-primary-continue-button-id input',
      'button[name="shipToThisAddress"]',
      'button[name="continue"]',
    ])

    if (clickedSelector) {
      await waitForPotentialNavigation(page)
      if (
        clickedSelector === 'input[data-testid="bottom-continue-button"]' ||
        clickedSelector === '#checkout-primary-continue-button-id input' ||
        clickedSelector === 'input[name="shipToThisAddress"]' ||
        clickedSelector === 'button[name="shipToThisAddress"]'
      ) {
        return
      }
      continue
    }

    const clickedText = await clickByVisibleText(page, [
      'Use this address',
      'Continue',
      'Next',
      'Dostarcz na ten adres',
      'Użyj tego adresu',
      'Kontynuuj',
      'Dalej',
    ])
    if (!clickedText) {
      return
    }

    await waitForPotentialNavigation(page)
    if (clickedText === 'Dostarcz na ten adres' || clickedText === 'Use this address' || clickedText === 'Użyj tego adresu') {
      return
    }
  }
}

async function openPaymentMethodChooser(page: puppeteer.Page) {
  const clickedSelector = await clickFirstVisible(page, [
    'input[name*="changePayment" i]',
    'a[href*="payment" i]',
    '[data-testid*="payment" i] a',
    '[data-feature-id*="payment" i] a',
  ])

  if (clickedSelector) {
    await waitForPotentialNavigation(page)
    return true
  }

  const clickedText = await clickByVisibleText(page, [
    'Change payment method',
    'Choose a payment method',
    'Edit payment method',
    'Zmień metodę płatności',
  ])

  if (clickedText) {
    await waitForPotentialNavigation(page)
    return true
  }

  return false
}

async function continuePastPrimeOffer(page: puppeteer.Page) {
  const clickedSelector = await clickFirstVisible(page, [
    'a[href*="/prime/handler?action=decline"]',
    '#prime-decline-button a',
  ])

  if (clickedSelector) {
    await waitForPotentialNavigation(page, 20000)
    return true
  }

  const clickedText = await clickByVisibleText(page, ['Nie, dziękuję', 'Nie, dziekuje', 'No, thanks', 'Nie teraz', 'nie teraz'])
  if (clickedText) {
    await waitForPotentialNavigation(page, 20000)
    return true
  }

  return false
}

async function continuePastSpcReview(page: puppeteer.Page) {
  const clickedSelector = await clickFirstVisible(page, [
    'input[data-testid="SPC_selectPlaceOrder"]',
    '#submitOrderButtonId input',
    '#bottomSubmitOrderButtonId input',
    'input[name="placeYourOrder1"]',
    'input[name="placeYourOrder"]',
    '#placeOrder',
  ])

  if (clickedSelector) {
    await waitForPotentialNavigation(page, 30000)
    return true
  }

  const clickedText = await clickByVisibleText(page, ['Kup teraz', 'Place your order', 'Buy now'])
  if (clickedText) {
    await waitForPotentialNavigation(page, 30000)
    return true
  }

  return false
}

async function getVisiblePaymentText(page: puppeteer.Page) {
  const bodyText = normalizeText(await getBodyText(page))
  const paymentIndex = bodyText.search(/payment|platnosc|platnosci|blik/)
  if (paymentIndex === -1) {
    return bodyText.slice(0, 400)
  }

  return bodyText.slice(paymentIndex, paymentIndex + 600)
}

async function selectBlikPaymentMethod(page: puppeteer.Page) {
  const blikInputAlreadyVisible = await waitForBlikCodeInput(page).catch(() => null)
  if (blikInputAlreadyVisible) {
    return
  }

  const paymentContinueSelector = await clickFirstVisible(page, [
    'input[data-testid="secondary-continue-button"]',
    '#checkout-secondary-continue-button-id input',
  ])
  if (paymentContinueSelector) {
    await waitForPotentialNavigation(page, 20000)
    return
  }

  const skippedPrimeOffer = await continuePastPrimeOffer(page)
  if (skippedPrimeOffer) {
    return
  }

  let bodyText = await getBodyText(page)
  if (!/blik/i.test(bodyText)) {
    await openPaymentMethodChooser(page)
    bodyText = await getBodyText(page)
  }

  const clickedSelector = await clickFirstVisible(page, [
    'input[value*="BLIK" i]',
    'input[aria-label*="BLIK" i]',
    'button[aria-label*="BLIK" i]',
    'label[aria-label*="BLIK" i]',
    'input[id*="blik" i]',
    '[for*="blik" i]',
    '[data-testid*="blik" i]',
  ])

  if (!clickedSelector) {
    const clickedText = await clickByVisibleText(page, ['BLIK'])
    if (!clickedText) {
      const paymentSnippet = await getVisiblePaymentText(page)
      throw new Error(`BLIK payment option was not detected in the Amazon checkout page. Visible payment text: ${paymentSnippet}`)
    }
  }

  await waitForPotentialNavigation(page, 10000)

  const continueSelector = await clickFirstVisible(page, [
    'input[name="ppw-widgetEvent:SelectPaymentOptionEvent"]',
    'input[name="continue-top"]',
    'input[name="continue-bottom"]',
    'input[name="continue"]',
    'input[data-testid="secondary-continue-button"]',
  ])
  if (!continueSelector) {
    await clickByVisibleText(page, ['Use this payment method', 'Continue', 'Kontynuuj', 'Użyj tej metody płatności'])
  }
  await waitForPotentialNavigation(page, 10000)
}

async function waitForBlikCodeInput(page: puppeteer.Page) {
  const selectors = [
    'input[name*="blik" i]',
    'input[id*="blik" i]',
    'input[placeholder*="BLIK" i]',
    'input[aria-label*="BLIK" i]',
    'input[inputmode="numeric"][maxlength="6"]',
    'input[type="tel"][maxlength="6"]',
  ]

  for (let attempt = 0; attempt < 10; attempt++) {
    if (await continuePastPrimeOffer(page)) {
      continue
    }

    if (await continuePastSpcReview(page)) {
      continue
    }

    for (const selector of selectors) {
      const element = await page.$(selector)
      if (element) {
        return selector
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  try {
    const debugPath = '/tmp/amazon-blik-step.html'
    fs.writeFileSync(debugPath, await page.content())
    console.error(`[DEBUG][purchase] Saved checkout HTML to ${debugPath}`)
  } catch (error) {
    console.error('[WARN][purchase] Failed to save checkout HTML for debugging:', error)
  }

  const title = await page.title().catch(() => '')
  const bodyPreview = normalizeText(await getBodyText(page)).slice(0, 1200)
  throw new Error(`Checkout reached the payment step, but no BLIK code input was found. url=${page.url()} title=${title} body=${bodyPreview}`)
}

function nowIso() {
  return new Date().toISOString()
}

function extractOrderNumberFromText(text: string) {
  return text.match(/\b(\d{3}-\d{7}-\d{7}|\d{3}-\d{7}-\d{6})\b/)?.[1]
}

async function waitForOrderConfirmation(page: puppeteer.Page) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const bodyText = await page.evaluate(() => document.body?.innerText || '')
    const orderNumber = extractOrderNumberFromText(bodyText)
    const confirmationDetected =
      /thank you|order placed|order received|zamowienie|potwierdzenie zamowienia|pedido realizado/i.test(bodyText) ||
      Boolean(orderNumber)

    if (confirmationDetected) {
      return {
        confirmationDetected: true,
        orderNumber,
        pageText: bodyText,
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000))
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)
  }

  return {
    confirmationDetected: false,
    orderNumber: undefined,
    pageText: await page.evaluate(() => document.body?.innerText || ''),
  }
}

export async function performPurchase() {
  await resetPendingPurchaseState()

  const { browser, page } = await createBrowserAndPage()

  try {
    await openCheckoutFromCart(page)
    await continuePastAddressOrSummary(page)
    await selectBlikPaymentMethod(page)
    const blikInputSelector = await waitForBlikCodeInput(page)
    await persistBrowserCookies(browser)

    pendingPurchaseRuntime = { browser, page }
    const state: PersistedPurchaseState = {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      phase: 'awaiting_blik_code',
      checkoutUrl: page.url(),
    }
    savePurchaseState(state)

    return {
      success: true,
      status: 'awaiting_blik_code',
      message: 'Amazon checkout is ready for the BLIK code.',
      blikInputSelector,
      checkoutUrl: page.url(),
    }
  } catch (error) {
    await browser.close().catch(() => null)
    pendingPurchaseRuntime = null
    savePurchaseState(null)
    throw error
  }
}

export async function submitBlikCode(blikCode: string) {
  if (!/^\d{6}$/.test(blikCode)) {
    throw new Error('BLIK code must be exactly 6 digits.')
  }

  const persistedState = loadPurchaseState()
  if (!persistedState || persistedState.phase !== 'awaiting_blik_code' || !pendingPurchaseRuntime) {
    throw new Error('No pending BLIK checkout was found. Start with perform-purchase first.')
  }

  const { browser, page } = pendingPurchaseRuntime

  const blikInputSelector = await waitForBlikCodeInput(page)
  await page.click(blikInputSelector, { clickCount: 3 })
  await page.type(blikInputSelector, blikCode, { delay: 40 })

  persistedState.phase = 'submitting_blik_code'
  persistedState.updatedAt = nowIso()
  savePurchaseState(persistedState)

  const clickedSelector =
    (await clickFirstVisible(page, [
      'input[name*="placeYourOrder" i]',
      'input[name*="submit" i]',
      'input[name*="continue" i]',
      'button[type="submit"]',
    ])) || (await clickByVisibleText(page, ['Place your order', 'Use this payment method', 'Continue', 'Confirm']))

  if (!clickedSelector) {
    throw new Error('The BLIK code was entered, but the checkout confirmation button could not be found.')
  }

  await waitForPotentialNavigation(page, 30000)
  await persistBrowserCookies(browser)

  const confirmation = await waitForOrderConfirmation(page)
  const nextState: PersistedPurchaseState = {
    ...persistedState,
    updatedAt: nowIso(),
    phase: 'awaiting_payment_confirmation',
    confirmationDetected: confirmation.confirmationDetected,
    orderNumber: confirmation.orderNumber,
    checkoutUrl: page.url(),
  }
  savePurchaseState(nextState)

  const paymentConfirmation = await confirmPurchasePaid()

  return {
    success: confirmation.confirmationDetected,
    status: paymentConfirmation.confirmed ? 'paid_confirmed' : 'awaiting_payment_confirmation',
    message: paymentConfirmation.confirmed
      ? 'The BLIK code was submitted and the purchase is now visible in Amazon orders.'
      : 'The BLIK code was submitted, but Amazon has not yet exposed the paid order in order history.',
    orderNumber: confirmation.orderNumber,
    confirmationDetected: confirmation.confirmationDetected,
    paymentRegistered: paymentConfirmation.confirmed,
    matchingOrder: paymentConfirmation.matchingOrder,
  }
}

export async function confirmPurchasePaid() {
  const state = loadPurchaseState()
  if (!state) {
    throw new Error('There is no purchase state to confirm.')
  }

  const orders = await getOrdersHistory()
  const matchingOrder = state.orderNumber
    ? orders.find((order: any) => order.orderInfo.orderNumber === state.orderNumber)
    : orders[0]

  const confirmed = Boolean(matchingOrder)

  if (confirmed) {
    await resetPendingPurchaseState()
  } else {
    savePurchaseState({
      ...state,
      updatedAt: nowIso(),
      phase: 'awaiting_payment_confirmation',
    })
  }

  return {
    confirmed,
    orderNumber: state.orderNumber,
    matchingOrder,
  }
}

export async function generateAmazonCookiesFromConfig() {
  const { browser, page } = await createBrowserAndPage()

  try {
    await page.goto(`https://www.${getAmazonDomain()}/ap/signin`, { waitUntil: 'networkidle2', timeout: 30000 })
    await ensureLoggedIn(page)
    await persistBrowserCookies(browser)

    return {
      success: true,
      message: 'Amazon cookies were generated and stored successfully.',
      domain: getAmazonDomain(),
    }
  } finally {
    await browser.close().catch(() => null)
  }
}
