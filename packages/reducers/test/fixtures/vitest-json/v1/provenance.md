# Vitest JSON v1 fixtures

Reporter fixtures were captured with Vitest 3.2.7 using:

```text
pnpm exec vitest run <fixture-source> --reporter=json --outputFile=<fixture-path>
```

`generate-derived-fixtures.mjs` replaces only the local repository prefix in
captured path strings with `<workspace>` before committing the reports. This
keeps the structural reporter output while avoiding developer-specific paths.

`no-summary-counts.json` is derived from `all-pass.json` by removing the five
top-level count fields. `truncated.json` is a prefix of `one-failure.json`.
`malformed-utf8.bin` contains the invalid byte sequence `c3 28`.
`very-large.json` is a valid JSON document larger than the 16 MiB parser bound.

These files are immutable parser inputs. Normal tests do not regenerate them.
