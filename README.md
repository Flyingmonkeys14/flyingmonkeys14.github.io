# Online AdvantageScope

A browser-based log file viewer for FRC (FIRST Robotics Competition) log formats, deployed as a password-protected GitHub Pages web app. No installation required.

## Adding Log Files

1. Place log files in `public/logs/`
2. Update `public/logs/manifest.json` to list the filenames:

```json
[
  "match1.wpilog",
  "match2.hoot",
  "autonomous.csv"
]
```

3. Commit and push — the site will automatically parse and display all listed files on load.

## Supported Formats

| Format | Extension(s) | Description |
|--------|-------------|-------------|
| **WPILOG** | `.wpilog` | WPILib standard data log (AdvantageKit, etc.) |
| **HOOT** | `.hoot` | CTRE Phoenix 6 robot log |
| **REVLOG** | `.revlog` | REV Robotics data log |
| **RLOG** | `.rlog` | AdvantageKit legacy format |
| **DS Log** | `.dslog` | Driver Station robot state log |
| **CSV** | `.csv` | Multi-column or Timestamp/Key/Value format |

## Features

- **Password gate** — SHA-256-protected splash screen; password never stored in plain text
- **Field tree** — Browse all logged fields in a hierarchical sidebar
- **Log selector** — Switch between multiple log files without reloading
- **Time-series chart** — Plot multiple numeric/boolean fields on a shared timeline
- **Value table** — See field values at any point in time
- **Time slider** — Scrub through the log; click the chart to seek
- **Fully client-side** — Files are served statically; nothing is uploaded

## Development

```bash
npm install
npm run dev     # dev server at http://localhost:5173
npm run build   # production build → dist/
```

## Deployment (GitHub Pages)

Push to `main` — `.github/workflows/deploy.yml` builds and deploys automatically.

To enable GitHub Pages the first time:
1. Go to **Settings → Pages**
2. Set Source to **GitHub Actions**

## Credits

Inspired by [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScope) by Mechanical Advantage (FRC Team 6328).
