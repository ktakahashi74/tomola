import ts from "typescript";

// Inspect syntax rather than comments or quoted sample code. A conditional gate
// must carry its own tag so an added outer suite cannot silently hide skips.
export function missingPostgresTags(source: string): number[] {
  const file = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const missing: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isCallExpression(node.expression)) {
      const gate = node.expression;
      if (ts.isPropertyAccessExpression(gate.expression) && /^(skipIf|runIf)$/.test(gate.expression.name.text) &&
          /^(it|test|describe)$/.test(gate.expression.expression.getText(file)) &&
          gate.arguments.some(arg => /\b(PG_MODE|REAL_PG_URL)\b/.test(arg.getText(file)))) {
        const options = node.arguments[1];
        const tagged = options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
          ts.isPropertyAssignment(property) && property.name.getText(file).replace(/['"]/g, "") === "tags" &&
          ts.isArrayLiteralExpression(property.initializer) && property.initializer.elements.some(tag => ts.isStringLiteral(tag) && tag.text === "postgres"));
        if (!tagged) missing.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return missing;
}
