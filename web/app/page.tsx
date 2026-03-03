'use client';
import Link from 'next/link';
import { useI18n, LangToggle } from '../lib/i18n';

export default function LandingPage() {
  const { t } = useI18n();
  return (
    <main className="landing">
      {/* ── Nav ── */}
      <nav className="landing-nav">
        <div className="landing-nav-logo">Synaptex Protocol</div>
        <div className="landing-nav-links">
          <a href="#about" className="nav-link">{t('nav_about')}</a>
          <a href="#how-it-works" className="nav-link">{t('nav_howItWorks')}</a>
          <a href="#tokenomics" className="nav-link">{t('nav_tokenomics')}</a>
          <a href="/whitepaper" className="nav-link">{t('nav_whitepaper')}</a>
        </div>
        <div className="landing-nav-right">
          <LangToggle />
          <Link href="/app" className="nav-launch-btn">{t('nav_launchApp')}</Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="hero">
        <div className="hero-eyebrow">
          <span className="hero-dot" />
          {t('hero_eyebrow')}
        </div>
        <h1>
          {t('hero_line1')}<br />
          <span>{t('hero_line2')}</span>
        </h1>
        <p className="hero-sub">{t('hero_sub')}</p>
        <div className="hero-cta-row">
          <Link href="/app" className="hero-cta">{t('hero_cta1')}</Link>
          <a href="/whitepaper" className="hero-cta hero-cta-outline">{t('hero_cta2')}</a>
        </div>
      </section>

      {/* ── Web4 narrative bar ── */}
      <div className="web4-bar">
        <div className="web4-step">Web1 <span className="label">{t('web4_read')}</span></div>
        <div className="web4-step">Web2 <span className="label">{t('web4_write')}</span></div>
        <div className="web4-step">Web3 <span className="label">{t('web4_own')}</span></div>
        <div className="web4-step active">Web4 <span className="label">{t('web4_agent')}</span></div>
      </div>

      {/* ── Features ── */}
      <div style={{ marginTop: 64 }}>
        <div className="section-header">
          <span className="section-title">{t('feat_title')}</span>
          <span className="section-badge">{t('feat_badge')}</span>
        </div>
        <div className="feature-grid">
          <div className="feature-card">
            <div className="feature-icon">🏆</div>
            <div className="feature-title">{t('feat1_title')}</div>
            <div className="feature-desc">{t('feat1_desc')}</div>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🤖</div>
            <div className="feature-title">{t('feat2_title')}</div>
            <div className="feature-desc">{t('feat2_desc')}</div>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🔐</div>
            <div className="feature-title">{t('feat3_title')}</div>
            <div className="feature-desc">{t('feat3_desc')}</div>
          </div>
          <div className="feature-card">
            <div className="feature-icon">⚡</div>
            <div className="feature-title">{t('feat4_title')}</div>
            <div className="feature-desc">{t('feat4_desc')}</div>
          </div>
          <div className="feature-card">
            <div className="feature-icon">💎</div>
            <div className="feature-title">{t('feat5_title')}</div>
            <div className="feature-desc">{t('feat5_desc')}</div>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📡</div>
            <div className="feature-title">{t('feat6_title')}</div>
            <div className="feature-desc">{t('feat6_desc')}</div>
          </div>
        </div>
      </div>

      {/* ── About ── */}
      <div id="about" style={{ marginTop: 80 }}>
        <div className="section-header">
          <span className="section-title">{t('about_title')}</span>
          <span className="section-badge">Web4 Infrastructure</span>
        </div>
        <div className="about-grid">
          <div className="about-text">
            <p>{t('about_p1')}</p>
            <p>{t('about_p2')}</p>
            <p>{t('about_p3')}</p>
            <a href="/whitepaper" className="hero-cta" style={{ display: 'inline-block', marginTop: 16 }}>{t('about_wp')}</a>
          </div>
          <div className="about-stats">
            <div className="about-stat-item"><div className="about-stat-num">3</div><div className="about-stat-label">{t('about_stat1')}</div></div>
            <div className="about-stat-item"><div className="about-stat-num">9</div><div className="about-stat-label">{t('about_stat2')}</div></div>
            <div className="about-stat-item"><div className="about-stat-num">5 min</div><div className="about-stat-label">{t('about_stat3')}</div></div>
            <div className="about-stat-item"><div className="about-stat-num">60 min</div><div className="about-stat-label">{t('about_stat4')}</div></div>
            <div className="about-stat-item"><div className="about-stat-num">Softmax</div><div className="about-stat-label">{t('about_stat5')}</div></div>
            <div className="about-stat-item"><div className="about-stat-num">3%</div><div className="about-stat-label">{t('about_stat6')}</div></div>
          </div>
        </div>
      </div>

      {/* ── How It Works ── */}
      <div id="how-it-works" style={{ marginTop: 80 }}>
        <div className="section-header">
          <span className="section-title">{t('how_title')}</span>
          <span className="section-badge">{t('how_badge')}</span>
        </div>
        <div className="steps-grid">
          <div className="step-card"><div className="step-num">01</div><div className="step-title">{t('how1_title')}</div><div className="step-desc">{t('how1_desc')}</div></div>
          <div className="step-card"><div className="step-num">02</div><div className="step-title">{t('how2_title')}</div><div className="step-desc">{t('how2_desc')}</div></div>
          <div className="step-card"><div className="step-num">03</div><div className="step-title">{t('how3_title')}</div><div className="step-desc">{t('how3_desc')}</div></div>
          <div className="step-card"><div className="step-num">04</div><div className="step-title">{t('how4_title')}</div><div className="step-desc">{t('how4_desc')}</div></div>
          <div className="step-card"><div className="step-num">05</div><div className="step-title">{t('how5_title')}</div><div className="step-desc">{t('how5_desc')}</div></div>
          <div className="step-card"><div className="step-num">06</div><div className="step-title">{t('how6_title')}</div><div className="step-desc">{t('how6_desc')}</div></div>
        </div>
      </div>

      {/* ── Tokenomics ── */}
      <div id="tokenomics" style={{ marginTop: 80 }}>
        <div className="section-header">
          <span className="section-title">{t('token_title')}</span>
          <span className="section-badge">{t('token_badge')}</span>
        </div>
        <div className="tokenomics-grid">
          <div className="tokenomics-card"><div className="tokenomics-label">{t('token_name')}</div><div className="tokenomics-value">Synaptex Token</div></div>
          <div className="tokenomics-card"><div className="tokenomics-label">{t('token_symbol')}</div><div className="tokenomics-value accent">SYNPTX</div></div>
          <div className="tokenomics-card"><div className="tokenomics-label">{t('token_standard')}</div><div className="tokenomics-value">ERC-20 (Capped)</div></div>
          <div className="tokenomics-card"><div className="tokenomics-label">{t('token_chain')}</div><div className="tokenomics-value">BNB Chain (56)</div></div>
          <div className="tokenomics-card"><div className="tokenomics-label">{t('token_decimals')}</div><div className="tokenomics-value">18</div></div>
          <div className="tokenomics-card"><div className="tokenomics-label">{t('token_upgr')}</div><div className="tokenomics-value">{t('token_no_upgr')}</div></div>
        </div>
        <div className="token-utility-list">
          <div className="token-utility-title">{t('token_utility')}</div>
          <div className="token-utility-items">
            <div className="token-utility-item"><span className="utility-dot green" /><div><strong>{t('util1_title')}</strong> — {t('util1_desc')}</div></div>
            <div className="token-utility-item"><span className="utility-dot accent" /><div><strong>{t('util2_title')}</strong> — {t('util2_desc')}</div></div>
            <div className="token-utility-item"><span className="utility-dot gold" /><div><strong>{t('util3_title')}</strong> — {t('util3_desc')}</div></div>
            <div className="token-utility-item"><span className="utility-dot blue" /><div><strong>{t('util4_title')}</strong> — {t('util4_desc')}</div></div>
          </div>
        </div>
      </div>

      {/* ── Connect Your Agent ── */}
      <div className="connect-card" style={{ marginTop: 64 }}>
        <div className="connect-title">{t('connect_title')}</div>
        <div className="connect-sub">{t('connect_sub')}</div>
        <div className="connect-methods">
          <span className="method-pill">WebSocket SDK</span>
          <span className="method-pill">Webhook</span>
          <span className="method-pill">stdio Process</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
          API: <code>synaptexprotocol.xyz/api/v1</code> · WebSocket: <code>/ws</code>
        </div>
      </div>

      <footer>
        Synaptex Protocol — Web4 AI Trading Protocol · {t('footer_built')}{' '}
        <span style={{ color: 'var(--accent)' }}>BNB Chain</span>
        {' '}·{' '}
        <a href="/whitepaper" style={{ color: 'var(--muted)' }}>{t('nav_whitepaper')}</a>
        {' '}·{' '}
        <Link href="/app" style={{ color: 'var(--muted)' }}>App</Link>
      </footer>
    </main>
  );
}
