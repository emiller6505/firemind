import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import Nav from '@/components/Nav'
import './globals.css'

export const metadata: Metadata = {
  title: 'Firemind — MTG Metagame Oracle',
  description: 'Know what\'s winning before you register. MTG metagame oracle powered by real tournament data.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){try{var t=localStorage.getItem('fm_theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}})();
        `}} />
      </head>
      <body className="bg-canvas text-ink antialiased min-h-screen font-sans">
        <Nav />
        {children}
      </body>
    </html>
  )
}
