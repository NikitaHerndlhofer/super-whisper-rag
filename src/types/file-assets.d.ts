declare module "*.dylib" {
  const path: string;
  export default path;
}

declare module "*.md" {
  const path: string;
  export default path;
}

declare module "*.sql" {
  const text: string;
  export default text;
}

// The Swift helper binary has no extension, so we declare an exact-path
// module so `import "../../vendor/swrag-helper-darwin-universal" with
// { type: "file" }` typechecks. Bun produces a string path at runtime;
// in dev it's a real fs path, in a `bun build --compile` bundle it's
// a `/$bunfs/...` path that `src/mac/helper.ts::materialiseHelper`
// resolves to a per-user cache dir.
declare module "*swrag-helper-darwin-universal" {
  const path: string;
  export default path;
}
