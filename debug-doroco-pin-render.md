# Debug: doroco-pin-render

Status: [OPEN]

## Symptom
The redesigned Doroco collector enamel pin preview appears incorrect.

## Hypotheses
1. The SVG data URL texture fails to load or decode in Three.js.
2. SVG `<use href>` or embedded font/filter support produces a blank or incomplete texture.
3. The artwork plane is occluded by the 3D rim due to layer depth or camera angle.
4. The browser is displaying stale Vite/HMR content instead of the latest module.

## Evidence
Pending runtime instrumentation and reproduction.
