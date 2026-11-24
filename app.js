(function () {
  const SRS = window.SRS;

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
  let waypointsById = new Map();
  let visibleWaypoints = [];
  let firOptions = [];
  let enabledFIRs = new Set();
  let currentTarget = null;
  let currentWrongCount = 0;
  let projection = null;
  let renderScheduled = false;
  let revealState = { active: false, visible: true, timerId: null };
  const waypointFeedback = new Map();
  let initializationError = null;
  let firPanelOpen = false;
  let idleAction = null;

  const MIN_SCALE = 1500;
  const MAX_SCALE = 25000;

  const FIR_STORAGE_KEY = 'enabledFIRs:v1';
  const CARD_STORAGE_PREFIX = 'wpCard:v2:';
  const DAILY_STORAGE_KEY = 'wpDaily:v2';
  // Progress from the old (pre-SM-2) engine; removed on load.
  const LEGACY_STORAGE_PREFIXES = ['waypointStats:v1:'];
  const LEGACY_STORAGE_KEYS = ['waypointSession:v1'];

  const QUIZ_CONFIG = {
    tolerancePx: 18,
    revealAfterWrong: 3,
    revealFlashMs: 300,
    newPerDay: 15,
    extraNewBatch: 10,
    idleCheckMs: 10 * 1000,
  };

  const DATA_ROOT = 'data';
  const WAYPOINTS_PATH = `${DATA_ROOT}/waypoints`;
  const WAYPOINT_INDEX_ERROR = 'Failed to load FIR manifest';
  const FIR_DISABLED_MESSAGE = 'Enable at least one FIR';
  const MANIFEST_EMPTY_MESSAGE = 'No FIR files listed in manifest';

  // ---------------------------------------------------------------------------
  // Storage helpers (localStorage can throw in private mode etc.)

  function storageGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn(`Failed to read ${key}`, error);
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`Failed to write ${key}`, error);
    }
  }

  function clearLegacyProgress() {
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (
          LEGACY_STORAGE_KEYS.includes(key) ||
          LEGACY_STORAGE_PREFIXES.some((prefix) => key?.startsWith(prefix))
        ) {
          doomed.push(key);
        }
      }
      doomed.forEach((key) => localStorage.removeItem(key));
    } catch (error) {
      console.warn('Failed to clear legacy progress', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Data loading

  async function fetchJSON(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Failed to load ${path}: ${response.status}`);
    }
    return response.json();
  }

  async function loadWaypointIndex() {
    let entries;
    try {
      entries = await fetchJSON(`${WAYPOINTS_PATH}/index.json`);
    } catch (error) {
      throw new Error(WAYPOINT_INDEX_ERROR);
    }

    const files = Array.isArray(entries)
      ? entries.map((item) => `${item}`.trim()).filter(Boolean)
      : [];

    if (!files.length) {
      throw new Error(MANIFEST_EMPTY_MESSAGE);
    }
    return files;
  }

  function firCodeFromFilename(filename) {
    const match = filename.match(/([^/]+?)(?:\.[^.]+)?$/);
    return match ? match[1].toUpperCase() : 'FIR';
  }

  async function loadWaypoints() {
    const files = await loadWaypointIndex();
    const perFile = await Promise.all(
      files.map(async (file) => {
        const firCode = firCodeFromFilename(file);
        const data = await fetchJSON(`${WAYPOINTS_PATH}/${file.split('/').pop()}`);
        return (data?.features ?? [])
          .map((feature) => {
            const [lon, lat] = feature?.geometry?.coordinates ?? [];
            const name = `${feature?.properties?.name ?? ''}`.trim();
            const fir = feature?.properties?.fir ?? firCode;
            // Keyed by FIR + name so progress survives edits to the data files.
            return { id: `${fir}:${name}`, name, fir, lon, lat, x: NaN, y: NaN };
          })
          .filter((wp) => wp.name && Number.isFinite(wp.lon) && Number.isFinite(wp.lat));
      })
    );

    const byId = new Map();
    perFile.flat().forEach((wp) => {
      if (byId.has(wp.id)) {
        console.warn(`Duplicate waypoint ${wp.id} ignored`);
        return;
      }
      byId.set(wp.id, wp);
    });
    return [...byId.values()];
  }

  // ---------------------------------------------------------------------------
  // Spaced-repetition state

  function loadCards(list) {
    list.forEach((wp) => {
      wp.card = SRS.normalizeCard(storageGet(`${CARD_STORAGE_PREFIX}${wp.id}`));
    });
  }

  function persistCard(wp) {
    storageSet(`${CARD_STORAGE_PREFIX}${wp.id}`, wp.card);
  }

  function loadDaily(now) {
    const today = SRS.dayKey(now);
    const stored = storageGet(DAILY_STORAGE_KEY);
    if (stored?.day === today) {
      return {
        day: today,
        newIntroduced: Number(stored.newIntroduced) || 0,
        extraNew: Number(stored.extraNew) || 0,
      };
    }
    return { day: today, newIntroduced: 0, extraNew: 0 };
  }

  function newAllowedToday(now) {
    const daily = loadDaily(now);
    return Math.max(0, QUIZ_CONFIG.newPerDay + daily.extraNew - daily.newIntroduced);
  }

  function updateDaily(now, change) {
    const daily = loadDaily(now);
    change(daily);
    storageSet(DAILY_STORAGE_KEY, daily);
  }

  function gradeWaypoint(wp, grade) {
    const now = Date.now();
    if (wp.card.state === 'new') {
      updateDaily(now, (daily) => {
        daily.newIntroduced += 1;
      });
    }
    wp.card = SRS.gradeCard(wp.card, grade, now);
    persistCard(wp);
    updateStatusCounters();
  }

  function cardItems(list) {
    return list.map((wp) => ({ id: wp.id, card: wp.card }));
  }

  // Picks the next waypoint to ask about, or sets an "all caught up" message.
  function showNextTarget({ excludeId = null } = {}) {
    stopRevealMode();
    currentWrongCount = 0;
    idleAction = null;

    if (!visibleWaypoints.length) {
      currentTarget = null;
      updateTopBar();
      requestRender();
      return;
    }

    const now = Date.now();
    const picked = SRS.pickNext(cardItems(visibleWaypoints), {
      now,
      newAllowed: newAllowedToday(now),
      excludeId,
    });

    currentTarget = picked ? waypointsById.get(picked.id) : null;
    updateTopBar();
    requestRender();
  }

  function idleMessage() {
    const now = Date.now();
    const items = cardItems(visibleWaypoints);
    const hasUnseen = visibleWaypoints.some((wp) => wp.card.state === 'new');
    const nextLearning = SRS.nextLearningDueAt(items);

    let message = 'All caught up for today ✓';
    if (nextLearning) {
      const minutes = Math.max(1, Math.ceil((nextLearning - now) / 60000));
      message = `All caught up · next in ${minutes} min`;
    }

    if (hasUnseen) {
      idleAction = 'moreNew';
      return `${message} · tap for ${QUIZ_CONFIG.extraNewBatch} new`;
    }

    idleAction = null;
    return message;
  }

  function onTitleClick() {
    if (currentTarget || idleAction !== 'moreNew') return;
    updateDaily(Date.now(), (daily) => {
      daily.extraNew += QUIZ_CONFIG.extraNewBatch;
    });
    showNextTarget();
  }

  // While idle, check periodically whether a learning card has become due.
  function idleTick() {
    if (initializationError || currentTarget || !visibleWaypoints.length) return;
    showNextTarget();
  }

  // ---------------------------------------------------------------------------
  // FIR selection

  function uniqueFIRs(list) {
    return Array.from(new Set(list.map((item) => item.fir).filter(Boolean))).sort();
  }

  function restoreEnabledFIRs(allFIRs) {
    const stored = storageGet(FIR_STORAGE_KEY);
    const valid = Array.isArray(stored) ? stored.filter((fir) => allFIRs.includes(fir)) : [];
    return new Set(valid.length ? valid : allFIRs);
  }

  function persistEnabledFIRs() {
    storageSet(FIR_STORAGE_KEY, [...enabledFIRs]);
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

  function setupFIRPanelControls() {
    setFIRPanelOpen(false);
    firFab?.addEventListener('click', (event) => {
      event.stopPropagation();
      setFIRPanelOpen(!firPanelOpen);
    });
    firOverlay?.addEventListener('click', () => setFIRPanelOpen(false));
  }

  function updateVisibleWaypoints() {
    visibleWaypoints = waypoints.filter((wp) => enabledFIRs.has(wp.fir));
  }

  function onFIRSelectionChanged() {
    persistEnabledFIRs();
    updateVisibleWaypoints();
    updateStatusCounters();
    if (!currentTarget || !enabledFIRs.has(currentTarget.fir)) {
      showNextTarget();
    } else {
      updateTopBar();
    }
    fitViewToVisible();
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Top bar + counters + feedback

  function updateTopBar() {
    if (!topBarTitle) return;
    let text;
    let actionable = false;

    if (initializationError) {
      text = initializationError;
    } else if (!enabledFIRs.size) {
      text = FIR_DISABLED_MESSAGE;
    } else if (currentTarget) {
      text = `${currentTarget.name} (${currentTarget.fir})`;
    } else if (visibleWaypoints.length) {
      text = idleMessage();
      actionable = idleAction === 'moreNew';
    } else {
      text = 'Waypoint Name';
    }

    topBarTitle.textContent = text;
    topBarTitle.classList.toggle('is-action', actionable);
    topBarTitle.classList.toggle('is-idle', !currentTarget);
    if (actionable) {
      topBarTitle.setAttribute('role', 'button');
      topBarTitle.tabIndex = 0;
    } else {
      topBarTitle.removeAttribute('role');
      topBarTitle.removeAttribute('tabindex');
    }
  }

  function updateStatusCounters() {
    if (!countRedEl || !countYellowEl || !countGreenEl) return;
    const counts = { red: 0, yellow: 0, green: 0 };
    if (!initializationError) {
      visibleWaypoints.forEach((wp) => {
        counts[SRS.cardStatus(wp.card)] += 1;
      });
    }
    countRedEl.textContent = `${counts.red}`;
    countYellowEl.textContent = `${counts.yellow}`;
    countGreenEl.textContent = `${counts.green}`;
  }

  function setInitializationError(message) {
    initializationError = message;
    updateTopBar();
    updateStatusCounters();
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

  // ---------------------------------------------------------------------------
  // Answering

  function findNearestWaypoint(worldPoint, toleranceWorld) {
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

    return nearest ? { wp: nearest, dist: nearestDistance } : null;
  }

  function handleCanvasTap(screenX, screenY) {
    if (!projection || !currentTarget) return;

    const tapWorld = screenToWorld(screenX, screenY);
    const toleranceWorld = QUIZ_CONFIG.tolerancePx / viewport.scale;
    const nearest = findNearestWaypoint(tapWorld, toleranceWorld);
    if (!nearest) return;

    // Correct only if the target is the waypoint closest to the tap
    // (ties count, for waypoints sharing a position).
    const targetDist = Math.hypot(tapWorld.x - currentTarget.x, tapWorld.y - currentTarget.y);
    const isCorrect = nearest.wp.id === currentTarget.id || targetDist <= nearest.dist + 1e-12;

    if (revealState.active && !isCorrect) return;

    if (isCorrect) {
      const answered = currentTarget;
      flashTopBar('correct');
      flashWaypointFeedback(answered.id, 'correct');
      // A card that was missed this time was already graded "again" on the first miss.
      if (currentWrongCount === 0) {
        gradeWaypoint(answered, 'good');
      }
      showNextTarget({ excludeId: answered.id });
      return;
    }

    currentWrongCount += 1;
    flashTopBar('wrong');
    flashWaypointFeedback(nearest.wp.id, 'wrong');
    if (currentWrongCount === 1) {
      gradeWaypoint(currentTarget, 'again');
    }
    if (currentWrongCount >= QUIZ_CONFIG.revealAfterWrong) {
      startRevealMode();
    }
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // Projection + view

  function waypointGeoBounds(list) {
    const bounds = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
    list.forEach((wp) => {
      bounds.minLon = Math.min(bounds.minLon, wp.lon);
      bounds.maxLon = Math.max(bounds.maxLon, wp.lon);
      bounds.minLat = Math.min(bounds.minLat, wp.lat);
      bounds.maxLat = Math.max(bounds.maxLat, wp.lat);
    });
    return Number.isFinite(bounds.minLon) ? bounds : null;
  }

  function buildProjection() {
    const bounds = waypointGeoBounds(waypoints);
    if (!bounds) {
      projection = null;
      return;
    }
    const lat0Rad = degToRad((bounds.minLat + bounds.maxLat) / 2);
    projection = {
      project(lon, lat) {
        return { x: degToRad(lon) * Math.cos(lat0Rad), y: -degToRad(lat) };
      },
    };
    waypoints.forEach((wp) => {
      const { x, y } = projection.project(wp.lon, wp.lat);
      wp.x = x;
      wp.y = y;
    });
  }

  function degToRad(value) {
    return (value * Math.PI) / 180;
  }

  function worldBoundsOf(list) {
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    list.forEach((wp) => {
      if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) return;
      bounds.minX = Math.min(bounds.minX, wp.x);
      bounds.maxX = Math.max(bounds.maxX, wp.x);
      bounds.minY = Math.min(bounds.minY, wp.y);
      bounds.maxY = Math.max(bounds.maxY, wp.y);
    });
    return Number.isFinite(bounds.minX) ? bounds : null;
  }

  function fitViewToVisible() {
    if (!projection || !canvas.width || !canvas.height) return;
    const bounds = worldBoundsOf(visibleWaypoints.length ? visibleWaypoints : waypoints);
    if (bounds) fitViewToBounds(bounds, 0.9);
  }

  function fitViewToBounds(bounds, targetFill) {
    const spanX = bounds.maxX - bounds.minX || 1e-3;
    const spanY = bounds.maxY - bounds.minY || 1e-3;
    const scale = clampScale(
      Math.min((canvas.width * targetFill) / spanX, (canvas.height * targetFill) / spanY)
    );
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;

    viewport.scale = scale;
    viewport.offsetX = canvas.width / 2 - centerX * scale;
    viewport.offsetY = canvas.height / 2 - centerY * scale;
    requestRender();
  }

  // Keeps whatever is in the middle of the screen in the middle, so the
  // phone's address bar showing/hiding doesn't reset your zoom and pan.
  function resizeCanvas() {
    const prevCenter =
      canvas.width && canvas.height ? screenToWorld(canvas.width / 2, canvas.height / 2) : null;

    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width || window.innerWidth || 1));
    canvas.height = Math.max(1, Math.floor(rect.height || window.innerHeight || 1));

    if (prevCenter && projection) {
      viewport.offsetX = canvas.width / 2 - prevCenter.x * viewport.scale;
      viewport.offsetY = canvas.height / 2 - prevCenter.y * viewport.scale;
    }
    requestRender();
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

  function clampScale(value) {
    return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE);
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function requestRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(render);
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
    firGeoJSON.features.forEach((feature) => traceGeometry(feature.geometry));
  }

  function drawWaypoints() {
    const scaleRatio = clamp((viewport.scale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE), 0, 1);
    const radius = 2.5 + (7 - 2.5) * scaleRatio;
    const now = Date.now();

    visibleWaypoints.forEach((wp) => {
      const isTarget = currentTarget?.id === wp.id;
      if (revealState.active && isTarget && !revealState.visible) return;
      const { x, y } = worldToScreen(wp);

      const feedback = waypointFeedback.get(wp.id);
      if (feedback && feedback.expiresAt <= now) {
        waypointFeedback.delete(wp.id);
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = waypointFeedback.get(wp.id)?.color || '#333';
      ctx.fill();
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function traceGeometry(geometry) {
    if (!geometry || !projection) return;
    const { type, coordinates } = geometry;

    const drawPath = (points, closePath) => {
      if (!points?.length) return;
      ctx.beginPath();
      points.forEach(([lon, lat], i) => {
        const { x, y } = worldToScreen(projection.project(lon, lat));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (closePath) ctx.closePath();
      ctx.stroke();
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
        geometry.geometries?.forEach((child) => traceGeometry(child));
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Pointer input (tap, drag to pan, pinch / wheel to zoom)

  const panState = { active: false, lastX: 0, lastY: 0 };
  const pointerState = {
    activeId: null,
    startX: 0,
    startY: 0,
    isDragging: false,
    lastTapTime: 0,
  };
  const pinchState = { active: false, startDistance: 0, startScale: 1 };
  const pointerPositions = new Map();
  const DRAG_DISTANCE_THRESHOLD = 10;
  const TAP_COOLDOWN_MS = 150;

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

  function setScaleAt(pointX, pointY, nextScale) {
    const clamped = clampScale(nextScale);
    if (clamped === viewport.scale) return;
    const worldPoint = screenToWorld(pointX, pointY);
    viewport.scale = clamped;
    viewport.offsetX = pointX - worldPoint.x * clamped;
    viewport.offsetY = pointY - worldPoint.y * clamped;
    requestRender();
  }

  function getCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function twoPointers() {
    const [a, b] = [...pointerPositions.values()];
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
    };
  }

  function resetPointerState() {
    pointerState.activeId = null;
    pointerState.isDragging = false;
  }

  function setupPointerControls() {
    const endPointer = (event) => {
      if (!pointerPositions.has(event.pointerId)) return;
      pointerPositions.delete(event.pointerId);

      if (pinchState.active && pointerPositions.size < 2) {
        pinchState.active = false;
        if (pointerPositions.size === 1) {
          // Continue panning with the finger that's still down.
          const [remainingId, remainingPoint] = [...pointerPositions.entries()][0];
          pointerState.activeId = remainingId;
          pointerState.startX = remainingPoint.x;
          pointerState.startY = remainingPoint.y;
          pointerState.isDragging = true;
          startPan(remainingPoint.x, remainingPoint.y);
        } else {
          resetPointerState();
        }
      }

      if (pointerState.activeId === event.pointerId) {
        if (pointerState.isDragging) {
          panState.active = false;
        } else if (!pinchState.active && event.type === 'pointerup') {
          const now = performance.now();
          if (now - pointerState.lastTapTime >= TAP_COOLDOWN_MS) {
            pointerState.lastTapTime = now;
            const { x, y } = getCanvasPoint(event.clientX, event.clientY);
            handleCanvasTap(x, y);
          }
        }
        resetPointerState();
      }

      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
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
          pointerState.isDragging = false;
        } else if (pointerPositions.size === 2) {
          pinchState.active = true;
          pinchState.startDistance = twoPointers().distance;
          pinchState.startScale = viewport.scale;
          pointerState.isDragging = true;
          panState.active = false;
        }
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      { passive: false }
    );

    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (!pointerPositions.has(event.pointerId)) return;
        const { x, y } = getCanvasPoint(event.clientX, event.clientY);
        pointerPositions.set(event.pointerId, { x, y });

        if (pinchState.active && pointerPositions.size >= 2) {
          const { center, distance } = twoPointers();
          setScaleAt(center.x, center.y, pinchState.startScale * (distance / pinchState.startDistance));
          event.preventDefault();
          return;
        }

        if (pointerState.activeId !== event.pointerId) return;

        if (
          !pointerState.isDragging &&
          Math.hypot(x - pointerState.startX, y - pointerState.startY) > DRAG_DISTANCE_THRESHOLD
        ) {
          pointerState.isDragging = true;
          startPan(x, y);
        }

        if (pointerState.isDragging) {
          continuePan(x, y);
          event.preventDefault();
        }
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
        const { x, y } = getCanvasPoint(event.clientX, event.clientY);
        setScaleAt(x, y, viewport.scale * Math.exp(-event.deltaY * 0.001));
      },
      { passive: false }
    );
  }

  // ---------------------------------------------------------------------------
  // Startup

  async function init() {
    resizeCanvas();
    initializationError = null;
    clearLegacyProgress();

    try {
      const [firData, loadedWaypoints] = await Promise.all([
        fetchJSON(`${DATA_ROOT}/FIRmap.json`),
        loadWaypoints(),
      ]);

      firGeoJSON = firData;
      waypoints = loadedWaypoints;
      waypointsById = new Map(waypoints.map((wp) => [wp.id, wp]));
      loadCards(waypoints);

      firOptions = uniqueFIRs(waypoints);
      enabledFIRs = restoreEnabledFIRs(firOptions);
      renderFIRControls();

      buildProjection();
      updateVisibleWaypoints();
      updateStatusCounters();
      showNextTarget();
      fitViewToVisible();
    } catch (error) {
      console.error('Failed to initialize map', error);
      setInitializationError(error?.message || WAYPOINT_INDEX_ERROR);
    }
  }

  setupFIRPanelControls();
  setupPointerControls();
  topBarTitle?.addEventListener('click', onTitleClick);
  topBarTitle?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onTitleClick();
    }
  });

  window.addEventListener('resize', resizeCanvas, { passive: true });
  window.addEventListener('load', init);
  setInterval(idleTick, QUIZ_CONFIG.idleCheckMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') idleTick();
  });
})();
