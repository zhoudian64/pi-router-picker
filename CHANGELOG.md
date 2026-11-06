# Changelog

## [0.1.0] - 2026-11-06

- Live model discovery from `GET {baseUrl}/models` during every Pi catalog refresh
  (session start, opening `/model`, credential changes, `pi update --models`).
- Router failures fall back to the last known catalogue instead of emptying it; a warning is
  shown once per session when discovery fails.
- `/pick [group]`: two-level picker (machine/group prefix -> model inside that group),
  Escape steps one level back, top-level Escape leaves without switching models.
- Metadata precedence: `models.json` > `$ROUTER_MODEL_DEFS` file > shipped placeholder example
  (`extensions/router-models.json`). The shipped example holds only synthetic ids (`gpu01/`,
  `api01/`) and `your.router.local`; no real router lineup, hostnames or keys.
- Pi clones git sources itself into `~/.pi/agent/git/<host>/<owner>/<repo>`; an unpinned source
  follows the remote branch on every start/reload, a `@tag`/`@commit` ref stays pinned.
