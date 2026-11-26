export function formatCollectionSelection(
  collections: readonly string[]
): string {
  const quoted = collections.map((name) => JSON.stringify(name)).join(", ");
  // Show invisible characters and keep ordinary spaces readable.
  return quoted.replace(
    /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]|[^\S ]/gu,
    (character) =>
      character
        .split("")
        .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("")
  );
}

export function validateCollectionSelection(
  collections: readonly string[]
): void {
  if (collections.length === 0) {
    throw new Error("Select at least one collection.");
  }
  const seen = new Set<string>();
  for (const name of collections) {
    if (name.startsWith("--")) {
      throw new Error(
        `Collection names cannot start with --: ${JSON.stringify(name)}`
      );
    }
    if (
      !name.trim() ||
      name.includes("*") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.includes("\n") ||
      name.includes("\r") ||
      name.includes("\x60") ||
      name.startsWith("system.")
    ) {
      throw new Error(
        `Collection name cannot be represented as an exact namespace filter: ${JSON.stringify(name)}`
      );
    }
    if (seen.has(name)) {
      throw new Error(`Collection ${name} was selected more than once.`);
    }
    seen.add(name);
  }
}

export function requireCollections(
  selected: readonly string[],
  available: readonly string[],
  description: string
): void {
  const names = new Set(available);
  const missing = selected.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length === 1 ? "Collection" : "Collections"} ${missing.join(", ")} ${description}`
    );
  }
}
