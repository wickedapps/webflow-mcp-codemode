// Files embedded in the compiled binary: seed files as text (home.ts) and the QuickJS wasm as a file (sandbox.ts).
declare module "*.txt" {
  const text: string;
  export default text;
}
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const path: string;
  export default path;
}
