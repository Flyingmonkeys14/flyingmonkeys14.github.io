# Online AdvantageScope

A browser-based log file viewer for FRC (FIRST Robotics Competition) log formats, built as a GitHub Pages web app. No installation required — just open the page and drop in a log file.

## Supported Formats

| Format | Extension | Description |
|--------|-----------|-------------|
| **WPILOG** | `.wpilog` | WPILib standard data log (AdvantageKit, etc.) |
| **HOOT** | `.hoot` | CTRE Phoenix 6 robot log |
| **REVLOG** | `.revlog` | REV Robotics data log |
| **RLOG** | `.rlog` | AdvantageKit legacy format |
| **DS Log** | `.dslog` | Driver Station robot state log |
| **CSV** | `.csv` | Multi-column or Timestamp/Key/Value format |

## Features

- **Field tree** — Browse all logged fields in a hierarchical sidebar
- **Time-series chart** — Plot multiple numeric/boolean fields on a shared timeline
- **Value table** — See current values of all selected fields at any point in time
- **Time slider** — Scrub through the log; click the chart to jump to a timestamp
- **Fully client-side** — Files never leave your browser

## Development

```bash
npm install
npm run dev       # start dev server
npm run build     # production build → dist/
```

## Deployment

Push to `main` — the GitHub Actions workflow (`deploy.yml`) automatically builds and deploys to GitHub Pages.

To enable GitHub Pages:
1. Go to **Settings → Pages**
2. Set Source to **GitHub Actions**

## Credits

Inspired by [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScope) by Mechanical Advantage (FRC Team 6328). Log format specifications from the WPILib and CTRE documentation.
