# ATC Waypoint Quiz

https://mankolik.github.io/ATC-WPTs-Quiz/

Tap the waypoint named in the top bar. Drag to pan, pinch or scroll to zoom, and use the **FIR** button to pick which FIRs to study.

## How the learning works

Scheduling is Anki-style spaced repetition (SM-2), implemented in `srs.js`:

- **New waypoints** go through short learning steps (1 min, then 10 min) and then come back the next day.
- After that, every correct answer multiplies the gap (roughly 1 → 3 → 8 → 20 → 50 days…).
- A **miss** (any wrong tap before the right one) sends a waypoint back to short steps, shrinks its interval and makes it come back more often from then on.
- Up to **15 new waypoints a day** are introduced. When you're caught up, tap the top bar to unlock 10 more.
- Counters: 🔴 new / just missed · 🟡 being learned · 🟢 known well (interval ≥ 21 days).

Progress is saved in the browser's localStorage, per device.

## Data

- `data/waypoints/index.json` lists the waypoint files; each `<FIR>.geojson` holds Point features with a `name` property.
- `data/FIRmap.json` is the FIR boundary map drawn in the background.

## Tests

```
node --test tests/*.test.js
```
