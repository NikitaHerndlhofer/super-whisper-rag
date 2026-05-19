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
