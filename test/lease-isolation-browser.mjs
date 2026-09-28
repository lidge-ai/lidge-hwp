import { withBrowser, until, idSelector, expect as assert } from './browser-shell-helper.mjs';

await withBrowser({ files: ['P/a.hwp', 'P/b.hwp'] }, async ({ cdp, server }) => {
  await until(() => cdp.eval(`return document.body.dataset.studioReady === 'true';`));
  await cdp.eval(`document.querySelector(${JSON.stringify(idSelector('P/a.hwp'))}).click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/a.hwp';`));

  const lease = server.tabs.owner('P/a.hwp');
  assert.ok(lease);
  await server.tabs.requestAgent(lease, 'agent.prepare', { format: 'hwp' }, 10000);
  await cdp.eval(`document.querySelector('#studio iframe').inert = true;
    document.querySelector(${JSON.stringify(idSelector('P/b.hwp'))}).click();`);
  await until(() => cdp.eval(`return document.querySelector('#status').textContent.includes('AGENT_BUSY');`));
  assert.deepEqual(await cdp.eval(`return {
    current: document.querySelector('#filename').title,
    selected: document.querySelector('#docs button[aria-current="true"]')?.dataset.id,
    shell: document.body.dataset.shellState,
    inert: document.querySelector('#studio iframe').inert,
    message: document.querySelector('#shell-message').textContent,
  };`), { current: 'P/a.hwp', selected: 'P/a.hwp', shell: 'open', inert: true,
    message: '목록에서 문서를 선택하세요' });
  console.log('PASS busy release preserves blocked editor and previous tab');
});
