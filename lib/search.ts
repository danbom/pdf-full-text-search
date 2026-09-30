// 텍스트 레이어 없이 문서 전체에서 찾기.
// 쪽마다 page.getTextContent()로 글자를 뽑아 두고(색인), 검색어와 문서 글자를 같은 규칙으로 "접어서" 비교해요.

// pdf.js 타입을 직접 가져오지 않으려고 쓰는 만큼만 적었어요. react-pdf의 onLoadSuccess가 넘기는 pdf를 그대로 넘기면 됩니다.
// items에는 글자 조각(TextItem)과, str이 없는 marked content 표시(TextMarkedContent)가 섞여 있어요.
export type Doc = {
  numPages: number
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: object[] }> }>
}

export type Index = {
  raw: string[] // 쪽 번호 - 1 → 뽑은 글자 그대로(줄 끝은 '\n')
  folded: string[] // 쪽 번호 - 1 → 접은 글자
  done: number
}
export type Hit = { page: number; ordinal: number; at: number } // ordinal: 그 쪽에서 몇 번째로 찾은 것인지

export const newIndex = (): Index => ({ raw: [], folded: [], done: 0 })

// getTextContent()의 조각(item)을 이어 붙여요. hasEOL은 그 조각 뒤에서 줄이 바뀐다는 뜻이에요.
export const pageText = (items: object[]) =>
  items.map((it) => ('str' in it ? String(it.str) : '') + ('hasEOL' in it && it.hasEOL ? '\n' : '')).join('')

// 버리는 글자: 공백과 줄 바꿈 전부, 하이픈(-, U+00AD soft hyphen, U+2010, U+2011).
// - 공백을 버리면 줄 끝에서 잘린 「임상시\n험」과 띄어 쓴 검색어 「임상 시험」을 같이 찾아요
// - 하이픈을 버리면 줄 끝에서 단어를 자른 「Pharmacovigi-\nlance」와 원래 하이픈이 있던 「self-\nreported」를 같이 찾아요.
//   글자만 봐서는 둘을 구별할 수 없어서, 둘 다 없애는 쪽을 골랐어요
const SKIP = /[\s\u00ad\u2010\u2011]/u

// 검색용으로 글자를 접어요. NFKC(합자 ﬁ → fi, 전각 → 반각) + 소문자 + 공백·하이픈 버리기.
// withMap이면 접은 글자 i번째가 원래 글자 몇 번째에서 왔는지(map[i])도 돌려줘요. 미리 보기와 하이라이트에 씁니다.
export function fold(raw: string, withMap = false): { folded: string; map: number[] } {
  const out: string[] = []
  const map: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const start = i
    let c = raw.charCodeAt(i)
    if (c < 128) {
      if (c <= 32 || c === 45) continue // 공백·제어 문자·하이픈
      if (c >= 65 && c <= 90) c += 32 // A-Z → a-z
      out.push(String.fromCharCode(c))
      if (withMap) map.push(start)
      continue
    }
    let ch = raw[i]
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < raw.length) ch += raw[++i] // 서로게이트 쌍은 한 글자로
    if (SKIP.test(ch)) continue
    const f = ch.normalize('NFKC').toLowerCase()
    out.push(f)
    if (withMap) for (let j = 0; j < f.length; j++) map.push(start)
  }
  return { folded: out.join(''), map }
}

export const foldQuery = (query: string) => fold(query.normalize('NFC')).folded

// 쪽 번호 목록을 concurrency개씩 동시에 색인해요. concurrency를 쪽 수만큼 주면 한꺼번에 요청하는 것과 같아요.
export async function indexPages(
  doc: Doc,
  pages: number[],
  index: Index,
  { concurrency = 1, onPage }: { concurrency?: number; onPage?: (n: number) => void } = {},
) {
  let next = 0
  const worker = async () => {
    while (next < pages.length) {
      const n = pages[next++]
      const page = await doc.getPage(n)
      const { items } = await page.getTextContent()
      const raw = pageText(items)
      index.raw[n - 1] = raw
      index.folded[n - 1] = fold(raw).folded
      index.done++
      onPage?.(n)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, worker))
}

// 색인된 쪽에서만 찾아요. 겹치지 않게 앞에서부터 셉니다(하이라이트도 같은 규칙으로 세야 ordinal이 맞아요).
export function search(index: Index, query: string): Hit[] {
  const q = foldQuery(query)
  const hits: Hit[] = []
  if (!q) return hits
  index.folded.forEach((text, i) => {
    let ordinal = 0
    for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) hits.push({ page: i + 1, ordinal: ordinal++, at })
  })
  return hits
}

// 찾은 곳 앞뒤 글자를 원래 글자로 보여 줘요. map은 fold(raw, true).map입니다.
export function snippet(raw: string, map: number[], at: number, length: number, pad = 24) {
  const s = map[at]
  let e = map[at + length - 1] + 1
  if (e < raw.length && /[\udc00-\udfff]/.test(raw[e])) e++
  const flat = (t: string) => t.replace(/\s+/g, ' ')
  const from = Math.max(0, s - pad)
  const to = Math.min(raw.length, e + pad)
  return {
    before: (from > 0 ? '…' : '') + flat(raw.slice(from, s)),
    match: flat(raw.slice(s, e)),
    after: flat(raw.slice(e, to)) + (to < raw.length ? '…' : ''),
  }
}

export const indexBytes = (index: Index) =>
  index.raw.reduce((sum, r, i) => sum + (r.length + (index.folded[i]?.length ?? 0)) * 2, 0)
