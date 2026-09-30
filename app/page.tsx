'use client'

import dynamic from 'next/dynamic'

// pdf.js는 모듈을 읽는 순간 DOMMatrix를 만들어서 서버에서 평가되면 죽습니다(1편 내용).
const Lab = dynamic(() => import('./lab'), {
  ssr: false,
  loading: () => <p>뷰어 불러오는 중…</p>,
})

export default function Page() {
  return (
    <main>
      <h1>텍스트 레이어 없이 PDF 전체에서 찾기</h1>
      <p className="sub">
        화면 근처 쪽만 그리는 뷰어에서, getTextContent()로 만든 색인으로 문서 전체를 찾아요. 색인을 언제 만들지 바꿔 보고,
        「줄 바꿈 1쪽」 문서에서 줄 끝에서 잘린 단어를 찾아 칠해 보세요. 설정을 바꾸면 페이지를 새로 불러와요.
      </p>
      <Lab />
    </main>
  )
}
