'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { useI18n, LangToggle } from '../lib/i18n';

export default function LandingPage() {
  const { t } = useI18n();

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }),
      { threshold: 0.1, rootMargin: '0px 0px -30px 0px' }
    );
    document.querySelectorAll('.scroll-reveal').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  return (
    <>
      {/* ── Nav (white) ── */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <Link href="/" className="landing-nav-logo">
            <div className="landing-nav-logo-box">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Synaptex" style={{ width: '80%', height: '80%', objectFit: 'contain' }} />
            </div>
            <span className="landing-nav-logo-text">SYNAPTEX</span>
          </Link>
          <div className="landing-nav-links">
            <a href="#about" className="nav-link">{t('nav_about')}</a>
            <a href="#how-it-works" className="nav-link">{t('nav_howItWorks')}</a>
            <a href="#tokenomics" className="nav-link">{t('nav_tokenomics')}</a>
            <a href="/whitepaper" className="nav-link">{t('nav_whitepaper')}</a>
          </div>
          <div className="landing-nav-right">
            <LangToggle />
            <a href="https://github.com/SynaptexProtocol/Synaptex-Protocol" target="_blank" rel="noopener noreferrer" className="nav-github-link" aria-label="GitHub">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
            </a>
            <Link href="/app" className="nav-launch-btn">{t('nav_launchApp')}</Link>
          </div>
        </div>
      </nav>

      <main className="landing">
        {/* ── Hero Section (dark, grid-bg) ── */}
        <section className="hero-section grid-bg">
          <div className="hero-glow hero-glow-right" />
          <div className="hero-glow hero-glow-left" />
          <div className="landing-inner">
            <div className="hero">
              <div className="hero-eyebrow">
                [ {t('hero_eyebrow')} ]
              </div>
              <h1>
                {t('hero_line1')}<br />
                <span style={{ color: 'var(--accent)' }}>{t('hero_line2')}</span>
              </h1>
              <p className="hero-sub">{t('hero_sub')}</p>
              <div className="hero-cta-row">
                <Link href="/app" className="hero-cta">{t('hero_cta1')}</Link>
                <a href="/whitepaper" className="hero-cta hero-cta-outline">{t('hero_cta2')}</a>
              </div>
            </div>
          </div>

          {/* ── Web4 grid (4-col terminal) ── */}
          <div className="web4-bar-wrap">
            <div className="landing-inner" style={{ width: '100%' }}>
              <div className="web4-bar-label">Evolutionary_Timeline_Sequence</div>
              <div className="web4-grid">
                {([
                  { num: '[01]', title: 'WEB1', labelKey: 'web4_read' as const },
                  { num: '[02]', title: 'WEB2', labelKey: 'web4_write' as const },
                  { num: '[03]', title: 'WEB3', labelKey: 'web4_own' as const },
                  { num: '[04]', title: 'WEB4', labelKey: 'web4_agent' as const, active: true },
                ] as const).map(step => (
                  <div key={step.title} className={`web4-grid-item${'active' in step && step.active ? ' active' : ''}`}>
                    <div className={`web4-grid-num${'active' in step && step.active ? ' active' : ''}`}>{step.num}</div>
                    <div className={`web4-grid-title${'active' in step && step.active ? ' active' : ''}`}>{step.title}</div>
                    <div className={`web4-grid-desc${'active' in step && step.active ? ' active' : ''}`}>{t(step.labelKey)}</div>
                    {'active' in step && step.active && <div className="web4-active-border" />}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Features (white, full-bleed) ── */}
        <section className="features-section">
          <div className="landing-inner">
            <h2 className="features-section-title scroll-reveal">{t('feat_title')}</h2>
            <div className="feature-grid scroll-stagger">
              <div className="feature-card scroll-reveal">
                <div className="feature-icon-box">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <div className="feature-title">{t('feat1_title')}</div>
                <div className="feature-desc">{t('feat1_desc')}</div>
              </div>
              <div className="feature-card scroll-reveal">
                <div className="feature-icon-box">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
                    <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
                  </svg>
                </div>
                <div className="feature-title">{t('feat2_title')}</div>
                <div className="feature-desc">{t('feat2_desc')}</div>
              </div>
              <div className="feature-card scroll-reveal">
                <div className="feature-icon-box">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/>
                    <line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>
                  </svg>
                </div>
                <div className="feature-title">{t('feat3_title')}</div>
                <div className="feature-desc">{t('feat3_desc')}</div>
              </div>
            </div>
          </div>
        </section>

        {/* ── About, How It Works, Tokenomics, Connect (dark) ── */}
        <div className="landing-inner landing-dark-content">

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
            <div className="section-header scroll-reveal">
              <span className="section-title">{t('how_title')}</span>
              <span className="section-badge">{t('how_badge')}</span>
            </div>
            <div className="steps-grid scroll-stagger">
              <div className="step-card scroll-reveal"><div className="step-num">01</div><div className="step-title">{t('how1_title')}</div><div className="step-desc">{t('how1_desc')}</div></div>
              <div className="step-card scroll-reveal"><div className="step-num">02</div><div className="step-title">{t('how2_title')}</div><div className="step-desc">{t('how2_desc')}</div></div>
              <div className="step-card scroll-reveal"><div className="step-num">03</div><div className="step-title">{t('how3_title')}</div><div className="step-desc">{t('how3_desc')}</div></div>
              <div className="step-card scroll-reveal"><div className="step-num">04</div><div className="step-title">{t('how4_title')}</div><div className="step-desc">{t('how4_desc')}</div></div>
              <div className="step-card scroll-reveal"><div className="step-num">05</div><div className="step-title">{t('how5_title')}</div><div className="step-desc">{t('how5_desc')}</div></div>
              <div className="step-card scroll-reveal"><div className="step-num">06</div><div className="step-title">{t('how6_title')}</div><div className="step-desc">{t('how6_desc')}</div></div>
            </div>
          </div>

          {/* ── Tokenomics ── */}
          <div id="tokenomics" style={{ marginTop: 80 }}>
            <div className="section-header scroll-reveal">
              <span className="section-title">{t('token_title')}</span>
              <span className="section-badge">{t('token_badge')}</span>
            </div>
            <div className="tokenomics-grid scroll-stagger">
              <div className="tokenomics-card scroll-reveal"><div className="tokenomics-label">{t('token_name')}</div><div className="tokenomics-value">Synaptex Token</div></div>
              <div className="tokenomics-card scroll-reveal"><div className="tokenomics-label">{t('token_symbol')}</div><div className="tokenomics-value accent">SYNPTX</div></div>
              <div className="tokenomics-card scroll-reveal"><div className="tokenomics-label">{t('token_standard')}</div><div className="tokenomics-value">ERC-20 (Capped)</div></div>
              <div className="tokenomics-card scroll-reveal"><div className="tokenomics-label">{t('token_chain')}</div><div className="tokenomics-value">BNB Chain (56)</div></div>
              <div className="tokenomics-card scroll-reveal"><div className="tokenomics-label">{t('token_decimals')}</div><div className="tokenomics-value">18</div></div>
              <div className="tokenomics-card scroll-reveal"><div className="tokenomics-label">{t('token_upgr')}</div><div className="tokenomics-value">{t('token_no_upgr')}</div></div>
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
              <span className="method-pill">Webhook Agent</span>
              <span className="method-pill">AI Strategy (Beta)</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
              API: <code>synaptexprotocol.xyz/api/v1</code> · WebSocket: <code>/ws</code>
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <footer>
          <div className="footer-inner">
            <div className="footer-top">
              <div className="footer-socials">
                <a href="https://x.com/Synaptex_" target="_blank" rel="noopener noreferrer" className="footer-social-icon" aria-label="X / Twitter">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.258 5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                </a>
                <a href="https://github.com/SynaptexProtocol/Synaptex-Protocol" target="_blank" rel="noopener noreferrer" className="footer-social-icon" aria-label="GitHub">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
                </a>
              </div>
              <div className="footer-links">
                <a href="https://github.com/SynaptexProtocol/Synaptex-Protocol" target="_blank" rel="noopener noreferrer" className="footer-link">GitHub</a>
                <span className="footer-sep">·</span>
                <a href="/whitepaper" className="footer-link">{t('nav_whitepaper')}</a>
                <span className="footer-sep">·</span>
                <Link href="/app" className="footer-link">App</Link>
              </div>
            </div>
            <div className="footer-bottom">
              <span>© 2025 Synaptex Protocol</span>
              <span>{t('footer_built')} <span style={{ color: 'var(--accent)' }}>BNB Chain</span></span>
            </div>
          </div>
        </footer>
      </main>
    </>
  );
}
