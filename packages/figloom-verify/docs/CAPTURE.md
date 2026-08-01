# Deterministic capture runbook

Visual thresholds are meaningful only when the capture environment is
controlled. A different browser build, font set, device scale factor, or
operating-system compositor can create pixel differences that say nothing
about the implementation being reviewed.

## Shared capture image

This package provides a pinned Playwright image in `Dockerfile`. Agents and
humans calibrating or reviewing the same component should run the live-app
capture inside that image. Use the same image tag, viewport dimensions,
browser settings, application commit, and font inputs for both runs.

Build it from this directory:

```bash
docker build -t figloom-capture:v1.61.1 .
```

The image wraps the existing `pnpm capture` command. Mount an output directory
and use `host.docker.internal` when the app is running on the host:

```bash
docker run --rm \
  -v "$PWD/artifacts:/workspace/artifacts" \
figloom-capture:v1.61.1 \
  http://host.docker.internal:3000/login \
  /workspace/artifacts/login.png \
  1440x1024 \
  '[data-testid=auth.login]'
```

If the app runs in another container, use a shared Docker network and the
service name instead of `host.docker.internal`.

On Linux, add `--add-host=host.docker.internal:host-gateway` to `docker run`
so the container can reach services on the host.

## When thresholds are meaningful

Treat a threshold as calibration evidence only when:

- the gold node, viewport, selector, expected size, and application revision
  are held constant;
- the agent and human use the same pinned capture image;
- fonts are installed and loaded before capture;
- animations, timers, network data, and feature flags are deterministic; and
- repeated captures in that environment are stable.

Calibrate with representative design-system components and several repeated
captures. Record the evidence and the decision in the change that updates a
threshold. Do not change a threshold merely to make one failing run pass.
Thresholds in `src/profiles.ts` remain provisional until the planned
calibration task is completed.

Do not calibrate on a random local Chrome installation. Local Chrome is useful
for interactive debugging, but its browser version, OS fonts, GPU/compositor,
scale factor, and user profile can differ from the environment used by the
agent. A local pass is not evidence that the pinned capture environment will
pass, and vice versa.

## Troubleshooting differences

First rerun in the pinned image. Check the application revision, loaded-font
completion, viewport size, device scale factor, and animation/data state before
considering a threshold change. Fix the implementation or capture setup; do
not use `ignoreSelectors` to hide an unexplained difference.
