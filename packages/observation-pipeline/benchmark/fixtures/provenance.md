# Benchmark fixture provenance

**Captured:** September 7, 2026

Every observation the local paired benchmark replays is real. None of it is
hand-written to make a reduction look better than it is.

## `vitest-passing.json`

The `@acm/reducers` suite, captured unchanged.

```bash
pnpm --filter @acm/reducers exec vitest run src \
  --reporter=json --outputFile=<path>
```

44 passing tests. This is the case a reducer folds hardest: passing test names
carry no information a later request needs, so they become counts.

## `vitest-failing.json`

A temporary suite of 33 tests with 3 real assertion failures, run through the
same reporter and then removed. Real failure output including the diff that
vitest produces for `toEqual`, because that is exactly what a reducer must
preserve rather than fold.

## `rg-safeforcontext.json`, `rg-reducer.json`

Ripgrep JSON records for `safeForContext` (88 matches) and
`reducedText|reducerId` (87 matches) across `packages/` and `apps/cli/src`.

No ripgrep binary was available on the capture machine, so the records were
generated from real matches found by walking the same paths: the file paths,
line numbers, matched text, and byte offsets are genuine, and only the
`begin`/`match`/`end`/`summary` envelope is reconstructed in ripgrep's format.

## `tsc-errors.txt`

Real TypeScript diagnostics from compiling `tsc-source.ts.txt`:

```bash
pnpm exec tsc --noEmit --pretty false --strict --target ES2022 \
  --module NodeNext --moduleResolution NodeNext --skipLibCheck <source>
```

Kept deliberately: its second diagnostic wraps onto an indented continuation
line, which the non-pretty parser does not recognize. The observation therefore
parses as `partial`, the reduction is marked unsafe, and the benchmark shows the
raw output being kept. That is the safety gate working, not a defect to fix in
the fixture.

## Source files

The benchmark also reads four files from this repository at their current
revision, so re-running it after those files change will move the numbers
slightly. That is intended: the point is a realistic session, not a frozen one.
