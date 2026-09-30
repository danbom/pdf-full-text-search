import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PDF 전체 검색 실험',
  description: 'react-pdf로 보이는 쪽만 그릴 때, getTextContent() 색인으로 문서 전체에서 찾고 CSS Custom Highlight API로 칠합니다',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
