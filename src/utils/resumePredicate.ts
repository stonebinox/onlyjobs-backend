function hasMeaningfulText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function itemText(item: unknown): unknown {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && "text" in item) {
    return (item as { text?: unknown }).text;
  }
  return undefined;
}

function hasMeaningfulArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => hasMeaningfulText(itemText(item)));
}

export function hasMeaningfulResume(resume: unknown): boolean {
  const r = resume as { summary?: unknown; skills?: unknown; experience?: unknown; education?: unknown } | null | undefined;
  return !!r &&
    (hasMeaningfulText(r.summary) ||
     hasMeaningfulArray(r.skills) ||
     hasMeaningfulArray(r.experience) ||
     hasMeaningfulArray(r.education));
}
