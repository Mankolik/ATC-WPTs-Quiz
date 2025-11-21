(function () {
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');

  const viewport = { scale: 1, offsetX: 0, offsetY: 0 };

  let firGeoJSON = null;
  let waypoints = [];
  let projection = null;
  let epwwBounds = null;
  let renderScheduled = false;

  const MIN_SCALE = 1;
  const MAX_SCALE = 40;

  const DEFAULT_VIEW_BOUNDS = {
    minLon: 14.156666,
    maxLon: 24.1,
    minLat: 49.0,
    maxLat: 55.85,
  };

  const DATA_ROOT = 'data';
  const WAYPOINT_PATHS = [`${DATA_ROOT}/EPWW.geoJSON`, `${DATA_ROOT}/EPWW.geojson`];

  async function loadFIRMap() {
    const response = await fetch(`${DATA_ROOT}/FIRmap.json`);
    if (!response.ok) {
      throw new Error(`Failed to load FIR map: ${response.status}`);
    }
    return response.json();
  }

  async function fetchJSONFrom(paths) {
    for (const path of paths) {
      try {
        const response = await fetch(path);
        if (response.ok) {
          return await response.json();
        }
      } catch (error) {
        console.warn(`Unable to fetch ${path}`, error);
      }
    }
    throw new Error('Failed to load waypoints');
  }

  async function loadWaypoints() {
    const firCode = 'EPWW';
    const data = await fetchJSONFrom(WAYPOINT_PATHS);
    const features = data?.features ?? [];

    return features
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
  }

  function resizeCanvas() {
    const { clientWidth, clientHeight } = canvas;
    canvas.width = clientWidth;
    canvas.height = clientHeight;
    updateProjection();
    fitViewToEPWW();
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

    epwwBounds = computeWaypointBounds('EPWW');
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
    ctx.fillStyle = '#333';

    waypoints.forEach((wp) => {
      if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) return;
      const radius = 3.5;
      const { x, y } = worldToScreen(wp);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
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

    try {
      const [firData, loadedWaypoints] = await Promise.all([
        loadFIRMap(),
        loadWaypoints(),
      ]);

      firGeoJSON = firData;
      waypoints = loadedWaypoints;

      updateProjection();
      fitViewToEPWW();
      requestRender();
    } catch (error) {
      console.error('Failed to initialize map', error);
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

  function computeWaypointBounds(firCode) {
    const bounds = waypoints
      .filter((wp) => wp.fir === firCode)
      .reduce(
        (acc, wp) => {
          if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) return acc;
          return {
            minX: Math.min(acc.minX, wp.x),
            maxX: Math.max(acc.maxX, wp.x),
            minY: Math.min(acc.minY, wp.y),
            maxY: Math.max(acc.maxY, wp.y),
          };
        },
        {
          minX: Infinity,
          maxX: -Infinity,
          minY: Infinity,
          maxY: -Infinity,
        }
      );

    return Number.isFinite(bounds.minX) ? bounds : null;
  }

  function fitViewToEPWW() {
    if (!epwwBounds || !canvas.width || !canvas.height) return;
    fitViewToBounds(epwwBounds, 1.6);
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

  function getCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function setupMouseControls() {
    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const { x, y } = getCanvasPoint(event.clientX, event.clientY);
      startPan(x, y);
    });

    window.addEventListener('mousemove', (event) => {
      if (!panState.active) return;
      const { x, y } = getCanvasPoint(event.clientX, event.clientY);
      continuePan(x, y);
    });

    window.addEventListener('mouseup', endPan);

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

  const touchState = {
    mode: 'none',
    lastX: 0,
    lastY: 0,
    lastDistance: 0,
    lastMidpoint: null,
  };

  function getTouchPoint(touch) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
    };
  }

  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function setupTouchControls() {
    canvas.addEventListener(
      'touchstart',
      (event) => {
        if (!projection) return;
        if (event.touches.length === 1) {
          const point = getTouchPoint(event.touches[0]);
          touchState.mode = 'pan';
          startPan(point.x, point.y);
          touchState.lastX = point.x;
          touchState.lastY = point.y;
        } else if (event.touches.length >= 2) {
          endPan();
          const first = getTouchPoint(event.touches[0]);
          const second = getTouchPoint(event.touches[1]);
          touchState.mode = 'pinch';
          touchState.lastDistance = distance(first, second);
          touchState.lastMidpoint = midpoint(first, second);
        }
      },
      { passive: false }
    );

    canvas.addEventListener(
      'touchmove',
      (event) => {
        if (!projection) return;
        event.preventDefault();

        if (event.touches.length === 1 && touchState.mode === 'pan') {
          const point = getTouchPoint(event.touches[0]);
          continuePan(point.x, point.y);
        } else if (event.touches.length >= 2) {
          const first = getTouchPoint(event.touches[0]);
          const second = getTouchPoint(event.touches[1]);
          const currentDistance = distance(first, second);
          const currentMidpoint = midpoint(first, second);

          if (touchState.mode !== 'pinch') {
            touchState.mode = 'pinch';
            touchState.lastDistance = currentDistance;
            touchState.lastMidpoint = currentMidpoint;
            return;
          }

          if (touchState.lastDistance > 0) {
            const factor = currentDistance / touchState.lastDistance;
            zoomAt(touchState.lastMidpoint.x, touchState.lastMidpoint.y, factor);
          }

          viewport.offsetX += currentMidpoint.x - touchState.lastMidpoint.x;
          viewport.offsetY += currentMidpoint.y - touchState.lastMidpoint.y;

          touchState.lastDistance = currentDistance;
          touchState.lastMidpoint = currentMidpoint;
          requestRender();
        }
      },
      { passive: false }
    );

    canvas.addEventListener(
      'touchend',
      (event) => {
        if (event.touches.length === 1) {
          const point = getTouchPoint(event.touches[0]);
          touchState.mode = 'pan';
          startPan(point.x, point.y);
          touchState.lastX = point.x;
          touchState.lastY = point.y;
        } else {
          touchState.mode = 'none';
          endPan();
        }
      },
      { passive: false }
    );

    canvas.addEventListener(
      'touchcancel',
      () => {
        touchState.mode = 'none';
        endPan();
      },
      { passive: false }
    );
  }

  setupMouseControls();
  setupTouchControls();

  window.addEventListener('resize', resizeCanvas, { passive: true });
  window.addEventListener('load', init);
})();
