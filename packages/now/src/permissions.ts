export function permissions(files: Record<string, string>): {
  inference: boolean;
} {
  if (files["now.json"] === undefined) return { inference: false };
  let manifest;
  try {
    manifest = JSON.parse(files["now.json"]);
  } catch {
    throw new Error("now.json must be valid JSON");
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !object(manifest) ||
    Object.keys(manifest).some((key) => key !== "permissions") ||
    !object(manifest.permissions) ||
    Object.keys(manifest.permissions).some((key) => key !== "inference") ||
    (manifest.permissions.inference !== undefined &&
      typeof manifest.permissions.inference !== "boolean")
  )
    throw new Error(
      "now.json must contain permissions with optional inference: true or false",
    );
  return { inference: manifest.permissions.inference === true };
}
