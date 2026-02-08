(function () {
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');
  const topBar = document.getElementById('topBar');
  const topBarTitle = document.querySelector('#topBar .title');
  const firPanel = document.getElementById('firPanel');
  const firOverlay = document.getElementById('firOverlay');
  const firFab = document.getElementById('firFab');
  const firContent = firPanel?.querySelector('.drawer-content');
  const countRedEl = document.getElementById('countRed');
  const countYellowEl = document.getElementById('countYellow');
  const countGreenEl = document.getElementById('countGreen');

  const viewport = { scale: 1, offsetX: 0, offsetY: 0 };

  let firGeoJSON = null;
  let waypoints = [];
  let visibleWaypoints = [];
  let firOptions = [];
  let enabledFIRs = new Set();
  let currentTarget = null;
  let queuedNextTarget = null;
  let projection = null;
  let epwwBounds = null;
  let renderScheduled = false;
  let currentWrongCount = 0;
  let revealState = { active: false, visible: true, timerId: null };
  const waypointFeedback = new Map();
  let initializationError = null;
  let firPanelOpen = false;

  const MIN_SCALE = 1500;
  const MAX_SCALE = 25000;

  const STORAGE_KEY = 'enabledFIRs:v1';
  const QUIZ_STORAGE_PREFIX = 'waypointStats:v1:';

  const QUIZ_CONFIG = {
    tolerancePx: 18,
    wrongIntervalsMs: [20000, 40000, 60000],
    correctNoWrongMs: 15 * 60 * 1000,
    correctWithWrongMs: 5 * 60 * 1000,
    correctStreakMultiplier: 1.7,
    maxCorrectIntervalMs: 2 * 60 * 60 * 1000,
    revealFlashMs: 300,
  };

  const DEFAULT_VIEW_BOUNDS = {
    minLon: 14.156666,
    maxLon: 24.1,
    minLat: 49.0,
    maxLat: 55.85,
  };

  const DATA_ROOT = 'data';
  const WAYPOINTS_PATH = `${DATA_ROOT}/waypoints`;
  const WAYPOINT_INDEX_FILE = 'index.json';
  const WAYPOINT_INDEX_ERROR = 'Failed to load FIR manifest';

  const FIR_DISABLED_MESSAGE = 'Enable at least one FIR';
  const MANIFEST_EMPTY_MESSAGE = 'No FIR files listed in manifest';

  async function loadFIRMap() {
    const response = await fetch(`${DATA_ROOT}/FIRmap.json`);
    if (!response.ok) {
      throw new Error(`Failed to load FIR map: ${response.status}`);
    }
    return response.json();
  }

  async function fetchJSONFrom(paths) {
    const triedPaths = [];
    for (const path of paths) {
      try {
        triedPaths.push(path);
        const response = await fetch(path);
        if (response.ok) {
          return await response.json();
        }
      } catch (error) {
        console.warn(`Unable to fetch ${path}`, error);
      }
    }
    throw new Error(`Failed to load waypoints from: ${triedPaths.join(', ')}`);
  }

  async function loadWaypointIndex() {
    const response = await fetch(`${WAYPOINTS_PATH}/${WAYPOINT_INDEX_FILE}`);
    if (!response.ok) {
      throw new Error(WAYPOINT_INDEX_ERROR);
    }

    const entries = await response.json();
    const files = Array.isArray(entries)
      ? entries.map((item) => `${item}`.trim()).filter(Boolean)
      : [];

    if (!files.length) {
      throw new Error(MANIFEST_EMPTY_MESSAGE);
    }

    return files;
  }

  function firCodeFromFilename(filename) {
    const match = filename?.match(/([^/]+?)(?:\.[^.]+)?$/);
    return match ? match[1].toUpperCase() : 'FIR';
  }

  function buildWaypointPaths(filename) {
    const safeName = filename?.trim();
    if (!safeName) return [];

    const nameOnly = safeName.split('/').pop();
    const stem = nameOnly.replace(/\.geojson$/i, '');
    const paths = new Set();

    paths.add(`${WAYPOINTS_PATH}/${nameOnly}`);
    paths.add(`${WAYPOINTS_PATH}/${stem}.geojson`);
    paths.add(`${WAYPOINTS_PATH}/${stem}.geoJSON`);

    return [...paths];
  }

  async function loadWaypoints() {
    const allWaypoints = [];
    const waypointFiles = await loadWaypointIndex();

    for (const file of waypointFiles) {
      const firCode = firCodeFromFilename(file);
      const paths = buildWaypointPaths(file);
      const data = await fetchJSONFrom(paths);
      const features = data?.features ?? [];

      const parsed = features
        .map((feature, index) => {
          const [lon, lat] = feature?.geometry?.coordinates ?? [];
          return {
            id: feature?.id ?? `${firCode}-${index}`,
            name: feature?.properties?.name ?? 'Unknown',
            fir: feature?.properties?.fir ?? firCode,
            lon,
            lat,
          };
        })
        .filter((wp) => Number.isFinite(wp.lon) && Number.isFinite(wp.lat));

      allWaypoints.push(...parsed);
    }

    return allWaypoints;
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const parentRect = canvas.parentElement?.getBoundingClientRect();
    const width =
      rect.width || parentRect?.width || canvas.clientWidth || window.innerWidth || 1;
    const height =
      rect.height || parentRect?.height || canvas.clientHeight || window.innerHeight || 1;
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
    updateProjection();
    fitViewToEPWW();
    requestRender();
  }

  function uniqueFIRs(list) {
    return Array.from(new Set(list.map((item) => item.fir).filter(Boolean))).sort();
  }

  function restoreEnabledFIRs(allFIRs) {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      const valid = stored?.filter((fir) => allFIRs.includes(fir)) || [];
      if (valid.length) {
        const missing = allFIRs.filter((fir) => !valid.includes(fir));
        return new Set([...valid, ...missing]);
      }
    } catch (error) {
      console.warn('Failed to restore FIR preferences', error);
    }

    return new Set(allFIRs);
  }

  function defaultStats() {
    return {
      wrongStreak: 0,
      correctStreak: 0,
      dueAt: 0,
      lastShownAt: 0,
      seen: false,
      hasAnswered: false,
    };
  }

  function loadWaypointStats(id) {
    try {
      const raw = localStorage.getItem(`${QUIZ_STORAGE_PREFIX}${id}`);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn('Failed to load waypoint stats', error);
      return null;
    }
  }

  function persistWaypointStats(waypoint) {
    if (!waypoint?.id || !waypoint?.stats) return;
    try {
      localStorage.setItem(
        `${QUIZ_STORAGE_PREFIX}${waypoint.id}`,
        JSON.stringify(waypoint.stats)
      );
    } catch (error) {
      console.warn('Failed to persist waypoint stats', error);
    }
  }

  function mergeStoredStats(waypointList) {
    waypointList.forEach((wp) => {
      const stored = loadWaypointStats(wp.id) || {};
      const merged = { ...defaultStats(), ...stored };

      merged.hasAnswered =
        typeof merged.hasAnswered === 'boolean'
          ? merged.hasAnswered
          : Boolean(
              stored?.dueAt ||
                stored?.lastShownAt ||
                stored?.correctStreak ||
                stored?.wrongStreak
            );

      merged.seen =
        typeof merged.seen === 'boolean' ? merged.seen : Boolean(merged.hasAnswered);

      wp.stats = merged;
    });
  }

  function persistEnabledFIRs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabledFIRs]));
    } catch (error) {
      console.warn('Failed to persist FIR preferences', error);
    }
  }

  function renderFIRControls() {
    if (!firContent) return;
    firContent.innerHTML = '';

    if (!firOptions.length) {
      firContent.textContent = 'No FIR data available.';
      return;
    }

    const actions = document.createElement('div');
    actions.className = 'drawer-actions';

    const selectAllButton = document.createElement('button');
    selectAllButton.type = 'button';
    selectAllButton.textContent = 'Select all';
    selectAllButton.addEventListener('click', () => {
      enabledFIRs = new Set(firOptions);
      syncFIRControls();
      onFIRSelectionChanged();
    });

    const selectNoneButton = document.createElement('button');
    selectNoneButton.type = 'button';
    selectNoneButton.textContent = 'Select none';
    selectNoneButton.addEventListener('click', () => {
      enabledFIRs = new Set();
      syncFIRControls();
      onFIRSelectionChanged();
    });

    actions.append(selectAllButton, selectNoneButton);
    firContent.appendChild(actions);

    const firList = document.createElement('div');
    firList.className = 'fir-list';

    firOptions.forEach((fir) => {
      const option = document.createElement('label');
      option.className = 'fir-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = fir;
      checkbox.checked = enabledFIRs.has(fir);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          enabledFIRs.add(fir);
        } else {
          enabledFIRs.delete(fir);
        }
        onFIRSelectionChanged();
      });

      const label = document.createElement('span');
      label.textContent = fir;

      option.append(checkbox, label);
      firList.appendChild(option);
    });

    firContent.appendChild(firList);
  }

  function syncFIRControls() {
    firContent?.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = enabledFIRs.has(input.value);
    });
  }

  function setFIRPanelOpen(open) {
    if (!firPanel || !firOverlay || !firFab) return;
    firPanelOpen = open;
    firPanel.classList.toggle('open', open);
    firOverlay.classList.toggle('active', open);
    firFab.setAttribute('aria-expanded', open ? 'true' : 'false');
    firOverlay.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function toggleFIRPanel() {
    setFIRPanelOpen(!firPanelOpen);
  }

  function setupFIRPanelControls() {
    setFIRPanelOpen(false);

    firFab?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFIRPanel();
    });

    firOverlay?.addEventListener('click', () => setFIRPanelOpen(false));
  }

  function updateVisibleWaypoints() {
    visibleWaypoints = enabledFIRs.size
      ? waypoints.filter((wp) => enabledFIRs.has(wp.fir))
      : [];
  }

  function wrongInterval(streak) {
    if (streak <= 0) return QUIZ_CONFIG.wrongIntervalsMs[0];
    const index = Math.min(streak - 1, QUIZ_CONFIG.wrongIntervalsMs.length - 1);
    return QUIZ_CONFIG.wrongIntervalsMs[index];
  }

  function baseCorrectInterval(wrongsBeforeCorrect) {
    if (wrongsBeforeCorrect === 0) return QUIZ_CONFIG.correctNoWrongMs;
    if (wrongsBeforeCorrect <= 2) return QUIZ_CONFIG.correctWithWrongMs;
    return QUIZ_CONFIG.correctWithWrongMs;
  }

  function applyWrong(waypoint) {
    if (!waypoint?.stats) waypoint.stats = defaultStats();
    const now = Date.now();
    waypoint.stats.wrongStreak += 1;
    waypoint.stats.correctStreak = 0;
    waypoint.stats.hasAnswered = true;
    waypoint.stats.dueAt = now + wrongInterval(waypoint.stats.wrongStreak);
    waypoint.stats.lastShownAt = now;
    persistWaypointStats(waypoint);
    updateStatusCounters();
  }

  function applyCorrect(waypoint, wrongsBeforeCorrect) {
    if (!waypoint?.stats) waypoint.stats = defaultStats();
    const now = Date.now();
    waypoint.stats.wrongStreak = 0;
    waypoint.stats.correctStreak += 1;
    waypoint.stats.hasAnswered = true;

    const base = baseCorrectInterval(wrongsBeforeCorrect);
    const streakMultiplier =
      waypoint.stats.correctStreak > 1
        ? Math.pow(QUIZ_CONFIG.correctStreakMultiplier, waypoint.stats.correctStreak - 1)
        : 1;

    const interval = Math.min(base * streakMultiplier, QUIZ_CONFIG.maxCorrectIntervalMs);

    waypoint.stats.dueAt = now + interval;
    waypoint.stats.lastShownAt = now;
    persistWaypointStats(waypoint);
    updateStatusCounters();
  }

  function onFIRSelectionChanged() {
    persistEnabledFIRs();
    updateVisibleWaypoints();
    updateStatusCounters();
    updateCurrentTarget();
    requestRender();
  }

  function randomItem(list) {
    if (!list?.length) return null;
    const index = Math.floor(Math.random() * list.length);
    return list[index];
  }

  function chooseNextTarget(availableWaypoints, { excludeId } = {}) {
    const pool = excludeId
      ? availableWaypoints.filter((wp) => wp.id !== excludeId)
      : availableWaypoints;

    if (!pool.length) return null;

    const now = Date.now();
    const groupA = [];
    const groupB = [];
    const groupC = [];

    pool.forEach((wp) => {
      if (!wp.stats) wp.stats = defaultStats();
      const { seen, hasAnswered, dueAt } = wp.stats;

      if (hasAnswered && (dueAt ?? now) <= now) {
        groupA.push(wp);
        return;
      }

      if (!seen) {
        groupB.push(wp);
        return;
      }

      if (hasAnswered) {
        groupC.push({ wp, dueAt });
      }
    });

    if (groupA.length) {
      return randomItem(groupA);
    }

    if (groupB.length) {
      return randomItem(groupB);
    }

    if (groupC.length) {
      const jittered = groupC.map(({ wp, dueAt }) => ({
        wp,
        value: (dueAt ?? now) + Math.random() * 2000,
      }));

      jittered.sort((a, b) => a.value - b.value);
      return jittered[0].wp;
    }

    return randomItem(pool);
  }

  function refreshQueuedNextTarget() {
    queuedNextTarget = chooseNextTarget(visibleWaypoints, {
      excludeId: currentTarget?.id,
    });
  }

  function takeQueuedNextTarget() {
    if (!visibleWaypoints.length) {
      queuedNextTarget = null;
      return null;
    }

    const available = visibleWaypoints.filter((wp) => wp.id !== currentTarget?.id);
    if (!available.length) {
      queuedNextTarget = null;
      return null;
    }

    const next = chooseNextTarget(available);
    queuedNextTarget = null;
    return next;
  }

  function markWaypointSeen(waypoint) {
    if (!waypoint) return;
    if (!waypoint.stats) waypoint.stats = defaultStats();
    if (waypoint.stats.seen) return;

    waypoint.stats.seen = true;
    persistWaypointStats(waypoint);
  }

  function updateCurrentTarget() {
    if (!enabledFIRs.size) {
      stopRevealMode();
      currentTarget = null;
      updateTopBar();
      return;
    }

    const availableWaypoints = visibleWaypoints;

    if (!availableWaypoints.length) {
      stopRevealMode();
      currentTarget = null;
      updateTopBar();
      return;
    }

    if (!currentTarget || !enabledFIRs.has(currentTarget.fir)) {
      currentTarget = chooseNextTarget(availableWaypoints);
      currentWrongCount = 0;
    }

    markWaypointSeen(currentTarget);

    queuedNextTarget = null;

    updateTopBar();
    requestRender();
  }

  function updateTopBar() {
    if (!topBarTitle) return;

    if (initializationError) {
      topBarTitle.textContent = initializationError;
      return;
    }

    if (!enabledFIRs.size) {
      topBarTitle.textContent = FIR_DISABLED_MESSAGE;
      return;
    }

    if (currentTarget) {
      topBarTitle.textContent = `${currentTarget.name} (${currentTarget.fir})`;
      return;
    }

    topBarTitle.textContent = 'Waypoint Name';
  }

  function categorizeWaypoint(stats) {
    const merged = { ...defaultStats(), ...stats };

    if (merged.correctStreak >= 3 && merged.wrongStreak === 0) {
      return 'green';
    }

    if (merged.hasAnswered && merged.correctStreak > 0 && merged.wrongStreak === 0) {
      return 'yellow';
    }

    return 'red';
  }

  function updateStatusCounters() {
    if (!countRedEl || !countYellowEl || !countGreenEl) return;
    if (initializationError || !visibleWaypoints.length) {
      countRedEl.textContent = '0';
      countYellowEl.textContent = '0';
      countGreenEl.textContent = '0';
      return;
    }

    const counts = { red: 0, yellow: 0, green: 0 };

    visibleWaypoints.forEach((wp) => {
      const category = categorizeWaypoint(wp.stats);
      counts[category] += 1;
    });

    countRedEl.textContent = `${counts.red}`;
    countYellowEl.textContent = `${counts.yellow}`;
    countGreenEl.textContent = `${counts.green}`;
  }

  function setInitializationError(message) {
    initializationError = message;
    updateTopBar();
  }

  function flashTopBar(type) {
    if (!topBar) return;
    const className = type === 'correct' ? 'flash-correct' : 'flash-wrong';
    topBar.classList.remove('flash-correct', 'flash-wrong');
    // force reflow to allow retriggering the flash
    void topBar.offsetWidth;
    topBar.classList.add(className);
    setTimeout(() => topBar.classList.remove(className), QUIZ_CONFIG.revealFlashMs);
  }

  function flashWaypointFeedback(waypointId, type) {
    if (!waypointId) return;

    const color = type === 'correct' ? '#22c55e' : '#ef4444';
    const expiresAt = Date.now() + QUIZ_CONFIG.revealFlashMs;
    waypointFeedback.set(waypointId, { color, expiresAt });

    setTimeout(() => {
      const feedback = waypointFeedback.get(waypointId);
      if (feedback && feedback.expiresAt <= Date.now()) {
        waypointFeedback.delete(waypointId);
        requestRender();
      }
    }, QUIZ_CONFIG.revealFlashMs);

    requestRender();
  }

  function startRevealMode() {
    if (revealState.active) return;
    revealState = { active: true, visible: true, timerId: null };
    revealState.timerId = setInterval(() => {
      revealState.visible = !revealState.visible;
      requestRender();
    }, QUIZ_CONFIG.revealFlashMs);
  }

  function stopRevealMode() {
    if (revealState.timerId) {
      clearInterval(revealState.timerId);
    }
    revealState = { active: false, visible: true, timerId: null };
    requestRender();
  }

  function updateProjection() {
    if (!canvas.width || !canvas.height) return;

    const bounds = getPreferredBounds(firGeoJSON, waypoints);
    if (!bounds) {
      projection = null;
      return;
    }

    projection = createProjection(bounds, firGeoJSON, waypoints);
    if (!projection) return;

    waypoints = waypoints.map((wp) => {
      const { x, y } = projection.project(wp.lon, wp.lat);
      return { ...wp, x, y };
    });

    epwwBounds = computeRegionBounds('WARSZAWA FIR', 'EPWW');
    updateVisibleWaypoints();
  }

  function getPreferredBounds(firData, waypointList) {
    const warsawFirBounds = computeBounds(filterFIRFeatures(firData, 'WARSZAWA FIR'), waypointList);
    if (warsawFirBounds) {
      return warsawFirBounds;
    }

    return computeBounds(firData, waypointList) ?? DEFAULT_VIEW_BOUNDS;
  }

  function filterFIRFeatures(firData, firName) {
    const features = firData?.features?.filter(
      (feature) => feature?.properties?.AV_NAME === firName
    );

    return features?.length ? { ...firData, features } : firData;
  }

  function computeBounds(firData, waypointList) {
    const bounds = {
      minLon: Infinity,
      maxLon: -Infinity,
      minLat: Infinity,
      maxLat: -Infinity,
    };

    const apply = (lon, lat) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      bounds.minLon = Math.min(bounds.minLon, lon);
      bounds.maxLon = Math.max(bounds.maxLon, lon);
      bounds.minLat = Math.min(bounds.minLat, lat);
      bounds.maxLat = Math.max(bounds.maxLat, lat);
    };

    firData?.features?.forEach((feature) => {
      forEachCoordinate(feature.geometry, apply);
    });

    waypointList.forEach((wp) => apply(wp.lon, wp.lat));

    if (!Number.isFinite(bounds.minLon)) {
      return null;
    }

    return bounds;
  }

  function forEachCoordinate(geometry, callback) {
    if (!geometry) return;

    const { type, coordinates } = geometry;

    switch (type) {
      case 'Polygon':
        coordinates?.forEach((ring) =>
          ring?.forEach(([lon, lat]) => callback(lon, lat))
        );
        break;
      case 'MultiPolygon':
        coordinates?.forEach((polygon) =>
          polygon?.forEach((ring) =>
            ring?.forEach(([lon, lat]) => callback(lon, lat))
          )
        );
        break;
      case 'LineString':
        coordinates?.forEach(([lon, lat]) => callback(lon, lat));
        break;
      case 'MultiLineString':
        coordinates?.forEach((line) =>
          line?.forEach(([lon, lat]) => callback(lon, lat))
        );
        break;
      case 'Point': {
        const [lon, lat] = coordinates ?? [];
        callback(lon, lat);
        break;
      }
      case 'MultiPoint':
        coordinates?.forEach(([lon, lat]) => callback(lon, lat));
        break;
      case 'GeometryCollection':
        geometry.geometries?.forEach((child) =>
          forEachCoordinate(child, callback)
        );
        break;
      default:
        break;
    }
  }

  function createProjection(bounds, firData, waypointList) {
    const lat0Rad = degToRad((bounds.minLat + bounds.maxLat) / 2);

    const toWorld = (lon, lat) => ({
      x: degToRad(lon) * Math.cos(lat0Rad),
      y: -degToRad(lat),
    });

    const worldBounds = computeProjectedBounds(
      firData,
      waypointList,
      toWorld,
      bounds
    );

    if (!worldBounds) return null;

    return {
      project(lon, lat) {
        return toWorld(lon, lat);
      },
      worldBounds,
    };
  }

  function computeProjectedBounds(firData, waypointList, toWorld, fallbackBounds) {
    const bounds = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    };

    const apply = (lon, lat) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      const { x, y } = toWorld(lon, lat);
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    };

    firData?.features?.forEach((feature) => {
      forEachCoordinate(feature.geometry, apply);
    });

    waypointList.forEach((wp) => apply(wp.lon, wp.lat));

    if (!Number.isFinite(bounds.minX) && fallbackBounds) {
      apply(fallbackBounds.minLon, fallbackBounds.minLat);
      apply(fallbackBounds.maxLon, fallbackBounds.maxLat);
    }

    return Number.isFinite(bounds.minX) ? bounds : null;
  }

  function degToRad(value) {
    return (value * Math.PI) / 180;
  }

  function render() {
    renderScheduled = false;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!projection) return;

    drawFIRBoundaries();
    drawWaypoints();
  }

  function drawFIRBoundaries() {
    if (!firGeoJSON?.features) return;

    ctx.strokeStyle = '#c4c4c4';
    ctx.lineWidth = 1;

    firGeoJSON.features.forEach((feature) => {
      traceGeometry(feature.geometry, true);
    });
  }

  function drawWaypoints() {
    const scaleRange = MAX_SCALE - MIN_SCALE || 1;
    const scaleRatio = Math.min(
      Math.max((viewport.scale - MIN_SCALE) / scaleRange, 0),
      1
    );
    const minRadius = 2.5;
    const maxRadius = 7;
    const radius = minRadius + (maxRadius - minRadius) * scaleRatio;

    visibleWaypoints.forEach((wp) => {
      if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) return;
      const isTarget = currentTarget?.id === wp.id;
      if (revealState.active && isTarget && !revealState.visible) return;
      const { x, y } = worldToScreen(wp);

      const feedback = waypointFeedback.get(wp.id);
      if (feedback && feedback.expiresAt <= Date.now()) {
        waypointFeedback.delete(wp.id);
      }

      const fillColor = waypointFeedback.get(wp.id)?.color || '#333';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
    });
  }

  function traceGeometry(geometry, strokeShape) {
    if (!geometry || !projection) return;

    const { type, coordinates } = geometry;

    const drawPath = (points, closePath = false) => {
      if (!points?.length) return;
      const [firstLon, firstLat] = points[0];
      const start = worldToScreen(projection.project(firstLon, firstLat));
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);

      for (let i = 1; i < points.length; i += 1) {
        const [lon, lat] = points[i];
        const { x, y } = worldToScreen(projection.project(lon, lat));
        ctx.lineTo(x, y);
      }

      if (closePath) {
        ctx.closePath();
      }

      if (strokeShape) {
        ctx.stroke();
      }
    };

    switch (type) {
      case 'Polygon':
        coordinates?.forEach((ring) => drawPath(ring, true));
        break;
      case 'MultiPolygon':
        coordinates?.forEach((polygon) => polygon?.forEach((ring) => drawPath(ring, true)));
        break;
      case 'LineString':
        drawPath(coordinates, false);
        break;
      case 'MultiLineString':
        coordinates?.forEach((line) => drawPath(line, false));
        break;
      case 'GeometryCollection':
        geometry.geometries?.forEach((child) => traceGeometry(child, strokeShape));
        break;
      default:
        break;
    }
  }

  async function init() {
    resizeCanvas();
    initializationError = null;

    try {
      const [firData, loadedWaypoints] = await Promise.all([
        loadFIRMap(),
        loadWaypoints(),
      ]);

      firGeoJSON = firData;
      waypoints = loadedWaypoints;
      mergeStoredStats(waypoints);

      firOptions = uniqueFIRs(waypoints);
      enabledFIRs = restoreEnabledFIRs(firOptions);
      renderFIRControls();

      updateProjection();
      updateVisibleWaypoints();
      updateStatusCounters();
      updateCurrentTarget();
      fitViewToEPWW();
      requestRender();
    } catch (error) {
      console.error('Failed to initialize map', error);
      setInitializationError(error?.message || WAYPOINT_INDEX_ERROR);
    }
  }

  function worldToScreen({ x, y }) {
    return {
      x: x * viewport.scale + viewport.offsetX,
      y: y * viewport.scale + viewport.offsetY,
    };
  }

  function screenToWorld(x, y) {
    return {
      x: (x - viewport.offsetX) / viewport.scale,
      y: (y - viewport.offsetY) / viewport.scale,
    };
  }

  function findTappedWaypoint(worldPoint, toleranceWorld) {
    let nearest = null;
    let nearestDistance = Infinity;

    visibleWaypoints.forEach((wp) => {
      if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) return;
      const dist = Math.hypot(worldPoint.x - wp.x, worldPoint.y - wp.y);
      if (dist <= toleranceWorld && dist < nearestDistance) {
        nearest = wp;
        nearestDistance = dist;
      }
    });

    return nearest;
  }

  function handleCanvasTap(screenX, screenY) {
    if (!projection || !currentTarget) return;

    const tapWorld = screenToWorld(screenX, screenY);
    const toleranceWorld = (QUIZ_CONFIG.tolerancePx || 18) / viewport.scale;
    const tappedWaypoint = findTappedWaypoint(tapWorld, toleranceWorld);

    if (!tappedWaypoint) {
      return;
    }

    const dist = Math.hypot(tapWorld.x - currentTarget.x, tapWorld.y - currentTarget.y);
    const isCorrect = dist <= toleranceWorld;

    if (revealState.active && !isCorrect) {
      return;
    }

    if (isCorrect) {
      const wrongsBeforeCorrect = currentWrongCount;
      flashTopBar('correct');
      flashWaypointFeedback(currentTarget.id, 'correct');
      applyCorrect(currentTarget, wrongsBeforeCorrect);
      currentWrongCount = 0;
      stopRevealMode();
      refreshQueuedNextTarget();
      currentTarget = takeQueuedNextTarget();
      markWaypointSeen(currentTarget);
      updateTopBar();
      requestRender();
      return;
    }

    currentWrongCount += 1;
    flashTopBar('wrong');
    if (tappedWaypoint?.id) {
      flashWaypointFeedback(tappedWaypoint.id, 'wrong');
    }
    applyWrong(currentTarget);
    refreshQueuedNextTarget();
    if (currentWrongCount >= 3) {
      startRevealMode();
    }
    requestRender();
  }

  function computeRegionBounds(firName, firCode) {
    if (!projection) return null;

    const bounds = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    };

    const addPoint = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    };

    const firFeatures = filterFIRFeatures(firGeoJSON, firName)?.features ?? [];
    firFeatures.forEach((feature) => {
      forEachCoordinate(feature.geometry, (lon, lat) => {
        const { x, y } = projection.project(lon, lat);
        addPoint(x, y);
      });
    });

    waypoints
      .filter((wp) => wp.fir === firCode)
      .forEach((wp) => addPoint(wp.x, wp.y));

    return Number.isFinite(bounds.minX) ? bounds : null;
  }

  function fitViewToEPWW() {
    if (!epwwBounds || !canvas.width || !canvas.height) return;
    fitViewToBounds(epwwBounds, 1.2);
  }

  function fitViewToBounds(bounds, targetFill = 0.85) {
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;

    const scale = clampScale(
      Math.min((canvas.width * targetFill) / spanX, (canvas.height * targetFill) / spanY)
    );

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;

    const offsetX = canvas.width / 2 - centerX * scale;
    const offsetY = canvas.height / 2 - centerY * scale;

    if (
      viewport.scale !== scale ||
      viewport.offsetX !== offsetX ||
      viewport.offsetY !== offsetY
    ) {
      viewport.scale = scale;
      viewport.offsetX = offsetX;
      viewport.offsetY = offsetY;
      requestRender();
    }
  }

  function clampScale(value) {
    return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE);
  }

  function requestRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(render);
  }

  function startPan(x, y) {
    panState.active = true;
    panState.lastX = x;
    panState.lastY = y;
  }

  function continuePan(x, y) {
    if (!panState.active) return;
    const dx = x - panState.lastX;
    const dy = y - panState.lastY;
    if (dx === 0 && dy === 0) return;
    viewport.offsetX += dx;
    viewport.offsetY += dy;
    panState.lastX = x;
    panState.lastY = y;
    requestRender();
  }

  function endPan() {
    panState.active = false;
  }

  function zoomAt(pointX, pointY, factor) {
    const prevScale = viewport.scale;
    const nextScale = clampScale(prevScale * factor);
    if (nextScale === prevScale) return;

    const worldPoint = screenToWorld(pointX, pointY);

    viewport.scale = nextScale;
    viewport.offsetX = pointX - worldPoint.x * nextScale;
    viewport.offsetY = pointY - worldPoint.y * nextScale;

    requestRender();
  }

  const panState = { active: false, lastX: 0, lastY: 0 };
  const pointerState = {
    activeId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    isDragging: false,
    lastTapTime: 0,
  };

  const pinchState = {
    active: false,
    startDistance: 0,
    startScale: 1,
    centerX: 0,
    centerY: 0,
  };

  const pointerPositions = new Map();
  const DRAG_DISTANCE_THRESHOLD = 10;
  const TAP_COOLDOWN_MS = 150;

  function getCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function distanceBetweenPoints(pointA, pointB) {
    return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
  }

  function centerBetweenPoints(pointA, pointB) {
    return { x: (pointA.x + pointB.x) / 2, y: (pointA.y + pointB.y) / 2 };
  }

  function setScaleAt(pointX, pointY, nextScale) {
    const clamped = clampScale(nextScale);
    if (clamped === viewport.scale) return;
    const worldPoint = screenToWorld(pointX, pointY);
    viewport.scale = clamped;
    viewport.offsetX = pointX - worldPoint.x * clamped;
    viewport.offsetY = pointY - worldPoint.y * clamped;
    requestRender();
  }

  function startPinch(pointA, pointB) {
    const center = centerBetweenPoints(pointA, pointB);
    pinchState.active = true;
    pinchState.startDistance = Math.max(distanceBetweenPoints(pointA, pointB), 1);
    pinchState.startScale = viewport.scale;
    pinchState.centerX = center.x;
    pinchState.centerY = center.y;
    pointerState.isDragging = true;
    panState.active = false;
  }

  function updatePinch(pointA, pointB) {
    const center = centerBetweenPoints(pointA, pointB);
    const distance = Math.max(distanceBetweenPoints(pointA, pointB), 1);
    const factor = distance / pinchState.startDistance;
    pinchState.centerX = center.x;
    pinchState.centerY = center.y;
    setScaleAt(center.x, center.y, pinchState.startScale * factor);
  }

  function endPinch() {
    pinchState.active = false;
    pinchState.startDistance = 0;
    pinchState.startScale = viewport.scale;
  }

  function setupPointerControls() {
    const endPointer = (event) => {
      if (!pointerPositions.has(event.pointerId)) return;

      pointerPositions.delete(event.pointerId);

      if (pinchState.active && pointerPositions.size < 2) {
        endPinch();
        if (pointerPositions.size === 1) {
          const [remainingId, remainingPoint] = [...pointerPositions.entries()][0];
          pointerState.activeId = remainingId;
          pointerState.startX = remainingPoint.x;
          pointerState.startY = remainingPoint.y;
          pointerState.lastX = remainingPoint.x;
          pointerState.lastY = remainingPoint.y;
          pointerState.isDragging = true;
          startPan(remainingPoint.x, remainingPoint.y);
        } else {
          pointerState.activeId = null;
          pointerState.isDragging = false;
          pointerState.startX = 0;
          pointerState.startY = 0;
          pointerState.lastX = 0;
          pointerState.lastY = 0;
        }
      }

      if (pointerState.activeId === event.pointerId && pointerState.isDragging) {
        endPan();
      } else if (pointerState.activeId === event.pointerId && !pinchState.active) {
        const now = performance.now();
        if (now - pointerState.lastTapTime >= TAP_COOLDOWN_MS) {
          pointerState.lastTapTime = now;
          const { x, y } = getCanvasPoint(event.clientX, event.clientY);
          handleCanvasTap(x, y);
        }
      }

      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (pointerState.activeId === event.pointerId) {
        pointerState.activeId = null;
        pointerState.isDragging = false;
        pointerState.startX = 0;
        pointerState.startY = 0;
        pointerState.lastX = 0;
        pointerState.lastY = 0;
      }
      event.preventDefault();
    };

    canvas.addEventListener(
      'pointerdown',
      (event) => {
        const { x, y } = getCanvasPoint(event.clientX, event.clientY);
        pointerPositions.set(event.pointerId, { x, y });

        if (pointerPositions.size === 1) {
          pointerState.activeId = event.pointerId;
          pointerState.startX = x;
          pointerState.startY = y;
          pointerState.lastX = x;
          pointerState.lastY = y;
          pointerState.isDragging = false;
        } else if (pointerPositions.size === 2) {
          const [pointA, pointB] = [...pointerPositions.values()];
          startPinch(pointA, pointB);
        }
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      { passive: false }
    );

    canvas.addEventListener(
      'pointermove',
      (event) => {
        const { x, y } = getCanvasPoint(event.clientX, event.clientY);
        if (!pointerPositions.has(event.pointerId)) return;
        pointerPositions.set(event.pointerId, { x, y });

        if (pinchState.active && pointerPositions.size >= 2) {
          const [pointA, pointB] = [...pointerPositions.values()];
          updatePinch(pointA, pointB);
          event.preventDefault();
          return;
        }

        if (pointerState.activeId !== event.pointerId) return;

        const dragDistance = Math.hypot(x - pointerState.startX, y - pointerState.startY);

        if (!pointerState.isDragging && dragDistance > DRAG_DISTANCE_THRESHOLD) {
          pointerState.isDragging = true;
          startPan(x, y);
        }

        if (pointerState.isDragging) {
          continuePan(x, y);
          event.preventDefault();
        }

        pointerState.lastX = x;
        pointerState.lastY = y;
      },
      { passive: false }
    );

    canvas.addEventListener('pointerup', endPointer, { passive: false });
    canvas.addEventListener('pointercancel', endPointer, { passive: false });

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!projection) return;
        event.preventDefault();
        const zoomFactor = Math.exp(-event.deltaY * 0.001);
        const { x, y } = getCanvasPoint(event.clientX, event.clientY);
        zoomAt(x, y, zoomFactor);
      },
      { passive: false }
    );
  }

  setupFIRPanelControls();
  setupPointerControls();

  window.addEventListener('resize', resizeCanvas, { passive: true });
  window.addEventListener('load', init);
})();
