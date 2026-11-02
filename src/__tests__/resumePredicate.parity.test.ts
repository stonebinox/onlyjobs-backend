import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

// The frontend copy imports the Resume type and uses it in the signature; those are
// the only permitted differences, normalized away here.
const normalize = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*import\b.*\bResume\b/.test(line))
    .join("\n")
    .replace("resume: Resume | null | undefined", "resume: unknown")
    .trim();

describe("resumePredicate parity across repos", () => {
  const backend = normalize(read("backend/src/utils/resumePredicate.ts"));
  const background = normalize(read("onlyjobs-background/src/utils/resumePredicate.ts"));
  const frontend = normalize(read("frontend/src/utils/resumePredicate.ts"));

  it("backend and onlyjobs-background copies are identical", () => {
    expect(background).toBe(backend);
  });

  it("backend and frontend copies are identical (minus the Resume import)", () => {
    expect(frontend).toBe(backend);
  });
});
