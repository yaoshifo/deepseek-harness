# Adapting to the Project

The examples throughout this skill are written in TypeScript/Jest. They express
**concepts**, not the syntax you should write. Before writing any test, detect what
the current project actually uses and translate accordingly.

## 1. Detect the project's conventions first

**Language & test framework** — read the dependency manifest:

- `pyproject.toml` / `setup.cfg` / `requirements*.txt` → Python (pytest, unittest)
- `package.json` → JS/TS (jest, vitest, mocha)
- `go.mod` → Go (`go test`)
- `Cargo.toml` → Rust (`cargo test`)
- `pom.xml` / `build.gradle` → Java (JUnit)

**Directory & naming convention** — look at the *existing* tests, don't assume:

- glob `test_*.py` / `*_test.py` / `*_test.go` / `*.test.ts` / `*.spec.ts`
- Put new tests in the directory the project already uses (`tests/`, `unit_test/`,
  `test/`, alongside source, …) and follow its naming style.
- **Do not create a new test directory** when one already exists.

**How to run tests** — reuse the project's own command, don't invent one:

- Check README / CLAUDE.md / AGENTS.md / Makefile / `[tool.pytest.ini_options]` /
  `package.json` scripts.
- Run the actual command each RED/GREEN step so you really see fail → pass.

If the project has **no tests yet**, pick the language's mainstream framework and
confirm the location with the user before scaffolding.

## 2. Translate the examples (concept → local syntax)

| Concept (shown as jest) | pytest | Go |
|---|---|---|
| `expect(x).toBe(y)` | `assert x == y` | `if got != want { t.Errorf(...) }` |
| float / numeric compare | `assert x == pytest.approx(y)` | tolerance check, not `==` |
| expect throw | `with pytest.raises(Err):` | assert returned `err != nil` |
| mock a boundary | `monkeypatch` / `unittest.mock` | inject via interface |
| many cases | `@pytest.mark.parametrize` | table-driven + `t.Run` |

The jest code in `SKILL.md`, `tests.md`, and `mocking.md` is illustrative only —
write the equivalent in the project's language.

## 3. Numeric / data-heavy projects

When the core logic is "feed a batch of input data → compute a metric / signal /
result" (quant, ETL, scientific computing):

- Prefer **integration tests over real or recorded data**, asserting with a
  tolerance — don't shatter numeric logic into meaningless micro-units just to make
  it "unit testable".
- Still follow the skill's rule: mock only at system boundaries (external data
  feeds, network, time/randomness), never your own processing modules.
- A good tracer bullet here = "given known input data → assert the key output
  metric".
