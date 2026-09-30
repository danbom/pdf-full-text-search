'use client'

import { type FormEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import { clearHighlights, layerRanges, paintHighlights } from '../lib/highlight'
import { type Doc, type Hit, fold, foldQuery, indexBytes, indexPages, newIndex, search, snippet } from '../lib/search'

// 1편과 같습니다. 워커는 번들러가 직접 해석하게 둡니다.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

const DOCS = { long: '/long.pdf', wrap: '/wrap.pdf' } as const
type DocName = keyof typeof DOCS
// eager: 문서를 열자마자 모든 쪽을 한꺼번에 요청 / after: 첫 텍스트 레이어가 뜬 뒤 c쪽씩 동시에 / lazy: 처음 검색할 때 한 쪽씩(pdf.js 기본 뷰어 방식) / off: 색인 없음
type Strategy = 'eager' | 'after' | 'lazy' | 'off'
// range: 텍스트 레이어는 그대로 두고 CSS Custom Highlight API로 칠하기 / item: customTextRenderer로 조각(item)마다 <mark> 씌우기
type Hl = 'range' | 'item'
type Opts = { doc: DocName; strategy: Strategy; c: number; hl: Hl }
type Size = { width: number; height: number }
type TextRenderer = (item: { str: string }) => string
type SlotProps = { n: number; size: Size; onRender: (n: number) => void; onText: (n: number) => void; renderer?: TextRenderer }
type Times = { firstCanvas?: number; firstText?: number; indexStart?: number; indexDone?: number; firstHit?: number; highlight?: number }

const SCALE = 1
const SHOWN = 100 // 결과 목록에는 앞에서부터 이만큼만 보여 줘요
const LAYER = '.react-pdf__Page__textContent'
// Range 방식의 색. ::highlight()는 Turbopack의 CSS 파서가 아직 몰라서 globals.css에 두면 빌드 경고가 나요. 그래서 여기 둡니다.
const HIGHLIGHT_CSS =
  '::highlight(search){background-color:rgba(250,204,21,.45)}::highlight(search-current){background-color:rgba(249,115,22,.6)}'

// 4편과 같은 "보이는 쪽만" 그리기. 콜백은 쪽마다 고정해서 텍스트 레이어가 다시 그려지지 않게 해요.
const LazyPage = memo(function LazyPage({ n, size, onRender, onText, renderer }: SlotProps) {
  const render = useCallback(() => onRender(n), [n, onRender])
  const text = useCallback(() => onText(n), [n, onText])
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '100% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div ref={ref} className="slot" data-page={n} style={size}>
      {near ? (
        <Page
          pageNumber={n}
          scale={SCALE}
          renderAnnotationLayer={false}
          onRenderSuccess={render}
          onRenderTextLayerSuccess={text}
          customTextRenderer={renderer}
        />
      ) : (
        <span className="num">{n}</span>
      )}
    </div>
  )
})

// 흔히 쓰는 하이라이트: customTextRenderer가 텍스트 조각(item) 하나씩 받아 검색어를 <mark>로 감싸요.
// 조각 하나 안에 검색어가 통째로 있을 때만 칠할 수 있어요.
function itemRenderer(query: string): TextRenderer | undefined {
  if (!query) return undefined
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return ({ str }) => {
    let out = ''
    let last = 0
    for (const m of str.matchAll(re)) {
      const at = m.index ?? 0
      out += esc(str.slice(last, at)) + '<mark>' + esc(m[0]) + '</mark>'
      last = at + m[0].length
    }
    return out + esc(str.slice(last))
  }
}

// 지금 DOM에 있는 텍스트 레이어에서만 찾으면 몇 곳인지 셉니다. 브라우저 찾기(Ctrl+F)가 볼 수 있는 범위예요.
function countInDom(q: string) {
  if (!q) return 0
  let count = 0
  for (const layer of document.querySelectorAll(LAYER)) {
    const text = fold(layer.textContent ?? '').folded
    for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) count++
  }
  return count
}

export default function Lab() {
  const [opts, setOpts] = useState<Opts | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [size, setSize] = useState<Size | null>(null)
  const [times, setTimes] = useState<Times>({})
  const [progress, setProgress] = useState(0) // 색인한 쪽 수
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<number | null>(null)
  const [dom, setDom] = useState({ layers: 0, count: 0, painted: 0, marks: 0 })

  const optsRef = useRef<Opts | null>(null)
  const pdfRef = useRef<Doc | null>(null)
  const index = useRef(newIndex())
  const started = useRef(false)
  const qRef = useRef('') // 접은 검색어
  const hitsRef = useRef<Hit[]>([])
  const currentRef = useRef<number | null>(null)
  const jumpStart = useRef<number | null>(null)
  const submitAt = useRef<number | null>(null)
  const ranges = useRef(new Map<number, Range[]>())
  const maps = useRef(new Map<number, number[]>())

  // ?doc=long|wrap &index=eager|after|lazy|off &c=1|4 &hl=range|item
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const pick = <T extends string>(v: string | null, all: readonly T[], d: T) => (all.includes(v as T) ? (v as T) : d)
    const o: Opts = {
      doc: pick(q.get('doc'), ['long', 'wrap'] as const, 'long'),
      strategy: pick(q.get('index'), ['eager', 'after', 'lazy', 'off'] as const, 'after'),
      c: Math.max(1, Number(q.get('c')) || 4),
      hl: pick(q.get('hl'), ['range', 'item'] as const, 'range'),
    }
    optsRef.current = o
    setOpts(o)
  }, [])

  const now = () => Math.round(performance.now())

  // 색인 진행 상황은 0.1초에 한 번만 화면에 반영해요. 쪽마다 setState하면 300번 다시 그려져요.
  const tick = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onIndexed = useCallback(() => {
    if (tick.current) return
    tick.current = setTimeout(() => {
      tick.current = null
      setProgress(index.current.done)
    }, 100)
  }, [])

  const startIndex = useCallback(
    (concurrency: number) => {
      const pdf = pdfRef.current
      if (started.current || !pdf) return
      started.current = true
      setTimes((t) => ({ ...t, indexStart: now() }))
      const pages = Array.from({ length: pdf.numPages }, (_, i) => i + 1)
      indexPages(pdf, pages, index.current, { concurrency, onPage: onIndexed }).then(() => {
        setTimes((t) => ({ ...t, indexDone: now() }))
        setProgress(index.current.done)
      })
    },
    [onIndexed],
  )

  // 그려진 텍스트 레이어의 Range를 모아 다시 칠합니다.
  const repaint = useCallback(() => {
    for (const [n, list] of ranges.current) if (!list[0]?.startContainer.isConnected) ranges.current.delete(n)
    const hit = currentRef.current === null ? undefined : hitsRef.current[currentRef.current]
    const cur = hit ? ranges.current.get(hit.page)?.[hit.ordinal] : undefined
    paintHighlights([...ranges.current.values()].flat(), cur)
    return cur
  }, [])

  // n쪽 텍스트 레이어가 다 그려졌을 때(또는 검색어가 바뀌었을 때) 그 쪽을 칠해요.
  const paint = useCallback(
    (n: number) => {
      const layer = document.querySelector(`[data-page="${n}"] ${LAYER}`)
      if (optsRef.current?.hl !== 'range' || !layer || !qRef.current) return
      ranges.current.set(n, layerRanges(layer, qRef.current))
      const cur = repaint()
      const hit = currentRef.current === null ? undefined : hitsRef.current[currentRef.current]
      if (cur && hit?.page === n && jumpStart.current !== null) {
        const ms = Math.round(performance.now() - jumpStart.current)
        jumpStart.current = null
        setTimes((t) => ({ ...t, highlight: ms }))
        const top = cur.getBoundingClientRect().top
        window.scrollBy({ top: top - window.innerHeight / 2 })
      }
    },
    [repaint],
  )

  const onRender = useCallback((n: number) => {
    if (n === 1) setTimes((t) => (t.firstCanvas ? t : { ...t, firstCanvas: now() }))
  }, [])
  const onText = useCallback(
    (n: number) => {
      if (n === 1) setTimes((t) => (t.firstText ? t : { ...t, firstText: now() }))
      const o = optsRef.current
      if (o?.strategy === 'after') startIndex(o.c)
      if (o?.hl === 'range') paint(n)
      else {
        // item 방식은 customTextRenderer가 <mark>를 넣은 뒤에 이 콜백이 불려요
        const hit = currentRef.current === null ? undefined : hitsRef.current[currentRef.current]
        if (hit?.page === n && jumpStart.current !== null) {
          const ms = Math.round(performance.now() - jumpStart.current)
          jumpStart.current = null
          setTimes((t) => ({ ...t, highlight: ms }))
        }
      }
    },
    [paint, startIndex],
  )

  // 검색은 색인이 늘어날 때마다 다시 돌려요. 색인이 덜 됐어도 된 쪽까지는 바로 찾습니다.
  const result = useMemo(() => {
    const t = performance.now()
    const hits = search(index.current, query)
    return { hits, ms: performance.now() - t }
  }, [query, progress]) // index.current는 ref라서, 색인이 늘어난 건 progress로 알려요

  useEffect(() => {
    hitsRef.current = result.hits
    if (submitAt.current !== null && result.hits.length > 0) {
      const ms = Math.round(performance.now() - submitAt.current)
      submitAt.current = null
      setTimes((t) => ({ ...t, firstHit: ms }))
    }
  }, [result])

  // 검색어가 바뀌면 지금 그려진 쪽을 전부 다시 칠해요. range 방식은 텍스트 레이어를 다시 그리지 않아요.
  useEffect(() => {
    qRef.current = foldQuery(query)
    ranges.current.clear()
    clearHighlights()
    if (optsRef.current?.hl !== 'range') return
    for (const el of document.querySelectorAll('[data-page]')) paint(Number((el as HTMLElement).dataset.page))
  }, [query, paint])

  // 0.5초마다 DOM 쪽 숫자를 잽니다.
  useEffect(() => {
    const id = setInterval(() => {
      setDom({
        layers: document.querySelectorAll(LAYER).length,
        count: countInDom(qRef.current),
        painted: [...ranges.current.values()].reduce((s, l) => s + l.filter((r) => r.startContainer.isConnected).length, 0),
        marks: document.querySelectorAll(`${LAYER} mark`).length,
      })
    }, 500)
    return () => clearInterval(id)
  }, [])

  // 테스트 스크립트가 읽어 가는 값
  useEffect(() => {
    ;(window as unknown as { __lab: unknown }).__lab = { opts, numPages, times, progress, hits: result.hits.length, searchMs: result.ms, dom, bytes: indexBytes(index.current) }
  })

  const folded = useMemo(() => foldQuery(query), [query])
  const renderer = useMemo(() => (opts?.hl === 'item' ? itemRenderer(query) : undefined), [opts?.hl, query])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    submitAt.current = performance.now()
    setTimes((t) => ({ ...t, firstHit: undefined, highlight: undefined }))
    setCurrent(null)
    currentRef.current = null
    setQuery(input.trim())
    if (optsRef.current?.strategy === 'lazy') startIndex(1)
  }

  const go = (i: number) => {
    const hit = result.hits[i]
    if (!hit) return
    setCurrent(i)
    currentRef.current = i
    setTimes((t) => ({ ...t, highlight: undefined }))
    jumpStart.current = performance.now()
    const slot = document.querySelector(`[data-page="${hit.page}"]`)
    // 텍스트 레이어가 이미 다 그려져 있으면(endOfContent가 붙어 있으면) 바로 칠하고, 아니면 그 쪽으로 가서 기다려요.
    if (slot?.querySelector(`${LAYER} .endOfContent`)) {
      if (optsRef.current?.hl === 'range') paint(hit.page)
      else {
        setTimes((t) => ({ ...t, highlight: 0 }))
        jumpStart.current = null
        slot.scrollIntoView({ block: 'start' })
      }
    } else slot?.scrollIntoView({ block: 'start' })
  }

  const preview = (hit: Hit) => {
    const raw = index.current.raw[hit.page - 1]
    let map = maps.current.get(hit.page)
    if (!map) maps.current.set(hit.page, (map = fold(raw, true).map))
    return snippet(raw, map, hit.at, folded.length)
  }

  if (!opts) return null
  const pages = Array.from({ length: numPages }, (_, i) => i + 1)
  const href = (o: Partial<Opts>) => {
    const m = { ...opts, ...o }
    return `?doc=${m.doc}&index=${m.strategy}&c=${m.c}&hl=${m.hl}`
  }
  const strategies: [Partial<Opts>, string][] = [
    [{ strategy: 'eager' }, '열자마자 전부'],
    [{ strategy: 'after', c: 1 }, '1쪽 글자 뒤 1쪽씩'],
    [{ strategy: 'after', c: 4 }, '1쪽 글자 뒤 4쪽씩'],
    [{ strategy: 'lazy' }, '처음 검색할 때'],
    [{ strategy: 'off' }, '색인 없음'],
  ]
  const on = (o: Partial<Opts>) => Object.entries(o).every(([k, v]) => opts[k as keyof Opts] === v)
  const ms = (v?: number) => (v === undefined ? '-' : `${v.toLocaleString()}ms`)

  return (
    <>
      <style>{HIGHLIGHT_CSS}</style>
      <div className="panel sticky">
        <div className="row">
          <strong>문서</strong>
          <a className="btn" aria-current={opts.doc === 'long' ? 'page' : undefined} href={href({ doc: 'long' })}>
            300쪽
          </a>
          <a className="btn" aria-current={opts.doc === 'wrap' ? 'page' : undefined} href={href({ doc: 'wrap' })}>
            줄 바꿈 1쪽
          </a>
          <strong>칠하기</strong>
          <a className="btn" aria-current={opts.hl === 'range' ? 'page' : undefined} href={href({ hl: 'range' })}>
            Range
          </a>
          <a className="btn" aria-current={opts.hl === 'item' ? 'page' : undefined} href={href({ hl: 'item' })}>
            조각마다 &lt;mark&gt;
          </a>
        </div>
        <div className="row">
          <strong>색인</strong>
          {strategies.map(([o, label]) => (
            <a key={label} className="btn" aria-current={on(o) ? 'page' : undefined} href={href(o)}>
              {label}
            </a>
          ))}
        </div>
        <form className="row" onSubmit={submit}>
          <input name="q" value={input} onChange={(e) => setInput(e.target.value)} placeholder={opts.doc === 'wrap' ? '임상시험' : 'Section 250'} />
          <button type="submit">찾기</button>
        </form>
        <table>
          <tbody>
            <tr>
              <th>1쪽 그림 · 1쪽 글자</th>
              <td>
                {ms(times.firstCanvas)} · {ms(times.firstText)} <span className="mute">(페이지를 연 뒤)</span>
              </td>
              <th>색인</th>
              <td>
                {progress}/{numPages}쪽 · 완료 {ms(times.indexDone)} · {Math.round(indexBytes(index.current) / 1024).toLocaleString()}KB
              </td>
            </tr>
            <tr>
              <th>찾은 곳</th>
              <td>
                색인 {result.hits.length.toLocaleString()}곳 ({result.ms.toFixed(1)}ms) · DOM {dom.count}곳{' '}
                <span className="mute">(텍스트 레이어 {dom.layers}쪽)</span>
              </td>
              <th>칠한 곳</th>
              <td>
                {opts.hl === 'range' ? `Range ${dom.painted}곳` : `<mark> ${dom.marks}개`} · 누르고 칠하기까지 {ms(times.highlight)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="note">
          {numPages}쪽 · devicePixelRatio {window.devicePixelRatio} · 색인 {strategies.find(([o]) => on(o))?.[1] ?? opts.strategy}
          {times.firstHit !== undefined ? ` · 검색하고 첫 결과까지 ${times.firstHit}ms` : ''}
        </p>
        {query && (
          <ol className="hits">
            {result.hits.slice(0, SHOWN).map((hit, i) => {
              const s = preview(hit)
              return (
                <li key={`${hit.page}-${hit.ordinal}`}>
                  <button className={current === i ? 'on' : undefined} onClick={() => go(i)}>
                    <b>{hit.page}쪽</b> {s.before}
                    <mark>{s.match}</mark>
                    {s.after}
                  </button>
                </li>
              )
            })}
            {result.hits.length > SHOWN && <li className="mute">…외 {(result.hits.length - SHOWN).toLocaleString()}곳</li>}
            {result.hits.length === 0 && <li className="mute">{opts.strategy === 'off' ? '색인이 꺼져 있어요' : '찾은 곳이 없어요'}</li>}
          </ol>
        )}
      </div>

      <Document
        file={DOCS[opts.doc]}
        loading="PDF 여는 중…"
        onLoadSuccess={async (pdf) => {
          pdfRef.current = pdf
          if (optsRef.current?.strategy === 'eager') startIndex(pdf.numPages)
          const first = await pdf.getPage(1)
          const vp = first.getViewport({ scale: SCALE })
          setSize({ width: Math.floor(vp.width), height: Math.floor(vp.height) })
          setNumPages(pdf.numPages)
        }}
      >
        <div className="list">
          {size && pages.map((n) => <LazyPage key={n} n={n} size={size} onRender={onRender} onText={onText} renderer={renderer} />)}
        </div>
      </Document>
    </>
  )
}
