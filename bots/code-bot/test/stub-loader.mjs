// Module resolution + load hooks used only by the test runner.
//
// The PR's review branch is a partial tree containing only the handler files;
// their sibling/workspace imports (@platform/bot-core/discord, ../session.js,
// ../deploy.js) are not present here. These hooks satisfy those imports with
// empty stubs so test/*.test.js can import the *real* raceFetchers helper from
// get-code.js and exercise its actual logic.

const STUBBED = [
  '@platform/bot-core/discord',
  '../session.js',
  '../deploy.js',
];

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED.includes(specifier)) {
    return { url: `stub:${specifier}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('stub:')) {
    // Empty ESM module — get-code.js only references these symbols inside
    // handler closures, never at module top level, so empty exports suffice
    // for importing and calling raceFetchers.
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export const ephemeralError = () => {};
        export const buildFetchingView = () => ({});
        export const buildCodeView = () => ({});
        export const buildTimeoutView = () => ({});
        export const buildPlainView = () => ({});
        export const deleteSession = () => {};
        export const refreshDeployMessage = async () => {};
        export const getDeployRecord = () => null;
        export default {};
      `,
    };
  }
  return nextLoad(url, context);
}
