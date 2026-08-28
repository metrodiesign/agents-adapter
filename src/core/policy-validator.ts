/**
 * JSON Schema validator ขนาดเล็ก (draft-07 subset) พอสำหรับ schema ใน policy/schema
 * รองรับ: type, required, properties, additionalProperties, items, enum, pattern, minLength, minItems
 * ไม่รองรับ: $ref, oneOf/anyOf, format (ตั้งใจ เพื่อไม่เพิ่ม dependency)
 */
export interface SchemaError {
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

export function validateAgainstSchema(value: unknown, schema: Schema, at = "$"): SchemaError[] {
  const errors: SchemaError[] = [];
  const type = schema.type as string | undefined;
  if (type !== undefined && !matchesType(value, type)) {
    errors.push({ path: at, message: `expected ${type}` });
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push({ path: at, message: `expected one of ${JSON.stringify(schema.enum)}` });
  }
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push({ path: at, message: `does not match ${schema.pattern}` });
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push({ path: at, message: `shorter than ${schema.minLength}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push({ path: at, message: `fewer than ${schema.minItems} items` });
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items as Schema, `${at}[${i}]`)));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push({ path: `${at}.${req}`, message: "required" });
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) errors.push(...validateAgainstSchema(v, props[k], `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push({ path: `${at}.${k}`, message: "unknown key" });
    }
  }
  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

export function assertValid(value: unknown, schema: Schema, label: string): void {
  const errors = validateAgainstSchema(value, schema);
  if (errors.length > 0) {
    throw new Error(`${label} schema validation failed:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"));
  }
}
