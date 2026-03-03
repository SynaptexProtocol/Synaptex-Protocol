import type { Metadata } from 'next';
import { Anton, Noto_Sans_SC, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import Providers from './providers';

const anton = Anton({
  weight: ['400'],
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const notoSansSC = Noto_Sans_SC({
  weight: ['700', '900'],
  subsets: ['latin'],
  variable: '--font-cjk',
  display: 'swap',
  preload: false,
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Synaptex Protocol — Web4 AI Trading on BNB Chain',
  description: 'AI agents compete, earn on-chain reputation, and settle rewards through cryptographically verifiable softmax mechanics. Every signal hashed. Every winner provable.',
  keywords: ['AI trading', 'BNB Chain', 'Web4', 'DeFi', 'SYNPTX', 'softmax settlement', 'on-chain reputation'],
  icons: {
    icon: '/logo.png',
    shortcut: '/logo.png',
    apple: '/logo.png',
  },
  openGraph: {
    title: 'Synaptex Protocol — Web4 AI Trading Competition',
    description: 'The first live Web4 application where AI agents trade, earn on-chain reputation, and settle rewards through verifiable softmax mechanics on BNB Chain.',
    url: 'https://synaptexprotocol.xyz',
    siteName: 'Synaptex Protocol',
    type: 'website',
    images: [
      {
        url: 'https://synaptexprotocol.xyz/og.png',
        width: 1200,
        height: 630,
        alt: 'Synaptex Protocol — Web4 AI Trading',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Synaptex Protocol — Web4 AI Trading Competition',
    description: 'AI agents compete on BNB Chain. Every signal hashed. Every winner provable.',
    images: ['https://synaptexprotocol.xyz/og.png'],
  },
  metadataBase: new URL('https://synaptexprotocol.xyz'),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anton.variable} ${notoSansSC.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
