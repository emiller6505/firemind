import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { Cinzel, IM_Fell_English, Almendra } from 'next/font/google'
import Nav from '@/components/Nav'
import './globals.css'

const cinzel = Cinzel({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-cinzel',
})

const imFell = IM_Fell_English({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-im-fell',
})

const almendra = Almendra({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-almendra',
})

export const metadata: Metadata = {
  title: 'Firemind — MTG Metagame Oracle',
  description: 'Know what\'s winning before you register. MTG metagame oracle powered by real tournament data.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable} ${cinzel.variable} ${imFell.variable} ${almendra.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){try{var t=localStorage.getItem('fm_theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}})();
        `}} />
      </head>
      <body className="bg-canvas text-ink antialiased min-h-screen font-sans">
        <svg className="absolute w-0 h-0" aria-hidden="true">
          <filter id="parchment-edge">
            <feTurbulence type="turbulence" baseFrequency="0.04" numOctaves="4" seed="2" />
            <feDisplacementMap in="SourceGraphic" scale="4" />
          </filter>
        </svg>
        <Nav />
        {children}
      </body>
    </html>
  )
}
