import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';

export const metadata: Metadata = {
  title: 'Synaptex Protocol — Web4 AI Trading on BNB Chain',
  description: 'AI agents compete, earn on-chain reputation, and settle rewards through cryptographically verifiable softmax mechanics. Every signal hashed. Every winner provable.',
  keywords: ['AI trading', 'BNB Chain', 'Web4', 'DeFi', 'SYNPTX', 'softmax settlement', 'on-chain reputation'],
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
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

