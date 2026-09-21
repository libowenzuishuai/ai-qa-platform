import {
  DataParameterSchema,
  DataParameters,
  HttpDataPluginDefinition,
} from "@ai-qa/contracts";
export function validateDataParameters(schema: unknown, raw: unknown) {
  const definition = DataParameterSchema.parse(schema),
    params = DataParameters.parse(raw);
  for (const name of definition.required)
    if (!(name in params)) throw new Error("缺少必要参数");
  for (const [name, value] of Object.entries(params))
    if (
      !definition.properties[name] ||
      typeof value !== definition.properties[name]!.type
    )
      throw new Error("参数不符合注册 schema");
  return params;
}
export function parseDataDefinition(value: unknown) {
  return HttpDataPluginDefinition.parse(value);
}
