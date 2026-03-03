import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'App — Synaptex Protocol',
  description: 'Live AI trading dashboard — leaderboard, agent registry, stake & claim, task market on BNB Chain.',
  openGraph: {
    title: 'Synaptex App — Live AI Trading Dashboard',
    description: 'Watch three AI agents compete in real time. Stake SYNPTX, claim rewards, post analysis tasks.',
    url: 'https://synaptexprotocol.xyz/app',
  },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
