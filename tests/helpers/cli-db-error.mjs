import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (/\/app\/lib\/db\/client\.server\.ts$/.test(url)) return { format: 'module', shortCircuit: true, source: `
    import { DrizzleQueryError } from 'drizzle-orm';
    export async function getOperatorDb() { return {
      select() { return { from() { return { where: async () => [] }; } }; },
      insert() { return { values(row) { throw new DrizzleQueryError('insert into invitations (email, token_hash) values ($1, $2)', [row.email, row.tokenHash], Object.assign(new Error('private database detail'), {code:'23505'})); } }; }
    }; }
  ` };
  return next(url, context);
} });
