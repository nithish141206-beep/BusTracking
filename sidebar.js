/**
 * sidebar.js — BusTrack Premium Transit Sidebar
 * ─────────────────────────────────────────────
 * Google Maps + Uber + Tesla dashboard aesthetic.
 * Self-contained IIFE — injects CSS & DOM, hooks into existing
 * `map` (Leaflet) and `busData` globals from map.html.
 *
 * Route lifecycle fix:
 *  • routeLayer    — polylines only
 *  • busStopLayer  — intermediate bus-stop markers
 *  • markerLayer   — From / To endpoint markers
 *  • vehicleLayer  — live bus markers (NEVER cleared on route change)
 *
 * All four LayerGroups are exposed on window so map.html can use them.
 *
 * DEMO BUS FIX (v2):
 *  syncGlobalRouteState now passes the new coords array directly to
 *  window.respawnDemoBuses(coords) so map.html's local routeCoords
 *  variable is updated inside the function — bypassing the JS closure
 *  scoping issue where window.routeCoords and the local var diverged.
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════ */
  const MAX_RECENTS = 4;
  const NOMINATIM   = 'https://nominatim.openstreetmap.org/search';
  const OSRM        = 'https://router.project-osrm.org/route/v1/driving/';

  /* Demo bus IDs — must mirror map.html */
  const DEMO_IDS = new Set(['BUS-DEMO-01', 'BUS-EV-01']);

  /* ═══════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════ */
  let recents        = JSON.parse(localStorage.getItem('bt_recents') || '[]');
  let searchDebounce = null;
  let sidebarOpen    = false;
  let activePanelBus = null;

  /* LayerGroups — initialised once Leaflet map is ready */
  let routeLayer    = null;   // sidebar-drawn polylines
  let busStopLayer  = null;   // sidebar-drawn bus stop markers
  let markerLayer   = null;   // sidebar-drawn endpoint markers (From / To)
  let vehicleLayer  = null;   // live vehicle markers — NEVER cleared

  /* Panel refresh interval */
  let panelRefreshInterval = null;

  /* Track current sidebar route data so we can update global state */
  let sidebarRouteCoords    = [];
  let sidebarRouteTotalKm   = 0;
  let sidebarFromName       = '';
  let sidebarToName         = '';
  let sidebarFromCoord      = null;
  let sidebarToCoord        = null;
  let sidebarBusStops       = [];
  let sidebarStopMarkerRefs = {};

  /* ─── LayerGroup bootstrap ───────────────────────────────────
     Wait for Leaflet `map` global, then create all four groups.
     vehicleLayer is exposed on window so map.html's processBusUpdate
     can add markers to it instead of directly to the map.
  ─────────────────────────────────────────────────────────────*/
  function initLayerGroups() {
    if (typeof map !== 'undefined' && map && map.addLayer) {
      /* Route-related layers */
      routeLayer   = L.layerGroup().addTo(map);
      busStopLayer = L.layerGroup().addTo(map);
      markerLayer  = L.layerGroup().addTo(map);

      /* Vehicle layer — separate, permanent */
      vehicleLayer = L.layerGroup().addTo(map);

      /* Expose so map.html can reference them */
      window._btRouteLayer    = routeLayer;
      window._btBusStopLayer  = busStopLayer;
      window._btMarkerLayer   = markerLayer;
      window._btVehicleLayer  = vehicleLayer;

      return;
    }
    setTimeout(initLayerGroups, 200);
  }
  initLayerGroups();

  /* ═══════════════════════════════════════════════════════════
     CSS INJECTION
  ═══════════════════════════════════════════════════════════ */
  const css = document.createElement('style');
  css.id = 'bt-sidebar-styles';
  css.textContent = `

/* ── Design tokens (mirror map.html palette) ─────────────── */
:root {
  --bt-bg:        #080c18;
  --bt-surf:      rgba(11, 16, 30, 0.95);
  --bt-surf2:     rgba(16, 23, 42, 0.97);
  --bt-glass:     rgba(13, 19, 37, 0.82);
  --bt-glass2:    rgba(18, 26, 48, 0.9);
  --bt-accent:    #f97316;
  --bt-accent2:   #fb923c;
  --bt-blue:      #3b82f6;
  --bt-blue2:     #60a5fa;
  --bt-green:     #22c55e;
  --bt-red:       #ef4444;
  --bt-text:      #f1f5f9;
  --bt-muted:     #94a3b8;
  --bt-faint:     #4a5568;
  --bt-border:    rgba(255,255,255,0.06);
  --bt-border-hi: rgba(255,255,255,0.11);
  --bt-topbar:    60px;
  --bt-drawer-w:  310px;
  --bt-panel-w:   308px;
  --bt-radius:    16px;
  --bt-radius-sm: 10px;
  --bt-radius-xs: 7px;
}

/* ═══════════════════════════════════════════════════════════
   HAMBURGER TOGGLE BUTTON
═══════════════════════════════════════════════════════════ */
#bt-toggle {
  position: absolute;
  top: calc(var(--bt-topbar) + 13px);
  left: 14px;
  z-index: 1200;
  width: 38px; height: 38px;
  background: var(--bt-glass2);
  border: 1px solid var(--bt-border-hi);
  border-radius: var(--bt-radius-sm);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  backdrop-filter: blur(20px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.04) inset;
  transition: border-color 0.2s, background 0.2s, transform 0.15s, left 0.32s cubic-bezier(0.4,0,0.2,1);
  user-select: none;
  flex-direction: column; gap: 4.5px;
}
#bt-toggle:hover {
  border-color: rgba(249,115,22,0.5);
  background: rgba(249,115,22,0.08);
}
#bt-toggle:active { transform: scale(0.91); }
#bt-toggle.open   { left: calc(14px + var(--bt-drawer-w) + 9px); }

#bt-toggle .bt-bar {
  display: block;
  width: 16px; height: 1.8px;
  background: var(--bt-muted);
  border-radius: 2px;
  transition: transform 0.28s cubic-bezier(0.4,0,0.2,1),
              opacity   0.2s,
              width     0.2s;
  pointer-events: none;
}
#bt-toggle.open .bt-bar:nth-child(1) { transform: translateY(6.3px) rotate(45deg); }
#bt-toggle.open .bt-bar:nth-child(2) { opacity: 0; width: 0; }
#bt-toggle.open .bt-bar:nth-child(3) { transform: translateY(-6.3px) rotate(-45deg); }

/* ═══════════════════════════════════════════════════════════
   LEFT DRAWER
═══════════════════════════════════════════════════════════ */
#bt-drawer {
  position: absolute;
  top: calc(var(--bt-topbar) + 10px);
  left: 14px;
  bottom: 14px;
  width: var(--bt-drawer-w);
  z-index: 1100;
  display: flex; flex-direction: column;
  background: var(--bt-surf);
  backdrop-filter: blur(32px) saturate(1.7);
  -webkit-backdrop-filter: blur(32px) saturate(1.7);
  border: 1px solid var(--bt-border-hi);
  border-radius: var(--bt-radius);
  box-shadow:
    0 20px 60px rgba(0,0,0,0.65),
    0 0 0 1px rgba(249,115,22,0.03) inset,
    inset 0 1px 0 rgba(255,255,255,0.04);
  overflow: hidden;
  transform: translateX(calc(-1 * (var(--bt-drawer-w) + 32px)));
  opacity: 0;
  pointer-events: none;
  transition:
    transform 0.34s cubic-bezier(0.4,0,0.2,1),
    opacity   0.28s ease;
}
#bt-drawer.open {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}

#bt-drawer::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, var(--bt-accent), transparent 75%);
  border-radius: var(--bt-radius) var(--bt-radius) 0 0;
  z-index: 1;
}

#bt-drawer-inner {
  display: flex; flex-direction: column;
  height: 100%; padding: 14px 13px 13px;
  gap: 9px; overflow: hidden;
}

.bt-label {
  font-family: 'Syne', sans-serif;
  font-size: 9px; font-weight: 700;
  letter-spacing: 0.9px; text-transform: uppercase;
  color: var(--bt-faint); padding: 0 2px; flex-shrink: 0;
}

.bt-rule {
  height: 1px; background: var(--bt-border);
  flex-shrink: 0; margin: 1px 0;
}

.bt-field-wrap {
  position: relative; flex-shrink: 0;
}
.bt-field-wrap input {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--bt-border-hi);
  border-radius: var(--bt-radius-sm);
  color: var(--bt-text);
  font-family: 'DM Sans', sans-serif; font-size: 12.5px;
  padding: 9px 34px 9px 35px;
  outline: none; transition: border-color 0.18s, background 0.18s;
}
.bt-field-wrap input::placeholder { color: var(--bt-faint); }
.bt-field-wrap input:focus {
  border-color: rgba(249,115,22,0.45);
  background: rgba(255,255,255,0.055);
  box-shadow: 0 0 0 3px rgba(249,115,22,0.06);
}
.bt-field-icon {
  position: absolute; left: 10px; top: 50%;
  transform: translateY(-50%);
  font-size: 13px; color: var(--bt-faint); pointer-events: none;
}
.bt-field-clear {
  position: absolute; right: 7px; top: 50%;
  transform: translateY(-50%);
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--bt-border-hi); border: none;
  color: var(--bt-muted); font-size: 10px;
  cursor: pointer; display: none; place-items: center;
  transition: background 0.14s, color 0.14s;
}
.bt-field-clear.vis { display: grid; }
.bt-field-clear:hover { background: rgba(249,115,22,0.2); color: var(--bt-accent); }

#bt-ac {
  background: var(--bt-surf2);
  border: 1px solid var(--bt-border-hi);
  border-radius: var(--bt-radius-sm);
  overflow: hidden; flex-shrink: 0;
  max-height: 0; opacity: 0;
  transition: max-height 0.26s ease, opacity 0.2s;
}
#bt-ac.vis { max-height: 260px; opacity: 1; }

.bt-ac-item {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 12px; cursor: pointer;
  border-bottom: 1px solid var(--bt-border);
  transition: background 0.13s;
}
.bt-ac-item:last-child { border-bottom: none; }
.bt-ac-item:hover { background: rgba(249,115,22,0.06); }
.bt-ac-icon { font-size: 13px; color: var(--bt-accent); flex-shrink: 0; }
.bt-ac-text { flex: 1; overflow: hidden; }
.bt-ac-name {
  font-size: 12px; color: var(--bt-text); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bt-ac-sub {
  font-size: 10px; color: var(--bt-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;
}
.bt-ac-msg { text-align: center; padding: 13px; font-size: 11px; color: var(--bt-faint); }

#bt-loc-btn {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 12px;
  background: rgba(34,197,94,0.06);
  border: 1px solid rgba(34,197,94,0.16);
  border-radius: var(--bt-radius-sm);
  color: #86efac; font-size: 12px; cursor: pointer;
  transition: background 0.16s, border-color 0.16s; flex-shrink: 0;
}
#bt-loc-btn:hover { background: rgba(34,197,94,0.12); border-color: rgba(34,197,94,0.32); }
#bt-loc-btn:active { opacity: 0.75; }
#bt-loc-icon { font-size: 14px; }
#bt-loc-label { font-family: 'DM Sans', sans-serif; font-weight: 500; }

#bt-dir-block { display: flex; flex-direction: column; gap: 7px; flex-shrink: 0; }
.bt-dir-fields { display: flex; flex-direction: column; gap: 5px; }

.bt-swap-row {
  display: flex; justify-content: center;
}
#bt-swap {
  width: 26px; height: 26px;
  background: rgba(59,130,246,0.1);
  border: 1px solid rgba(59,130,246,0.22);
  border-radius: 8px; color: var(--bt-blue2);
  font-size: 13px; cursor: pointer;
  display: grid; place-items: center;
  transition: background 0.15s, transform 0.15s;
}
#bt-swap:hover { background: rgba(59,130,246,0.2); transform: rotate(180deg); }

#bt-route-btn {
  width: 100%; padding: 9px;
  background: linear-gradient(135deg, var(--bt-blue), #1d4ed8);
  border: none; border-radius: var(--bt-radius-sm);
  color: white; font-family: 'Syne', sans-serif;
  font-weight: 700; font-size: 12px; letter-spacing: 0.3px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(59,130,246,0.35);
  transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
}
#bt-route-btn:hover {
  opacity: 0.9; transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(59,130,246,0.45);
}
#bt-route-btn:active { transform: translateY(0) scale(0.98); }

#bt-eta-display {
  font-size: 11px; color: var(--bt-muted);
  text-align: center; min-height: 16px;
  transition: color 0.2s;
}
#bt-eta-display.has-result { color: var(--bt-green); font-weight: 500; }

#bt-scroll {
  flex: 1; overflow-y: auto;
  display: flex; flex-direction: column; gap: 7px;
  scrollbar-width: thin; scrollbar-color: var(--bt-border-hi) transparent;
  padding-right: 2px;
}
#bt-scroll::-webkit-scrollbar { width: 3px; }
#bt-scroll::-webkit-scrollbar-thumb { background: var(--bt-border-hi); border-radius: 2px; }

.bt-list { display: flex; flex-direction: column; gap: 4px; }

.bt-item {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-xs);
  cursor: pointer;
  transition: background 0.13s, border-color 0.13s, transform 0.13s;
}
.bt-item:hover {
  background: rgba(249,115,22,0.05);
  border-color: rgba(249,115,22,0.18);
  transform: translateX(2px);
}
.bt-item:active { transform: translateX(0) scale(0.99); }

.bt-item-icon {
  width: 28px; height: 28px; border-radius: var(--bt-radius-xs);
  display: grid; place-items: center; font-size: 13px; flex-shrink: 0;
}
.bt-item-icon.saved  { background: rgba(249,115,22,0.1); }
.bt-item-icon.recent { background: rgba(59,130,246,0.1);  }

.bt-item-text { flex: 1; overflow: hidden; }
.bt-item-name {
  font-size: 12px; color: var(--bt-text); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bt-item-sub {
  font-size: 10px; color: var(--bt-faint); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bt-item-arrow { color: var(--bt-faint); font-size: 11px; flex-shrink: 0; }

.bt-empty {
  text-align: center; padding: 8px 4px;
  font-size: 11px; color: var(--bt-faint); font-style: italic;
}

/* ═══════════════════════════════════════════════════════════
   FLOATING BUS ICON DOCK  (right side, vertically centered)
═══════════════════════════════════════════════════════════ */
#bt-bus-dock {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1050;
  display: flex; flex-direction: column;
  align-items: center; gap: 14px;
}

.bt-bus-icon {
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  cursor: pointer;
  transition: transform 0.24s cubic-bezier(0.34,1.56,0.64,1);
}
.bt-bus-icon:hover  { transform: translateX(-5px) scale(1.07); }
.bt-bus-icon.active { transform: translateX(-8px) scale(1.1); }

.bt-bus-disc {
  width: 54px; height: 54px; border-radius: 50%;
  background: var(--bt-glass2);
  border: 2px solid var(--bt-border-hi);
  display: flex; align-items: center; justify-content: center;
  position: relative; overflow: visible;
  box-shadow:
    0 8px 28px rgba(0,0,0,0.55),
    0 0 0 0 transparent;
  transition: border-color 0.22s, box-shadow 0.22s, background 0.22s;
}

.bt-bus-icon:not(.demo):hover .bt-bus-disc,
.bt-bus-icon:not(.demo).active .bt-bus-disc {
  border-color: rgba(249,115,22,0.6);
  background: rgba(249,115,22,0.1);
  box-shadow:
    0 10px 32px rgba(0,0,0,0.6),
    0 0 22px rgba(249,115,22,0.22),
    0 0 0 5px rgba(249,115,22,0.07);
}

.bt-bus-icon.demo:hover .bt-bus-disc,
.bt-bus-icon.demo.active .bt-bus-disc {
  border-color: rgba(59,130,246,0.6);
  background: rgba(59,130,246,0.1);
  box-shadow:
    0 10px 32px rgba(0,0,0,0.6),
    0 0 22px rgba(59,130,246,0.28),
    0 0 0 5px rgba(59,130,246,0.08);
}

.bt-bus-disc .bt-disc-emoji {
  font-size: 22px;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
  transition: transform 0.2s;
}
.bt-bus-icon:hover .bt-disc-emoji,
.bt-bus-icon.active .bt-disc-emoji {
  transform: scale(1.1);
}

.bt-bus-dot {
  position: absolute; top: 3px; right: 3px;
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--bt-green);
  border: 2px solid #080c18;
  box-shadow: 0 0 7px var(--bt-green);
  animation: bt-pulse-green 2s ease-in-out infinite;
}
.bt-bus-dot.stopped {
  background: var(--bt-red);
  box-shadow: 0 0 5px var(--bt-red);
  animation: none; opacity: 0.75;
}

@keyframes bt-pulse-green {
  0%,100% { opacity:1; transform:scale(1);   }
  50%      { opacity:0.35; transform:scale(0.65); }
}

.bt-bus-lbl {
  font-family: 'Syne', sans-serif;
  font-size: 9px; font-weight: 700; letter-spacing: 0.4px;
  color: var(--bt-muted); text-align: center; line-height: 1.2;
  white-space: nowrap;
  transition: color 0.2s;
}
.bt-bus-icon:hover .bt-bus-lbl,
.bt-bus-icon.active .bt-bus-lbl { color: var(--bt-accent); }
.bt-bus-icon.demo:hover .bt-bus-lbl,
.bt-bus-icon.demo.active .bt-bus-lbl { color: var(--bt-blue2); }

.bt-bus-chip {
  font-size: 8px; font-weight: 700; letter-spacing: 0.5px;
  text-transform: uppercase; padding: 1px 6px; border-radius: 5px;
}
.bt-bus-chip.real {
  background: rgba(249,115,22,0.14);
  border: 1px solid rgba(249,115,22,0.28);
  color: var(--bt-accent);
}
.bt-bus-chip.demo {
  background: rgba(59,130,246,0.14);
  border: 1px solid rgba(59,130,246,0.28);
  color: var(--bt-blue2);
}

/* ═══════════════════════════════════════════════════════════
   BUS DETAILS PANEL  (slides in from right)
═══════════════════════════════════════════════════════════ */
#bt-panel {
  position: absolute;
  top: calc(var(--bt-topbar) + 12px);
  right: -360px;
  bottom: 14px;
  width: var(--bt-panel-w);
  z-index: 1080;
  opacity: 0; pointer-events: none;
  transition:
    right 0.38s cubic-bezier(0.4,0,0.2,1),
    opacity 0.3s ease;
}
#bt-panel.open {
  right: 82px;
  opacity: 1; pointer-events: auto;
}

#bt-panel-card {
  height: 100%; border-radius: var(--bt-radius);
  background: rgba(9, 14, 26, 0.97);
  backdrop-filter: blur(36px) saturate(1.9);
  -webkit-backdrop-filter: blur(36px) saturate(1.9);
  border: 1px solid var(--bt-border-hi);
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow:
    -6px 0 40px rgba(0,0,0,0.5),
    0 24px 70px rgba(0,0,0,0.7);
  position: relative;
}

#bt-panel-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, var(--bt-accent), #ea580c, transparent 80%);
  border-radius: var(--bt-radius) var(--bt-radius) 0 0;
  transition: background 0.3s;
}
#bt-panel-card.demo::before {
  background: linear-gradient(90deg, var(--bt-blue), #1d4ed8, transparent 80%);
}

#bt-panel-card::after {
  content: '';
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at top right, rgba(249,115,22,0.04), transparent 60%);
  pointer-events: none; transition: background 0.3s;
}
#bt-panel-card.demo::after {
  background: radial-gradient(ellipse at top right, rgba(59,130,246,0.05), transparent 60%);
}

#bt-ph {
  padding: 16px 15px 13px;
  border-bottom: 1px solid var(--bt-border);
  flex-shrink: 0; position: relative; z-index: 1;
  display: flex; align-items: flex-start; justify-content: space-between;
}
#bt-ph-left { display: flex; align-items: center; gap: 12px; }

#bt-avatar {
  width: 58px; height: 58px; border-radius: 50%;
  background: rgba(249,115,22,0.1);
  border: 2.5px solid rgba(249,115,22,0.3);
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; flex-shrink: 0; position: relative;
  box-shadow: 0 0 22px rgba(249,115,22,0.13);
  transition: background 0.3s, border-color 0.3s, box-shadow 0.3s;
}
#bt-avatar.demo {
  background: rgba(59,130,246,0.1);
  border-color: rgba(59,130,246,0.3);
  box-shadow: 0 0 22px rgba(59,130,246,0.18);
}
#bt-avatar-dot {
  position: absolute; bottom: 2px; right: 2px;
  width: 13px; height: 13px; border-radius: 50%;
  background: var(--bt-green); border: 2.5px solid #090e1a;
  box-shadow: 0 0 8px var(--bt-green);
  animation: bt-pulse-green 2s ease-in-out infinite;
  transition: background 0.3s;
}
#bt-avatar-dot.stopped {
  background: var(--bt-red);
  box-shadow: 0 0 6px var(--bt-red);
  animation: none;
}

#bt-ph-name {
  font-family: 'Syne', sans-serif; font-weight: 800;
  font-size: 15px; color: var(--bt-text); letter-spacing: -0.2px;
}
#bt-ph-badges { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.bt-ph-badge {
  font-size: 9px; font-weight: 700; letter-spacing: 0.6px;
  text-transform: uppercase; padding: 2px 8px; border-radius: 6px;
}
.bt-ph-badge.type-real  { background: rgba(249,115,22,0.12); border: 1px solid rgba(249,115,22,0.25); color: var(--bt-accent); }
.bt-ph-badge.type-demo  { background: rgba(59,130,246,0.12);  border: 1px solid rgba(59,130,246,0.25);  color: var(--bt-blue2); }
.bt-ph-badge.running    { background: rgba(34,197,94,0.1);   border: 1px solid rgba(34,197,94,0.24);   color: #86efac; }
.bt-ph-badge.stopped    { background: rgba(239,68,68,0.08);  border: 1px solid rgba(239,68,68,0.2);    color: #fca5a5; }

#bt-panel-close {
  width: 30px; height: 30px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--bt-border-hi);
  border-radius: 8px; display: grid; place-items: center;
  cursor: pointer; color: var(--bt-faint); font-size: 13px; flex-shrink: 0;
  transition: all 0.15s;
}
#bt-panel-close:hover {
  background: rgba(239,68,68,0.1);
  border-color: rgba(239,68,68,0.3); color: #f87171;
}

#bt-pb {
  flex: 1; overflow-y: auto; padding: 14px 15px;
  position: relative; z-index: 1;
  scrollbar-width: thin; scrollbar-color: var(--bt-border-hi) transparent;
}
#bt-pb::-webkit-scrollbar { width: 3px; }
#bt-pb::-webkit-scrollbar-thumb { background: var(--bt-border-hi); border-radius: 2px; }

.bt-stat-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 7px; margin-bottom: 7px;
}
.bt-stat {
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--bt-border);
  border-radius: 11px; padding: 10px 12px;
  transition: background 0.14s;
}
.bt-stat:hover { background: rgba(255,255,255,0.05); }
.bt-stat-lbl {
  font-size: 9px; color: var(--bt-faint);
  text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 5px;
}
.bt-stat-val {
  font-family: 'Syne', sans-serif; font-weight: 700;
  font-size: 15px; color: var(--bt-text); line-height: 1;
  transition: color 0.2s;
}
.bt-stat-val.accent { color: var(--bt-accent); }
.bt-stat-val.green  { color: var(--bt-green); }
.bt-stat-val.red    { color: #f87171; }
.bt-stat-val.blue   { color: var(--bt-blue2); }
.bt-stat-sub        { font-size: 9px; color: var(--bt-faint); margin-top: 3px; }

.bt-coords {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 7px; margin-bottom: 7px;
}
.bt-coord {
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--bt-border);
  border-radius: 9px; padding: 8px 10px;
}
.bt-coord-lbl { font-size: 9px; color: var(--bt-faint); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }
.bt-coord-val { font-family: 'Courier New', monospace; font-size: 11.5px; color: var(--bt-muted); letter-spacing: 0.2px; }

.bt-micro {
  font-size: 9px; color: var(--bt-faint);
  text-transform: uppercase; letter-spacing: 0.7px;
  margin: 10px 0 6px; display: block;
}

.bt-prog-track {
  height: 6px; background: rgba(255,255,255,0.06);
  border-radius: 3px; overflow: hidden; margin-bottom: 6px;
}
.bt-prog-fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--bt-accent), var(--bt-green));
  box-shadow: 0 0 9px rgba(249,115,22,0.3);
  transition: width 1.5s cubic-bezier(0.25,1,0.5,1);
}
.bt-prog-meta {
  display: flex; justify-content: space-between;
  font-size: 10px; color: var(--bt-faint);
}
.bt-prog-meta span { color: var(--bt-muted); }

.bt-engine {
  margin: 10px 0 7px; padding: 9px 12px;
  border-radius: 10px; font-size: 11px;
  display: flex; align-items: center; gap: 8px;
  transition: background 0.3s, border-color 0.3s, color 0.3s;
}
.bt-engine.running {
  background: rgba(34,197,94,0.07);
  border: 1px solid rgba(34,197,94,0.15); color: #86efac;
}
.bt-engine.idle {
  background: rgba(239,68,68,0.06);
  border: 1px solid rgba(239,68,68,0.14); color: #fca5a5;
}
.bt-engine-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  transition: background 0.3s;
}
.bt-engine.running .bt-engine-dot {
  background: var(--bt-green); box-shadow: 0 0 6px var(--bt-green);
  animation: bt-pulse-green 1.8s ease-in-out infinite;
}
.bt-engine.idle .bt-engine-dot {
  background: var(--bt-red); opacity: 0.7;
}

.bt-updated {
  text-align: center; font-size: 10px; color: var(--bt-faint); margin-bottom: 8px;
}
.bt-updated b { color: var(--bt-muted); }

.bt-focus-btn {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  width: 100%; padding: 11px;
  background: rgba(249,115,22,0.09);
  border: 1px solid rgba(249,115,22,0.22);
  border-radius: 11px; cursor: pointer;
  font-family: 'Syne', sans-serif; font-weight: 700; font-size: 12px;
  color: var(--bt-accent); letter-spacing: 0.3px;
  transition: all 0.18s;
}
.bt-focus-btn:hover {
  background: rgba(249,115,22,0.17);
  border-color: rgba(249,115,22,0.44);
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(249,115,22,0.18);
}
.bt-focus-btn:active { transform: translateY(0) scale(0.98); }
.bt-focus-btn.demo {
  background: rgba(59,130,246,0.09);
  border-color: rgba(59,130,246,0.22); color: var(--bt-blue2);
}
.bt-focus-btn.demo:hover {
  background: rgba(59,130,246,0.17); border-color: rgba(59,130,246,0.44);
  box-shadow: 0 6px 20px rgba(59,130,246,0.18);
}

/* ═══════════════════════════════════════════════════════════
   CLICK-OUTSIDE OVERLAY
═══════════════════════════════════════════════════════════ */
#bt-overlay {
  position: absolute; inset: 0; z-index: 1070;
  display: none; cursor: default;
}
#bt-overlay.vis { display: block; }

/* ═══════════════════════════════════════════════════════════
   SIDEBAR-OWN TOAST
═══════════════════════════════════════════════════════════ */
#bt-toast {
  position: absolute; bottom: 18px; left: 50%;
  transform: translateX(-50%) translateY(8px); z-index: 2000;
  background: rgba(16,23,42,0.97); backdrop-filter: blur(16px);
  border: 1px solid var(--bt-border-hi); border-radius: 12px;
  padding: 8px 16px; font-size: 11px; color: var(--bt-muted);
  white-space: nowrap; pointer-events: none;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  opacity: 0; transition: opacity 0.25s, transform 0.25s;
}
#bt-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

/* ═══════════════════════════════════════════════════════════
   RESPONSIVE — MOBILE
═══════════════════════════════════════════════════════════ */
@media (max-width: 640px) {
  :root {
    --bt-drawer-w: calc(100vw - 28px);
    --bt-panel-w:  100vw;
  }

  #bt-bus-dock {
    top: auto; right: auto; bottom: 14px;
    left: 50%; transform: translateX(-50%);
    flex-direction: row; gap: 10px;
  }
  .bt-bus-icon:hover  { transform: translateY(-4px) scale(1.07); }
  .bt-bus-icon.active { transform: translateY(-6px) scale(1.1); }

  #bt-panel {
    top: auto; right: 0 !important; left: 0;
    bottom: -80vh; height: 75vh;
    transition: bottom 0.38s cubic-bezier(0.4,0,0.2,1), opacity 0.3s;
  }
  #bt-panel.open { bottom: 0; right: 0; opacity: 1; }
  #bt-panel-card { border-radius: 20px 20px 0 0; }

  #bt-toggle.open { left: 14px; }

  #bt-drawer {
    top: auto; bottom: -85vh; height: 80vh;
    transform: translateY(100%);
    border-radius: 20px 20px 0 0;
    transition: transform 0.34s cubic-bezier(0.4,0,0.2,1), opacity 0.28s;
  }
  #bt-drawer.open {
    transform: translateY(0); bottom: 0;
  }
}

  `;
  document.head.appendChild(css);


  /* ═══════════════════════════════════════════════════════════
     DOM CONSTRUCTION
  ═══════════════════════════════════════════════════════════ */

  const toggle = document.createElement('div');
  toggle.id = 'bt-toggle';
  toggle.title = 'Toggle sidebar';
  toggle.setAttribute('role', 'button');
  toggle.setAttribute('aria-label', 'Toggle search sidebar');
  toggle.innerHTML = `
    <span class="bt-bar"></span>
    <span class="bt-bar"></span>
    <span class="bt-bar"></span>
  `;

  const drawer = document.createElement('div');
  drawer.id = 'bt-drawer';
  drawer.innerHTML = `
    <div id="bt-drawer-inner">

      <div class="bt-label">Search Places</div>
      <div class="bt-field-wrap">
        <span class="bt-field-icon">🔍</span>
        <input id="bt-search" type="text" placeholder="Search a place…"
               autocomplete="off" spellcheck="false" />
        <button class="bt-field-clear" id="bt-search-clear" title="Clear">✕</button>
      </div>
      <div id="bt-ac"></div>

      <div id="bt-loc-btn">
        <span id="bt-loc-icon">📍</span>
        <span id="bt-loc-label">My Location</span>
      </div>

      <div class="bt-rule"></div>

      <div class="bt-label">Directions</div>
      <div id="bt-dir-block">
        <div class="bt-dir-fields">
          <div class="bt-field-wrap">
            <span class="bt-field-icon">🟢</span>
            <input id="bt-from" type="text" placeholder="From…" autocomplete="off" />
          </div>
          <div class="bt-swap-row">
            <button id="bt-swap" title="Swap">↕</button>
          </div>
          <div class="bt-field-wrap">
            <span class="bt-field-icon">🏁</span>
            <input id="bt-to" type="text" placeholder="To…" autocomplete="off" />
          </div>
        </div>
        <button id="bt-route-btn">Get Route →</button>
        <div id="bt-eta-display"></div>
      </div>

      <div class="bt-rule"></div>

      <div id="bt-scroll">
        <div class="bt-label">Saved Places</div>
        <div class="bt-list" id="bt-saved-list"></div>

        <div class="bt-rule"></div>

        <div class="bt-label">Recent Searches</div>
        <div class="bt-list" id="bt-recents-list"></div>
      </div>

    </div>
  `;

  const dock = document.createElement('div');
  dock.id = 'bt-bus-dock';

  const panel = document.createElement('div');
  panel.id = 'bt-panel';
  panel.innerHTML = `
    <div id="bt-panel-card">

      <div id="bt-ph">
        <div id="bt-ph-left">
          <div id="bt-avatar">
            <span>🚌</span>
            <div id="bt-avatar-dot"></div>
          </div>
          <div id="bt-ph-info">
            <div id="bt-ph-name">—</div>
            <div id="bt-ph-badges">
              <span class="bt-ph-badge type-real"  id="bt-badge-type">Real</span>
              <span class="bt-ph-badge running"     id="bt-badge-status">Running</span>
            </div>
          </div>
        </div>
        <div id="bt-panel-close" title="Close">✕</div>
      </div>

      <div id="bt-pb">

        <div class="bt-stat-grid">
          <div class="bt-stat">
            <div class="bt-stat-lbl">Speed</div>
            <div class="bt-stat-val accent" id="bp-speed">—</div>
            <div class="bt-stat-sub">Current</div>
          </div>
          <div class="bt-stat">
            <div class="bt-stat-lbl">ETA</div>
            <div class="bt-stat-val accent" id="bp-eta">—</div>
            <div class="bt-stat-sub">To destination</div>
          </div>
        </div>

        <div class="bt-stat-grid">
          <div class="bt-stat">
            <div class="bt-stat-lbl">Remaining</div>
            <div class="bt-stat-val green" id="bp-remaining">—</div>
            <div class="bt-stat-sub">Distance</div>
          </div>
          <div class="bt-stat">
            <div class="bt-stat-lbl">Progress</div>
            <div class="bt-stat-val green" id="bp-pct">—</div>
            <div class="bt-stat-sub">Route done</div>
          </div>
        </div>

        <span class="bt-micro">Coordinates</span>
        <div class="bt-coords">
          <div class="bt-coord">
            <div class="bt-coord-lbl">Latitude</div>
            <div class="bt-coord-val" id="bp-lat">—</div>
          </div>
          <div class="bt-coord">
            <div class="bt-coord-lbl">Longitude</div>
            <div class="bt-coord-val" id="bp-lon">—</div>
          </div>
        </div>

        <span class="bt-micro">Route Progress</span>
        <div class="bt-prog-track">
          <div class="bt-prog-fill" id="bp-bar" style="width:0%"></div>
        </div>
        <div class="bt-prog-meta">
          <span id="bp-from-lbl">Origin</span>
          <span id="bp-pct-lbl">0%</span>
          <span id="bp-to-lbl">Destination</span>
        </div>

        <div class="bt-engine running" id="bp-engine">
          <div class="bt-engine-dot"></div>
          <span id="bp-engine-txt">Engine Running</span>
        </div>

        <div class="bt-updated">Last updated: <b id="bp-updated">—</b></div>

        <button class="bt-focus-btn" id="bp-focus">⊕ Focus on Map</button>

      </div>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.id = 'bt-overlay';

  const toast = document.createElement('div');
  toast.id = 'bt-toast';

  document.body.appendChild(toggle);
  document.body.appendChild(drawer);
  document.body.appendChild(dock);
  document.body.appendChild(overlay);
  document.body.appendChild(panel);
  document.body.appendChild(toast);


  /* ═══════════════════════════════════════════════════════════
     TOAST HELPER
  ═══════════════════════════════════════════════════════════ */
  let toastTimer;
  function showToast(msg, ms = 3000) {
    const main = document.getElementById('toast');
    if (main) {
      main.textContent = msg;
      main.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => main.classList.remove('show'), ms);
    } else {
      clearTimeout(toastTimer);
      toast.textContent = msg;
      toast.classList.add('show');
      toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     SAVED PLACES
  ═══════════════════════════════════════════════════════════ */
  const SAVED = [
    { name: 'Home',   icon: '🏠', lat: 11.0168, lon: 76.9558, sub: 'Coimbatore, TN'  },
    { name: 'Office', icon: '🏢', lat: 11.1271, lon: 78.6569, sub: 'Salem, TN'        },
    { name: 'Depot',  icon: '🚌', lat: 10.9020, lon: 76.8958, sub: 'Tiruppur, TN'    },
  ];


  /* ═══════════════════════════════════════════════════════════
     RECENTS PERSISTENCE
  ═══════════════════════════════════════════════════════════ */
  function saveRecents() { localStorage.setItem('bt_recents', JSON.stringify(recents)); }

  function addRecent(name, lat, lon) {
    recents = recents.filter(r => r.name !== name);
    recents.unshift({ name, lat, lon, ts: Date.now() });
    recents = recents.slice(0, MAX_RECENTS);
    saveRecents();
    renderRecents();
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }


  /* ═══════════════════════════════════════════════════════════
     MAP PAN HELPER
  ═══════════════════════════════════════════════════════════ */
  function panMap(lat, lon, name) {
    if (typeof map !== 'undefined' && map && map.setView) {
      map.setView([lat, lon], 13, { animate: true, duration: 0.8 });
      showToast(`📍 Moved to ${name}`);
    } else {
      showToast('⚠ Map not ready yet');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     RENDER: SAVED PLACES
  ═══════════════════════════════════════════════════════════ */
  function renderSaved() {
    const list = document.getElementById('bt-saved-list');
    if (!list) return;
    list.innerHTML = '';
    SAVED.forEach(s => {
      const el = document.createElement('div');
      el.className = 'bt-item';
      el.innerHTML = `
        <div class="bt-item-icon saved">${s.icon}</div>
        <div class="bt-item-text">
          <div class="bt-item-name">${s.name}</div>
          <div class="bt-item-sub">${s.sub}</div>
        </div>
        <span class="bt-item-arrow">›</span>`;
      el.addEventListener('click', () => { panMap(s.lat, s.lon, s.name); addRecent(s.name, s.lat, s.lon); });
      list.appendChild(el);
    });
  }


  /* ═══════════════════════════════════════════════════════════
     RENDER: RECENT SEARCHES
  ═══════════════════════════════════════════════════════════ */
  function renderRecents() {
    const list = document.getElementById('bt-recents-list');
    if (!list) return;
    list.innerHTML = '';
    if (!recents.length) {
      list.innerHTML = '<div class="bt-empty">No recent searches yet</div>';
      return;
    }
    recents.forEach(r => {
      const el = document.createElement('div');
      el.className = 'bt-item';
      el.innerHTML = `
        <div class="bt-item-icon recent">🕐</div>
        <div class="bt-item-text">
          <div class="bt-item-name">${r.name}</div>
          <div class="bt-item-sub">${timeAgo(r.ts)}</div>
        </div>
        <span class="bt-item-arrow">›</span>`;
      el.addEventListener('click', () => panMap(r.lat, r.lon, r.name));
      list.appendChild(el);
    });
  }


  /* ═══════════════════════════════════════════════════════════
     PLACE SEARCH  (Nominatim autocomplete)
  ═══════════════════════════════════════════════════════════ */
  const searchInput = document.getElementById('bt-search');
  const clearBtn    = document.getElementById('bt-search-clear');
  const acBox       = document.getElementById('bt-ac');

  function showAC(html) { acBox.innerHTML = html; acBox.classList.add('vis'); }
  function hideAC()     { acBox.classList.remove('vis'); setTimeout(() => { acBox.innerHTML = ''; }, 260); }

  async function doSearch(q) {
    if (!q.trim()) { hideAC(); return; }
    showAC('<div class="bt-ac-msg">Searching…</div>');
    try {
      const url  = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`;
      const data = await (await fetch(url, { headers: { 'Accept-Language': 'en' } })).json();
      if (!data.length) { showAC('<div class="bt-ac-msg">No results found</div>'); return; }

      acBox.innerHTML = data.map(item => {
        const name = item.display_name.split(',')[0];
        const sub  = item.display_name.split(',').slice(1,3).join(',').trim();
        return `<div class="bt-ac-item" data-lat="${item.lat}" data-lon="${item.lon}" data-name="${name}">
          <span class="bt-ac-icon">📍</span>
          <div class="bt-ac-text">
            <div class="bt-ac-name">${name}</div>
            <div class="bt-ac-sub">${sub}</div>
          </div>
        </div>`;
      }).join('');
      acBox.classList.add('vis');

      acBox.querySelectorAll('.bt-ac-item').forEach(el => {
        el.addEventListener('click', () => {
          const lat = parseFloat(el.dataset.lat);
          const lon = parseFloat(el.dataset.lon);
          const nm  = el.dataset.name;
          panMap(lat, lon, nm);
          addRecent(nm, lat, lon);
          searchInput.value = nm;
          clearBtn.classList.add('vis');
          hideAC();
        });
      });
    } catch {
      showAC('<div class="bt-ac-msg">⚠ Search failed</div>');
    }
  }

  searchInput.addEventListener('input', e => {
    clearBtn.classList.toggle('vis', e.target.value.length > 0);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => doSearch(e.target.value), 420);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideAC(); searchInput.blur(); }
    if (e.key === 'Enter')  { clearTimeout(searchDebounce); doSearch(searchInput.value); }
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = ''; clearBtn.classList.remove('vis'); hideAC(); searchInput.focus();
  });
  document.addEventListener('click', e => { if (!drawer.contains(e.target)) hideAC(); });


  /* ═══════════════════════════════════════════════════════════
     MY LOCATION
  ═══════════════════════════════════════════════════════════ */
  document.getElementById('bt-loc-btn').addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('⚠ Geolocation not supported'); return; }
    showToast('📡 Fetching location…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        panMap(lat, lon, 'My Location');
        if (typeof map !== 'undefined' && map) {
          const icon = L.divIcon({
            html: `<div style="width:18px;height:18px;background:#3b82f6;border-radius:50%;border:3px solid white;box-shadow:0 0 0 6px rgba(59,130,246,0.22),0 4px 12px rgba(0,0,0,0.5);"></div>`,
            className: '', iconSize: [18,18], iconAnchor: [9,9]
          });
          const m = L.marker([lat,lon], { icon, zIndexOffset: 2000 })
            .addTo(map).bindPopup('<b>📍 Your Location</b>').openPopup();
          setTimeout(() => m.remove(), 15000);
        }
        addRecent('My Location', lat, lon);
      },
      err => {
        const m = { 1:'Permission denied', 2:'Position unavailable', 3:'Request timed out' };
        showToast('⚠ ' + (m[err.code] || 'Could not get location'));
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });


  /* ═══════════════════════════════════════════════════════════
     FULL ROUTE LAYER CLEAR
     Wipes ALL sidebar-owned route artefacts:
       • route polylines (routeLayer)
       • bus stop markers (busStopLayer)
       • From / To endpoint markers (markerLayer)
       • Any open map popups
     Vehicle markers live in a completely separate vehicleLayer
     and are NEVER touched here.
  ═══════════════════════════════════════════════════════════ */
  function clearAllRouteArtifacts() {
    /* Wait until layer groups are ready */
    if (!routeLayer || !busStopLayer || !markerLayer) return;

    routeLayer.clearLayers();
    busStopLayer.clearLayers();
    markerLayer.clearLayers();

    /* Also clear the map.html route layers if they exist as globals */
    if (typeof window._mapRoutePolylines !== 'undefined') {
      window._mapRoutePolylines.forEach(pl => { try { pl.remove(); } catch(e){} });
      window._mapRoutePolylines = [];
    }

    /* Reset sidebar stop refs */
    sidebarStopMarkerRefs = {};
    sidebarBusStops       = [];

    /* Close any lingering popups opened by route markers */
    if (typeof map !== 'undefined' && map && map.closePopup) {
      map.closePopup();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     HAVERSINE  (used for intermediate stop generation)
  ═══════════════════════════════════════════════════════════ */
  function haversineSb(a, b) {
    const R = 6371;
    const dLat = (b[0]-a[0]) * Math.PI/180;
    const dLon = (b[1]-a[1]) * Math.PI/180;
    const s = Math.sin(dLat/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
  }

  function calcTotalKm(coords) {
    let km = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      km += haversineSb(coords[i], coords[i+1]);
    }
    return km;
  }

  /* ═══════════════════════════════════════════════════════════
     ENDPOINT ICON HELPER
     Mirrors makeEndpointIcon from map.html exactly.
  ═══════════════════════════════════════════════════════════ */
  function _endpointIcon(color, emoji) {
    if (typeof makeEndpointIcon === 'function') {
      return makeEndpointIcon(color, emoji);
    }
    return L.divIcon({
      html: `<div style="background:${color};border-radius:50%;width:36px;height:36px;
               display:flex;align-items:center;justify-content:center;font-size:16px;
               box-shadow:0 0 0 5px ${color}28,0 0 0 2px white,0 6px 18px rgba(0,0,0,0.5);
               border:2px solid rgba(255,255,255,0.85);">${emoji}</div>`,
      className:   '',
      iconSize:    [36, 36],
      iconAnchor:  [18, 18],
      popupAnchor: [0, -20]
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BUS STOP ICON HELPER
     Mirrors makeStopIcon from map.html exactly.
  ═══════════════════════════════════════════════════════════ */
  function _stopIcon() {
    if (typeof makeStopIcon === 'function') return makeStopIcon();
    return L.divIcon({
      html: `<div style="background:rgba(59,130,246,0.85);border-radius:50%;width:11px;height:11px;
               border:2px solid rgba(255,255,255,0.8);
               box-shadow:0 0 0 3px rgba(59,130,246,0.18),0 2px 8px rgba(0,0,0,0.4);"></div>`,
      className: '', iconSize: [11,11], iconAnchor: [5,5], popupAnchor: [0,-8]
    });
  }

  /* ═══════════════════════════════════════════════════════════
     INTERMEDIATE BUS STOP GENERATION + PLACEMENT
     Generates 6 evenly spaced stops along the route coords
     and places them into busStopLayer.
  ═══════════════════════════════════════════════════════════ */
  function generateAndPlaceStops(coords, totalKm, fName, tName) {
    busStopLayer.clearLayers();
    sidebarBusStops       = [];
    sidebarStopMarkerRefs = {};

    const count  = 6;
    const margin = Math.floor(coords.length * 0.05);
    const usable = coords.length - margin * 2;
    const step   = Math.floor(usable / (count + 1));

    for (let i = 1; i <= count; i++) {
      const idx = margin + i * step;
      if (idx >= coords.length) continue;

      const [lat, lon] = coords[idx];
      const distFromStart = calcTotalKm(coords.slice(0, idx));
      const progressPct   = Math.round((idx / (coords.length - 1)) * 100);
      const stopName      = `Route Stop ${i}`;

      sidebarBusStops.push({ lat, lon, name: stopName, idx });

      const popupHtml = `
        <div style="font-family:'DM Sans',sans-serif;padding:12px 14px;min-width:180px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <div style="width:28px;height:28px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.28);
              border-radius:8px;display:grid;place-items:center;font-size:13px;flex-shrink:0;">🚏</div>
            <div>
              <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:13px;color:#f1f5f9;line-height:1.2;">${stopName}</div>
              <div style="font-size:10px;color:#4b5768;margin-top:2px;">Bus Stop · Stop ${i}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;margin-bottom:4px;">
            📍 Route progress at stop: <span style="color:#93c5fd;font-weight:500;">${progressPct}%</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;">
            📏 From start: <span style="color:#93c5fd;font-weight:500;">${distFromStart.toFixed(1)} km</span>
          </div>
        </div>`;

      const marker = L.marker([lat, lon], { icon: _stopIcon(), zIndexOffset: 200 })
        .bindPopup(popupHtml, { maxWidth: 240 });
      marker.addTo(busStopLayer);
      sidebarStopMarkerRefs[`stop_${i}`] = marker;
    }

    /* Reverse geocode stop names async (non-blocking, best-effort) */
    enrichStopNames(coords);
  }

  /* Async reverse geocode for stop names */
  async function enrichStopNames(coords) {
    for (let i = 0; i < sidebarBusStops.length; i++) {
      const stop = sidebarBusStops[i];
      try {
        const url    = `https://nominatim.openstreetmap.org/reverse?lat=${stop.lat}&lon=${stop.lon}&format=json&zoom=16&addressdetails=1`;
        const ctrl   = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 4000);
        const res    = await fetch(url, { headers: { 'Accept-Language': 'en' }, signal: ctrl.signal });
        clearTimeout(timeout);
        const d = await res.json();
        const a = d.address || {};
        const name = a.road || a.suburb || a.village || a.town || a.city_district || a.county || null;
        if (name) {
          stop.name = name;
          const key    = `stop_${i+1}`;
          const marker = sidebarStopMarkerRefs[key];
          if (marker) {
            const distFromStart = calcTotalKm(coords.slice(0, stop.idx));
            const progressPct   = sidebarRouteCoords.length
              ? Math.round((stop.idx / (sidebarRouteCoords.length - 1)) * 100) : 0;
            const updatedPopup = `
              <div style="font-family:'DM Sans',sans-serif;padding:12px 14px;min-width:180px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                  <div style="width:28px;height:28px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.28);
                    border-radius:8px;display:grid;place-items:center;font-size:13px;flex-shrink:0;">🚏</div>
                  <div>
                    <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:13px;color:#f1f5f9;line-height:1.2;">${name}</div>
                    <div style="font-size:10px;color:#4b5768;margin-top:2px;">Bus Stop · Stop ${i+1}</div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;margin-bottom:4px;">
                  📍 Route progress at stop: <span style="color:#93c5fd;font-weight:500;">${progressPct}%</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;">
                  📏 From start: <span style="color:#93c5fd;font-weight:500;">${distFromStart.toFixed(1)} km</span>
                </div>
              </div>`;
            marker.setPopupContent(updatedPopup);
          }
        }
      } catch (e) { /* ignore */ }
      if (i < sidebarBusStops.length - 1) await new Promise(r => setTimeout(r, 1100));
    }
  }

  /* ═══════════════════════════════════════════════════════════
     UPDATE GLOBAL ROUTE STATE
     After a sidebar route is drawn, update the globals that
     map.html uses for bus progress calculations so that live
     buses are computed against the new route.

     ── DEMO BUS FIX ──────────────────────────────────────────
     window.respawnDemoBuses is now called with the new coords
     array as a direct argument. map.html's updated implementation
     receives coords, syncs its closure-scoped `routeCoords`
     variable, and THEN respawns the demo buses — so they always
     start on the correct route instead of the original one.

     The previous code called respawnDemoBuses() with no arguments,
     meaning map.html's internal routeCoords was never updated and
     demo buses kept using the original coordinates.
  ═══════════════════════════════════════════════════════════ */
  function syncGlobalRouteState(coords, totalKm, fName, tName, fCoord, tCoord) {
    /* Update map.html globals safely */
    if (typeof window !== 'undefined') {
      try { window.routeCoords   = coords;   } catch(e){}
      try { window.routeTotalKm  = totalKm;  } catch(e){}
      try { window.fromName      = fName;    } catch(e){}
      try { window.toName        = tName;    } catch(e){}
      try { window.fromCoord     = fCoord;   } catch(e){}
      try { window.toCoord       = tCoord;   } catch(e){}
      try { window.busRemainingKm = {};       } catch(e){}
    }

    /* Update topbar route labels if they exist */
    const fromNameEl = document.getElementById('from-name');
    const toNameEl   = document.getElementById('to-name');
    const fromDistEl = document.getElementById('from-dist');
    const toDistEl   = document.getElementById('to-dist');
    if (fromNameEl) fromNameEl.textContent = fName;
    if (toNameEl)   toNameEl.textContent   = tName;
    if (fromDistEl) fromDistEl.textContent = totalKm.toFixed(1) + ' km total';
    if (toDistEl)   toDistEl.textContent   = totalKm.toFixed(1) + ' km remaining';

    /* Regenerate bus stops for the new route in map.html's stop arrays */
    if (typeof window.busStops !== 'undefined') {
      try { window.busStops = []; } catch(e){}
    }

    /* ── DEMO BUS FIX ──────────────────────────────────────────────
       Pass the new coords array directly into respawnDemoBuses so
       map.html can synchronise its closure-scoped `routeCoords`
       variable before spawning.  Without this argument the function
       would still read the OLD routeCoords binding and demo buses
       would never move to the new route.
    ─────────────────────────────────────────────────────────────── */
    if (typeof window.respawnDemoBuses === 'function') {
      try {
        window.respawnDemoBuses(coords);   // <── FIX: coords passed as argument
      } catch(e) {
        console.warn('[sidebar.js] respawnDemoBuses error:', e);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     DIRECTIONS  — the main route draw function
     1. Clears ALL previous route artefacts (polylines, stops,
        endpoint markers) — never touches vehicle markers.
     2. Geocodes both endpoints.
     3. Fetches OSRM route.
     4. Draws glow + sharp polylines into routeLayer.
     5. Places From / To markers into markerLayer.
     6. Generates bus stop markers into busStopLayer.
     7. Updates global route state so live buses track the
        new route.
     8. Fits map to new route.
  ═══════════════════════════════════════════════════════════ */
  async function getDirectionsRoute() {
    const fromVal = document.getElementById('bt-from').value.trim();
    const toVal   = document.getElementById('bt-to').value.trim();
    const etaEl   = document.getElementById('bt-eta-display');

    if (!fromVal || !toVal) { showToast('⚠ Enter From and To locations'); return; }

    etaEl.textContent = 'Calculating…'; etaEl.className = '';
    showToast('🗺 Finding route…');

    try {
      /* ── 1. Geocode ── */
      const [fData, tData] = await Promise.all([
        fetch(`${NOMINATIM}?q=${encodeURIComponent(fromVal)}&format=json&limit=1`).then(r => r.json()),
        fetch(`${NOMINATIM}?q=${encodeURIComponent(toVal)}&format=json&limit=1`).then(r => r.json()),
      ]);

      if (!fData[0] || !tData[0]) {
        showToast('⚠ One or both locations not found');
        etaEl.textContent = '';
        return;
      }

      const fLat = parseFloat(fData[0].lat), fLon = parseFloat(fData[0].lon);
      const tLat = parseFloat(tData[0].lat), tLon = parseFloat(tData[0].lon);
      const fName = fData[0].display_name.split(',')[0];
      const tName = tData[0].display_name.split(',')[0];

      /* ── 2. Ensure LayerGroups are ready ── */
      if (!routeLayer || !busStopLayer || !markerLayer) {
        if (typeof map !== 'undefined' && map && map.addLayer) {
          routeLayer   = routeLayer   || L.layerGroup().addTo(map);
          busStopLayer = busStopLayer || L.layerGroup().addTo(map);
          markerLayer  = markerLayer  || L.layerGroup().addTo(map);
          vehicleLayer = vehicleLayer || L.layerGroup().addTo(map);
          window._btRouteLayer   = routeLayer;
          window._btBusStopLayer = busStopLayer;
          window._btMarkerLayer  = markerLayer;
          window._btVehicleLayer = vehicleLayer;
        } else {
          showToast('⚠ Map not ready yet');
          etaEl.textContent = '';
          return;
        }
      }

      /* ── 3. CLEAR ALL previous route artefacts ── */
      clearAllRouteArtifacts();

      /* Also clear map.html's own initial route layers.
         map.html adds polylines directly to map (not a named layer),
         so we remove any polylines that are NOT vehicle markers.
         We do this by iterating the map's layers and removing
         Polyline instances that were added by map.html init. */
      if (typeof map !== 'undefined' && map) {
        map.eachLayer(layer => {
          /* Keep tile layers, vehicle markers, and our own managed layers */
          if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
            /* Only remove if it's not in one of our managed LayerGroups */
            const inManaged = routeLayer.hasLayer(layer)
              || busStopLayer.hasLayer(layer)
              || markerLayer.hasLayer(layer)
              || (vehicleLayer && vehicleLayer.hasLayer(layer));
            if (!inManaged) {
              try { map.removeLayer(layer); } catch(e){}
            }
          }
          /* Remove old endpoint / stop markers added directly to map by map.html init */
          if (layer instanceof L.Marker) {
            const inVehicle = vehicleLayer && vehicleLayer.hasLayer(layer);
            const inManaged = routeLayer.hasLayer(layer)
              || busStopLayer.hasLayer(layer)
              || markerLayer.hasLayer(layer);
            /* Bus vehicle markers are tracked in busMarkers global */
            const isBusMarker = (typeof busMarkers !== 'undefined') &&
              Object.values(busMarkers).some(bm => bm.marker === layer);
            if (!inVehicle && !inManaged && !isBusMarker) {
              /* Only remove markers that look like route markers
                 (endpoint or stop icons — not the geolocation dot) */
              const iconHtml = layer.options && layer.options.icon && layer.options.icon.options && layer.options.icon.options.html;
              if (iconHtml && (iconHtml.includes('border-radius:50%') || iconHtml.includes('rgba(59,130,246'))) {
                try { map.removeLayer(layer); } catch(e){}
              }
            }
          }
        });
      }

      /* ── 4. Fetch OSRM route ── */
      const url   = `${OSRM}${fLon},${fLat};${tLon},${tLat}?overview=full&geometries=geojson`;
      const rData = await (await fetch(url)).json();

      if (rData.code !== 'Ok') throw new Error('OSRM route not found');

      const coords   = rData.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      const dist     = (rData.routes[0].distance / 1000);
      const mins     = Math.round(rData.routes[0].duration / 60);
      const distStr  = dist.toFixed(1);

      /* Store in module state */
      sidebarRouteCoords  = coords;
      sidebarRouteTotalKm = dist;
      sidebarFromName     = fName;
      sidebarToName       = tName;
      sidebarFromCoord    = [fLat, fLon];
      sidebarToCoord      = [tLat, tLon];

      /* ── 5. Draw polylines — identical style to map.html ── */
      L.polyline(coords, {
        color:        '#f9731633',
        weight:       16,
        opacity:      0.45,
        lineJoin:     'round',
        lineCap:      'round',
        smoothFactor: 1.5
      }).addTo(routeLayer);

      L.polyline(coords, {
        color:        '#f97316',
        weight:       4,
        opacity:      0.88,
        lineJoin:     'round',
        lineCap:      'round',
        smoothFactor: 1.5
      }).addTo(routeLayer);

      /* ── 6. Endpoint markers into markerLayer ── */
      L.marker([fLat, fLon], {
        icon: _endpointIcon('#22c55e', '🟢'),
        zIndexOffset: 900
      }).addTo(markerLayer).bindPopup(
        `<div style="font-family:'DM Sans',sans-serif;padding:12px 14px;min-width:180px;">
           <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:13px;color:#f1f5f9;margin-bottom:6px;">
             🟢 ${fName}
           </div>
           <div style="color:#64748b;font-size:11px;">Route Origin</div>
           <div style="color:#64748b;font-size:11px;margin-top:4px;">
             📏 Total: <b style="color:#22c55e">${distStr} km</b>
           </div>
         </div>`,
        { maxWidth: 240 }
      );

      L.marker([tLat, tLon], {
        icon: _endpointIcon('#f97316', '🏁'),
        zIndexOffset: 900
      }).addTo(markerLayer).bindPopup(
        `<div style="font-family:'DM Sans',sans-serif;padding:12px 14px;min-width:180px;">
           <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:13px;color:#f1f5f9;margin-bottom:6px;">
             🏁 ${tName}
           </div>
           <div style="color:#64748b;font-size:11px;">Destination</div>
           <div style="color:#64748b;font-size:11px;margin-top:4px;">
             ⏱ ETA: <b style="color:#f97316">~${mins} min</b>
           </div>
         </div>`,
        { maxWidth: 240 }
      );

      /* ── 7. Bus stop markers into busStopLayer ── */
      generateAndPlaceStops(coords, dist, fName, tName);

      /* ── 8. Sync global route state (updates bus ETA/progress calcs)
              and triggers demo bus respawn on new route.
              coords is passed directly so map.html updates its
              closure-scoped routeCoords variable. ── */
      syncGlobalRouteState(coords, dist, fName, tName, [fLat, fLon], [tLat, tLon]);

      /* ── 9. Fit map ── */
      map.fitBounds(
        L.latLngBounds(coords),
        { padding: [80, 80], animate: true }
      );

      /* ── 10. UI feedback ── */
      etaEl.textContent = `${distStr} km · ~${mins} min`;
      etaEl.className   = 'has-result';
      showToast(`Route: ${distStr} km · ~${mins} min`);

    } catch (e) {
      console.error('[sidebar.js] Directions error:', e);
      showToast('⚠ Route calculation failed');
      document.getElementById('bt-eta-display').textContent = '⚠ Failed';
    }
  }

  document.getElementById('bt-route-btn').addEventListener('click', getDirectionsRoute);

  document.getElementById('bt-swap').addEventListener('click', () => {
    const f = document.getElementById('bt-from');
    const t = document.getElementById('bt-to');
    [f.value, t.value] = [t.value, f.value];
  });

  ['bt-from','bt-to'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') getDirectionsRoute();
    });
  });


  /* ═══════════════════════════════════════════════════════════
     TOGGLE SIDEBAR DRAWER
  ═══════════════════════════════════════════════════════════ */
  toggle.addEventListener('click', () => {
    sidebarOpen = !sidebarOpen;
    drawer.classList.toggle('open', sidebarOpen);
    toggle.classList.toggle('open', sidebarOpen);
  });


  /* ═══════════════════════════════════════════════════════════
     BUS ICON DOCK  — create/update icons from global busData
  ═══════════════════════════════════════════════════════════ */
  function ensureDockIcon(busId) {
    const safeId = busId.replace(/[^a-zA-Z0-9-_]/g, '-');
    const btnId  = `bt-dicon-${safeId}`;
    if (document.getElementById(btnId)) return;

    const isDemo = DEMO_IDS.has(busId);
    const btn    = document.createElement('div');
    btn.id        = btnId;
    btn.className = 'bt-bus-icon' + (isDemo ? ' demo' : '');
    btn.innerHTML = `
      <div class="bt-bus-disc">
        <span class="bt-disc-emoji">🚌</span>
        <div class="bt-bus-dot" id="bt-dot-${safeId}"></div>
      </div>
      <div class="bt-bus-lbl">${busId.replace('BUS-','')}</div>
      <div class="bt-bus-chip ${isDemo ? 'demo' : 'real'}">${isDemo ? 'Demo' : 'Real'}</div>
    `;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (activePanelBus === busId) {
        closePanelUI();
      } else {
        openPanelUI(busId);
      }
    });

    if (isDemo) dock.appendChild(btn);
    else        dock.prepend(btn);
  }

  function updateDockDot(busId, moving) {
    const safeId = busId.replace(/[^a-zA-Z0-9-_]/g, '-');
    const dot = document.getElementById(`bt-dot-${safeId}`);
    if (!dot) return;
    dot.className = 'bt-bus-dot' + (moving ? '' : ' stopped');
  }

  function removeDockIcon(busId) {
    const safeId = busId.replace(/[^a-zA-Z0-9-_]/g, '-');
    const btn = document.getElementById(`bt-dicon-${safeId}`);
    if (btn) btn.remove();
  }


  /* ═══════════════════════════════════════════════════════════
     DETAILS PANEL  — open / populate / close
  ═══════════════════════════════════════════════════════════ */
  function openPanelUI(busId) {
    activePanelBus = busId;

    document.querySelectorAll('.bt-bus-icon').forEach(b => b.classList.remove('active'));
    const safeId = busId.replace(/[^a-zA-Z0-9-_]/g, '-');
    const btn = document.getElementById(`bt-dicon-${safeId}`);
    if (btn) btn.classList.add('active');

    populatePanelData(busId);

    panel.classList.add('open');
    overlay.classList.add('vis');

    clearInterval(panelRefreshInterval);
    panelRefreshInterval = setInterval(() => {
      if (activePanelBus) populatePanelData(activePanelBus);
    }, 1500);
  }

  function closePanelUI() {
    panel.classList.remove('open');
    overlay.classList.remove('vis');
    document.querySelectorAll('.bt-bus-icon').forEach(b => b.classList.remove('active'));
    activePanelBus = null;
    clearInterval(panelRefreshInterval);
  }

  function populatePanelData(busId) {
    const data = (typeof busData !== 'undefined') ? busData[busId] : null;
    if (!data) return;

    const isDemo  = DEMO_IDS.has(busId);
    const speed   = data.speed || 0;
    const moving  = speed >= 2;
    const pct     = Math.round((data.progress || 0) * 100);
    const eta     = data.eta;
    const rem     = data.remainingKm;

    const card = document.getElementById('bt-panel-card');
    card.className = isDemo ? 'demo' : '';

    const avatar = document.getElementById('bt-avatar');
    avatar.className = isDemo ? 'demo' : '';
    document.getElementById('bt-avatar-dot').className = moving ? '' : 'stopped';

    document.getElementById('bt-ph-name').textContent = busId.toUpperCase();

    const typeB = document.getElementById('bt-badge-type');
    typeB.textContent = isDemo ? 'Demo' : 'Real';
    typeB.className = 'bt-ph-badge ' + (isDemo ? 'type-demo' : 'type-real');

    const statB = document.getElementById('bt-badge-status');
    statB.textContent = moving ? 'Running' : 'Stopped';
    statB.className = 'bt-ph-badge ' + (moving ? 'running' : 'stopped');

    const speedEl = document.getElementById('bp-speed');
    speedEl.textContent = Math.round(speed) + ' km/h';
    speedEl.className = 'bt-stat-val ' + (moving ? 'accent' : 'red');

    const etaEl = document.getElementById('bp-eta');
    if (!moving) {
      etaEl.textContent = 'Bus Stopped';
      etaEl.className = 'bt-stat-val red';
    } else if (eta != null && !isNaN(eta)) {
      const mins = Math.floor(eta);
      const secs = Math.round((eta - mins) * 60);
      etaEl.textContent = `${mins}m ${secs}s`;
      etaEl.className = 'bt-stat-val accent';
    } else {
      etaEl.textContent = 'Calculating…';
      etaEl.className = 'bt-stat-val accent';
    }

    document.getElementById('bp-remaining').textContent =
      rem != null ? rem.toFixed(1) + ' km' : '—';
    document.getElementById('bp-pct').textContent = pct + '%';

    document.getElementById('bp-lat').textContent =
      data.lat != null ? data.lat.toFixed(6) : '—';
    document.getElementById('bp-lon').textContent =
      data.lon != null ? data.lon.toFixed(6) : '—';

    /* Use sidebar route names if a sidebar route is active, else fall back to URL params */
    const fLabel = sidebarFromName || new URLSearchParams(window.location.search).get('from') || 'Origin';
    const tLabel = sidebarToName   || new URLSearchParams(window.location.search).get('to')   || 'Destination';
    document.getElementById('bp-from-lbl').textContent = fLabel;
    document.getElementById('bp-to-lbl').textContent   = tLabel;

    document.getElementById('bp-bar').style.width    = pct + '%';
    document.getElementById('bp-pct-lbl').textContent = pct + '%';

    const engine = document.getElementById('bp-engine');
    const engTxt = document.getElementById('bp-engine-txt');
    engine.className = 'bt-engine ' + (moving ? 'running' : 'idle');
    engTxt.textContent = moving
      ? `Engine Running — ${Math.round(speed)} km/h`
      : 'Engine Idle — Bus Stopped';

    const lu = (typeof lastUpdateTime !== 'undefined') ? lastUpdateTime[busId] : null;
    document.getElementById('bp-updated').textContent =
      lu ? new Date(lu).toLocaleTimeString() : '—';

    const focusBtn = document.getElementById('bp-focus');
    focusBtn.className = 'bt-focus-btn' + (isDemo ? ' demo' : '');
  }

  document.getElementById('bt-panel-close').addEventListener('click', closePanelUI);
  overlay.addEventListener('click', closePanelUI);

  document.getElementById('bp-focus').addEventListener('click', () => {
    if (!activePanelBus) return;
    if (typeof busMarkers !== 'undefined' && busMarkers[activePanelBus]) {
      map.panTo(busMarkers[activePanelBus].marker.getLatLng(), { animate: true, duration: 0.7 });
      showToast(`📍 Focused on ${activePanelBus}`);
    }
  });


  /* ═══════════════════════════════════════════════════════════
     PERIODIC SYNC  — polls global busData every 1.5s
  ═══════════════════════════════════════════════════════════ */
  setInterval(() => {
    if (typeof busData === 'undefined') return;

    Object.keys(busData).forEach(id => {
      ensureDockIcon(id);
      const moving = (busData[id].speed || 0) >= 2;
      updateDockDot(id, moving);
    });

    document.querySelectorAll('.bt-bus-icon').forEach(btn => {
      const safeId = btn.id.replace('bt-dicon-', '');
      /* Recover original busId by checking busData keys */
      const origId = Object.keys(busData || {}).find(k => k.replace(/[^a-zA-Z0-9-_]/g, '-') === safeId);
      if (origId && DEMO_IDS.has(origId)) return;
      if (!origId || !busData[origId]) {
        removeDockIcon(origId || safeId);
        if (activePanelBus === origId) closePanelUI();
      }
    });
  }, 1500);


  /* ═══════════════════════════════════════════════════════════
     INITIAL RENDER
  ═══════════════════════════════════════════════════════════ */
  renderSaved();
  renderRecents();

  console.info('[sidebar.js] BusTrack premium sidebar initialised ✓');

})();
