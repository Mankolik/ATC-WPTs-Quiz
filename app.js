(function () {
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');

  let firGeoJSON = null;
  let waypoints = [];
  let projection = null;

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
    render();
  }

  function updateProjection() {
    if (!canvas.width || !canvas.height) return;

    const bounds = computeBounds(firGeoJSON, waypoints);
    if (!bounds) {
      projection = null;
      return;
    }

    projection = createProjection(bounds, canvas.width, canvas.height);
    waypoints = waypoints.map((wp) => {
      const { x, y } = projection.project(wp.lon, wp.lat);
      return { ...wp, x, y };
    });
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

  function createProjection(bounds, width, height) {
    const padding = Math.min(width, height) * 0.05;
    const usableWidth = Math.max(width - padding * 2, 1);
    const usableHeight = Math.max(height - padding * 2, 1);

    const lonSpan = bounds.maxLon - bounds.minLon || 1;
    const latSpan = bounds.maxLat - bounds.minLat || 1;
    const scale = Math.min(usableWidth / lonSpan, usableHeight / latSpan);

    return {
      project(lon, lat) {
        const x = padding + (lon - bounds.minLon) * scale;
        const y = padding + (bounds.maxLat - lat) * scale;
        return { x, y };
      },
    };
  }

  function render() {
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
      ctx.beginPath();
      ctx.arc(wp.x, wp.y, radius, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function traceGeometry(geometry, strokeShape) {
    if (!geometry || !projection) return;

    const { type, coordinates } = geometry;

    const drawPath = (points, closePath = false) => {
      if (!points?.length) return;
      const [firstLon, firstLat] = points[0];
      const start = projection.project(firstLon, firstLat);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);

      for (let i = 1; i < points.length; i += 1) {
        const [lon, lat] = points[i];
        const { x, y } = projection.project(lon, lat);
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
      render();
    } catch (error) {
      console.error('Failed to initialize map', error);
    }
  }

  window.addEventListener('resize', resizeCanvas, { passive: true });
  window.addEventListener('load', init);
})();
