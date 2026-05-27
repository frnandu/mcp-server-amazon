import assert from 'node:assert/strict'
import fs from 'fs'
import * as cheerio from 'cheerio'
import { extractCartPageData, isAddToCartConfirmationText } from './cart.js'

const __dirname = new URL('.', import.meta.url).pathname

function readMock(name: string) {
  return fs.readFileSync(`${__dirname}/../mocks/${name}`, 'utf-8')
}

async function main() {
  const emptyCart = extractCartPageData(cheerio.load(readMock('getCartContent_2026-05-27_14-33-17.html')))
  assert.equal(emptyCart.isEmpty, true)
  assert.deepEqual(emptyCart.items, [])

  const populatedCart = extractCartPageData(cheerio.load(readMock('getCartContent.html')))
  assert.equal(populatedCart.isEmpty, false)
  assert.equal(populatedCart.items.length, 2)
  assert.equal(populatedCart.totalItems, 2)
  assert.equal(populatedCart.items[0]?.quantity, 1)
  assert.ok(populatedCart.items[0]?.title)

  assert.equal(isAddToCartConfirmationText('Added to cart'), true)
  assert.equal(isAddToCartConfirmationText('Dodano do koszyka'), true)
  assert.equal(isAddToCartConfirmationText('Something else entirely'), false)

  console.log('amazon.cart.parsers.test: OK')
}

main().catch(error => {
  console.error('amazon.cart.parsers.test: FAILED')
  console.error(error)
  process.exit(1)
})
