import path from 'node:path';
import { WRITER_EXCEPTIONS } from './writer-exceptions.mjs';

const gates = new Set(['requireWriter', 'getWriter', 'requireOperator', 'requireModerator']);
export default {
  meta: { type: 'problem', schema: [], messages: { missing: 'Route action needs a writer/role gate or a documented exception.' } },
  create(context) {
    const source = context.sourceCode;
    const resolve = node => {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (variable) return variable.defs[0];
      }
    };
    const checked = new Set();
    function gated(node, wanted = gates) {
      if (!node || checked.has(node)) return false;
      checked.add(node);
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const definition = resolve(node.callee);
        const imported = definition?.node;
        if (imported?.type === 'ImportSpecifier' && wanted.has(imported.imported.name)) return true;
      }
      if (node.type === 'Identifier') {
        const def = resolve(node);
        if (def?.type === 'FunctionName' && gated(def.node.body, wanted)) return true;
        if (def?.type === 'Variable' && gated(def.node.init, wanted)) return true;
      }
      return (source.visitorKeys[node.type] ?? []).some(key => {
        const value = node[key];
        return Array.isArray(value) ? value.some(child => child?.type && gated(child, wanted)) : value?.type && gated(value, wanted);
      });
    }
    return {
      ExportNamedDeclaration(node) {
        const declaration = node.declaration;
        const actions = declaration?.type === 'FunctionDeclaration' && declaration.id?.name === 'action' ? [declaration]
          : declaration?.type === 'VariableDeclaration' ? declaration.declarations.filter(item => item.id.name === 'action').map(item => item.init)
          : (node.specifiers ?? []).filter(item => item.exported.name === 'action').map(item => item.local);
        for (const action of actions) {
          checked.clear();
          const hasGate = gated(action);
          checked.clear();
          const readsSession = gated(action, new Set(['requireUser', 'getSessionUser']));
          if (!Object.hasOwn(WRITER_EXCEPTIONS, path.basename(context.filename)) && (!hasGate || readsSession)) context.report({ node: action ?? node, messageId: 'missing' });
        }
      },
    };
  },
};
