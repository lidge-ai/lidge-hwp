export function dispatchHostEvent(event, actions) {
  if (event?.payload?.schemaVersion !== 1) return false;
  const handlers = {
    'lidge.hostSaveRequested': actions.save,
    'lidge.hostRenameRequested': actions.rename,
    'lidge.hostCopyPathRequested': actions.copyPath,
    'lidge.hostNewRequested': actions.newDocument,
  };
  const handler = handlers[event.event];
  if (!handler) return false;
  handler();
  return true;
}
