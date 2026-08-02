import * as fs from "fs";
import * as path from "path";

// ─── Parity: backend and background copies must be byte-for-byte identical ───
//
// The background repo already has an equivalent test (preferenceFilters.test.ts)
// that reads this direction. This test guards the OTHER direction: when backend
// tests are run in isolation (without running the background suite), this file
// prevents silent drift. A one-sided guard gives false confidence to whichever
// repo is run alone — both suites must fail loudly when the copies diverge.

describe("parity: backend and background preferenceFilters.ts must be identical", () => {
  const bePath = path.resolve(__dirname, "../utils/preferenceFilters.ts");
  const bgPath = path.resolve(
    __dirname,
    "../../../onlyjobs-background/src/utils/preferenceFilters.ts"
  );

  test("both files exist", () => {
    expect(fs.existsSync(bePath)).toBe(true);
    expect(fs.existsSync(bgPath)).toBe(true);
  });

  test("file contents are byte-for-byte identical", () => {
    const beContent = fs.readFileSync(bePath, "utf8");
    const bgContent = fs.readFileSync(bgPath, "utf8");
    if (beContent !== bgContent) {
      const beLines = beContent.split("\n");
      const bgLines = bgContent.split("\n");
      const diffs: string[] = [];
      const maxLen = Math.max(beLines.length, bgLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (beLines[i] !== bgLines[i]) {
          diffs.push(
            `Line ${i + 1}:\n  backend:    ${beLines[i] ?? "(missing)"}\n  background: ${bgLines[i] ?? "(missing)"}`
          );
          if (diffs.length >= 5) {
            diffs.push("... (more differences omitted)");
            break;
          }
        }
      }
      throw new Error(`Files differ:\n${diffs.join("\n\n")}`);
    }
    expect(beContent).toBe(bgContent);
  });
});
