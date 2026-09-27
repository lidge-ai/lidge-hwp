import { runTest, createNewDocument, assert } from './helpers.mjs';

runTest('Option-C reaches Studio format copy once', async ({ page }) => {
  await createNewDocument(page);
  const result = await page.evaluate(() => {
    const handler = window.__inputHandler;
    if (!handler) throw new Error('development input handler unavailable');
    const calls = [];
    const original = handler.dispatcher.dispatch;
    handler.dispatcher.dispatch = function (...args) {
      calls.push(args[0]);
      return original.apply(this, args);
    };
    try {
      handler.textarea.focus();
      handler.textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ç', code: 'KeyC', altKey: true, bubbles: true, cancelable: true,
      }));
      return calls;
    } finally { handler.dispatcher.dispatch = original; }
  });
  assert(result.filter(id => id === 'edit:format-copy').length === 1,
    `format copy dispatches once: ${JSON.stringify(result)}`);
});
