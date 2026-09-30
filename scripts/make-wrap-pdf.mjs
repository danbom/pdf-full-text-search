// scripts/wrap.html을 Chromium으로 인쇄해서 public/wrap.pdf를 다시 씁니다.
// playwright가 필요해요: npm i -D playwright && npx playwright install chromium
// 한국어 글꼴(Noto Sans CJK KR)이 없으면 다른 글꼴로 바뀌어서 줄 폭과 글자 조각이 달라질 수 있어요.
import { chromium } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(pathToFileURL(join(here, 'wrap.html')).href)
await page.evaluate(() => document.fonts.ready)
await page.pdf({ path: join(here, '..', 'public', 'wrap.pdf'), preferCSSPageSize: true })
await browser.close()
console.log('ok public/wrap.pdf')
