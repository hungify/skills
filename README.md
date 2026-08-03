# Hungify Skills

Agent skills published in two modes:

- Managed plugins: versioned bundles installed and updated by supported plugin hosts.
- Standalone skills: editable copies installed into a project with skills.sh.

Choose one mode for the same skill. Installing both may expose duplicate skills to an agent.

## Figloom

Figloom is the managed Figma workflow plugin from Hungify. Current release includes:

- `figma-component-registry`: synchronize Figma component metadata with code, validate registry entries, and detect drift after component edits.
- `verify-visual`: verify visual parity between rendered code and a known-good baseline — a Figma node or another web state — without implementing or modifying UI.
- `figma-implement-component`: implement a design-system component from Figma into code, gated by a `figma-component-registry` sync and a Figloom schema-v4 verification/done-gate pipeline.

Planned Figloom skills:

- `figma-implement-screen`

`shadcn-design-md` and `spec-design-md` remain standalone skills. They are not bundled with Figloom.

### Usage examples

`verify-visual` triggers from a plain-language ask; the agent picks `figma` or `web` baseline from what you supply.

Web-vs-web regression (current code vs a previously approved deploy):

```text
Verify http://localhost:3000/checkout against https://staging.example.com/checkout
(revision prod-2026-07-30) at 1440x1024, full page. Do not modify code.
```

Figma-vs-web (rendered code vs a Figma node):

```text
Verify http://localhost:3000/login against Figma node
https://www.figma.com/design/abc123/App?node-id=153-5181 at 1440x1024, full page.
Do not modify code.
```

`FIGMA_ACCESS_TOKEN` is required for the Figma-baseline case. Set it in the shell environment, or in `.env`/`.env.local` anywhere between the project root and the nearest ancestor `.git` directory — the CLI loads it automatically. See `skills/verify-visual/references/contract.md` for the full contract JSON each of these produces.

## Managed installation

Managed installs use plugin cache files. Do not edit installed copies. Change source files in this repository or install standalone skills when customization is required.

### Claude Code

```bash
claude plugin marketplace add hungify/skills
claude plugin install figloom@hungify
```

Claude Code disables automatic updates for third-party marketplaces by default. Enable auto-update for the `hungify` marketplace in `/plugin`, or update it manually:

```bash
claude plugin marketplace update hungify
```

### Codex

```bash
codex plugin marketplace add hungify/skills
codex plugin add figloom@hungify
```

Refresh marketplace metadata when a new release is available:

```bash
codex plugin marketplace upgrade hungify
```

### Cursor

After Figloom is accepted into the public Cursor Marketplace, install it from Cursor Agent chat:

```text
/add-plugin figloom
```

The repository includes Cursor marketplace and plugin manifests for validation and submission. Their presence does not create a public Cursor listing automatically.

## Editable standalone installation

```bash
npx skills@latest add hungify/skills
```

Select individual skills and target agents in the installer. skills.sh copies selected files into the project, where they can be reviewed and edited.

Available standalone skills:

| Skill | Purpose |
| --- | --- |
| `figma-component-registry` | Synchronize and validate Figma-to-code component registry entries. |
| `verify-visual` | Verify visual parity between rendered code and a Figma node or web baseline. |
| `figma-implement-component` | Implement a design-system component from Figma into code, gated by registry sync and Figloom verification. |
| `spec-design-md` | Generate a DESIGN.md specification from a product brief or brand direction. |
| `shadcn-design-md` | Extract a DESIGN.md visual language from an existing shadcn and Tailwind codebase. |

## Repository layout

```text
skills/                              # canonical standalone skill source
  figma-component-registry/
  verify-visual/
  figma-implement-component/
  shadcn-design-md/
  spec-design-md/

.agents/plugins/marketplace.json     # Codex marketplace: hungify
.claude-plugin/marketplace.json      # Claude Code marketplace: hungify
.cursor-plugin/marketplace.json      # Cursor marketplace: hungify

plugins/
  figloom/
    .codex-plugin/plugin.json
    .claude-plugin/plugin.json
    .cursor-plugin/plugin.json
    skills/                           # generated materialized bundle
    hooks/                            # host-specific hook registration

drafts/figloom/                       # unreleased Figloom work
deprecated/figloom/                   # retired Figloom work
```

`skills/` is source of truth. `plugins/figloom/skills/` contains generated real files, not symlinks, because plugin caches and archives may not preserve symlinks.

## Development

Install release tooling:

```bash
npm install
```

After changing a Figloom source skill:

```bash
git add skills/figma-component-registry
npm run sync:figloom
npm run validate
```

Bundle generation copies only Git-tracked source files. This prevents local notes, credentials, dependency folders, and other untracked files from entering a public plugin artifact.

After changing package version:

```bash
npm run sync:version
npm run validate
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run sync` | Synchronize version and generated Figloom bundle. |
| `npm run test:hooks` | Test cross-host registry drift hook behavior. |
| `npm run test:registry` | Run figma-component-registry test suite. |
| `npm run check:bundle` | Validate manifests, marketplaces, version parity, bundle drift, and release layout. |
| `npm run validate` | Run full release validation. |
| `npm run changeset` | Record a user-visible release change. |

Never edit `plugins/figloom/skills/` by hand. Edit matching source under `skills/`, then regenerate bundle.

## Release flow

Changesets drives version pull requests and tags:

```text
changeset
-> version pull request
-> synchronize three plugin manifests
-> validate host metadata and generated bundle
-> git tag
```

`package.json` is version source. CI fails when Claude Code, Codex, or Cursor plugin manifests drift from it.

## License

MIT
