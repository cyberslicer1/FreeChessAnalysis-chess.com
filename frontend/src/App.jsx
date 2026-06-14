// the dashboard shell. router decides between landing page and per-user
// dashboard; the dashboard fetches /summary once and feeds each card the
// piece it cares about. error boundaries wrap every card so one bad chart
// cant blank the whole page.

import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams, Navigate } from 'react-router-dom';

import { fetchSummary }       from './api';
import { MetricCards }        from './components/MetricCards';
import { RatingChart }        from './components/RatingChart';
import { ColorRecord }        from './components/ColorRecord';
import { TimeClassChart }     from './components/TimeClassChart';
import { OpeningsTable }      from './components/OpeningsTable';
import { Heatmap }            from './components/Heatmap';
import { HourPerformance }    from './components/HourPerformance';
import { GameLog }            from './components/GameLog';
import { SyncButton }         from './components/SyncButton';
import { ErrorBoundary }      from './components/ErrorBoundary';
import { DashboardSkeleton }  from './components/DashboardSkeleton';


// the user whose data was pre-synced at build time. landing on the root
// redirects to their dashboard so visitors see something immediately.
var DEFAULT_USERNAME = 'mrsbyt';


function useTheme() {

    var [theme, setTheme] = useState(() => {
        if (typeof window === 'undefined') { return 'dark'; }
        var stored = window.localStorage.getItem('theme');
        if (stored === 'light' || stored === 'dark') { return stored; }
        return 'dark';
    });

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        window.localStorage.setItem('theme', theme);
    }, [theme]);

    return [theme, () => setTheme(t => t === 'dark' ? 'light' : 'dark')];
}


// 'local' or 'utc'. local is auto-detected from the browser. persisted to
// localStorage so the choice sticks across reloads.
function useTimezone() {

    var [mode, setMode] = useState(() => {
        if (typeof window === 'undefined') { return 'local'; }
        var stored = window.localStorage.getItem('tz_mode');
        return stored === 'utc' ? 'utc' : 'local';
    });

    useEffect(() => {
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('tz_mode', mode);
        }
    }, [mode]);

    var offsetHours = mode === 'utc'
        ? 0
        : -new Date().getTimezoneOffset() / 60;

    return { mode, setMode, offsetHours };
}


function tzLabel(mode) {

    if (mode === 'utc') { return 'UTC'; }
    // 'America/Phoenix' -> 'Phoenix'
    try {
        var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        var parts = zone.split('/');
        return parts[parts.length - 1].replace(/_/g, ' ');
    } catch (e) {
        return 'Local';
    }
}


function SunIcon() {

    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
        </svg>
    );
}


function MoonIcon() {

    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
    );
}


function ThemeToggle({ theme, onToggle }) {

    return (
        <button
            className="theme-toggle"
            onClick={onToggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
    );
}


function TimezoneToggle({ mode, onChange }) {

    return (
        <select
            className="tz-toggle"
            value={mode}
            onChange={e => onChange(e.target.value)}
            title="Timezone for the heatmap and hour-of-day charts"
        >
            <option value="local">{tzLabel('local')}</option>
            <option value="utc">UTC</option>
        </select>
    );
}


export default function App() {

    return (
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
                <Route path="/u/:username" element={<UserPage />} />
                <Route path="/demo" element={<Navigate to={`/u/${DEFAULT_USERNAME}`} replace />} />
                <Route path="/" element={<LandingPage />} />
                <Route path="*" element={<Navigate to={`/u/${DEFAULT_USERNAME}`} replace />} />
            </Routes>
        </BrowserRouter>
    );
}


function UserPage() {

    var { username }         = useParams();
    var navigate             = useNavigate();
    var [theme, toggleTheme] = useTheme();
    var tz                   = useTimezone();

    var [input, setInput]     = useState(username);
    var [summary, setSummary] = useState(null);
    var [error, setError]     = useState(null);
    var [loading, setLoading] = useState(false);

    // refetch when the route's :username changes, or when the user flips
    // the timezone toggle (which affects the heatmap and hour data)
    useEffect(() => {

        if (!username) { return; }
        setInput(username);
        var cancelled = false;
        setLoading(true);
        setError(null);
        fetchSummary(username, tz.offsetHours)
            .then(data => { if (!cancelled) { setSummary(data); } })
            .catch(err => { if (!cancelled) { setError(err.message); setSummary(null); } })
            .finally(()  => { if (!cancelled) { setLoading(false); } });
        return () => { cancelled = true; };
    }, [username, tz.offsetHours]);

    var onSubmit = e => {
        e.preventDefault();
        var trimmed = input.trim();
        if (trimmed && trimmed !== username) {
            navigate(`/u/${trimmed}`);
        }
    };

    // sync just finished -> drop the cached summary and refetch
    var onSyncComplete = () => {
        setSummary(null);
        setError(null);
        setLoading(true);
        fetchSummary(username, tz.offsetHours)
            .then(setSummary)
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    };

    var totalGames = summary
        ? summary.record_by_color.white.total + summary.record_by_color.black.total
        : 0;

    return (
        <div className="app-shell">
            <Sidebar />
            <main className="app-main">
                <TopNav
                    username={username}
                    input={input}
                    setInput={setInput}
                    loading={loading}
                    onSubmit={onSubmit}
                    theme={theme}
                    toggleTheme={toggleTheme}
                    tz={tz}
                    onSyncComplete={onSyncComplete}
                />
                <div className="app">
                    <div className="app-header">
                        <div>
                            <div className="eyebrow">OpenChess Analyzer</div>
                            <h1>{summary ? `${username}'s command center` : 'Chess intelligence dashboard'}</h1>
                            {summary && (
                                <div className="meta">{totalGames.toLocaleString()} games analyzed from Chess.com</div>
                            )}
                        </div>
                    </div>

            {error && (
                <div className="status">
                    <strong>Couldn't load.</strong> {error}
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                        Click <strong>Sync</strong> above to pull this user's games from Chess.com.
                        The first sync takes 2-3 minutes for active players.
                    </div>
                </div>
            )}

            {!error && !summary && loading && <DashboardSkeleton />}

            {!error && summary && (
                <div className="dashboard">
                    <ErrorBoundary label="Couldn't render summary cards">
                        <MetricCards summary={summary} />
                    </ErrorBoundary>

                    <ErrorBoundary label="Couldn't render rating chart">
                        <div className="card">
                            <div className="card-header">
                                <h2>Rating progression</h2>
                                <RatingLegend progression={summary.rating_progression} />
                            </div>
                            <RatingChart progression={summary.rating_progression} />
                        </div>
                    </ErrorBoundary>

                    <ErrorBoundary label="Couldn't render format analysis">
                        <FormatAnalysis summary={summary} />
                    </ErrorBoundary>

                    <ErrorBoundary label="Couldn't render openings table">
                        <div className="card">
                            <OpeningsTable username={username} initial={summary.top_openings} />
                        </div>
                    </ErrorBoundary>

                    <ErrorBoundary label="Couldn't render hour performance">
                        <div className="card">
                            <div className="card-header">
                                <h2>Win rate by hour of day</h2>
                                <span className="subtitle">Min 20 games per hour · {tzLabel(tz.mode)}</span>
                            </div>
                            <HourPerformance data={summary.performance_by_hour} />
                        </div>
                    </ErrorBoundary>

                    <div className="row-2">
                        <ErrorBoundary label="Couldn't render time class chart">
                            <div className="card">
                                <div className="card-header">
                                    <h2>Win rate by time control</h2>
                                </div>
                                <TimeClassChart performance={summary.performance_by_time_class} />
                            </div>
                        </ErrorBoundary>
                        <ErrorBoundary label="Couldn't render color record">
                            <div className="card">
                                <div className="card-header">
                                    <h2>Record by color</h2>
                                </div>
                                <ColorRecord record={summary.record_by_color} />
                            </div>
                        </ErrorBoundary>
                    </div>

                    <ErrorBoundary label="Couldn't render activity heatmap">
                        <div className="card">
                            <Heatmap
                                username={username}
                                tzOffsetHours={tz.offsetHours}
                                tzLabel={tzLabel(tz.mode)}
                                initial={summary.activity_heatmap}
                            />
                        </div>
                    </ErrorBoundary>

                    <ErrorBoundary label="Couldn't render game log">
                        <div className="card">
                            <GameLog username={username} />
                        </div>
                    </ErrorBoundary>
                </div>
            )}
                </div>
            </main>
        </div>
    );
}


function LandingPage() {

    var navigate = useNavigate();
    var [username, setUsername] = useState('');
    var [loading, setLoading] = useState(false);

    var submit = e => {
        e.preventDefault();
        var clean = username.trim();
        if (!clean) { return; }
        setLoading(true);
        window.setTimeout(() => navigate(`/u/${clean}`), 420);
    };

    return (
        <div className="landing-page">
            <nav className="landing-nav">
                <div className="brand-mark">
                    <span>OC</span>
                    <strong>OpenChess Analyzer</strong>
                </div>
                <button onClick={() => navigate('/demo')}>View demo</button>
            </nav>

            <section className="hero">
                <div className="hero-copy">
                    <div className="hero-kicker">Stockfish-powered Chess.com intelligence</div>
                    <h1>Analyze Every Chess Game Like a Grandmaster</h1>
                    <p>
                        Import any Chess.com profile and unlock free AI-powered analysis,
                        opening insights, mistake detection, accuracy reports, and performance tracking.
                    </p>

                    <form className="hero-search" onSubmit={submit}>
                        <label htmlFor="hero-username">Enter Chess.com Username</label>
                        <div>
                            <input
                                id="hero-username"
                                value={username}
                                onChange={e => setUsername(e.target.value)}
                                placeholder="mrsbyt"
                                autoComplete="off"
                            />
                            <button type="submit" disabled={loading || !username.trim()}>
                                {loading ? 'Importing…' : 'Analyze Username'}
                            </button>
                        </div>
                        {loading && (
                            <div className="import-progress">
                                <span />
                                <b>Importing games and preparing Stockfish review</b>
                            </div>
                        )}
                    </form>
                </div>

                <HeroBoard />
            </section>
        </div>
    );
}


function HeroBoard() {

    var pieces = {
        0: '♜', 3: '♛', 4: '♚',
        9: '♟', 11: '♞', 12: '♟',
        27: '♘', 28: '♙',
        36: '♗', 44: '♕',
        48: '♙', 52: '♔', 56: '♖'
    };

    return (
        <div className="hero-visual" aria-hidden="true">
            <div className="engine-pill">Stockfish depth 22</div>
            <div className="hero-eval"><span /></div>
            <div className="hero-board">
                {Array.from({ length: 64 }, (_, i) => (
                    <div key={i} className={(Math.floor(i / 8) + i) % 2 ? 'dark' : 'light'}>
                        {pieces[i] && <span>{pieces[i]}</span>}
                    </div>
                ))}
            </div>
            <div className="move-suggestion">
                <strong>Best move</strong>
                <span>Nxf7+  +1.84</span>
            </div>
        </div>
    );
}


function Sidebar() {

    var items = ['Dashboard', 'Games', 'Analysis', 'Openings', 'Mistakes', 'Opponents', 'Puzzles', 'Reports', 'Settings'];
    return (
        <aside className="sidebar">
            <div className="brand-mark">
                <span>OC</span>
                <strong>OpenChess</strong>
            </div>
            <nav>
                {items.map((item, i) => (
                    <button key={item} className={i === 0 ? 'active' : ''}>
                        <span>{item.slice(0, 1)}</span>
                        {item}
                    </button>
                ))}
            </nav>
        </aside>
    );
}


function TopNav({ username, input, setInput, loading, onSubmit, theme, toggleTheme, tz, onSyncComplete }) {

    return (
        <header className="top-nav">
            <form className="username-form top-search" onSubmit={onSubmit}>
                <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder="Search Chess.com username"
                    autoComplete="off"
                />
                <button type="submit" disabled={loading || !input.trim()}>
                    {loading ? 'Loading…' : 'Load'}
                </button>
                <SyncButton username={username} onComplete={onSyncComplete} />
            </form>
            <div className="header-right">
                <button className="notification-btn" title="Notifications">N</button>
                <TimezoneToggle mode={tz.mode} onChange={tz.setMode} />
                <ThemeToggle theme={theme} onToggle={toggleTheme} />
                <button className="profile-btn" title="Profile">{username.slice(0, 2).toUpperCase()}</button>
            </div>
        </header>
    );
}


function FormatAnalysis({ summary }) {

    var formats = ['bullet', 'blitz', 'rapid'];
    var available = formats.filter(tc =>
        summary.performance_by_time_class[tc]?.games > 0 ||
        summary.rating_progression[tc]?.length
    );

    if (!available.length) { return null; }

    return (
        <div className="format-analysis">
            {available.map(tc => (
                <FormatAnalysisCard
                    key={tc}
                    timeClass={tc}
                    performance={summary.performance_by_time_class[tc]}
                    progression={summary.rating_progression}
                />
            ))}
        </div>
    );
}


function FormatAnalysisCard({ timeClass, performance, progression }) {

    var label  = timeClass[0].toUpperCase() + timeClass.slice(1);
    var games  = performance?.games || 0;
    var wins   = performance?.wins || 0;
    var draws  = performance?.draws || 0;
    var losses = performance?.losses || 0;
    var latest = progression[timeClass]?.length
        ? progression[timeClass][progression[timeClass].length - 1].rating
        : null;

    return (
        <div className={`card format-card format-${timeClass}`}>
            <div className="card-header">
                <div>
                    <h2>{label} analysis</h2>
                    <span className="subtitle">
                        {games.toLocaleString()} games{latest ? ` · current ${latest}` : ''}
                    </span>
                </div>
                <span className={`format-chip tc-${timeClass}`}>{label}</span>
            </div>

            {progression[timeClass]?.length ? (
                <RatingChart progression={progression} timeClass={timeClass} height={150} />
            ) : (
                <div className="format-empty">No rated {label.toLowerCase()} games yet.</div>
            )}

            {games > 0 && (
                <>
                    <div className="format-stats">
                        <div>
                            <strong>{((performance.win_rate || 0) * 100).toFixed(1)}%</strong>
                            <span>Win rate</span>
                        </div>
                        <div>
                            <strong>{wins}</strong>
                            <span>Wins</span>
                        </div>
                        <div>
                            <strong>{draws}</strong>
                            <span>Draws</span>
                        </div>
                        <div>
                            <strong>{losses}</strong>
                            <span>Losses</span>
                        </div>
                    </div>
                    <div className="format-result-bar">
                        <div className="bar-segment win"  style={{ width: `${(wins / games) * 100}%` }} />
                        <div className="bar-segment draw" style={{ width: `${(draws / games) * 100}%` }} />
                        <div className="bar-segment loss" style={{ width: `${(losses / games) * 100}%` }} />
                    </div>
                </>
            )}
        </div>
    );
}


function RatingLegend({ progression }) {

    var order   = ['blitz', 'rapid', 'bullet', 'daily'];
    var present = order.filter(tc => progression[tc] && progression[tc].length);
    return (
        <div className="legend-inline">
            {present.map(tc => (
                <span key={tc}>
                    <i style={{ background: `var(--${tc})` }} />
                    {tc[0].toUpperCase() + tc.slice(1)}
                </span>
            ))}
        </div>
    );
}
