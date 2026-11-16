import { isValidJsonSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type FormChoice = { const: string; title: string };
type FormField = {
  type: string; title?: string | null; description?: string | null; format?: string | null;
  enum?: string[]; enumNames?: string[] | null; oneOf?: FormChoice[];
  items?: { enum?: string[]; anyOf?: FormChoice[] };
  default?: unknown;
  minimum?: number | null; maximum?: number | null;
  minLength?: number | null; maxLength?: number | null;
  minItems?: number | null; maxItems?: number | null;
};
export type FormSchema = { type: string; properties: Record<string, FormField>; required?: string[] | null };
export type FormParams = { mode?: string; serverName: string; message: string; _meta?: unknown; requestedSchema?: unknown };

class FormInputError extends Error {}

export async function requestForm(params: FormParams, parser: { parse(value: unknown): FormSchema }, ui: ExtensionContext["ui"], signal: AbortSignal, current: () => boolean) {
  const empty = { action: "cancel" };
  // Known approval markers are declined. Unmarked MCP workflows still require explicit submission.
  if (!["form", "openai/form", "openaiForm"].includes(params.mode ?? "") || /approval|permission|mcp_tool_call/i.test(JSON.stringify(params._meta ?? {}))) return { action: "decline" };
  let schema: FormSchema;
  try { schema = parser.parse(params.requestedSchema); } catch {
    ui.notify("MCP form declined: unsupported form schema.", "warning");
    return { action: "decline" };
  }
  if (!isValidJsonSchema(params.requestedSchema)) {
    ui.notify("MCP form declined: invalid form schema.", "warning");
    return { action: "decline" };
  }
  // OMP's JSON Schema validator does not implement `format`; do not accept it as enforced.
  if (Object.values(schema.properties).some(field => field.format != null)) {
    ui.notify("MCP form declined: string format validation is unsupported by this host.", "warning");
    return { action: "decline" };
  }
  const content: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!current()) return empty;
    const title = `${params.serverName}: ${params.message}\n${field.title ?? key}${field.description ? `\n${field.description}` : ""}`;
    const required = schema.required?.includes(key);
    if (!required) {
      const choice = await ui.select(`${title}\nOptional field`, ["Provide value", "Omit field"], { signal });
      if (!current() || choice === undefined) return empty;
      if (choice === "Omit field") continue;
      if (choice !== "Provide value") return empty;
    }
    for (;;) {
      let issue: string;
      try {
        const value = await formValue(key, title, field, ui, signal);
        if (!current() || value === undefined) return empty;
        const validation = validateJsonSchemaValue({ type: "object", properties: { [key]: field }, required: [key] }, { [key]: value });
        if (validation.success) { content[key] = value; break; }
        issue = validation.issues.map(entry => entry.message).join("; ");
      } catch (error) {
        if (!current()) return empty;
        if (!(error instanceof FormInputError)) throw error;
        issue = error.message;
      }
      const edit = await ui.select(`${title}\n${issue}\nOther answers are kept.`, ["Edit answer", "Cancel form"], { signal });
      if (!current() || edit !== "Edit answer") return { action: "decline" };
    }
  }
  const validation = validateJsonSchemaValue(params.requestedSchema, content);
  if (!validation.success) {
    ui.notify("MCP form declined: submitted values do not satisfy the requested schema.", "warning");
    return { action: "decline" };
  }
  const submit = await ui.select(`${params.serverName}: ${params.message}\nSubmit these answers?`, ["Submit answers", "Decline"], { signal });
  if (!current() || submit === undefined) return empty;
  return submit === "Submit answers" ? { action: "accept", content } : { action: "decline" };
}

async function formValue(key: string, title: string, field: FormField, ui: ExtensionContext["ui"], signal: AbortSignal): Promise<unknown> {
  const constraints = Object.entries({ minimum: field.minimum, maximum: field.maximum, minLength: field.minLength, maxLength: field.maxLength, minItems: field.minItems, maxItems: field.maxItems })
    .filter(([, value]) => value != null).map(([name, value]) => `${name}: ${value}`).join(" · ");
  const prompt = constraints ? `${title}\n${constraints}` : title;
  if (field.type === "boolean") {
    const selected = await ui.select(prompt, ["true", "false"], { signal });
    return selected === "true" ? true : selected === "false" ? false : undefined;
  }
  const choices = field.enum ?? field.oneOf?.map(entry => entry.const);
  if (field.type === "string" && choices) return ui.select(prompt, choices.map((label, index) => ({ label, description: field.oneOf?.[index]?.title ?? field.enumNames?.[index] })), { signal });
  if (field.type === "array") {
    const values = field.items?.enum ?? field.items?.anyOf?.map(entry => entry.const);
    if (!values) {
      const text = await ui.input(prompt, "Array values (JSON)", { signal });
      if (text === undefined) return undefined;
      try { return JSON.parse(text); } catch { throw new FormInputError("Enter a valid array."); }
    }
    if (ui.askDialog) {
      let none = "Select none";
      while (values.includes(none)) none += "…";
      const allowEmpty = !field.minItems;
      const result = await ui.askDialog([{ id: key, header: field.title ?? key, question: prompt, multi: true,
        options: [...values.map((label, index) => ({ label, description: field.items?.anyOf?.[index]?.title })), ...(allowEmpty ? [{ label: none }] : [])],
      }], { signal });
      const answer = result?.kind === "submit" && result.results.length === 1 ? result.results[0] : undefined;
      if (!answer || answer.id !== key || answer.timedOut) return undefined;
      if (answer.customInput?.trim()) throw new FormInputError("Choose values from the list.");
      if (allowEmpty && answer.selectedOptions.includes(none)) {
        if (answer.selectedOptions.length > 1) throw new FormInputError("Select none cannot be combined with other values.");
        return [];
      }
      return answer.selectedOptions;
    }
    const selected = new Set<string>();
    while (!signal.aborted) {
      const labels = values.map(value => `${selected.has(value) ? "[x]" : "[ ]"} ${value}`);
      const choice = await ui.select(prompt, [...labels, "Done", "Cancel form"], { signal });
      if (choice === "Done") return [...selected];
      const index = choice === undefined ? -1 : labels.indexOf(choice);
      if (index < 0) return undefined;
      const value = values[index];
      if (selected.has(value)) selected.delete(value); else selected.add(value);
    }
    return undefined;
  }
  const text = await ui.input(prompt, field.type === "string" ? undefined : field.type === "integer" ? "Whole number" : "Number", { signal });
  if (text === undefined) return undefined;
  if (field.type === "string") return text;
  try { return JSON.parse(text); } catch { throw new FormInputError("Enter a valid number."); }
}
export function createFormParsers(z: ExtensionAPI["zod"]) {
  const choiceSchema = z.object({ const: z.string(), title: z.string() }).strict();
  const formField = z.object({
    type: z.enum(["string", "number", "integer", "boolean", "array"]),
    title: z.string().nullable().optional(), description: z.string().nullable().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).nullable().optional(),
    enum: z.array(z.string()).optional(), enumNames: z.array(z.string()).nullable().optional(),
    oneOf: z.array(choiceSchema).optional(),
    items: z.object({ type: z.literal("string").optional(), enum: z.array(z.string()).optional(), anyOf: z.array(choiceSchema).optional() }).strict().optional(),
    minimum: z.number().nullable().optional(), maximum: z.number().nullable().optional(),
    minLength: z.number().int().nonnegative().nullable().optional(), maxLength: z.number().int().nonnegative().nullable().optional(),
    minItems: z.number().int().nonnegative().nullable().optional(), maxItems: z.number().int().nonnegative().nullable().optional(),
    default: z.unknown().optional(),
  }).strict();
  return {
    form: z.object({
      mode: z.string().optional(), serverName: z.string(), message: z.string(), _meta: z.unknown().optional(),
      requestedSchema: z.unknown().optional(),
    }),
    formSchema: z.object({
      $schema: z.string().nullable().optional(),
      type: z.literal("object"), properties: z.record(z.string(), formField), required: z.array(z.string()).nullable().optional(),
    }).strict(),
  };
}
