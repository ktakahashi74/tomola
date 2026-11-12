import path from 'node:path';
import { SAME_ORIGIN_EXCEPTIONS } from './same-origin-exceptions.mjs';

export default {
  meta: { type: 'problem', schema: [], messages: { missing: 'Route action needs assertSameOrigin or a documented exception.' } },
  create(context) {
    const source = context.sourceCode;
    const checked = new Set();
    const resolve = node => {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (variable) return variable.defs[0];
      }
    };
    function guarded(node) {
      if (!node || checked.has(node)) return false;
      checked.add(node);
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const definition = resolve(node.callee);
        if (definition?.node?.type === 'ImportSpecifier' && definition.node.imported.name === 'assertSameOrigin'
          && definition.parent.source.value === '~/lib/http/csrf.server') return true;
      }
      if (node.type === 'Identifier') {
        const definition = resolve(node);
        if (definition?.type === 'FunctionName' && guarded(definition.node.body)) return true;
        if (definition?.type === 'Variable' && guarded(definition.node.init)) return true;
      }
      return (source.visitorKeys[node.type] ?? []).some(key => {
        const value = node[key];
        return Array.isArray(value) ? value.some(child => child?.type && guarded(child)) : value?.type && guarded(value);
      });
    }
    return {
      ExportNamedDeclaration(node) {
        if (Object.hasOwn(SAME_ORIGIN_EXCEPTIONS, path.basename(context.filename))) return;
        const declaration = node.declaration;
        const actions = declaration?.type === 'FunctionDeclaration' && declaration.id?.name === 'action' ? [declaration]
          : declaration?.type === 'VariableDeclaration' ? declaration.declarations.filter(item => item.id.name === 'action').map(item => item.init)
          : (node.specifiers ?? []).filter(item => item.exported.name === 'action').map(item => item.local);
        for (const action of actions) {
          checked.clear();
          if (!guarded(action)) context.report({ node: action ?? node, messageId: 'missing' });
        }
      },
    };
  },
};
