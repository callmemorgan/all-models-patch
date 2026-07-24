import { SPEED_COMPARISON_OUTPUT_TOKENS } from "./model-recommendations.mjs";

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializeInlineString(value) {
  return JSON.stringify(String(value)).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function renderDashboardHTML({ token, version = "local" } = {}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("dashboard token must be a non-empty string");
  }

  const safeToken = serializeInlineString(token);
  const safeVersion = escapeHTML(version);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>Model Cockpit · all-models-patch</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b0f;
      --surface: #10141b;
      --surface-2: #161c25;
      --surface-3: #1d2530;
      --line: #293240;
      --line-strong: #3a4658;
      --text: #f1f4f8;
      --muted: #9da9b8;
      --faint: #758293;
      --accent: #b8f36b;
      --accent-2: #56d7c4;
      --accent-ink: #101709;
      --warn: #ffcb66;
      --danger: #ff8e91;
      --good: #7be39e;
      --shadow: 0 24px 80px rgba(0, 0, 0, .42);
      --radius: 16px;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body {
      min-width: 320px;
      min-height: 100vh;
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 14% -10%, rgba(86, 215, 196, .13), transparent 34rem),
        radial-gradient(circle at 92% 2%, rgba(184, 243, 107, .09), transparent 29rem),
        var(--bg);
    }
    button, input, select { font: inherit; }
    button, select, input[type="number"], input[type="text"] {
      color: var(--text);
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 9px;
    }
    button { cursor: pointer; }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 2px solid var(--accent-2);
      outline-offset: 2px;
    }
    button:disabled { cursor: not-allowed; opacity: .48; }
    .shell { width: min(1480px, 100%); margin: 0 auto; padding: 0 26px 44px; }
    .topbar {
      position: sticky;
      z-index: 20;
      top: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      min-height: 76px;
      margin: 0 -26px 28px;
      padding: 12px 26px;
      background: rgba(9, 11, 15, .84);
      border-bottom: 1px solid rgba(58, 70, 88, .6);
      backdrop-filter: blur(18px);
    }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand-mark {
      display: grid;
      width: 38px;
      height: 38px;
      place-items: center;
      color: var(--accent-ink);
      font-weight: 900;
      background: linear-gradient(145deg, var(--accent), var(--accent-2));
      border-radius: 11px;
      box-shadow: 0 0 32px rgba(184, 243, 107, .18);
    }
    .brand-copy { min-width: 0; }
    .brand-name { margin: 0; font-size: 16px; letter-spacing: -.01em; }
    .brand-subtitle { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
    .top-actions { display: flex; align-items: center; gap: 12px; }
    .status { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
    .status-dot { width: 7px; height: 7px; background: var(--accent-2); border-radius: 999px; box-shadow: 0 0 12px var(--accent-2); }
    .icon-button { min-height: 34px; padding: 6px 11px; color: var(--muted); }
    .tabs {
      display: inline-flex;
      gap: 4px;
      margin-bottom: 22px;
      padding: 4px;
      background: rgba(16, 20, 27, .78);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .tab { min-width: 128px; padding: 9px 14px; color: var(--muted); background: transparent; border: 0; }
    .tab[aria-selected="true"] { color: var(--text); background: var(--surface-3); box-shadow: 0 1px 0 rgba(255,255,255,.05); }
    [hidden] { display: none !important; }
    .error-banner {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 20px;
      padding: 13px 15px;
      color: #ffd9da;
      background: rgba(110, 28, 33, .42);
      border: 1px solid rgba(255, 142, 145, .42);
      border-radius: 12px;
    }
    .eyebrow { margin: 0 0 8px; color: var(--accent-2); font-size: 11px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    h1, h2, h3, p { overflow-wrap: anywhere; }
    h1 { max-width: 760px; margin: 0; font-size: clamp(32px, 5vw, 58px); line-height: .98; letter-spacing: -.055em; }
    .lede { max-width: 700px; margin: 16px 0 0; color: var(--muted); font-size: 16px; line-height: 1.6; }
    .hero { display: flex; justify-content: space-between; gap: 28px; margin: 5px 0 30px; }
    .hero-stat { align-self: end; min-width: 190px; padding: 16px 18px; background: rgba(16, 20, 27, .72); border: 1px solid var(--line); border-radius: var(--radius); }
    .hero-stat strong { display: block; font-size: 28px; letter-spacing: -.04em; }
    .hero-stat span { color: var(--muted); font-size: 12px; }
    .recommend-grid { display: grid; grid-template-columns: minmax(250px, 330px) minmax(0, 1fr); gap: 22px; align-items: start; }
    .panel { background: rgba(16, 20, 27, .88); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 1px 0 rgba(255,255,255,.025); }
    .controls { position: sticky; top: 98px; padding: 19px; }
    .panel-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .panel-title h2, .panel-title h3 { margin: 0; font-size: 15px; letter-spacing: -.01em; }
    .panel-title span { color: var(--faint); font-size: 11px; }
    .field { margin: 0 0 16px; }
    .field > label, .field-label { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 7px; color: var(--muted); font-size: 12px; }
    .field input[type="text"], .field select { width: 100%; min-height: 39px; padding: 8px 10px; }
    .weight { margin-bottom: 14px; }
    .weight-heading { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 5px; font-size: 12px; }
    .weight-heading label { color: var(--muted); }
    .weight-label { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .tooltip-trigger {
      display: grid;
      width: 17px;
      height: 17px;
      flex: 0 0 17px;
      padding: 0;
      place-items: center;
      color: var(--faint);
      background: transparent;
      border: 1px solid var(--line-strong);
      border-radius: 50%;
      font-size: 10px;
      font-weight: 800;
      line-height: 1;
      cursor: help;
    }
    .tooltip-trigger:hover, .tooltip-trigger:focus-visible { color: var(--text); border-color: var(--accent-2); }
    .factor-tooltip {
      position: absolute;
      z-index: 30;
      bottom: calc(100% + 9px);
      left: 0;
      width: min(270px, calc(100vw - 52px));
      padding: 10px 11px;
      visibility: hidden;
      color: var(--text);
      background: #222b36;
      border: 1px solid var(--line-strong);
      border-radius: 9px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, .44);
      font-size: 11px;
      font-weight: 450;
      line-height: 1.45;
      opacity: 0;
      pointer-events: none;
      transform: translateY(4px);
      transition: opacity .14s ease, transform .14s ease, visibility .14s ease;
    }
    .factor-tooltip::after {
      position: absolute;
      top: 100%;
      left: 28px;
      border: 6px solid transparent;
      border-top-color: #222b36;
      content: "";
    }
    .weight-label:hover .factor-tooltip,
    .weight-label:focus-within .factor-tooltip,
    .weight:focus-within .factor-tooltip {
      visibility: visible;
      opacity: 1;
      transform: translateY(0);
    }
    .weight-output { color: var(--text); font-variant-numeric: tabular-nums; }
    .assumption-note { margin: 3px 0 0; color: var(--faint); font-size: 10px; line-height: 1.45; }
    input[type="range"] { width: 100%; height: 5px; margin: 7px 0; appearance: none; background: var(--line); border-radius: 99px; }
    input[type="range"]::-webkit-slider-thumb { width: 17px; height: 17px; appearance: none; background: var(--accent); border: 3px solid #202812; border-radius: 50%; box-shadow: 0 0 0 1px var(--accent); }
    input[type="range"]::-moz-range-thumb { width: 13px; height: 13px; background: var(--accent); border: 3px solid #202812; border-radius: 50%; }
    .divider { height: 1px; margin: 18px 0; background: var(--line); }
    .button-row { display: flex; gap: 8px; }
    .primary { color: var(--accent-ink); font-weight: 750; background: var(--accent); border-color: transparent; }
    .secondary { color: var(--muted); }
    .small-button { min-height: 36px; padding: 7px 11px; }
    .button-row > :first-child { flex: 1; }
    .recommendations { min-width: 0; }
    .recommendation-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .recommendation-card { position: relative; min-width: 0; padding: 18px; overflow: hidden; }
    .recommendation-card:first-child { grid-column: 1 / -1; padding: 23px; border-color: rgba(184, 243, 107, .38); background: linear-gradient(135deg, rgba(184, 243, 107, .08), rgba(16, 20, 27, .93) 45%); }
    .rank { color: var(--faint); font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .card-top { display: flex; justify-content: space-between; gap: 18px; }
    .model-name { margin: 5px 0 3px; font-size: 19px; letter-spacing: -.025em; }
    .model-id { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .score-ring {
      display: grid;
      flex: 0 0 66px;
      width: 66px;
      height: 66px;
      place-content: center;
      text-align: center;
      background: conic-gradient(var(--accent) var(--score), var(--line) 0);
      border-radius: 50%;
    }
    .score-ring::before { position: absolute; }
    .score-inner { display: grid; width: 54px; height: 54px; place-content: center; background: var(--surface); border-radius: 50%; }
    .score-inner strong { font-size: 17px; }
    .score-inner small { color: var(--faint); font-size: 9px; text-transform: uppercase; }
    .fact-row { display: flex; flex-wrap: wrap; gap: 7px; margin: 15px 0 12px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; min-height: 25px; padding: 4px 8px; color: var(--muted); font-size: 10px; background: rgba(29, 37, 48, .82); border: 1px solid var(--line); border-radius: 999px; }
    .chip.good { color: var(--good); border-color: rgba(123, 227, 158, .3); }
    .chip.warn { color: var(--warn); border-color: rgba(255, 203, 102, .32); }
    .reason-list { margin: 12px 0 0; padding: 0; list-style: none; }
    .reason-list li { position: relative; margin: 6px 0; padding-left: 14px; color: var(--muted); font-size: 12px; line-height: 1.42; }
    .reason-list li::before { position: absolute; left: 0; color: var(--accent-2); content: "↳"; }
    .dimension-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(58px, 1fr)); gap: 4px; margin-top: 16px; }
    .dimension-segment { min-width: 0; }
    .dimension-segment div { height: 4px; margin-bottom: 5px; overflow: hidden; background: var(--line); border-radius: 5px; }
    .dimension-segment i { display: block; width: var(--dimension); height: 100%; background: var(--accent-2); border-radius: inherit; }
    .dimension-segment span { display: block; overflow: hidden; color: var(--faint); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
    .details-link { margin-top: 14px; padding: 0; color: var(--accent); background: transparent; border: 0; font-size: 11px; font-weight: 700; }
    .empty { padding: 48px 24px; color: var(--muted); text-align: center; }
    .loading-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .skeleton { height: 230px; background: linear-gradient(100deg, var(--surface) 10%, var(--surface-2) 28%, var(--surface) 44%); background-size: 240% 100%; border: 1px solid var(--line); border-radius: var(--radius); animation: shimmer 1.4s infinite linear; }
    @keyframes shimmer { to { background-position-x: -240%; } }
    .source-panel { margin-top: 18px; padding: 16px 18px; }
    .source-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .source { color: var(--muted); font-size: 10px; }
    .roster-head { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
    .roster-head h1 { font-size: clamp(32px, 4.5vw, 50px); }
    .search { width: min(330px, 100%); min-height: 41px; padding: 9px 12px; }
    .table-wrap { overflow: auto; }
    table { width: 100%; min-width: 1040px; border-collapse: collapse; }
    th { position: sticky; z-index: 3; top: 0; padding: 11px 12px; color: var(--faint); background: var(--surface); border-bottom: 1px solid var(--line-strong); font-size: 10px; font-weight: 750; letter-spacing: .08em; text-align: left; text-transform: uppercase; }
    th button { width: 100%; padding: 0; color: inherit; background: transparent; border: 0; font: inherit; letter-spacing: inherit; text-align: inherit; text-transform: inherit; }
    td { padding: 13px 12px; color: var(--muted); border-bottom: 1px solid var(--line); font-size: 12px; vertical-align: middle; }
    tbody tr { transition: background .14s ease; }
    tbody tr:hover { background: rgba(29, 37, 48, .52); }
    .table-model { display: block; max-width: 250px; padding: 0; color: var(--text); background: transparent; border: 0; font-weight: 700; text-align: left; }
    .table-sub { display: block; max-width: 240px; margin-top: 3px; overflow: hidden; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .numeric { color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .meter { width: 82px; height: 5px; margin-top: 5px; overflow: hidden; background: var(--line); border-radius: 99px; }
    .meter > i { display: block; width: var(--meter); height: 100%; background: var(--accent-2); }
    dialog {
      position: fixed;
      inset: 0;
      width: min(760px, calc(100% - 48px));
      max-height: min(820px, calc(100vh - 48px));
      margin: auto;
      padding: 0;
      overflow-y: auto;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--line-strong);
      border-radius: 20px;
      box-shadow: var(--shadow);
    }
    dialog::backdrop { background: rgba(2, 5, 8, .7); backdrop-filter: blur(5px); }
    .drawer { min-height: 100%; padding: 24px; }
    .drawer-header { display: flex; align-items: start; justify-content: space-between; gap: 18px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
    .drawer-header h2 { margin: 3px 0; font-size: 26px; letter-spacing: -.035em; }
    .close { width: 36px; height: 36px; flex: 0 0 36px; color: var(--muted); }
    .drawer-description { color: var(--muted); line-height: 1.55; }
    .drawer-section { margin-top: 24px; }
    .drawer-section h3 { margin: 0 0 11px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    .fact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .fact { padding: 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; }
    .fact dt { color: var(--faint); font-size: 10px; text-transform: uppercase; }
    .fact dd { margin: 5px 0 0; color: var(--text); font-size: 13px; }
    .dimension-list { display: grid; gap: 11px; }
    .dimension-row { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(110px, 2fr) 54px; gap: 10px; align-items: center; }
    .dimension-row label { color: var(--muted); font-size: 11px; }
    .dimension-bar { height: 6px; overflow: hidden; background: var(--line); border-radius: 9px; }
    .dimension-bar i { display: block; width: var(--dimension); height: 100%; background: linear-gradient(90deg, var(--accent-2), var(--accent)); }
    .dimension-value { color: var(--text); font-size: 11px; text-align: right; }
    .provenance { margin: 0; padding-left: 18px; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .aa-variants { display: grid; gap: 8px; }
    .aa-variant {
      display: grid;
      gap: 4px;
      width: 100%;
      padding: 12px 13px;
      text-align: left;
      color: var(--text);
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 10px;
    }
    .aa-variant:hover { border-color: var(--line-strong); }
    .aa-variant.selected {
      border-color: var(--accent-2);
      box-shadow: 0 0 0 1px rgba(86, 215, 196, .28);
    }
    .aa-variant-name { font-size: 13px; font-weight: 650; letter-spacing: -.01em; }
    .aa-variant-meta { color: var(--muted); font-size: 11px; line-height: 1.45; font-variant-numeric: tabular-nums; }
    .aa-variant-selected { color: var(--accent-2); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .site-footer {
      margin-top: 28px;
      padding-top: 16px;
      border-top: 1px solid rgba(58, 70, 88, .45);
      color: var(--faint);
      font-size: 11px;
      line-height: 1.5;
    }
    .site-footer a { color: var(--muted); text-decoration: underline; text-decoration-color: rgba(157, 169, 184, .35); text-underline-offset: 2px; }
    .site-footer a:hover { color: var(--text); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .muted { color: var(--muted); }
    .nowrap { white-space: nowrap; }

    @media (max-width: 920px) {
      .recommend-grid { grid-template-columns: 1fr; }
      .controls { position: static; }
      .recommendation-list { grid-template-columns: 1fr; }
      .recommendation-card:first-child { grid-column: auto; }
      .hero-stat { display: none; }
    }
    @media (max-width: 640px) {
      .shell { padding: 0 14px 28px; }
      .topbar { margin: 0 -14px 20px; padding: 10px 14px; }
      .brand-subtitle, .status span { display: none; }
      .tabs { display: flex; }
      .tab { flex: 1; min-width: 0; }
      .hero { margin-bottom: 24px; }
      .roster-head { align-items: stretch; flex-direction: column; }
      .search { width: 100%; }
      .fact-grid { grid-template-columns: 1fr; }
      dialog { inset: auto 0 0; width: 100%; max-height: 92vh; margin: 0; border-width: 1px 0 0; border-radius: 18px 18px 0 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">M</div>
        <div class="brand-copy">
          <p class="brand-name">Model Cockpit</p>
          <p class="brand-subtitle">all-models-patch · ${safeVersion}</p>
        </div>
      </div>
      <div class="top-actions">
        <div class="status" title="Dashboard data freshness"><i class="status-dot" aria-hidden="true"></i><span id="freshness">Connecting…</span></div>
        <button class="icon-button" id="refresh" type="button" aria-label="Refresh dashboard data">Refresh</button>
      </div>
    </header>

    <div class="tabs" role="tablist" aria-label="Dashboard views">
      <button class="tab" id="tab-recommendation" type="button" role="tab" aria-selected="true" aria-controls="recommendation-view">Recommendation</button>
      <button class="tab" id="tab-roster" type="button" role="tab" aria-selected="false" aria-controls="roster-view" tabindex="-1">Roster</button>
    </div>

    <div id="error-banner" class="error-banner" role="alert" hidden>
      <span id="error-message"></span>
      <button class="secondary small-button" id="dismiss-error" type="button">Dismiss</button>
    </div>
    <div id="announcer" class="sr-only" aria-live="polite"></div>

    <main>
      <section id="recommendation-view" role="tabpanel" aria-labelledby="tab-recommendation">
        <div class="hero">
          <div>
            <p class="eyebrow">Live decision support</p>
            <h1>Your priorities. Your best model right now.</h1>
            <p class="lede">Shape the tradeoff between judgment, velocity, evidence, and available capacity. Every score stays inspectable.</p>
          </div>
          <div class="hero-stat" aria-label="Roster size"><strong id="model-count">—</strong><span>eligible profiles in the live roster</span></div>
        </div>

        <div class="recommend-grid">
          <aside class="panel controls" aria-label="Recommendation controls">
            <div class="panel-title"><h2>Your priorities</h2><span>updates live</span></div>
            <div class="field-label"><span>Factor importance</span><span>0–100</span></div>
            <div id="weights" aria-label="Recommendation weights"></div>
            <p class="assumption-note">Speed uses a fixed ${SPEED_COMPARISON_OUTPUT_TOKENS}-token comparison; context uses usable runway before compaction. Agents still use and compact tokens as needed.</p>
            <div class="divider"></div>
            <div class="field">
              <label for="preset-select"><span>Saved profile</span></label>
              <select id="preset-select"><option value="">Custom settings</option></select>
            </div>
            <div class="field">
              <label class="sr-only" for="preset-name">New preset name</label>
              <input id="preset-name" type="text" maxlength="48" autocomplete="off" placeholder="Name this profile…">
            </div>
            <div class="button-row">
              <button class="primary small-button" id="save-preset" type="button">Save preset</button>
              <button class="secondary small-button" id="delete-preset" type="button" disabled>Delete</button>
            </div>
          </aside>

          <section class="recommendations" aria-labelledby="recommendation-heading">
            <div class="panel-title"><h2 id="recommendation-heading">Best fits</h2><span id="recommendation-status">Waiting for data</span></div>
            <div id="recommendation-loading" class="loading-grid" aria-label="Loading recommendations"><div class="skeleton"></div><div class="skeleton"></div></div>
            <div id="recommendation-list" class="recommendation-list"></div>
            <div id="recommendation-empty" class="panel empty" hidden>No models are currently available.</div>
            <section class="panel source-panel" aria-labelledby="source-heading">
              <div class="panel-title"><h3 id="source-heading">Evidence health</h3><span>freshness matters</span></div>
              <div id="source-list" class="source-list"><span class="source">Loading evidence sources…</span></div>
            </section>
          </section>
        </div>
      </section>

      <section id="roster-view" role="tabpanel" aria-labelledby="tab-roster" hidden>
        <div class="roster-head">
          <div><p class="eyebrow">Live inventory</p><h1>Every profile, one evidence trail.</h1></div>
          <label><span class="sr-only">Filter model roster</span><input class="search" id="roster-search" type="search" placeholder="Filter by profile, model, or provider…" autocomplete="off"></label>
        </div>
        <div class="panel table-wrap">
          <table>
            <caption class="sr-only">Model roster with live recommendation and evidence data</caption>
            <thead><tr>
              <th scope="col" aria-sort="none"><button type="button" data-sort="id">Profile</button></th>
              <th scope="col" aria-sort="none"><button type="button" data-sort="provider">Provider</button></th>
              <th scope="col" aria-sort="none"><button type="button" data-sort="speed">Speed</button></th>
              <th scope="col" aria-sort="none"><button type="button" data-sort="ttft">TTFT</button></th>
              <th scope="col" aria-sort="none"><button type="button" data-sort="taste">Taste</button></th>
              <th scope="col" aria-sort="none"><button type="button" data-sort="publicRating">Public</button></th>
              <th scope="col" aria-sort="none"><button type="button" data-sort="quota">Quota</button></th>
              <th scope="col" aria-sort="none"><button type="button" data-sort="context">Context</button></th>
              <th scope="col" aria-sort="descending"><button type="button" data-sort="score">Score</button></th>
            </tr></thead>
            <tbody id="roster-body"></tbody>
          </table>
          <div id="roster-empty" class="empty" hidden>No profiles match this filter.</div>
        </div>
      </section>
    </main>
    <footer class="site-footer">Model data: <a href="https://artificialanalysis.ai/" rel="noopener noreferrer">Artificial Analysis</a></footer>
  </div>

  <dialog id="model-dialog" aria-labelledby="drawer-title" aria-describedby="drawer-description" aria-modal="true">
    <article class="drawer">
      <header class="drawer-header">
        <div><p class="eyebrow" id="drawer-provider"></p><h2 id="drawer-title"></h2><span class="model-id" id="drawer-model"></span></div>
        <button class="close" id="close-dialog" type="button" aria-label="Close model details">×</button>
      </header>
      <p class="drawer-description" id="drawer-description"></p>
      <div class="fact-row" id="drawer-chips"></div>
      <section class="drawer-section" id="drawer-variants-section" hidden aria-labelledby="drawer-variants-heading"><h3 id="drawer-variants-heading">Artificial Analysis variants</h3><div class="aa-variants" id="drawer-variants"></div></section>
      <section class="drawer-section" aria-labelledby="drawer-facts-heading"><h3 id="drawer-facts-heading">Live facts</h3><dl class="fact-grid" id="drawer-facts"></dl></section>
      <section class="drawer-section" aria-labelledby="drawer-dimensions-heading"><h3 id="drawer-dimensions-heading">Score contribution</h3><div class="dimension-list" id="drawer-dimensions"></div></section>
      <section class="drawer-section" aria-labelledby="drawer-quota-heading"><h3 id="drawer-quota-heading">Quota windows</h3><dl class="fact-grid" id="drawer-quota"></dl></section>
      <section class="drawer-section" aria-labelledby="drawer-provenance-heading"><h3 id="drawer-provenance-heading">Provenance &amp; caveats</h3><ul class="provenance" id="drawer-provenance"></ul></section>
    </article>
  </dialog>

  <script>
    "use strict";
    const API_TOKEN = ${safeToken};
    const WEIGHT_HELP = Object.freeze({
      aaCoding: "Artificial Analysis Coding Index: agentic terminal engineering (Terminal-Bench) plus spec-to-code correctness (SciCode). Data: Artificial Analysis.",
      aaAgentic: "Artificial Analysis Agentic Index: long-horizon tool use and deliverable production (GDPval-AA, τ³-Banking). Data: Artificial Analysis.",
      aaIntelligence: "Artificial Analysis Intelligence Index: full composite including reasoning, knowledge, and hallucination resistance. Data: Artificial Analysis.",
      taste: "How strongly to favor your personal judgment of polish, product sense, and engineering taste.",
      speed: "Uses time to first token plus post-first-token throughput over a fixed ${SPEED_COMPARISON_OUTPUT_TOKENS}-token comparison, then applies diminishing returns.",
      reliability: "Uses valid completion share from the latest compatible raw benchmark, confidence-adjusted by sample count.",
      quota: "Uses the tightest applicable live quota window, reset timing, and the best available provider route.",
      context: "Softly scores usable pre-compaction runway and never excludes a profile. Agents compact and continue as needed.",
      coachability: "Favors models observed to improve through iterative feedback and review-driven loops.",
      efficiency: "Favors models that deliver useful work with lower cost or subscription-quota burn."
    });
    const app = {
      catalog: null,
      weights: {},
      recommendations: [],
      requestSequence: 0,
      recommendationTimer: null,
      dialogTrigger: null,
      search: "",
      sort: { key: "score", direction: "desc" }
    };

    const byId = (id) => document.getElementById(id);
    const elements = {
      errorBanner: byId("error-banner"), errorMessage: byId("error-message"), announcer: byId("announcer"),
      freshness: byId("freshness"), modelCount: byId("model-count"), weights: byId("weights"),
      presetSelect: byId("preset-select"), presetName: byId("preset-name"), deletePreset: byId("delete-preset"),
      recommendationLoading: byId("recommendation-loading"), recommendationList: byId("recommendation-list"),
      recommendationEmpty: byId("recommendation-empty"), recommendationStatus: byId("recommendation-status"),
      sourceList: byId("source-list"), rosterBody: byId("roster-body"), rosterEmpty: byId("roster-empty"),
      dialog: byId("model-dialog")
    };

    function node(tag, className, textValue) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (textValue !== undefined && textValue !== null) element.textContent = String(textValue);
      return element;
    }

    function clear(element) {
      while (element.firstChild) element.removeChild(element.firstChild);
    }

    function finite(value, fallback) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function clamp(value, minimum, maximum) {
      return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
    }

    function titleCase(value) {
      return String(value || "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\\b\\w/g, (letter) => letter.toUpperCase());
    }

    function formatNumber(value, digits) {
      if (value === null || value === undefined || value === "") return "—";
      const number = finite(value, NaN);
      if (!Number.isFinite(number)) return "—";
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits === undefined ? 1 : digits }).format(number);
    }

    function formatTokens(value) {
      if (value === null || value === undefined || value === "") return "—";
      const number = finite(value, NaN);
      if (!Number.isFinite(number)) return "—";
      if (number >= 1000000) return formatNumber(number / 1000000, 2) + "M";
      if (number >= 1000) return formatNumber(number / 1000, 0) + "K";
      return formatNumber(number, 0);
    }

    function formatDate(value) {
      if (!value) return "unknown date";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    }

    function relativeTime(value) {
      if (!value) return "freshness unknown";
      const time = new Date(value).getTime();
      if (!Number.isFinite(time)) return "freshness unknown";
      const seconds = Math.round((time - Date.now()) / 1000);
      const absolute = Math.abs(seconds);
      const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      if (absolute < 90) return formatter.format(seconds, "second");
      if (absolute < 5400) return formatter.format(Math.round(seconds / 60), "minute");
      if (absolute < 129600) return formatter.format(Math.round(seconds / 3600), "hour");
      return formatter.format(Math.round(seconds / 86400), "day");
    }

    function scoreValue(value) {
      if (value === null || value === undefined || value === "") return null;
      const number = finite(value, NaN);
      if (!Number.isFinite(number)) return null;
      return clamp(number, 0, 100);
    }

    function confidenceValue(value) {
      const number = finite(value, NaN);
      if (!Number.isFinite(number)) return null;
      return clamp(number <= 1 ? number * 100 : number, 0, 100);
    }

    function recommendationFor(id) {
      return app.recommendations.find((item) => item.id === id) || null;
    }

    function rosterItem(id) {
      return (app.catalog && app.catalog.roster || []).find((item) => item.id === id) || null;
    }

    async function api(path, options) {
      const request = options || {};
      const headers = new Headers(request.headers || {});
      headers.set("Accept", "application/json");
      headers.set("X-All-Models-Patch-Token", API_TOKEN);
      if (request.body !== undefined) headers.set("Content-Type", "application/json");
      const response = await fetch(path, {
        method: request.method || "GET",
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        cache: "no-store",
        credentials: "same-origin",
        referrerPolicy: "no-referrer"
      });
      let payload = null;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok) {
        const message = payload && (payload.error || payload.message);
        throw new Error(message || "Dashboard request failed (" + response.status + ")");
      }
      return payload;
    }

    function showError(error) {
      elements.errorMessage.textContent = error instanceof Error ? error.message : String(error);
      elements.errorBanner.hidden = false;
    }

    function announce(message) {
      elements.announcer.textContent = "";
      window.setTimeout(() => { elements.announcer.textContent = message; }, 20);
    }

    function currentSettings() {
      return { weights: { ...app.weights } };
    }

    function normalizeWeights(weights) {
      const normalized = {};
      Object.entries(weights || {}).forEach(([key, value]) => { normalized[key] = clamp(value, 0, 100); });
      return normalized;
    }

    function setControls(settings) {
      const safe = settings || {};
      app.weights = normalizeWeights(safe.weights || app.weights);
      renderWeights();
    }

    function renderWeights() {
      clear(elements.weights);
      const entries = Object.entries(app.weights);
      if (entries.length === 0) {
        elements.weights.append(node("p", "muted", "No scoring factors are configured."));
        return;
      }
      entries.forEach(([key, value]) => {
        const wrapper = node("div", "weight");
        const heading = node("div", "weight-heading");
        const labelGroup = node("span", "weight-label");
        const label = node("label", "", titleCase(key));
        const help = WEIGHT_HELP[key] || "Controls how strongly this factor influences the recommendation score.";
        const helpButton = node("button", "tooltip-trigger", "?");
        const tooltip = node("span", "factor-tooltip", help);
        const output = node("output", "weight-output", Math.round(value));
        const input = node("input");
        const inputId = "weight-" + key.replace(/[^a-z0-9_-]/gi, "-");
        const tooltipId = "tooltip-" + key.replace(/[^a-z0-9_-]/gi, "-");
        input.id = inputId;
        input.type = "range";
        input.min = "0";
        input.max = "100";
        input.step = "1";
        input.value = String(value);
        input.setAttribute("aria-label", titleCase(key) + " importance");
        input.setAttribute("aria-describedby", tooltipId);
        input.title = help;
        label.htmlFor = inputId;
        helpButton.type = "button";
        helpButton.setAttribute("aria-label", "About " + titleCase(key));
        helpButton.setAttribute("aria-describedby", tooltipId);
        tooltip.id = tooltipId;
        tooltip.setAttribute("role", "tooltip");
        labelGroup.append(label, helpButton, tooltip);
        heading.append(labelGroup, output);
        wrapper.append(heading, input);
        input.addEventListener("input", () => {
          app.weights[key] = finite(input.value, 0);
          output.value = Math.round(app.weights[key]);
          elements.presetSelect.value = "";
          queueRecommendation();
        });
        elements.weights.append(wrapper);
      });
    }

    function presets() {
      return Array.isArray(app.catalog && app.catalog.presets) ? app.catalog.presets : [];
    }

    function renderPresets(selectedId) {
      clear(elements.presetSelect);
      const custom = node("option", "", "Custom settings");
      custom.value = "";
      elements.presetSelect.append(custom);
      presets().forEach((preset) => {
        const option = node("option", "", preset.name + (preset.builtin ? " · built in" : ""));
        option.value = preset.id;
        elements.presetSelect.append(option);
      });
      elements.presetSelect.value = selectedId || "";
      updatePresetButtons();
    }

    function updatePresetButtons() {
      const selected = presets().find((preset) => preset.id === elements.presetSelect.value);
      elements.deletePreset.disabled = !selected || Boolean(selected.builtin);
      elements.deletePreset.title = selected && selected.builtin ? "Built-in presets cannot be deleted" : "Delete selected preset";
    }

    function benchmarkSpeed(item) {
      return finite(item && item.benchmark && item.benchmark.postFirstTokenTPS && item.benchmark.postFirstTokenTPS.p50, NaN);
    }

    function benchmarkTTFT(item) {
      return finite(item && item.benchmark && item.benchmark.ttftMS && item.benchmark.ttftMS.p50, NaN);
    }

    function rating(item, key) {
      return item && item.ratings && item.ratings[key] || null;
    }

    function quotaRemaining(item) {
      const windows = item && item.quota && Array.isArray(item.quota.windows) ? item.quota.windows : [];
      const remaining = windows.map((windowItem) => finite(windowItem.remainingPercent, NaN)).filter(Number.isFinite);
      if (remaining.length > 0) return Math.min(...remaining);
      return scoreValue(item && item.quota && item.quota.score);
    }

    function caveats(item) {
      return Array.isArray(item && item.caveats) ? item.caveats : item && item.caveats ? [String(item.caveats)] : [];
    }

    function confidenceFor(recommendation) {
      const values = (recommendation && recommendation.dimensions || [])
        .map((dimension) => confidenceValue(dimension.confidence))
        .filter((value) => value !== null);
      if (values.length === 0) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    function chip(text, tone, title) {
      const element = node("span", "chip" + (tone ? " " + tone : ""), text);
      if (title) element.title = title;
      return element;
    }

    function scoreRing(score) {
      const value = scoreValue(score);
      const ring = node("div", "score-ring");
      ring.style.setProperty("--score", (value === null ? 0 : value) + "%");
      ring.setAttribute("aria-label", value === null ? "Score unavailable" : "Score " + formatNumber(value, 1) + " out of 100");
      const inner = node("div", "score-inner");
      inner.append(node("strong", "", value === null ? "—" : formatNumber(value, 1)), node("small", "", "score"));
      ring.append(inner);
      return ring;
    }

    function renderRecommendations() {
      clear(elements.recommendationList);
      const eligible = app.recommendations.filter((item) => item.eligible !== false).slice(0, 6);
      elements.recommendationLoading.hidden = true;
      elements.recommendationEmpty.hidden = eligible.length > 0;
      elements.recommendationStatus.textContent = eligible.length ? eligible.length + " strongest eligible fits" : "No eligible profiles";
      eligible.forEach((recommendation, index) => {
        const item = rosterItem(recommendation.id) || { id: recommendation.id, model: recommendation.id };
        const card = node("article", "panel recommendation-card");
        const top = node("div", "card-top");
        const identity = node("div");
        identity.append(node("span", "rank", index === 0 ? "Top recommendation" : "Rank " + (index + 1)));
        identity.append(node("h3", "model-name", item.id));
        identity.append(node("span", "model-id", item.model));
        top.append(identity, scoreRing(recommendation.score));
        card.append(top);

        const facts = node("div", "fact-row");
        const speed = benchmarkSpeed(item);
        const remaining = quotaRemaining(item);
        const confidence = confidenceFor(recommendation);
        facts.append(chip(Number.isFinite(speed) ? formatNumber(speed, 1) + " tok/s" : "speed unknown", Number.isFinite(speed) ? "good" : "warn"));
        facts.append(chip(remaining === null || !Number.isFinite(remaining) ? "quota unknown" : formatNumber(remaining, 0) + "% quota", remaining !== null && remaining < 20 ? "warn" : ""));
        facts.append(chip(confidence === null ? "confidence unknown" : formatNumber(confidence, 0) + "% confidence", confidence !== null && confidence < 55 ? "warn" : ""));
        if (item.benchmark && item.benchmark.provisional) facts.append(chip("provisional speed", "warn"));
        if (caveats(item).length) facts.append(chip(caveats(item).length + " caveat" + (caveats(item).length === 1 ? "" : "s"), "warn", caveats(item).join(" · ")));
        card.append(facts);

        const reasons = node("ul", "reason-list");
        (Array.isArray(recommendation.reasons) ? recommendation.reasons : []).slice(0, 3).forEach((reason) => reasons.append(node("li", "", reason)));
        if (!reasons.childElementCount) reasons.append(node("li", "", "Score reflects the current weights and live evidence."));
        card.append(reasons);

        const strip = node("div", "dimension-strip");
        (recommendation.dimensions || []).forEach((dimension) => {
          const segment = node("div", "dimension-segment");
          const bar = node("div");
          const fill = node("i");
          fill.style.setProperty("--dimension", (scoreValue(dimension.value) || 0) + "%");
          bar.append(fill);
          const dimensionId = dimension.id || dimension.dimensionId;
          segment.append(bar, node("span", "", dimension.label || titleCase(dimensionId)));
          segment.title = (dimension.label || titleCase(dimensionId)) + ": " + formatNumber(scoreValue(dimension.value), 1);
          strip.append(segment);
        });
        card.append(strip);
        const details = node("button", "details-link", "Inspect evidence →");
        details.type = "button";
        details.addEventListener("click", (event) => openDetails(item.id, event.currentTarget));
        card.append(details);
        elements.recommendationList.append(card);
      });
      renderRoster();
    }

    function renderSources() {
      clear(elements.sourceList);
      const sources = app.catalog && app.catalog.dataSources;
      const entries = Array.isArray(sources) ? sources : Object.entries(sources || {}).map(([id, value]) => typeof value === "object" ? { id, ...value } : { id, status: value });
      if (entries.length === 0) {
        elements.sourceList.append(node("span", "source", "No source metadata reported."));
        return;
      }
      entries.forEach((sourceItem) => {
        const name = sourceItem.label || sourceItem.name || titleCase(sourceItem.id || "source");
        const stamp = sourceItem.updatedAt || sourceItem.generatedAt || sourceItem.completedAt;
        const status = sourceItem.status || sourceItem.state || "available";
        elements.sourceList.append(chip(name + " · " + status + (stamp ? " · " + relativeTime(stamp) : ""), ["stale", "error", "unavailable"].includes(status) ? "warn" : "good", stamp ? formatDate(stamp) : "Freshness not reported"));
      });
    }

    function sortValue(item, key) {
      const recommendation = recommendationFor(item.id);
      if (key === "provider") return String(item.provider || "").toLowerCase();
      if (key === "speed") return benchmarkSpeed(item);
      if (key === "ttft") return benchmarkTTFT(item);
      if (key === "taste" || key === "publicRating") return finite(rating(item, key) && rating(item, key).value, NaN);
      if (key === "quota") return finite(quotaRemaining(item), NaN);
      if (key === "context") return finite(item.context && item.context.contextTokens, NaN);
      if (key === "score") return finite(recommendation && recommendation.score, finite(item.defaultScore, NaN));
      return String(item.id || "").toLowerCase();
    }

    function compareValues(left, right, direction) {
      const factor = direction === "asc" ? 1 : -1;
      if (typeof left === "string" || typeof right === "string") return String(left).localeCompare(String(right)) * factor;
      const leftValid = Number.isFinite(left);
      const rightValid = Number.isFinite(right);
      if (!leftValid && !rightValid) return 0;
      if (!leftValid) return 1;
      if (!rightValid) return -1;
      return (left - right) * factor;
    }

    function updateSortHeaders() {
      document.querySelectorAll("th[data-sort], th:has(button[data-sort])").forEach((heading) => {
        const button = heading.querySelector("button[data-sort]");
        const active = button && button.dataset.sort === app.sort.key;
        heading.setAttribute("aria-sort", active ? (app.sort.direction === "asc" ? "ascending" : "descending") : "none");
      });
    }

    function renderRoster() {
      clear(elements.rosterBody);
      const query = app.search.trim().toLowerCase();
      const roster = [...(app.catalog && app.catalog.roster || [])]
        .filter((item) => !query || [item.id, item.model, item.provider, item.description].some((value) => String(value || "").toLowerCase().includes(query)))
        .sort((left, right) => compareValues(sortValue(left, app.sort.key), sortValue(right, app.sort.key), app.sort.direction));
      elements.rosterEmpty.hidden = roster.length > 0;
      roster.forEach((item) => {
        const recommendation = recommendationFor(item.id);
        const row = node("tr");
        const identityCell = node("td");
        const identity = node("button", "table-model", item.id);
        identity.type = "button";
        identity.addEventListener("click", (event) => openDetails(item.id, event.currentTarget));
        identityCell.append(identity, node("span", "table-sub", item.model));
        row.append(identityCell);
        row.append(node("td", "", item.provider || "—"));

        const speed = benchmarkSpeed(item);
        const speedCell = node("td", "numeric", Number.isFinite(speed) ? formatNumber(speed, 1) + " tok/s" : "—");
        if (item.benchmark && item.benchmark.provisional) speedCell.append(node("span", "chip warn", "provisional"));
        row.append(speedCell);
        const ttft = benchmarkTTFT(item);
        row.append(node("td", "numeric", Number.isFinite(ttft) ? formatNumber(ttft, 0) + " ms" : "—"));

        ["taste", "publicRating"].forEach((key) => {
          const evidence = rating(item, key);
          const value = scoreValue(evidence && evidence.value);
          const cell = node("td");
          cell.append(node("span", "numeric", value === null ? "—" : formatNumber(value, 0)));
          if (value !== null) {
            const meter = node("div", "meter");
            const fill = node("i");
            fill.style.setProperty("--meter", value + "%");
            meter.append(fill);
            meter.title = "Confidence " + formatNumber(confidenceValue(evidence.confidence), 0) + "%";
            cell.append(meter);
          }
          row.append(cell);
        });

        const remaining = quotaRemaining(item);
        const quotaCell = node("td");
        quotaCell.append(node("span", "numeric", remaining === null || !Number.isFinite(remaining) ? "—" : formatNumber(remaining, 0) + "%"));
        if (item.quota && item.quota.state) quotaCell.append(node("span", "table-sub", item.quota.state));
        row.append(quotaCell);
        row.append(node("td", "numeric", formatTokens(item.context && item.context.contextTokens)));
        const score = scoreValue(recommendation ? recommendation.score : item.defaultScore);
        const scoreCell = node("td");
        scoreCell.append(chip(score === null ? "—" : formatNumber(score, 1), score !== null && recommendation && recommendation.eligible !== false ? "good" : "warn"));
        row.append(scoreCell);
        elements.rosterBody.append(row);
      });
      updateSortHeaders();
    }

    function addFact(container, label, value) {
      const wrapper = node("div", "fact");
      wrapper.append(node("dt", "", label), node("dd", "", value));
      container.append(wrapper);
    }

    function aaRatingProvenanceLine(item) {
      const ratings = item && item.ratings || {};
      const candidates = ["aaCoding", "aaAgentic", "aaIntelligence"]
        .map((key) => ratings[key])
        .filter((rating) => rating && typeof rating === "object");
      const rating = candidates.find((entry) => {
        const source = String(entry.source || "").toLowerCase();
        return source.includes("artificial") || entry.variant || entry.indexVersion || entry.fetchedAt;
      });
      if (!rating) return null;
      const source = String(rating.source || "").toLowerCase();
      if (!source.includes("artificial") && !rating.variant && !rating.indexVersion && !rating.fetchedAt) return null;
      const parts = ["Artificial Analysis"];
      const variant = rating.variant || item.selectedAaVariant;
      if (variant) parts.push("variant " + variant);
      if (rating.indexVersion) parts.push("index v" + rating.indexVersion);
      if (rating.fetchedAt) parts.push("fetched " + formatDate(rating.fetchedAt));
      return parts.length > 1 ? parts.join(" · ") : null;
    }

    function renderAaVariants(item) {
      const section = byId("drawer-variants-section");
      const container = byId("drawer-variants");
      clear(container);
      const variants = item && Array.isArray(item.aaVariants) ? item.aaVariants : [];
      if (!variants.length) {
        section.hidden = true;
        return;
      }
      section.hidden = false;
      variants.forEach((variant) => {
        const selected = variant.aaSlug === item.selectedAaVariant;
        const button = node("button", "aa-variant" + (selected ? " selected" : ""));
        button.type = "button";
        button.disabled = selected;
        button.dataset.aaSlug = variant.aaSlug || "";
        button.append(node("span", "aa-variant-name", variant.aaName || variant.aaSlug || "Unnamed variant"));
        if (selected) button.append(node("span", "aa-variant-selected", "Selected"));
        const meta = [
          "Coding " + formatNumber(variant.artificial_analysis_coding_index, 1),
          "Agentic " + formatNumber(variant.artificial_analysis_agentic_index, 1),
          "Intelligence " + formatNumber(variant.artificial_analysis_intelligence_index, 1),
          Number.isFinite(Number(variant.median_output_tokens_per_second))
            ? formatNumber(variant.median_output_tokens_per_second, 1) + " tok/s"
            : "tok/s —",
          Number.isFinite(Number(variant.median_time_to_first_answer_token_seconds))
            ? formatNumber(variant.median_time_to_first_answer_token_seconds, 2) + "s TTFAT"
            : "TTFAT —"
        ].join(" · ");
        button.append(node("span", "aa-variant-meta", meta));
        if (!selected) {
          button.addEventListener("click", async () => {
            try {
              button.disabled = true;
              await api("/api/aa-variant", { method: "POST", body: { profile: item.id, variant: variant.aaSlug } });
              await loadState(true);
              openDetails(item.id, app.dialogTrigger);
              announce("Selected Artificial Analysis variant " + (variant.aaName || variant.aaSlug) + ".");
            } catch (error) {
              button.disabled = false;
              showError(error);
            }
          });
        }
        container.append(button);
      });
    }

    function openDetails(id, trigger) {
      const item = rosterItem(id);
      if (!item) return;
      app.dialogTrigger = trigger && typeof trigger.focus === "function" ? trigger : document.activeElement;
      const recommendation = recommendationFor(id);
      byId("drawer-provider").textContent = item.provider || "Unknown provider";
      byId("drawer-title").textContent = item.id;
      byId("drawer-model").textContent = item.model || "";
      byId("drawer-description").textContent = item.description || "No profile guidance is available.";

      const chips = byId("drawer-chips");
      clear(chips);
      if (recommendation) chips.append(chip((recommendation.eligible === false ? "Ineligible · " : "Score · ") + formatNumber(scoreValue(recommendation.score), 1), recommendation.eligible === false ? "warn" : "good"));
      if (item.context && item.context.status) chips.append(chip("Context · " + item.context.status, item.context.status === "verified" ? "good" : "warn"));
      if (item.benchmark && item.benchmark.provisional) chips.append(chip("Provisional benchmark", "warn"));
      caveats(item).forEach((value) => chips.append(chip(value, "warn")));

      renderAaVariants(item);

      const facts = byId("drawer-facts");
      clear(facts);
      addFact(facts, "Post-first-token", Number.isFinite(benchmarkSpeed(item)) ? formatNumber(benchmarkSpeed(item), 1) + " tok/s p50" : "Not measured");
      addFact(facts, "First token", Number.isFinite(benchmarkTTFT(item)) ? formatNumber(benchmarkTTFT(item), 0) + " ms p50" : "Not measured");
      addFact(facts, "Context window", formatTokens(item.context && item.context.contextTokens) + " tokens");
      addFact(facts, "Compact at", formatTokens(item.context && item.context.compactAtTokens) + " tokens");
      const samples = item.benchmark && item.benchmark.measuredSamples;
      const valid = item.benchmark && item.benchmark.validSamples;
      addFact(facts, "Benchmark samples", samples === undefined ? "Unknown" : String(valid || 0) + " / " + String(samples) + " valid");
      addFact(facts, "Last benchmark", item.benchmark && item.benchmark.completedAt ? formatDate(item.benchmark.completedAt) : "Not reported");

      const dimensions = byId("drawer-dimensions");
      clear(dimensions);
      const dimensionData = recommendation && recommendation.dimensions || item.dimensions || [];
      dimensionData.forEach((dimension) => {
        const row = node("div", "dimension-row");
        const value = scoreValue(dimension.value);
        const bar = node("div", "dimension-bar");
        const fill = node("i");
        fill.style.setProperty("--dimension", (value || 0) + "%");
        bar.append(fill);
        const contribution = finite(dimension.weightedContribution ?? dimension.deltaFromNeutral ?? dimension.contribution, NaN);
        const suffix = Number.isFinite(contribution) ? (contribution >= 0 ? "+" : "") + formatNumber(contribution, 2) : formatNumber(value, 1);
        row.append(node("label", "", dimension.label || titleCase(dimension.id || dimension.dimensionId)), bar, node("span", "dimension-value", suffix));
        row.title = "Value " + formatNumber(value, 1) + " · confidence " + formatNumber(confidenceValue(dimension.confidence), 0) + "%";
        dimensions.append(row);
      });
      if (!dimensions.childElementCount) dimensions.append(node("p", "muted", "No score dimensions are available."));

      const quota = byId("drawer-quota");
      clear(quota);
      const windows = item.quota && Array.isArray(item.quota.windows) ? item.quota.windows : [];
      windows.forEach((windowItem) => {
        const remaining = finite(windowItem.remainingPercent, NaN);
        const reset = windowItem.resetAt ? " · resets " + relativeTime(windowItem.resetAt) : "";
        addFact(quota, windowItem.label || titleCase(windowItem.id), (Number.isFinite(remaining) ? formatNumber(remaining, 0) + "% remaining" : "Usage unknown") + reset);
      });
      if (!quota.childElementCount) addFact(quota, "Availability", item.quota && item.quota.state || "No quota telemetry");

      const provenance = byId("drawer-provenance");
      clear(provenance);
      const aaLine = aaRatingProvenanceLine(item);
      if (aaLine) provenance.append(node("li", "", aaLine));
      const records = Array.isArray(item.provenance) ? item.provenance : [];
      records.forEach((record) => provenance.append(node("li", "", typeof record === "string" ? record : [record.label || record.source || record.id, record.updatedAt ? formatDate(record.updatedAt) : null].filter(Boolean).join(" · "))));
      caveats(item).forEach((value) => provenance.append(node("li", "", "Caveat · " + value)));
      if (!provenance.childElementCount) provenance.append(node("li", "", "No provenance metadata reported."));

      if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
      else elements.dialog.setAttribute("open", "");
      byId("close-dialog").focus({ preventScroll: true });
    }

    function restoreDialogFocus() {
      const trigger = app.dialogTrigger;
      app.dialogTrigger = null;
      if (trigger && trigger.isConnected && typeof trigger.focus === "function") trigger.focus({ preventScroll: true });
    }

    function closeDetails() {
      if (typeof elements.dialog.close === "function" && elements.dialog.open) {
        elements.dialog.close();
        return;
      }
      elements.dialog.removeAttribute("open");
      restoreDialogFocus();
    }

    async function refreshRecommendations() {
      const sequence = ++app.requestSequence;
      elements.recommendationStatus.textContent = "Recalculating…";
      try {
        const result = await api("/api/recommend", { method: "POST", body: currentSettings() });
        if (sequence !== app.requestSequence) return;
        app.recommendations = Array.isArray(result && result.recommendations) ? result.recommendations : [];
        renderRecommendations();
        announce("Recommendations updated. " + app.recommendations.filter((item) => item.eligible !== false).length + " eligible profiles.");
      } catch (error) {
        if (sequence !== app.requestSequence) return;
        elements.recommendationLoading.hidden = true;
        elements.recommendationStatus.textContent = "Update failed";
        showError(error);
      }
    }

    function queueRecommendation() {
      window.clearTimeout(app.recommendationTimer);
      elements.recommendationStatus.textContent = "Weights changed…";
      app.recommendationTimer = window.setTimeout(refreshRecommendations, 180);
    }

    async function loadState(preserveControls) {
      elements.freshness.textContent = "Refreshing…";
      const existing = preserveControls ? currentSettings() : null;
      try {
        const catalog = await api("/api/state");
        if (!catalog || !Array.isArray(catalog.roster)) throw new Error("Dashboard state did not include a model roster");
        app.catalog = catalog;
        const defaults = catalog.defaults || {};
        setControls(existing || { weights: defaults.weights || {} });
        elements.modelCount.textContent = catalog.roster.length;
        elements.freshness.textContent = catalog.generatedAt ? "Updated " + relativeTime(catalog.generatedAt) : "Live data";
        elements.freshness.title = catalog.generatedAt ? formatDate(catalog.generatedAt) : "Generation time unavailable";
        renderPresets("");
        renderSources();
        renderRoster();
        await refreshRecommendations();
      } catch (error) {
        elements.recommendationLoading.hidden = true;
        elements.freshness.textContent = "Offline";
        showError(error);
      }
    }

    function switchTab(tabName) {
      const recommendationActive = tabName === "recommendation";
      byId("recommendation-view").hidden = !recommendationActive;
      byId("roster-view").hidden = recommendationActive;
      ["recommendation", "roster"].forEach((name) => {
        const tab = byId("tab-" + name);
        const active = name === tabName;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      });
    }

    byId("tab-recommendation").addEventListener("click", () => switchTab("recommendation"));
    byId("tab-roster").addEventListener("click", () => switchTab("roster"));
    document.querySelector("[role='tablist']").addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const target = event.key === "ArrowRight" ? byId("tab-roster") : byId("tab-recommendation");
      target.click();
      target.focus();
    });
    byId("refresh").addEventListener("click", () => loadState(true));
    byId("dismiss-error").addEventListener("click", () => { elements.errorBanner.hidden = true; });
    elements.presetSelect.addEventListener("change", () => {
      const preset = presets().find((item) => item.id === elements.presetSelect.value);
      if (preset && preset.settings) {
        setControls(preset.settings);
        queueRecommendation();
      }
      updatePresetButtons();
    });
    byId("save-preset").addEventListener("click", async () => {
      const name = elements.presetName.value.trim();
      if (!name) {
        showError(new Error("Enter a name before saving this profile."));
        elements.presetName.focus();
        return;
      }
      try {
        await api("/api/presets", { method: "POST", body: { name, settings: currentSettings() } });
        elements.presetName.value = "";
        await loadState(true);
        announce("Preset " + name + " saved.");
      } catch (error) { showError(error); }
    });
    elements.deletePreset.addEventListener("click", async () => {
      const preset = presets().find((item) => item.id === elements.presetSelect.value);
      if (!preset || preset.builtin) return;
      if (!window.confirm("Delete the preset ‘" + preset.name + "’?")) return;
      try {
        await api("/api/presets/" + encodeURIComponent(preset.id), { method: "DELETE" });
        await loadState(true);
        announce("Preset " + preset.name + " deleted.");
      } catch (error) { showError(error); }
    });
    byId("roster-search").addEventListener("input", (event) => { app.search = event.target.value; renderRoster(); });
    document.querySelectorAll("button[data-sort]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (app.sort.key === key) app.sort.direction = app.sort.direction === "asc" ? "desc" : "asc";
      else app.sort = { key, direction: key === "id" || key === "provider" ? "asc" : "desc" };
      renderRoster();
    }));
    byId("close-dialog").addEventListener("click", closeDetails);
    elements.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDetails();
    });
    elements.dialog.addEventListener("close", restoreDialogFocus);
    elements.dialog.addEventListener("click", (event) => {
      const bounds = elements.dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDetails();
    });

    loadState(false);
  </script>
</body>
</html>`;
}
