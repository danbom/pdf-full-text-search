import { fold } from './search'

// 그려진 텍스트 레이어에서 검색어(접은 글자) 자리를 Range로 돌려줘요.
// 텍스트 노드를 순서대로 모아 같은 규칙으로 접은 뒤, 접은 글자 자리를 (텍스트 노드, 오프셋)으로 되돌립니다.
// 그래서 한 단어가 span 두 개에 걸쳐 있어도(「sta」+「ff」, 「임상시」+ 줄 바꿈 +「험」) Range 하나로 잡혀요.
export function layerRanges(layer: Element, q: string): Range[] {
  const nodes: Text[] = []
  const offsets: number[] = []
  let raw = ''
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.data.length; i++) {
      nodes.push(node)
      offsets.push(i)
    }
    raw += node.data
  }
  const { folded, map } = fold(raw, true)
  const ranges: Range[] = []
  if (!q) return ranges
  // search()와 같은 규칙(겹치지 않게 앞에서부터)으로 세야 색인의 ordinal과 맞아요.
  for (let at = folded.indexOf(q); at !== -1; at = folded.indexOf(q, at + q.length)) {
    const s = map[at]
    const e = map[at + q.length - 1]
    const range = document.createRange()
    range.setStart(nodes[s], offsets[s])
    const end = nodes[e] === nodes[e + 1] && /[\udc00-\udfff]/.test(nodes[e].data[offsets[e] + 1] ?? '') ? 2 : 1
    range.setEnd(nodes[e], offsets[e] + end)
    ranges.push(range)
  }
  return ranges
}

// CSS Custom Highlight API로 칠해요. DOM을 건드리지 않아서 텍스트 레이어를 다시 그리지 않아도 됩니다.
export function paintHighlights(all: Range[], current?: Range) {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return false
  CSS.highlights.set('search', new Highlight(...all))
  if (current) CSS.highlights.set('search-current', new Highlight(current))
  else CSS.highlights.delete('search-current')
  return true
}

export function clearHighlights() {
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.clear()
}
