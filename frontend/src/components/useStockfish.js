// stockfish 16 lite, single-threaded wasm, served from cdn. loaded as a
// web worker so analysis doesnt block the ui.
//
// the lite build is ~600KB and runs ~700K nodes/sec on a modern laptop,
// plenty for the 12-22 depths we use here. multi-threaded builds need
// cross-origin isolation headers we dont want to deal with.
//
// the cdn-via-worker dance: workers can only load same-origin urls
// directly, so we fetch the script as text, wrap it in a blob url, and
// hand that to the Worker constructor. standard pattern.

import { useEffect, useRef, useState, useCallback } from 'react';

var STOCKFISH_URL = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';


// turn stockfish's centipawn / mate score into a display string and a
// signed eval ("white advantage in pawns", positive = white better)
export function formatScore(score) {

    if (!score) { return { text: '0.0', signed: 0 }; }
    if (score.kind === 'mate') {
        return {
            text:   `M${Math.abs(score.value)}`,
            signed: score.value > 0 ? 100 : -100,
            mate:   score.value
        };
    }
    var pawns = score.value / 100;
    var sign  = pawns > 0 ? '+' : '';
    return { text: `${sign}${pawns.toFixed(2)}`, signed: pawns };
}


// useStockfish: spawn a worker, send positions to analyze, get
// { depth, score, pv } updates back.
//
// one worker per hook instance (one per AnalysisBoard). a new analyze()
// cancels the previous one. worker is terminated on unmount.
export function useStockfish() {

    var workerRef       = useRef(null);
    var [ready, setReady] = useState(false);
    var [info, setInfo]   = useState({ depth: 0, score: null, pv: null });

    // pin the fen we're "currently analyzing" so stale info events from a
    // previous position can be discarded
    var currentFenRef = useRef(null);

    useEffect(() => {

        var cancelled = false;

        fetch(STOCKFISH_URL)
            .then(r => r.text())
            .then(src => {
                if (cancelled) { return; }
                var blob   = new Blob([src], { type: 'application/javascript' });
                var worker = new Worker(URL.createObjectURL(blob));
                workerRef.current = worker;

                worker.onmessage = e => {
                    var line = typeof e.data === 'string' ? e.data : e.data?.data || '';
                    if (!line) { return; }

                    if (line === 'uciok') {
                        worker.postMessage('setoption name MultiPV value 1');
                        worker.postMessage('isready');
                    } else if (line === 'readyok') {
                        setReady(true);
                    } else if (line.startsWith('info ')) {
                        var parsed = parseInfo(line);
                        if (parsed) {
                            // tag the update with the fen we're analyzing so
                            // the consumer can drop stale data after a move
                            var fen = currentFenRef.current;
                            setInfo(prev => ({
                                depth:    parsed.depth ?? prev.depth,
                                score:    parsed.score ?? prev.score,
                                pv:       parsed.pv    ?? prev.pv,
                                fenForPv: parsed.pv ? fen : prev.fenForPv
                            }));
                        }
                    }
                };

                worker.postMessage('uci');
            })
            .catch(err => {
                console.warn('stockfish failed to load:', err);
            });

        return () => {
            cancelled = true;
            if (workerRef.current) {
                workerRef.current.postMessage('quit');
                workerRef.current.terminate();
                workerRef.current = null;
            }
        };
    }, []);

    var stop = useCallback(() => {

        if (!workerRef.current) { return; }
        workerRef.current.postMessage('stop');
    }, []);

    // analyze a position. opts.depth (preferred) or opts.movetime in ms.
    // calling again cancels the prior analysis and clears the previous pv
    // so consumers dont see stale arrows from an old position.
    var analyze = useCallback((fen, opts = {}) => {

        if (!workerRef.current || !ready) { return; }
        currentFenRef.current = fen;
        setInfo({ depth: 0, score: null, pv: null, fenForPv: null });
        workerRef.current.postMessage('stop');
        workerRef.current.postMessage(`position fen ${fen}`);
        if (opts.depth) {
            workerRef.current.postMessage(`go depth ${opts.depth}`);
        } else if (opts.movetime) {
            workerRef.current.postMessage(`go movetime ${opts.movetime}`);
        } else {
            workerRef.current.postMessage('go depth 18');
        }
    }, [ready]);

    return { ready, info, analyze, stop };
}


// A second, purpose-built worker for game review. It evaluates each played
// move from the pre-move position, then the resulting position, and turns the
// win-chance drop into a Chess.com-style accuracy/classification.
export function useGameReview() {

    var workerRef         = useRef(null);
    var [ready, setReady] = useState(false);
    var [error, setError] = useState(null);

    useEffect(() => {

        var cancelled = false;

        fetch(STOCKFISH_URL)
            .then(r => r.text())
            .then(src => {
                if (cancelled) { return; }
                var blob   = new Blob([src], { type: 'application/javascript' });
                var worker = new Worker(URL.createObjectURL(blob));
                workerRef.current = worker;

                worker.onmessage = e => {
                    var line = typeof e.data === 'string' ? e.data : e.data?.data || '';
                    if (line === 'uciok') {
                        worker.postMessage('setoption name MultiPV value 1');
                        worker.postMessage('isready');
                    } else if (line === 'readyok') {
                        setReady(true);
                    }
                };

                worker.postMessage('uci');
            })
            .catch(err => {
                console.warn('stockfish review failed to load:', err);
                setError('Review engine failed to load.');
            });

        return () => {
            cancelled = true;
            if (workerRef.current) {
                workerRef.current.postMessage('quit');
                workerRef.current.terminate();
                workerRef.current = null;
            }
        };
    }, []);

    var analyzeGame = useCallback(async (moves, opts = {}) => {

        var worker = workerRef.current;
        if (!worker || !ready || !moves.length) { return null; }

        var movetimeMs  = opts.movetime || 350;
        var timeoutMs   = opts.timeoutMs || movetimeMs + 3000;
        var onProgress  = opts.onProgress || function () {};

        var analyzeFen = fen => new Promise(resolve => {
            var last = { depth: 0, score: null, pv: null, bestmove: null };
            var settled = false;
            var timer = window.setTimeout(() => settle(true), timeoutMs);

            function settle(shouldStop = false) {
                if (settled) { return; }
                settled = true;
                window.clearTimeout(timer);
                if (shouldStop) {
                    worker.postMessage('stop');
                }
                resolve(last);
            }

            worker.onmessage = e => {
                var line = typeof e.data === 'string' ? e.data : e.data?.data || '';
                if (!line) { return; }
                if (line.startsWith('info ')) {
                    var parsed = parseInfo(line);
                    if (parsed) {
                        last = {
                            depth: parsed.depth ?? last.depth,
                            score: parsed.score ?? last.score,
                            pv:    parsed.pv    ?? last.pv
                        };
                    }
                } else if (line.startsWith('bestmove ')) {
                    last.bestmove = line.split(/\s+/)[1] || null;
                    settle();
                }
            };

            worker.postMessage(`position fen ${fen}`);
            worker.postMessage(`go movetime ${movetimeMs}`);
        });

        try {
            var reviewed = [];
            worker.postMessage('stop');
            worker.postMessage('ucinewgame');

            for (var i = 0; i < moves.length; i++) {
                var move = moves[i];
                var before = await analyzeFen(move.beforeFen);
                var after  = await analyzeFen(move.fen);
                var item   = reviewMove(move, before, after);
                reviewed.push(item);
                onProgress({ done: reviewed.length, total: moves.length, latest: item });
            }

            return summarizeReview(reviewed);
        } catch (err) {
            console.warn('game review failed:', err);
            return null;
        }
    }, [ready]);

    return { ready, error, analyzeGame };
}


// parse a stockfish uci 'info' line into { depth, score, pv }
// example: "info depth 14 seldepth 20 multipv 1 score cp 35 nodes 51234 pv e2e4 e7e5 ..."
function parseInfo(line) {

    var tokens = line.split(/\s+/);
    var depth = null, score = null, pv = null;
    for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (t === 'depth') {
            depth = parseInt(tokens[i + 1], 10);
        } else if (t === 'score') {
            var kind = tokens[i + 1];   // 'cp' or 'mate'
            var val  = parseInt(tokens[i + 2], 10);
            score = { kind: kind === 'mate' ? 'mate' : 'cp', value: val };
        } else if (t === 'pv') {
            pv = tokens.slice(i + 1);
            break;
        }
    }
    return { depth, score, pv };
}


function scoreForSideToMove(score) {

    if (!score) { return 0; }
    if (score.kind === 'mate') {
        var sign = score.value > 0 ? 1 : -1;
        var distance = Math.max(1, Math.abs(score.value));
        return sign * (100000 - distance);
    }
    return Math.max(-1000, Math.min(1000, score.value));
}


function winChance(cp) {

    return 100 / (1 + Math.exp(-0.00368208 * cp));
}


function accuracyFromDrop(drop) {

    if (drop <= 0) { return 100; }
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}


function reviewMove(move, before, after) {

    var bestCp      = scoreForSideToMove(before.score);
    var playedCp    = -scoreForSideToMove(after.score);
    var bestWin     = winChance(bestCp);
    var playedWin   = winChance(playedCp);
    var winLoss     = Math.max(0, bestWin - playedWin);
    var accuracy    = accuracyFromDrop(winLoss);
    var bestUci     = before.bestmove || before.pv?.[0] || null;
    var playedUci   = `${move.from}${move.to}${move.promotion || ''}`;
    var isBest      = bestUci && playedUci === bestUci;
    var label       = classifyReviewMove({ accuracy, winLoss, isBest, bestCp, playedCp });

    return {
        ply: move.ply,
        color: move.color,
        san: move.san,
        accuracy,
        winLoss,
        label,
        bestUci,
        playedUci,
        bestCp,
        playedCp
    };
}


function classifyReviewMove({ accuracy, winLoss, isBest, bestCp, playedCp }) {

    if (isBest || winLoss < 1) { return 'best'; }
    if (playedCp > bestCp + 35) { return 'brilliant'; }
    if (accuracy >= 90) { return 'great'; }
    if (winLoss >= 30 || accuracy < 20) { return 'blunder'; }
    if (winLoss >= 16 || accuracy < 50) { return 'mistake'; }
    if (winLoss >= 8 || accuracy < 75) { return 'miss'; }
    return 'good';
}


function summarizeReview(reviewed) {

    var byColor = { w: [], b: [] };
    for (var m of reviewed) {
        byColor[m.color]?.push(m);
    }

    var counts = {
        w: emptyCounts(),
        b: emptyCounts()
    };
    for (var m of reviewed) {
        if (counts[m.color] && counts[m.color][m.label] != null) {
            counts[m.color][m.label] += 1;
        }
    }

    return {
        moves: reviewed,
        counts,
        accuracy: {
            w: averageAccuracy(byColor.w),
            b: averageAccuracy(byColor.b)
        }
    };
}


function emptyCounts() {

    return { brilliant: 0, great: 0, best: 0, good: 0, mistake: 0, miss: 0, blunder: 0 };
}


function averageAccuracy(moves) {

    if (!moves.length) { return null; }
    var total = moves.reduce((sum, m) => sum + m.accuracy, 0);
    return total / moves.length;
}
