import { hasMeaningfulResume } from "../utils/resumePredicate";

const FALSE_CASES: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["empty object", {}],
  ['summary:""', { summary: "" }],
  ['summary:"   "', { summary: "   " }],
  ['summary:"\\n"', { summary: "\n" }],
  ["skills:[]", { skills: [] }],
  ['skills:["   "]', { skills: ["   "] }],
  ['experience:[{text:" ", link:"https://x"}]', { experience: [{ text: " ", link: "https://x" }] }],
  ['experience:[{link:"https://x"}] — link-only, no text key', { experience: [{ link: "https://x" }] }],
  ['education:["\\n"]', { education: ["\n"] }],
  ["all four blank", { summary: "  ", skills: [""], experience: [{ text: "" }], education: ["\t"] }],
];

const TRUE_CASES: Array<[string, unknown]> = [
  ['summary:"Engineer"', { summary: "Engineer" }],
  ['skills:["React"]', { skills: ["React"] }],
  ['experience:["Senior dev at X"]', { experience: ["Senior dev at X"] }],
  ['experience:[{text:"Lead", link:"https://x"}]', { experience: [{ text: "Lead", link: "https://x" }] }],
  ['education:["BS CS"]', { education: ["BS CS"] }],
  ['summary:"   ", skills:["React"] — one meaningful field is enough', { summary: "   ", skills: ["React"] }],
];

describe("hasMeaningfulResume", () => {
  describe("returns false for non-meaningful resumes", () => {
    test.each(FALSE_CASES)("%s", (_label, input) => {
      expect(hasMeaningfulResume(input)).toBe(false);
    });
  });

  describe("returns true for meaningful resumes", () => {
    test.each(TRUE_CASES)("%s", (_label, input) => {
      expect(hasMeaningfulResume(input)).toBe(true);
    });
  });
});
