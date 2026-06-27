// Ambient declarations for the test-only deep imports in
// markdown-image-render.test.tsx. The markdown rendering regression test drives
// the library's internal parser + AstRenderer (and the underlying markdown-it)
// directly, none of which ship type declarations for these paths. Typing them
// as `any` here keeps the test honest (it asserts on the produced element tree)
// without a runtime dependency on @types.
declare module "markdown-it";
declare module "react-native-markdown-display/src/lib/AstRenderer.js";
declare module "react-native-markdown-display/src/lib/parser.js";
