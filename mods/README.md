# mods/

**All** game content lives here, each mod in its own folder with a `manifest.json`,
`prototypes/`, and optional `scripts/`. The loader discovers mods by scanning this
directory: every immediate subfolder containing a `manifest.json` is loaded, in
alphabetical order, then re-ordered by declared dependencies.

`base/` is the base game — "mod zero". It is **not** privileged: it is discovered and
merged through the exact same path as any third-party mod. If mod discovery breaks, the
base game won't boot, so the mod system is dogfooded at all times.

Drop a third-party mod in as a new sibling folder (e.g. `mods/my-mod/`) and it loads
automatically — no wiring required.
