import { test, expect, state } from './helpers';

test('production starts, renders Markdown and stops without the test preload', () => {
  expect(state().noPreload).toMatchObject({ health: 200, document: 200, exitCode: 0 });
});
