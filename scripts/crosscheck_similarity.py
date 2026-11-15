#!/usr/bin/env python3
"""Independent re-implementation of the FIELD//ZERO similarity model (numpy/scipy, no shared code with the JS engine).
Family rule: lognormal if the Gaussian implied by the summary has > 15% mass below 0, else Beta on [min,max].

Reads the REAL processed CSV + summary JSON files, recomputes every Earth 120 m cell's feature scores, overall score,
contributions and the 360 m parent score, and compares them with the values written to
outputs/earth_{mars,moon}_similarity.geojson by the JS engine. Writes reports/similarity_crosscheck.json.
Usage: python3 scripts/crosscheck_similarity.py [--weights slope_deg=..,...]
"""
import json, sys, os
import numpy as np, pandas as pd
from scipy.special import erfc, betainc
from scipy.stats import norm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEATS = ['slope_deg', 'roughness_std', 'elev_variability_std', 'tri']
W = {'slope_deg': 0.30, 'roughness_std': 0.20, 'elev_variability_std': 0.30, 'tri': 0.20}
if '--weights' in sys.argv:
    W = {kv.split('=')[0]: float(kv.split('=')[1]) for kv in sys.argv[sys.argv.index('--weights') + 1].split(',')}
tot = sum(W.values()); W = {k: v / tot for k, v in W.items()}
NEG_MASS = 0.15; MIN_COMPLETE = 0.5; MIN_FEATURES = 2; TOL = 15.0
D = {'earth': ('Earth files', 'earth_western_desert'), 'mars': ('Mars files', 'mars_jezero'), 'moon': ('Moon files', 'moon_taurus_littrow')}

def p(body, sc, kind):
    d, s = D[body]
    return os.path.join(ROOT, 'Data', 'processed', d, f"{s}_{sc}m_terrain" + ('_summary.json' if kind == 'summary' else '.csv'))

def model(summ):
    m = {}
    for f in FEATS:
        s = summ[f]
        neg = norm.cdf(-s['mean'] / s['std'])
        if neg > NEG_MASS:
            sl = np.sqrt(np.log1p((s['std'] / s['mean']) ** 2)); mu = np.log(s['mean']) - sl ** 2 / 2
            m[f] = ('ln', mu, sl)
        else:
            rng = s['max'] - s['min']; u = (s['mean'] - s['min']) / rng; k = u * (1 - u) / (s['std'] / rng) ** 2 - 1
            m[f] = ('beta', u * k, (1 - u) * k, s['min'], rng)
    return m

def score(df, m):
    fs = {}
    for f in FEATS:
        x = df[f].to_numpy(float)
        if m[f][0] == 'beta':
            _, al, be, lo, rng = m[f]
            u = np.clip((x - lo) / rng, 0, 1)
            fs[f] = 200 * np.minimum(betainc(al, be, u), betainc(be, al, 1 - u))
            fs[f] = np.where(np.isnan(x), np.nan, fs[f])
        else:
            _, mu, sg = m[f]
            z = (np.log(np.where(x > 0, x, np.nan)) - mu) / sg
            fs[f] = 100 * erfc(np.abs(z) / np.sqrt(2))
    A = np.column_stack([fs[f] for f in FEATS]); ok = ~np.isnan(A)
    w = np.array([W[f] for f in FEATS])
    Wav = (ok * w).sum(1); used = (ok & (w > 0)).sum(1)
    with np.errstate(invalid='ignore', divide='ignore'):
        eff = np.where(ok, w, 0) / Wav[:, None]
    contrib = np.where(ok, eff * np.nan_to_num(A), np.nan)
    S = np.nansum(contrib, axis=1)
    scored = (used >= MIN_FEATURES) & (Wav >= MIN_COMPLETE - 1e-12)
    S = np.where(scored, S, np.nan); contrib[~scored] = np.nan; A[~scored] = np.nan
    return A, contrib, S, Wav / sum(w), model_kinds(m)

def model_kinds(m): return {f: m[f][0] for f in FEATS}

earth = {sc: pd.read_csv(p('earth', sc, 'csv')) for sc in (120, 360)}
report = {'weights': W, 'targets': {}}
for body in ('mars', 'moon'):
    out = {}
    sc_scores = {}
    for sc in (120, 360):
        summ = json.load(open(p(body, sc, 'summary')))
        A, C, S, comp, kinds = score(earth[sc], model(summ))
        sc_scores[sc] = (A, C, S, comp)
        out['models_%d' % sc] = kinds
    A, C, S, comp = sc_scores[120]
    gj = json.load(open(os.path.join(ROOT, 'outputs', f'earth_{body}_similarity.geojson')))
    feats = gj['features']
    assert len(feats) == len(earth[120]), 'feature count mismatch'
    js_score = np.array([np.nan if f['properties']['score'] is None else f['properties']['score'] for f in feats])
    js_fs = np.array([[np.nan if f['properties']['fs_' + k] is None else f['properties']['fs_' + k] for k in FEATS] for f in feats])
    js_c = np.array([[np.nan if f['properties']['c_' + k] is None else f['properties']['c_' + k] for k in FEATS] for f in feats])
    js_comp = np.array([f['properties']['completeness'] for f in feats])
    js_360 = np.array([np.nan if f['properties']['score_360m'] is None else f['properties']['score_360m'] for f in feats])
    out['null_pattern_matches'] = bool(np.array_equal(np.isnan(js_score), np.isnan(S)))
    both = ~np.isnan(S) & ~np.isnan(js_score)
    out['n_compared'] = int(both.sum())
    out['max_abs_diff_score'] = float(np.nanmax(np.abs(js_score[both] - S[both])))
    out['max_abs_diff_feature_score'] = float(np.nanmax(np.abs(js_fs[both] - A[both])))
    out['max_abs_diff_contribution'] = float(np.nanmax(np.abs(js_c[both] - C[both])))
    out['max_abs_diff_completeness'] = float(np.max(np.abs(js_comp - comp)))
    # rank: python rank vs js rank (ties impossible in practice)
    order = np.argsort(-np.where(np.isnan(S), -np.inf, S), kind='stable')
    py_rank = np.empty(len(S), float); py_rank[:] = np.nan
    n_sc = int((~np.isnan(S)).sum()); py_rank[order[:n_sc]] = np.arange(1, n_sc + 1)
    js_rank = np.array([np.nan if f['properties']['rank'] is None else f['properties']['rank'] for f in feats])
    out['rank_max_abs_diff_unrounded_python_vs_js'] = float(np.nanmax(np.abs(py_rank - js_rank)))
    rb = ~np.isnan(py_rank) & ~np.isnan(js_rank)
    out['rank_mismatch_count'] = int((py_rank[rb] != js_rank[rb]).sum())
    out['rank_null_pattern_matches'] = bool(np.array_equal(np.isnan(py_rank), np.isnan(js_rank)))
    # 360 m parent score, independent mapping by integer lattice arithmetic
    e1, e3 = earth[120], earth[360]
    x0, y0 = e3.x_m_localTM.min(), e3.y_m_localTM.min()
    key3 = {(int(round((x - x0) / 360)), int(round((y - y0) / 360))): i for i, (x, y) in enumerate(zip(e3.x_m_localTM, e3.y_m_localTM))}
    S3 = sc_scores[360][2]
    par = np.full(len(e1), np.nan)
    for i, (x, y) in enumerate(zip(e1.x_m_localTM, e1.y_m_localTM)):
        j = key3.get((int(np.floor((x - x0 + 180) / 360 + 1e-9)), int(np.floor((y - y0 + 180) / 360 + 1e-9))))
        if j is not None and not np.isnan(S3[j]): par[i] = S3[j]
    pb = ~np.isnan(par) & ~np.isnan(js_360)
    out['null_pattern_360_matches'] = bool(np.array_equal(np.isnan(par), np.isnan(js_360)))
    out['max_abs_diff_score_360m'] = float(np.max(np.abs(par[pb] - js_360[pb]))) if pb.any() else None
    report['targets'][body] = out
report['tolerance_note'] = 'JS erfc is accurate to ~1e-15; GeoJSON rounds score/contribution to 2 decimals and feature score to 1 decimal, so expected max diffs are <=0.005 / 0.005 / 0.05.'
os.makedirs(os.path.join(ROOT, 'reports'), exist_ok=True)
json.dump(report, open(os.path.join(ROOT, 'reports', 'similarity_crosscheck.json'), 'w'), indent=2)
print(json.dumps(report, indent=2))
